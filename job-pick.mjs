import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  formatJobLine,
  isTerminalJob,
  latestReplyFromEvents,
  listJobs,
  tailJobEvents,
} from "./jobs.mjs";

const DEFAULT_LIMIT = 200;
const DEFAULT_TAIL = 80;
const TERMINAL_STATUS_ORDER = ["done", "failed", "aborted", "stale"];

export function parsePickCommandArgs(rawArgs = "") {
  const parts = String(rawArgs || "").trim().split(/\s+/).filter(Boolean);
  let peek = false;
  let mode = "random";
  const workerParts = [];

  for (const part of parts) {
    if (part === "--peek" || part === "-p") {
      peek = true;
      continue;
    }
    if (part === "--latest") {
      mode = "latest";
      continue;
    }
    workerParts.push(part);
  }

  return {
    worker: workerParts.join(" ") || undefined,
    mode,
    markRead: !peek,
    peek,
  };
}

export function jobReadEventsFile(workersDir) {
  return join(workersDir, "job-read.jsonl");
}

function ensureParent(file) {
  mkdirSync(dirname(file), { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

function randomId() {
  return `read_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function appendJsonl(file, entry) {
  ensureParent(file);
  appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
}

export function readJobReadEvents(workersDir) {
  return readJsonl(jobReadEventsFile(workersDir));
}

export function readJobReadState(workersDir) {
  const state = new Map();
  for (const event of readJobReadEvents(workersDir)) {
    if (event.type !== "job_read" || !event.jobId) continue;
    state.set(String(event.jobId), event);
  }
  return state;
}

export function markJobRead(workersDir, input) {
  const jobId = String(input?.jobId || "").trim();
  if (!jobId) throw new Error("jobId 不能为空");
  const event = {
    id: randomId(),
    type: "job_read",
    jobId,
    readBy: String(input?.readBy || "user"),
    note: String(input?.note || ""),
    time: nowIso(),
  };
  appendJsonl(jobReadEventsFile(workersDir), event);
  return event;
}

function sortNewestFirst(a, b) {
  return String(b.updatedAt || b.finishedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.finishedAt || a.createdAt || ""));
}

function normalizeStatuses(status) {
  if (!status || status === "all") return new Set(TERMINAL_STATUS_ORDER);
  if (Array.isArray(status)) return new Set(status.map(String));
  return new Set([String(status)]);
}

function jobMatches(job, options) {
  if (!isTerminalJob(job)) return false;
  if (options.worker && job.worker !== options.worker) return false;
  if (options.project && job.project !== options.project) return false;
  const statuses = normalizeStatuses(options.status ?? options.statuses);
  if (!statuses.has(job.status)) return false;
  return true;
}

export function pickUnreadJob(workersDir, options = {}) {
  const limit = Math.max(1, Number(options.limit || DEFAULT_LIMIT));
  const tail = Math.max(1, Number(options.tail || DEFAULT_TAIL));
  const readState = readJobReadState(workersDir);
  const candidates = listJobs(workersDir, { worker: options.worker, limit })
    .filter((job) => jobMatches(job, options))
    .sort(sortNewestFirst)
    .filter((job) => options.includeRead || !readState.has(job.id));

  if (candidates.length === 0) return null;
  const index = options.mode === "random" ? Math.floor(Math.random() * candidates.length) : 0;
  const job = candidates[index];
  const events = tailJobEvents(job, tail);
  const latestReply = latestReplyFromEvents(events) || job.fullOutput || job.summary || job.error || "";
  const readEvent = options.markRead ? markJobRead(workersDir, {
    jobId: job.id,
    readBy: options.readBy || "user",
    note: options.note || "picked",
  }) : null;

  return {
    job,
    events,
    latestReply,
    readEvent,
    peek: options.markRead === false,
    unreadCount: candidates.length,
    candidateCount: candidates.length,
  };
}

function compact(value, max = 180) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function truncateBlock(value, max = 1800) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n...(截断，共 ${text.length} 字符)`;
}

export function formatPickedJob(selection) {
  if (!selection) return "暂无未读 job。";
  const { job, latestReply, readEvent, unreadCount } = selection;
  const lines = [
    "## Pick 到一个未读 job",
    "",
    formatJobLine(job),
    `- worker: ${job.worker || "—"}`,
    `- project: ${job.project || job.kind || "—"}`,
    `- status: ${job.status}`,
    `- updated: ${job.updatedAt || job.finishedAt || job.createdAt || "—"}`,
    `- unread candidates: ${unreadCount}`,
    readEvent
      ? `- read: 已标记 (${readEvent.readBy})`
      : selection.peek
        ? "- read: 未标记（peek，稍后仍会被 pick 到）"
        : "- read: 未标记",
    "",
    `任务：${compact(job.task || "—", 500)}`,
  ];
  if (latestReply) {
    lines.push("", "### 最近结果", "", truncateBlock(latestReply));
  } else if (job.error) {
    lines.push("", "### 错误", "", truncateBlock(job.error));
  }
  lines.push("", `查看完整记录：/attach ${job.id}`);
  return lines.join("\n");
}

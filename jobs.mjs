import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { markOutsourceRunsStaleForJob } from "./outsource-agents.mjs";

const TERMINAL_STATUSES = new Set(["done", "failed", "aborted", "stale"]);
const MAX_LATEST_REPLY_CHARS = 8000;
const MAX_EVENT_TEXT_CHARS = 1200;
export const DEFAULT_JOB_HEARTBEAT_INTERVAL_MS = 5000;
export const DEFAULT_JOB_HEARTBEAT_TIMEOUT_MS = 30000;
const JOB_LIST_CACHE_TRUST_MS = 5000;
const JOB_LIST_CACHE_DEEP_CHECK_MS = 30000;
const JOB_LIST_VERSION_FILE = ".job-list-version";

const jobListCache = new Map();

function jobListVersionFile(jobsDir) {
  return join(jobsDir, JOB_LIST_VERSION_FILE);
}

function touchJobListVersion(jobsDir) {
  try {
    writeFileSync(jobListVersionFile(jobsDir), `${Date.now()}\n`, "utf8");
  } catch {
    // Best-effort cache invalidation only. The next deep check still repairs.
  }
}

function jobListShallowSignal(jobsDir) {
  if (!existsSync(jobsDir)) return "missing";
  try {
    const stat = statSync(jobListVersionFile(jobsDir));
    return `marker:${stat.size}:${Math.trunc(stat.mtimeMs)}`;
  } catch {
    // Older running processes may not write the marker yet. Directory stats are
    // cheap and catch create/delete; existing-file updates are covered by the
    // periodic deep check below.
  }
  try {
    const stat = statSync(jobsDir);
    return `dir:${stat.size}:${Math.trunc(stat.mtimeMs)}`;
  } catch {
    return "missing";
  }
}

function jobListSignalIsAuthoritative(signal) {
  return String(signal || "").startsWith("marker:");
}

function jobListFingerprint(jobsDir) {
  if (!existsSync(jobsDir)) return "missing";
  const parts = [];
  for (const name of readdirSync(jobsDir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const stat = statSync(join(jobsDir, name));
      if (!stat.isFile()) continue;
      parts.push(`${name}:${stat.size}:${Math.trunc(stat.mtimeMs)}`);
    } catch {
      parts.push(`${name}:missing`);
    }
  }
  return parts.sort().join("|");
}

function cloneJob(job) {
  return { ...job };
}

function listCachedJobs(workersDir) {
  const { jobsDir } = ensureJobDirs(workersDir);
  const now = Date.now();
  const cached = jobListCache.get(jobsDir);
  if (cached && now < cached.trustUntil) return cached.jobs;

  const shallowSignal = jobListShallowSignal(jobsDir);
  if (
    cached
    && cached.shallowSignal === shallowSignal
    && (jobListSignalIsAuthoritative(shallowSignal) || now < cached.deepCheckAfter)
  ) {
    cached.trustUntil = now + JOB_LIST_CACHE_TRUST_MS;
    return cached.jobs;
  }

  const fingerprint = jobListFingerprint(jobsDir);
  if (cached?.fingerprint === fingerprint) {
    cached.shallowSignal = shallowSignal;
    cached.trustUntil = now + JOB_LIST_CACHE_TRUST_MS;
    cached.deepCheckAfter = now + JOB_LIST_CACHE_DEEP_CHECK_MS;
    return cached.jobs;
  }
  const jobs = readdirSync(jobsDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readJob(join(jobsDir, name)))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  jobListCache.set(jobsDir, {
    fingerprint,
    shallowSignal,
    jobs,
    trustUntil: now + JOB_LIST_CACHE_TRUST_MS,
    deepCheckAfter: now + JOB_LIST_CACHE_DEEP_CHECK_MS,
  });
  return jobs;
}

export function nowIso() {
  return new Date().toISOString();
}

export function ensureJobDirs(workersDir) {
  const jobsDir = join(workersDir, "jobs");
  const eventsDir = join(workersDir, "events");
  mkdirSync(jobsDir, { recursive: true });
  mkdirSync(eventsDir, { recursive: true });
  return { jobsDir, eventsDir };
}

export function createJob(workersDir, input) {
  const { jobsDir, eventsDir } = ensureJobDirs(workersDir);
  const createdAt = nowIso();
  const safeWorker = String(input.worker || "worker").replace(/[^A-Za-z0-9_-]+/g, "_");
  const id = `${createdAt.replace(/[-:.TZ]/g, "").slice(0, 14)}-${safeWorker}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const job = {
    id,
    kind: input.kind || "dispatch",
    worker: input.worker,
    project: input.project || "",
    task: input.task || "",
    attachments: Array.isArray(input.attachments) ? input.attachments.map((attachment) => ({ ...attachment })) : [],
    attachmentMentions: Array.isArray(input.attachmentMentions) ? input.attachmentMentions.map((mention) => ({ ...mention })) : [],
    cwd: input.cwd || "",
    sessionFile: input.sessionFile || "",
    status: "queued",
    createdAt,
    updatedAt: createdAt,
    jobFile: join(jobsDir, `${id}.json`),
    eventFile: join(eventsDir, `${id}.jsonl`),
  };
  writeJob(job);
  appendJobEvent(job, { type: "queued", text: input.task || "" });
  return job;
}

export function readJob(jobOrPath) {
  const file = typeof jobOrPath === "string" ? jobOrPath : jobOrPath.jobFile;
  return JSON.parse(readFileSync(file, "utf8"));
}

export function writeJob(job) {
  mkdirSync(join(job.jobFile, ".."), { recursive: true });
  writeFileSync(job.jobFile, `${JSON.stringify(job, null, 2)}\n`, "utf8");
  const jobsDir = join(job.jobFile, "..");
  jobListCache.delete(jobsDir);
  touchJobListVersion(jobsDir);
}

export function updateJob(jobOrPath, patch) {
  const job = readJob(jobOrPath);
  Object.assign(job, patch, { updatedAt: nowIso() });
  writeJob(job);
  if (typeof jobOrPath === "object") Object.assign(jobOrPath, job);
  return job;
}

function toDate(value) {
  if (value instanceof Date) return value;
  if (!value) return new Date();
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : new Date();
}

export function appendJobEvent(jobOrPath, event) {
  const job = typeof jobOrPath === "string" ? readJob(jobOrPath) : jobOrPath;
  mkdirSync(join(job.eventFile, ".."), { recursive: true });
  appendFileSync(job.eventFile, `${JSON.stringify({ time: nowIso(), ...event })}\n`, "utf8");
}

export function appendJobEventIfOpen(jobOrPath, event) {
  const job = readJob(jobOrPath);
  if (isTerminalJob(job)) {
    appendJobEvent(job, {
      type: "late_event_after_terminal",
      originalType: event?.type || "unknown",
      terminalStatus: job.status,
      message: `late event after terminal status ${job.status}`,
    });
    return { appended: false, job };
  }
  appendJobEvent(job, event);
  return { appended: true, job };
}

export function tailJobEvents(jobOrPath, limit = 50) {
  const job = typeof jobOrPath === "string" ? readJob(jobOrPath) : jobOrPath;
  if (!existsSync(job.eventFile)) return [];
  const lines = readFileSync(job.eventFile, "utf8").trim().split("\n").filter(Boolean);
  return lines.slice(-limit).map((line) => JSON.parse(line));
}

export function readJobEventsSince(jobOrPath, offset = 0, limit = 200) {
  const job = typeof jobOrPath === "string" ? readJob(jobOrPath) : jobOrPath;
  if (!existsSync(job.eventFile)) return { events: [], nextOffset: 0 };
  const lines = readFileSync(job.eventFile, "utf8").trim().split("\n").filter(Boolean);
  const start = Math.max(0, Math.min(Number(offset) || 0, lines.length));
  const end = Math.min(lines.length, start + Math.max(1, Number(limit) || 200));
  return {
    events: lines.slice(start, end).map((line) => JSON.parse(line)),
    nextOffset: end,
  };
}

export function listJobs(workersDir, { worker, status, limit = 20 } = {}) {
  const jobs = listCachedJobs(workersDir)
    .filter((job) => !worker || job.worker === worker)
    .filter((job) => !status || job.status === status)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  return jobs.slice(-limit).map(cloneJob);
}

export function isTerminalJob(job) {
  return TERMINAL_STATUSES.has(job.status);
}

function pidLooksAlive(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return true;
  try {
    process.kill(numericPid, 0);
    return true;
  } catch {
    return false;
  }
}

export function recordJobHeartbeat(jobOrPath, options = {}) {
  const job = readJob(jobOrPath);
  if (isTerminalJob(job)) return job;
  const heartbeatAt = toDate(options.now).toISOString();
  return updateJob(job, {
    ownerPid: options.ownerPid ?? job.ownerPid,
    ownerInstanceId: options.ownerInstanceId ?? job.ownerInstanceId,
    ownerStartedAt: options.ownerStartedAt ?? job.ownerStartedAt,
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? job.heartbeatIntervalMs ?? DEFAULT_JOB_HEARTBEAT_INTERVAL_MS,
    heartbeatAt,
  });
}

export function hasFreshJobHeartbeat(job, options = {}) {
  const now = toDate(options.now);
  const heartbeatAt = job.heartbeatAt ? new Date(job.heartbeatAt) : null;
  if (!heartbeatAt || !Number.isFinite(heartbeatAt.getTime())) return false;
  const timeoutMs = Number(options.heartbeatTimeoutMs ?? DEFAULT_JOB_HEARTBEAT_TIMEOUT_MS);
  if (now.getTime() - heartbeatAt.getTime() > timeoutMs) return false;
  if (options.checkOwnerPid !== false && !pidLooksAlive(job.ownerPid)) return false;
  return true;
}

export function markOpenJobsStale(workersDir, reason = "previous Pi process exited before this job completed") {
  const openJobs = listJobs(workersDir, { limit: 10000 }).filter((job) => !isTerminalJob(job));
  for (const job of openJobs) {
    const staleJob = updateJob(job, {
      status: "stale",
      finishedAt: nowIso(),
      error: reason,
    });
    appendJobEvent(staleJob, { type: "stale", message: reason });
    markLinkedOutsourceRunsStale(workersDir, staleJob, reason);
  }
  return openJobs.length;
}

function markLinkedOutsourceRunsStale(workersDir, job, reason) {
  if (job?.kind !== "outsource-run") return;
  try {
    markOutsourceRunsStaleForJob(workersDir, job, reason);
  } catch {
    // Job recovery must not fail because an auxiliary outsource index is corrupt.
  }
}

export function recoverOpenJobsOnStartup(
  workersDir,
  reason = "previous Pi process exited before this in-process job completed",
  options = {},
) {
  const now = toDate(options.now);
  const openJobs = listJobs(workersDir, { limit: 10000 }).filter((job) => !isTerminalJob(job));
  const summary = {
    totalOpen: openJobs.length,
    recovered: 0,
    stale: 0,
    checkedAt: now.toISOString(),
  };

  for (const job of openJobs) {
    if (hasFreshJobHeartbeat(job, { ...options, now })) {
      const alreadyOrphan = job.status === "orphan-running";
      const recoveredJob = updateJob(job, {
        status: "orphan-running",
        recoveryState: "orphan-running",
        recoveryCheckedAt: now.toISOString(),
        recoveredAt: job.recoveredAt || now.toISOString(),
        recoveryReason: "fresh heartbeat observed during plugin startup",
      });
      appendJobEvent(recoveredJob, {
        type: alreadyOrphan ? "recovery_check" : "recovered",
        message: "fresh heartbeat observed during plugin startup; keeping job open as orphan-running",
        heartbeatAt: job.heartbeatAt,
        ownerPid: job.ownerPid,
        ownerInstanceId: job.ownerInstanceId,
      });
      summary.recovered++;
      continue;
    }

    const staleJob = updateJob(job, {
      status: "stale",
      finishedAt: now.toISOString(),
      error: reason,
      recoveryState: "stale",
      recoveryCheckedAt: now.toISOString(),
    });
    appendJobEvent(staleJob, { type: "stale", message: reason });
    markLinkedOutsourceRunsStale(workersDir, staleJob, reason);
    summary.stale++;
  }

  return summary;
}

export function formatJobLine(job) {
  const elapsed = job.elapsedSeconds == null ? "" : ` | ${job.elapsedSeconds}s`;
  const error = job.error ? ` | error: ${String(job.error).slice(0, 80)}` : "";
  const mode = job.deliveryMode ? ` | ${job.deliveryMode}` : "";
  const queued = job.status === "queued" && job.queuePosition ? ` | queue #${job.queuePosition}` : "";
  return `${job.id} | ${job.status}${queued} | ${job.worker} | ${job.project || job.kind}${mode}${elapsed}${error}`;
}

function truncate(text, max = MAX_EVENT_TEXT_CHARS) {
  const value = String(text ?? "");
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n...(${value.length - max} chars omitted)`;
}

function parseMaybeJson(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try { return JSON.parse(trimmed); } catch { return value; }
}

function extractText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join("\n");
  if (typeof value === "object") {
    if (Array.isArray(value.content)) return extractText(value.content);
    if (typeof value.text === "string") return value.text;
    if (typeof value.output === "string") return value.output;
    if (typeof value.stdout === "string" || typeof value.stderr === "string") {
      return [value.stdout, value.stderr].filter(Boolean).join("\n");
    }
    if (value.details) {
      const detailsText = extractText(value.details);
      if (detailsText) return detailsText;
    }
  }
  return "";
}

function compactWhitespace(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

export function formatToolArgs(name, args) {
  const value = parseMaybeJson(args);
  if (!value || value === "{}") return "";
  if (typeof value === "string") return compactWhitespace(value).slice(0, 300);
  if (typeof value !== "object") return compactWhitespace(String(value)).slice(0, 300);

  if (name === "bash") return compactWhitespace(value.command || value.cmd || JSON.stringify(value)).slice(0, 300);
  if (["read", "write", "edit", "grep", "find", "ls"].includes(name)) {
    const path = value.path || value.file || value.pattern || value.command;
    const extra = [];
    if (value.offset != null) extra.push(`offset=${value.offset}`);
    if (value.limit != null) extra.push(`limit=${value.limit}`);
    if (value.timeout != null) extra.push(`timeout=${value.timeout}`);
    return [path, ...extra].filter(Boolean).join(" ");
  }
  return compactWhitespace(JSON.stringify(value)).slice(0, 300);
}

export function formatToolResult(name, result, isError = false) {
  const text = compactWhitespace(extractText(result));
  if (!text) return isError ? "error" : "";
  return truncate(text, 500);
}

export function formatJobEvent(event) {
  if (event.type === "thinking") return `[thinking] ${truncate(event.text || "", 300)}`;
  if (event.type === "text") return `[text] ${truncate(event.text || "")}`;
  if (event.type === "tool") {
    const args = formatToolArgs(event.name || "", event.args);
    const output = truncate(compactWhitespace(event.output || ""), 500);
    const result = formatToolResult(event.name || "", event.result, event.isError);
    const parts = [];
    if (output) parts.push(`output: ${output}`);
    if (result && result !== output) parts.push(`result: ${result}`);
    return `[tool${event.isError ? ":error" : ""}] ${event.name || ""}${args ? `: ${args}` : ""}${parts.length ? ` | ${parts.join(" | ")}` : ""}`;
  }
  if (event.type === "tool_start") {
    const args = formatToolArgs(event.name || "", event.args);
    return `[tool:start] ${event.name || ""}${args ? `: ${args}` : ""}`;
  }
  if (event.type === "tool_end") {
    const result = formatToolResult(event.name || "", event.result, event.isError);
    return `[tool:end] ${event.name || ""}${event.isError ? " error" : ""}${result ? `: ${result}` : ""}`;
  }
  if (event.type === "tool_output") {
    const text = truncate(compactWhitespace(event.text || ""), 500);
    return `[tool:output] ${event.name || ""}${text ? `: ${text}` : ""}`;
  }
  if (event.type === "codex_thread") return `[codex:thread] ${event.threadId || event.text || ""}`;
  if (event.type === "claude_session") return `[claude:session] ${event.sessionId || event.text || ""}`;
  if (event.type === "kimi_session") return `[kimi:session] ${event.sessionId || event.text || ""}`;
  if (event.type === "error") return `[error] ${event.message || event.text || ""}`;
  if (event.type === "late_event_after_terminal") {
    return `[late event after terminal] ${event.originalType || "unknown"} ignored because job is ${event.terminalStatus || "terminal"}`;
  }
  if (event.type === "done") {
    if (event.text) return `[done] ${truncate(event.text)}`;
    const cached = event.cachedInputTokens ? `, cached ${event.cachedInputTokens}` : "";
    const reasoning = event.reasoningOutputTokens ? `, reasoning ${event.reasoningOutputTokens}` : "";
    const total = event.totalTokens ? `, total ${event.totalTokens}` : "";
    return `[done] ${event.turns ?? 0} rounds, input ${event.inputTokens ?? 0}${cached}, output ${event.outputTokens ?? 0}${reasoning}${total}`;
  }
  return `[${event.type}] ${event.text || event.message || ""}`;
}

export function latestReplyFromEvents(events = []) {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === "done" && event.text) return event.text;
  }
  return "";
}

export function compactJobEvents(events = []) {
  const compacted = [];
  let textBuffer = "";
  const flushText = () => {
    if (!textBuffer) return;
    compacted.push({ type: "text", text: textBuffer });
    textBuffer = "";
  };

  for (const event of events) {
    if (event.type === "text") {
      textBuffer += event.text || "";
      continue;
    }
    flushText();
    compacted.push(event);
  }
  flushText();
  return compacted;
}

export function compactJobTimelineEvents(events = []) {
  const compacted = [];
  let textBuffer = "";
  let textTime = null;
  let thinkingBuffer = "";
  let thinkingTime = null;
  let activeTool = null;

  const flushText = () => {
    if (!textBuffer) return;
    compacted.push({ time: textTime, type: "text", text: textBuffer });
    textBuffer = "";
    textTime = null;
  };
  const flushThinking = () => {
    if (!thinkingBuffer) return;
    compacted.push({ time: thinkingTime, type: "thinking", text: thinkingBuffer });
    thinkingBuffer = "";
    thinkingTime = null;
  };
  const flushTool = () => {
    if (!activeTool) return;
    compacted.push(activeTool);
    activeTool = null;
  };
  const isThinkingDelimiterText = (event) =>
    event.type === "text" && ["<think>", "</think>"].includes(String(event.text || "").trim());
  const sameTool = (event) => {
    if (!activeTool) return false;
    if (!event.name || !activeTool.name) return true;
    return activeTool.name === event.name;
  };
  const ensureTool = (event) => {
    if (activeTool && !sameTool(event)) flushTool();
    if (!activeTool) {
      activeTool = {
        time: event.time || null,
        type: "tool",
        name: event.name || null,
        args: event.args,
        output: "",
        isError: false,
        sourceTypes: [],
      };
    }
    if (event.name && !activeTool.name) activeTool.name = event.name;
    if (event.args && !activeTool.args) activeTool.args = event.args;
    if (event.time && !activeTool.time) activeTool.time = event.time;
    activeTool.sourceTypes.push(event.type);
    return activeTool;
  };

  for (const event of events) {
    if (isThinkingDelimiterText(event)) {
      flushThinking();
      continue;
    }
    if (event.type === "thinking") {
      flushText();
      flushTool();
      if (!thinkingBuffer) thinkingTime = event.time || null;
      thinkingBuffer += event.text || "";
      continue;
    }
    if (event.type === "text") {
      flushThinking();
      flushTool();
      if (!textBuffer) textTime = event.time || null;
      textBuffer += event.text || "";
      continue;
    }
    if (event.type === "tool_start") {
      flushText();
      flushThinking();
      flushTool();
      ensureTool(event);
      continue;
    }
    if (event.type === "tool_output") {
      flushText();
      flushThinking();
      const tool = ensureTool(event);
      tool.output += event.text || "";
      continue;
    }
    if (event.type === "tool_end") {
      flushText();
      flushThinking();
      const tool = ensureTool(event);
      tool.result = event.result;
      tool.isError = Boolean(event.isError);
      tool.finishedAt = event.time || null;
      flushTool();
      continue;
    }

    flushText();
    flushThinking();
    flushTool();
    compacted.push(event.type === "done" && event.text ? { ...event, text: "" } : event);
  }

  flushText();
  flushThinking();
  flushTool();
  return compacted;
}

export function formatJobDetails(job, events = tailJobEvents(job, 80)) {
  const latestReply = job.fullOutput || latestReplyFromEvents(events) || "";
  const lines = [
    `Job: ${job.id}`,
    `Status: ${job.status}`,
    `Worker: ${job.worker}`,
    `Project: ${job.project || "-"}`,
    `Task: ${truncate(job.task || "-", 500)}`,
    `Created: ${job.createdAt}`,
    `Updated: ${job.updatedAt}`,
  ];
  if (job.pid) lines.push(`PID: ${job.pid}`);
  if (job.model) lines.push(`Model: ${job.model}`);
  if (job.deliveryMode) lines.push(`Delivery: ${job.deliveryMode}`);
  if (job.queuedBehind) lines.push(`Queued behind: ${job.queuedBehind}`);
  if (job.error) lines.push(`Error: ${job.error}`);
  if (!latestReply && job.summary) lines.push(`Summary: ${job.summary}`);
  if (latestReply) {
    lines.push("");
    lines.push("Latest reply:");
    lines.push(truncate(latestReply, MAX_LATEST_REPLY_CHARS));
  }
  lines.push("");
  lines.push("Recent events:");
  const compactedEvents = compactJobEvents(events).filter((event) => !(event.type === "done" && event.text));
  for (const event of compactedEvents) {
    lines.push(formatJobEvent(event));
  }
  return lines.join("\n");
}

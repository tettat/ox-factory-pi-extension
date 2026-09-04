#!/usr/bin/env node
// 牛马工厂本地 Web 协作驾驶舱
// ---------------------------------------------------------------------------
// 目标：把 .pi/workers/ 下的工厂运行数据聚合成一个本地仪表盘。
// 边界：读优先；Web talk/control 只写 intent，由 Pi 主进程接管执行。不写权限 / 不 apply 主 agent 压缩 / 不扫全局 session。
// 数据：复用 jobs / comm / token-report / report-context / compaction 现有模块。
// ---------------------------------------------------------------------------

import { createServer } from "node:http";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, isAbsolute, join, resolve, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  listJobs,
  readJob,
  tailJobEvents,
  latestReplyFromEvents,
  compactJobTimelineEvents,
  formatJobEvent,
} from "./jobs.mjs";
import {
  readPermissions,
  hasPermission,
  listPermissions,
  listMessages,
  markMessageRead,
  markWorkerMessagesRead,
  formatPermissions,
  formatMessages,
  messagesFile,
  permissionEventsFile,
} from "./comm.mjs";
import {
  cancelWebTalkRequest,
  createWebTalkRequest,
  createWebTalkJobControlRequest,
  editWebTalkRequest,
  getWebTalkJobControlRequest,
  getWebTalkRequest,
  listWebTalkJobControlRequests,
  listWebTalkRequests,
  normalizeWebTalkMode,
} from "./web-talk.mjs";
import {
  buildWorkerJobUnreadSummary,
  markWebJobRead,
  markWorkerJobsRead,
} from "./web-job-read.mjs";
import {
  createMainAgentTalkRequest,
  getMainAgentTalkRequest,
  listMainAgentTalkRequests,
} from "./main-agent-talk.mjs";
import {
  cancelWorkerTaskRequest,
  createWorkerTaskRequest,
  editWorkerTaskRequest,
  getWorkerTaskRequest,
  listWorkerTaskRequests,
  normalizeWorkerTaskMode,
} from "./task-requests.mjs";
import {
  FactoryTaskConflictError,
  archiveFactoryTask,
  createFactoryTask,
  getFactoryTask,
  listFactoryTasks,
  restoreFactoryTask,
  splitFactoryTask,
  updateFactoryTask,
} from "./task-board.mjs";
import { dispatchDueFactoryTasks, dispatchFactoryTask } from "./task-dispatcher.mjs";
import {
  findMainSessionFile,
  getWorkerRegistrySnapshot,
} from "./worker-registry-snapshot.mjs";
import {
  listOutsourceProfiles,
  getOutsourceProfile,
  listOutsourceRuns,
  getOutsourceRun,
  OUTSOURCE_TERMINAL_STATUSES,
} from "./outsource-agents.mjs";
import {
  normalizeOutsourceWait,
  startOutsourceRunJob,
} from "./outsource-dispatcher.mjs";
import { buildFactoryTokenReport, buildFactoryTokenTrend, formatFactoryTokenReport, localDateString } from "./token-report.mjs";
import { buildFactoryReportContext, formatFactoryReportContext } from "./report-context.mjs";
import {
  readFactoryCompactionShadowRecords,
  buildFactoryCompactionReport,
  formatFactoryCompactionReport,
} from "./compaction.mjs";
import { buildFactoryQualityReport } from "./quality-metrics.mjs";
import {
  buildJobNotifications,
  readNotificationSettings,
  writeNotificationSettings,
} from "./notifications.mjs";
import {
  listWorkerResponsibilities,
  summarizeResponsibilities,
} from "./responsibilities.mjs";
import { listProjects as listStoredProjects, resolveProject as resolveStoredProject } from "./projects.mjs";
import { markdownPreviewText } from "./markdown-preview.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WEB_DIR = join(__dirname, "web");
const VERSION = "phase-1-0.1.0";
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const QUALITY_CACHE_TTL_MS = 30_000;
const JOB_DETAIL_REPLY_MAX_CHARS = 200_000;
const qualityMetricsCache = new Map();

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { port: 8787, workersDir: null, host: "127.0.0.1" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port" || a === "-p") args.port = Number(argv[++i]);
    else if (a === "--workers-dir" || a === "-w") args.workersDir = argv[++i];
    else if (a === "--host" || a === "-H") args.host = argv[++i];
    else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  if (!args.workersDir) {
    // 兜底：相对项目根
    args.workersDir = resolve(__dirname, "..", "..", "workers");
  }
  args.workersDir = resolve(args.workersDir);
  return args;
}

function printHelp() {
  process.stdout.write(
    [
      "牛马工厂本地 Web 协作驾驶舱",
      "",
      "用法:",
      "  node .pi/extensions/ox-factory/web-server.mjs [--workers-dir <dir>] [--port <n>] [--host <addr>]",
      "",
      "选项:",
      "  --workers-dir, -w   员工数据根目录 (默认: .pi/workers)",
      "  --port, -p          HTTP 端口 (默认: 8787)",
      "  --host, -H          监听地址 (默认: 127.0.0.1)",
      "  --help, -h          显示帮助",
      "",
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// 外包判定 (可复用且可测试)
// ---------------------------------------------------------------------------

/**
 * 判断一个 job 是否是外包执行的。
 * 可靠识别 kind === "outsource-run"；同时对 worker 名做防御性识别。
 */
export function isOutsourceJob(job) {
  if (!job || typeof job !== "object") return false;
  if (job.kind && String(job.kind).toLowerCase() === "outsource-run") return true;
  if (isOutsourceWorkerName(job.worker)) return true;
  return false;
}

/**
 * 判断 worker 名是否是外包虚拟 worker（以 "外包:" 开头）。
 * 防御性识别，避免历史数据/registry/session 污染正式员工列表。
 */
export function isOutsourceWorkerName(name) {
  if (!name) return false;
  return String(name).trim().startsWith("外包:");
}

/**
 * 计算可靠的完成时间：finishedAt → completedAt → cancelledAt → staleAt → updatedAt。
 * @param {object} run - outsource run 或 job 对象
 * @returns {string|null} ISO 时间字符串或 null
 */
export function computeReliableFinishedAt(run) {
  if (!run || typeof run !== "object") return null;
  const explicitFinishedAt = run.finishedAt || run.completedAt || run.cancelledAt || run.staleAt;
  if (explicitFinishedAt) return explicitFinishedAt;
  return OUTSOURCE_TERMINAL_STATUSES.has(run.status) ? run.updatedAt || null : null;
}

/**
 * 计算可靠的耗时（毫秒）。
 * 优先使用持久化的 elapsedMs；否则用 startedAt 或 createdAt 到 finishedAt 计算。
 * @param {object} run - outsource run 或 job 对象
 * @param {object} [finishedInfo] - 可选的完成时间覆盖 { finishedAt }
 * @returns {number|null} 毫秒数或 null
 */
export function computeReliableElapsedMs(run, finishedInfo = {}) {
  if (!run || typeof run !== "object") return null;
  // 优先使用持久化的 elapsedMs；合法的 0 也接受
  if (typeof run.elapsedMs === "number" && Number.isFinite(run.elapsedMs) && run.elapsedMs >= 0) return run.elapsedMs;
  // elapsedSeconds 兜底（job 字段）
  if (typeof run.elapsedSeconds === "number" && Number.isFinite(run.elapsedSeconds) && run.elapsedSeconds >= 0) return run.elapsedSeconds * 1000;
  // 计算 startedAt → finishedAt
  const finishedAt = finishedInfo.finishedAt || computeReliableFinishedAt(run);
  if (!finishedAt) return null;
  const startAt = run.startedAt || run.createdAt;
  if (!startAt) return null;
  const startMs = Date.parse(startAt);
  const finishMs = Date.parse(finishedAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(finishMs)) return null;
  const elapsed = finishMs - startMs;
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function jsonResponse(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "content-length": Buffer.byteLength(payload, "utf8"),
  });
  res.end(payload);
}

function errorResponse(res, status, message, detail) {
  jsonResponse(res, status, { error: { status, message, detail: detail || null } });
}

function notFound(res, message = "Not Found") {
  errorResponse(res, 404, message);
}

function badRequest(res, message, detail) {
  errorResponse(res, 400, message, detail);
}

function safeReadJsonl(file) {
  if (!existsSync(file)) return [];
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function readQueueFile(workersDir) {
  return safeReadJsonl(join(workersDir, "queue.jsonl"));
}

function listSessionWorkers(workersDir) {
  const dir = join(workersDir, "sessions");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith(".jsonl"))
    .map((n) => n.slice(0, -".jsonl".length));
}

export function uniqueWorkers(workersDir) {
  const sessions = listSessionWorkers(workersDir).filter((n) => !isOutsourceWorkerName(n));
  const jobs = listJobs(workersDir, { limit: 100000 });
  const set = new Set(sessions);
  for (const job of jobs) {
    if (job.worker && !isOutsourceJob(job)) set.add(String(job.worker));
  }
  return [...set].filter(Boolean).sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
}

function summarizeJobForOverview(job) {
  return {
    id: job.id,
    status: job.status,
    worker: job.worker,
    kind: job.kind || "",
    project: job.project || "",
    displayChannel: job.displayChannel || "",
    source: job.source || "",
    assignedBy: job.assignedBy || "",
    returnTo: job.returnTo || "",
    model: job.model || null,
    task: compactText(job.task || "", 80),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt,
    summary: compactText(job.summary || "", 200),
    error: compactText(job.error || "", 200),
  };
}

function compactText(value, max = 160) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return text.slice(0, max) + "…";
}

function detailText(value, max = JOB_DETAIL_REPLY_MAX_CHARS) {
  const text = String(value ?? "");
  return {
    text: text.length > max ? text.slice(0, max) : text,
    chars: text.length,
    truncated: text.length > max,
    limit: max,
  };
}

function readWorkersRelativeText(workersDir, relativePath, maxBytes = 200_000) {
  const rel = String(relativePath || "").trim();
  if (!rel) return "";
  const root = resolve(workersDir);
  const file = resolve(root, rel);
  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (file !== root && !file.startsWith(rootPrefix)) return "";
  if (!existsSync(file)) return "";
  try {
    const st = statSync(file);
    if (!st.isFile()) return "";
    const text = readFileSync(file, "utf8");
    return text.length > maxBytes ? text.slice(0, maxBytes) : text;
  } catch {
    return "";
  }
}

function isHttpRef(ref) {
  return /^https?:\/\//i.test(String(ref || "").trim());
}

function cleanRef(ref) {
  return String(ref || "").trim();
}

function isMarkdownRef(ref) {
  return cleanRef(ref).toLowerCase().endsWith(".md");
}

function pathInsideRoot(filePath, rootPath) {
  const file = resolve(filePath);
  const root = resolve(rootPath);
  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return file === root || file.startsWith(rootPrefix);
}

function projectMarkdownRefs(project) {
  const refs = [];
  const add = (entry) => {
    if (!entry || typeof entry !== "object") return;
    const ref = cleanRef(entry.ref || entry.path || entry.url);
    if (!ref || isHttpRef(ref)) return;
    const type = cleanRef(entry.type).toLowerCase();
    if (type === "markdown" || isMarkdownRef(ref)) refs.push(ref);
  };
  add(project?.truth);
  for (const link of Array.isArray(project?.links) ? project.links : []) add(link);
  return [...new Set(refs)];
}

export function resolveProjectMarkdownDocRef({ project, ref, extensionRoot = __dirname, repoRoot = REPO_ROOT } = {}) {
  const registeredRefs = projectMarkdownRefs(project);
  const selectedRef = cleanRef(ref) || registeredRefs[0] || "";
  if (!selectedRef) {
    return { ok: false, status: 404, message: "项目没有登记本地 Markdown 文档" };
  }
  if (!registeredRefs.includes(selectedRef)) {
    return { ok: false, status: 403, message: "只能读取项目结构中已登记的 Markdown 文档", ref: selectedRef };
  }
  if (isHttpRef(selectedRef)) {
    return { ok: false, status: 400, message: "网络地址应由前端直接打开，不通过本地 Markdown 渲染接口", ref: selectedRef };
  }
  if (!isMarkdownRef(selectedRef)) {
    return { ok: false, status: 400, message: "只支持渲染 .md 文档", ref: selectedRef };
  }

  const candidates = isAbsolute(selectedRef)
    ? [resolve(selectedRef)]
    : [resolve(extensionRoot, selectedRef), resolve(repoRoot, selectedRef)];
  const allowedRoots = [resolve(extensionRoot), resolve(repoRoot)];
  for (const filePath of candidates) {
    if (!allowedRoots.some((root) => pathInsideRoot(filePath, root))) continue;
    if (!existsSync(filePath)) continue;
    try {
      const st = statSync(filePath);
      if (!st.isFile()) continue;
      return { ok: true, ref: selectedRef, filePath, size: st.size };
    } catch {
      continue;
    }
  }
  return { ok: false, status: 404, message: "本地 Markdown 文档不存在或不可读", ref: selectedRef };
}

function pickStatus(jobs) {
  // 员工当前状态：取最近一个非终态 job，否则 idle
  if (!jobs || jobs.length === 0) return "idle";
  const sorted = [...jobs].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const latest = sorted[0];
  if (["running", "queued"].includes(latest.status)) return "busy";
  if (["stale", "failed", "aborted"].includes(latest.status)) return "error";
  if (latest.status === "orphan-running") return "busy";
  if (["done"].includes(latest.status)) return "idle";
  return "idle";
}

// ---------------------------------------------------------------------------
// 派生项目视角 (从 job.project 聚合)
// ---------------------------------------------------------------------------
export function buildProjectStrips(workersDir) {
  const jobs = listJobs(workersDir, { limit: 100000 });
  const byProject = new Map();
  for (const job of jobs) {
    const name = job.project || "未归档";
    if (!byProject.has(name)) {
      byProject.set(name, {
        name,
        total: 0,
        byStatus: {},
        participants: new Set(),
        lastActivity: job.updatedAt || job.createdAt,
        lastSummary: "",
        lastJobId: job.id,
      });
    }
    const p = byProject.get(name);
    p.total += 1;
    p.byStatus[job.status] = (p.byStatus[job.status] || 0) + 1;
    // 只把正式员工加入 participants，外包虚拟 worker 排除
    if (job.worker && !isOutsourceJob(job)) p.participants.add(job.worker);
    const lastTs = job.updatedAt || job.createdAt;
    if (lastTs && String(lastTs).localeCompare(String(p.lastActivity)) > 0) {
      p.lastActivity = lastTs;
      p.lastSummary = compactText(job.summary || job.task || "", 160);
      p.lastJobId = job.id;
    }
  }
  const strips = [...byProject.values()].map((p) => ({
    name: p.name,
    total: p.total,
    byStatus: p.byStatus,
    participants: [...p.participants],
    lastActivity: p.lastActivity,
    lastSummary: p.lastSummary,
    lastJobId: p.lastJobId,
  }));
  return strips.sort((a, b) => String(b.lastActivity).localeCompare(String(a.lastActivity))).slice(0, 8);
}

// ---------------------------------------------------------------------------
// 风险聚合
// ---------------------------------------------------------------------------
function buildRisks(workersDir, jobs, compactions) {
  const risks = [];
  const now = Date.now();
  for (const job of jobs) {
    if (job.status === "stale") {
      risks.push({
        level: "high",
        source: "job",
        ref: job.id,
        message: `Stale job: ${job.worker} / ${job.project || "—"} — ${compactText(job.error || job.task || "", 100)}`,
        at: job.finishedAt || job.updatedAt,
      });
    } else if (job.status === "orphan-running") {
      risks.push({
        level: "high",
        source: "job",
        ref: job.id,
        message: `Orphan-running job: ${job.worker} 进程丢失`,
        at: job.updatedAt,
      });
    } else if (job.status === "failed" || job.status === "aborted") {
      risks.push({
        level: "medium",
        source: "job",
        ref: job.id,
        message: `${job.status}: ${job.worker} / ${compactText(job.task || job.error || "", 100)}`,
        at: job.finishedAt || job.updatedAt,
      });
    }
  }
  for (const c of compactions || []) {
    if (c.targetType === "main" && c.codex?.error) {
      risks.push({
        level: "medium",
        source: "compaction",
        ref: c.id,
        message: `Codex shadow 压缩失败（主 agent）: ${compactText(c.codex.error, 100)}`,
        at: c.createdAt,
      });
    }
  }
  // 按时间倒序，最多 8 条
  return risks.sort((a, b) => String(b.at || "").localeCompare(String(a.at || ""))).slice(0, 8);
}

function getWorkerRegistry(workersDir) {
  return getWorkerRegistrySnapshot(workersDir);
}

// ---------------------------------------------------------------------------
// 员工视角聚合 (含今日 token / 最新 job / 未读消息)
// ---------------------------------------------------------------------------
export function buildWorkersView(workersDir, jobs, tokenReport, messages, registry) {
  const reg = registry || getWorkerRegistry(workersDir);
  // 过滤掉外包虚拟 worker（防御性：sessions/registry 里可能有 外包: 污染）
  const allNames = [...new Set([...uniqueWorkers(workersDir), ...reg.keys()])]
    .filter(Boolean)
    .filter((n) => !isOutsourceWorkerName(n))
    .sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
  const names = allNames;
  const unreadJobs = buildWorkerJobUnreadSummary(workersDir, jobs || []);
  const talkRequests = listWebTalkRequests(workersDir, { limit: 10000 });
  const messageEvents = safeReadJsonl(messagesFile(workersDir));
  const tokenMap = new Map((tokenReport?.workers || []).map((t) => [t.worker, t]));
  const responsibilityMap = new Map();
  for (const responsibility of listWorkerResponsibilities(workersDir)) {
    const list = responsibilityMap.get(responsibility.worker) || [];
    list.push(responsibility);
    responsibilityMap.set(responsibility.worker, list);
  }
  const messageReads = new Map();
  for (const event of messageEvents) {
    if (event.type !== "read" || !event.worker || !event.messageId) continue;
    const reads = messageReads.get(event.worker) || new Set();
    reads.add(event.messageId);
    messageReads.set(event.worker, reads);
  }
  const messageStats = new Map();
  function ensureMessageStats(worker) {
    const key = String(worker || "").trim();
    if (!key) return null;
    if (!messageStats.has(key)) messageStats.set(key, { unread: 0, lastMessageAt: null });
    return messageStats.get(key);
  }
  function bumpMessageAt(worker, at) {
    const stats = ensureMessageStats(worker);
    if (!stats || !at) return;
    if (!stats.lastMessageAt || String(at).localeCompare(String(stats.lastMessageAt)) > 0) stats.lastMessageAt = at;
  }
  for (const event of messageEvents) {
    if (event.type !== "message" || !event.id) continue;
    const at = event.createdAt || null;
    if (event.from && event.from !== "*") bumpMessageAt(event.from, at);
    if (event.to === "*") {
      for (const name of names) {
        if (name === event.from) continue;
        bumpMessageAt(name, at);
        if (!messageReads.get(name)?.has(event.id)) ensureMessageStats(name).unread += 1;
      }
    } else if (event.to) {
      bumpMessageAt(event.to, at);
      if (!messageReads.get(event.to)?.has(event.id)) ensureMessageStats(event.to).unread += 1;
    }
  }
  const requestAtByWorker = new Map();
  for (const request of talkRequests) {
    const worker = String(request.worker || "").trim();
    if (!worker) continue;
    const at = request.acceptedAt || request.createdAt || request.editedAt || null;
    if (!at) continue;
    const previous = requestAtByWorker.get(worker);
    if (!previous || String(at).localeCompare(String(previous)) > 0) requestAtByWorker.set(worker, at);
  }
  const jobsByWorker = new Map();
  for (const j of jobs) {
    const list = jobsByWorker.get(j.worker) || [];
    list.push(j);
    jobsByWorker.set(j.worker, list);
  }
  return names.map((name) => {
    const jobsForWorker = (jobsByWorker.get(name) || []).sort((a, b) =>
      String(b.updatedAt).localeCompare(String(a.updatedAt)),
    );
    const regInfo = reg.get(name) || {};
    const status = regInfo.status === "vacation" ? "vacation" : pickStatus(jobsForWorker);
    const token = tokenMap.get(name);
    const messageStat = messageStats.get(name) || {};
    const unread = messageStat.unread || 0;
    const unreadJobState = unreadJobs.byWorker.get(name) || {};
    const unreadJobUpdates = unreadJobState.unreadJobs || 0;
    const unreadJobEvents = unreadJobState.unreadEvents || 0;
    const unreadCount = unread + unreadJobUpdates;
    const responsibilities = responsibilityMap.get(name) || [];
    const lastJobAt = jobsForWorker[0]?.updatedAt || jobsForWorker[0]?.createdAt || null;
    const lastReplyJob = jobsForWorker.find((job) =>
      (job.kind === "talk" || job.project === "talk" || job.displayChannel === "talk")
      && compactText(job.fullOutput || job.summary || job.error || "", 1)
    );
    const lastTalkReply = lastReplyJob
      ? {
          jobId: lastReplyJob.id,
          status: lastReplyJob.status,
          project: lastReplyJob.project || "",
          contentPreview: markdownPreviewText(lastReplyJob.fullOutput || lastReplyJob.summary || lastReplyJob.error || "", { max: 120 }),
          updatedAt: lastReplyJob.updatedAt || lastReplyJob.finishedAt || lastReplyJob.createdAt || null,
        }
      : null;
    const lastInteractionAt = [
      messageStat.lastMessageAt,
      requestAtByWorker.get(name),
      unreadJobState.lastUnreadAt,
      lastJobAt,
    ].filter(Boolean).sort().at(-1) || null;
    return {
      name,
      status,
      role: regInfo.role || null,
      avatar: regInfo.avatar || null,
      backend: regInfo.backend || null,
      model: regInfo.model || null,
      thinking: regInfo.thinking || null,
      responsibility: summarizeResponsibilities(responsibilities, { max: 2 }),
      responsibilities,
      jobCount: jobsForWorker.length,
      lastJob: jobsForWorker[0]
        ? {
            id: jobsForWorker[0].id,
            status: jobsForWorker[0].status,
            project: jobsForWorker[0].project || "",
            task: compactText(jobsForWorker[0].task || "", 80),
            updatedAt: jobsForWorker[0].updatedAt,
          }
        : null,
      tokenToday: token
        ? {
            input: token.reported.inputTokens,
            output: token.reported.outputTokens,
            total: token.reported.totalTokens,
            totalWithCached: token.reported.totalWithCachedTokens,
            source: token.source,
          }
        : null,
      lastTalkReply,
      unreadMessages: unread,
      unreadJobUpdates,
      unreadJobEvents,
      unreadCount,
      lastUnreadAt: unreadJobState.lastUnreadAt || null,
      lastInteractionAt,
    };
  }).sort((a, b) => {
    const aInteraction = String(a.lastInteractionAt || "");
    const bInteraction = String(b.lastInteractionAt || "");
    if (aInteraction || bInteraction) return bInteraction.localeCompare(aInteraction);
    const aActive = a.status === "idle" ? 0 : 1;
    const bActive = b.status === "idle" ? 0 : 1;
    if (aActive !== bActive) return bActive - aActive;
    return String(a.name || "").localeCompare(String(b.name || ""), "zh-Hans-CN");
  });
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------
function isTrustedMutationOrigin(req) {
  const origin = String(req.headers.origin || "").trim();
  if (!origin) return true;
  try {
    return new URL(origin).host.toLowerCase() === String(req.headers.host || "").trim().toLowerCase();
  } catch {
    return false;
  }
}

export function buildRouter({ workersDir }) {
  return async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
    const pathname = url.pathname;
    const method = (req.method || "GET").toUpperCase();

    if (["POST", "PATCH", "DELETE"].includes(method) && !isTrustedMutationOrigin(req)) {
      return errorResponse(res, 403, "拒绝跨站写入本地牛马工厂");
    }
    if (method === "OPTIONS") {
      if (!isTrustedMutationOrigin(req)) return errorResponse(res, 403, "拒绝跨站预检请求");
      res.writeHead(204, {
        "access-control-allow-origin": req.headers.origin || "*",
        "access-control-allow-methods": "GET,OPTIONS,POST,PATCH,DELETE",
        "access-control-allow-headers": "content-type",
      });
      res.end();
      return;
    }
    // /api/talk/:worker 与 /api/main-agent/talk 接受 POST；其余仍只 GET
    if (method === "POST" && pathname.startsWith("/api/talk/")) {
      try {
        const body = await readJsonBody(req);
        return await handleTalkMessage(workersDir, res, pathname, body);
      } catch (err) {
        return errorResponse(res, 400, `读取请求体失败: ${err.message}`);
      }
    }
    if (method === "POST" && pathname === "/api/main-agent/talk") {
      try {
        const body = await readJsonBody(req);
        return await handleMainAgentTalkMessage(workersDir, res, body);
      } catch (err) {
        return errorResponse(res, 400, `读取请求体失败: ${err.message}`);
      }
    }
    if (method === "POST" && pathname === "/api/task-requests") {
      try {
        const body = await readJsonBody(req);
        return await handleWorkerTaskRequestCreate(workersDir, res, body);
      } catch (err) {
        return errorResponse(res, 400, `读取请求体失败: ${err.message}`);
      }
    }
    if (method === "POST" && (pathname === "/api/factory-tasks" || pathname.startsWith("/api/factory-tasks/"))) {
      try {
        const body = await readJsonBody(req);
        return await handleFactoryTaskMutation(workersDir, res, pathname, method, body);
      } catch (err) {
        return handleFactoryTaskMutationError(res, err);
      }
    }
    if ((method === "POST" || method === "PATCH") && pathname === "/api/outsource/runs") {
      try {
        const body = await readJsonBody(req);
        return await handleOutsourceRunCreate(workersDir, res, body);
      } catch (err) {
        return errorResponse(res, 400, `读取请求体失败: ${err.message}`);
      }
    }
    if ((method === "POST" || method === "PATCH") && pathname === "/api/notification-settings") {
      try {
        const body = await readJsonBody(req);
        return await handleNotificationSettingsMutation(workersDir, res, body);
      } catch (err) {
        return errorResponse(res, 400, `读取请求体失败: ${err.message}`);
      }
    }
    if ((method === "PATCH" || method === "POST") && pathname.startsWith("/api/task-requests/")) {
      try {
        const body = await readJsonBody(req);
        return await handleWorkerTaskRequestMutation(workersDir, res, pathname, method, body);
      } catch (err) {
        return errorResponse(res, 400, `读取请求体失败: ${err.message}`);
      }
    }
    if ((method === "PATCH" || method === "POST") && pathname.startsWith("/api/talk-requests/")) {
      try {
        const body = await readJsonBody(req);
        return await handleTalkRequestMutation(workersDir, res, pathname, method, body);
      } catch (err) {
        return errorResponse(res, 400, `读取请求体失败: ${err.message}`);
      }
    }
    if (method === "POST" && pathname.match(/^\/api\/jobs\/[^/]+\/(read|cancel)$/)) {
      try {
        const body = await readJsonBody(req);
        return await handleJobMutation(workersDir, res, pathname, method, body);
      } catch (err) {
        return errorResponse(res, 400, `读取请求体失败: ${err.message}`);
      }
    }
    if (method === "POST" && pathname.match(/^\/api\/messages\/[^/]+\/read$/)) {
      try {
        const body = await readJsonBody(req);
        return await handleMessageMutation(workersDir, res, pathname, body);
      } catch (err) {
        return errorResponse(res, 400, `读取请求体失败: ${err.message}`);
      }
    }
    if (method === "POST" && pathname.match(/^\/api\/workers\/[^/]+\/messages\/read$/)) {
      try {
        const body = await readJsonBody(req);
        return await handleWorkerMessagesRead(workersDir, res, pathname, body);
      } catch (err) {
        return errorResponse(res, 400, `读取请求体失败: ${err.message}`);
      }
    }
    if (method === "POST" && pathname.match(/^\/api\/workers\/[^/]+\/read$/)) {
      try {
        const body = await readJsonBody(req);
        return await handleWorkerRead(workersDir, res, pathname, body);
      } catch (err) {
        return errorResponse(res, 400, `读取请求体失败: ${err.message}`);
      }
    }
    if (method === "PATCH" && pathname.match(/^\/api\/jobs\/[^/]+$/)) {
      try {
        const body = await readJsonBody(req);
        return await handleJobMutation(workersDir, res, pathname, method, body);
      } catch (err) {
        return errorResponse(res, 400, `读取请求体失败: ${err.message}`);
      }
    }
    if (method === "PATCH" && pathname.startsWith("/api/factory-tasks/")) {
      try {
        const body = await readJsonBody(req);
        return await handleFactoryTaskMutation(workersDir, res, pathname, method, body);
      } catch (err) {
        return handleFactoryTaskMutationError(res, err);
      }
    }
    if (method !== "GET") {
      res.writeHead(405, {
        "allow": "GET, OPTIONS, POST/PATCH /api/factory-tasks*, POST /api/talk/*, POST /api/main-agent/talk, POST /api/task-requests, POST/PATCH /api/outsource/runs, POST/PATCH /api/notification-settings, PATCH /api/task-requests/*, POST /api/task-requests/*/cancel, PATCH /api/talk-requests/*, POST /api/talk-requests/*/cancel, POST /api/jobs/*/read, POST /api/jobs/*/cancel, PATCH /api/jobs/*, POST /api/messages/*/read, POST /api/workers/*/messages/read, POST /api/workers/*/read",
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify({ error: { status: 405, message: `Method Not Allowed: ${method}` } }));
      return;
    }

    try {
      if (pathname === "/api/health") return handleHealth(res);
      if (pathname.startsWith("/api/avatars/")) return await handleAvatarAsset(workersDir, res, pathname);
      if (pathname === "/api/overview") return await handleOverview(workersDir, res);
      if (pathname === "/api/workers") return await handleWorkers(workersDir, res);
      if (pathname.startsWith("/api/workers/")) {
        const name = decodeURIComponent(pathname.slice("/api/workers/".length));
        return await handleWorkerDetail(workersDir, res, name, url);
      }
      if (pathname === "/api/jobs") return await handleJobs(workersDir, res, url);
      if (pathname.startsWith("/api/jobs/")) {
        const id = decodeURIComponent(pathname.slice("/api/jobs/".length));
        return await handleJobDetail(workersDir, res, id, url);
      }
      if (pathname === "/api/report-context") return await handleReportContext(workersDir, res, url);
      if (pathname === "/api/tokens") return await handleTokens(workersDir, res, url);
      if (pathname === "/api/tokens/trend") return await handleTokensTrend(workersDir, res, url);
      if (pathname === "/api/compactions") return await handleCompactions(workersDir, res, url);
      if (pathname === "/api/quality-metrics") return await handleQualityMetrics(workersDir, res, url);
      if (pathname === "/api/notification-settings") return await handleNotificationSettings(workersDir, res);
      if (pathname === "/api/notifications") return await handleNotifications(workersDir, res, url);
      if (pathname === "/api/permissions") return await handlePermissions(workersDir, res);
      if (pathname === "/api/messages") return await handleMessages(workersDir, res, url);
      if (pathname === "/api/factory-tasks" || pathname.startsWith("/api/factory-tasks/")) {
        return await handleFactoryTaskStatus(workersDir, res, pathname, url);
      }
      if (pathname === "/api/task-requests" || pathname.startsWith("/api/task-requests/")) {
        return await handleWorkerTaskRequestStatus(workersDir, res, pathname, url);
      }
      if (pathname === "/api/talk-requests" || pathname.startsWith("/api/talk-requests/")) {
        return await handleTalkRequestStatus(workersDir, res, pathname, url);
      }
      if (pathname === "/api/job-controls" || pathname.startsWith("/api/job-controls/")) {
        return await handleJobControlStatus(workersDir, res, pathname, url);
      }
      if (pathname === "/api/main-agent/transcript") return await handleMainAgentTranscript(workersDir, res, url);
      if (pathname === "/api/main-agent/talk-requests" || pathname.startsWith("/api/main-agent/talk-requests/")) {
        return await handleMainAgentTalkRequestStatus(workersDir, res, pathname, url);
      }
      if (pathname === "/api/projects") return await handleProjects(workersDir, res);
      if (pathname === "/api/project-doc") return await handleProjectDoc(workersDir, res, url);
      if (pathname.startsWith("/api/projects/")) {
        const id = decodeURIComponent(pathname.slice("/api/projects/".length));
        return await handleProjectDetail(workersDir, res, id);
      }
      if (pathname === "/api/schedules") return await handleSchedules(workersDir, res, url);
      if (pathname === "/api/responsibilities") return await handleResponsibilities(workersDir, res, url);
      if (pathname === "/api/outsource/profiles") return await handleOutsourceProfiles(workersDir, res);
      if (pathname.startsWith("/api/outsource/profiles/")) {
        const name = decodeURIComponent(pathname.slice("/api/outsource/profiles/".length));
        return await handleOutsourceProfile(workersDir, res, name);
      }
      if (pathname === "/api/outsource/runs") return await handleOutsourceRuns(workersDir, res, url);
      if (pathname.startsWith("/api/outsource/runs/")) {
        const runId = decodeURIComponent(pathname.slice("/api/outsource/runs/".length));
        return await handleOutsourceRun(workersDir, res, runId);
      }
      if (pathname.startsWith("/api/")) {
        return jsonResponse(res, 404, {
          ok: false,
          detail: `API not found: ${pathname}`,
        });
      }

      // 静态文件 / SPA fallback
      return await serveStatic(res, pathname);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[web-server] ${method} ${pathname} error:`, err);
      return errorResponse(res, 500, "Internal Server Error", String(err?.message || err));
    }
  };
}

async function readJsonBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let len = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      len += chunk.length;
      if (len > maxBytes) {
        req.destroy();
        reject(new Error(`body too large (>${maxBytes})`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error("body 不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

function handleHealth(res) {
  return jsonResponse(res, 200, {
    ok: true,
    version: VERSION,
    service: "ox-factory-web-dashboard",
    phase: "1",
    features: {
      taskRequests: true,
      factoryTasks: true,
      compactJobTimeline: true,
      mainAgentTalk: true,
      workerTalkRequests: true,
    },
    timestamp: new Date().toISOString(),
  });
}

async function handleOverview(workersDir, res) {
  const today = localDateString(new Date());
  // 并发聚合
  const [jobsAll, tokenReport, compactions, messages, reportCtx] = await Promise.all([
    Promise.resolve(listJobs(workersDir, { limit: 1000 })),
    Promise.resolve(buildFactoryTokenReport({ workersDir, date: today })),
    Promise.resolve(
      readFactoryCompactionShadowRecords(workersDir, { limit: 50 }),
    ),
    Promise.resolve(listMessages(workersDir, { worker: "主agent", limit: 50 })),
    Promise.resolve(buildFactoryReportContext({ workersDir, date: today })),
  ]);
  const jobsToday = jobsAll.filter((j) => localDateString(j.createdAt) === today);
  const projectStrips = buildProjectStrips(workersDir);
  const projectCatalog = listStoredProjects(workersDir, { includeArchived: false });
  const workers = buildWorkersView(workersDir, jobsAll, tokenReport, messages);

  // Job 状态统计
  const jobStats = {
    queued: 0,
    running: 0,
    done: 0,
    failed: 0,
    aborted: 0,
    stale: 0,
    "orphan-running": 0,
  };
  for (const j of jobsAll) {
    if (jobStats[j.status] != null) jobStats[j.status] += 1;
  }

  // 健康状态
  const health = computeHealth({ jobStats, compactions, jobsAll });

  // 风险
  const risks = buildRisks(workersDir, jobsAll, compactions);

  return jsonResponse(res, 200, {
    generatedAt: new Date().toISOString(),
    date: today,
    health,
    totals: {
      workers: workers.length,
      activeWorkers: workers.filter((w) => w.status !== "idle").length,
      jobsAll: jobsAll.length,
      jobsToday: jobsToday.length,
      ...jobStats,
      tokens: tokenReport.totals,
    },
    workers: workers.slice(0, 20),
    jobStats,
    tokens: {
      top: (tokenReport.workers || []).slice(0, 5),
      totals: tokenReport.totals,
    },
    projects: projectStrips,
    projectCatalog,
    messages: {
      recent: messages.slice(-8).reverse().map((m) => ({
        id: m.id,
        from: m.from,
        to: m.to,
        createdAt: m.createdAt,
        read: m.read,
        preview: compactText(m.content, 160),
      })),
    },
    compactions: {
      main: compactions.filter((c) => c.targetType === "main").length,
      worker: compactions.filter((c) => c.targetType === "worker").length,
      recent: compactions.slice(-5).map(compactCompactionRecord),
    },
    risks,
    sources: reportCtx.sources,
  });
}

function compactCompactionRecord(r) {
  return {
    id: r.id,
    targetType: r.targetType || "worker",
    worker: r.worker?.id || r.worker || null,
    createdAt: r.createdAt || r.time || null,
    pi: r.pi ? { summaryChars: r.pi.summaryChars || r.pi.summary?.length || 0, estimatedTokens: r.pi.estimatedTokens || 0 } : null,
    codex: r.codex ? { summaryChars: r.codex.summaryChars || r.codex.summary?.length || 0, estimatedTokens: r.codex.estimatedTokens || 0, error: r.codex.error || null } : null,
  };
}

function hydrateCompactionSide(workersDir, side) {
  if (!side) return null;
  const summary = side.summary || readWorkersRelativeText(workersDir, side.summaryFile);
  return {
    summary: summary || null,
    summaryFile: side.summaryFile || null,
    summaryChars: side.summaryChars || summary.length || 0,
    estimatedTokens: side.estimatedTokens || 0,
  };
}

function computeHealth({ jobStats, compactions, jobsAll }) {
  const stale = jobStats.stale || 0;
  const orphan = jobStats["orphan-running"] || 0;
  const failed = jobStats.failed || 0;
  const codexMainErrors = (compactions || []).filter(
    (c) => c.targetType === "main" && c.codex?.error,
  ).length;

  let level = "healthy";
  const signals = [];
  if (stale > 0) {
    level = "warning";
    signals.push(`${stale} 个 stale job`);
  }
  if (orphan > 0) {
    level = "error";
    signals.push(`${orphan} 个 orphan-running job（进程丢失）`);
  }
  if (failed > 5) {
    if (level === "healthy") level = "warning";
    signals.push(`今日失败 ${failed} 个`);
  }
  if (codexMainErrors > 0) {
    if (level === "healthy") level = "warning";
    signals.push(`Codex 主 agent 压缩失败 ${codexMainErrors} 次（仅评估，不影响 Pi）`);
  }
  return {
    level,
    label: level === "healthy" ? "健康" : level === "warning" ? "注意" : "异常",
    signals,
  };
}

async function handleWorkers(workersDir, res) {
  const [jobsAll, tokenReport, messages] = await Promise.all([
    Promise.resolve(listJobs(workersDir, { limit: 1000 })),
    Promise.resolve(buildFactoryTokenReport({ workersDir, date: localDateString(new Date()) })),
    Promise.resolve(listMessages(workersDir, { worker: "主agent", limit: 200 })),
  ]);
  const workers = buildWorkersView(workersDir, jobsAll, tokenReport, messages);
  return jsonResponse(res, 200, {
    generatedAt: new Date().toISOString(),
    workers,
  });
}

async function handleWorkerDetail(workersDir, res, name, url = null) {
  if (!name) return badRequest(res, "worker name required");
  const registry = getWorkerRegistry(workersDir);
  const regInfo = registry.get(name) || {};
  const jobs = listJobs(workersDir, { worker: name, limit: 200 }).sort((a, b) =>
    String(b.createdAt).localeCompare(String(a.createdAt)),
  );
  const talkRequests = listWebTalkRequests(workersDir, { worker: name, limit: 50 }).reverse();
  const inbox = listMessages(workersDir, { worker: name, limit: 50, includeSent: true });
  const unreadIncomingMessages = listMessages(workersDir, { worker: name, unreadOnly: true, limit: 100000 })
    .filter((m) => m.from !== name && (m.to === name || m.to === "*"));
  const includeToken = url?.searchParams?.get("includeToken") === "1";
  const tokenReport = includeToken ? buildFactoryTokenReport({ workersDir, date: localDateString(new Date()), worker: name }) : null;
  const responsibilities = listWorkerResponsibilities(workersDir, { worker: name });
  const unreadJobSummary = buildWorkerJobUnreadSummary(workersDir, jobs);
  const unreadJobState = unreadJobSummary.byWorker.get(name) || {};
  const unreadMessageIdsBeforeOpen = new Set(unreadIncomingMessages.map((m) => m.id).filter(Boolean));
  const unreadMessages = unreadIncomingMessages.length;
  const unreadJobUpdates = unreadJobState.unreadJobs || 0;
  const unreadJobEvents = unreadJobState.unreadEvents || 0;
  return jsonResponse(res, 200, {
    name,
    status: regInfo.status === "vacation" ? "vacation" : pickStatus(jobs),
    role: regInfo.role || null,
    avatar: regInfo.avatar || null,
    backend: regInfo.backend || null,
    model: regInfo.model || null,
    thinking: regInfo.thinking || null,
    profile: null,
    responsibility: summarizeResponsibilities(responsibilities, { max: 5 }),
    responsibilities,
    jobCount: jobs.length,
    jobs: jobs.map((job) => {
      const unreadJob = unreadJobSummary.byJob.get(job.id);
      return {
        ...summarizeJobForOverview(job),
        unreadBeforeOpen: Boolean(unreadJob?.unread),
        unreadEventsBeforeOpen: Number(unreadJob?.unreadEvents || 0),
        lastUnreadAt: unreadJob?.lastUnreadAt || null,
      };
    }),
    unreadJobIds: (unreadJobState.jobs || []).map((item) => item.jobId).filter(Boolean),
    unreadMessageIds: unreadIncomingMessages.map((m) => m.id).filter(Boolean),
    talkRequests: talkRequests.map((request) => ({
      id: request.id,
      status: request.status,
      worker: request.worker,
      from: request.from || null,
      source: request.source || null,
      message: request.message || "",
      mode: request.mode || "auto",
      deliveryMode: request.deliveryMode || request.resolvedMode || null,
      placement: request.placement || null,
      jobId: request.jobId || null,
      createdAt: request.createdAt,
      updatedAt: request.editedAt || request.acceptedAt || request.cancelledAt || request.failedAt || request.claimedAt || request.createdAt,
      claimedAt: request.claimedAt || null,
      acceptedAt: request.acceptedAt || null,
      failedAt: request.failedAt || null,
      cancelledAt: request.cancelledAt || null,
      error: request.error || null,
      cancelReason: request.cancelReason || null,
    })),
    unreadMessages,
    unreadJobUpdates,
    unreadJobEvents,
    unreadCount: unreadMessages + unreadJobUpdates,
    lastUnreadAt: unreadJobState.lastUnreadAt || null,
    inbox: inbox.map((m) => ({
      id: m.id,
      from: m.from,
      to: m.to,
      direction: m.to === name ? "in" : "out",
      createdAt: m.createdAt,
      read: m.read,
      unreadBeforeOpen: unreadMessageIdsBeforeOpen.has(m.id),
      content: m.content,
    })),
    tokenToday: tokenReport?.workers[0]?.reported || null,
  });
}

async function handleResponsibilities(workersDir, res, url) {
  const worker = url.searchParams.get("worker") || "";
  const includeInactive = url.searchParams.get("includeInactive") === "1" || url.searchParams.get("includeInactive") === "true";
  const responsibilities = listWorkerResponsibilities(workersDir, {
    worker,
    includeInactive,
  });
  return jsonResponse(res, 200, {
    generatedAt: new Date().toISOString(),
    worker,
    responsibilities,
  });
}

async function handleJobs(workersDir, res, url) {
  const status = url.searchParams.get("status") || null;
  const worker = url.searchParams.get("worker") || null;
  const project = url.searchParams.get("project") || null;
  const search = (url.searchParams.get("search") || "").trim().toLowerCase();
  const dateParam = url.searchParams.get("date") || null;
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 200));
  let jobs = listJobs(workersDir, { status: status || undefined, worker: worker || undefined, limit: 100000 });
  if (project) jobs = jobs.filter((j) => (j.project || "") === project);
  if (dateParam) jobs = jobs.filter((j) => localDateString(j.createdAt) === dateParam);
  if (search) {
    jobs = jobs.filter(
      (j) =>
        String(j.task || "").toLowerCase().includes(search) ||
        String(j.summary || "").toLowerCase().includes(search) ||
        String(j.id || "").toLowerCase().includes(search) ||
        String(j.worker || "").toLowerCase().includes(search),
    );
  }
  jobs = jobs.slice(-limit).reverse();
  return jsonResponse(res, 200, {
    generatedAt: new Date().toISOString(),
    total: jobs.length,
    jobs: jobs.map(summarizeJobForOverview),
  });
}

function jobDetailEventDisplayText(event) {
  if (!event) return "";
  if (event.type === "text" || event.type === "thinking") return event.text || "";
  if (["tool", "tool_start", "tool_output", "tool_end", "done", "codex_thread", "claude_session", "kimi_session"].includes(event.type)) {
    return formatJobEvent(event);
  }
  return event.text || event.message || formatJobEvent(event);
}

async function handleJobDetail(workersDir, res, id, url = null) {
  if (!id) return badRequest(res, "job id required");
  const jobFile = join(workersDir, "jobs", `${id}.json`);
  if (!existsSync(jobFile)) return notFound(res, `job ${id} not found`);
  const job = readJob(jobFile);
  const rawEvents = tailJobEvents(job, 500);
  const events = compactJobTimelineEvents(rawEvents).slice(-100);
  const markRead = url?.searchParams?.get("markRead") !== "0";
  const readMarker = markRead ? markWebJobRead(workersDir, job, { readBy: "web" }) : null;
  const latestReply = latestReplyFromEvents(rawEvents);
  const fullReply = detailText(job.fullOutput || latestReply || job.summary || "");
  return jsonResponse(res, 200, {
    id: job.id,
    status: job.status,
    kind: job.kind,
    worker: job.worker,
    project: job.project || "",
    displayChannel: job.displayChannel || "",
    source: job.source || "",
    assignedBy: job.assignedBy || "",
    returnTo: job.returnTo || "",
    task: job.task,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    elapsedSeconds: job.elapsedSeconds,
    model: job.model,
    summary: job.summary || null,
    fullReply: fullReply.text || null,
    fullReplyChars: fullReply.chars,
    fullReplyTruncated: fullReply.truncated,
    fullReplyLimit: fullReply.limit,
    error: job.error || null,
    read: readMarker
      ? {
          marked: true,
          readAt: readMarker.readAt,
          eventOffset: readMarker.eventOffset,
        }
      : { marked: false },
    events: events.map((e) => ({
      time: e.time,
      type: e.type,
      name: e.name || null,
      text: jobDetailEventDisplayText(e) || null,
      message: e.message || null,
      isError: Boolean(e.isError),
    })),
    latestReply,
  });
}

async function handleReportContext(workersDir, res, url) {
  const date = url.searchParams.get("date") || localDateString(new Date());
  const context = buildFactoryReportContext({ workersDir, date });
  const format = (url.searchParams.get("format") || "json").toLowerCase();
  if (format === "markdown" || format === "md") {
    const md = formatFactoryReportContext(context);
    res.writeHead(200, { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store" });
    res.end(md);
    return;
  }
  return jsonResponse(res, 200, context);
}

async function handleTokens(workersDir, res, url) {
  const date = url.searchParams.get("date") || localDateString(new Date());
  const worker = url.searchParams.get("worker") || null;
  const format = (url.searchParams.get("format") || "json").toLowerCase();
  const report = buildFactoryTokenReport({ workersDir, date, worker });
  if (format === "markdown" || format === "md") {
    const md = formatFactoryTokenReport(report);
    res.writeHead(200, { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store" });
    res.end(md);
    return;
  }
  return jsonResponse(res, 200, report);
}

async function handleTokensTrend(workersDir, res, url) {
  const days = Math.min(60, Math.max(1, Number(url.searchParams.get("days")) || 7));
  return jsonResponse(res, 200, buildFactoryTokenTrend({ workersDir, days }));
}

async function handleCompactions(workersDir, res, url) {
  const target = url.searchParams.get("target"); // main | worker | all
  const worker = url.searchParams.get("worker") || null;
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50));
  const records = readFactoryCompactionShadowRecords(workersDir, { limit, worker, targetType: target && target !== "all" ? target : undefined });
  return jsonResponse(res, 200, {
    generatedAt: new Date().toISOString(),
    target: target || "all",
    total: records.length,
    records: records.map((r) => ({
      id: r.id,
      targetType: r.targetType || "worker",
      worker: r.worker?.id || r.worker || null,
      createdAt: r.createdAt || r.time || null,
      pi: hydrateCompactionSide(workersDir, r.pi),
      codex: r.codex
        ? {
            ...hydrateCompactionSide(workersDir, r.codex),
            estimatedTokens: r.codex.estimatedTokens || 0,
            error: r.codex.error || null,
            elapsedMs: r.codex.elapsedMs || r.codex.latencyMs || null,
          }
        : null,
    })),
    note: "Codex shadow 压缩只用于评估，不会替换 Pi 真实压缩结果。",
  });
}

async function handleQualityMetrics(workersDir, res, url) {
  const rawDate = url.searchParams.get("date");
  const date = rawDate && rawDate.trim() ? rawDate.trim() : localDateString(new Date());
  const worker = url.searchParams.get("worker") || undefined;
  const rawLimit = (url.searchParams.get("limit") || "").trim().toLowerCase();
  const limit = rawLimit === "all"
    ? "all"
    : Math.min(5000, Math.max(1, Number(rawLimit) || (date === "all" ? 5000 : 120)));
  const cacheKey = JSON.stringify({ workersDir, date, worker: worker || "", limit });
  const bypassCache = url.searchParams.get("refresh") === "1" || url.searchParams.get("noCache") === "1";
  const cached = qualityMetricsCache.get(cacheKey);
  if (!bypassCache && cached && cached.expiresAt > Date.now()) {
    return jsonResponse(res, 200, {
      ...cached.report,
      cache: { hit: true, cachedAt: cached.cachedAt, ttlMs: QUALITY_CACHE_TTL_MS },
    });
  }
  const report = buildFactoryQualityReport({
    workersDir,
    date,
    worker,
    limit,
  });
  qualityMetricsCache.set(cacheKey, {
    report,
    cachedAt: new Date().toISOString(),
    expiresAt: Date.now() + QUALITY_CACHE_TTL_MS,
  });
  if (qualityMetricsCache.size > 20) {
    const now = Date.now();
    for (const [key, value] of qualityMetricsCache) {
      if (value.expiresAt <= now || qualityMetricsCache.size > 20) qualityMetricsCache.delete(key);
    }
  }
  return jsonResponse(res, 200, {
    ...report,
    cache: { hit: false, ttlMs: QUALITY_CACHE_TTL_MS },
  });
}

async function handleNotificationSettings(workersDir, res) {
  return jsonResponse(res, 200, {
    generatedAt: new Date().toISOString(),
    settings: readNotificationSettings(workersDir),
  });
}

async function handleNotificationSettingsMutation(workersDir, res, body) {
  const settings = writeNotificationSettings(workersDir, body?.settings || body || {});
  return jsonResponse(res, 200, {
    ok: true,
    generatedAt: new Date().toISOString(),
    settings,
  });
}

async function handleNotifications(workersDir, res, url) {
  const since = url.searchParams.get("since") || "";
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50));
  const settings = readNotificationSettings(workersDir);
  const jobs = listJobs(workersDir, { limit: 100000 });
  return jsonResponse(res, 200, {
    generatedAt: new Date().toISOString(),
    settings,
    notifications: buildJobNotifications(jobs, settings, { since, limit }),
  });
}

async function handlePermissions(workersDir, res) {
  const state = readPermissions(workersDir);
  const events = safeReadJsonl(permissionEventsFile(workersDir));
  return jsonResponse(res, 200, {
    generatedAt: new Date().toISOString(),
    version: state.version,
    grants: state.grants,
    events: events.slice(-20).reverse(),
    matrix: buildPermissionMatrix(state.grants),
  });
}

function buildPermissionMatrix(grants) {
  // subject → { action: [targets] }
  const matrix = new Map();
  for (const g of grants || []) {
    if (g.revokedAt) continue;
    if (!matrix.has(g.subject)) matrix.set(g.subject, {});
    const m = matrix.get(g.subject);
    for (const action of g.actions || []) {
      m[action] = m[action] || [];
      for (const t of g.targets || []) {
        if (!m[action].includes(t)) m[action].push(t);
      }
    }
  }
  return Object.fromEntries(matrix);
}

async function handleMessages(workersDir, res, url) {
  const worker = url.searchParams.get("worker") || null;
  const unread = url.searchParams.get("unreadOnly") === "1";
  if (!worker) return badRequest(res, "worker query param required");
  const messages = listMessages(workersDir, { worker, unreadOnly: unread, limit: 100 });
  return jsonResponse(res, 200, {
    generatedAt: new Date().toISOString(),
    worker,
    total: messages.length,
    unread: messages.filter((m) => !m.read).length,
    messages: messages.map((m) => ({
      id: m.id,
      from: m.from,
      to: m.to,
      createdAt: m.createdAt,
      read: m.read,
      content: m.content,
    })),
  });
}

async function handleMessageMutation(workersDir, res, pathname, body) {
  const match = pathname.match(/^\/api\/messages\/([^/]+)\/read$/);
  if (!match) return notFound(res, "路径格式错误");
  const messageId = decodeURIComponent(match[1]);
  const worker = String(body?.worker || "").trim();
  if (!messageId) return badRequest(res, "message id required");
  if (!worker) return badRequest(res, "worker required");

  const visible = listMessages(workersDir, { worker, includeSent: true, limit: 100000 })
    .find((message) => message.id === messageId);
  if (!visible) return notFound(res, `message ${messageId} not found for ${worker}`);
  if (visible.from === worker && visible.to !== worker && visible.to !== "*") {
    return jsonResponse(res, 200, { ok: true, skipped: true, reason: "outgoing message" });
  }

  const read = markMessageRead(workersDir, { worker, messageId });
  return jsonResponse(res, 200, { ok: true, read });
}

async function handleWorkerMessagesRead(workersDir, res, pathname) {
  const match = pathname.match(/^\/api\/workers\/([^/]+)\/messages\/read$/);
  if (!match) return notFound(res, "路径格式错误");
  const worker = decodeURIComponent(match[1]);
  if (!worker) return badRequest(res, "worker required");
  const result = markWorkerMessagesRead(workersDir, { worker });
  return jsonResponse(res, 200, {
    ok: true,
    worker,
    count: result.count,
    reads: result.reads,
  });
}

async function handleWorkerRead(workersDir, res, pathname, body) {
  const match = pathname.match(/^\/api\/workers\/([^/]+)\/read$/);
  if (!match) return notFound(res, "路径格式错误");
  const worker = decodeURIComponent(match[1]);
  if (!worker) return badRequest(res, "worker required");
  const readBy = String(body?.from || "web").trim() || "web";
  const messages = markWorkerMessagesRead(workersDir, { worker });
  const jobs = listJobs(workersDir, { worker, limit: 100000 });
  const jobReads = markWorkerJobsRead(workersDir, jobs, { readBy });
  return jsonResponse(res, 200, {
    ok: true,
    worker,
    messages,
    jobs: jobReads,
    count: messages.count + jobReads.count,
  });
}

async function handleProjects(workersDir, res) {
  const projects = buildProjectStrips(workersDir);
  const catalog = listStoredProjects(workersDir, { includeArchived: false });
  // 为每个项目附加相关 jobs 数量（按 project 字符串匹配 id/name/aliases）
  const allJobs = listJobs(workersDir, { limit: 10000 });
  const enriched = catalog.map((p) => {
    const matchNames = new Set([p.id, p.name, ...(p.aliases || [])].filter(Boolean).map((s) => String(s).toLowerCase()));
    const relatedJobs = allJobs.filter((j) => j.project && matchNames.has(String(j.project).toLowerCase()));
    const lastActivity = relatedJobs.length
      ? relatedJobs.reduce((latest, j) => {
          const t = j.updatedAt || j.createdAt;
          return t && String(t).localeCompare(String(latest)) > 0 ? t : latest;
        }, relatedJobs[0].updatedAt || relatedJobs[0].createdAt)
      : p.updatedAt || null;
    return { ...p, relatedJobCount: relatedJobs.length, lastActivity };
  });
  return jsonResponse(res, 200, {
    generatedAt: new Date().toISOString(),
    projects,
    catalogTotal: catalog.length,
    catalog: enriched,
    note: "projects 为从 job.project 派生的活动条；catalog 为 projects.jsonl 中的一等 Project 实体，供后续项目视角可视化使用。",
  });
}

// ---------------------------------------------------------------------------
// Talk · Web 版 /talk 员工名
// ---------------------------------------------------------------------------
// 设计：
// - Web server 是独立进程，不能直接调用 Pi 主进程内的 startTalkMessage。
// - 因此这里不再直接 createJob，避免制造永远没人执行的 queued 悬空 job。
// - 这里只写 web-talk intent；Pi 主进程 reload 后会轮询并调用正常 /talk 背后的
//   startTalkMessage(worker, message)，从而复用同一套空闲/忙碌排队/事件/记忆机制。
async function handleTalkMessage(workersDir, res, pathname, body) {
  const m = pathname.match(/^\/api\/talk\/(.+)$/);
  if (!m) return notFound(res, "路径格式错误");
  const worker = decodeURIComponent(m[1]);
  if (!worker) return badRequest(res, "worker name required");
  // 验证员工存在：
  // - Pi 后端员工通常有 `.pi/workers/sessions/<name>.jsonl`
  // - Codex 后端员工的真实 session 在 `~/.codex/sessions`，本目录可能没有同名 session 文件；
  //   这类员工必须从主 session 里的 ox-worker-* registry 恢复。
  const sessionExists = existsSync(join(workersDir, "sessions", `${worker}.jsonl`));
  const registry = getWorkerRegistry(workersDir);
  const regInfo = registry.get(worker);
  if (!sessionExists && !regInfo) {
    return badRequest(res, `员工 ${worker} 不存在（既不在员工 registry，也没有 sessions/ 本地 session）。完整路径检查后重试。`);
  }
  if (regInfo?.status === "fired") {
    return badRequest(res, `员工 ${worker} 已离职，不能对话。`);
  }
  const message = String(body?.message ?? "").trim();
  if (!message) return badRequest(res, "message 不能为空");
  if (message.length > 16000) return badRequest(res, "message 过长 (>16000)");
  let mode = "auto";
  try {
    mode = normalizeWebTalkMode(body?.mode || body?.deliveryMode || "auto");
  } catch (err) {
    return badRequest(res, err?.message || String(err));
  }

  try {
    const request = createWebTalkRequest(workersDir, {
      worker,
      message,
      from: String(body?.from || "web").trim() || "web",
      mode,
    });
    return jsonResponse(res, 202, {
      ok: true,
      request: {
        id: request.id,
        status: request.status,
        worker: request.worker,
        message: request.message,
        mode: request.mode,
        createdAt: request.createdAt,
      },
      note: "Web talk 请求已提交，等待 Pi 主进程接管并走正常 /talk 调度。mode=auto 表示空闲时 message、忙碌时 queue；mode=queue 强制排队；mode=steer 表示优先插队/可用时注入 Codex active turn。若刚更新代码，需要 reload Pi 后才会自动接管。",
    });
  } catch (err) {
    return errorResponse(res, 500, "创建 web talk 请求失败", String(err?.message || err));
  }
}

// ---------------------------------------------------------------------------
// Worker Task Requests · Web 版员工派活 intent
// ---------------------------------------------------------------------------
function factoryTaskActor(body) {
  return String(body?.actor || body?.from || "用户").trim() || "用户";
}

function ensureFactoryTaskAssignee(workersDir, assignee, actor) {
  const worker = String(assignee || "").trim();
  if (!worker) return;
  const sessionExists = existsSync(join(workersDir, "sessions", `${worker}.jsonl`));
  const registry = getWorkerRegistry(workersDir);
  const regInfo = registry.get(worker);
  if (!sessionExists && !regInfo) throw new Error(`员工 ${worker} 不存在`);
  if (regInfo?.status === "fired") throw new Error(`员工 ${worker} 已离职，不能指派任务`);
  if (!hasPermission(workersDir, { subject: actor, action: "work:assign", target: worker })) {
    const error = new Error(`${actor} 没有权限对 ${worker} 执行 work:assign`);
    error.statusCode = 403;
    throw error;
  }
}

export function handleFactoryTaskMutationError(res, error) {
  if (error instanceof FactoryTaskConflictError || error?.code === "FACTORY_TASK_REVISION_CONFLICT") {
    return errorResponse(res, 409, "任务已被其他人更新", error.message);
  }
  const status = Number(error?.statusCode) || 400;
  return errorResponse(res, status, "任务操作失败", error?.message || String(error));
}

function factoryTaskPath(pathname) {
  const prefix = "/api/factory-tasks";
  const rest = pathname.slice(prefix.length).replace(/^\/+/, "");
  if (!rest) return { id: "", action: "" };
  const parts = rest.split("/").map((part) => decodeURIComponent(part));
  return { id: parts[0] || "", action: parts[1] || "" };
}

function splitQueryValues(url, key) {
  return url.searchParams.getAll(key)
    .flatMap((value) => String(value || "").split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}

export async function handleFactoryTaskMutation(workersDir, res, pathname, method, body = {}) {
  const { id, action } = factoryTaskPath(pathname);
  const actor = factoryTaskActor(body);

  if (method === "POST" && !id) {
    if (body.runNow === true && !String(body.assignee || "").trim()) {
      return badRequest(res, "创建后立即执行需要先指定负责人");
    }
    ensureFactoryTaskAssignee(workersDir, body.assignee, actor);
    let task = createFactoryTask(workersDir, { ...body, creator: actor });
    let request = null;
    if (body.runNow === true) {
      const dispatched = dispatchFactoryTask(workersDir, task.id, {
        actor,
        from: actor,
        cwd: body.cwd,
        mode: body.mode,
        force: true,
      });
      task = dispatched.task;
      request = dispatched.request;
    }
    return jsonResponse(res, body.runNow === true ? 202 : 201, {
      ok: true,
      task,
      request,
      note: request
        ? "已创建看板任务和派活 intent；Pi 主进程会沿正常员工 job 链路执行。"
        : "已创建全工厂共享看板任务。",
    });
  }

  if (!id) return badRequest(res, "task id required");
  const current = getFactoryTask(workersDir, id);
  if (!current) return notFound(res, `factory task not found: ${id}`);

  if (method === "PATCH" && !action) {
    const nextAssignee = Object.hasOwn(body, "assignee") ? body.assignee : current.assignee;
    if (Object.hasOwn(body, "assignee") || Object.hasOwn(body, "triggerAt")) {
      ensureFactoryTaskAssignee(workersDir, nextAssignee, actor);
    }
    const task = updateFactoryTask(workersDir, id, { ...body, updatedBy: actor });
    return jsonResponse(res, 200, { ok: true, task });
  }

  if (method === "POST" && action === "split") {
    for (const child of body.children || []) ensureFactoryTaskAssignee(workersDir, child?.assignee, actor);
    const children = splitFactoryTask(workersDir, id, {
      children: body.children,
      actor,
      expectedRevision: body.expectedRevision,
    });
    return jsonResponse(res, 201, { ok: true, parentTaskId: id, children });
  }

  if (method === "POST" && (action === "archive" || action === "restore")) {
    const task = action === "restore"
      ? restoreFactoryTask(workersDir, id, { actor, expectedRevision: body.expectedRevision })
      : archiveFactoryTask(workersDir, id, { actor, expectedRevision: body.expectedRevision });
    return jsonResponse(res, 200, { ok: true, task });
  }

  if (method === "POST" && action === "run") {
    ensureFactoryTaskAssignee(workersDir, current.assignee, actor);
    const dispatched = dispatchFactoryTask(workersDir, id, {
      actor,
      from: actor,
      cwd: body.cwd,
      mode: body.mode || current.mode,
      expectedRevision: body.expectedRevision,
      force: true,
    });
    return jsonResponse(res, 202, {
      ok: true,
      task: dispatched.task,
      request: dispatched.request,
      note: "执行 intent 已写入；等待 Pi 主进程接管。",
    });
  }

  return badRequest(res, `不支持的任务操作: ${method} ${pathname}`);
}

export async function handleFactoryTaskStatus(workersDir, res, pathname, url) {
  const { id, action } = factoryTaskPath(pathname);
  if (action) return notFound(res, `factory task route not found: ${pathname}`);
  if (id) {
    const task = getFactoryTask(workersDir, id, { includeEvents: true });
    if (!task) return notFound(res, `factory task not found: ${id}`);
    return jsonResponse(res, 200, { generatedAt: new Date().toISOString(), task });
  }

  const includeArchived = ["1", "true", "yes"].includes(String(url.searchParams.get("includeArchived") || "").toLowerCase());
  const options = {
    project: splitQueryValues(url, "project"),
    status: splitQueryValues(url, "status"),
    assignee: splitQueryValues(url, "assignee"),
    priority: splitQueryValues(url, "priority"),
    executionState: splitQueryValues(url, "executionState"),
    labels: splitQueryValues(url, "label"),
    query: url.searchParams.get("query") || "",
    includeArchived,
    limit: Math.min(5000, Math.max(1, Number(url.searchParams.get("limit")) || 1000)),
  };
  const tasks = listFactoryTasks(workersDir, options);
  const statuses = [...new Set(tasks.map((task) => task.status).filter(Boolean))];
  const allActive = listFactoryTasks(workersDir, { includeArchived, limit: 5000 });
  return jsonResponse(res, 200, {
    generatedAt: new Date().toISOString(),
    total: tasks.length,
    tasks,
    statuses,
    facets: {
      projects: [...new Set(allActive.map((task) => task.project).filter(Boolean))].sort(),
      assignees: [...new Set(allActive.map((task) => task.assignee).filter(Boolean))].sort(),
      statuses: [...new Set(allActive.map((task) => task.status).filter(Boolean))],
      priorities: [...new Set(allActive.map((task) => task.priority).filter(Boolean))],
      executionStates: [...new Set(allActive.map((task) => task.execution?.state).filter(Boolean))],
    },
  });
}

async function handleWorkerTaskRequestCreate(workersDir, res, body) {
  const from = String(body?.from || "用户").trim() || "用户";
  const to = String(body?.to || body?.worker || "").trim();
  const task = String(body?.task || body?.message || "").trim();
  if (!to) return badRequest(res, "to/worker 不能为空");
  if (!task) return badRequest(res, "task 不能为空");
  if (task.length > 16000) return badRequest(res, "task 过长 (>16000)");

  const sessionExists = existsSync(join(workersDir, "sessions", `${to}.jsonl`));
  const registry = getWorkerRegistry(workersDir);
  const regInfo = registry.get(to);
  if (!sessionExists && !regInfo) {
    return badRequest(res, `员工 ${to} 不存在（既不在员工 registry，也没有 sessions/ 本地 session）。`);
  }
  if (regInfo?.status === "fired") {
    return badRequest(res, `员工 ${to} 已离职，不能派活。`);
  }
  if (!hasPermission(workersDir, { subject: from, action: "work:assign", target: to })) {
    return errorResponse(res, 403, `${from} 没有权限对 ${to} 执行 work:assign`);
  }

  let mode = "auto";
  try {
    mode = normalizeWorkerTaskMode(body?.mode || body?.deliveryMode || "auto");
  } catch (err) {
    return badRequest(res, err?.message || String(err));
  }

  try {
    const request = createWorkerTaskRequest(workersDir, {
      from,
      to,
      task,
      project: String(body?.project || "factory-task").trim() || "factory-task",
      cwd: body?.cwd == null ? "" : String(body.cwd).trim(),
      mode,
      source: "web",
    });
    return jsonResponse(res, 202, {
      ok: true,
      request: {
        id: request.id,
        status: request.status,
        from: request.from,
        to: request.to,
        task: request.task,
        project: request.project,
        mode: request.mode,
        createdAt: request.createdAt,
      },
      note: "员工派活请求已提交，等待 Pi 主进程检查 work:assign 权限并接管调度；目标忙碌时会按 mode 排队/steer。",
    });
  } catch (err) {
    return errorResponse(res, 500, "创建员工派活请求失败", String(err?.message || err));
  }
}

async function handleWorkerTaskRequestMutation(workersDir, res, pathname, method, body) {
  const cancelSuffix = "/cancel";
  const isCancel = method === "POST" && pathname.endsWith(cancelSuffix);
  const rawId = isCancel
    ? pathname.slice("/api/task-requests/".length, -cancelSuffix.length)
    : pathname.slice("/api/task-requests/".length);
  const id = decodeURIComponent(rawId || "");
  if (!id) return badRequest(res, "request id required");
  const request = getWorkerTaskRequest(workersDir, id);
  if (!request) return notFound(res, `task request not found: ${id}`);

  if (method === "PATCH" && !isCancel) {
    if (request.status === "pending") {
      try {
        const edited = editWorkerTaskRequest(workersDir, {
          requestId: id,
          task: body?.task || body?.message,
          project: body?.project,
          cwd: body?.cwd,
          mode: body?.mode || body?.deliveryMode,
          from: String(body?.from || "web").trim() || "web",
        });
        return jsonResponse(res, 200, { ok: true, request: edited });
      } catch (err) {
        return badRequest(res, err?.message || String(err));
      }
    }
    if (request.status === "accepted" && request.jobId) {
      const message = String(body?.task ?? body?.message ?? "").trim();
      if (!message) return badRequest(res, "task/message 不能为空");
      const control = createWebTalkJobControlRequest(workersDir, {
        action: "edit",
        jobId: request.jobId,
        worker: request.to,
        message,
        from: String(body?.from || "web").trim() || "web",
      });
      return jsonResponse(res, 202, {
        ok: true,
        control,
        note: "编辑请求已提交，只有仍在 Pi 主进程内存队列中的 job 可以改写。",
      });
    }
    return badRequest(res, `只能编辑 pending 或 accepted+jobId 请求，当前状态 ${request.status}`);
  }

  if (isCancel) {
    if (request.status === "pending") {
      const cancelled = cancelWorkerTaskRequest(workersDir, {
        requestId: id,
        reason: body?.reason || "用户取消员工派活请求",
        from: String(body?.from || "web").trim() || "web",
      });
      return jsonResponse(res, 200, { ok: true, request: cancelled });
    }
    if (request.status === "accepted" && request.jobId) {
      const control = createWebTalkJobControlRequest(workersDir, {
        action: "cancel",
        jobId: request.jobId,
        worker: request.to,
        reason: body?.reason || "用户取消已接入的员工派活 job",
        from: String(body?.from || "web").trim() || "web",
      });
      return jsonResponse(res, 202, {
        ok: true,
        control,
        note: "取消请求已提交，等待 Pi 主进程用当前 job controller/queue 处理。",
      });
    }
    return badRequest(res, `当前状态 ${request.status} 不能取消或找不到 jobId`);
  }

  return badRequest(res, `不支持的 task request 操作: ${method} ${pathname}`);
}

async function handleWorkerTaskRequestStatus(workersDir, res, pathname, url) {
  const prefix = "/api/task-requests/";
  if (pathname.startsWith(prefix)) {
    const id = decodeURIComponent(pathname.slice(prefix.length));
    if (!id) return badRequest(res, "request id required");
    const request = getWorkerTaskRequest(workersDir, id);
    if (!request) return notFound(res, `task request not found: ${id}`);
    return jsonResponse(res, 200, { generatedAt: new Date().toISOString(), request });
  }
  const from = url.searchParams.get("from") || undefined;
  const to = url.searchParams.get("to") || url.searchParams.get("worker") || undefined;
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50));
  const requests = listWorkerTaskRequests(workersDir, { from, to, limit }).reverse();
  return jsonResponse(res, 200, {
    generatedAt: new Date().toISOString(),
    from: from || null,
    to: to || null,
    total: requests.length,
    requests,
  });
}

async function handleTalkRequestMutation(workersDir, res, pathname, method, body) {
  const cancelSuffix = "/cancel";
  const isCancel = method === "POST" && pathname.endsWith(cancelSuffix);
  const rawId = isCancel
    ? pathname.slice("/api/talk-requests/".length, -cancelSuffix.length)
    : pathname.slice("/api/talk-requests/".length);
  const id = decodeURIComponent(rawId || "");
  if (!id) return badRequest(res, "request id required");
  const request = getWebTalkRequest(workersDir, id);
  if (!request) return notFound(res, `talk request not found: ${id}`);

  if (method === "PATCH" && !isCancel) {
    if (request.status !== "pending") return badRequest(res, `只能编辑 pending 请求，当前状态 ${request.status}`);
    try {
      const edited = editWebTalkRequest(workersDir, {
        requestId: id,
        message: body?.message,
        mode: body?.mode || body?.deliveryMode,
        from: String(body?.from || "web").trim() || "web",
      });
      return jsonResponse(res, 200, { ok: true, request: edited });
    } catch (err) {
      return badRequest(res, err?.message || String(err));
    }
  }

  if (isCancel) {
    if (request.status === "pending") {
      const cancelled = cancelWebTalkRequest(workersDir, {
        requestId: id,
        reason: body?.reason || "用户取消 web talk 请求",
        from: String(body?.from || "web").trim() || "web",
      });
      return jsonResponse(res, 200, { ok: true, request: cancelled });
    }
    if (request.status === "accepted" && request.jobId) {
      const control = createWebTalkJobControlRequest(workersDir, {
        action: "cancel",
        jobId: request.jobId,
        worker: request.worker,
        reason: body?.reason || "用户取消已接入的 web talk job",
        from: String(body?.from || "web").trim() || "web",
      });
      return jsonResponse(res, 202, {
        ok: true,
        control,
        note: "取消请求已提交，等待 Pi 主进程用当前 job controller/queue 处理。",
      });
    }
    return badRequest(res, `当前状态 ${request.status} 不能取消或找不到 jobId`);
  }

  return badRequest(res, `不支持的 talk request 操作: ${method} ${pathname}`);
}

async function handleJobMutation(workersDir, res, pathname, method, body) {
  const match = pathname.match(/^\/api\/jobs\/([^/]+)(?:\/(read|cancel))?$/);
  if (!match) return notFound(res, "路径格式错误");
  const id = decodeURIComponent(match[1]);
  const action = match[2] || (method === "PATCH" ? "edit" : "");
  const jobFile = join(workersDir, "jobs", `${id}.json`);
  if (!existsSync(jobFile)) return notFound(res, `job ${id} not found`);
  const job = readJob(jobFile);

  if (action === "read") {
    const read = markWebJobRead(workersDir, job, { readBy: String(body?.from || "web").trim() || "web" });
    return jsonResponse(res, 200, { ok: true, read });
  }

  if (action === "cancel") {
    const control = createWebTalkJobControlRequest(workersDir, {
      action: "cancel",
      jobId: job.id,
      worker: job.worker,
      reason: body?.reason || "用户通过 Web 取消 job",
      from: String(body?.from || "web").trim() || "web",
    });
    return jsonResponse(res, 202, {
      ok: true,
      control,
      note: "取消请求已提交，等待 Pi 主进程处理；运行中 job 会尝试 abort，队列中 job 会移出队列。",
    });
  }

  if (action === "edit") {
    const message = String(body?.message ?? body?.task ?? "").trim();
    if (!message) return badRequest(res, "message/task 不能为空");
    const control = createWebTalkJobControlRequest(workersDir, {
      action: "edit",
      jobId: job.id,
      worker: job.worker,
      message,
      from: String(body?.from || "web").trim() || "web",
    });
    return jsonResponse(res, 202, {
      ok: true,
      control,
      note: "编辑请求已提交，只有仍在 Pi 主进程内存队列中的 job 可以改写；运行中 job 不会被编辑。",
    });
  }

  return badRequest(res, `不支持的 job 操作: ${method} ${pathname}`);
}

async function handleTalkRequestStatus(workersDir, res, pathname, url) {
  const prefix = "/api/talk-requests/";
  if (pathname.startsWith(prefix)) {
    const id = decodeURIComponent(pathname.slice(prefix.length));
    if (!id) return badRequest(res, "request id required");
    const request = getWebTalkRequest(workersDir, id);
    if (!request) return notFound(res, `talk request not found: ${id}`);
    return jsonResponse(res, 200, { generatedAt: new Date().toISOString(), request });
  }
  const worker = url.searchParams.get("worker") || undefined;
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50));
  const requests = listWebTalkRequests(workersDir, { worker, limit }).reverse();
  return jsonResponse(res, 200, {
    generatedAt: new Date().toISOString(),
    worker: worker || null,
    total: requests.length,
    requests,
  });
}

async function handleJobControlStatus(workersDir, res, pathname, url) {
  const prefix = "/api/job-controls/";
  if (pathname.startsWith(prefix)) {
    const id = decodeURIComponent(pathname.slice(prefix.length));
    if (!id) return badRequest(res, "control id required");
    const control = getWebTalkJobControlRequest(workersDir, id);
    if (!control) return notFound(res, `job control not found: ${id}`);
    return jsonResponse(res, 200, { generatedAt: new Date().toISOString(), control });
  }
  const worker = url.searchParams.get("worker") || undefined;
  const jobId = url.searchParams.get("jobId") || undefined;
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50));
  const controls = listWebTalkJobControlRequests(workersDir, { worker, jobId, limit }).reverse();
  return jsonResponse(res, 200, {
    generatedAt: new Date().toISOString(),
    worker: worker || null,
    jobId: jobId || null,
    total: controls.length,
    controls,
  });
}

// ---------------------------------------------------------------------------
// Main Agent · Web 版秘书对话 intent + 主 session 只读 transcript
// ---------------------------------------------------------------------------
async function handleMainAgentTalkMessage(workersDir, res, body) {
  const message = String(body?.message ?? "").trim();
  if (!message) return badRequest(res, "message 不能为空");
  if (message.length > 16000) return badRequest(res, "message 过长 (>16000)");

  try {
    const request = createMainAgentTalkRequest(workersDir, {
      message,
      from: String(body?.from || "web").trim() || "web",
    });
    return jsonResponse(res, 202, {
      ok: true,
      request: {
        id: request.id,
        status: request.status,
        target: request.target,
        message: request.message,
        createdAt: request.createdAt,
      },
      note: "主 agent Web 消息已提交。Pi 主进程会在秘书空闲且未处于 /talk 员工模式时投递，避免打断控制台体验。",
    });
  } catch (err) {
    return errorResponse(res, 500, "创建主 agent talk 请求失败", String(err?.message || err));
  }
}

async function handleMainAgentTalkRequestStatus(workersDir, res, pathname, url) {
  const prefix = "/api/main-agent/talk-requests/";
  if (pathname.startsWith(prefix)) {
    const id = decodeURIComponent(pathname.slice(prefix.length));
    if (!id) return badRequest(res, "request id required");
    const request = getMainAgentTalkRequest(workersDir, id);
    if (!request) return notFound(res, `main agent talk request not found: ${id}`);
    return jsonResponse(res, 200, { generatedAt: new Date().toISOString(), request });
  }
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50));
  const requests = listMainAgentTalkRequests(workersDir, { limit }).reverse();
  return jsonResponse(res, 200, {
    generatedAt: new Date().toISOString(),
    total: requests.length,
    requests,
  });
}

function extractMessageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    if (content && typeof content === "object") {
      if (typeof content.text === "string") return content.text;
      if (typeof content.content === "string") return content.content;
    }
    return "";
  }
  return content
    .map((part) => {
      if (!part) return "";
      if (typeof part === "string") return part;
      if (typeof part.text === "string") return part.text;
      if (part.type === "text" && typeof part.content === "string") return part.content;
      if (part.type === "toolCall") return `[tool_call ${part.name || part.toolName || ""}]`;
      if (part.type === "toolResult") return `[tool_result ${part.toolName || part.name || ""}]`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function compactTranscriptText(text, maxChars) {
  const s = String(text || "");
  if (s.length <= maxChars) return { text: s, truncated: false };
  return { text: s.slice(0, maxChars), truncated: true };
}

async function handleMainAgentTranscript(workersDir, res, url) {
  const sessionFile = findMainSessionFile(workersDir);
  if (!sessionFile) return notFound(res, "未找到主 agent session 文件");
  const limit = Math.min(300, Math.max(1, Number(url.searchParams.get("limit")) || 80));
  const maxChars = Math.min(50_000, Math.max(500, Number(url.searchParams.get("maxChars")) || 8000));
  const includeCustom = url.searchParams.get("includeCustom") === "1";
  const messages = [];
  const lines = readFileSync(sessionFile, "utf8").split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type === "message") {
      const role = entry.message?.role || entry.role || null;
      if (!["user", "assistant"].includes(role)) continue;
      const extracted = compactTranscriptText(extractMessageText(entry.message?.content ?? entry.content), maxChars);
      if (!extracted.text.trim()) continue;
      messages.push({
        id: entry.id || null,
        parentId: entry.parentId || null,
        type: "message",
        role,
        timestamp: entry.timestamp || null,
        text: extracted.text,
        truncated: extracted.truncated,
      });
    } else if (includeCustom && entry.type === "custom" && entry.content) {
      const extracted = compactTranscriptText(entry.content, maxChars);
      messages.push({
        id: entry.id || null,
        parentId: entry.parentId || null,
        type: "custom",
        role: "system",
        customType: entry.customType || null,
        timestamp: entry.timestamp || null,
        text: extracted.text,
        truncated: extracted.truncated,
      });
    }
  }
  return jsonResponse(res, 200, {
    generatedAt: new Date().toISOString(),
    sessionFile,
    total: messages.length,
    messages: messages.slice(-limit),
    note: "只读主 agent transcript；默认只返回 user/assistant 消息，避免工具和 custom message 噪声污染页面。",
  });
}

// ---------------------------------------------------------------------------
// Quality · 每 job 一行派生指标，供前端做趋势/散点分析
// ---------------------------------------------------------------------------
// 后端能提供的字段：
//   worker / project / status / kind
//   time (createdAt ISO)
//   inputTokens / outputTokens / cachedInputTokens / cachedTokens (计算口径 = inputTokens + outputTokens + cachedInputTokens)
//   turns / elapsedMs (= elapsedSeconds * 1000)
//   taskChars (= len(job.task))
//   summaryChars (= len(job.summary))
//   toolCalls (从 events 数 tool_start 个数)
//   compactions (= 从同名 compactions/ 是否存在 .codex.md / .pi.md 推 count)
//   emotionScore (session jsonl 里查 emotionScore 标记，没有则为 null)
async function handleQuality(workersDir, res, url) {
  const limit = Math.min(20000, Math.max(1, Number(url.searchParams.get("limit")) || 5000));
  const worker = url.searchParams.get("worker") || null;
  const compactionsDir = join(workersDir, "compactions");
  const sessionsDir = join(workersDir, "sessions");
  const sessionEmotionCache = new Map(); // worker -> [{ts, score}]
  if (existsSync(sessionsDir)) {
    for (const name of readdirSync(sessionsDir)) {
      if (!name.endsWith(".jsonl")) continue;
      const w = name.slice(0, -".jsonl".length);
      try {
        const lines = readFileSync(join(sessionsDir, name), "utf8").split("\n");
        const points = [];
        for (const line of lines) {
          if (!line.trim()) continue;
          let entry;
          try { entry = JSON.parse(line); } catch { continue; }
          const usage = entry?.message?.usage || entry?.usage;
          const emo = usage?.emotionScore ?? entry?.message?.emotionScore ?? entry?.emotionScore;
          const t = entry?.timestamp || entry?.time || entry?.createdAt;
          if (typeof emo === "number" && t) {
            points.push({ t: new Date(t).getTime() || 0, score: emo });
          }
        }
        if (points.length) sessionEmotionCache.set(w, points);
      } catch { /* ignore */ }
    }
  }

  const jobs = listJobs(workersDir, { limit });
  const rows = [];
  for (const job of jobs) {
    if (worker && job.worker !== worker) continue;
    // tool_calls 计数从 events 读取
    let toolCalls = 0;
    let thinkingBlocks = 0;
    try {
      const events = tailJobEvents(job, 500);
      for (const e of events) {
        if (e.type === "tool_start") toolCalls += 1;
        if (e.type === "thinking") thinkingBlocks += 1;
      }
    } catch { /* 读不到则不填 */ }
    // compaction hits (从 compactions/<jobId>.{codex,pi}.md 是否存在推 count)
    let compactions = 0;
    if (existsSync(compactionsDir)) {
      for (const ext of [".codex.md", ".pi.md"]) {
        if (existsSync(join(compactionsDir, `${job.id}${ext}`))) compactions += 1;
      }
    }
    const input = Number(job.inputTokens || 0);
    const output = Number(job.outputTokens || 0);
    const cache = Number(job.cachedInputTokens || 0);
    const elapsedMs = Number(job.elapsedSeconds || 0) * 1000;
    const task = String(job.task || "");
    const summary = String(job.summary || "");
    rows.push({
      jobId: job.id,
      worker: job.worker || "",
      project: job.project || "",
      kind: job.kind || "",
      status: job.status || "",
      time: job.createdAt || "",
      inputTokens: input,
      outputTokens: output,
      cachedTokens: cache,
      totalTokens: input + output + cache,
      turns: Number(job.turns || 0),
      elapsedMs,
      taskChars: task.length,
      summaryChars: summary.length,
      toolCalls,
      compactions,
      thinkingBlocks,
    });
  }

  // 按员工聚合：每个员工的 job 数 + 总 token 数 + 平均耗时 + 工具总调用 + 压缩总次数
  const byWorkerMap = new Map();
  for (const r of rows) {
    if (!r.worker) continue;
    const w = byWorkerMap.get(r.worker) || { worker: r.worker, jobs: 0, totalInputTokens: 0, totalOutputTokens: 0, totalToolCalls: 0, totalElapsedMs: 0, totalTasks: 0, totalCompactions: 0 };
    w.jobs += 1;
    w.totalInputTokens += r.inputTokens;
    w.totalOutputTokens += r.outputTokens;
    w.totalToolCalls += r.toolCalls;
    w.totalElapsedMs += r.elapsedMs;
    w.totalCompactions += r.compactions;
    byWorkerMap.set(r.worker, w);
  }
  const byWorker = [...byWorkerMap.values()].sort((a, b) => b.jobs - a.jobs);

  return jsonResponse(res, 200, {
    generatedAt: new Date().toISOString(),
    total: rows.length,
    rows,
    byWorker,
    emotionAvailable: sessionEmotionCache.size > 0,
    emotionPoints: Object.fromEntries(sessionEmotionCache),
    note: "sessionContextTokens / emotionScore / inputChars / outputChars 这些字段在当前会话 jsonl 未产生；后端有会随时补上。",
  });
}

async function handleProjectDetail(workersDir, res, id) {
  const project = resolveStoredProject(workersDir, id);
  if (!project) {
    return jsonResponse(res, 404, { ok: false, detail: `项目不存在: ${id}` });
  }

  // 相关 jobs（按 id/name/aliases 匹配）
  const allJobs = listJobs(workersDir, { limit: 10000 });
  const matchNames = new Set([project.id, project.name, ...(project.aliases || [])].filter(Boolean).map((s) => String(s).toLowerCase()));
  const relatedJobs = allJobs.filter((j) => j.project && matchNames.has(String(j.project).toLowerCase()));

  // 按状态分组
  const byStatus = {};
  for (const j of relatedJobs) {
    byStatus[j.status] = (byStatus[j.status] || 0) + 1;
  }

  // 最近进展（按时间倒序）
  const progress = (project.progress || []).slice().sort((a, b) =>
    String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))
  );

  // 相关 responsibilities
  const allResps = listWorkerResponsibilities(workersDir, { includeInactive: false });
  const relatedResps = allResps.filter((r) => {
    if (!r.project) return false;
    return matchNames.has(String(r.project).toLowerCase());
  });

  return jsonResponse(res, 200, {
    generatedAt: new Date().toISOString(),
    project,
    relatedJobs: {
      total: relatedJobs.length,
      byStatus,
      recent: relatedJobs
        .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
        .slice(0, 20)
        .map((j) => ({
          id: j.id,
          status: j.status,
          worker: j.worker,
          task: j.task ? String(j.task).slice(0, 200) : null,
          summary: j.summary ? String(j.summary).slice(0, 200) : null,
          createdAt: j.createdAt,
          updatedAt: j.updatedAt,
          elapsedSeconds: j.elapsedSeconds,
        })),
    },
    progress,
    relatedResponsibilities: relatedResps.map((r) => ({
      worker: r.worker,
      scope: r.scope,
      relation: r.relation,
      status: r.status,
      note: r.note,
    })),
  });
}

async function handleProjectDoc(workersDir, res, url) {
  const projectId = url.searchParams.get("project") || url.searchParams.get("id") || "";
  const ref = url.searchParams.get("ref") || "";
  if (!projectId) return badRequest(res, "缺少 project 参数");
  const project = resolveStoredProject(workersDir, projectId);
  if (!project) return jsonResponse(res, 404, { ok: false, detail: `项目不存在: ${projectId}` });

  const resolved = resolveProjectMarkdownDocRef({ project, ref });
  if (!resolved.ok) {
    return errorResponse(res, resolved.status || 400, resolved.message || "无法读取项目文档", resolved.ref || null);
  }

  const maxChars = 500_000;
  const content = readFileSync(resolved.filePath, "utf8");
  const truncated = content.length > maxChars;
  return jsonResponse(res, 200, {
    generatedAt: new Date().toISOString(),
    project: {
      id: project.id,
      name: project.name,
    },
    ref: resolved.ref,
    path: resolved.filePath,
    size: resolved.size,
    truncated,
    content: truncated ? content.slice(0, maxChars) : content,
  });
}

// ---------------------------------------------------------------------------
// Outsource run 序列化（可测试的纯函数）
// ---------------------------------------------------------------------------

/**
 * 把 outsource run 对象序列化为 API 响应字段。
 * 纯函数：只依赖输入 run 对象，不读文件、不碰网络。
 * 可靠时间字段：finishedAt 走 computeReliableFinishedAt；elapsedMs 走 computeReliableElapsedMs。
 * @param {object} run - 从 getOutsourceRun / listOutsourceRuns 拿到的 run 对象
 * @param {object} [opts]
 * @param {boolean} [opts.includeFullOutput] - 是否包含 fullOutput（列表默认 false，详情默认 true）
 * @returns {object}
 */
export function serializeOutsourceRun(run, opts = {}) {
  if (!run || typeof run !== "object") return null;
  const includeFullOutput = opts.includeFullOutput !== false; // 默认 true
  const reliableFinishedAt = computeReliableFinishedAt(run);
  const reliableElapsedMs = computeReliableElapsedMs(run, { finishedAt: reliableFinishedAt });
  const taskText = String(run.task || run.summary || "");
  const serialized = {
    runId: run.id || run.runId || null,
    profile: run.profile || run.profileName || "",
    groupId: run.groupId || null,
    requestedBy: run.requestedBy || "",
    project: run.project || "",
    status: run.status || "pending",
    taskPreview: taskText.slice(0, 200),
    taskLength: Array.from(taskText).length,
    summary: run.summary || "",
    model: run.model || "",
    jobId: run.jobId || null,
    createdAt: run.createdAt || null,
    updatedAt: run.updatedAt || null,
    startedAt: run.startedAt || null,
    finishedAt: reliableFinishedAt,
    elapsedMs: reliableElapsedMs,
    error: run.error || "",
    terminal: OUTSOURCE_TERMINAL_STATUSES.has(run.status),
  };
  if (includeFullOutput) {
    serialized.fullOutput = run.fullOutput || run.fullReply || "";
  }
  return serialized;
}

// ---------------------------------------------------------------------------
// Outsource / Subagent — read-oriented routes only
// ---------------------------------------------------------------------------
async function handleOutsourceProfiles(workersDir, res) {
  const profiles = listOutsourceProfiles(workersDir) || [];
  return jsonResponse(res, 200, {
    generatedAt: new Date().toISOString(),
    total: profiles.length,
    profiles: profiles.map((p) => ({
      name: p.name,
      description: p.description || "",
      backend: p.backend || "pi",
      model: p.model || "",
      thinking: p.thinking || "",
      tools: p.tools || [],
      skills: Boolean(p.skills),
      maxTurns: Number(p.maxTurns || 0),
      defaultWait: Boolean(p.defaultWait),
      timeoutMs: Number(p.timeoutMs || 0),
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    })),
  });
}

async function handleOutsourceProfile(workersDir, res, name) {
  if (!name) return badRequest(res, "profile name required");
  const p = getOutsourceProfile(workersDir, name);
  if (!p) return jsonResponse(res, 404, { ok: false, detail: `profile ${name} not found` });
  return jsonResponse(res, 200, {
    name: p.name,
    description: p.description || "",
    backend: p.backend || "pi",
    model: p.model || "",
    thinking: p.thinking || "",
    tools: p.tools || [],
    skills: Boolean(p.skills),
    maxTurns: Number(p.maxTurns || 0),
    defaultWait: Boolean(p.defaultWait),
    timeoutMs: Number(p.timeoutMs || 0),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  });
}

async function handleOutsourceRuns(workersDir, res, url) {
  const runId = url.searchParams.get("runId") || null;
  const groupId = url.searchParams.get("groupId") || null;
  const profile = url.searchParams.get("profile") || null;
  const status = url.searchParams.get("status") || null;
  const requestedBy = url.searchParams.get("requestedBy") || null;
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 100));
  const runs = listOutsourceRuns(workersDir, { runId, groupId, profile, status, requestedBy, limit }) || [];
  return jsonResponse(res, 200, {
    generatedAt: new Date().toISOString(),
    total: runs.length,
    filters: { runId, groupId, profile, status, requestedBy, limit },
    runs: runs.map((r) => serializeOutsourceRun(r, { includeFullOutput: false })),
  });
}

async function handleOutsourceRun(workersDir, res, runId) {
  if (!runId) return badRequest(res, "runId required");
  const r = getOutsourceRun(workersDir, runId);
  if (!r) return jsonResponse(res, 404, { ok: false, detail: `run ${runId} not found` });
  const serialized = serializeOutsourceRun(r, { includeFullOutput: true });
  return jsonResponse(res, 200, {
    ...serialized,
    name: r.name || r.id,
    task: r.task || "",
    result: r.result || null,
    usage: r.usage || null,
    events: Array.isArray(r.events) ? r.events : [],
  });
}

// POST /api/outsource/runs — 从 web 侧直接启动白纸外包 agent。
// 默认后台运行并返回 run/job id；传 wait=true 时等待本次 run 完成后返回。
async function handleOutsourceRunCreate(workersDir, res, body) {
  const profileName = String(body?.profile || "").trim();
  const task = String(body?.task || "").trim();
  if (!profileName) return badRequest(res, "profile required");
  if (!task) return badRequest(res, "task required");
  if (task.length > 16000) return badRequest(res, "task 过长 (>16000)");

  const profile = getOutsourceProfile(workersDir, profileName);
  if (!profile) {
    return badRequest(res, `未找到外包 profile: ${profileName}。先用 factory_outsource_profiles 创建。`);
  }

  try {
    const shouldWait = normalizeOutsourceWait({
      wait: body?.wait === true ? true : undefined,
      background: body?.background === false ? false : true,
    }, profile);

    const { run, job, promise } = startOutsourceRunJob({
      workersDir,
      profile,
      task,
      project: String(body?.project || "outsource").trim() || "outsource",
      cwd: body?.cwd || process.cwd(),
      requestedBy: String(body?.requestedBy || "web").trim() || "web",
      groupId: body?.groupId || undefined,
      wait: shouldWait,
      background: !shouldWait,
      detached: !shouldWait,
    });

    let current = run;
    if (shouldWait) {
      await promise;
      current = getOutsourceRun(workersDir, run.id) || run;
    }

    return jsonResponse(res, 200, {
      ok: true,
      run: {
        runId: current.id,
        profile: current.profile || current.profileName,
        groupId: current.groupId || null,
        requestedBy: current.requestedBy || "",
        project: current.project || "",
        status: current.status || "pending",
        task: current.task || "",
        summary: current.summary || "",
        error: current.error || "",
        createdAt: current.createdAt,
        startedAt: current.startedAt || null,
        finishedAt: current.finishedAt || null,
      },
      job: {
        id: job.id,
        status: shouldWait ? (current.status || "done") : "running",
      },
      note: shouldWait
        ? "外包 run 已执行完成；可用 GET /api/outsource/runs/<id> 查看完整事件。"
        : "外包 run 已后台启动；可用 GET /api/outsource/runs/<id> 轮询 status 变化。",
    });
  } catch (err) {
    return errorResponse(res, 500, "启动外包 run 失败", String(err?.message || err));
  }
}

// ---------------------------------------------------------------------------
// Schedules (queue.jsonl runner/cron 流水)
// ---------------------------------------------------------------------------
async function handleSchedules(workersDir, res, url) {
  const statusFilter = url.searchParams.get("status") || null;
  const workerFilter = url.searchParams.get("worker") || null;
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 200));
  const raw = readQueueFile(workersDir);

  // 过滤 project-recorded 这类非执行状态（只是履历标记）
  const execEntries = raw.filter((e) => e.status !== "project-recorded");

  let entries = execEntries.map((e, idx) => ({
    id: e.id || `q_${idx}_${e.time || ""}`,
    status: e.status || "unknown",
    worker: e.worker || null,
    project: e.project || null,
    task: compactText(e.task || "", 200),
    taskFull: e.task || null,
    summary: compactText(e.summary || "", 200),
    elapsed: e.elapsed != null ? Number(e.elapsed) : null,
    exitCode: e.exitCode != null ? Number(e.exitCode) : null,
    time: e.time || null,
    scheduled: e.scheduled || null,
    repeat: e.repeat != null ? Number(e.repeat) : null,
    cycle: e.cycle != null ? Number(e.cycle) : null,
    key: e.key || null,
    error: e.error ? compactText(e.error, 200) : null,
  }));

  if (statusFilter) {
    entries = entries.filter((e) => e.status === statusFilter);
  }
  if (workerFilter) {
    entries = entries.filter((e) => e.worker === workerFilter);
  }

  // 按 time 倒序
  entries.sort((a, b) => String(b.time || "").localeCompare(String(a.time || "")));
  const total = entries.length;
  const shown = entries.slice(0, limit);

  // 统计
  const counts = {};
  for (const e of execEntries) {
    counts[e.status] = (counts[e.status] || 0) + 1;
  }
  const repeatCount = execEntries.filter((e) => e.repeat != null).length;

  return jsonResponse(res, 200, {
    generatedAt: new Date().toISOString(),
    total,
    shown: shown.length,
    counts,
    repeatCount,
    entries: shown,
    note: "queue.jsonl 只代表 runner/cron/factory_queue 队列流水，不代表全员工作总账。即时一次性任务走 in-process jobs（见 Jobs 页）。",
  });
}

// ---------------------------------------------------------------------------
// 静态文件 / SPA fallback
// ---------------------------------------------------------------------------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

function avatarDirForWorkers(workersDir) {
  return resolve(process.env.OX_FACTORY_AVATAR_DIR || join(workersDir, "avatars"));
}

async function handleAvatarAsset(workersDir, res, pathname) {
  let name = "";
  try {
    name = decodeURIComponent(pathname.slice("/api/avatars/".length));
  } catch {
    return notFound(res, "Invalid avatar path");
  }
  if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..") {
    return notFound(res, "Invalid avatar path");
  }
  const avatarDir = avatarDirForWorkers(workersDir);
  const filePath = resolve(avatarDir, name);
  if (!filePath.startsWith(`${avatarDir}${sep}`)) return notFound(res, "Invalid avatar path");
  if (!existsSync(filePath) || !statSync(filePath).isFile()) return notFound(res, "Avatar not found");
  return serveFile(res, filePath);
}

async function serveStatic(res, pathname) {
  if (pathname === "/") pathname = "/index.html";
  // 安全：禁止 .. 跳出
  const safe = pathname.replace(/\.\.+/g, "").replace(/^\/+/, "");
  const filePath = join(WEB_DIR, safe);
  if (!filePath.startsWith(WEB_DIR)) return notFound(res, "Invalid path");
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    // SPA fallback: 找不到静态资源时，尝试 index.html
    const fallback = join(WEB_DIR, "index.html");
    if (existsSync(fallback)) {
      return serveFile(res, fallback);
    }
    return notFound(res, "Not Found");
  }
  return serveFile(res, filePath);
}

function serveFile(res, filePath) {
  const ext = extname(filePath).toLowerCase();
  const type = MIME[ext] || "application/octet-stream";
  try {
    const buf = readFileSync(filePath);
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    res.end(buf);
  } catch (err) {
    return errorResponse(res, 500, "Failed to read file", String(err.message || err));
  }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
function envNumber(name, fallback, min, max) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

export function createFactoryTaskScheduler({
  workersDir,
  graceMs = envNumber("OX_FACTORY_TASK_SCHEDULER_GRACE_MS", 15_000, 0, 300_000),
  jitterMs = envNumber("OX_FACTORY_TASK_SCHEDULER_JITTER_MS", 15_000, 0, 300_000),
  intervalMs = envNumber("OX_FACTORY_TASK_SCHEDULER_INTERVAL_MS", 5_000, 10, 300_000),
  batchSize = envNumber("OX_FACTORY_TASK_SCHEDULER_BATCH_SIZE", 5, 1, 100),
  random = Math.random,
  dispatchDue = dispatchDueFactoryTasks,
  onResult,
  onError,
} = {}) {
  if (!workersDir) throw new Error("workersDir is required for task scheduler");
  let startupTimer = null;
  let intervalTimer = null;
  let running = false;
  let stopped = true;

  const runOnce = async () => {
    if (stopped || running) return { skipped: true };
    running = true;
    try {
      const result = await dispatchDue(workersDir, {
        actor: "web-scheduler",
        limit: batchSize,
        now: new Date(),
      });
      onResult?.(result);
      return result;
    } catch (error) {
      onError?.(error);
      return { checked: 0, dispatched: [], errors: [{ error: error?.message || String(error) }] };
    } finally {
      running = false;
    }
  };

  const start = () => {
    if (!stopped) return;
    stopped = false;
    const jitter = Math.max(0, Number(jitterMs) || 0);
    const delay = Math.max(0, Number(graceMs) || 0) + Math.floor(Math.max(0, Math.min(1, Number(random()) || 0)) * jitter);
    startupTimer = setTimeout(() => {
      startupTimer = null;
      void runOnce();
      intervalTimer = setInterval(() => void runOnce(), Math.max(10, Number(intervalMs) || 5_000));
      intervalTimer.unref?.();
    }, delay);
    startupTimer.unref?.();
  };

  const stop = () => {
    stopped = true;
    if (startupTimer) clearTimeout(startupTimer);
    if (intervalTimer) clearInterval(intervalTimer);
    startupTimer = null;
    intervalTimer = null;
  };

  return {
    start,
    stop,
    runOnce,
    get state() {
      return { running, stopped, graceMs, jitterMs, intervalMs, batchSize };
    },
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.workersDir)) {
    process.stderr.write(`[web-server] workers dir not found: ${args.workersDir}\n`);
    process.exit(2);
  }
  if (!existsSync(WEB_DIR)) {
    process.stderr.write(`[web-server] web dir not found: ${WEB_DIR}\n`);
    process.exit(2);
  }
  const handler = buildRouter({ workersDir: args.workersDir });
  const taskScheduler = createFactoryTaskScheduler({
    workersDir: args.workersDir,
    onResult: (result) => {
      if (result?.dispatched?.length || result?.errors?.length) {
        process.stdout.write(`[task-scheduler] dispatched=${result.dispatched.length} errors=${result.errors.length}\n`);
      }
    },
    onError: (error) => process.stderr.write(`[task-scheduler] ${error?.message || String(error)}\n`),
  });
  const server = createServer((req, res) => {
    handler(req, res).catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[web-server] uncaught:", err);
      try {
        errorResponse(res, 500, "Internal Server Error", String(err?.message || err));
      } catch {
        /* noop */
      }
    });
  });
  server.listen(args.port, args.host, () => {
    taskScheduler.start();
    process.stdout.write(
      [
        "🐂🐴 牛马工厂本地 Web 协作驾驶舱",
        `   version:   ${VERSION}`,
        `   workers:   ${args.workersDir}`,
        `   listen:    http://${args.host}:${args.port}`,
        `   static:    ${WEB_DIR}`,
        "",
        "  按 Ctrl+C 停止。任务看板写入本地总账，员工派活由 Pi 主进程接管。",
        "",
      ].join("\n"),
    );
  });
  const shutdown = () => {
    process.stdout.write("\n[web-server] shutting down…\n");
    taskScheduler.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

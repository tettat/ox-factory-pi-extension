#!/usr/bin/env node
// 牛马工厂本地只读 Web 驾驶舱 (Phase 1)
// ---------------------------------------------------------------------------
// 目标：把 .pi/workers/ 下的工厂运行数据聚合成一个本地只读仪表盘。
// 边界：纯只读。不写权限 / 不派活 / 不 apply 主 agent 压缩 / 不扫全局 session。
// 数据：复用 jobs / comm / token-report / report-context / compaction 现有模块。
// ---------------------------------------------------------------------------

import { createServer } from "node:http";
import { existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import { extname, isAbsolute, join, resolve, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

import { listJobs, readJob, tailJobEvents, latestReplyFromEvents } from "./jobs.mjs";
import {
  readPermissions,
  listPermissions,
  listMessages,
  formatPermissions,
  formatMessages,
  messagesFile,
  permissionEventsFile,
} from "./comm.mjs";
import {
  createWebTalkRequest,
  getWebTalkRequest,
  listWebTalkRequests,
} from "./web-talk.mjs";
import { buildFactoryTokenReport, buildFactoryTokenTrend, formatFactoryTokenReport, localDateString } from "./token-report.mjs";
import { buildFactoryReportContext, formatFactoryReportContext } from "./report-context.mjs";
import {
  readFactoryCompactionShadowRecords,
  buildFactoryCompactionReport,
  formatFactoryCompactionReport,
} from "./compaction.mjs";
import { buildFactoryQualityReport } from "./quality-metrics.mjs";
import {
  listWorkerResponsibilities,
  summarizeResponsibilities,
} from "./responsibilities.mjs";
import { listProjects as listStoredProjects, resolveProject as resolveStoredProject } from "./projects.mjs";

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
      "牛马工厂本地 Web 驾驶舱 (Phase 1)",
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

function uniqueWorkers(workersDir) {
  const sessions = listSessionWorkers(workersDir);
  const jobs = listJobs(workersDir, { limit: 100000 });
  const set = new Set(sessions);
  for (const job of jobs) {
    if (job.worker) set.add(String(job.worker));
  }
  return [...set].filter(Boolean).sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
}

function summarizeJobForOverview(job) {
  return {
    id: job.id,
    status: job.status,
    worker: job.worker,
    project: job.project || "",
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
function buildProjectStrips(workersDir) {
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
    if (job.worker) p.participants.add(job.worker);
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

// ---------------------------------------------------------------------------
// Worker Registry Snapshot (从主 session 恢复 role/backend/model/thinking)
// ---------------------------------------------------------------------------
const _registryCache = { map: null, file: null, mtime: 0 };

function findMainSessionFile(workersDir) {
  // 从 workersDir 反推项目根: <project>/.pi/workers → <project>
  const projectRoot = resolve(workersDir, "..", "..");
  const sanitized = projectRoot.replace(/^\//, "").replace(/\//g, "-");
  const sessionDirName = "--" + sanitized + "--";
  const mainSessionDir = join(homedir(), ".pi", "agent", "sessions", sessionDirName);
  if (!existsSync(mainSessionDir)) return null;
  // 取最新的 .jsonl（排除 .bak）
  const files = readdirSync(mainSessionDir)
    .filter((f) => f.endsWith(".jsonl") && !f.includes(".bak"))
    .map((f) => {
      const fp = join(mainSessionDir, f);
      return { fp, mtime: statSync(fp).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return files[0]?.fp || null;
}

function scanWorkerEntries(sessionFile) {
  // 逐行扫描 ox-worker-* custom entries，重建 registry
  const workers = new Map();
  try {
    const lines = readFileSync(sessionFile, "utf8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      const ct = obj.customType;
      if (!ct || !ct.startsWith("ox-worker-")) continue;
      const d = obj.data || {};
      const wid = d.workerId;
      if (!wid) continue;

      if (ct === "ox-worker-hire") {
        workers.set(wid, {
          role: d.role || null,
          backend: d.backend || "pi",
          model: d.model || null,
          thinking: d.thinking || null,
          hired: d.hired || null,
          status: d.status || "idle",
          fired: false,
        });
      } else if (ct === "ox-worker-config") {
        const w = workers.get(wid);
        if (w) {
          if (d.backend) w.backend = d.backend;
          if (d.model) w.model = d.model;
          if (d.thinking) w.thinking = d.thinking;
        }
      } else if (ct === "ox-worker-promote") {
        const w = workers.get(wid);
        if (w && d.to) w.role = d.to;
      } else if (ct === "ox-worker-fire") {
        const w = workers.get(wid);
        if (w) {
          w.fired = true;
          w.status = "fired";
        }
      } else if (ct === "ox-worker-status") {
        const w = workers.get(wid);
        if (w && d.status && d.status !== "working") w.status = d.status;
      }
    }
  } catch {
    // 读取失败返回空
  }
  // 过滤掉已解雇的
  for (const [name, info] of workers) {
    if (info.fired) workers.delete(name);
  }
  return workers;
}

function getWorkerRegistry(workersDir) {
  const sessionFile = findMainSessionFile(workersDir);
  if (!sessionFile) return new Map();

  const mtime = statSync(sessionFile).mtimeMs;
  if (_registryCache.map && _registryCache.file === sessionFile && _registryCache.mtime === mtime) {
    return _registryCache.map;
  }

  const map = scanWorkerEntries(sessionFile);
  _registryCache.map = map;
  _registryCache.file = sessionFile;
  _registryCache.mtime = mtime;
  return map;
}

// ---------------------------------------------------------------------------
// 员工视角聚合 (含今日 token / 最新 job / 未读消息)
// ---------------------------------------------------------------------------
function buildWorkersView(workersDir, jobs, tokenReport, messages, registry) {
  const reg = registry || getWorkerRegistry(workersDir);
  const names = [...new Set([...uniqueWorkers(workersDir), ...reg.keys()])]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
  const tokenMap = new Map((tokenReport?.workers || []).map((t) => [t.worker, t]));
  const responsibilityMap = new Map();
  for (const responsibility of listWorkerResponsibilities(workersDir)) {
    const list = responsibilityMap.get(responsibility.worker) || [];
    list.push(responsibility);
    responsibilityMap.set(responsibility.worker, list);
  }
  const msgCount = new Map();
  for (const m of messages) {
    const key = m.to;
    msgCount.set(key, (msgCount.get(key) || 0) + 1);
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
    const unread = msgCount.get(name) || 0;
    const responsibilities = responsibilityMap.get(name) || [];
    return {
      name,
      status,
      role: regInfo.role || null,
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
      unreadMessages: unread,
    };
  });
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------
function buildRouter({ workersDir }) {
  return async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
    const pathname = url.pathname;
    const method = (req.method || "GET").toUpperCase();

    if (method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,OPTIONS,POST",
        "access-control-allow-headers": "content-type",
      });
      res.end();
      return;
    }
    // /api/talk/:worker 接受 POST；其余仍只 GET
    if (method === "POST" && pathname.startsWith("/api/talk/")) {
      try {
        const body = await readJsonBody(req);
        return await handleTalkMessage(workersDir, res, pathname, body);
      } catch (err) {
        return errorResponse(res, 400, `读取请求体失败: ${err.message}`);
      }
    }
    if (method !== "GET") {
      res.writeHead(405, {
        "allow": "GET, OPTIONS, POST /api/talk/*",
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify({ error: { status: 405, message: `Method Not Allowed: ${method}` } }));
      return;
    }

    try {
      if (pathname === "/api/health") return handleHealth(res);
      if (pathname === "/api/overview") return await handleOverview(workersDir, res);
      if (pathname === "/api/workers") return await handleWorkers(workersDir, res);
      if (pathname.startsWith("/api/workers/")) {
        const name = decodeURIComponent(pathname.slice("/api/workers/".length));
        return await handleWorkerDetail(workersDir, res, name);
      }
      if (pathname === "/api/jobs") return await handleJobs(workersDir, res, url);
      if (pathname.startsWith("/api/jobs/")) {
        const id = decodeURIComponent(pathname.slice("/api/jobs/".length));
        return await handleJobDetail(workersDir, res, id);
      }
      if (pathname === "/api/report-context") return await handleReportContext(workersDir, res, url);
      if (pathname === "/api/tokens") return await handleTokens(workersDir, res, url);
      if (pathname === "/api/tokens/trend") return await handleTokensTrend(workersDir, res, url);
      if (pathname === "/api/compactions") return await handleCompactions(workersDir, res, url);
      if (pathname === "/api/quality-metrics") return await handleQualityMetrics(workersDir, res, url);
      if (pathname === "/api/permissions") return await handlePermissions(workersDir, res);
      if (pathname === "/api/messages") return await handleMessages(workersDir, res, url);
      if (pathname === "/api/talk-requests" || pathname.startsWith("/api/talk-requests/")) {
        return await handleTalkRequestStatus(workersDir, res, pathname, url);
      }
      if (pathname === "/api/projects") return await handleProjects(workersDir, res);
      if (pathname === "/api/project-doc") return await handleProjectDoc(workersDir, res, url);
      if (pathname.startsWith("/api/projects/")) {
        const id = decodeURIComponent(pathname.slice("/api/projects/".length));
        return await handleProjectDetail(workersDir, res, id);
      }
      if (pathname === "/api/schedules") return await handleSchedules(workersDir, res, url);
      if (pathname === "/api/responsibilities") return await handleResponsibilities(workersDir, res, url);
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

async function handleWorkerDetail(workersDir, res, name) {
  if (!name) return badRequest(res, "worker name required");
  const registry = getWorkerRegistry(workersDir);
  const regInfo = registry.get(name) || {};
  const jobs = listJobs(workersDir, { worker: name, limit: 200 }).sort((a, b) =>
    String(b.createdAt).localeCompare(String(a.createdAt)),
  );
  const inbox = listMessages(workersDir, { worker: name, limit: 50, includeSent: true });
  const tokenReport = buildFactoryTokenReport({ workersDir, date: localDateString(new Date()), worker: name });
  const responsibilities = listWorkerResponsibilities(workersDir, { worker: name });
  return jsonResponse(res, 200, {
    name,
    status: regInfo.status === "vacation" ? "vacation" : pickStatus(jobs),
    role: regInfo.role || null,
    backend: regInfo.backend || null,
    model: regInfo.model || null,
    thinking: regInfo.thinking || null,
    profile: null,
    responsibility: summarizeResponsibilities(responsibilities, { max: 5 }),
    responsibilities,
    jobCount: jobs.length,
    jobs: jobs.map(summarizeJobForOverview),
    inbox: inbox.map((m) => ({
      id: m.id,
      from: m.from,
      to: m.to,
      direction: m.to === name ? "in" : "out",
      createdAt: m.createdAt,
      read: m.read,
      content: m.content,
    })),
    tokenToday: tokenReport.workers[0]?.reported || null,
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

async function handleJobDetail(workersDir, res, id) {
  if (!id) return badRequest(res, "job id required");
  const jobFile = join(workersDir, "jobs", `${id}.json`);
  if (!existsSync(jobFile)) return notFound(res, `job ${id} not found`);
  const job = readJob(jobFile);
  const events = tailJobEvents(job, 100);
  const latestReply = latestReplyFromEvents(events);
  const fullReply = detailText(job.fullOutput || latestReply || job.summary || "");
  return jsonResponse(res, 200, {
    id: job.id,
    status: job.status,
    kind: job.kind,
    worker: job.worker,
    project: job.project || "",
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
    events: events.map((e) => ({
      time: e.time,
      type: e.type,
      name: e.name || null,
      text: e.text || null,
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

  try {
    const request = createWebTalkRequest(workersDir, {
      worker,
      message,
      from: String(body?.from || "web").trim() || "web",
    });
    return jsonResponse(res, 202, {
      ok: true,
      request: {
        id: request.id,
        status: request.status,
        worker: request.worker,
        message: request.message,
        createdAt: request.createdAt,
      },
      note: "Web talk 请求已提交，等待 Pi 主进程接管并走正常 /talk 调度。若刚更新代码，需要 reload Pi 后才会自动接管。",
    });
  } catch (err) {
    return errorResponse(res, 500, "创建 web talk 请求失败", String(err?.message || err));
  }
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
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

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
    process.stdout.write(
      [
        "🐂🐴 牛马工厂本地 Web 驾驶舱 (Phase 1)",
        `   version:   ${VERSION}`,
        `   workers:   ${args.workersDir}`,
        `   listen:    http://${args.host}:${args.port}`,
        `   static:    ${WEB_DIR}`,
        "",
        "  按 Ctrl+C 停止。Phase 1 只读，不写权限 / 不派活 / 不 apply 压缩。",
        "",
      ].join("\n"),
    );
  });
  const shutdown = () => {
    process.stdout.write("\n[web-server] shutting down…\n");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

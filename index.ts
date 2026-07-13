/**
 * 牛马工厂 — Pi Extension
 *
 * 将每个 pi session 视为一名"员工"，提供招人、派活、赛马、晋升等管理能力。
 *
 * 工具列表:
 *   factory_hire      - 招人（创建新 session）
 *   factory_fire      - 解雇
 *   factory_worker_status - 员工休假/返岗
 *   factory_cancel_job - 取消后台 job
 *   factory_list      - 查看全体员工
 *   factory_promote   - 晋升/转岗
 *   factory_worker_config - 调整员工运行配置
 *   factory_dispatch  - 派活（单人 or 并行）
 *   factory_race      - 赛马（多人做同一任务，评委选优）
 *   factory_recommend - 推荐人选
 *   factory_transfer  - 记忆迁移（fork session 给新员工）
 *   factory_talk      - 实时对话（流式思考和工具调用）
 *   factory_queue     - 加入任务队列（离线执行）
 *   factory_check     - 查看队列状态
 *   factory_pick      - 随机查看未读员工成果
 *   factory_report_context - 聚合日报数据源
 *   factory_token_report - 统计员工 token 用量
 *   factory_compaction_report - 查看 Pi vs Codex shadow 压缩对比
 *   factory_quality_report - 统计上下文/压缩/回复质量观测指标
 *   factory_quality_monitor_config - 开关情绪评分旁路
 *   factory_project_* - 管理轻量项目实体 / Todo / Worktree / 进展 / 人员
 *   factory_responsibility_* - 管理员工当前职责 / 负责项目
 *   factory_permission_* - 授权式员工通信权限
 *   factory_message_* - 授权式员工消息
 *   factory_command   - 有记忆员工指挥模式
 *   factory_watch     - 实时查看后台 job 输出
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { request as httpRequest } from "node:http";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

import { type Worker, type WorkerRole, ALL_ROLES } from "./types.ts";
import {
  init,
  hire,
  fire,
  promote,
  setWorkerStatus,
  listWorkers,
  formatWorkerProfile,
  getActiveWorkers,
  recordProject,
  recordRace,
  getWorkersDir,
  getAgentDef,
  restoreFromEntries,
  listResponsibilities,
  removeResponsibility,
  setResponsibility,
  updateWorkerConfig,
  workers,
  raceHistory,
  setPi,
} from "./registry.ts";
import {
  spawnWorker,
  spawnWorkerStreaming,
  startWorkerJob,
  createWorktree,
  cleanupWorktree,
  mapWithConcurrencyLimit,
  type SpawnOptions,
  type SpawnResult,
  type StreamEvent,
} from "./spawner.ts";
import { assertWorkerThinkingSupported, createCodexWorkerThread, normalizeCodexModel } from "./codex-backend.mjs";
import {
  appendJobEvent,
  createJob,
  formatJobEvent,
  formatJobDetails,
  formatJobLine,
  isTerminalJob,
  listJobs,
  recoverOpenJobsOnStartup,
  readJobEventsSince,
  readJob,
  tailJobEvents,
  updateJob,
} from "./jobs.mjs";
import { formatPickedJob, parsePickCommandArgs, pickUnreadJob } from "./job-pick.mjs";
import { shouldRunInProcess } from "./queue-utils.mjs";
import { buildFactoryReportContext, formatFactoryReportContext } from "./report-context.mjs";
import { buildFactoryTokenReport, formatFactoryTokenReport } from "./token-report.mjs";
import {
  buildFactoryQualityReport,
  formatFactoryQualityReport,
  readQualityMonitorConfig,
  writeQualityMonitorConfig,
} from "./quality-metrics.mjs";
import {
  buildFactoryCompactionReport,
  formatFactoryCompactionReport,
  handleFactoryCompactionCompleted,
  handleFactoryCompactionEvent,
} from "./compaction.mjs";
import {
  formatMessages,
  formatPermissions,
  grantPermission,
  hasPermission,
  isFactoryAdmin,
  listMessages,
  listPermissions,
  markMessageRead,
  revokePermission,
  sendAuthorizedMessage,
  sendTaskResultMessage,
} from "./comm.mjs";
import { formatResponsibilitiesMarkdown } from "./responsibilities.mjs";
import {
  addProjectProgress,
  formatProjectMarkdown,
  formatProjectsMarkdown,
  listProjects,
  resolveProject,
  setProjectMember,
  setProjectTodo,
  setProjectWorktree,
  upsertProject,
} from "./projects.mjs";
import {
  acceptWebTalkRequest,
  acceptWebTalkJobControlRequest,
  claimWebTalkRequest,
  failWebTalkRequest,
  failWebTalkJobControlRequest,
  listPendingWebTalkRequests,
  listPendingWebTalkJobControlRequests,
} from "./web-talk.mjs";
import {
  acceptMainAgentTalkRequest,
  claimMainAgentTalkRequest,
  failMainAgentTalkRequest,
  listPendingMainAgentTalkRequests,
} from "./main-agent-talk.mjs";
import {
  acceptWorkerTaskRequest,
  claimWorkerTaskRequest,
  createWorkerTaskRequest,
  failWorkerTaskRequest,
  getWorkerTaskRequest,
  listPendingWorkerTaskRequests,
  listWorkerTaskRequests,
  reportWorkerTaskResult,
  recoverStaleWorkerTaskRequests,
} from "./task-requests.mjs";
import {
  formatOutsourceProfiles,
  formatOutsourceRuns,
  getOutsourceProfile,
  getOutsourceRun,
  listOutsourceProfiles,
  listOutsourceRuns,
  upsertOutsourceProfile,
  waitForOutsourceRuns,
} from "./outsource-agents.mjs";
import {
  normalizeOutsourceWait,
  renderOutsourceResult,
  renderOutsourceWaitResult,
  startOutsourceRunJob,
} from "./outsource-dispatcher.mjs";
import { getWorkerRegistrySnapshot } from "./worker-registry-snapshot.mjs";

// ─── Role Schema ────────────────────────────────────────

const RoleSchema = StringEnum(
  ["programmer", "tester", "reviewer", "foreman", "judge", "historian", "senior-programmer", "designer"] as const,
  { description: "员工角色", default: "programmer" },
);

const PermissionActionSchema = StringEnum(
  ["message:send", "message:broadcast", "work:request", "work:assign", "permission:manage", "worker:fire", "*"] as const,
  { description: "授权动作" },
);

const ResponsibilityStatusSchema = StringEnum(
  ["active", "paused", "done"] as const,
  { description: "职责状态：active=进行中，paused=暂停，done=已完成", default: "active" },
);

const ProjectStatusSchema = StringEnum(
  ["active", "paused", "done", "archived"] as const,
  { description: "项目状态：active=进行中，paused=暂停，done=完成，archived=归档", default: "active" },
);

const ProjectTodoStatusSchema = StringEnum(
  ["todo", "doing", "done", "blocked", "dropped"] as const,
  { description: "项目 Todo 状态", default: "todo" },
);

const ProjectWorktreeStatusSchema = StringEnum(
  ["active", "paused", "merged", "abandoned"] as const,
  { description: "项目 worktree 状态", default: "active" },
);

const ProjectMemberStatusSchema = StringEnum(
  ["active", "inactive"] as const,
  { description: "项目成员关系状态", default: "active" },
);

const WorkerManualStatusSchema = StringEnum(
  ["idle", "vacation"] as const,
  { description: "员工手动状态：idle=返岗空闲，vacation=长期休假不接新任务", default: "vacation" },
);

// ─── 结果总结 ───────────────────────────────────────────

function summarizeSpawn(r: SpawnResult): string {
  const ok = r.exitCode === 0 && !["error", "aborted"].includes(r.stopReason ?? "");
  const icon = ok ? "✅" : "❌";
  const cached = (r as any).cachedInputTokens ? ` cache↑${(r as any).cachedInputTokens}` : "";
  const reasoning = (r as any).reasoningOutputTokens ? ` reason↓${(r as any).reasoningOutputTokens}` : "";
  let text = `${icon} 退出码=${r.exitCode} | ${r.turns} 轮 | ↑${r.inputTokens}${cached} ↓${r.outputTokens}${reasoning}`;
  if (r.model) text += ` | ${r.model}`;
  if (!ok) text += `\n错误: ${r.errorMessage || r.stderr || "未知错误"}`;
  text += `\n\n---\n\n${r.output.slice(0, 3000)}`;
  if (r.output.length > 3000) text += `\n...(截断，共 ${r.output.length} 字符)`;
  return text;
}

function spawnSucceeded(r: SpawnResult): boolean {
  return r.exitCode === 0 && !["error", "aborted"].includes(r.stopReason ?? "");
}

function backendDisplayName(backend: string | undefined): string {
  if (backend === "codex") return "Codex app-server";
  if (backend === "claude") return "Claude Code CLI";
  return "Pi CLI";
}

function workerUnavailableReason(w: Worker | undefined, name: string): string {
  if (!w) return `员工 "${name}" 不存在`;
  if (w.status === "fired") return `员工 "${name}" 已离职`;
  if (w.status === "vacation") return `员工 "${name}" 正在休假，不接新任务`;
  if ((w.backend ?? "pi") === "codex" && !String(w.codexThreadId || "").trim()) {
    return `员工 "${name}" 缺少 Codex thread 绑定；为避免新开空白 thread，已拒绝派活。请先修复 codexThreadId。`;
  }
  if ((w.backend ?? "pi") === "claude" && !String(w.claudeSessionId || "").trim()) {
    return `员工 "${name}" 缺少 Claude session 绑定；为避免新开空白 session，已拒绝派活。请先修复 claudeSessionId。`;
  }
  return "";
}

function workerCanAcceptWork(w: Worker | undefined, name: string): { ok: boolean; reason?: string } {
  const reason = workerUnavailableReason(w, name);
  return reason ? { ok: false, reason } : { ok: true };
}

function recoverWorkerFromRegistrySnapshot(workerId: string): Worker | undefined {
  const name = String(workerId || "").trim();
  if (!name) return undefined;
  const snapshot = getWorkerRegistrySnapshot(getWorkersDir()).get(name);
  const existing = workers.get(name);
  if (!snapshot) return existing;
  if (existing) {
    const fields = [
      "backend",
      "model",
      "thinking",
      "codexThreadId",
      "codexServerUrl",
      "codexApprovalPolicy",
      "codexSandbox",
      "codexThreadHandoff",
      "claudeSessionId",
      "claudeSessionInitialized",
      "claudeCwd",
      "claudeCommand",
      "claudePermissionMode",
      "claudeTools",
      "claudeAllowedTools",
      "claudeDisallowedTools",
      "claudeBare",
      "sessionFile",
    ] as const;
    for (const field of fields) {
      if (field in snapshot && (snapshot as any)[field] !== undefined) {
        (existing as any)[field] = (snapshot as any)[field];
      }
    }
    if (snapshot.role) existing.role = snapshot.role as WorkerRole;
    if (snapshot.status === "fired" || snapshot.status === "vacation") {
      existing.status = snapshot.status;
    } else if (existing.status !== "working" && snapshot.status) {
      existing.status = snapshot.status;
    }
    return existing;
  }
  const backend = snapshot.backend ?? "pi";
  const worker: Worker = {
    id: name,
    sessionFile: snapshot.sessionFile || path.join(getWorkersDir(), "sessions", `${name}.jsonl`),
    role: (snapshot.role || "programmer") as WorkerRole,
    backend,
    model: backend === "codex" ? normalizeCodexModel(snapshot.model) : snapshot.model,
    thinking: snapshot.thinking,
    codexThreadId: snapshot.codexThreadId,
    codexServerUrl: snapshot.codexServerUrl,
    codexApprovalPolicy: snapshot.codexApprovalPolicy,
    codexSandbox: snapshot.codexSandbox,
    codexThreadHandoff: snapshot.codexThreadHandoff,
    claudeSessionId: snapshot.claudeSessionId,
    claudeSessionInitialized: snapshot.claudeSessionInitialized,
    claudeCwd: snapshot.claudeCwd,
    claudeCommand: snapshot.claudeCommand,
    claudePermissionMode: snapshot.claudePermissionMode,
    claudeTools: snapshot.claudeTools,
    claudeAllowedTools: snapshot.claudeAllowedTools,
    claudeDisallowedTools: snapshot.claudeDisallowedTools,
    claudeBare: snapshot.claudeBare,
    status: snapshot.status || "idle",
    hired: snapshot.hired || new Date().toISOString().slice(0, 10),
    projects: [],
    promotions: [],
    responsibilities: [],
  };
  workers.set(name, worker);
  return worker;
}

function setWorkerIdleIfStillWorking(w: Worker) {
  if (w.status === "working") w.status = "idle";
}

function findJob(jobId: string): any | undefined {
  const jobs = listJobs(getWorkersDir(), { limit: 500 });
  return jobs.find((job: any) => job.id === jobId || job.id.startsWith(jobId));
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n...(截断，共 ${text.length} 字符)`;
}

function buildCodexThreadHandoff(worker: Worker, previousThreadId?: string | null, note?: string): string {
  const lines: string[] = [
    "本摘要由 ox-factory 在 resetCodexThread 时自动生成，用于把旧 Codex thread 的近期工作上下文交给新 thread。",
    `员工：${worker.id}`,
  ];
  if (previousThreadId) lines.push(`旧 Codex thread：${previousThreadId}`);
  if (note?.trim()) lines.push(`重置说明：${note.trim()}`);

  const recentJobs = listJobs(getWorkersDir(), { worker: worker.id, limit: 5 }).reverse();
  if (recentJobs.length === 0) {
    lines.push("", "近期 job：暂无。");
    return lines.join("\n");
  }

  lines.push("", "近期 job 摘要：");
  for (const job of recentJobs) {
    const events = tailJobEvents(job, 80);
    const finalText = [...events].reverse().find((event: any) => event.type === "done" && event.text)?.text || job.summary || job.fullOutput || "";
    lines.push("");
    lines.push(`- ${job.updatedAt || job.createdAt} · ${job.status} · ${job.project || "talk"} · ${job.id}`);
    lines.push(`  任务：${truncateText(String(job.task || ""), 300).replace(/\n/g, "\n  ")}`);
    if (finalText) {
      lines.push(`  最近结果：${truncateText(String(finalText), 900).replace(/\n/g, "\n  ")}`);
    } else {
      const compactEvents = events.slice(-8).map(formatJobEvent).join("\n");
      if (compactEvents) lines.push(`  最近事件：${truncateText(compactEvents, 700).replace(/\n/g, "\n  ")}`);
    }
  }

  return truncateText(lines.join("\n"), 6000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let oxWebServerProcess: ChildProcess | null = null;

function parseOxWebArgs(raw: string = "") {
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  const options = { port: 8787, open: true, statusOnly: false };
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (/^\d+$/.test(part)) {
      options.port = Number(part);
    } else if (part === "--port" || part === "-p") {
      const value = Number(parts[++i]);
      if (Number.isFinite(value)) options.port = value;
    } else if (part === "--no-open") {
      options.open = false;
    } else if (part === "--status") {
      options.statusOnly = true;
    }
  }
  if (!Number.isFinite(options.port) || options.port <= 0 || options.port > 65535) options.port = 8787;
  return options;
}

async function httpGetText(url: string, timeout = 800): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: { statusCode: number; body: string }) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = httpRequest(url, { timeout }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        finish({ statusCode: res.statusCode || 0, body });
      });
    });
    req.on("error", () => finish({ statusCode: 0, body: "" }));
    req.on("timeout", () => {
      req.destroy();
      finish({ statusCode: 0, body: "" });
    });
    req.end();
  });
}

async function checkOxWebDashboard(url: string): Promise<{ baseHealthy: boolean; requiredApisHealthy: boolean; healthy: boolean; detail: string }> {
  const health = await httpGetText(`${url}/api/health`);
  const baseHealthy = health.statusCode === 200 && health.body.includes("ox-factory-web-dashboard");
  if (!baseHealthy) {
    return { baseHealthy: false, requiredApisHealthy: false, healthy: false, detail: "health endpoint is not ox-factory" };
  }
  let featureAdvertised = false;
  try {
    const parsed = JSON.parse(health.body);
    featureAdvertised = Boolean(parsed?.features?.taskRequests);
  } catch {
    featureAdvertised = false;
  }
  const taskRequests = await httpGetText(`${url}/api/task-requests?limit=1`);
  const requiredApisHealthy = featureAdvertised || taskRequests.statusCode === 200;
  return {
    baseHealthy,
    requiredApisHealthy,
    healthy: baseHealthy && requiredApisHealthy,
    detail: requiredApisHealthy ? "ok" : "missing required /api/task-requests; web server process is stale",
  };
}

async function isOxWebDashboardHealthy(url: string): Promise<boolean> {
  return (await checkOxWebDashboard(url)).healthy;
}

async function waitForOxWebDashboard(url: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isOxWebDashboardHealthy(url)) return true;
    await sleep(250);
  }
  return false;
}

function openExternalUrl(url: string) {
  const platform = process.platform;
  const command = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.on("error", () => {
    /* best-effort open; command response still includes URL */
  });
  child.unref();
}

function listeningPidForPort(port: number): number | null {
  if (process.platform === "win32") return null;
  try {
    const output = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"], {
      encoding: "utf8",
      timeout: 1200,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const match = output.match(/^p(\d+)/m);
    if (!match) return null;
    const pid = Number(match[1]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function waitForPortToClose(port: number, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!listeningPidForPort(port)) return true;
    await sleep(150);
  }
  return !listeningPidForPort(port);
}

async function stopOxWebDashboardOnPort(port: number): Promise<boolean> {
  const pid = listeningPidForPort(port);
  if (!pid || pid === process.pid) return false;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return false;
  }
  if (await waitForPortToClose(port)) return true;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return false;
  }
  return await waitForPortToClose(port, 1500);
}

async function ensureOxWebDashboard(port: number) {
  const url = `http://127.0.0.1:${port}`;
  const logPath = path.join(getWorkersDir(), `web-server-${port}.log`);
  const current = await checkOxWebDashboard(url);
  if (current.healthy) {
    return { url, status: "running", logPath };
  }
  let staleRestarted = false;
  if (current.baseHealthy && !current.requiredApisHealthy) {
    staleRestarted = await stopOxWebDashboardOnPort(port);
    if (!staleRestarted) {
      throw new Error(`检测到旧版牛马工厂 Web 服务占用 ${url}，但无法自动停止。请手动结束该端口上的 web-server 进程后重试 /ox-web。`);
    }
  }

  const webServerPath = path.resolve(getWorkersDir(), "..", "extensions", "ox-factory", "web-server.mjs");
  if (!fs.existsSync(webServerPath)) {
    throw new Error(`web-server.mjs 不存在：${webServerPath}`);
  }

  try { fs.mkdirSync(getWorkersDir(), { recursive: true }); } catch {}
  const out = fs.openSync(logPath, "a");
  const nodeCmd = process.env.OX_FACTORY_NODE_CMD || "node";
  try {
    oxWebServerProcess = spawn(
      nodeCmd,
      [webServerPath, "--workers-dir", getWorkersDir(), "--port", String(port), "--host", "127.0.0.1"],
      {
        cwd: path.resolve(getWorkersDir(), "..", ".."),
        detached: true,
        stdio: ["ignore", out, out],
        env: { ...process.env },
      },
    );
  } finally {
    try { fs.closeSync(out); } catch {}
  }
  oxWebServerProcess.on("error", () => {
    /* health check below will surface startup failure to the user */
  });
  oxWebServerProcess.unref();

  const healthy = await waitForOxWebDashboard(url);
  return { url, status: healthy ? (staleRestarted ? "restarted" : "started") : "starting", logPath };
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.max(min, Math.min(max, numberValue));
}

function renderWatch(job: any, events: any[]): string {
  const lines = [
    "## 实时 Job 输出",
    "",
    formatJobLine(job),
    "",
    ...events.map(formatJobEvent),
  ];
  return lines.join("\n");
}

type PendingWorkerJob = {
  options: SpawnOptions;
  job: any;
  controller: AbortController;
  onEvent?: (event: StreamEvent) => void;
  resolve: (result: SpawnResult) => void;
  reject: (error: unknown) => void;
};

const workerJobQueues = new Map<string, PendingWorkerJob[]>();
const workerRunningJobs = new Map<string, any>();
const workerJobControllers = new Map<string, AbortController>();

function canSteerActiveCodexTurn(worker: Worker) {
  return (worker.backend ?? "pi") === "codex" && Boolean(worker.codexActiveTurnId) && workerRunningJobs.has(worker.id);
}

function abortedSpawnResult(job: any, reason: string): SpawnResult {
  return {
    exitCode: 1,
    output: "",
    stderr: reason,
    turns: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    stopReason: "aborted",
    errorMessage: reason,
    model: "",
  } as SpawnResult;
}

function markJobAborted(job: any, reason: string, actor = "用户") {
  const current = readJob(job);
  if (isTerminalJob(current)) return current;
  const updated = updateJob(current, {
    status: "aborted",
    finishedAt: new Date().toISOString(),
    error: reason,
    cancelledBy: actor,
  });
  appendJobEvent(updated, {
    type: "aborted",
    text: reason,
    actor,
  });
  return updated;
}

function pruneTerminalRunningJob(workerId: string, reason: string): any | null {
  const running = workerRunningJobs.get(workerId);
  if (!running) return null;
  let current: any;
  try {
    current = readJob(running);
  } catch {
    return null;
  }
  if (!isTerminalJob(current)) return null;
  workerRunningJobs.delete(workerId);
  workerJobControllers.delete(running.id);
  appendJobEvent(current, {
    type: "running_handle_pruned",
    text: reason,
    originalJobId: running.id,
    terminalStatus: current.status,
  });
  const worker = workers.get(workerId);
  const queue = workerJobQueues.get(workerId) ?? [];
  if (worker && queue.length === 0) setWorkerIdleIfStillWorking(worker);
  return current;
}

function jobIdMatches(job: any, jobIdOrPrefix: string) {
  const needle = String(jobIdOrPrefix || "").trim();
  return needle && (job.id === needle || String(job.id || "").startsWith(needle));
}

function cancelWorkerJob(input: { jobId?: string; worker?: string; reason?: string; actor?: string } = {}) {
  const actor = input.actor || "用户";
  const reason = input.reason || `cancelled by ${actor}`;
  const workerFilter = input.worker || "";
  const jobId = input.jobId || "";

  for (const [workerId, job] of workerRunningJobs.entries()) {
    if (workerFilter && workerId !== workerFilter) continue;
    if (jobId && !jobIdMatches(job, jobId)) continue;
    const alreadyTerminal = pruneTerminalRunningJob(workerId, "cancel requested for a job that is already terminal on disk");
    if (alreadyTerminal) {
      refreshWorkerQueuePositions(workerId);
      setTimeout(() => void drainWorkerJobQueue(workerId), 0);
      return {
        status: "cleared-terminal-handle",
        worker: workerId,
        job: alreadyTerminal,
        message: "已清理当前 Pi 进程里的幽灵 running handle；该 job 在磁盘上已经是终态，等待队列会继续流转",
      };
    }
    const controller = workerJobControllers.get(job.id);
    const aborted = markJobAborted(job, reason, actor);
    controller?.abort();
    return {
      status: controller ? "aborting" : "aborted-no-handle",
      worker: workerId,
      job: aborted,
      message: controller ? "已请求中止运行中的 job" : "已标记为 aborted，但当前进程没有可中止句柄",
    };
  }

  for (const [workerId, queue] of workerJobQueues.entries()) {
    if (workerFilter && workerId !== workerFilter) continue;
    const index = queue.findIndex((item) => !jobId || jobIdMatches(item.job, jobId));
    if (index === -1) continue;
    const [item] = queue.splice(index, 1);
    if (queue.length === 0) workerJobQueues.delete(workerId);
    const aborted = markJobAborted(item.job, reason, actor);
    item.controller.abort();
    item.resolve(abortedSpawnResult(aborted, reason));
    refreshWorkerQueuePositions(workerId);
    return {
      status: "aborted",
      worker: workerId,
      job: aborted,
      message: "已从等待队列移除并标记为 aborted",
    };
  }

  const openJobs = listJobs(getWorkersDir(), { worker: workerFilter || undefined, limit: 500 })
    .filter((job: any) => !isTerminalJob(job))
    .sort((a: any, b: any) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")));
  const job = jobId ? openJobs.find((candidate: any) => jobIdMatches(candidate, jobId)) : openJobs[0];
  if (!job) return { status: "not-found", message: "没有找到可取消的未完成 job" };
  const aborted = markJobAborted(job, reason, actor);
  return {
    status: "aborted-no-handle",
    worker: aborted.worker,
    job: aborted,
    message: "已标记为 aborted；该 job 不在当前 Pi 进程内存队列中，无法保证杀掉底层进程",
  };
}

function editQueuedWorkerJob(input: { jobId?: string; worker?: string; task?: string; actor?: string } = {}) {
  const actor = input.actor || "用户";
  const workerFilter = input.worker || "";
  const jobId = input.jobId || "";
  const task = String(input.task || "").trim();
  if (!task) return { status: "invalid", message: "编辑后的任务内容为空" };

  for (const [workerId, queue] of workerJobQueues.entries()) {
    if (workerFilter && workerId !== workerFilter) continue;
    const item = queue.find((candidate) => !jobId || jobIdMatches(candidate.job, jobId));
    if (!item) continue;
    item.options.task = task;
    const updated = updateJob(item.job, {
      task,
      editedAt: new Date().toISOString(),
      editedBy: actor,
    });
    appendJobEvent(updated, {
      type: "edited",
      text: task,
      actor,
      message: "queued job task edited before execution",
    });
    return {
      status: "edited",
      worker: workerId,
      job: updated,
      message: "已更新 Pi 主进程内存队列中的 job 内容",
    };
  }

  const running = [...workerRunningJobs.entries()].find(([workerId, job]) => {
    if (workerFilter && workerId !== workerFilter) return false;
    if (jobId && !jobIdMatches(job, jobId)) return false;
    return true;
  });
  if (running) {
    return {
      status: "running-not-editable",
      worker: running[0],
      job: running[1],
      message: "job 已经运行，不能安全改写；请改用 steer 追加新指令或取消后重发",
    };
  }

  const openJobs = listJobs(getWorkersDir(), { worker: workerFilter || undefined, limit: 500 })
    .filter((job: any) => !isTerminalJob(job))
    .sort((a: any, b: any) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")));
  const job = jobId ? openJobs.find((candidate: any) => jobIdMatches(candidate, jobId)) : openJobs[0];
  if (!job) return { status: "not-found", message: "没有找到可编辑的未完成 job" };
  return {
    status: "not-editable-no-handle",
    worker: job.worker,
    job,
    message: "找到了未完成 job，但它不在当前 Pi 主进程内存队列中；为避免执行内容和元数据不一致，未改写",
  };
}

function refreshWorkerQueuePositions(workerId: string) {
  pruneTerminalRunningJob(workerId, "queue position refresh observed a terminal running job on disk");
  const queue = workerJobQueues.get(workerId) ?? [];
  const running = workerRunningJobs.get(workerId);
  let previousId = running?.id || "";
  queue.forEach((item, index) => {
    updateJob(item.job, {
      queuePosition: index + (running ? 2 : 1),
      queuedBehind: previousId || undefined,
    });
    previousId = item.job.id;
  });
}

async function drainWorkerJobQueue(workerId: string) {
  if (workerRunningJobs.has(workerId)) {
    const pruned = pruneTerminalRunningJob(workerId, "queue drain observed a terminal running job on disk");
    if (!pruned) return;
  }
  const queue = workerJobQueues.get(workerId);
  const item = queue?.shift();
  if (!item) return;

  workerRunningJobs.set(workerId, item.job);
  workerJobControllers.set(item.job.id, item.controller);
  item.options.worker.status = "working";
  refreshWorkerQueuePositions(workerId);

  try {
    const handle = startWorkerJob({ ...item.options, signal: item.controller.signal }, item.job, item.onEvent);
    const result = await handle.promise;
    item.resolve(result);
  } catch (error) {
    item.reject(error);
  } finally {
    workerRunningJobs.delete(workerId);
    workerJobControllers.delete(item.job.id);
    const remaining = workerJobQueues.get(workerId) ?? [];
    if (remaining.length === 0) {
      workerJobQueues.delete(workerId);
      setWorkerIdleIfStillWorking(item.options.worker);
    } else {
      item.options.worker.status = "working";
    }
    refreshWorkerQueuePositions(workerId);
    setTimeout(() => void drainWorkerJobQueue(workerId), 0);
  }
}

function startWorkerJobQueued(
  options: SpawnOptions,
  job: any,
  onEvent?: (event: StreamEvent) => void,
): { job: any; promise: Promise<SpawnResult> } {
  const workerId = options.worker.id;
  if (
    job.deliveryMode === "steer" &&
    canSteerActiveCodexTurn(options.worker)
  ) {
    return startWorkerJob(options, job, onEvent);
  }

  const promise = new Promise<SpawnResult>((resolve, reject) => {
    const controller = new AbortController();
    if (options.signal) {
      const abort = () => controller.abort();
      if (options.signal.aborted) abort();
      else options.signal.addEventListener("abort", abort, { once: true });
    }
    const item: PendingWorkerJob = { options, job, controller, onEvent, resolve, reject };
    const queue = workerJobQueues.get(workerId) ?? [];
    if (job.deliveryMode === "steer") {
      const firstPlainQueue = queue.findIndex((queued) => queued.job.deliveryMode !== "steer");
      if (firstPlainQueue === -1) queue.push(item);
      else queue.splice(firstPlainQueue, 0, item);
    } else {
      queue.push(item);
    }
    workerJobQueues.set(workerId, queue);
    refreshWorkerQueuePositions(workerId);
    void drainWorkerJobQueue(workerId);
  });
  return { job, promise };
}

// ─── 主扩展入口 ─────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  setPi(pi);

  // 从主 session 恢复工厂状态（首次启动时初始化目录）
  let initialized = false;
  let mainSessionEntries: any[] = [];
  let lastSessionCtx: any = null;
  let webTalkPoller: ReturnType<typeof setInterval> | null = null;
  let webTalkDraining = false;
  let webTalkControlDraining = false;
  let mainAgentTalkPoller: ReturnType<typeof setInterval> | null = null;
  let mainAgentTalkDraining = false;
  let workerTaskPoller: ReturnType<typeof setInterval> | null = null;
  let workerTaskDraining = false;
  let talkTarget: string | null = null;
  let activeTalkJobId: string | null = null;
  let mainAgentActive = false;

  function ensureWebTalkPoller(ctx?: any) {
    if (ctx) lastSessionCtx = ctx;
    if (webTalkPoller) return;
    webTalkPoller = setInterval(() => {
      void drainWebTalkRequests(lastSessionCtx);
      void drainWebTalkJobControls(lastSessionCtx);
    }, 1000);
    (webTalkPoller as any).unref?.();
  }

  async function drainWebTalkRequests(ctx?: any) {
    if (!initialized || webTalkDraining) return;
    webTalkDraining = true;
    try {
      const pending = listPendingWebTalkRequests(getWorkersDir(), { limit: 20 });
      for (const request of pending) {
        try {
          const claimed = claimWebTalkRequest(getWorkersDir(), {
            requestId: request.id,
            claimedBy: `pi:${process.pid}`,
          });
          if (!claimed) continue;
          const workerId = String(request.worker || "").trim();
          const message = String(request.message || "").trim();
          const w = recoverWorkerFromRegistrySnapshot(workerId);
          const availability = workerCanAcceptWork(w, workerId);
          if (!availability.ok) {
            failWebTalkRequest(getWorkersDir(), {
              requestId: request.id,
              error: availability.reason || `员工 ${workerId} 当前不可接活`,
            });
            continue;
          }
          if (!message) {
            failWebTalkRequest(getWorkersDir(), {
              requestId: request.id,
              error: "web talk 消息为空",
            });
            continue;
          }

          const requestedMode = request.mode === "queue" || request.mode === "steer" ? request.mode : undefined;
          const job = startTalkMessage(w!, message, ctx, requestedMode, { attach: false, notify: false });
          if (!job) {
            failWebTalkRequest(getWorkersDir(), {
              requestId: request.id,
              error: "Pi 主进程未能创建 talk job",
            });
            continue;
          }
          acceptWebTalkRequest(getWorkersDir(), {
            requestId: request.id,
            jobId: job.id,
            deliveryMode: job.deliveryMode || "message",
            placement: job.deliveryMode === "queue" ? "已排队" : "已接入正常 talk 调度",
          });
        } catch (error: any) {
          failWebTalkRequest(getWorkersDir(), {
            requestId: request.id,
            error: error?.message || String(error),
          });
        }
      }
    } finally {
      webTalkDraining = false;
    }
  }

  async function drainWebTalkJobControls(_ctx?: any) {
    if (!initialized || webTalkControlDraining) return;
    webTalkControlDraining = true;
    try {
      const pending = listPendingWebTalkJobControlRequests(getWorkersDir(), { limit: 20 });
      for (const request of pending) {
        try {
          if (request.action === "cancel") {
            const result = cancelWorkerJob({
              jobId: request.jobId || undefined,
              worker: request.worker || undefined,
              actor: request.from || "web",
              reason: request.reason || "用户通过 Web 取消 job",
            });
            if (result.status === "not-found") {
              failWebTalkJobControlRequest(getWorkersDir(), {
                requestId: request.id,
                error: result.message,
              });
            } else {
              acceptWebTalkJobControlRequest(getWorkersDir(), {
                requestId: request.id,
                status: result.status,
                message: result.message,
              });
            }
            continue;
          }

          if (request.action === "edit") {
            const result = editQueuedWorkerJob({
              jobId: request.jobId || undefined,
              worker: request.worker || undefined,
              task: request.message || "",
              actor: request.from || "web",
            });
            if (result.status !== "edited") {
              failWebTalkJobControlRequest(getWorkersDir(), {
                requestId: request.id,
                error: result.message,
              });
            } else {
              acceptWebTalkJobControlRequest(getWorkersDir(), {
                requestId: request.id,
                status: result.status,
                message: result.message,
              });
            }
            continue;
          }

          failWebTalkJobControlRequest(getWorkersDir(), {
            requestId: request.id,
            error: `不支持的 web job control action: ${request.action}`,
          });
        } catch (error: any) {
          failWebTalkJobControlRequest(getWorkersDir(), {
            requestId: request.id,
            error: error?.message || String(error),
          });
        }
      }
    } finally {
      webTalkControlDraining = false;
    }
  }

  function ensureMainAgentTalkPoller(ctx?: any) {
    if (ctx) lastSessionCtx = ctx;
    if (mainAgentTalkPoller) return;
    mainAgentTalkPoller = setInterval(() => {
      void drainMainAgentTalkRequests(lastSessionCtx);
    }, 1000);
    (mainAgentTalkPoller as any).unref?.();
  }

  async function drainMainAgentTalkRequests(ctx?: any) {
    if (!initialized || mainAgentTalkDraining || !ctx) return;
    // 轻量第一版：只在秘书完全空闲、且用户没有停留在 /talk 员工模式时投递。
    // 这样 Web 侧不会抢占控制台当前 turn，也不会被 /talk input hook 当成员工消息拦截。
    if (mainAgentActive || talkTarget || (typeof ctx.isIdle === "function" && !ctx.isIdle())) return;
    mainAgentTalkDraining = true;
    try {
      const pending = listPendingMainAgentTalkRequests(getWorkersDir(), { limit: 1 });
      for (const request of pending) {
        try {
          const claimed = claimMainAgentTalkRequest(getWorkersDir(), {
            requestId: request.id,
            claimedBy: `pi:${process.pid}`,
          });
          if (!claimed) continue;
          const message = String(request.message || "").trim();
          if (!message) {
            failMainAgentTalkRequest(getWorkersDir(), {
              requestId: request.id,
              error: "主 agent Web 消息为空",
            });
            continue;
          }
          if (mainAgentActive || talkTarget || (typeof ctx.isIdle === "function" && !ctx.isIdle())) break;
          await pi.sendUserMessage(message);
          acceptMainAgentTalkRequest(getWorkersDir(), {
            requestId: request.id,
            deliveryMode: "idle",
            placement: "秘书空闲，已作为真实用户消息投递",
          });
        } catch (error: any) {
          failMainAgentTalkRequest(getWorkersDir(), {
            requestId: request.id,
            error: error?.message || String(error),
          });
        }
      }
    } finally {
      mainAgentTalkDraining = false;
    }
  }

  function ensureWorkerTaskPoller(ctx?: any) {
    if (ctx) lastSessionCtx = ctx;
    if (workerTaskPoller) return;
    workerTaskPoller = setInterval(() => {
      void drainWorkerTaskRequests(lastSessionCtx);
    }, 1000);
    (workerTaskPoller as any).unref?.();
  }

  function buildAssignedTaskPrompt(request: any): string {
    return [
      `你收到一项来自 ${request.from || "用户"} 的工厂派活。`,
      ``,
      `task request id: ${request.id}`,
      `source: ${request.source || "worker"}`,
      `project: ${request.project || "factory-task"}`,
      ``,
      `任务内容：`,
      String(request.task || "").trim(),
      ``,
      `请直接执行任务。完成后不需要手动发消息；系统会把本 job 的结果回传给派活者 ${request.from || "用户"}。`,
    ].join("\n");
  }

  async function drainWorkerTaskRequests(_ctx?: any) {
    if (!initialized || workerTaskDraining) return;
    workerTaskDraining = true;
    try {
      recoverStaleWorkerTaskRequests(getWorkersDir(), {
        recoveredBy: `pi:${process.pid}`,
      });
      const pending = listPendingWorkerTaskRequests(getWorkersDir(), { limit: 20 });
      for (const request of pending) {
        try {
          const claimed = claimWorkerTaskRequest(getWorkersDir(), {
            requestId: request.id,
            claimedBy: `pi:${process.pid}`,
          });
          if (!claimed) continue;
          const from = String(claimed.from || "用户").trim() || "用户";
          const targetWorkerId = String(claimed.to || "").trim();
          const task = String(claimed.task || "").trim();
          if (!targetWorkerId || targetWorkerId === "*") {
            failWorkerTaskRequest(getWorkersDir(), {
              requestId: request.id,
              error: "派活目标不能为空，且暂不支持广播目标 *",
            });
            continue;
          }
          if (!hasPermission(getWorkersDir(), { subject: from, action: "work:assign", target: targetWorkerId })) {
            failWorkerTaskRequest(getWorkersDir(), {
              requestId: request.id,
              error: `${from} 没有权限对 ${targetWorkerId} 执行 work:assign`,
            });
            continue;
          }
          const worker = recoverWorkerFromRegistrySnapshot(targetWorkerId);
          const availability = workerCanAcceptWork(worker, targetWorkerId);
          if (!availability.ok) {
            failWorkerTaskRequest(getWorkersDir(), {
              requestId: request.id,
              error: availability.reason || `员工 ${targetWorkerId} 当前不可接活`,
            });
            continue;
          }
          if (!task) {
            failWorkerTaskRequest(getWorkersDir(), {
              requestId: request.id,
              error: "派活任务为空",
            });
            continue;
          }

          const { job, deliveryMode, placement } = enqueueWorkerCommand({
            worker: worker!,
            task: buildAssignedTaskPrompt(claimed),
            project: claimed.project || "factory-task",
            cwd: claimed.cwd || process.cwd(),
            mode: claimed.mode || "auto",
            kind: "assigned-task",
            sourceTaskRequestId: claimed.id,
            assignedBy: from,
            returnTo: from,
            source: "worker_task_assign",
            displayChannel: "talk",
          });
          acceptWorkerTaskRequest(getWorkersDir(), {
            requestId: request.id,
            jobId: job.id,
            deliveryMode,
            placement,
          });
        } catch (error: any) {
          failWorkerTaskRequest(getWorkersDir(), {
            requestId: request.id,
            error: error?.message || String(error),
          });
        }
      }
    } finally {
      workerTaskDraining = false;
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    lastSessionCtx = ctx;
    if (!initialized) {
      init(ctx.cwd);
      initialized = true;
      const recovery = recoverOpenJobsOnStartup(
        getWorkersDir(),
        "previous Pi process exited before this in-process job completed",
      );
      if (recovery.stale > 0) {
        ctx.ui?.notify?.(`已将 ${recovery.stale} 个无新鲜 heartbeat 的遗留员工 job 标记为 stale`, "info");
      }
      if (recovery.recovered > 0) {
        ctx.ui?.notify?.(`保留 ${recovery.recovered} 个仍有新鲜 heartbeat 的员工 job 为 orphan-running`, "info");
      }
      ensureWebTalkPoller(ctx);
      ensureMainAgentTalkPoller(ctx);
      ensureWorkerTaskPoller(ctx);
    }
    const entries = ctx.sessionManager.getEntries();
    mainSessionEntries = entries;
    restoreFromEntries(entries);
  });

  // Codex 代压缩后端。
  // 主 agent 和员工默认 shadow-only：Codex 旁路双跑并记录对比，不替换 Pi 真实摘要。
  // 如需临时关闭可设置 OX_FACTORY_CODEX_COMPACTION_MODE=off；
  // 如需收窄员工范围可设置 OX_FACTORY_CODEX_COMPACTION_WORKERS。
  // legacy OX_FACTORY_CODEX_COMPACTION=1 仍等价于 apply；主 agent 默认拒绝 apply，只做评估不采纳。
  pi.on("session_before_compact", async (event, ctx) => {
    return handleFactoryCompactionEvent(event, ctx, {
      workersDir: getWorkersDir(),
      model: process.env.OX_FACTORY_CODEX_COMPACTION_MODEL || "gpt-5.5",
    });
  });

  pi.on("session_compact", (event, ctx) => {
    void handleFactoryCompactionCompleted(event, ctx, {
      workersDir: getWorkersDir(),
    });
  });

  // ═══════════════════════════════════════════════════════
  // factory_hire — 招人
  // ═══════════════════════════════════════════════════════
  pi.registerTool({
    name: "factory_hire",
    label: "招人",
    description: "雇佣一名新员工（创建独立 session）。用于建立开发团队。",
    parameters: Type.Object({
      name: Type.String({ description: "员工姓名（唯一标识）" }),
      role: RoleSchema,
      profile: Type.Optional(
        Type.String({ description: "预设配置名（lite/pro/balanced），自动填入模型和思考深度" }),
      ),
      model: Type.Optional(Type.String({ description: "指定模型（覆盖 profile 的默认值）" })),
      thinking: Type.Optional(
        StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const, {
          description: "思考深度（覆盖 profile 的默认值）。max/ultra 仅适用于 Codex 后端；ultra 还会允许 Codex 自动委派子任务。",
        }),
      ),
      backend: Type.Optional(
        StringEnum(["pi", "codex", "claude"] as const, {
          description: "员工后端。pi=当前 Pi CLI 子进程；codex=本机 Codex app-server thread；claude=本机 Claude Code CLI session。",
          default: "pi",
        }),
      ),
      codexServerUrl: Type.Optional(Type.String({ description: "Codex app-server WebSocket URL，默认 ws://127.0.0.1:48177" })),
      codexApprovalPolicy: Type.Optional(
        StringEnum(["untrusted", "on-failure", "on-request", "never"] as const, {
          description: "Codex 审批策略，默认 never。",
          default: "never",
        }),
      ),
      codexSandbox: Type.Optional(
        StringEnum(["read-only", "workspace-write", "danger-full-access"] as const, {
          description: "Codex sandbox，默认 danger-full-access。",
          default: "danger-full-access",
        }),
      ),
      claudeCommand: Type.Optional(Type.String({ description: "Claude Code CLI 命令，默认 claude。可填自定义 wrapper 路径。" })),
      claudePermissionMode: Type.Optional(
        StringEnum(["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"] as const, {
          description: "Claude Code permission mode；不填则沿用本机 Claude 配置。",
        }),
      ),
      claudeTools: Type.Optional(Type.String({ description: "Claude Code --tools 参数，例如 default、空字符串或 Bash,Edit,Read。" })),
      claudeAllowedTools: Type.Optional(Type.String({ description: "Claude Code --allowedTools，逗号或空格分隔。" })),
      claudeDisallowedTools: Type.Optional(Type.String({ description: "Claude Code --disallowedTools，逗号或空格分隔。" })),
      claudeBare: Type.Optional(Type.Boolean({ description: "是否启用 Claude --bare。默认 false，通常不建议开启以免绕过本机定制配置。", default: false })),
    }),
    async execute(_tcid, params) {
      try {
        // 从 profile 加载默认模型和 thinking
        let model = params.model;
        let thinking = params.thinking;

        if (params.profile) {
          const fs = await import("node:fs");
          const profilePath = path.join(getWorkersDir(), "profiles.json");
          if (fs.existsSync(profilePath)) {
            const profiles = JSON.parse(fs.readFileSync(profilePath, "utf-8"));
            const p = profiles[params.profile];
            if (p) {
              if (!model) model = p.model;
              if (!thinking) thinking = p.thinking;
            }
          }
        }

        const backend = params.backend ?? "pi";
        assertWorkerThinkingSupported(backend, thinking);
        if (backend === "codex") {
          model = normalizeCodexModel(model);
        }
        if ((backend === "codex" || backend === "claude") && workers.has(params.name) && workers.get(params.name)?.status !== "fired") {
          throw new Error(`员工 "${params.name}" 已存在`);
        }

        let codexOptions: any = {};
        if (backend === "codex") {
          const previewWorker: Worker = {
            id: params.name,
            sessionFile: "",
            role: params.role as WorkerRole,
            backend: "codex",
            model,
            thinking,
            codexServerUrl: params.codexServerUrl,
            codexApprovalPolicy: params.codexApprovalPolicy ?? "never",
            codexSandbox: params.codexSandbox ?? "danger-full-access",
            status: "idle",
            hired: new Date().toISOString().slice(0, 10),
            projects: [],
            promotions: [],
            responsibilities: [],
          };
          const created = await createCodexWorkerThread({
            worker: previewWorker,
            cwd: process.cwd(),
            agentDef: getAgentDef(params.role as WorkerRole),
            workersDir: getWorkersDir(),
          });
          model = created.model || model;
          codexOptions = {
            backend: "codex",
            codexThreadId: created.threadId,
            codexServerUrl: params.codexServerUrl || created.serverUrl,
            codexApprovalPolicy: params.codexApprovalPolicy ?? "never",
            codexSandbox: params.codexSandbox ?? "danger-full-access",
          };
        }

        let claudeOptions: any = {};
        if (backend === "claude") {
          claudeOptions = {
            backend: "claude",
            claudeSessionId: randomUUID(),
            claudeSessionInitialized: false,
            claudeCwd: process.cwd(),
            claudeCommand: params.claudeCommand,
            claudePermissionMode: params.claudePermissionMode,
            claudeTools: params.claudeTools,
            claudeAllowedTools: params.claudeAllowedTools,
            claudeDisallowedTools: params.claudeDisallowedTools,
            claudeBare: params.claudeBare,
          };
        }

        const w = hire(params.name, params.role as WorkerRole, model, thinking, { backend, ...codexOptions, ...claudeOptions });
        const cfgLines: string[] = [
          `🎉 **${w.id}** 已入职！`,
          `- 职位: ${w.role}`,
          `- 后端: ${backendDisplayName(w.backend ?? "pi")}`,
          `- 入职日期: ${w.hired}`,
        ];
        if (w.model) cfgLines.push(`- 模型: ${w.model}`);
        if (w.thinking) cfgLines.push(`- 思考深度: ${w.thinking}`);
        if (w.codexThreadId) cfgLines.push(`- Codex thread: ${w.codexThreadId}`);
        if (w.codexServerUrl) cfgLines.push(`- Codex server: ${w.codexServerUrl}`);
        if (w.claudeSessionId) cfgLines.push(`- Claude session: ${w.claudeSessionId}`);
        if (w.claudeCommand) cfgLines.push(`- Claude command: ${w.claudeCommand}`);
        if (w.claudePermissionMode) cfgLines.push(`- Claude permission: ${w.claudePermissionMode}`);
        cfgLines.push(`- 状态: 待命中`);
        cfgLines.push(``);
        cfgLines.push(`现在可以用「派活」给 ${w.id} 分配任务。`);

        return {
          content: [{ type: "text", text: cfgLines.join("\n") }],
          details: { worker: { id: w.id, role: w.role, backend: w.backend, model: w.model, thinking: w.thinking, hired: w.hired, codexThreadId: w.codexThreadId, codexServerUrl: w.codexServerUrl, claudeSessionId: w.claudeSessionId, claudeCwd: w.claudeCwd } },
        };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `❌ 招人失败: ${e.message}` }],
          isError: true,
          details: {},
        };
      }
    },
  });

  // ═══════════════════════════════════════════════════════
  // factory_fire — 解雇
  // ═══════════════════════════════════════════════════════
  pi.registerTool({
    name: "factory_fire",
    label: "解雇",
    description: "解雇一名员工（标记为离职，不删除记录）。",
    parameters: Type.Object({
      name: Type.String({ description: "员工姓名" }),
      actor: Type.Optional(Type.String({ description: "操作人，默认秘书；管理员可通过 OX_FACTORY_ADMINS 或 workers/local-admins.json 扩展" })),
    }),
    async execute(_tcid, params) {
      try {
        const actor = params.actor || "秘书";
        if (!hasPermission(getWorkersDir(), { subject: actor, action: "worker:fire", target: params.name })) {
          return {
            content: [{ type: "text", text: `❌ ${actor} 没有权限解雇 ${params.name}。` }],
            isError: true,
            details: {},
          };
        }
        const w = fire(params.name);
        return {
          content: [{ type: "text", text: `💀 **${w.id}** 已离职。其履历和工作记录保留在档案中。` }],
          details: { actor, worker: w.id },
        };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `❌ 解雇失败: ${e.message}` }],
          isError: true,
          details: {},
        };
      }
    },
  });

  // ═══════════════════════════════════════════════════════
  // factory_worker_status — 员工休假/返岗
  // ═══════════════════════════════════════════════════════
  pi.registerTool({
    name: "factory_worker_status",
    label: "员工状态",
    description: "设置员工手动状态。vacation=休假不接新任务；idle=返岗为空闲。休假员工会从推荐/派活/指挥/wake 中排除。",
    parameters: Type.Object({
      name: Type.String({ description: "员工姓名" }),
      status: WorkerManualStatusSchema,
      note: Type.Optional(Type.String({ description: "状态说明，例如“长期无任务，先休假”" })),
    }),
    async execute(_tcid, params) {
      try {
        const w = setWorkerStatus(params.name, params.status as "idle" | "vacation", params.note || "");
        return {
          content: [{
            type: "text",
            text: params.status === "vacation"
              ? `🏖️ **${w.id}** 已休假。休假期间不会被推荐、派活、指挥或 wake。`
              : `😴 **${w.id}** 已返岗为空闲状态，可以重新接任务。`,
          }],
          details: { worker: w.id, status: w.status },
        };
      } catch (e: any) {
        return { content: [{ type: "text", text: `❌ 设置员工状态失败: ${e.message}` }], isError: true, details: {} };
      }
    },
  });

  // ═══════════════════════════════════════════════════════
  // factory_cancel_job — 取消后台任务
  // ═══════════════════════════════════════════════════════
  pi.registerTool({
    name: "factory_cancel_job",
    label: "取消任务",
    description: [
      "取消员工后台 job。",
      "当前 Pi 进程内的 running job 会触发 AbortController/turn interrupt；等待队列里的 job 会直接移除并标记 aborted。",
      "reload 前遗留或其他进程的 job 只能标记 aborted，无法保证杀掉底层进程。",
    ].join(" "),
    parameters: Type.Object({
      jobId: Type.Optional(Type.String({ description: "job id 或前缀。不填则按 worker/latest 查找最新未完成 job。" })),
      worker: Type.Optional(Type.String({ description: "员工姓名。不填则全局查找最新未完成 job。" })),
      reason: Type.Optional(Type.String({ description: "取消原因，会写入 job events。" })),
      actor: Type.Optional(Type.String({ description: "操作者，默认用户。" })),
    }),
    async execute(_tcid, params) {
      const result = cancelWorkerJob({
        jobId: params.jobId,
        worker: params.worker,
        reason: params.reason || "用户通过 factory_cancel_job 取消",
        actor: params.actor || "用户",
      });
      if (result.status === "not-found") {
        return {
          content: [{ type: "text", text: `❌ ${result.message}` }],
          isError: true,
          details: result,
        };
      }
      const job = (result as any).job;
      return {
        content: [{
          type: "text",
          text: [
            "🛑 取消请求已处理。",
            "",
            job ? `- job: \`${job.id}\`` : null,
            job?.worker ? `- worker: ${job.worker}` : null,
            `- status: ${result.status}`,
            `- message: ${result.message}`,
            result.status === "aborting" ? "- 说明：正在请求底层进程中止，最终状态以 job events 为准。" : null,
          ].filter(Boolean).join("\n"),
        }],
        details: result,
      };
    },
  });

  // ═══════════════════════════════════════════════════════
  // factory_list — 查看员工
  // ═══════════════════════════════════════════════════════
  pi.registerTool({
    name: "factory_list",
    label: "查看员工",
    description: "列出所有员工及其履历。",
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "查看特定员工详情（不填则列出全部）" })),
    }),
    async execute(_tcid, params) {
      if (params.name) {
        const w = workers.get(params.name);
        if (!w) return { content: [{ type: "text", text: `员工 "${params.name}" 不存在` }], details: {} };
        return { content: [{ type: "text", text: formatWorkerProfile(w) }], details: {} };
      }
      return { content: [{ type: "text", text: listWorkers() }], details: {} };
    },
  });

  // ═══════════════════════════════════════════════════════
  // factory_promote — 晋升
  // ═══════════════════════════════════════════════════════
  pi.registerTool({
    name: "factory_promote",
    label: "晋升",
    description: "调整员工的职位/角色。",
    parameters: Type.Object({
      name: Type.String({ description: "员工姓名" }),
      newRole: Type.Optional(RoleSchema),
      model: Type.Optional(Type.String({ description: "更换模型。Codex 员工默认保留原 thread 和记忆，从下一次 turn 生效。" })),
      thinking: Type.Optional(
        StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const, {
          description: "调整思考深度。max/ultra 仅适用于 Codex 后端；ultra 还会允许 Codex 自动委派子任务。",
        }),
      ),
    }),
    async execute(_tcid, params) {
      try {
        const w = workers.get(params.name);
        if (!w) return { content: [{ type: "text", text: `❌ 员工 "${params.name}" 不存在` }], isError: true, details: {} };

        const changes: string[] = [];

        if (params.newRole && params.newRole !== w.role) {
          const oldRole = w.role;
          promote(params.name, params.newRole as WorkerRole);
          changes.push(`角色: ${oldRole} → ${w.role}`);
        }
        if (params.model) {
          const nextModel = (w.backend ?? "pi") === "codex" ? normalizeCodexModel(params.model) : params.model;
          changes.push(`模型: ${nextModel}`);
          updateWorkerConfig(w.id, { model: nextModel });
        }
        if (params.thinking !== undefined) {
          assertWorkerThinkingSupported(w.backend ?? "pi", params.thinking);
          changes.push(`思考深度: ${params.thinking}`);
          updateWorkerConfig(w.id, { thinking: params.thinking as Worker["thinking"] });
        }

        if (changes.length === 0) {
          return { content: [{ type: "text", text: `未做任何变更。` }], details: {} };
        }

        return {
          content: [{ type: "text", text: `📈 **${w.id}** 已更新: ${changes.join(", ")}` }],
          details: {},
        };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `❌ 晋升失败: ${e.message}` }],
          isError: true,
          details: {},
        };
      }
    },
  });

  // ═══════════════════════════════════════════════════════
  // factory_worker_config — 员工运行配置
  // ═══════════════════════════════════════════════════════
  pi.registerTool({
    name: "factory_worker_config",
    label: "员工配置",
    description: "调整员工运行配置（模型、思考深度、Codex sandbox / approval 等）。用于修正招募后的后端权限配置。员工可用 name 或 workerId 指定。",
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "员工姓名" })),
      workerId: Type.Optional(Type.String({ description: "员工姓名/ID；兼容旧提示里的 workerId 写法" })),
      avatar: Type.Optional(Type.String({ description: "员工头像。支持 emoji/短文本，或 http(s)/data:image 图片 URL；传空字符串可清空。" })),
      model: Type.Optional(Type.String({ description: "更换模型。Codex 员工默认保留原 thread 和记忆，从下一次 turn 生效。" })),
      thinking: Type.Optional(
        StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const, {
          description: "调整思考深度。max/ultra 仅适用于 Codex 后端；ultra 还会允许 Codex 自动委派子任务。",
        }),
      ),
      codexApprovalPolicy: Type.Optional(
        StringEnum(["untrusted", "on-failure", "on-request", "never"] as const, {
          description: "Codex 审批策略。danger-full-access 通常配 never。",
        }),
      ),
      codexSandbox: Type.Optional(
        StringEnum(["read-only", "workspace-write", "danger-full-access"] as const, {
          description: "Codex sandbox。需要完整本机文件访问时设为 danger-full-access。",
        }),
      ),
      codexServerUrl: Type.Optional(Type.String({ description: "Codex app-server WebSocket URL" })),
      resetCodexThread: Type.Optional(Type.Boolean({
        description: "重置 Codex thread。保留员工身份和工厂 job/session 留痕，清空 codexThreadId；下次任务会用当前 sandbox 新建 thread。",
        default: false,
      })),
      resetNote: Type.Optional(Type.String({ description: "resetCodexThread 的原因，会写入新 thread 的 handoff 摘要" })),
      claudeSessionId: Type.Optional(Type.String({ description: "Claude Code session id。谨慎修改；用于把员工重新指向已有 Claude session。" })),
      claudeSessionInitialized: Type.Optional(Type.Boolean({ description: "Claude session 是否已经初始化；已存在的 session 应设为 true。" })),
      claudeCwd: Type.Optional(Type.String({ description: "Claude session 绑定的工作目录；默认招募时的项目目录。" })),
      claudeCommand: Type.Optional(Type.String({ description: "Claude Code CLI 命令，默认 claude。" })),
      claudePermissionMode: Type.Optional(
        StringEnum(["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"] as const, {
          description: "Claude Code permission mode；清空需要重新招募或手动修 registry。",
        }),
      ),
      claudeTools: Type.Optional(Type.String({ description: "Claude Code --tools 参数。" })),
      claudeAllowedTools: Type.Optional(Type.String({ description: "Claude Code --allowedTools，逗号或空格分隔。" })),
      claudeDisallowedTools: Type.Optional(Type.String({ description: "Claude Code --disallowedTools，逗号或空格分隔。" })),
      claudeBare: Type.Optional(Type.Boolean({ description: "是否启用 Claude --bare。" })),
    }),
    async execute(_tcid, params) {
      try {
        const workerName = params.name || params.workerId;
        if (!workerName) return { content: [{ type: "text", text: "❌ 缺少员工姓名：请传 name 或 workerId" }], isError: true, details: {} };
        const w = workers.get(workerName);
        if (!w) return { content: [{ type: "text", text: `❌ 员工 "${workerName}" 不存在` }], isError: true, details: {} };

        const patch: Partial<Worker> = {};
        const changes: string[] = [];
        if (params.avatar !== undefined) {
          patch.avatar = String(params.avatar || "").trim() || null;
          changes.push(`头像: ${w.avatar || "—"} → ${patch.avatar || "—"}`);
        }
        if (params.model) {
          patch.model = (w.backend ?? "pi") === "codex" ? normalizeCodexModel(params.model) : params.model;
          changes.push(`模型: ${w.model || "—"} → ${patch.model}`);
        }
        if (params.thinking !== undefined) {
          assertWorkerThinkingSupported(w.backend ?? "pi", params.thinking);
          patch.thinking = params.thinking as Worker["thinking"];
          changes.push(`思考深度: ${w.thinking || "—"} → ${patch.thinking}`);
        }
        if (params.codexApprovalPolicy !== undefined) {
          if ((w.backend ?? "pi") !== "codex") throw new Error("codexApprovalPolicy 只适用于 Codex 员工");
          patch.codexApprovalPolicy = params.codexApprovalPolicy as Worker["codexApprovalPolicy"];
          changes.push(`Codex approval: ${w.codexApprovalPolicy || "—"} → ${patch.codexApprovalPolicy}`);
        }
        if (params.codexSandbox !== undefined) {
          if ((w.backend ?? "pi") !== "codex") throw new Error("codexSandbox 只适用于 Codex 员工");
          patch.codexSandbox = params.codexSandbox as Worker["codexSandbox"];
          changes.push(`Codex sandbox: ${w.codexSandbox || "—"} → ${patch.codexSandbox}`);
        }
        if (params.codexServerUrl !== undefined) {
          if ((w.backend ?? "pi") !== "codex") throw new Error("codexServerUrl 只适用于 Codex 员工");
          patch.codexServerUrl = params.codexServerUrl;
          changes.push(`Codex server: ${w.codexServerUrl || "—"} → ${patch.codexServerUrl}`);
        }
        if (params.resetCodexThread) {
          if ((w.backend ?? "pi") !== "codex") throw new Error("resetCodexThread 只适用于 Codex 员工");
          const previousThreadId = w.codexThreadId || "";
          patch.codexThreadId = null;
          patch.codexThreadHandoff = buildCodexThreadHandoff(w, previousThreadId, params.resetNote);
          w.codexActiveTurnId = null;
          changes.push(`Codex thread: ${previousThreadId || "—"} → 下次任务新建（已生成 handoff）`);
        }
        if (params.claudeSessionId !== undefined) {
          if ((w.backend ?? "pi") !== "claude") throw new Error("claudeSessionId 只适用于 Claude 员工");
          patch.claudeSessionId = params.claudeSessionId || null;
          patch.claudeSessionInitialized = Boolean(params.claudeSessionInitialized);
          changes.push(`Claude session: ${w.claudeSessionId || "—"} → ${patch.claudeSessionId || "—"}`);
        }
        if (params.claudeSessionInitialized !== undefined && params.claudeSessionId === undefined) {
          if ((w.backend ?? "pi") !== "claude") throw new Error("claudeSessionInitialized 只适用于 Claude 员工");
          patch.claudeSessionInitialized = params.claudeSessionInitialized;
          changes.push(`Claude initialized: ${w.claudeSessionInitialized ? "true" : "false"} → ${patch.claudeSessionInitialized ? "true" : "false"}`);
        }
        if (params.claudeCwd !== undefined) {
          if ((w.backend ?? "pi") !== "claude") throw new Error("claudeCwd 只适用于 Claude 员工");
          patch.claudeCwd = params.claudeCwd || null;
          changes.push(`Claude cwd: ${w.claudeCwd || "—"} → ${patch.claudeCwd || "—"}`);
        }
        if (params.claudeCommand !== undefined) {
          if ((w.backend ?? "pi") !== "claude") throw new Error("claudeCommand 只适用于 Claude 员工");
          patch.claudeCommand = params.claudeCommand || undefined;
          changes.push(`Claude command: ${w.claudeCommand || "claude"} → ${patch.claudeCommand || "claude"}`);
        }
        if (params.claudePermissionMode !== undefined) {
          if ((w.backend ?? "pi") !== "claude") throw new Error("claudePermissionMode 只适用于 Claude 员工");
          patch.claudePermissionMode = params.claudePermissionMode as Worker["claudePermissionMode"];
          changes.push(`Claude permission: ${w.claudePermissionMode || "本机默认"} → ${patch.claudePermissionMode || "本机默认"}`);
        }
        if (params.claudeTools !== undefined) {
          if ((w.backend ?? "pi") !== "claude") throw new Error("claudeTools 只适用于 Claude 员工");
          patch.claudeTools = params.claudeTools;
          changes.push(`Claude tools: ${w.claudeTools || "本机默认"} → ${patch.claudeTools || "本机默认"}`);
        }
        if (params.claudeAllowedTools !== undefined) {
          if ((w.backend ?? "pi") !== "claude") throw new Error("claudeAllowedTools 只适用于 Claude 员工");
          patch.claudeAllowedTools = params.claudeAllowedTools;
          changes.push(`Claude allowedTools: ${w.claudeAllowedTools || "—"} → ${patch.claudeAllowedTools || "—"}`);
        }
        if (params.claudeDisallowedTools !== undefined) {
          if ((w.backend ?? "pi") !== "claude") throw new Error("claudeDisallowedTools 只适用于 Claude 员工");
          patch.claudeDisallowedTools = params.claudeDisallowedTools;
          changes.push(`Claude disallowedTools: ${w.claudeDisallowedTools || "—"} → ${patch.claudeDisallowedTools || "—"}`);
        }
        if (params.claudeBare !== undefined) {
          if ((w.backend ?? "pi") !== "claude") throw new Error("claudeBare 只适用于 Claude 员工");
          patch.claudeBare = params.claudeBare;
          changes.push(`Claude bare: ${w.claudeBare ? "true" : "false"} → ${patch.claudeBare ? "true" : "false"}`);
        }

        if (changes.length === 0) {
          return { content: [{ type: "text", text: "未做任何变更。" }], details: { worker: w.id } };
        }

        updateWorkerConfig(w.id, patch);
        return {
          content: [{ type: "text", text: `🛠 **${w.id}** 运行配置已更新：\n- ${changes.join("\n- ")}` }],
          details: { worker: w.id, patch },
        };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `❌ 员工配置失败: ${e.message}` }],
          isError: true,
          details: {},
        };
      }
    },
  });

  // ═══════════════════════════════════════════════════════
  // factory_dispatch — 派活
  // ═══════════════════════════════════════════════════════
  pi.registerTool({
    name: "factory_dispatch",
    label: "派活",
    description: [
      "给员工派活。支持单人、并行（多人不同任务）、广播（多人同一任务）。",
      "会自动为每个员工准备独立的 git worktree。",
    ].join(" "),
    parameters: Type.Object({
      project: Type.String({ description: "项目名称（用于 worktree 隔离和履历记录）" }),
      assignments: Type.Array(
        Type.Object({
          worker: Type.String({ description: "员工姓名" }),
          task: Type.String({ description: "任务描述" }),
          cwd: Type.Optional(Type.String({ description: "工作目录（不填则自动创建 worktree）" })),
        }),
        { description: "任务分配列表" },
      ),
      baseBranch: Type.Optional(Type.String({ description: "worktree 基于的分支（默认 main）" })),
      background: Type.Optional(Type.Boolean({ description: "是否后台执行；默认 true。false 时等待所有员工完成后返回。", default: true })),
    }),
    async execute(_tcid, params, signal) {
      const active = getActiveWorkers();
      const invalid = params.assignments.filter((a) => !active.find((w) => w.id === a.worker));
      if (invalid.length > 0) {
        return {
          content: [
            {
              type: "text",
              text: `❌ 以下员工不存在、已离职或正在休假: ${invalid.map((a) => a.worker).join(", ")}`,
            },
          ],
          isError: true,
          details: {},
        };
      }

      if (params.background !== false) {
        const started = await mapWithConcurrencyLimit(params.assignments, 4, async (a) => {
          const w = workers.get(a.worker)!;
          w.status = "working";

          let workCwd = a.cwd;
          if (!workCwd) {
            try {
              workCwd = await createWorktree(params.project, a.worker, params.baseBranch);
            } catch (e: any) {
              setWorkerIdleIfStillWorking(w);
              return { worker: a.worker, task: a.task, error: `worktree 创建失败: ${e.message}` };
            }
          }

          const job = createJob(getWorkersDir(), {
            kind: "dispatch",
            worker: w.id,
            project: params.project,
            task: a.task,
            cwd: workCwd,
            sessionFile: w.sessionFile,
          });

          const handle = startWorkerJobQueued({ worker: w, task: a.task, project: params.project, cwd: workCwd, signal: undefined as any }, job);
          handle.promise.then((r) => {
            const success = spawnSucceeded(r);
            recordProject(w.id, params.project, a.task, success ? "success" : "failed", (r.output || r.errorMessage || r.stderr || "").slice(0, 500));
          });

          return { worker: a.worker, task: a.task, jobId: job.id, cwd: workCwd };
        });

        const lines: string[] = [`## 已后台派活: ${params.project}`, ""];
        for (const item of started) {
          if (item.error) {
            lines.push(`- ❌ **${item.worker}**: ${item.error}`);
          } else {
            lines.push(`- 🔄 **${item.worker}** job=${item.jobId}`);
            if (item.cwd) lines.push(`  cwd: ${item.cwd}`);
          }
        }
        lines.push("");
        lines.push("用 `factory_jobs` 查看后台任务列表，用 `factory_attach` 查看某个 job 的实时记录。");

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { jobs: started },
        };
      }

      // 并发执行
      const results = await mapWithConcurrencyLimit(params.assignments, 4, async (a, i) => {
        const w = workers.get(a.worker)!;
        w.status = "working";

        // 准备 worktree
        let workCwd = a.cwd;
        if (!workCwd) {
          try {
            workCwd = await createWorktree(params.project, a.worker, params.baseBranch);
          } catch (e: any) {
            setWorkerIdleIfStillWorking(w);
            return { worker: a.worker, task: a.task, result: null, error: `worktree 创建失败: ${e.message}` };
          }
        }

        try {
          const r = await spawnWorker({
            worker: w,
            task: a.task,
            project: params.project,
            cwd: workCwd,
            signal,
          });

          const success = spawnSucceeded(r);
          recordProject(w.id, params.project, a.task, success ? "success" : "failed", r.output.slice(0, 500));
          setWorkerIdleIfStillWorking(w);

          return { worker: a.worker, task: a.task, result: r, error: null, cwd: workCwd };
        } catch (e: any) {
          setWorkerIdleIfStillWorking(w);
          return { worker: a.worker, task: a.task, result: null, error: e.message };
        }
      });

      // 汇总
      const successCount = results.filter((r) => r.result && !r.error && spawnSucceeded(r.result)).length;
      const lines: string[] = [];
      lines.push(`## 派活结果: ${params.project}`);
      lines.push(`${successCount}/${results.length} 成功\n`);

      for (const r of results) {
        lines.push(`### ${r.worker}`);
        if (r.error) {
          lines.push(`❌ ${r.error}`);
        } else if (r.result) {
          lines.push(summarizeSpawn(r.result));
        }
        lines.push("");
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { results },
      };
    },
  });

  // ═══════════════════════════════════════════════════════
  // factory_race — 赛马
  // ═══════════════════════════════════════════════════════
  pi.registerTool({
    name: "factory_race",
    label: "赛马",
    description: [
      "赛马模式：多个员工独立完成同一任务，由评委选出最优方案。",
      "适合高难度或关键任务，用竞争保证质量。",
      "会自动为每位选手创建独立 git worktree。",
    ].join(" "),
    parameters: Type.Object({
      project: Type.String({ description: "项目名称" }),
      task: Type.String({ description: "任务描述（所有选手做同一任务）" }),
      candidates: Type.Array(Type.String(), { description: "参赛员工姓名列表" }),
      judge: Type.Optional(Type.String({ description: "评委姓名（必须是现有员工），默认用 judge 角色员工或自动找" })),
      baseBranch: Type.Optional(Type.String({ description: "worktree 基于的分支" })),
    }),
    async execute(_tcid, params, signal) {
      const active = getActiveWorkers();
      const invalid = params.candidates.filter((c) => !active.find((w) => w.id === c));
      if (invalid.length > 0) {
        return {
          content: [
            { type: "text", text: `❌ 以下选手不存在、已离职或正在休假: ${invalid.join(", ")}` },
          ],
          isError: true,
          details: {},
        };
      }

      if (params.candidates.length < 2) {
        return {
          content: [{ type: "text", text: "❌ 赛马至少需要 2 名选手。" }],
          isError: true,
          details: {},
        };
      }

      // Phase 1: 所有选手并发执行
      const raceId = `race-${Date.now().toString(36)}`;
      const candidateResults: { worker: string; result: string; success: boolean }[] = [];

      await mapWithConcurrencyLimit(params.candidates, 4, async (workerId) => {
        const w = workers.get(workerId)!;
        w.status = "working";

        let workCwd: string;
        try {
          workCwd = await createWorktree(params.project, workerId, params.baseBranch);
        } catch (e: any) {
          candidateResults.push({ worker: workerId, result: `worktree 创建失败: ${e.message}`, success: false });
          setWorkerIdleIfStillWorking(w);
          return;
        }

        try {
          const r = await spawnWorker({
            worker: w,
            task: params.task,
            project: params.project,
            cwd: workCwd,
            signal,
          });

          const success = r.exitCode === 0 && !["error", "aborted"].includes(r.stopReason ?? "");
          candidateResults.push({
            worker: workerId,
            result: success ? r.output : `失败: ${r.errorMessage || r.stderr || "未知错误"}`,
            success,
          });

          recordProject(w.id, params.project, params.task, success ? "success" : "failed", r.output.slice(0, 500));
        } catch (e: any) {
          candidateResults.push({ worker: workerId, result: `执行错误: ${e.message}`, success: false });
        }
        setWorkerIdleIfStillWorking(w);
      });

      // Phase 2: 找评委
      let judgeWorker: Worker | undefined;
      if (params.judge) {
        judgeWorker = workers.get(params.judge);
      } else {
        judgeWorker = active.find((w) => w.role === "judge") ?? active.find((w) => w.role === "foreman");
      }

      if (!judgeWorker) {
        // 没有评委，直接列结果
        const lines: string[] = ["## 🏇 赛马结果（无评委，并列展示）\n"];
        for (const cr of candidateResults) {
          lines.push(`### ${cr.worker} ${cr.success ? "✅" : "❌"}`);
          lines.push(cr.result.slice(0, 2000));
          lines.push("");
        }
        return { content: [{ type: "text", text: lines.join("\n") }], details: { raceId, candidateResults } };
      }

      // 评委评估
      const judgeTask = [
        `## 赛马评审`,
        ``,
        `项目: ${params.project}`,
        `任务: ${params.task}`,
        ``,
        `以下是 ${params.candidates.length} 名选手的方案，请评估并选出最优：`,
        ``,
        ...candidateResults.map((cr, i) => [
          `### 选手 ${i + 1}: ${cr.worker}`,
          `\`\`\``,
          cr.result.slice(0, 5000),
          `\`\`\``,
          ``,
        ].join("\n")),
      ].join("\n");

      const judgeResult = await spawnWorker({
        worker: judgeWorker,
        task: judgeTask,
        project: params.project,
        signal,
      });

      // 记录赛马
      recordRace({
        raceId,
        task: params.task,
        candidates: params.candidates,
        winner: judgeResult.output.slice(0, 200),
        judgeNotes: judgeResult.output,
        date: new Date().toISOString().slice(0, 10),
      });

      const lines: string[] = [
        `## 🏇 赛马结果: ${params.project}`,
        ``,
        `**评委**: ${judgeWorker.id}`,
        ``,
        `---`,
        ``,
        judgeResult.output.slice(0, 8000),
        ``,
        `---`,
        ``,
        `### 选手原始方案摘要`,
      ];
      for (const cr of candidateResults) {
        lines.push(`**${cr.worker}** ${cr.success ? "✅" : "❌"}`);
        lines.push(cr.result.slice(0, 1000));
        lines.push("");
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { raceId, candidateResults, judgeOutput: judgeResult.output },
      };
    },
  });

  // ═══════════════════════════════════════════════════════
  // factory_recommend — 推荐人选
  // ═══════════════════════════════════════════════════════
  pi.registerTool({
    name: "factory_recommend",
    label: "推荐人选",
    description: "根据任务描述，从现有员工中推荐最合适的人选。",
    parameters: Type.Object({
      task: Type.String({ description: "任务描述" }),
      count: Type.Optional(Type.Number({ description: "推荐人数（默认 3）", default: 3 })),
      useForeman: Type.Optional(
        Type.Boolean({ description: "是否请工头来推荐（更智能），默认 true", default: true }),
      ),
    }),
    async execute(_tcid, params, signal) {
      const active = getActiveWorkers();
      if (active.length === 0) {
        return { content: [{ type: "text", text: "工厂还没有在职员工。先招人吧。" }], details: {} };
      }

      // 准备履历摘要
      const profiles = active.map((w) => formatWorkerProfile(w)).join("\n\n---\n\n");

      if (params.useForeman) {
        const foreman = active.find((w) => w.role === "foreman");
        if (foreman) {
          const task = [
            `## 推荐任务`,
            ``,
            `请根据以下任务描述，从现有员工中推荐 ${params.count ?? 3} 位最合适的人选。`,
            `考虑他们的角色、项目经验、技能匹配度。`,
            ``,
            `### 待办任务`,
            params.task,
            ``,
            `### 现有员工履历`,
            profiles,
          ].join("\n");

          const r = await spawnWorker({
            worker: foreman,
            task,
            project: "hr-recommend",
            signal,
          });

          return {
            content: [{ type: "text", text: `## 🎯 工头 ${foreman.id} 的推荐\n\n${r.output.slice(0, 5000)}` }],
            details: {},
          };
        }
      }

      // 无工头：直接靠履历匹配
      const lines: string[] = [
        `## 📋 现有员工（无工头，请自行判断）\n`,
        `任务: ${params.task}\n`,
        profiles,
      ];
      return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
    },
  });

  // ═══════════════════════════════════════════════════════
  // factory_transfer — 记忆迁移
  // ═══════════════════════════════════════════════════════
  pi.registerTool({
    name: "factory_transfer",
    label: "记忆迁移",
    description: [
      "将员工 A 的记忆（session 历史）迁移给员工 B。",
      "B 可以接着 A 的工作继续干，无需重新理解上下文。",
      "实际实现：将 A 的 session 文件中前面的内容写入 B 的 session 文件头部。",
    ].join(" "),
    parameters: Type.Object({
      from: Type.String({ description: "源员工姓名" }),
      to: Type.String({ description: "目标员工姓名" }),
      summary: Type.Optional(
        Type.String({ description: "迁移摘要（告诉 B 这是谁的活、做到了哪一步）" }),
      ),
    }),
    async execute(_tcid, params) {
      const from = workers.get(params.from);
      const to = workers.get(params.to);

      if (!from) return { content: [{ type: "text", text: `❌ 员工 "${params.from}" 不存在` }], isError: true, details: {} };
      if (!to) return { content: [{ type: "text", text: `❌ 员工 "${params.to}" 不存在` }], isError: true, details: {} };

      // 读取 A 的 session 文件内容
      let historyContent = "";
      try {
        const fs = await import("node:fs");
        if (fs.existsSync(from.sessionFile)) {
          historyContent = fs.readFileSync(from.sessionFile, "utf-8").slice(0, 50000);
        }
      } catch {}

      const summary = params.summary ?? `${from.id} 之前的工作记录`;

      return {
        content: [
          {
            type: "text",
            text: [
              `📦 **记忆迁移**: ${from.id} → ${to.id}`,
              ``,
              `**摘要**: ${summary}`,
              ``,
              `**${from.id} 的履历**:`,
              `- 角色: ${from.role}`,
              `- 参与项目: ${from.projects.length} 个`,
              ...from.projects.map((p) => `  - ${p.project}: ${p.summary.slice(0, 60)}`),
              ``,
              `**${to.id} 现在可以接着干**。派活时在任务描述里引用以上信息即可。`,
            ].join("\n"),
          },
        ],
        details: { from: from.id, to: to.id, historyLength: historyContent.length },
      };
    },
  });

  pi.registerCommand("ox-web", {
    description: "启动/打开牛马工厂本地 Web 大盘。用法: /ox-web [端口] [--no-open] [--status]",
    handler: async (args, ctx) => {
      const options = parseOxWebArgs(args || "");
      const url = `http://127.0.0.1:${options.port}`;
      try {
        if (options.statusOnly) {
          const health = await checkOxWebDashboard(url);
          const content = [
            "## 牛马工厂 Web 大盘",
            "",
            `- URL: ${url}`,
            `- 状态: ${health.healthy ? "running" : health.baseHealthy ? `stale / ${health.detail}` : "stopped / not ox-factory"}`,
            `- 端口: ${options.port}`,
          ].join("\n");
          pi.sendMessage({ customType: "ox-web", content, display: true }, { deliverAs: "nextTurn", triggerTurn: false });
          return;
        }

        ctx?.ui?.notify?.(`正在准备牛马工厂 Web 大盘：${url}`, "info");
        const result = await ensureOxWebDashboard(options.port);
        let openStatus = "未打开浏览器（--no-open）";
        if (options.open) {
          openExternalUrl(result.url);
          openStatus = "已请求系统浏览器打开";
        }
        const content = [
          "## 牛马工厂 Web 大盘",
          "",
          `- URL: ${result.url}`,
          `- 服务状态: ${result.status === "running" ? "已在运行，直接复用" : result.status === "restarted" ? "检测到旧版服务并已自动重启" : result.status === "started" ? "刚刚启动并通过 health check" : "已尝试启动，仍在等待健康检查"}`,
          `- 浏览器: ${openStatus}`,
          `- 日志: \`${result.logPath}\``,
          "",
          result.status === "starting"
            ? "如果页面没有马上打开，请稍等几秒刷新；若仍失败，查看日志文件。"
            : "如果页面数据没更新，可以在页面内刷新或重新执行 `/ox-web`。",
        ].join("\n");
        pi.sendMessage({ customType: "ox-web", content, display: true }, { deliverAs: "nextTurn", triggerTurn: false });
      } catch (e: any) {
        const content = [
          "## 牛马工厂 Web 大盘启动失败",
          "",
          `- URL: ${url}`,
          `- 错误: ${e?.message || String(e)}`,
          "",
          "可以手动执行：",
          "",
          "```bash",
          `node .pi/extensions/ox-factory/web-server.mjs --workers-dir .pi/workers --port ${options.port}`,
          "```",
        ].join("\n");
        pi.sendMessage({ customType: "ox-web-error", content, display: true }, { deliverAs: "nextTurn", triggerTurn: false });
      }
    },
  });

  // ═══════════════════════════════════════════════════════
  // /talk 命令 — 进入/退出对话模式
  // ═══════════════════════════════════════════════════════
  const talkLiveBuffers = new Map<string, { workerId: string; lines: string[]; timer: any }>();
  let deferredTalkNoticeShown = false;
  const deferredTalkMessages: Array<{ workerId: string; message: any }> = [];

  function flushDeferredTalkMessages() {
    if (mainAgentActive || deferredTalkMessages.length === 0) return;
    const pending = deferredTalkMessages.splice(0);
    deferredTalkNoticeShown = false;
    for (const item of pending) {
      if (talkTarget !== item.workerId) continue;
      pi.sendMessage(item.message);
    }
  }

  function shouldPersistTalkLiveMessages(): boolean {
    return process.env.OX_FACTORY_TALK_LIVE_MESSAGES === "1";
  }

  function compactTalkPanelContent(content: string, maxChars = 3500): string {
    return truncateText(content, maxChars);
  }

  function sendTalkMessage(workerId: string, message: any, ctx?: any) {
    if (talkTarget !== workerId) return;
    if (mainAgentActive) {
      deferredTalkMessages.push({ workerId, message });
      if (!deferredTalkNoticeShown) {
        deferredTalkNoticeShown = true;
        ctx?.ui?.notify?.("秘书正在回复，员工输出会在本轮结束后显示", "info");
      }
      return;
    }
    pi.sendMessage(message);
  }

  pi.on("agent_start", () => {
    mainAgentActive = true;
  });

  pi.on("agent_end", () => {
    mainAgentActive = false;
    setTimeout(flushDeferredTalkMessages, 0);
  });

  function recentWorkerJobs(workerId: string, limit = 100): any[] {
    return listJobs(getWorkersDir(), { worker: workerId, limit }).sort((a: any, b: any) => {
      const aTime = String(a.updatedAt || a.createdAt || "");
      const bTime = String(b.updatedAt || b.createdAt || "");
      return bTime.localeCompare(aTime);
    });
  }

  function openWorkerJobs(workerId: string): any[] {
    const statusRank: Record<string, number> = { running: 0, queued: 1 };
    return recentWorkerJobs(workerId, 200)
      .filter((job: any) => !isTerminalJob(job))
      .sort((a: any, b: any) => {
        const rankDiff = (statusRank[a.status] ?? 9) - (statusRank[b.status] ?? 9);
        if (rankDiff !== 0) return rankDiff;
        const aPos = a.queuePosition ?? Number.MAX_SAFE_INTEGER;
        const bPos = b.queuePosition ?? Number.MAX_SAFE_INTEGER;
        if (aPos !== bPos) return aPos - bPos;
        return String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
      });
  }

  function latestWorkerJob(workerId: string): any | undefined {
    const open = openWorkerJobs(workerId);
    if (open.length > 0) return open[0];
    return recentWorkerJobs(workerId, 50)[0];
  }

  function formatWorkerQueue(workerId: string, currentJobId?: string): string {
    const open = openWorkerJobs(workerId).filter((job: any) => job.id !== currentJobId);
    if (open.length === 0) return "";
    const lines = ["", "### 当前未完成消息"];
    for (const job of open.slice(0, 8)) {
      const mode = job.deliveryMode ? ` | ${job.deliveryMode}` : "";
      const task = String(job.task || "").replace(/\s+/g, " ").slice(0, 160);
      lines.push(`- ${job.id} | ${job.status}${mode} | ${task}`);
    }
    return lines.join("\n");
  }

  function sendTalkSnapshot(workerId: string) {
    const job = latestWorkerJob(workerId);
    if (!job) {
      sendTalkMessage(workerId, {
        customType: "ox-talk-attached",
        content: `💬 已接入 **${workerId}**。\n\n暂无历史 job。直接发消息即可；用 \`/talk off\` 切回秘书。`,
        display: true,
        details: { worker: workerId },
      });
      return;
    }

    if (!isTerminalJob(job)) activeTalkJobId = job.id;
    const statusText = isTerminalJob(job) ? "最近记录" : "正在执行，已自动接回";
    const queueText = formatWorkerQueue(workerId, job.id);
    const details = compactTalkPanelContent(formatJobDetails(job, tailJobEvents(job, 20)), 3500);
    sendTalkMessage(workerId, {
      customType: "ox-talk-attached",
      content: `💬 已接入 **${workerId}**（${statusText}）。\n\n${details}${queueText}`,
      display: true,
      details: { worker: workerId, jobId: job.id },
    });
  }

  function formatTalkLiveEvent(event: StreamEvent): string {
    if (event.type === "text") return event.text || "";
    if (event.type === "thinking") return "";
    if (event.type === "tool_start" || event.type === "tool_output" || event.type === "tool_end" || event.type === "error") {
      return `\n${formatJobEvent(event)}\n`;
    }
    if (event.type === "done") return `\n${formatJobEvent(event)}\n`;
    return "";
  }

  function flushTalkLive(jobId: string) {
    const state = talkLiveBuffers.get(jobId);
    if (!state) return;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    const text = state.lines.join("");
    state.lines = [];
    if (!text.trim() || talkTarget !== state.workerId) return;
    if (!shouldPersistTalkLiveMessages()) return;

    sendTalkMessage(state.workerId, {
      customType: "ox-talk-live",
      content: `💬 **${state.workerId}** · \`${jobId}\`\n\n${text}`,
      display: true,
      details: { worker: state.workerId, jobId },
    });
  }

  function queueTalkLive(workerId: string, job: any, event: StreamEvent) {
    if (talkTarget !== workerId) return;
    const text = formatTalkLiveEvent(event);
    if (!text) return;

    let state = talkLiveBuffers.get(job.id);
    if (!state) {
      state = { workerId, lines: [], timer: null };
      talkLiveBuffers.set(job.id, state);
    }
    state.lines.push(text);

    if (event.type === "tool_start" || event.type === "tool_output" || event.type === "tool_end" || event.type === "error" || event.type === "done") {
      flushTalkLive(job.id);
      return;
    }
    if (!state.timer) {
      state.timer = setTimeout(() => flushTalkLive(job.id), 1200);
    }
  }

  type TalkDeliveryMode = "message" | "queue" | "steer";

  function parseTalkDirective(raw: string): { mode?: TalkDeliveryMode; text: string } {
    const text = String(raw || "");
    const trimmed = text.trim();
    const match = trimmed.match(/^(queue|steer)\s*[:：]\s*([\s\S]+)$/i);
    if (!match) return { text };
    const mode = match[1].toLowerCase() as TalkDeliveryMode;
    return { mode, text: match[2].trim() };
  }

  type WorkerCommandMode = "auto" | "queue" | "steer" | "now";

  function enqueueWorkerCommand({
    worker,
    task,
    project = "talk",
    cwd = process.cwd(),
    mode = "auto",
    kind = "command",
    sourceMessageId,
    sourceTaskRequestId,
    assignedBy,
    returnTo,
    source,
    displayChannel,
  }: {
    worker: Worker;
    task: string;
    project?: string;
    cwd?: string;
    mode?: WorkerCommandMode;
    kind?: string;
    sourceMessageId?: string;
    sourceTaskRequestId?: string;
    assignedBy?: string;
    returnTo?: string;
    source?: string;
    displayChannel?: string;
  }): { job: any; deliveryMode: TalkDeliveryMode; placement: string } {
    worker = recoverWorkerFromRegistrySnapshot(worker.id) || worker;
    const availability = workerCanAcceptWork(worker, worker.id);
    if (!availability.ok) throw new Error(availability.reason);
    const openBefore = openWorkerJobs(worker.id);
    const busy = openBefore.length > 0;
    if (mode === "now" && busy) {
      throw new Error(`${worker.id} 当前有未完成 job，不能 now 执行；请改用 queue 或 steer`);
    }
    const runningJob = openBefore.find((candidate: any) => candidate.status === "running") ?? openBefore[0];
    const deliveryMode: TalkDeliveryMode =
      mode === "steer" ? "steer" :
      mode === "queue" ? "queue" :
      busy ? "queue" : "message";
    const steerInline = deliveryMode === "steer" && canSteerActiveCodexTurn(worker);

    const job = createJob(getWorkersDir(), {
      kind,
      worker: worker.id,
      project,
      task,
      cwd,
      sessionFile: worker.sessionFile,
    });
    updateJob(job, {
      deliveryMode,
      queuePosition: busy ? (steerInline ? 1 : deliveryMode === "steer" ? 2 : openBefore.length + 1) : 1,
      queuedBehind: busy ? (deliveryMode === "steer" ? runningJob?.id : openBefore[openBefore.length - 1]?.id) : undefined,
      sourceMessageId,
      sourceTaskRequestId,
      assignedBy,
      returnTo,
      source,
      displayChannel,
    });
    appendJobEvent(job, {
      type: "delivery",
      text: steerInline ? `codex steer injected into active turn ${worker.codexActiveTurnId}` : busy ? `${deliveryMode} queued behind ${job.queuedBehind || "current job"}` : `${deliveryMode} starts immediately`,
    });
    if (sourceMessageId) {
      appendJobEvent(job, { type: "message_wake", messageId: sourceMessageId, text: `wake from message ${sourceMessageId}` });
    }
    if (sourceTaskRequestId || assignedBy) {
      appendJobEvent(job, {
        type: "assigned_task",
        taskRequestId: sourceTaskRequestId,
        assignedBy,
        returnTo,
        text: `assigned by ${assignedBy || "unknown"}${sourceTaskRequestId ? ` via ${sourceTaskRequestId}` : ""}`,
      });
    }
    if (deliveryMode === "steer" && runningJob) {
      appendJobEvent(runningJob, { type: "steer", text: task, queuedJobId: job.id, sourceMessageId });
    }

    worker.status = "working";
    const handle = startWorkerJobQueued(
      { worker, task, project, cwd, signal: undefined as any, deliveryMode },
      job,
    );
    handle.promise
      .then((result) => {
        const success = spawnSucceeded(result);
        recordProject(
          worker.id,
          project,
          task,
          success ? "success" : "failed",
          (result.output || result.errorMessage || result.stderr || "").slice(0, 500),
        );
        if (sourceTaskRequestId && (returnTo || assignedBy)) {
          const summary = (result.output || result.errorMessage || result.stderr || "").trim();
          const content = [
            success ? "✅ 派活任务已完成" : "❌ 派活任务执行失败",
            "",
            `- task request: \`${sourceTaskRequestId}\``,
            `- job: \`${job.id}\``,
            `- 执行员工: ${worker.id}`,
            `- 派活来源: ${assignedBy || returnTo}`,
            `- project: ${project}`,
            "",
            "结果摘要：",
            summary.slice(0, 2000) || (success ? "任务完成，但没有文本输出。" : "任务失败，未提供错误文本。"),
            summary.length > 2000 ? `\n...(截断，共 ${summary.length} 字符；完整输出请查看 job events)` : "",
          ].join("\n");
          try {
            const message = sendTaskResultMessage(getWorkersDir(), {
              from: worker.id,
              to: returnTo || assignedBy,
              content,
              jobId: job.id,
              taskRequestId: sourceTaskRequestId,
              resultStatus: success ? "done" : "failed",
            });
            reportWorkerTaskResult(getWorkersDir(), {
              requestId: sourceTaskRequestId,
              jobId: job.id,
              messageId: message.id,
              resultStatus: success ? "done" : "failed",
              summary: summary.slice(0, 500),
            });
            appendJobEvent(job, {
              type: "task_result_message",
              messageId: message.id,
              to: returnTo || assignedBy,
              text: `task result returned to ${returnTo || assignedBy}`,
            });
          } catch (error: any) {
            appendJobEvent(job, {
              type: "task_result_message_failed",
              message: error?.message || String(error),
            });
          }
        }
      })
      .catch(() => {
        /* job failure is already persisted by startWorkerJob */
      });

    const placement = !busy
      ? "马上开始"
      : steerInline
        ? "Codex 后端：已插入当前 active turn"
      : deliveryMode === "steer"
        ? `steer 已记录，会排在当前运行 job 后面`
        : `已排队，前面还有 ${openBefore.length} 个未完成 job`;
    return { job, deliveryMode, placement };
  }

  function startTalkMessage(
    w: Worker,
    msg: string,
    ctx?: any,
    requestedMode?: TalkDeliveryMode,
    options: { attach?: boolean; notify?: boolean } = {},
  ) {
    w = recoverWorkerFromRegistrySnapshot(w.id) || w;
    const availability = workerCanAcceptWork(w, w.id);
    if (!availability.ok) {
      ctx?.ui?.notify?.(availability.reason!, "error");
      return null;
    }
    const openBefore = openWorkerJobs(w.id);
    const busy = openBefore.length > 0;
    const deliveryMode: TalkDeliveryMode = requestedMode ?? (busy ? "queue" : "message");
    const runningJob = openBefore.find((candidate: any) => candidate.status === "running") ?? openBefore[0];
    const steerInline = deliveryMode === "steer" && canSteerActiveCodexTurn(w);

    const job = createJob(getWorkersDir(), {
      kind: "talk",
      worker: w.id,
      project: "talk",
      task: msg,
      cwd: process.cwd(),
      sessionFile: w.sessionFile,
    });
    updateJob(job, {
      deliveryMode,
      queuePosition: busy ? (steerInline ? 1 : deliveryMode === "steer" ? 2 : openBefore.length + 1) : 1,
      queuedBehind: busy ? (deliveryMode === "steer" ? runningJob?.id : openBefore[openBefore.length - 1]?.id) : undefined,
    });
    appendJobEvent(job, {
      type: "delivery",
      text: steerInline ? `codex steer injected into active turn ${w.codexActiveTurnId}` : busy ? `${deliveryMode} queued behind ${job.queuedBehind || "current job"}` : `${deliveryMode} starts immediately`,
    });
    if (deliveryMode === "steer" && runningJob) {
      appendJobEvent(runningJob, { type: "steer", text: msg, queuedJobId: job.id });
    }

    const attachToCurrentTalk = options.attach !== false;
    const notifyConsole = options.notify !== false;
    if (attachToCurrentTalk) activeTalkJobId = runningJob?.status === "running" ? runningJob.id : job.id;
    w.status = "working";
    const placement = !busy
      ? "马上开始"
      : steerInline
        ? "Codex 后端：已插入当前 active turn"
      : deliveryMode === "steer"
        ? `steer 已记录，会排在当前运行 job 后面`
        : `已排队，前面还有 ${openBefore.length} 个未完成 job`;
    if (notifyConsole) ctx?.ui?.notify?.(`${w.id}: ${placement}，job ${job.id}`, "info");

    sendTalkMessage(w.id, {
      customType: "ox-talk-started",
      content: [
        `💬 **${w.id}** 已收到。`,
        ``,
        `job: \`${job.id}\``,
        `mode: ${deliveryMode}`,
        busy ? `placement: ${placement}` : `placement: 马上开始`,
        ``,
        `实时输出会写入 job events；用 \`/attach ${job.id}\`、\`/watch ${job.id}\` 或 Web 查看。用 \`/talk off\` 切回秘书，job 在当前 Pi 进程内继续执行。`,
        formatWorkerQueue(w.id, attachToCurrentTalk ? activeTalkJobId || undefined : job.id),
      ].filter(Boolean).join("\n"),
      display: true,
      details: { worker: w.id, jobId: job.id, deliveryMode },
    }, ctx);

    try {
      const handle = startWorkerJobQueued(
        { worker: w, task: msg, project: "talk", signal: undefined as any, deliveryMode },
        job,
        (ev) => {
          queueTalkLive(w.id, job, ev);
          if (!notifyConsole) {
            return;
          }
          if (ev.type === "tool_start") {
            ctx?.ui?.notify?.(`${w.id}: ${ev.name}`, "info");
          } else if (ev.type === "error") {
            ctx?.ui?.notify?.(`${w.id} 出错: ${ev.message}`, "error");
          }
        },
      );

      handle.promise.finally(() => {
        flushTalkLive(job.id);
        const finished = readJob(job.jobFile);
        if (activeTalkJobId === job.id && isTerminalJob(finished)) activeTalkJobId = null;
        if (talkTarget === w.id) {
          const queueText = formatWorkerQueue(w.id, finished.id);
          const details = compactTalkPanelContent(formatJobDetails(finished, tailJobEvents(finished, 20)), 3500);
          sendTalkMessage(w.id, {
            customType: "ox-talk-finished",
            content: `${details}${queueText}`,
            display: true,
            details: { worker: w.id, jobId: job.id },
          }, ctx);
        } else if (notifyConsole && isTerminalJob(finished)) {
          ctx?.ui?.notify?.(`${w.id} 后台 job ${job.id} 已${finished.status === "done" ? "完成" : "结束"}`, finished.status === "done" ? "info" : "error");
        }
      });
    } catch (e: any) {
      sendTalkMessage(w.id, {
        customType: "ox-talk-error",
        content: `❌ 与 ${w.id} 对话失败: ${e.message}`,
        display: true,
      }, ctx);
    }

    return job;
  }

  function attachPickedJobToTalk(picked: any, content: string, ctx?: any): boolean {
    const workerId = String(picked?.job?.worker || "").trim();
    if (!workerId) {
      pi.sendMessage({
        customType: "ox-pick",
        content: `${content}\n\n⚠️ 这个 job 没有 worker 字段，已展示结果但无法切换 talk。`,
        display: true,
      });
      return false;
    }

    const w = recoverWorkerFromRegistrySnapshot(workerId);
    const availability = workerCanAcceptWork(w, workerId);
    if (!availability.ok) {
      const reason = availability.reason || "员工当前不可接入";
      ctx?.ui?.notify?.(`pick 到 ${workerId}，但不能切换 talk：${reason}`, "error");
      pi.sendMessage({
        customType: "ox-pick",
        content: `${content}\n\n⚠️ 已展示结果，但没有切换 talk：${reason}`,
        display: true,
        details: { worker: workerId, jobId: picked?.job?.id },
      });
      return false;
    }

    talkTarget = workerId;
    activeTalkJobId = isTerminalJob(picked.job) ? null : picked.job.id;
    ctx?.ui?.notify?.(`🎯 已 pick ${workerId}，并切换到 ${workerId} 的 talk。`, "info");
    const message = {
      customType: "ox-talk-attached",
      content: [
        `🎯 已 pick 并接入 **${workerId}**。`,
        "",
        content,
        "",
        `现在直接输入内容即可继续和 ${workerId} 对话；用 \`/talk off\` 切回秘书。`,
      ].join("\n"),
      display: true,
      details: { worker: workerId, jobId: picked.job.id, source: "pick" },
    };
    if (mainAgentActive) pi.sendMessage(message);
    else sendTalkMessage(workerId, message, ctx);
    return true;
  }

  pi.registerCommand("talk", {
    description: "与员工持续对话。用法: /talk 员工名 [消息] 或 /talk off 退出",
    handler: async (args, ctx) => {
      const parts = (args || "").trim().split(/\s+/);
      const name = parts[0];
      const message = parts.slice(1).join(" ");

      if (!name || name === "off") {
        if (talkTarget) {
          const suffix = activeTalkJobId ? `；${activeTalkJobId} 继续后台执行` : "";
          ctx.ui.notify(`退出与 ${talkTarget} 的对话${suffix}`, "info");
          talkTarget = null;
          activeTalkJobId = null;
        }
        else { ctx.ui.notify("当前没有在对话", "info"); }
        return;
      }

      const w = recoverWorkerFromRegistrySnapshot(name);
      const availability = workerCanAcceptWork(w, name);
      if (!availability.ok) { ctx.ui.notify(availability.reason!, "error"); return; }

      if (!message) {
        talkTarget = name;
        ctx.ui.notify(`🔗 正在与 **${name}** 对话。直接发消息即可，/talk off 退出。`, "info");
        sendTalkSnapshot(name);
        return;
      }

      talkTarget = name;
      startTalkMessage(w, message, ctx);
    },
  });

  function currentTalkWorker(ctx: any): Worker | null {
    if (!talkTarget) {
      ctx.ui.notify("当前没有接入员工。先用 /talk 员工名。", "error");
      return null;
    }
    const w = recoverWorkerFromRegistrySnapshot(talkTarget);
    const availability = workerCanAcceptWork(w, talkTarget);
    if (!availability.ok) {
      ctx.ui.notify(availability.reason!, "error");
      talkTarget = null;
      return null;
    }
    return w;
  }

  pi.registerCommand("queue", {
    description: "在当前 talk 员工队尾追加消息。用法: /queue <消息>",
    handler: async (args, ctx) => {
      const msg = (args || "").trim();
      if (!msg) {
        ctx.ui.notify("用法: /queue <消息>", "error");
        return;
      }
      const w = currentTalkWorker(ctx);
      if (!w) return;
      startTalkMessage(w, msg, ctx, "queue");
    },
  });

  pi.registerCommand("steer", {
    description: "给当前 talk 员工追加补充。Codex 后端会插入当前 turn；Pi 后端会排在当前 job 后优先执行。用法: /steer <消息>",
    handler: async (args, ctx) => {
      const msg = (args || "").trim();
      if (!msg) {
        ctx.ui.notify("用法: /steer <消息>", "error");
        return;
      }
      const w = currentTalkWorker(ctx);
      if (!w) return;
      startTalkMessage(w, msg, ctx, "steer");
    },
  });

  pi.registerCommand("cancel", {
    description: "取消后台员工 job。用法: /cancel [jobId前缀]；不填时取消当前 talk 员工最新未完成 job",
    handler: async (args) => {
      const jobId = (args || "").trim() || activeTalkJobId || undefined;
      const result = cancelWorkerJob({
        jobId,
        worker: jobId ? undefined : talkTarget || undefined,
        actor: "/cancel",
        reason: "用户通过 /cancel 取消",
      });
      const job = (result as any).job;
      const content = [
        result.status === "not-found" ? "❌ 没有找到可取消的 job。" : "🛑 取消请求已处理。",
        "",
        job ? `- job: \`${job.id}\`` : null,
        job?.worker ? `- worker: ${job.worker}` : null,
        `- status: ${result.status}`,
        `- message: ${result.message}`,
      ].filter(Boolean).join("\n");
      pi.sendMessage({ customType: "ox-cancel", content, display: true }, { deliverAs: "nextTurn", triggerTurn: false });
    },
  });

  pi.registerCommand("jobs", {
    description: "查看后台员工任务。用法: /jobs [员工名]",
    handler: async (args) => {
      const worker = (args || "").trim() || undefined;
      const jobs = listJobs(getWorkersDir(), { worker, limit: 12 }).reverse();
      const content = jobs.length === 0
        ? "暂无后台 job。"
        : ["## 后台 Jobs", "", ...jobs.map((job: any) => `- ${formatJobLine(job)}`)].join("\n");
      pi.sendMessage({ customType: "ox-jobs", content, display: true }, { deliverAs: "nextTurn", triggerTurn: false });
    },
  });

  pi.registerCommand("pick", {
    description: "随机查看一个未读员工成果。用法: /pick [员工名] [--peek] [--latest]",
    handler: async (args, ctx) => {
      const pickArgs = parsePickCommandArgs(args);
      const picked = pickUnreadJob(getWorkersDir(), {
        worker: pickArgs.worker,
        limit: 500,
        mode: pickArgs.mode,
        markRead: pickArgs.markRead,
        readBy: pickArgs.peek ? "/pick --peek" : "/pick",
      });
      const content = picked
        ? formatPickedJob(picked)
        : pickArgs.worker
          ? `暂无 ${pickArgs.worker} 的未读 job。`
          : "暂无未读 job。";
      if (picked && !pickArgs.peek) {
        attachPickedJobToTalk(picked, content, ctx);
        return;
      }
      pi.sendMessage({ customType: "ox-pick", content, display: true });
    },
  });

  pi.registerCommand("report", {
    description: "查看日报上下文。用法: /report [YYYY-MM-DD]",
    handler: async (args) => {
      const date = (args || "").trim() || undefined;
      try {
        const context = buildFactoryReportContext({
          workersDir: getWorkersDir(),
          date,
          workers: getActiveWorkers(),
          sessionEntries: mainSessionEntries,
          includeSessions: true,
        });
        pi.sendMessage(
          { customType: "ox-report-context", content: formatFactoryReportContext(context), display: true },
          { deliverAs: "nextTurn", triggerTurn: false },
        );
      } catch (e: any) {
        pi.sendMessage(
          { customType: "ox-report-context-error", content: `❌ 日报上下文生成失败: ${e.message}`, display: true },
          { deliverAs: "nextTurn", triggerTurn: false },
        );
      }
    },
  });

  pi.registerCommand("attach", {
    description: "查看后台任务记录。用法: /attach <jobId前缀>",
    handler: async (args) => {
      const jobId = (args || "").trim();
      if (!jobId) {
        pi.sendMessage({ customType: "ox-attach-error", content: "用法: /attach <jobId前缀>", display: true }, { deliverAs: "nextTurn", triggerTurn: false });
        return;
      }
      const job = findJob(jobId);
      const content = job ? formatJobDetails(job, tailJobEvents(job, 80)) : `找不到 job: ${jobId}`;
      pi.sendMessage({ customType: "ox-attach", content, display: true }, { deliverAs: "nextTurn", triggerTurn: false });
    },
  });

  pi.registerCommand("watch", {
    description: "实时查看后台任务输出。用法: /watch <jobId前缀> [秒数]",
    handler: async (args) => {
      const parts = (args || "").trim().split(/\s+/).filter(Boolean);
      const jobId = parts[0];
      const seconds = parts[1] || "30";
      if (!jobId) {
        pi.sendMessage({ customType: "ox-watch-error", content: "用法: /watch <jobId前缀> [秒数]", display: true }, { deliverAs: "nextTurn", triggerTurn: false });
        return;
      }
      await pi.sendUserMessage(
        `请调用 factory_watch 实时查看后台 job ${jobId}，seconds=${seconds}。只展示工具结果，不要额外发挥。`,
        { deliverAs: "steer" },
      );
    },
  });

  // 拦截 input：对话模式下直接 spawn，不经过 LLM
  pi.on("input", async (event, ctx) => {
    if (!talkTarget || !event.text) return;

    const trimmed = event.text.trim();
    if (trimmed.startsWith("/") && trimmed !== "/talk off") return;

    if (trimmed === "/talk off" || trimmed === "talk off") {
      const suffix = activeTalkJobId ? `；job ${activeTalkJobId} 继续后台执行` : "";
      ctx.ui.notify(`已切回秘书对话${suffix}`, "info");
      talkTarget = null;
      activeTalkJobId = null;
      return { action: "handled" as const };
    }

    const w = recoverWorkerFromRegistrySnapshot(talkTarget);
    const availability = workerCanAcceptWork(w, talkTarget);
    if (!availability.ok) {
      ctx.ui.notify(availability.reason!, "error");
      talkTarget = null;
      return { action: "handled" as const };
    }

    const parsed = parseTalkDirective(event.text);
    if (!parsed.text.trim()) {
      ctx.ui.notify("消息为空，未发送", "error");
      return { action: "handled" as const };
    }

    startTalkMessage(w, parsed.text, ctx, parsed.mode);

    // 阻止原消息
    return { action: "handled" as const };
  });

  // ═══════════════════════════════════════════════════════
  // factory_note — 手动记录履历
  // ═══════════════════════════════════════════════════════
  pi.registerTool({
    name: "factory_note",
    label: "记录履历",
    description: "为员工手动记录一条项目经历，自动去重同项目旧记录。",
    parameters: Type.Object({
      worker: Type.String({ description: "员工姓名" }),
      project: Type.String({ description: "项目名称" }),
      task: Type.String({ description: "任务简述" }),
      summary: Type.String({ description: "成果摘要" }),
    }),
    async execute(_tcid, params) {
      const w = workers.get(params.worker);
      if (!w) return { content: [{ type: "text", text: `❌ 员工 "${params.worker}" 不存在` }], isError: true, details: {} };
      // 去重同项目旧记录
      w.projects = w.projects.filter((p) => p.project !== params.project);
      recordProject(params.worker, params.project, params.task, "success", params.summary);
      return { content: [{ type: "text", text: `✅ 已记录 **${params.worker}** → 「${params.project}」` }], details: {} };
    },
  });

  // ═══════════════════════════════════════════════════════
  // factory_project_* — 轻量项目实体 / Todo / Worktree / 进展 / 人员
  // ═══════════════════════════════════════════════════════
  pi.registerTool({
    name: "factory_project_upsert",
    label: "创建或更新项目",
    description: [
      "创建或更新轻量 Project 实体。Project 是和员工类似的一等实体，但只记录必要索引。",
      "适合维护项目名称、状态、优先级、别名、single source of truth 文档链接、飞书链接、仓库/看板链接。",
      "长 checklist/方案/报告继续放 Markdown 或飞书文档，本工具只保存链接和摘要。",
    ].join(" "),
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "稳定项目 ID，例如 ox-factory-web；不填会从 name 生成" })),
      name: Type.Optional(Type.String({ description: "项目名称，例如 牛马工厂 Web 大盘" })),
      summary: Type.Optional(Type.String({ description: "项目摘要，一句话说明目标" })),
      status: Type.Optional(ProjectStatusSchema),
      priority: Type.Optional(Type.String({ description: "优先级，例如 P0/P1/P2", default: "P1" })),
      aliases: Type.Optional(Type.Array(Type.String({ description: "项目别名，用于自然语言解析，例如 web-dashboard、工厂大盘" }))),
      truthType: Type.Optional(Type.String({ description: "single source of truth 类型，例如 markdown/feishu/external/mixed" })),
      truthRef: Type.Optional(Type.String({ description: "single source of truth 链接或路径，例如 docs/ox-projects/xxx.md" })),
      truthNote: Type.Optional(Type.String({ description: "truth 说明" })),
      docPath: Type.Optional(Type.String({ description: "项目 Markdown 文档路径" })),
      feishuUrl: Type.Optional(Type.String({ description: "飞书文档链接" })),
      repoPath: Type.Optional(Type.String({ description: "代码仓库或本地 repo 路径" })),
      dashboardUrl: Type.Optional(Type.String({ description: "项目看板/本地 Web 链接" })),
    }),
    async execute(_tcid, params) {
      try {
        const project = upsertProject(getWorkersDir(), { ...params, updatedBy: "主agent" });
        return {
          content: [{ type: "text", text: `✅ 已维护项目 **${project.name}**\n\n${formatProjectMarkdown(project)}` }],
          details: { project },
        };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `❌ 项目维护失败: ${e.message}` }],
          isError: true,
          details: {},
        };
      }
    },
  });

  pi.registerTool({
    name: "factory_project_list",
    label: "查看项目",
    description: "查看项目列表或单个项目详情。适合用户问“现在有哪些项目”“看看 Web 大盘项目”。",
    parameters: Type.Object({
      project: Type.Optional(Type.String({ description: "项目 ID/名称/别名；不填则列出项目列表" })),
      query: Type.Optional(Type.String({ description: "项目搜索关键词" })),
      includeArchived: Type.Optional(Type.Boolean({ description: "是否包含归档项目", default: false })),
      format: Type.Optional(
        StringEnum(["markdown", "json"] as const, {
          description: "返回格式，默认 markdown",
          default: "markdown",
        }),
      ),
    }),
    async execute(_tcid, params) {
      try {
        if (params.project) {
          const project = resolveProject(getWorkersDir(), params.project);
          if (!project) return { content: [{ type: "text", text: `❌ 项目不存在: ${params.project}` }], isError: true, details: {} };
          return {
            content: [{ type: "text", text: params.format === "json" ? JSON.stringify(project, null, 2) : formatProjectMarkdown(project) }],
            details: { project },
          };
        }
        const projects = listProjects(getWorkersDir(), {
          includeArchived: Boolean(params.includeArchived),
          query: params.query,
        });
        return {
          content: [{ type: "text", text: params.format === "json" ? JSON.stringify(projects, null, 2) : formatProjectsMarkdown(projects) }],
          details: { projects },
        };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `❌ 项目查询失败: ${e.message}` }],
          isError: true,
          details: {},
        };
      }
    },
  });

  pi.registerTool({
    name: "factory_project_todo_set",
    label: "设定项目 Todo",
    description: "新增或更新项目 Todo。用于轻量维护项目待办；长 checklist 仍建议放项目文档并通过 truthRef 链接。",
    parameters: Type.Object({
      project: Type.String({ description: "项目 ID/名称/别名" }),
      todoId: Type.Optional(Type.String({ description: "稳定 Todo ID；不填会从 title 生成" })),
      title: Type.String({ description: "Todo 标题" }),
      status: Type.Optional(ProjectTodoStatusSchema),
      owner: Type.Optional(Type.String({ description: "负责人" })),
      note: Type.Optional(Type.String({ description: "备注" })),
      evidence: Type.Optional(Type.String({ description: "证据链接/文档/job/message id" })),
    }),
    async execute(_tcid, params) {
      try {
        const project = setProjectTodo(getWorkersDir(), { ...params, updatedBy: "主agent" });
        return {
          content: [{ type: "text", text: `✅ 已更新项目 **${project.name}** 的 Todo\n\n${formatProjectMarkdown(project)}` }],
          details: { project },
        };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `❌ 项目 Todo 更新失败: ${e.message}` }],
          isError: true,
          details: {},
        };
      }
    },
  });

  pi.registerTool({
    name: "factory_project_worktree_set",
    label: "设定项目 Worktree",
    description: "新增或更新项目相关 worktree，记录路径、分支、负责人和状态；不负责真实创建/删除 worktree。",
    parameters: Type.Object({
      project: Type.String({ description: "项目 ID/名称/别名" }),
      worktreeId: Type.Optional(Type.String({ description: "稳定 worktree ID；不填会从路径生成" })),
      path: Type.String({ description: "worktree 路径" }),
      branch: Type.Optional(Type.String({ description: "分支名" })),
      worker: Type.Optional(Type.String({ description: "负责人/使用者" })),
      status: Type.Optional(ProjectWorktreeStatusSchema),
      note: Type.Optional(Type.String({ description: "备注" })),
    }),
    async execute(_tcid, params) {
      try {
        const project = setProjectWorktree(getWorkersDir(), { ...params, updatedBy: "主agent" });
        return {
          content: [{ type: "text", text: `✅ 已更新项目 **${project.name}** 的 worktree\n\n${formatProjectMarkdown(project)}` }],
          details: { project },
        };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `❌ 项目 worktree 更新失败: ${e.message}` }],
          isError: true,
          details: {},
        };
      }
    },
  });

  pi.registerTool({
    name: "factory_project_progress_add",
    label: "追加项目进展",
    description: "追加项目进展流水，供日报/项目报告读取。适合记录阶段性结果、风险、blocked 信息。",
    parameters: Type.Object({
      project: Type.String({ description: "项目 ID/名称/别名" }),
      text: Type.String({ description: "进展内容" }),
      status: Type.Optional(Type.String({ description: "进展状态/类型，例如 note/doing/done/blocked/risk", default: "note" })),
      owner: Type.Optional(Type.String({ description: "相关负责人" })),
      evidence: Type.Optional(Type.String({ description: "证据链接/文档/job/message id" })),
    }),
    async execute(_tcid, params) {
      try {
        const project = addProjectProgress(getWorkersDir(), { ...params, updatedBy: "主agent" });
        return {
          content: [{ type: "text", text: `✅ 已追加项目 **${project.name}** 的进展\n\n${formatProjectMarkdown(project)}` }],
          details: { project },
        };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `❌ 项目进展追加失败: ${e.message}` }],
          isError: true,
          details: {},
        };
      }
    },
  });

  pi.registerTool({
    name: "factory_project_member_set",
    label: "设定项目人员",
    description: "设定项目相关人员及关系，例如 owner/lead/developer/designer/reviewer/foreman。",
    parameters: Type.Object({
      project: Type.String({ description: "项目 ID/名称/别名" }),
      worker: Type.String({ description: "员工姓名" }),
      relation: Type.Optional(Type.String({ description: "项目关系，如 owner、lead、developer、designer、reviewer、foreman", default: "contributor" })),
      status: Type.Optional(ProjectMemberStatusSchema),
      note: Type.Optional(Type.String({ description: "备注/职责范围" })),
    }),
    async execute(_tcid, params) {
      try {
        const project = setProjectMember(getWorkersDir(), { ...params, updatedBy: "主agent" });
        return {
          content: [{ type: "text", text: `✅ 已更新项目 **${project.name}** 的相关人员\n\n${formatProjectMarkdown(project)}` }],
          details: { project },
        };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `❌ 项目人员更新失败: ${e.message}` }],
          isError: true,
          details: {},
        };
      }
    },
  });

  // ═══════════════════════════════════════════════════════
  // factory_responsibility_* — 当前职责 / 负责项目
  // ═══════════════════════════════════════════════════════
  pi.registerTool({
    name: "factory_responsibility_set",
    label: "设定员工职责",
    description: [
      "为员工设定当前职责、负责项目或笼统工作范围。",
      "适合用户说“让 Alice 负责 Web 大盘”“Bob 负责日报”“Carol 做 MR review”。",
      "这是当前职责，不是历史履历；会写入 .pi/workers/responsibilities.jsonl，Web 大盘可读取。",
    ].join(" "),
    parameters: Type.Object({
      worker: Type.String({ description: "员工姓名" }),
      project: Type.Optional(Type.String({ description: "负责项目；不填则为通用职责", default: "通用职责" })),
      relation: Type.Optional(Type.String({ description: "关系/角色，如 owner、lead、developer、reviewer、tester、support", default: "contributor" })),
      scope: Type.String({ description: "职责范围说明，例如：负责本地 Web 大盘前端实现和视觉 polish" }),
      status: Type.Optional(ResponsibilityStatusSchema),
      note: Type.Optional(Type.String({ description: "补充备注" })),
    }),
    async execute(_tcid, params) {
      try {
        const record = setResponsibility(params.worker, {
          project: params.project,
          relation: params.relation,
          scope: params.scope,
          status: params.status as "active" | "paused" | "done" | undefined,
          note: params.note,
          updatedBy: "主agent",
        });
        return {
          content: [{
            type: "text",
            text: [
              `✅ 已设定 **${record.worker}** 的当前职责`,
              "",
              `- 项目：${record.project}`,
              `- 关系：${record.relation}`,
              `- 状态：${record.status}`,
              `- 范围：${record.scope}`,
            ].join("\n"),
          }],
          details: { responsibility: record },
        };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `❌ 职责设定失败: ${e.message}` }],
          isError: true,
          details: {},
        };
      }
    },
  });

  pi.registerTool({
    name: "factory_responsibility_list",
    label: "查看员工职责",
    description: "查看员工当前职责 / 负责项目。适合用户问“谁负责什么”“看看 Alice 的职责”。",
    parameters: Type.Object({
      worker: Type.Optional(Type.String({ description: "只看某个员工" })),
      includeInactive: Type.Optional(Type.Boolean({ description: "是否包含已移除职责", default: false })),
      format: Type.Optional(
        StringEnum(["markdown", "json"] as const, {
          description: "返回格式，默认 markdown",
          default: "markdown",
        }),
      ),
    }),
    async execute(_tcid, params) {
      try {
        if (params.worker && !workers.has(params.worker)) {
          return { content: [{ type: "text", text: `❌ 员工 "${params.worker}" 不存在` }], isError: true, details: {} };
        }
        const records = listResponsibilities(params.worker, Boolean(params.includeInactive));
        const text = params.format === "json"
          ? JSON.stringify(records, null, 2)
          : formatResponsibilitiesMarkdown(records);
        return {
          content: [{ type: "text", text }],
          details: { responsibilities: records },
        };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `❌ 职责查询失败: ${e.message}` }],
          isError: true,
          details: {},
        };
      }
    },
  });

  pi.registerTool({
    name: "factory_responsibility_remove",
    label: "移除员工职责",
    description: "移除某个员工的当前职责。采用 append-only 记录，不删除历史文件行。",
    parameters: Type.Object({
      worker: Type.String({ description: "员工姓名" }),
      project: Type.Optional(Type.String({ description: "负责项目；不填则为通用职责", default: "通用职责" })),
      relation: Type.Optional(Type.String({ description: "关系/角色；不填则为 contributor", default: "contributor" })),
      note: Type.Optional(Type.String({ description: "移除原因" })),
    }),
    async execute(_tcid, params) {
      try {
        const record = removeResponsibility(params.worker, {
          project: params.project,
          relation: params.relation,
          note: params.note,
          updatedBy: "主agent",
        });
        return {
          content: [{
            type: "text",
            text: `✅ 已移除 **${record.worker}** 在「${record.project}」的 ${record.relation} 职责`,
          }],
          details: { responsibility: record },
        };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `❌ 职责移除失败: ${e.message}` }],
          isError: true,
          details: {},
        };
      }
    },
  });

  // ═══════════════════════════════════════════════════════
  // factory_talk — 实时对话
  // ═══════════════════════════════════════════════════════
  pi.registerTool({
    name: "factory_talk",
    label: "对话",
    description: [
      "与指定员工实时对话。能看到员工的思考过程、工具调用和最终回复。",
      "适合：临时讨论、问题咨询、了解进度。不记录为项目经验。",
    ].join(" "),
    parameters: Type.Object({
      worker: Type.String({ description: "员工姓名" }),
      message: Type.String({ description: "要发送的消息" }),
      background: Type.Optional(Type.Boolean({ description: "是否后台执行并立即返回 job id；默认 false", default: false })),
    }),
    async execute(_tcid, params, signal, onUpdate) {
      const w = workers.get(params.worker);
      const availability = workerCanAcceptWork(w, params.worker);
      if (!availability.ok) return { content: [{ type: "text", text: `❌ ${availability.reason}` }], isError: true, details: {} };

      if (params.background) {
        const { job } = enqueueWorkerCommand({
          worker: w,
          task: params.message,
          project: "talk",
          mode: "queue",
          kind: "talk",
        });
        return {
          content: [{ type: "text", text: `💬 已后台发送给 **${w.id}**。\n\njob: \`${job.id}\`\n\n用 \`factory_attach\` 查看实时记录。` }],
          details: { worker: w.id, jobId: job.id },
        };
      }

      let displayText = `💬 **${w.id}** (${w.role})\n`;
      let thinkingActive = false;
      let lastUpdate = Date.now();
      const flushDisplay = () => onUpdate?.({ content: [{ type: "text", text: displayText }] });

      const result = await spawnWorkerStreaming(
        { worker: w, task: params.message, project: "", signal },
        (event) => {
          switch (event.type) {
            case "thinking":
              if (!thinkingActive) { displayText += "\n🤔 思考中"; thinkingActive = true; }
              if (Date.now() - lastUpdate > 1000) { flushDisplay(); lastUpdate = Date.now(); }
              break;
            case "text":
              if (thinkingActive) { displayText += "\n"; thinkingActive = false; }
              displayText += event.text;
              if (Date.now() - lastUpdate > 300) { flushDisplay(); lastUpdate = Date.now(); }
              break;
            case "tool_start": {
              if (thinkingActive) { thinkingActive = false; }
              displayText += `\n${formatJobEvent(event)}\n`;
              flushDisplay();
              break;
            }
            case "tool_output":
              displayText += `${formatJobEvent(event)}\n`;
              flushDisplay();
              break;
            case "tool_end":
              displayText += `${formatJobEvent(event)}\n`;
              flushDisplay();
              break;
            case "done":
              if (thinkingActive) { displayText += "\n"; thinkingActive = false; }
              displayText += `\n---\n${event.turns} 轮 | ↑${event.inputTokens} ↓${event.outputTokens}`;
              if (event.model) displayText += ` | ${event.model}`;
              break;
            case "error":
              displayText += `\n❌ ${event.message}\n`;
              flushDisplay();
              break;
          }
        },
      );

      flushDisplay();
      const success = spawnSucceeded(result);
      return {
        content: [{ type: "text", text: displayText }],
        isError: success ? undefined : true,
        details: { worker: w.id, turns: result.turns, exitCode: result.exitCode, stopReason: result.stopReason, error: result.errorMessage || result.stderr },
      };
    },
  });

  function formatWorkerTaskRequestSummary(requests: any[]): string {
    if (!requests.length) return "暂无派活请求。";
    return [
      "| 状态 | 请求 | 来源 | 目标 | job | 模式 | 项目 | 时间 | 任务 |",
      "|---|---|---|---|---|---|---|---|---|",
      ...requests.map((request) =>
        `| ${request.status || "-"} | \`${request.id}\` | ${request.from || "-"} | ${request.to || "-"} | ${request.jobId ? `\`${request.jobId}\`` : "-"} | ${request.deliveryMode || request.mode || "-"} | ${request.project || "-"} | ${request.createdAt || "-"} | ${String(request.task || "").replace(/\s+/g, " ").slice(0, 80)} |`
      ),
    ].join("\n");
  }

  // ═══════════════════════════════════════════════════════
  // factory_outsource_* — 外包白纸 subagent 模式
  // ═══════════════════════════════════════════════════════
  pi.registerTool({
    name: "factory_outsource_profiles",
    label: "外包配置",
    description: [
      "管理匿名/白纸外包 agent profile。",
      "外包 agent 不复用员工身份、记忆或 session；只按 profile 的 backend/model/tools 执行当前任务。",
      "action=upsert 可添加类似 codex-coder、doubao-coder 的外包公司配置。",
    ].join(" "),
    parameters: Type.Object({
      action: Type.Optional(
        StringEnum(["list", "get", "upsert"] as const, {
          description: "list=列出，get=查看单个，upsert=新增或更新",
          default: "list",
        }),
      ),
      name: Type.Optional(Type.String({ description: "profile 名称，如 codex-coder" })),
      description: Type.Optional(Type.String({ description: "profile 描述" })),
      backend: Type.Optional(
        StringEnum(["pi", "codex"] as const, {
          description: "后端：pi=临时 Pi session，codex=临时 Codex app-server thread",
          default: "pi",
        }),
      ),
      model: Type.Optional(Type.String({ description: "模型名" })),
      thinking: Type.Optional(Type.String({ description: "思考深度/effort" })),
      tools: Type.Optional(Type.Array(Type.String({ description: "允许工具名" }), { description: "允许工具列表；不填使用默认编码工具集" })),
      skills: Type.Optional(Type.Boolean({ description: "是否启用 skills；外包白纸模式默认 false" })),
      systemPrompt: Type.Optional(Type.String({ description: "额外/覆盖系统提示；默认强调匿名、无记忆、只执行当前任务" })),
      maxTurns: Type.Optional(Type.Number({ description: "最大轮数预留字段，默认 1" })),
      defaultWait: Type.Optional(Type.Boolean({ description: "未显式指定时是否等待结果返回，默认 true" })),
      timeoutMs: Type.Optional(Type.Number({ description: "默认等待超时；不填/0=不超时" })),
    }),
    async execute(_tcid, params) {
      try {
        const action = params.action || "list";
        if (action === "upsert") {
          const profile = upsertOutsourceProfile(getWorkersDir(), {
            name: params.name,
            description: params.description,
            backend: params.backend || "pi",
            model: params.model,
            thinking: params.thinking,
            tools: params.tools,
            skills: params.skills,
            systemPrompt: params.systemPrompt,
            maxTurns: params.maxTurns,
            defaultWait: params.defaultWait,
            timeoutMs: params.timeoutMs,
            actor: "factory_outsource_profiles",
          });
          return {
            content: [{ type: "text", text: [`✅ 已保存外包 profile: **${profile.name}**`, "", formatOutsourceProfiles([profile])].join("\n") }],
            details: { profile },
          };
        }
        if (action === "get") {
          const profile = getOutsourceProfile(getWorkersDir(), params.name || "");
          if (!profile) return { content: [{ type: "text", text: `❌ 未找到外包 profile: ${params.name || "(empty)"}` }], isError: true, details: {} };
          return { content: [{ type: "text", text: formatOutsourceProfiles([profile]) }], details: { profile } };
        }
        const profiles = listOutsourceProfiles(getWorkersDir());
        return { content: [{ type: "text", text: formatOutsourceProfiles(profiles) }], details: { profiles } };
      } catch (e: any) {
        return { content: [{ type: "text", text: `❌ 外包 profile 操作失败: ${e.message}` }], isError: true, details: {} };
      }
    },
  });

  pi.registerTool({
    name: "factory_outsource_run",
    label: "联系外包公司",
    description: [
      "启动匿名/白纸外包 agent 执行任务。",
      "可 background=true 后台跑，也可 wait=true 等到结果再继续；默认按 profile.defaultWait 等待。",
      "运行会记录为 outsource-run job 和 outsource run，但不会触发员工情绪评分。",
    ].join(" "),
    parameters: Type.Object({
      profile: Type.String({ description: "外包 profile 名称" }),
      task: Type.String({ description: "要外包 agent 执行的具体任务" }),
      project: Type.Optional(Type.String({ description: "项目名称，默认 outsource" })),
      cwd: Type.Optional(Type.String({ description: "工作目录，默认当前目录" })),
      requestedBy: Type.Optional(Type.String({ description: "派活来源，默认用户；员工派活时填员工名" })),
      groupId: Type.Optional(Type.String({ description: "可选批次 id，用于等待一组外包 run" })),
      background: Type.Optional(Type.Boolean({ description: "true=后台返回 run/job id；false=等待完成" })),
      wait: Type.Optional(Type.Boolean({ description: "是否等待结果；优先级高于 background" })),
      timeoutMs: Type.Optional(Type.Number({ description: "等待超时；不填/0=不超时（可显式传毫秒数）" })),
    }),
    async execute(_tcid, params, signal) {
      try {
        const profile = getOutsourceProfile(getWorkersDir(), params.profile);
        if (!profile) {
          return { content: [{ type: "text", text: `❌ 未找到外包 profile: ${params.profile}

先用 factory_outsource_profiles action=upsert 创建。` }], isError: true, details: {} };
        }
        const shouldWait = normalizeOutsourceWait(params, profile);
        const { run, job } = startOutsourceRunJob({
          workersDir: getWorkersDir(),
          profile,
          task: params.task,
          project: params.project || "outsource",
          cwd: params.cwd || process.cwd(),
          requestedBy: params.requestedBy || "用户",
          groupId: params.groupId,
          wait: shouldWait,
          background: !shouldWait,
          detached: !shouldWait,
          signal,
        });
        if (!shouldWait) {
          return {
            content: [{
              type: "text",
              text: [
                `🚀 已启动外包 run。`,
                "",
                `- run: \`${run.id}\``,
                `- group: \`${run.groupId}\``,
                `- job: \`${job.id}\``,
                `- profile: ${profile.name}`,
                "",
                `之后用 \`factory_outsource_wait\` 等结果，或 \`factory_outsource_result\` 查看单个结果。`,
              ].join("\n"),
            }],
            details: { run, job },
          };
        }
        const waited = await waitForOutsourceRuns(getWorkersDir(), {
          runId: run.id,
          mode: "all",
          timeoutMs: params.timeoutMs || profile.timeoutMs || 0,
          signal,
        });
        return {
          content: [{ type: "text", text: renderOutsourceWaitResult(waited) }],
          isError: waited.status === "timeout" ? true : undefined,
          details: { runId: run.id, jobId: job.id, waited },
        };
      } catch (e: any) {
        return { content: [{ type: "text", text: `❌ 外包执行失败: ${e.message}` }], isError: true, details: {} };
      }
    },
  });

  pi.registerTool({
    name: "factory_outsource_status",
    label: "外包状态",
    description: "查看外包 run 列表/状态，可按 runId、groupId、profile、status 过滤。",
    parameters: Type.Object({
      runId: Type.Optional(Type.String({ description: "单个 run id" })),
      groupId: Type.Optional(Type.String({ description: "批次 group id" })),
      profile: Type.Optional(Type.String({ description: "profile 名称" })),
      status: Type.Optional(StringEnum(["queued", "running", "done", "failed", "cancelled"] as const, { description: "状态过滤" })),
      limit: Type.Optional(Type.Number({ description: "最多返回数量，默认 20" })),
    }),
    async execute(_tcid, params) {
      try {
        const runs = listOutsourceRuns(getWorkersDir(), {
          runId: params.runId,
          groupId: params.groupId,
          profile: params.profile,
          status: params.status,
          limit: params.limit || 20,
        }).reverse();
        return { content: [{ type: "text", text: formatOutsourceRuns(runs) }], details: { runs } };
      } catch (e: any) {
        return { content: [{ type: "text", text: `❌ 查询外包状态失败: ${e.message}` }], isError: true, details: {} };
      }
    },
  });

  pi.registerTool({
    name: "factory_outsource_wait",
    label: "等待外包",
    description: "等待一个外包 run 或一个 group 的外包 run 完成。适合父 agent 派后台外包后稍后收敛结果。",
    parameters: Type.Object({
      runId: Type.Optional(Type.String({ description: "单个 run id" })),
      groupId: Type.Optional(Type.String({ description: "批次 group id" })),
      mode: Type.Optional(StringEnum(["all", "next"] as const, { description: "all=等全部；next=等任一完成", default: "all" })),
      timeoutMs: Type.Optional(Type.Number({ description: "等待超时；不填/0=不超时" })),
      pollIntervalMs: Type.Optional(Type.Number({ description: "轮询间隔，默认 500ms" })),
    }),
    async execute(_tcid, params, signal) {
      try {
        const waited = await waitForOutsourceRuns(getWorkersDir(), {
          runId: params.runId,
          groupId: params.groupId,
          mode: params.mode || "all",
          timeoutMs: params.timeoutMs || 0,
          pollIntervalMs: params.pollIntervalMs || 500,
          signal,
        });
        return {
          content: [{ type: "text", text: renderOutsourceWaitResult(waited) }],
          isError: waited.status === "timeout" ? true : undefined,
          details: { waited },
        };
      } catch (e: any) {
        return { content: [{ type: "text", text: `❌ 等待外包失败: ${e.message}` }], isError: true, details: {} };
      }
    },
  });

  pi.registerTool({
    name: "factory_outsource_result",
    label: "外包结果",
    description: "查看单个外包 run 的结果；可选择等待其完成。",
    parameters: Type.Object({
      runId: Type.String({ description: "run id" }),
      wait: Type.Optional(Type.Boolean({ description: "如果还在运行，是否先等待完成，默认 false" })),
      timeoutMs: Type.Optional(Type.Number({ description: "等待超时；不填/0=不超时" })),
      verbose: Type.Optional(Type.Boolean({ description: "是否展示完整输出，默认 false" })),
    }),
    async execute(_tcid, params, signal) {
      try {
        let run = getOutsourceRun(getWorkersDir(), params.runId);
        if (!run) return { content: [{ type: "text", text: `❌ 未找到外包 run: ${params.runId}` }], isError: true, details: {} };
        if (params.wait && !["done", "failed", "cancelled"].includes(run.status)) {
          await waitForOutsourceRuns(getWorkersDir(), {
            runId: run.id,
            mode: "all",
            timeoutMs: params.timeoutMs || 0,
            signal,
          });
          run = getOutsourceRun(getWorkersDir(), params.runId);
        }
        return {
          content: [{ type: "text", text: renderOutsourceResult(run, params.verbose === true) }],
          isError: run?.status === "failed" ? true : undefined,
          details: { run },
        };
      } catch (e: any) {
        return { content: [{ type: "text", text: `❌ 查看外包结果失败: ${e.message}` }], isError: true, details: {} };
      }
    },
  });

  // ═══════════════════════════════════════════════════════
  // factory_task_* — 授权式员工派活
  // ═══════════════════════════════════════════════════════
  pi.registerTool({
    name: "factory_task_assign",
    label: "员工派活",
    description: [
      "让一个来源（用户/员工/秘书）授权式派具体任务给另一个员工。",
      "和发送消息不同：派活会写入 worker task request intent，由 Pi 主进程检查 work:assign 权限后创建员工 job。",
      "目标员工忙碌时按 mode 排队或 steer；job 完成后系统会自动把结果消息回给派活来源。",
    ].join(" "),
    parameters: Type.Object({
      from: Type.Optional(Type.String({ description: "派活来源，默认用户；普通员工需要对目标有 work:assign 权限" })),
      to: Type.String({ description: "目标员工姓名" }),
      task: Type.String({ description: "要目标员工执行的具体任务" }),
      project: Type.Optional(Type.String({ description: "项目名称，默认 factory-task" })),
      mode: Type.Optional(
        StringEnum(["auto", "queue", "steer", "now"] as const, {
          description: "auto=空闲立即/忙则排队；queue=明确排队；steer=优先插队/可用时注入 Codex active turn；now=仅空闲才执行",
          default: "auto",
        }),
      ),
      cwd: Type.Optional(Type.String({ description: "工作目录，默认当前目录" })),
    }),
    async execute(_tcid, params) {
      try {
        const from = String(params.from || "用户").trim() || "用户";
        const to = String(params.to || "").trim();
        if (!hasPermission(getWorkersDir(), { subject: from, action: "work:assign", target: to })) {
          return { content: [{ type: "text", text: `❌ ${from} 没有权限对 ${to} 执行 work:assign` }], isError: true, details: {} };
        }
        const request = createWorkerTaskRequest(getWorkersDir(), {
          from,
          to,
          task: params.task,
          project: params.project || "factory-task",
          cwd: params.cwd || process.cwd(),
          mode: params.mode || "auto",
          source: "factory-tool",
        });
        await drainWorkerTaskRequests(lastSessionCtx);
        const current = getWorkerTaskRequest(getWorkersDir(), request.id) || request;
        const lines = [
          `🧩 已提交员工派活请求。`,
          ``,
          `- request: \`${current.id}\``,
          `- status: ${current.status}`,
          `- from: ${current.from}`,
          `- to: ${current.to}`,
          `- mode: ${current.deliveryMode || current.mode}`,
          current.jobId ? `- job: \`${current.jobId}\`` : null,
          current.placement ? `- placement: ${current.placement}` : null,
          current.error ? `- error: ${current.error}` : null,
          ``,
          `派活完成后，系统会自动把 job 结果作为 task_result 消息回给 ${current.from}。`,
        ].filter(Boolean);
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          isError: current.status === "failed" ? true : undefined,
          details: { request: current },
        };
      } catch (e: any) {
        return { content: [{ type: "text", text: `❌ 派活失败: ${e.message}` }], isError: true, details: {} };
      }
    },
  });

  pi.registerTool({
    name: "factory_task_status",
    label: "查看员工派活",
    description: "查看授权式员工派活请求的状态、关联 job 和结果回传消息。",
    parameters: Type.Object({
      requestId: Type.Optional(Type.String({ description: "派活请求 id；不填则列出最近请求" })),
      from: Type.Optional(Type.String({ description: "按派活来源过滤" })),
      to: Type.Optional(Type.String({ description: "按目标员工过滤" })),
      limit: Type.Optional(Type.Number({ description: "最多返回多少条，默认 20" })),
    }),
    async execute(_tcid, params) {
      try {
        if (params.requestId) {
          const request = getWorkerTaskRequest(getWorkersDir(), params.requestId);
          if (!request) return { content: [{ type: "text", text: `❌ 未找到派活请求 ${params.requestId}` }], isError: true, details: {} };
          return {
            content: [{ type: "text", text: formatWorkerTaskRequestSummary([request]) }],
            details: { request },
          };
        }
        const requests = listWorkerTaskRequests(getWorkersDir(), {
          from: params.from,
          to: params.to,
          limit: params.limit || 20,
        }).reverse();
        return {
          content: [{ type: "text", text: formatWorkerTaskRequestSummary(requests) }],
          details: { requests },
        };
      } catch (e: any) {
        return { content: [{ type: "text", text: `❌ 查询派活失败: ${e.message}` }], isError: true, details: {} };
      }
    },
  });

  // ═══════════════════════════════════════════════════════
  // factory_command — 有记忆员工指挥模式
  // ═══════════════════════════════════════════════════════
  pi.registerTool({
    name: "factory_command",
    label: "指挥员工",
    description: [
      "用有记忆 subagent 模式指挥指定员工执行任务。",
      "复用员工自己的长期 session；主 agent 只拿 job id / 短摘要，完整输出写 job events 和员工 session。",
      "适合隔离上下文地派活、让空闲员工立即干活，或忙碌员工排队处理。",
    ].join(" "),
    parameters: Type.Object({
      worker: Type.String({ description: "员工姓名" }),
      task: Type.String({ description: "任务描述" }),
      project: Type.Optional(Type.String({ description: "项目名称；默认 talk，确保员工页对话历史可见" })),
      assignedBy: Type.Optional(Type.String({ description: "指派者，默认主agent；员工代为调用时填员工名" })),
      mode: Type.Optional(
        StringEnum(["auto", "queue", "steer", "now"] as const, {
          description: "auto=空闲立即/忙则排队；queue=明确排队；steer=Codex 有 active turn 时插入当前 turn，Pi/无 active turn 时排在当前 job 后优先；now=仅空闲才执行",
          default: "auto",
        }),
      ),
      cwd: Type.Optional(Type.String({ description: "工作目录，默认当前目录" })),
    }),
    async execute(_tcid, params) {
      try {
        const w = workers.get(params.worker);
        const availability = workerCanAcceptWork(w, params.worker);
        if (!availability.ok) return { content: [{ type: "text", text: `❌ ${availability.reason}` }], isError: true, details: {} };
        const { job, deliveryMode, placement } = enqueueWorkerCommand({
          worker: w,
          task: params.task,
          project: params.project || "talk",
          cwd: params.cwd || process.cwd(),
          mode: params.mode || "auto",
          kind: "talk",
          source: "factory_command",
          displayChannel: "talk",
          assignedBy: params.assignedBy || "主agent",
        });
        return {
          content: [
            {
              type: "text",
              text: [
                `🧭 已指挥 **${w.id}** 执行任务。`,
                ``,
                `- job: \`${job.id}\``,
                `- mode: ${deliveryMode}`,
                `- placement: ${placement}`,
                `- project: ${job.project || "talk"}`,
                `- assignedBy: ${job.assignedBy || "主agent"}`,
                ``,
                `完整输出会写入 job events 和员工 session；主 agent 默认只保留这条短摘要。`,
              ].join("\n"),
            },
          ],
          details: { worker: w.id, jobId: job.id, deliveryMode, placement },
        };
      } catch (e: any) {
        return { content: [{ type: "text", text: `❌ 指挥失败: ${e.message}` }], isError: true, details: {} };
      }
    },
  });

  // ═══════════════════════════════════════════════════════
  // factory_queue — 加入任务队列
  // ═══════════════════════════════════════════════════════
  pi.registerTool({
    name: "factory_queue",
    label: "加入队列",
    description: [
      "将任务加入执行队列。即时一次性任务默认在当前 Pi 进程后台执行；定时/循环任务走离线 runner。",
      "员工会在后台自主干活，结果保存到各自的 session 文件中。",
      "适合：定时检查、长任务、批量处理。",
    ].join(" "),
    parameters: Type.Object({
      worker: Type.String({ description: "员工姓名" }),
      project: Type.String({ description: "项目名称" }),
      task: Type.String({ description: "任务描述" }),
      cwd: Type.Optional(Type.String({ description: "工作目录（不填则默认项目根目录）" })),
      scheduled: Type.Optional(Type.String({ description: "计划执行时间（ISO 格式，如 2026-06-25T09:00:00Z），不填则立即" })),
      repeat: Type.Optional(Type.Number({ description: "重复间隔（分钟），填了就会循环执行。如 30 = 每 30 分钟跑一次" })),
      mode: Type.Optional(
        StringEnum(["auto", "in_process", "runner"] as const, {
          description: "执行模式。auto 默认：即时一次性任务在当前 Pi 进程后台跑；定时/循环走 runner。",
          default: "auto",
        }),
      ),
    }),
    async execute(_tcid, params) {
      try {
        const fs = await import("node:fs");
        const queueFile = path.join(getWorkersDir(), "queue.jsonl");

        const w = workers.get(params.worker);
        const availability = workerCanAcceptWork(w, params.worker);
        if (!availability.ok) return { content: [{ type: "text", text: `❌ ${availability.reason}` }], isError: true, details: {} };

        const mode = params.mode ?? "auto";
        const workCwd = params.cwd || process.cwd();
        if (shouldRunInProcess({ mode, scheduled: params.scheduled, repeat: params.repeat })) {
          const { job } = enqueueWorkerCommand({
            worker: w,
            task: params.task,
            project: params.project,
            cwd: workCwd,
            mode: "queue",
            kind: "queue",
          });

          return {
            content: [
              {
                type: "text",
                text: [
                  `📋 任务已作为后台 job 启动。`,
                  ``,
                  `- **执行者**: ${w.id}`,
                  `- **项目**: ${params.project}`,
                  `- **job**: \`${job.id}\``,
                  `- **cwd**: ${workCwd}`,
                  ``,
                  `它继承当前 Pi 进程环境，适合需要 GUI、当前登录态或完整 PATH 的任务。`,
                  `用 \`factory_watch\` 或 \`/watch ${job.id}\` 动态看输出；用 \`factory_attach\` 查看快照。`,
                ].join("\n"),
              },
            ],
            details: { job },
          };
        }

        const entry: any = {
          status: "pending",
          worker: params.worker,
          project: params.project,
          task: params.task,
          time: new Date().toISOString(),
        };
        if (params.scheduled) entry.scheduled = params.scheduled;
        if (params.repeat) entry.repeat = params.repeat;
        if (params.cwd) entry.cwd = params.cwd;
        entry.mode = mode;

        fs.appendFileSync(queueFile, JSON.stringify(entry) + "\n", "utf-8");

        // 如果没有计划时间，立即后台触发队列处理
        let immediateInfo = "";
        const repeatInfo = params.repeat
          ? `🔄 循环任务，每 ${params.repeat} 分钟执行一次`
          : "";

        if (!params.scheduled) {
          try {
            const { spawn: bgSpawn } = await import("node:child_process");
            const runnerPath = path.join(getWorkersDir(), "runner.sh");
            const logFd = fs.openSync(path.join(getWorkersDir(), "history.log"), "a");
            // 不传 --worker --task，让 runner.sh 自己从队列取（避免重复执行）
            const child = bgSpawn("bash", [runnerPath], {
              cwd: process.cwd(),
              detached: true,
              stdio: ["ignore", logFd, logFd],
              env: { ...process.env },
            });
            child.unref();
            immediateInfo = "⚡ 已立即后台启动，无需等待。";
            w.status = "working";
          } catch {
            immediateInfo = "⏳ 将在下一个 cron 周期执行（每 5 分钟）。";
          }
        } else {
          immediateInfo = `⏰ 计划执行: ${params.scheduled}`;
        }

        return {
          content: [
            {
              type: "text",
              text: [
                `📋 任务已入队！`,
                ``,
                `- **执行者**: ${params.worker}`,
                `- **项目**: ${params.project}`,
                `- **任务**: ${params.task}`,
                `- ${immediateInfo}`,
                ``,
                repeatInfo ? `- ${repeatInfo}` : "",
                `用 \`工厂检查\` 随时查看进度和结果。`,
              ].join("\n"),
            },
          ],
          details: { entry },
        };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `❌ 入队失败: ${e.message}` }],
          isError: true,
          details: {},
        };
      }
    },
  });

  // ═══════════════════════════════════════════════════════
  // factory_check — 查看队列和最近结果
  // ═══════════════════════════════════════════════════════
  pi.registerTool({
    name: "factory_check",
    label: "队列检查",
    description: "查看任务队列状态、最近执行结果、员工工作日志。",
    parameters: Type.Object({
      scope: Type.Optional(
        StringEnum(["queue", "history", "all"] as const, {
          description: "查看范围：queue=队列, history=历史, all=全部",
          default: "all",
        }),
      ),
      worker: Type.Optional(Type.String({ description: "只看某个员工的（可选）" })),
    }),
    async execute(_tcid, params) {
      try {
        const fs = await import("node:fs");
        const queueFile = path.join(getWorkersDir(), "queue.jsonl");
        const logFile = path.join(getWorkersDir(), "history.log");
        const lines: string[] = [];

        // 队列状态
        if (params.scope !== "history" && fs.existsSync(queueFile)) {
          const rawEntries = fs
            .readFileSync(queueFile, "utf-8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((l) => {
              try { return JSON.parse(l); } catch { return null; }
            })
            .filter(Boolean);

          // 去重：同一 worker+task 非循环任务只保留最新状态
          const seen = new Map<string, any>();
          for (const e of rawEntries) {
            // 循环任务用 cycle 区分，不去重
            const key = e.repeat ? `${e.worker}::${e.cycle || 0}` : `${e.worker}::${(e.task || "").slice(0, 60)}`;
            if (e.status === "pending" && seen.has(key) && seen.get(key).status !== "pending") continue;
            seen.set(key, e);
          }
          const entries = [...seen.values()];

          // 刷新员工状态：队列中无 running 任务 → idle
          const runningWorkers = new Set(entries.filter((e: any) => e.status === "running").map((e: any) => e.worker));
          for (const w of getActiveWorkers()) {
            if (w.status === "working" && !runningWorkers.has(w.id)) {
              w.status = "idle";
            }
          }

          const pending = entries.filter((e: any) => e.status === "pending");
          const running = entries.filter((e: any) => e.status === "running");
          const done = entries.filter((e: any) => e.status === "done");
          const failed = entries.filter((e: any) => e.status === "failed");
          const stale = entries.filter((e: any) => e.status === "stale");

          lines.push(`## 📋 任务队列`);
          lines.push(`待办: ${pending.length} | 进行中: ${running.length} | 已完成: ${done.length} | 失败: ${failed.length} | 卡住: ${stale.length}`);
          lines.push("");

          if (pending.length > 0) {
            lines.push("### ⏳ 待办");
            for (const e of pending) {
              if (params.worker && e.worker !== params.worker) continue;
              const scheduled = e.scheduled ? ` (计划: ${e.scheduled})` : "";
              lines.push(`- 👤 **${e.worker}** | ${e.project}${scheduled}`);
              lines.push(`  ${(e.task as string).slice(0, 100)}`);
            }
            lines.push("");
          }

          if (done.length > 0) {
            lines.push("### ✅ 最近完成");
            const recent = done.slice(-5).reverse();
            for (const e of recent) {
              if (params.worker && e.worker !== params.worker) continue;
              lines.push(`- 👤 **${e.worker}** | ${e.time} | ⏱ ${e.elapsed ?? "?"}s`);
              lines.push(`  ${(e.summary || e.task || "").slice(0, 120)}`);
            }
            lines.push("");
          }

          if (failed.length > 0) {
            lines.push("### ❌ 失败");
            for (const e of failed.slice(-3)) {
              if (params.worker && e.worker !== params.worker) continue;
              lines.push(`- 👤 **${e.worker}** | ${e.time} | exit=${e.exitCode}`);
            }
            lines.push("");
          }

          if (stale.length > 0) {
            lines.push("### ⚠️ 卡住/过期");
            for (const e of stale.slice(-5)) {
              if (params.worker && e.worker !== params.worker) continue;
              lines.push(`- 👤 **${e.worker}** | ${e.project || "未命名项目"} | ${e.time}`);
              lines.push(`  ${(e.summary || e.task || "").slice(0, 120)}`);
            }
            lines.push("");
          }
        }

        // 历史日志
        if (params.scope !== "queue" && fs.existsSync(logFile)) {
          const logContent = fs.readFileSync(logFile, "utf-8").trim();
          if (logContent) {
            const logLines = logContent.split("\n");
            const recent = logLines.slice(-20);
            lines.push("### 📜 最近日志");
            lines.push("```");
            for (const l of recent) {
              if (params.worker && !l.includes(params.worker)) continue;
              lines.push(l);
            }
            lines.push("```");
          }
        }

        const recentJobs = listJobs(getWorkersDir(), { worker: params.worker, limit: 8 }).reverse();
        if (recentJobs.length > 0) {
          lines.push("");
          lines.push("### 🔄 后台 Jobs");
          for (const job of recentJobs) {
            lines.push(`- ${formatJobLine(job)}`);
          }
        }

        if (lines.length <= 1) {
          lines.push("📭 暂无队列记录。用「加入队列」来添加任务。");
        }

        return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `❌ 查询失败: ${e.message}` }],
          isError: true,
          details: {},
        };
      }
    },
  });

  // ═══════════════════════════════════════════════════════
  // factory_report_context — 日报/全员产出上下文
  // ═══════════════════════════════════════════════════════
  pi.registerTool({
    name: "factory_report_context",
    label: "日报上下文",
    description: [
      "聚合工厂日报数据源，避免只看 queue.jsonl 误判空转。",
      "会只读汇总 jobs、queue、员工 session 和当前主 session 管理动作，适合 Foreman 写日报前调用。",
    ].join(" "),
    parameters: Type.Object({
      date: Type.Optional(Type.String({ description: "日报日期，格式 YYYY-MM-DD；不填默认今天" })),
      includeSessions: Type.Optional(Type.Boolean({ description: "是否扫描员工 session 统计工具调用和 token，默认 true" })),
      format: Type.Optional(
        StringEnum(["markdown", "json"] as const, {
          description: "返回格式，默认 markdown",
          default: "markdown",
        }),
      ),
    }),
    async execute(_tcid, params) {
      try {
        const context = buildFactoryReportContext({
          workersDir: getWorkersDir(),
          date: params.date,
          workers: getActiveWorkers(),
          sessionEntries: mainSessionEntries,
          includeSessions: params.includeSessions ?? true,
        });
        const text = params.format === "json"
          ? JSON.stringify(context, null, 2)
          : formatFactoryReportContext(context);
        return {
          content: [{ type: "text", text }],
          details: { context },
        };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `❌ 日报上下文生成失败: ${e.message}` }],
          isError: true,
          details: {},
        };
      }
    },
  });

  // ═══════════════════════════════════════════════════════
  // factory_token_report — 员工 Token 用量
  // ═══════════════════════════════════════════════════════
  pi.registerTool({
    name: "factory_token_report",
    label: "查看 Token 消耗",
    description: [
      "当用户用自然语言询问 token 消耗、token 用量、某个员工今天/昨天花了多少 token 时调用本工具，例如“看看 DeveloperA 的 token 消耗”。",
      "按日期统计每个员工 input/output/total token。",
      "只做 token 监控，不计算成本，不做绩效评分。",
      "session usage 优先，job token 作为兜底，避免重复相加。",
    ].join(" "),
    parameters: Type.Object({
      date: Type.Optional(Type.String({ description: "统计日期，格式 YYYY-MM-DD；不填默认今天" })),
      worker: Type.Optional(Type.String({ description: "只看某个员工；用户说“看看 xxx 的 token 消耗”时填员工名 xxx" })),
      format: Type.Optional(
        StringEnum(["markdown", "json"] as const, {
          description: "返回格式，默认 markdown",
          default: "markdown",
        }),
      ),
    }),
    async execute(_tcid, params) {
      try {
        const report = buildFactoryTokenReport({
          workersDir: getWorkersDir(),
          date: params.date,
          worker: params.worker,
        });
        const text = params.format === "json"
          ? JSON.stringify(report, null, 2)
          : formatFactoryTokenReport(report);
        return {
          content: [{ type: "text", text }],
          details: { report },
        };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `❌ Token 报告生成失败: ${e.message}` }],
          isError: true,
          details: {},
        };
      }
    },
  });

  // ═══════════════════════════════════════════════════════
  // factory_quality_report — 上下文 / 回复质量观测
  // ═══════════════════════════════════════════════════════
  pi.registerTool({
    name: "factory_quality_report",
    label: "查看回复质量观测",
    description: [
      "统计员工上下文长度、压缩次数、会话轮次、用户输入长度、输出长度、响应耗时、工具调用次数和情绪评分。",
      "当用户询问“上下文变长是否影响质量”“看看回复质量数据”“压缩后员工表现怎么样”时调用。",
      "会回溯现有 jobs/events/session，可按日期和员工过滤；情绪评分只在开启旁路后产生。",
    ].join(" "),
    parameters: Type.Object({
      date: Type.Optional(Type.String({ description: "统计日期，格式 YYYY-MM-DD；填 all/不填表示全部历史" })),
      worker: Type.Optional(Type.String({ description: "只看某个员工" })),
      limit: Type.Optional(Type.Number({ description: "最多展示多少个 turn 样本，默认 100；全部历史可传较大数字" })),
      format: Type.Optional(
        StringEnum(["markdown", "json"] as const, {
          description: "返回格式，默认 markdown",
          default: "markdown",
        }),
      ),
    }),
    async execute(_tcid, params) {
      try {
        const report = buildFactoryQualityReport({
          workersDir: getWorkersDir(),
          date: params.date,
          worker: params.worker,
          limit: params.limit ?? 100,
        });
        const text = params.format === "json"
          ? JSON.stringify(report, null, 2)
          : formatFactoryQualityReport(report);
        return {
          content: [{ type: "text", text }],
          details: { report },
        };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `❌ 回复质量观测生成失败: ${e.message}` }],
          isError: true,
          details: {},
        };
      }
    },
  });

  // ═══════════════════════════════════════════════════════
  // factory_quality_monitor_config — 情绪评分旁路开关
  // ═══════════════════════════════════════════════════════
  pi.registerTool({
    name: "factory_quality_monitor_config",
    label: "配置质量监控",
    description: [
      "配置用户情绪评分旁路。主 agent 可以用它开启/关闭评分。",
      "开启后，新的后台 job/talk/command 完成时会用指定 OpenAI-compatible Chat Completions endpoint 对用户输入打 1~5 分。",
      "1=强烈不满，3=中性，5=非常满意；只保存分数、标签和简短原因，不保存 API key。",
    ].join(" "),
    parameters: Type.Object({
      enabled: Type.Optional(Type.Boolean({ description: "是否开启情绪评分旁路" })),
      provider: Type.Optional(
        StringEnum(["deepseek", "minimax", "custom"] as const, {
          description: "评分提供方标记。默认 deepseek；custom 表示自定义 OpenAI-compatible endpoint",
        }),
      ),
      endpoint: Type.Optional(Type.String({ description: "OpenAI-compatible Chat Completions endpoint" })),
      model: Type.Optional(Type.String({ description: "评分模型，例如 deepseek-chat" })),
      apiKeyEnv: Type.Optional(Type.String({ description: "读取 API key 的环境变量名，例如 DEEPSEEK_API_KEY" })),
      updatedBy: Type.Optional(Type.String({ description: "配置人，默认 主agent" })),
    }),
    async execute(_tcid, params) {
      try {
        const patch: Record<string, unknown> = {};
        for (const key of ["enabled", "provider", "endpoint", "model", "apiKeyEnv", "updatedBy"] as const) {
          if (params[key] !== undefined) patch[key] = params[key];
        }
        if (patch.updatedBy == null) patch.updatedBy = "主agent";
        const config = Object.keys(patch).length > 1 || params.enabled !== undefined
          ? writeQualityMonitorConfig(getWorkersDir(), patch)
          : readQualityMonitorConfig(getWorkersDir());
        const status = config.enabled ? "开启" : "关闭";
        const envHint = process.env[config.apiKeyEnv] ? "已检测到环境变量" : `未检测到环境变量 ${config.apiKeyEnv}`;
        return {
          content: [{
            type: "text",
            text: [
              `✅ 回复质量情绪评分旁路：${status}`,
              "",
              `- provider: ${config.provider}`,
              `- model: ${config.model}`,
              `- endpoint: ${config.endpoint}`,
              `- apiKeyEnv: ${config.apiKeyEnv}（${envHint}）`,
              `- scale: ${config.scoreScale}`,
              `- updatedAt: ${config.updatedAt || "—"}`,
              "",
              "说明：JSON/API key 不会写入仓库；历史 job 可回溯基础指标，情绪分只对开启后的新 turn 自动记录。",
            ].join("\n"),
          }],
          details: { config },
        };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `❌ 质量监控配置失败: ${e.message}` }],
          isError: true,
          details: {},
        };
      }
    },
  });

  // ═══════════════════════════════════════════════════════
  // factory_compaction_report — Pi vs Codex shadow 压缩对比
  // ═══════════════════════════════════════════════════════
  pi.registerTool({
    name: "factory_compaction_report",
    label: "查看压缩对比",
    description: [
      "查看 Pi 默认压缩与 Codex shadow 压缩的对比记录。",
      "当用户询问“压缩效果怎么样”“看看最近压缩对比”“Codex 压缩比 Pi 好吗”“主 agent 压缩效果怎么样”时调用。",
      "只读 .pi/workers/compaction-shadow.jsonl，不触发新的压缩。",
    ].join(" "),
    parameters: Type.Object({
      worker: Type.Optional(Type.String({ description: "只看某个员工" })),
      target: Type.Optional(
        StringEnum(["main", "worker"] as const, {
          description: "只看主 agent 或员工；默认全部",
        }),
      ),
      limit: Type.Optional(Type.Number({ description: "最近记录数量，默认 20" })),
      format: Type.Optional(
        StringEnum(["markdown", "json"] as const, {
          description: "返回格式，默认 markdown",
          default: "markdown",
        }),
      ),
    }),
    async execute(_tcid, params) {
      try {
        const report = buildFactoryCompactionReport({
          workersDir: getWorkersDir(),
          worker: params.worker,
          targetType: params.target,
          limit: params.limit ?? 20,
        });
        const text = params.format === "json"
          ? JSON.stringify(report, null, 2)
          : formatFactoryCompactionReport(report);
        return {
          content: [{ type: "text", text }],
          details: { report },
        };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `❌ 压缩对比报告生成失败: ${e.message}` }],
          isError: true,
          details: {},
        };
      }
    },
  });

  // ═══════════════════════════════════════════════════════
  // factory_permission_* — 授权式通信权限
  // ═══════════════════════════════════════════════════════
  pi.registerTool({
    name: "factory_permission_grant",
    label: "授予员工权限",
    description: [
      "授予员工对其他员工的通信/协作权限。",
      "默认由秘书授权；未授权员工不能主动联系其他员工。",
      "当前只落地消息通信权限，work:* 作为后续派活权限预留。",
    ].join(" "),
    parameters: Type.Object({
      subject: Type.String({ description: "被授权员工，例如 Alice、Bob" }),
      actions: Type.Array(PermissionActionSchema, { description: "授权动作，如 message:send、message:broadcast" }),
      targets: Type.Array(Type.String(), { description: "目标员工列表；* 表示全员/广播" }),
      grantedBy: Type.Optional(Type.String({ description: "授权人，默认秘书" })),
      note: Type.Optional(Type.String({ description: "授权原因/备注" })),
    }),
    async execute(_tcid, params) {
      try {
        const grantedBy = params.grantedBy || "秘书";
        if (!hasPermission(getWorkersDir(), { subject: grantedBy, action: "permission:manage", target: params.subject })) {
          return {
            content: [{ type: "text", text: `❌ ${grantedBy} 没有权限给 ${params.subject} 授权。` }],
            isError: true,
            details: {},
          };
        }
        const grant = grantPermission(getWorkersDir(), {
          subject: params.subject,
          actions: params.actions,
          targets: params.targets,
          grantedBy,
          note: params.note,
        });
        return {
          content: [
            {
              type: "text",
              text: [
                "✅ 已授予权限",
                "",
                `- 对象: ${grant.subject}`,
                `- 动作: ${grant.actions.join(", ")}`,
                `- 目标: ${grant.targets.join(", ")}`,
                `- 授权人: ${grant.grantedBy}`,
                grant.note ? `- 备注: ${grant.note}` : "",
              ].filter(Boolean).join("\n"),
            },
          ],
          details: { grant },
        };
      } catch (e: any) {
        return { content: [{ type: "text", text: `❌ 授权失败: ${e.message}` }], isError: true, details: {} };
      }
    },
  });

  pi.registerTool({
    name: "factory_permission_revoke",
    label: "撤销员工权限",
    description: "撤销员工通信/协作权限。未指定 actions/targets 时，撤销该员工匹配范围内的授权。",
    parameters: Type.Object({
      subject: Type.String({ description: "被撤权员工" }),
      actions: Type.Optional(Type.Array(PermissionActionSchema, { description: "要撤销的动作；不填表示该员工所有动作" })),
      targets: Type.Optional(Type.Array(Type.String(), { description: "要撤销的目标；不填表示该员工所有目标" })),
      revokedBy: Type.Optional(Type.String({ description: "撤销人，默认秘书" })),
    }),
    async execute(_tcid, params) {
      try {
        const revokedBy = params.revokedBy || "秘书";
        if (!hasPermission(getWorkersDir(), { subject: revokedBy, action: "permission:manage", target: params.subject })) {
          return {
            content: [{ type: "text", text: `❌ ${revokedBy} 没有权限撤销 ${params.subject} 的授权。` }],
            isError: true,
            details: {},
          };
        }
        const revoked = revokePermission(getWorkersDir(), {
          subject: params.subject,
          actions: params.actions,
          targets: params.targets,
          revokedBy,
        });
        return {
          content: [{ type: "text", text: `✅ 已撤销 ${revoked.length} 条授权。` }],
          details: { revoked },
        };
      } catch (e: any) {
        return { content: [{ type: "text", text: `❌ 撤权失败: ${e.message}` }], isError: true, details: {} };
      }
    },
  });

  pi.registerTool({
    name: "factory_permission_list",
    label: "查看员工权限",
    description: "查看当前员工通信/协作授权列表。",
    parameters: Type.Object({
      subject: Type.Optional(Type.String({ description: "只看某个员工" })),
    }),
    async execute(_tcid, params) {
      const grants = listPermissions(getWorkersDir(), { subject: params.subject });
      return {
        content: [{ type: "text", text: `## 员工授权\n\n${formatPermissions(grants)}` }],
        details: { grants },
      };
    },
  });

  pi.registerTool({
    name: "factory_permission_check",
    label: "检查员工权限",
    description: "检查某个员工是否有对目标执行某动作的权限。",
    parameters: Type.Object({
      subject: Type.String({ description: "员工/主体" }),
      action: PermissionActionSchema,
      target: Type.String({ description: "目标员工或 *" }),
    }),
    async execute(_tcid, params) {
      const allowed = hasPermission(getWorkersDir(), {
        subject: params.subject,
        action: params.action,
        target: params.target,
      });
      return {
        content: [{ type: "text", text: allowed ? "✅ 允许" : "⛔ 未授权" }],
        details: { allowed },
      };
    },
  });

  // ═══════════════════════════════════════════════════════
  // factory_message_* — 授权式员工消息
  // ═══════════════════════════════════════════════════════
  pi.registerTool({
    name: "factory_message_send",
    label: "发送员工消息",
    description: [
      "向员工发送授权消息。秘书默认可发；普通员工必须先被授予 message:send 或 message:broadcast。",
      "未授权时直接拒绝，不走审批队列。",
    ].join(" "),
    parameters: Type.Object({
      from: Type.Optional(Type.String({ description: "发送者，默认秘书；普通员工需要授权" })),
      to: Type.String({ description: "接收员工；* 表示广播给全员，需要 message:broadcast" }),
      content: Type.String({ description: "消息内容" }),
      wake: Type.Optional(Type.Boolean({ description: "是否为单个收件人创建 inbox 回调 job；默认 false", default: false })),
      wakeMode: Type.Optional(
        StringEnum(["queue", "steer"] as const, {
          description: "wake job 的排队方式。queue=排到队尾；steer=Codex 有 active turn 时插入当前 turn，Pi/无 active turn 时排在当前 job 后优先",
          default: "queue",
        }),
      ),
      project: Type.Optional(Type.String({ description: "wake job 的项目名，默认 factory-inbox" })),
    }),
    async execute(_tcid, params) {
      try {
        const from = params.from || "秘书";
        if (!isFactoryAdmin(getWorkersDir(), from)) {
          const sender = workers.get(from);
          if (!sender || sender.status === "fired") {
            return { content: [{ type: "text", text: `❌ 发送者 ${from} 不存在或已离职。` }], isError: true, details: {} };
          }
        }
        if (params.to !== "*" && !workers.has(params.to)) {
          return { content: [{ type: "text", text: `❌ 接收者 ${params.to} 不存在。` }], isError: true, details: {} };
        }
        const message = sendAuthorizedMessage(getWorkersDir(), {
          from,
          to: params.to,
          content: params.content,
        });
        let wakeResult: { jobId?: string; status: "skipped" | "queued" | "denied"; reason?: string; placement?: string; mode?: string } = { status: "skipped" };
        if (params.wake) {
          if (params.to === "*") {
            wakeResult = { status: "denied", reason: "广播消息默认不自动唤醒全员；请单独指定员工或后续使用 wakeTargets 白名单" };
          } else if (!hasPermission(getWorkersDir(), { subject: from, action: "work:assign", target: params.to })) {
            wakeResult = { status: "denied", reason: `${from} 没有权限对 ${params.to} 执行 work:assign` };
          } else {
            const target = workers.get(params.to);
            const availability = workerCanAcceptWork(target, params.to);
            if (!availability.ok) {
              wakeResult = { status: "denied", reason: availability.reason };
            } else {
              const task = [
                `你收到一条来自 ${from} 的工厂消息。`,
                ``,
                `message id: ${message.id}`,
                ``,
                `消息内容：`,
                params.content,
                ``,
                `请先查看你的收件箱，重点处理这条消息。`,
                `如果这是问题，请回复；如果这是任务，请执行并把结果用工厂消息回给 ${from}。`,
              ].join("\n");
              const { job, deliveryMode, placement } = enqueueWorkerCommand({
                worker: target,
                task,
                project: params.project || "factory-inbox",
                mode: params.wakeMode || "queue",
                kind: "inbox",
                sourceMessageId: message.id,
                source: "message_wake",
                displayChannel: "talk",
                assignedBy: from,
                returnTo: from,
              });
              wakeResult = { status: "queued", jobId: job.id, placement, mode: deliveryMode };
            }
          }
        }
        return {
          content: [
            {
              type: "text",
              text: [
                "📨 消息已发送",
                "",
                `- id: \`${message.id}\``,
                `- from: ${message.from}`,
                `- to: ${message.to}`,
                params.wake ? `- wake: ${wakeResult.status}${wakeResult.jobId ? ` (${wakeResult.jobId})` : wakeResult.reason ? ` — ${wakeResult.reason}` : ""}` : null,
                "",
                message.content,
              ].filter(Boolean).join("\n"),
            },
          ],
          details: { message, wake: wakeResult },
        };
      } catch (e: any) {
        return { content: [{ type: "text", text: `❌ 发送失败: ${e.message}` }], isError: true, details: {} };
      }
    },
  });

  pi.registerTool({
    name: "factory_inbox",
    label: "员工收件箱",
    description: "查看员工收件箱。广播消息会出现在所有员工 inbox 中。",
    parameters: Type.Object({
      worker: Type.String({ description: "员工姓名" }),
      unreadOnly: Type.Optional(Type.Boolean({ description: "只看未读，默认 false" })),
      includeSent: Type.Optional(Type.Boolean({ description: "是否包含该员工发出的消息，默认 false" })),
      markRead: Type.Optional(Type.Boolean({ description: "展示后标记为已读，默认 false" })),
      limit: Type.Optional(Type.Number({ description: "最多返回数量，默认 50", default: 50 })),
    }),
    async execute(_tcid, params) {
      try {
        if (!workers.has(params.worker)) {
          return { content: [{ type: "text", text: `❌ 员工 ${params.worker} 不存在。` }], isError: true, details: {} };
        }
        const messages = listMessages(getWorkersDir(), {
          worker: params.worker,
          unreadOnly: params.unreadOnly ?? false,
          includeSent: params.includeSent ?? false,
          limit: params.limit ?? 50,
        });
        if (params.markRead) {
          for (const message of messages) {
            if (!message.read) markMessageRead(getWorkersDir(), { messageId: message.id, worker: params.worker });
          }
        }
        return {
          content: [{ type: "text", text: formatMessages(messages, `${params.worker} 的收件箱`) }],
          details: { messages },
        };
      } catch (e: any) {
        return { content: [{ type: "text", text: `❌ 查询收件箱失败: ${e.message}` }], isError: true, details: {} };
      }
    },
  });

  pi.registerTool({
    name: "factory_message_read",
    label: "标记消息已读",
    description: "将某条员工消息标记为已读。",
    parameters: Type.Object({
      worker: Type.String({ description: "员工姓名" }),
      messageId: Type.String({ description: "消息 id" }),
    }),
    async execute(_tcid, params) {
      try {
        const event = markMessageRead(getWorkersDir(), { worker: params.worker, messageId: params.messageId });
        return {
          content: [{ type: "text", text: `✅ 已标记已读: ${params.messageId}` }],
          details: { event },
        };
      } catch (e: any) {
        return { content: [{ type: "text", text: `❌ 标记失败: ${e.message}` }], isError: true, details: {} };
      }
    },
  });

  // ═══════════════════════════════════════════════════════
  // factory_jobs — 查看后台 jobs
  // ═══════════════════════════════════════════════════════
  pi.registerTool({
    name: "factory_jobs",
    label: "后台任务",
    description: "查看员工后台 job 列表，包括 dispatch/talk 的运行、完成和失败状态。",
    parameters: Type.Object({
      worker: Type.Optional(Type.String({ description: "只看某个员工" })),
      status: Type.Optional(
        StringEnum(["queued", "running", "orphan-running", "done", "failed", "aborted", "stale", "all"] as const, {
          description: "状态过滤，默认 all",
          default: "all",
        }),
      ),
      limit: Type.Optional(Type.Number({ description: "最多返回数量，默认 12", default: 12 })),
    }),
    async execute(_tcid, params) {
      const status = params.status && params.status !== "all" ? params.status : undefined;
      const jobs = listJobs(getWorkersDir(), { worker: params.worker, status, limit: params.limit ?? 12 }).reverse();
      if (jobs.length === 0) {
        return { content: [{ type: "text", text: "暂无匹配的后台 job。" }], details: { jobs: [] } };
      }
      return {
        content: [{ type: "text", text: ["## 后台 Jobs", "", ...jobs.map((job: any) => `- ${formatJobLine(job)}`)].join("\n") }],
        details: { jobs },
      };
    },
  });

  // ═══════════════════════════════════════════════════════
  // factory_pick — 随机查看一个未读 job 成果
  // ═══════════════════════════════════════════════════════
  pi.registerTool({
    name: "factory_pick",
    label: "Pick 未读成果",
    description: [
      "从员工后台 job 里挑一个未读的终态成果，适合用户说“pick 一个结果看看”“看看有没有没读的员工结果”。",
      "默认随机挑选并标记已读；完整记录可继续用 factory_attach 或 /attach 查看。",
    ].join(" "),
    parameters: Type.Object({
      worker: Type.Optional(Type.String({ description: "只 pick 某个员工" })),
      project: Type.Optional(Type.String({ description: "只 pick 某个项目" })),
      status: Type.Optional(
        StringEnum(["done", "failed", "aborted", "stale", "all"] as const, {
          description: "终态过滤，默认 all",
          default: "all",
        }),
      ),
      mode: Type.Optional(
        StringEnum(["random", "latest"] as const, {
          description: "random=随机未读；latest=最近未读",
          default: "random",
        }),
      ),
      markRead: Type.Optional(Type.Boolean({ description: "展示后是否标记已读，默认 true", default: true })),
      limit: Type.Optional(Type.Number({ description: "扫描最近多少个 job，默认 200", default: 200 })),
    }),
    async execute(_tcid, params) {
      const picked = pickUnreadJob(getWorkersDir(), {
        worker: params.worker,
        project: params.project,
        status: params.status || "all",
        mode: params.mode || "random",
        markRead: params.markRead !== false,
        readBy: "factory_pick",
        limit: params.limit ?? 200,
      });
      if (!picked) {
        return { content: [{ type: "text", text: "暂无未读 job。" }], details: { picked: null } };
      }
      return {
        content: [{ type: "text", text: formatPickedJob(picked) }],
        details: {
          job: picked.job,
          readEvent: picked.readEvent,
          unreadCount: picked.unreadCount,
        },
      };
    },
  });

  // ═══════════════════════════════════════════════════════
  // factory_attach — 查看 job 事件
  // ═══════════════════════════════════════════════════════
  pi.registerTool({
    name: "factory_attach",
    label: "查看任务",
    description: "查看某个后台 job 的详情和最近事件。jobId 可用前缀。",
    parameters: Type.Object({
      jobId: Type.String({ description: "job id 或前缀" }),
      tail: Type.Optional(Type.Number({ description: "事件条数，默认 80", default: 80 })),
    }),
    async execute(_tcid, params) {
      const job = findJob(params.jobId);
      if (!job) {
        return { content: [{ type: "text", text: `❌ 找不到 job: ${params.jobId}` }], isError: true, details: {} };
      }
      const events = tailJobEvents(job, params.tail ?? 80);
      return {
        content: [{ type: "text", text: formatJobDetails(job, events) }],
        details: { job, events },
      };
    },
  });

  // ═══════════════════════════════════════════════════════
  // factory_watch — 实时查看 job 事件
  // ═══════════════════════════════════════════════════════
  pi.registerTool({
    name: "factory_watch",
    label: "实时查看任务",
    description: "实时查看某个后台 job 的输出。会在工具面板中动态刷新，jobId 可用前缀。",
    parameters: Type.Object({
      jobId: Type.String({ description: "job id 或前缀" }),
      seconds: Type.Optional(Type.Number({ description: "最多观察秒数，默认 30，最大 300", default: 30 })),
      tail: Type.Optional(Type.Number({ description: "初始展示最近事件条数，默认 40", default: 40 })),
      intervalMs: Type.Optional(Type.Number({ description: "刷新间隔毫秒，默认 1000", default: 1000 })),
    }),
    async execute(_tcid, params, signal, onUpdate) {
      const seedJob = findJob(params.jobId);
      if (!seedJob) {
        return { content: [{ type: "text", text: `❌ 找不到 job: ${params.jobId}` }], isError: true, details: {} };
      }

      const seconds = clampNumber(params.seconds, 30, 1, 300);
      const tail = Math.floor(clampNumber(params.tail, 40, 1, 200));
      const intervalMs = clampNumber(params.intervalMs, 1000, 250, 5000);
      let job = readJob(seedJob.jobFile);

      const allEvents = readJobEventsSince(job, 0, Number.POSITIVE_INFINITY);
      let offset = Math.max(0, allEvents.nextOffset - tail);
      const initialRead = readJobEventsSince(job, offset, Number.POSITIVE_INFINITY);
      let events = initialRead.events.slice(-tail);
      offset = initialRead.nextOffset;

      const flush = () => onUpdate?.({ content: [{ type: "text", text: renderWatch(job, events) }] });
      flush();

      const deadline = Date.now() + seconds * 1000;
      while (!signal?.aborted && !isTerminalJob(job) && Date.now() < deadline) {
        await sleep(intervalMs);
        job = readJob(seedJob.jobFile);
        const next = readJobEventsSince(job, offset, 200);
        if (next.events.length > 0) {
          events = [...events, ...next.events].slice(-200);
          offset = next.nextOffset;
          flush();
        }
      }

      job = readJob(seedJob.jobFile);
      const finalEvents = readJobEventsSince(job, offset, 200);
      if (finalEvents.events.length > 0) {
        events = [...events, ...finalEvents.events].slice(-200);
      }

      return {
        content: [{ type: "text", text: renderWatch(job, events) }],
        details: { job, events },
      };
    },
  });
}

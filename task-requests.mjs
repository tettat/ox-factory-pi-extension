import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

import { settleFactoryTaskExecution } from "./task-board.mjs";

const REQUEST_EVENT_TYPES = new Set(["request"]);
const TERMINAL_STATUSES = new Set(["accepted", "failed", "cancelled", "reported"]);
const DEFAULT_PROCESSING_TIMEOUT_MS = 120_000;

function nowIso() {
  return new Date().toISOString();
}

function toTimeMs(value) {
  const time = Date.parse(String(value || ""));
  return Number.isFinite(time) ? time : 0;
}

function normalizeTimeoutMs(value) {
  const timeout = Number(value);
  return Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_PROCESSING_TIMEOUT_MS;
}

function randomId(prefix = "wtask") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function workerTaskRequestsFile(workersDir) {
  return join(workersDir, "worker-task-requests.jsonl");
}

export function normalizeWorkerTaskMode(value) {
  const mode = String(value || "auto").trim().toLowerCase();
  if (!mode || mode === "auto") return "auto";
  if (mode === "queue") return "queue";
  if (mode === "steer") return "steer";
  if (mode === "now") return "now";
  throw new Error(`不支持的 worker task mode: ${value}`);
}

function appendJsonl(file, entry) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
}

function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function lockName(id) {
  return encodeURIComponent(String(id || "")).replace(/%/g, "_");
}

function lockFile(workersDir, requestId) {
  return join(workersDir, ".locks", "worker-tasks", `${lockName(requestId)}.lock`);
}

function executionLockFile(workersDir, executionKey) {
  return join(workersDir, ".locks", "worker-task-executions", `${lockName(executionKey)}.lock`);
}

function tryAcquireFileLock(file) {
  mkdirSync(dirname(file), { recursive: true });
  try {
    return openSync(file, "wx");
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    try {
      const ageMs = Date.now() - statSync(file).mtimeMs;
      if (ageMs > 120_000) {
        unlinkSync(file);
        return openSync(file, "wx");
      }
    } catch (staleError) {
      if (staleError?.code !== "ENOENT") throw staleError;
      return openSync(file, "wx");
    }
    return null;
  }
}

function tryAcquireRequestLock(workersDir, requestId) {
  const file = lockFile(workersDir, requestId);
  return tryAcquireFileLock(file);
}

function releaseRequestLock(workersDir, requestId, fd) {
  try {
    if (fd != null) closeSync(fd);
  } finally {
    try {
      unlinkSync(lockFile(workersDir, requestId));
    } catch {
      // Best-effort cleanup. Stale locks are reclaimed by tryAcquireRequestLock.
    }
  }
}

export function createWorkerTaskRequest(workersDir, input) {
  const from = String(input?.from || "用户").trim() || "用户";
  const to = String(input?.to || input?.worker || "").trim();
  const task = String(input?.task || input?.message || "").trim();
  const source = String(input?.source || "worker").trim() || "worker";
  const project = String(input?.project || "factory-task").trim() || "factory-task";
  const cwd = input?.cwd == null ? "" : String(input.cwd).trim();
  const mode = normalizeWorkerTaskMode(input?.mode || input?.deliveryMode || "auto");
  const factoryTaskId = String(input?.factoryTaskId || "").trim();
  const executionKey = String(input?.executionKey || "").trim();
  if (!from) throw new Error("from 不能为空");
  if (!to) throw new Error("to 不能为空");
  if (to === "*") throw new Error("派活暂不支持广播目标 *");
  if (!task) throw new Error("task 不能为空");
  const create = () => {
    if (executionKey) {
      const existing = findWorkerTaskRequestByExecutionKey(workersDir, executionKey);
      if (existing) return existing;
    }
    const request = {
      type: "request",
      protocolVersion: 1,
      id: randomId(),
      source,
      from,
      to,
      task,
      project,
      cwd,
      mode,
      permissionAction: "work:assign",
      ...(factoryTaskId ? { factoryTaskId } : {}),
      ...(executionKey ? { executionKey } : {}),
      createdAt: nowIso(),
    };
    appendJsonl(workerTaskRequestsFile(workersDir), request);
    return { ...request, status: "pending" };
  };
  if (!executionKey) return create();

  const file = executionLockFile(workersDir, executionKey);
  const fd = tryAcquireFileLock(file);
  if (fd == null) {
    const existing = findWorkerTaskRequestByExecutionKey(workersDir, executionKey);
    if (existing) return existing;
    throw new Error(`execution ${executionKey} 正在创建派活请求，请稍后重试`);
  }
  try {
    return create();
  } finally {
    try { closeSync(fd); } finally {
      try { unlinkSync(file); } catch {}
    }
  }
}

export function listWorkerTaskRequests(workersDir, { from, to, worker, limit = 200 } = {}) {
  const events = readJsonl(workerTaskRequestsFile(workersDir));
  const byId = new Map();
  const history = new Map();
  for (const event of events) {
    const id = event.id || event.requestId;
    if (!id) continue;
    if (!history.has(id)) history.set(id, []);
    history.get(id).push(event);
    if (REQUEST_EVENT_TYPES.has(event.type)) {
      byId.set(id, {
        ...event,
        status: "pending",
      });
      continue;
    }
    const state = byId.get(id);
    if (!state) continue;
    if (event.type === "claimed") {
      if (state.status === "pending") {
        Object.assign(state, {
          status: "processing",
          claimedAt: event.claimedAt,
          claimedBy: event.claimedBy || null,
        });
      }
    } else if (event.type === "claim_released") {
      if (state.status === "processing") {
        Object.assign(state, {
          status: "pending",
          recoveredAt: event.recoveredAt,
          recoveredBy: event.recoveredBy || null,
          recoveryReason: event.reason || "worker task processing claim timed out",
          previousClaimedAt: state.claimedAt || null,
          previousClaimedBy: state.claimedBy || null,
          claimedAt: null,
          claimedBy: null,
        });
      }
    } else if (event.type === "accepted") {
      Object.assign(state, {
        status: "accepted",
        acceptedAt: event.acceptedAt,
        jobId: event.jobId || null,
        deliveryMode: event.deliveryMode || null,
        resolvedMode: event.deliveryMode || null,
        placement: event.placement || null,
      });
    } else if (event.type === "failed") {
      Object.assign(state, {
        status: "failed",
        failedAt: event.failedAt,
        error: event.error || "worker task request failed",
      });
    } else if (event.type === "edited") {
      Object.assign(state, {
        task: event.task || state.task,
        project: event.project || state.project || "factory-task",
        cwd: event.cwd == null ? state.cwd : event.cwd,
        mode: event.mode || state.mode || "auto",
        editedAt: event.editedAt,
        editedBy: event.from || null,
      });
    } else if (event.type === "cancelled") {
      Object.assign(state, {
        status: "cancelled",
        cancelledAt: event.cancelledAt,
        cancelReason: event.reason || "worker task request cancelled",
        cancelledBy: event.from || null,
      });
    } else if (event.type === "reported") {
      Object.assign(state, {
        status: "reported",
        reportedAt: event.reportedAt,
        jobId: event.jobId || state.jobId || null,
        resultStatus: event.resultStatus || null,
        resultMessageId: event.messageId || null,
        resultSummary: event.summary || "",
      });
    }
  }
  const target = worker || to;
  return [...byId.values()]
    .filter((request) => !from || request.from === from)
    .filter((request) => !target || request.to === target)
    .map((request) => ({ ...request, events: history.get(request.id) || [] }))
    .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")))
    .slice(-Math.max(1, Number(limit) || 200));
}

export function listPendingWorkerTaskRequests(workersDir, { limit = 50 } = {}) {
  return listWorkerTaskRequests(workersDir, { limit: 10000 })
    .filter((request) => request.status === "pending")
    .slice(0, Math.max(1, Number(limit) || 50));
}

export function getWorkerTaskRequest(workersDir, requestId) {
  const id = String(requestId || "").trim();
  if (!id) return null;
  return listWorkerTaskRequests(workersDir, { limit: 10000 }).find((request) => request.id === id) || null;
}

export function findWorkerTaskRequestByExecutionKey(workersDir, executionKey) {
  const key = String(executionKey || "").trim();
  if (!key) return null;
  return listWorkerTaskRequests(workersDir, { limit: 10000 })
    .find((request) => request.executionKey === key) || null;
}

export function claimWorkerTaskRequest(workersDir, { requestId, claimedBy = "pi" } = {}) {
  const id = String(requestId || "").trim();
  if (!id) throw new Error("requestId 不能为空");
  const fd = tryAcquireRequestLock(workersDir, id);
  if (fd == null) return null;
  try {
    const current = getWorkerTaskRequest(workersDir, id);
    if (!current || current.status !== "pending") return null;
    const event = {
      type: "claimed",
      requestId: id,
      claimedAt: nowIso(),
      claimedBy: String(claimedBy || "pi").trim() || "pi",
    };
    appendJsonl(workerTaskRequestsFile(workersDir), event);
    return getWorkerTaskRequest(workersDir, id);
  } finally {
    releaseRequestLock(workersDir, id, fd);
  }
}

export function recoverStaleWorkerTaskRequests(workersDir, {
  timeoutMs = DEFAULT_PROCESSING_TIMEOUT_MS,
  now = new Date(),
  recoveredBy = "pi",
  limit = 1000,
} = {}) {
  const timeout = normalizeTimeoutMs(timeoutMs);
  const nowMs = now instanceof Date ? now.getTime() : toTimeMs(now);
  if (!Number.isFinite(nowMs) || nowMs <= 0) return [];
  const staleRequests = listWorkerTaskRequests(workersDir, { limit: Math.max(1, Number(limit) || 1000) })
    .filter((request) => {
      if (request.status !== "processing") return false;
      const claimedAtMs = toTimeMs(request.claimedAt);
      return claimedAtMs > 0 && nowMs - claimedAtMs >= timeout;
    });
  const recovered = [];
  for (const request of staleRequests) {
    const fd = tryAcquireRequestLock(workersDir, request.id);
    if (fd == null) continue;
    try {
      const current = getWorkerTaskRequest(workersDir, request.id);
      const claimedAtMs = toTimeMs(current?.claimedAt);
      if (!current || current.status !== "processing" || claimedAtMs <= 0 || nowMs - claimedAtMs < timeout) continue;
      appendJsonl(workerTaskRequestsFile(workersDir), {
        type: "claim_released",
        requestId: current.id,
        recoveredAt: new Date(nowMs).toISOString(),
        recoveredBy: String(recoveredBy || "pi").trim() || "pi",
        previousClaimedAt: current.claimedAt || null,
        previousClaimedBy: current.claimedBy || null,
        reason: `processing claim timed out after ${timeout}ms`,
      });
      const next = getWorkerTaskRequest(workersDir, request.id);
      if (next) recovered.push(next);
    } finally {
      releaseRequestLock(workersDir, request.id, fd);
    }
  }
  return recovered;
}

export function acceptWorkerTaskRequest(workersDir, { requestId, jobId, deliveryMode, placement }) {
  const id = String(requestId || "").trim();
  if (!id) throw new Error("requestId 不能为空");
  const current = getWorkerTaskRequest(workersDir, id);
  if (TERMINAL_STATUSES.has(current?.status)) return current;
  const event = {
    type: "accepted",
    requestId: id,
    acceptedAt: nowIso(),
    jobId: jobId || null,
    deliveryMode: deliveryMode || null,
    placement: placement || null,
  };
  appendJsonl(workerTaskRequestsFile(workersDir), event);
  return getWorkerTaskRequest(workersDir, id);
}

export function failWorkerTaskRequest(workersDir, { requestId, error }) {
  const id = String(requestId || "").trim();
  if (!id) throw new Error("requestId 不能为空");
  const current = getWorkerTaskRequest(workersDir, id);
  if (TERMINAL_STATUSES.has(current?.status)) return current;
  const event = {
    type: "failed",
    requestId: id,
    failedAt: nowIso(),
    error: String(error || "worker task request failed"),
  };
  appendJsonl(workerTaskRequestsFile(workersDir), event);
  return getWorkerTaskRequest(workersDir, id);
}

function requirePendingWorkerTaskRequest(workersDir, requestId) {
  const request = getWorkerTaskRequest(workersDir, requestId);
  if (!request) throw new Error(`worker task request not found: ${requestId}`);
  if (request.status !== "pending") throw new Error(`worker task request ${requestId} is ${request.status}, not pending`);
  return request;
}

export function editWorkerTaskRequest(workersDir, { requestId, task, project, cwd, mode, from = "用户" }) {
  const request = requirePendingWorkerTaskRequest(workersDir, requestId);
  const nextTask = task == null ? request.task : String(task || "").trim();
  const nextProject = project == null ? request.project || "factory-task" : String(project || "").trim();
  const nextCwd = cwd == null ? request.cwd || "" : String(cwd || "").trim();
  const nextMode = mode == null ? request.mode || "auto" : normalizeWorkerTaskMode(mode);
  if (!nextTask) throw new Error("task 不能为空");
  const event = {
    type: "edited",
    requestId: request.id,
    from: String(from || "用户").trim() || "用户",
    task: nextTask,
    project: nextProject || "factory-task",
    cwd: nextCwd,
    mode: nextMode,
    editedAt: nowIso(),
  };
  appendJsonl(workerTaskRequestsFile(workersDir), event);
  return getWorkerTaskRequest(workersDir, request.id);
}

export function cancelWorkerTaskRequest(workersDir, { requestId, reason, from = "用户" }) {
  const request = requirePendingWorkerTaskRequest(workersDir, requestId);
  const event = {
    type: "cancelled",
    requestId: request.id,
    from: String(from || "用户").trim() || "用户",
    reason: String(reason || "worker task request cancelled"),
    cancelledAt: nowIso(),
  };
  appendJsonl(workerTaskRequestsFile(workersDir), event);
  if (request.factoryTaskId && request.executionKey) {
    try {
      settleFactoryTaskExecution(workersDir, request.factoryTaskId, {
        executionKey: request.executionKey,
        state: "cancelled",
        jobId: request.jobId,
        error: event.reason,
        actor: event.from,
      });
    } catch (error) {
      appendJsonl(workerTaskRequestsFile(workersDir), {
        type: "factory_task_sync_failed",
        requestId: request.id,
        at: nowIso(),
        error: error?.message || String(error),
      });
    }
  }
  return getWorkerTaskRequest(workersDir, request.id);
}

export function reportWorkerTaskResult(workersDir, { requestId, jobId, messageId, resultStatus, summary }) {
  const id = String(requestId || "").trim();
  if (!id) throw new Error("requestId 不能为空");
  const current = getWorkerTaskRequest(workersDir, id);
  if (!current || current.status === "failed" || current.status === "cancelled") return current;
  const event = {
    type: "reported",
    requestId: id,
    reportedAt: nowIso(),
    jobId: jobId || current.jobId || null,
    messageId: messageId || null,
    resultStatus: resultStatus || "done",
    summary: String(summary || "").trim(),
  };
  appendJsonl(workerTaskRequestsFile(workersDir), event);
  return getWorkerTaskRequest(workersDir, id);
}

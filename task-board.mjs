import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";

const TASK_EVENT_TYPES = new Set([
  "task:created",
  "task:updated",
  "task:split",
  "task:archived",
  "task:restored",
  "task:dispatching",
  "task:request-linked",
  "task:running",
  "task:settled",
]);
const PRIORITIES = new Set(["low", "normal", "high", "urgent"]);
const MODES = new Set(["auto", "queue", "steer", "now"]);
const TERMINAL_EXECUTION_STATES = new Set(["succeeded", "failed", "cancelled"]);
const DEFAULT_DISPATCH_LEASE_MS = 60_000;
const DEFAULT_LOCK_STALE_MS = 120_000;
const MAX_TITLE_CHARS = 240;
const MAX_TEXT_CHARS = 64_000;

function nowIso(now = new Date()) {
  const value = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(value.getTime())) throw new Error("无效时间");
  return value.toISOString();
}

function toTimeMs(value) {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? ms : 0;
}

function randomId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

function clean(value) {
  return String(value ?? "").trim();
}

function normalizeOptionalText(value, name, maxChars = MAX_TEXT_CHARS) {
  if (value == null) return "";
  const text = String(value).trim();
  if (text.length > maxChars) throw new Error(`${name} 过长 (>${maxChars})`);
  return text;
}

function normalizeStatus(value) {
  const status = clean(value || "TODO");
  if (!status) throw new Error("status 不能为空");
  if (status.length > 80) throw new Error("status 过长 (>80)");
  return status;
}

function normalizePriority(value) {
  const priority = clean(value || "normal").toLowerCase();
  if (!PRIORITIES.has(priority)) throw new Error(`不支持的 priority: ${value}`);
  return priority;
}

function normalizeMode(value) {
  const mode = clean(value || "auto").toLowerCase();
  if (!MODES.has(mode)) throw new Error(`不支持的 mode: ${value}`);
  return mode;
}

function normalizeLabels(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error("labels 必须是数组");
  const seen = new Set();
  const labels = [];
  for (const item of value) {
    const label = clean(item);
    if (!label || seen.has(label)) continue;
    if (label.length > 80) throw new Error("label 过长 (>80)");
    seen.add(label);
    labels.push(label);
  }
  if (labels.length > 50) throw new Error("labels 过多 (>50)");
  return labels;
}

function normalizeTriggerAt(value) {
  if (value == null || value === "") return null;
  return nowIso(value);
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
    .filter((event) => event && TASK_EVENT_TYPES.has(event.type));
}

export function factoryTasksFile(workersDir) {
  return join(workersDir, "factory-tasks.jsonl");
}

function lockName(id) {
  return encodeURIComponent(String(id || "")).replace(/%/g, "_");
}

function taskLockFile(workersDir, taskId) {
  return join(workersDir, ".locks", "factory-tasks", `${lockName(taskId)}.lock`);
}

function acquireTaskLock(workersDir, taskId, staleMs = DEFAULT_LOCK_STALE_MS) {
  const file = taskLockFile(workersDir, taskId);
  mkdirSync(dirname(file), { recursive: true });
  try {
    return openSync(file, "wx");
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    try {
      if (Date.now() - statSync(file).mtimeMs > staleMs) {
        unlinkSync(file);
        return openSync(file, "wx");
      }
    } catch (staleError) {
      if (staleError?.code !== "ENOENT") throw staleError;
      return openSync(file, "wx");
    }
    throw new Error(`任务 ${taskId} 正在被其他进程更新，请稍后重试`);
  }
}

function releaseTaskLock(workersDir, taskId, fd) {
  try {
    if (fd != null) closeSync(fd);
  } finally {
    try {
      unlinkSync(taskLockFile(workersDir, taskId));
    } catch {
      // Stale locks are reclaimed by acquireTaskLock.
    }
  }
}

function initialExecution(triggerAt) {
  return {
    state: triggerAt ? "scheduled" : "idle",
    executionKey: null,
    leaseUntil: null,
    taskRequestId: null,
    jobId: null,
    startedAt: null,
    finishedAt: null,
    resultSummary: "",
    error: "",
  };
}

function baseTask(input, at) {
  const title = normalizeOptionalText(input?.title, "title", MAX_TITLE_CHARS);
  if (!title) throw new Error("title 不能为空");
  const triggerAt = normalizeTriggerAt(input?.triggerAt);
  return {
    id: clean(input?.id) || randomId("ftask"),
    title,
    description: normalizeOptionalText(input?.description, "description"),
    context: normalizeOptionalText(input?.context, "context"),
    project: normalizeOptionalText(input?.project, "project", 240),
    status: normalizeStatus(input?.status),
    assignee: normalizeOptionalText(input?.assignee, "assignee", 160),
    creator: normalizeOptionalText(input?.creator || input?.actor || "用户", "creator", 160) || "用户",
    updatedBy: normalizeOptionalText(input?.creator || input?.actor || "用户", "updatedBy", 160) || "用户",
    priority: normalizePriority(input?.priority),
    labels: normalizeLabels(input?.labels),
    triggerAt,
    mode: normalizeMode(input?.mode),
    parentTaskId: normalizeOptionalText(input?.parentTaskId, "parentTaskId", 240) || null,
    archivedAt: null,
    execution: initialExecution(triggerAt),
    revision: 1,
    createdAt: at,
    updatedAt: at,
  };
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function projectTasks(events) {
  const byId = new Map();
  const history = new Map();
  for (const event of events) {
    const id = event.taskId || event.task?.id;
    if (!id) continue;
    if (!history.has(id)) history.set(id, []);
    history.get(id).push(event);
    if (event.type === "task:created") {
      byId.set(id, clone(event.task));
      continue;
    }
    const task = byId.get(id);
    if (!task) continue;
    if (event.patch && typeof event.patch === "object") Object.assign(task, clone(event.patch));
    if (event.execution && typeof event.execution === "object") {
      task.execution = { ...(task.execution || initialExecution(null)), ...clone(event.execution) };
    }
    task.revision = Number(event.revision || task.revision || 1);
    task.updatedAt = event.at || task.updatedAt;
    task.updatedBy = event.actor || task.updatedBy;
  }

  const children = new Map();
  for (const task of byId.values()) {
    if (!task.parentTaskId) continue;
    if (!children.has(task.parentTaskId)) children.set(task.parentTaskId, []);
    children.get(task.parentTaskId).push(task.id);
  }
  for (const task of byId.values()) {
    task.childTaskIds = children.get(task.id) || [];
  }
  return { byId, history };
}

function readProjection(workersDir) {
  return projectTasks(readJsonl(factoryTasksFile(workersDir)));
}

function requireTask(workersDir, taskId) {
  const task = readProjection(workersDir).byId.get(clean(taskId));
  if (!task) throw new Error(`factory task not found: ${taskId}`);
  return task;
}

export class FactoryTaskConflictError extends Error {
  constructor(taskId, expectedRevision, currentRevision) {
    super(`任务 ${taskId} revision 冲突：期望 ${expectedRevision}，当前 ${currentRevision}`);
    this.name = "FactoryTaskConflictError";
    this.code = "FACTORY_TASK_REVISION_CONFLICT";
    this.taskId = taskId;
    this.expectedRevision = expectedRevision;
    this.currentRevision = currentRevision;
  }
}

function assertRevision(task, expectedRevision) {
  if (expectedRevision == null || expectedRevision === "") return;
  const expected = Number(expectedRevision);
  if (!Number.isInteger(expected) || expected < 1) throw new Error("expectedRevision 必须是正整数");
  if (task.revision !== expected) throw new FactoryTaskConflictError(task.id, expected, task.revision);
}

function appendTaskEvent(workersDir, task, type, { actor, patch, execution, at = new Date(), data } = {}) {
  const eventAt = nowIso(at);
  const revision = Number(task.revision || 0) + 1;
  appendJsonl(factoryTasksFile(workersDir), {
    type,
    taskId: task.id,
    actor: clean(actor || "用户") || "用户",
    at: eventAt,
    revision,
    ...(patch ? { patch } : {}),
    ...(execution ? { execution } : {}),
    ...(data ? { data } : {}),
  });
  return requireTask(workersDir, task.id);
}

export function createFactoryTask(workersDir, input = {}) {
  const at = nowIso(input.now || new Date());
  const task = baseTask(input, at);
  const fd = acquireTaskLock(workersDir, task.id);
  try {
    if (readProjection(workersDir).byId.has(task.id)) throw new Error(`factory task already exists: ${task.id}`);
    appendJsonl(factoryTasksFile(workersDir), {
      type: "task:created",
      taskId: task.id,
      actor: task.creator,
      at,
      revision: 1,
      task,
    });
    return getFactoryTask(workersDir, task.id);
  } finally {
    releaseTaskLock(workersDir, task.id, fd);
  }
}

export function getFactoryTask(workersDir, taskId, { includeEvents = false } = {}) {
  const projection = readProjection(workersDir);
  const task = projection.byId.get(clean(taskId));
  if (!task) return null;
  const result = clone(task);
  if (includeEvents) result.events = clone(projection.history.get(task.id) || []);
  return result;
}

function normalizeFilterValues(value) {
  const values = Array.isArray(value) ? value : value == null || value === "" ? [] : [value];
  return values.map(clean).filter(Boolean);
}

export function listFactoryTasks(workersDir, options = {}) {
  const projects = normalizeFilterValues(options.project || options.projects);
  const statuses = normalizeFilterValues(options.status || options.statuses);
  const assignees = normalizeFilterValues(options.assignee || options.assignees);
  const priorities = normalizeFilterValues(options.priority || options.priorities);
  const executionStates = normalizeFilterValues(options.executionState || options.executionStates);
  const labels = normalizeFilterValues(options.labels);
  const query = clean(options.query).toLocaleLowerCase();
  const parentTaskId = options.parentTaskId == null ? null : clean(options.parentTaskId);
  const limit = Math.min(5000, Math.max(1, Number(options.limit) || 1000));
  const tasks = [...readProjection(workersDir).byId.values()]
    .filter((task) => options.includeArchived === true || !task.archivedAt)
    .filter((task) => !projects.length || projects.includes(task.project))
    .filter((task) => !statuses.length || statuses.includes(task.status))
    .filter((task) => !assignees.length || assignees.includes(task.assignee))
    .filter((task) => !priorities.length || priorities.includes(task.priority))
    .filter((task) => !executionStates.length || executionStates.includes(task.execution?.state || "idle"))
    .filter((task) => !labels.length || labels.every((label) => task.labels.includes(label)))
    .filter((task) => parentTaskId == null || clean(task.parentTaskId) === parentTaskId)
    .filter((task) => {
      if (!query) return true;
      return [task.title, task.description, task.context, task.project, task.status, task.assignee, ...(task.labels || [])]
        .join("\n")
        .toLocaleLowerCase()
        .includes(query);
    })
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  return tasks.slice(-limit).map(clone);
}

export function listFactoryTaskStatuses(workersDir, options = {}) {
  const seen = new Set();
  const statuses = [];
  for (const task of listFactoryTasks(workersDir, { ...options, limit: 5000 })) {
    if (seen.has(task.status)) continue;
    seen.add(task.status);
    statuses.push(task.status);
  }
  return statuses;
}

function normalizeTaskPatch(task, input) {
  const patch = {};
  if (Object.hasOwn(input, "title")) {
    const title = normalizeOptionalText(input.title, "title", MAX_TITLE_CHARS);
    if (!title) throw new Error("title 不能为空");
    patch.title = title;
  }
  if (Object.hasOwn(input, "description")) patch.description = normalizeOptionalText(input.description, "description");
  if (Object.hasOwn(input, "context")) patch.context = normalizeOptionalText(input.context, "context");
  if (Object.hasOwn(input, "project")) patch.project = normalizeOptionalText(input.project, "project", 240);
  if (Object.hasOwn(input, "status")) patch.status = normalizeStatus(input.status);
  if (Object.hasOwn(input, "assignee")) patch.assignee = normalizeOptionalText(input.assignee, "assignee", 160);
  if (Object.hasOwn(input, "priority")) patch.priority = normalizePriority(input.priority);
  if (Object.hasOwn(input, "labels")) patch.labels = normalizeLabels(input.labels);
  if (Object.hasOwn(input, "mode")) patch.mode = normalizeMode(input.mode);
  if (Object.hasOwn(input, "triggerAt")) {
    patch.triggerAt = normalizeTriggerAt(input.triggerAt);
    if (!["dispatching", "queued", "running"].includes(task.execution?.state)) {
      patch.execution = {
        ...(task.execution || initialExecution(null)),
        state: patch.triggerAt ? "scheduled" : "idle",
        executionKey: null,
        leaseUntil: null,
        taskRequestId: null,
        jobId: null,
        startedAt: null,
        finishedAt: null,
        resultSummary: "",
        error: "",
      };
    }
  }
  if (Object.hasOwn(input, "parentTaskId")) {
    const parentTaskId = normalizeOptionalText(input.parentTaskId, "parentTaskId", 240) || null;
    if (parentTaskId === task.id) throw new Error("任务不能把自己设为父任务");
    patch.parentTaskId = parentTaskId;
  }
  return patch;
}

export function updateFactoryTask(workersDir, taskId, input = {}) {
  const id = clean(taskId);
  const fd = acquireTaskLock(workersDir, id);
  try {
    const task = requireTask(workersDir, id);
    assertRevision(task, input.expectedRevision);
    const normalized = normalizeTaskPatch(task, input);
    const execution = normalized.execution;
    delete normalized.execution;
    if (Object.keys(normalized).length === 0 && !execution) return task;
    return appendTaskEvent(workersDir, task, "task:updated", {
      actor: input.updatedBy || input.actor,
      patch: normalized,
      execution,
      at: input.now,
    });
  } finally {
    releaseTaskLock(workersDir, id, fd);
  }
}

export function splitFactoryTask(workersDir, parentTaskId, { children, actor = "用户", expectedRevision, now } = {}) {
  const id = clean(parentTaskId);
  if (!Array.isArray(children) || children.length === 0) throw new Error("children 不能为空");
  if (children.length > 50) throw new Error("一次最多拆分 50 个子任务");
  const fd = acquireTaskLock(workersDir, id);
  try {
    const parent = requireTask(workersDir, id);
    assertRevision(parent, expectedRevision);
    const created = children.map((child) => createFactoryTask(workersDir, {
      ...child,
      project: Object.hasOwn(child || {}, "project") ? child.project : parent.project,
      status: child?.status || "TODO",
      parentTaskId: parent.id,
      creator: actor,
      now,
    }));
    appendTaskEvent(workersDir, parent, "task:split", {
      actor,
      at: now,
      data: { childTaskIds: created.map((child) => child.id) },
    });
    return created;
  } finally {
    releaseTaskLock(workersDir, id, fd);
  }
}

function setArchiveState(workersDir, taskId, { actor = "用户", expectedRevision, archived, now } = {}) {
  const id = clean(taskId);
  const fd = acquireTaskLock(workersDir, id);
  try {
    const task = requireTask(workersDir, id);
    assertRevision(task, expectedRevision);
    if (Boolean(task.archivedAt) === archived) return task;
    const at = nowIso(now || new Date());
    return appendTaskEvent(workersDir, task, archived ? "task:archived" : "task:restored", {
      actor,
      at,
      patch: { archivedAt: archived ? at : null },
    });
  } finally {
    releaseTaskLock(workersDir, id, fd);
  }
}

export function archiveFactoryTask(workersDir, taskId, options = {}) {
  return setArchiveState(workersDir, taskId, { ...options, archived: true });
}

export function restoreFactoryTask(workersDir, taskId, options = {}) {
  return setArchiveState(workersDir, taskId, { ...options, archived: false });
}

function isDispatchLeaseExpired(task, nowMs) {
  return task.execution?.state === "dispatching"
    && toTimeMs(task.execution?.leaseUntil) > 0
    && toTimeMs(task.execution.leaseUntil) <= nowMs;
}

export function listDueFactoryTasks(workersDir, { now = new Date(), limit = 20 } = {}) {
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(nowMs)) throw new Error("无效 now");
  return listFactoryTasks(workersDir, { limit: 5000 })
    .filter((task) => {
      if (!task.assignee || task.archivedAt) return false;
      if (isDispatchLeaseExpired(task, nowMs)) return true;
      if (task.execution?.state !== "scheduled") return false;
      const triggerAtMs = toTimeMs(task.triggerAt);
      return triggerAtMs > 0 && triggerAtMs <= nowMs;
    })
    .sort((a, b) => {
      const aAt = toTimeMs(a.triggerAt) || toTimeMs(a.createdAt);
      const bAt = toTimeMs(b.triggerAt) || toTimeMs(b.createdAt);
      return aAt - bAt;
    })
    .slice(0, Math.max(1, Number(limit) || 20));
}

export function beginFactoryTaskDispatch(workersDir, taskId, options = {}) {
  const id = clean(taskId);
  const fd = acquireTaskLock(workersDir, id);
  try {
    const task = requireTask(workersDir, id);
    assertRevision(task, options.expectedRevision);
    if (task.archivedAt) throw new Error("归档任务不能执行");
    if (!task.assignee) throw new Error("任务没有 assignee，不能执行");
    if (["queued", "running"].includes(task.execution?.state)) throw new Error(`任务正在 ${task.execution.state}，不能重复执行`);
    const at = nowIso(options.now || new Date());
    const nowMs = toTimeMs(at);
    if (task.execution?.state === "scheduled" && toTimeMs(task.triggerAt) > nowMs && options.force !== true) {
      throw new Error(`任务尚未到触发时间 ${task.triggerAt}`);
    }
    const expired = isDispatchLeaseExpired(task, nowMs);
    if (task.execution?.state === "dispatching" && !expired) return task;
    const leaseMs = Math.max(1_000, Number(options.leaseMs) || DEFAULT_DISPATCH_LEASE_MS);
    const executionKey = clean(options.executionKey || (expired && task.execution?.executionKey) || randomId("fexec"));
    const execution = {
      state: "dispatching",
      executionKey,
      leaseUntil: new Date(nowMs + leaseMs).toISOString(),
      taskRequestId: expired ? task.execution?.taskRequestId || null : null,
      jobId: null,
      startedAt: at,
      finishedAt: null,
      resultSummary: "",
      error: "",
    };
    return appendTaskEvent(workersDir, task, "task:dispatching", {
      actor: options.actor,
      at,
      execution,
      data: { recovered: expired },
    });
  } finally {
    releaseTaskLock(workersDir, id, fd);
  }
}

function assertExecutionKey(task, executionKey) {
  const key = clean(executionKey);
  if (!key || task.execution?.executionKey !== key) {
    throw new Error(`executionKey 不匹配：${key || "—"}`);
  }
  return key;
}

export function linkFactoryTaskRequest(workersDir, taskId, options = {}) {
  const id = clean(taskId);
  const fd = acquireTaskLock(workersDir, id);
  try {
    const task = requireTask(workersDir, id);
    assertExecutionKey(task, options.executionKey);
    const requestId = clean(options.requestId);
    if (!requestId) throw new Error("requestId 不能为空");
    if (task.execution?.taskRequestId === requestId && task.execution?.state === "queued") return task;
    return appendTaskEvent(workersDir, task, "task:request-linked", {
      actor: options.actor,
      at: options.now,
      execution: {
        state: "queued",
        executionKey: task.execution.executionKey,
        leaseUntil: null,
        taskRequestId: requestId,
        jobId: task.execution.jobId || null,
      },
    });
  } finally {
    releaseTaskLock(workersDir, id, fd);
  }
}

export function markFactoryTaskQueued(workersDir, taskId, options = {}) {
  const id = clean(taskId);
  const fd = acquireTaskLock(workersDir, id);
  try {
    const task = requireTask(workersDir, id);
    assertExecutionKey(task, options.executionKey);
    const requestId = clean(options.requestId) || task.execution?.taskRequestId;
    const jobId = clean(options.jobId);
    if (!requestId) throw new Error("requestId 不能为空");
    if (!jobId) throw new Error("jobId 不能为空");
    if (["running", "succeeded", "failed", "cancelled"].includes(task.execution?.state)
      && task.execution?.jobId === jobId) return task;
    if (task.execution?.state === "queued" && task.execution?.jobId === jobId) return task;
    return appendTaskEvent(workersDir, task, "task:request-linked", {
      actor: options.actor,
      at: options.now,
      execution: {
        state: "queued",
        executionKey: task.execution.executionKey,
        leaseUntil: null,
        taskRequestId: requestId,
        jobId,
      },
      data: { jobLinked: true },
    });
  } finally {
    releaseTaskLock(workersDir, id, fd);
  }
}

export function markFactoryTaskRunning(workersDir, taskId, options = {}) {
  const id = clean(taskId);
  const fd = acquireTaskLock(workersDir, id);
  try {
    const task = requireTask(workersDir, id);
    assertExecutionKey(task, options.executionKey);
    const jobId = clean(options.jobId);
    if (!jobId) throw new Error("jobId 不能为空");
    if (task.execution?.state === "running" && task.execution?.jobId === jobId) return task;
    return appendTaskEvent(workersDir, task, "task:running", {
      actor: options.actor,
      at: options.now,
      execution: {
        state: "running",
        executionKey: task.execution.executionKey,
        leaseUntil: null,
        taskRequestId: clean(options.requestId) || task.execution.taskRequestId || null,
        jobId,
        startedAt: task.execution.startedAt || nowIso(options.now || new Date()),
        finishedAt: null,
        error: "",
      },
    });
  } finally {
    releaseTaskLock(workersDir, id, fd);
  }
}

export function settleFactoryTaskExecution(workersDir, taskId, options = {}) {
  const id = clean(taskId);
  const fd = acquireTaskLock(workersDir, id);
  try {
    const task = requireTask(workersDir, id);
    assertExecutionKey(task, options.executionKey);
    const state = clean(options.state);
    if (!TERMINAL_EXECUTION_STATES.has(state)) throw new Error(`不支持的执行终态: ${state}`);
    if (TERMINAL_EXECUTION_STATES.has(task.execution?.state) && task.execution?.state === state) return task;
    const at = nowIso(options.now || new Date());
    return appendTaskEvent(workersDir, task, "task:settled", {
      actor: options.actor,
      at,
      execution: {
        state,
        executionKey: task.execution.executionKey,
        leaseUntil: null,
        taskRequestId: task.execution.taskRequestId || null,
        jobId: clean(options.jobId) || task.execution.jobId || null,
        startedAt: task.execution.startedAt || null,
        finishedAt: at,
        resultSummary: normalizeOptionalText(options.summary, "summary", 8_000),
        error: normalizeOptionalText(options.error, "error", 8_000),
      },
    });
  } finally {
    releaseTaskLock(workersDir, id, fd);
  }
}

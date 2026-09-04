import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { TALK_IMAGE_MAX_COUNT } from "./talk-attachments.mjs";

function nowIso() {
  return new Date().toISOString();
}

function randomId(prefix = "wtalk") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

const REQUEST_EVENT_TYPES = new Set(["request", "request_v2"]);

function normalizeAttachments(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error("attachments 必须是数组");
  const byId = new Map();
  for (const attachment of value) {
    const id = String(attachment?.id || "").trim();
    if (!id) throw new Error("attachment id 不能为空");
    byId.set(id, { ...attachment, id });
  }
  const attachments = [...byId.values()];
  if (attachments.length > TALK_IMAGE_MAX_COUNT) {
    throw new Error(`每条消息最多 ${TALK_IMAGE_MAX_COUNT} 张图片`);
  }
  return attachments;
}

export function webTalkRequestsFile(workersDir) {
  return join(workersDir, "web-talk-requests.jsonl");
}

export function webTalkJobControlsFile(workersDir) {
  return join(workersDir, "web-talk-job-controls.jsonl");
}

export function normalizeWebTalkMode(value) {
  const mode = String(value || "auto").trim().toLowerCase();
  if (!mode || mode === "auto") return "auto";
  if (mode === "queue") return "queue";
  if (mode === "steer") return "steer";
  throw new Error(`不支持的 web talk mode: ${value}`);
}

function normalizeControlAction(value) {
  const action = String(value || "").trim().toLowerCase();
  if (action === "cancel" || action === "edit") return action;
  throw new Error(`不支持的 web job control action: ${value}`);
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
  return join(workersDir, ".locks", "web-talk", `${lockName(requestId)}.lock`);
}

function tryAcquireRequestLock(workersDir, requestId) {
  const file = lockFile(workersDir, requestId);
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

export function createWebTalkRequest(workersDir, input) {
  const worker = String(input?.worker || "").trim();
  const message = String(input?.message || "").trim();
  const attachments = normalizeAttachments(input?.attachments);
  const from = String(input?.from || "web").trim() || "web";
  const mode = normalizeWebTalkMode(input?.mode || input?.deliveryMode || "auto");
  if (!worker) throw new Error("worker 不能为空");
  if (!message && attachments.length === 0) throw new Error("message 或 attachments 至少需要一个");
  const request = {
    type: "request_v2",
    protocolVersion: 2,
    id: randomId(),
    source: "web",
    from,
    worker,
    message,
    attachments,
    mode,
    createdAt: nowIso(),
  };
  appendJsonl(webTalkRequestsFile(workersDir), request);
  return { ...request, status: "pending" };
}

export function listWebTalkRequests(workersDir, { worker, limit = 200 } = {}) {
  const events = readJsonl(webTalkRequestsFile(workersDir));
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
        error: event.error || "web talk request failed",
      });
    } else if (event.type === "edited") {
      Object.assign(state, {
        message: Object.prototype.hasOwnProperty.call(event, "message") ? event.message : state.message,
        mode: event.mode || state.mode || "auto",
        editedAt: event.editedAt,
        editedBy: event.from || null,
      });
    } else if (event.type === "cancelled") {
      Object.assign(state, {
        status: "cancelled",
        cancelledAt: event.cancelledAt,
        cancelReason: event.reason || "web talk request cancelled",
        cancelledBy: event.from || null,
      });
    }
  }
  return [...byId.values()]
    .filter((request) => !worker || request.worker === worker)
    .map((request) => ({ ...request, events: history.get(request.id) || [] }))
    .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")))
    .slice(-Math.max(1, Number(limit) || 200));
}

export function listPendingWebTalkRequests(workersDir, { limit = 50 } = {}) {
  return listWebTalkRequests(workersDir, { limit: 10000 })
    .filter((request) => request.status === "pending")
    .slice(0, Math.max(1, Number(limit) || 50));
}

export function getWebTalkRequest(workersDir, requestId) {
  const id = String(requestId || "").trim();
  if (!id) return null;
  return listWebTalkRequests(workersDir, { limit: 10000 }).find((request) => request.id === id) || null;
}

export function claimWebTalkRequest(workersDir, { requestId, claimedBy = "pi" } = {}) {
  const id = String(requestId || "").trim();
  if (!id) throw new Error("requestId 不能为空");
  const fd = tryAcquireRequestLock(workersDir, id);
  if (fd == null) return null;
  try {
    const current = getWebTalkRequest(workersDir, id);
    if (!current || current.status !== "pending") return null;
    const event = {
      type: "claimed",
      requestId: id,
      claimedAt: nowIso(),
      claimedBy: String(claimedBy || "pi").trim() || "pi",
    };
    appendJsonl(webTalkRequestsFile(workersDir), event);
    return getWebTalkRequest(workersDir, id);
  } finally {
    releaseRequestLock(workersDir, id, fd);
  }
}

export function acceptWebTalkRequest(workersDir, { requestId, jobId, deliveryMode, placement }) {
  const id = String(requestId || "").trim();
  if (!id) throw new Error("requestId 不能为空");
  const current = getWebTalkRequest(workersDir, id);
  if (current?.status === "accepted" || current?.status === "failed" || current?.status === "cancelled") return current;
  const event = {
    type: "accepted",
    requestId: id,
    acceptedAt: nowIso(),
    jobId: jobId || null,
    deliveryMode: deliveryMode || null,
    placement: placement || null,
  };
  appendJsonl(webTalkRequestsFile(workersDir), event);
  return getWebTalkRequest(workersDir, id);
}

export function failWebTalkRequest(workersDir, { requestId, error }) {
  const id = String(requestId || "").trim();
  if (!id) throw new Error("requestId 不能为空");
  const current = getWebTalkRequest(workersDir, id);
  if (current?.status === "accepted" || current?.status === "failed" || current?.status === "cancelled") return current;
  const event = {
    type: "failed",
    requestId: id,
    failedAt: nowIso(),
    error: String(error || "web talk request failed"),
  };
  appendJsonl(webTalkRequestsFile(workersDir), event);
  return getWebTalkRequest(workersDir, id);
}

function requirePendingWebTalkRequest(workersDir, requestId) {
  const request = getWebTalkRequest(workersDir, requestId);
  if (!request) throw new Error(`web talk request not found: ${requestId}`);
  if (request.status !== "pending") throw new Error(`web talk request ${requestId} is ${request.status}, not pending`);
  return request;
}

export function editWebTalkRequest(workersDir, { requestId, message, mode, from = "web" }) {
  const request = requirePendingWebTalkRequest(workersDir, requestId);
  const nextMessage = message == null ? request.message : String(message || "").trim();
  const nextMode = mode == null ? request.mode || "auto" : normalizeWebTalkMode(mode);
  if (!nextMessage && (!request.attachments || request.attachments.length === 0)) {
    throw new Error("message 或 attachments 至少需要一个");
  }
  const event = {
    type: "edited",
    requestId: request.id,
    from: String(from || "web").trim() || "web",
    message: nextMessage,
    mode: nextMode,
    editedAt: nowIso(),
  };
  appendJsonl(webTalkRequestsFile(workersDir), event);
  return getWebTalkRequest(workersDir, request.id);
}

export function cancelWebTalkRequest(workersDir, { requestId, reason, from = "web" }) {
  const request = requirePendingWebTalkRequest(workersDir, requestId);
  const event = {
    type: "cancelled",
    requestId: request.id,
    from: String(from || "web").trim() || "web",
    reason: String(reason || "web talk request cancelled"),
    cancelledAt: nowIso(),
  };
  appendJsonl(webTalkRequestsFile(workersDir), event);
  return getWebTalkRequest(workersDir, request.id);
}

export function createWebTalkJobControlRequest(workersDir, input) {
  const action = normalizeControlAction(input?.action);
  const jobId = String(input?.jobId || "").trim();
  const worker = String(input?.worker || "").trim();
  const from = String(input?.from || "web").trim() || "web";
  const message = input?.message == null ? "" : String(input.message).trim();
  const reason = input?.reason == null ? "" : String(input.reason).trim();
  if (!jobId && !worker) throw new Error("jobId 或 worker 至少需要一个");
  if (action === "edit" && !message) throw new Error("edit control message 不能为空");
  const request = {
    type: "request",
    id: randomId("wjobctl"),
    source: "web",
    from,
    action,
    jobId,
    worker,
    message,
    reason,
    createdAt: nowIso(),
  };
  appendJsonl(webTalkJobControlsFile(workersDir), request);
  return { ...request, status: "pending" };
}

export function listWebTalkJobControlRequests(workersDir, { worker, jobId, limit = 200 } = {}) {
  const events = readJsonl(webTalkJobControlsFile(workersDir));
  const byId = new Map();
  const history = new Map();
  for (const event of events) {
    const id = event.id || event.requestId;
    if (!id) continue;
    if (!history.has(id)) history.set(id, []);
    history.get(id).push(event);
    if (event.type === "request") {
      byId.set(id, { ...event, status: "pending" });
      continue;
    }
    const state = byId.get(id);
    if (!state) continue;
    if (event.type === "accepted") {
      Object.assign(state, {
        status: "accepted",
        acceptedAt: event.acceptedAt,
        resultStatus: event.status || null,
        resultMessage: event.message || null,
      });
    } else if (event.type === "failed") {
      Object.assign(state, {
        status: "failed",
        failedAt: event.failedAt,
        error: event.error || "web job control failed",
      });
    }
  }
  return [...byId.values()]
    .filter((request) => !worker || request.worker === worker)
    .filter((request) => !jobId || request.jobId === jobId)
    .map((request) => ({ ...request, events: history.get(request.id) || [] }))
    .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")))
    .slice(-Math.max(1, Number(limit) || 200));
}

export function listPendingWebTalkJobControlRequests(workersDir, { limit = 50 } = {}) {
  return listWebTalkJobControlRequests(workersDir, { limit: 10000 })
    .filter((request) => request.status === "pending")
    .slice(0, Math.max(1, Number(limit) || 50));
}

export function getWebTalkJobControlRequest(workersDir, requestId) {
  const id = String(requestId || "").trim();
  if (!id) return null;
  return listWebTalkJobControlRequests(workersDir, { limit: 10000 }).find((request) => request.id === id) || null;
}

export function acceptWebTalkJobControlRequest(workersDir, { requestId, status, message }) {
  const id = String(requestId || "").trim();
  if (!id) throw new Error("requestId 不能为空");
  const current = getWebTalkJobControlRequest(workersDir, id);
  if (current?.status === "accepted" || current?.status === "failed") return current;
  const event = {
    type: "accepted",
    requestId: id,
    acceptedAt: nowIso(),
    status: status || "ok",
    message: message || "",
  };
  appendJsonl(webTalkJobControlsFile(workersDir), event);
  return getWebTalkJobControlRequest(workersDir, id);
}

export function failWebTalkJobControlRequest(workersDir, { requestId, error }) {
  const id = String(requestId || "").trim();
  if (!id) throw new Error("requestId 不能为空");
  const current = getWebTalkJobControlRequest(workersDir, id);
  if (current?.status === "accepted" || current?.status === "failed") return current;
  const event = {
    type: "failed",
    requestId: id,
    failedAt: nowIso(),
    error: String(error || "web job control failed"),
  };
  appendJsonl(webTalkJobControlsFile(workersDir), event);
  return getWebTalkJobControlRequest(workersDir, id);
}

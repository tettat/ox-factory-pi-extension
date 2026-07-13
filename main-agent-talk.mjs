import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

function nowIso() {
  return new Date().toISOString();
}

function randomId(prefix = "mtalk") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function mainAgentTalkRequestsFile(workersDir) {
  return join(workersDir, "main-agent-talk-requests.jsonl");
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
  return join(workersDir, ".locks", "main-agent-talk", `${lockName(requestId)}.lock`);
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

export function createMainAgentTalkRequest(workersDir, input) {
  const message = String(input?.message || "").trim();
  const from = String(input?.from || "web").trim() || "web";
  if (!message) throw new Error("message 不能为空");
  const request = {
    type: "request",
    id: randomId(),
    source: "web",
    target: "main-agent",
    from,
    message,
    createdAt: nowIso(),
  };
  appendJsonl(mainAgentTalkRequestsFile(workersDir), request);
  return { ...request, status: "pending" };
}

export function listMainAgentTalkRequests(workersDir, { limit = 200 } = {}) {
  const events = readJsonl(mainAgentTalkRequestsFile(workersDir));
  const byId = new Map();
  const history = new Map();
  for (const event of events) {
    const id = event.id || event.requestId;
    if (!id) continue;
    if (!history.has(id)) history.set(id, []);
    history.get(id).push(event);
    if (event.type === "request") {
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
        deliveryMode: event.deliveryMode || null,
        placement: event.placement || null,
      });
    } else if (event.type === "failed") {
      Object.assign(state, {
        status: "failed",
        failedAt: event.failedAt,
        error: event.error || "main agent talk request failed",
      });
    }
  }
  return [...byId.values()]
    .map((request) => ({ ...request, events: history.get(request.id) || [] }))
    .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")))
    .slice(-Math.max(1, Number(limit) || 200));
}

export function listPendingMainAgentTalkRequests(workersDir, { limit = 50 } = {}) {
  return listMainAgentTalkRequests(workersDir, { limit: 10000 })
    .filter((request) => request.status === "pending")
    .slice(0, Math.max(1, Number(limit) || 50));
}

export function getMainAgentTalkRequest(workersDir, requestId) {
  const id = String(requestId || "").trim();
  if (!id) return null;
  return listMainAgentTalkRequests(workersDir, { limit: 10000 }).find((request) => request.id === id) || null;
}

export function claimMainAgentTalkRequest(workersDir, { requestId, claimedBy = "pi" } = {}) {
  const id = String(requestId || "").trim();
  if (!id) throw new Error("requestId 不能为空");
  const fd = tryAcquireRequestLock(workersDir, id);
  if (fd == null) return null;
  try {
    const current = getMainAgentTalkRequest(workersDir, id);
    if (!current || current.status !== "pending") return null;
    const event = {
      type: "claimed",
      requestId: id,
      claimedAt: nowIso(),
      claimedBy: String(claimedBy || "pi").trim() || "pi",
    };
    appendJsonl(mainAgentTalkRequestsFile(workersDir), event);
    return getMainAgentTalkRequest(workersDir, id);
  } finally {
    releaseRequestLock(workersDir, id, fd);
  }
}

export function acceptMainAgentTalkRequest(workersDir, { requestId, deliveryMode, placement }) {
  const id = String(requestId || "").trim();
  if (!id) throw new Error("requestId 不能为空");
  const current = getMainAgentTalkRequest(workersDir, id);
  if (current?.status === "accepted" || current?.status === "failed") return current;
  const event = {
    type: "accepted",
    requestId: id,
    acceptedAt: nowIso(),
    deliveryMode: deliveryMode || null,
    placement: placement || null,
  };
  appendJsonl(mainAgentTalkRequestsFile(workersDir), event);
  return getMainAgentTalkRequest(workersDir, id);
}

export function failMainAgentTalkRequest(workersDir, { requestId, error }) {
  const id = String(requestId || "").trim();
  if (!id) throw new Error("requestId 不能为空");
  const current = getMainAgentTalkRequest(workersDir, id);
  if (current?.status === "accepted" || current?.status === "failed") return current;
  const event = {
    type: "failed",
    requestId: id,
    failedAt: nowIso(),
    error: String(error || "main agent talk request failed"),
  };
  appendJsonl(mainAgentTalkRequestsFile(workersDir), event);
  return getMainAgentTalkRequest(workersDir, id);
}

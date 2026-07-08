import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

function nowIso() {
  return new Date().toISOString();
}

function randomId(prefix = "wtalk") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function webTalkRequestsFile(workersDir) {
  return join(workersDir, "web-talk-requests.jsonl");
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

export function createWebTalkRequest(workersDir, input) {
  const worker = String(input?.worker || "").trim();
  const message = String(input?.message || "").trim();
  const from = String(input?.from || "web").trim() || "web";
  if (!worker) throw new Error("worker 不能为空");
  if (!message) throw new Error("message 不能为空");
  const request = {
    type: "request",
    id: randomId(),
    source: "web",
    from,
    worker,
    message,
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
    if (event.type === "request") {
      byId.set(id, {
        ...event,
        status: "pending",
      });
      continue;
    }
    const state = byId.get(id);
    if (!state) continue;
    if (event.type === "accepted") {
      Object.assign(state, {
        status: "accepted",
        acceptedAt: event.acceptedAt,
        jobId: event.jobId || null,
        deliveryMode: event.deliveryMode || null,
        placement: event.placement || null,
      });
    } else if (event.type === "failed") {
      Object.assign(state, {
        status: "failed",
        failedAt: event.failedAt,
        error: event.error || "web talk request failed",
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

export function acceptWebTalkRequest(workersDir, { requestId, jobId, deliveryMode, placement }) {
  const id = String(requestId || "").trim();
  if (!id) throw new Error("requestId 不能为空");
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
  const event = {
    type: "failed",
    requestId: id,
    failedAt: nowIso(),
    error: String(error || "web talk request failed"),
  };
  appendJsonl(webTalkRequestsFile(workersDir), event);
  return getWebTalkRequest(workersDir, id);
}

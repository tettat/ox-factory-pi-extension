import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

function nowIso() {
  return new Date().toISOString();
}

export function webJobReadFile(workersDir) {
  return join(workersDir, "web-job-read.jsonl");
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

const NON_NOTIFY_EVENT_TYPES = new Set([
  "queued",
  "delivery",
  "started",
  "message_wake",
  "edited",
  "recovery_check",
  "recovered",
]);

const jobEventCursorCache = new Map();

function isNotifiableJobEvent(event) {
  if (!event?.type) return false;
  return !NON_NOTIFY_EVENT_TYPES.has(event.type);
}

export function jobEventCursor(job) {
  if (!job?.eventFile || !existsSync(job.eventFile)) {
    return {
      eventOffset: 0,
      lastEventAt: job?.updatedAt || job?.createdAt || null,
    };
  }
  let stat;
  try {
    stat = statSync(job.eventFile);
  } catch {
    return {
      eventOffset: 0,
      lastEventAt: job?.updatedAt || job?.createdAt || null,
    };
  }
  const cached = jobEventCursorCache.get(job.eventFile);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    return cached.cursor;
  }

  const lines = readFileSync(job.eventFile, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  let eventOffset = 0;
  let lastEvent = null;
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (!isNotifiableJobEvent(event)) continue;
      eventOffset += 1;
      lastEvent = event;
    } catch {
      // Ignore malformed legacy event lines for unread purposes.
    }
  }
  const cursor = {
    eventOffset,
    lastEventAt: lastEvent?.time || job.updatedAt || job.createdAt || null,
  };
  jobEventCursorCache.set(job.eventFile, {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    cursor,
  });
  return cursor;
}

export function readWebJobReadState(workersDir) {
  const state = new Map();
  for (const event of readJsonl(webJobReadFile(workersDir))) {
    if (event.type !== "read" || !event.jobId) continue;
    const previous = state.get(event.jobId);
    if (!previous || Number(event.eventOffset || 0) >= Number(previous.eventOffset || 0)) {
      state.set(event.jobId, event);
    }
  }
  return state;
}

export function markWebJobRead(workersDir, job, { readBy = "web" } = {}) {
  const cursor = jobEventCursor(job);
  const event = {
    type: "read",
    jobId: job.id,
    worker: job.worker || null,
    eventOffset: cursor.eventOffset,
    lastEventAt: cursor.lastEventAt,
    readAt: nowIso(),
    readBy,
  };
  appendJsonl(webJobReadFile(workersDir), event);
  return event;
}

export function buildWorkerJobUnreadSummary(workersDir, jobs = []) {
  const reads = readWebJobReadState(workersDir);
  const byWorker = new Map();
  const byJob = new Map();

  function ensureWorker(worker) {
    const name = worker || "";
    if (!byWorker.has(name)) {
      byWorker.set(name, {
        worker: name,
        unreadJobs: 0,
        unreadEvents: 0,
        lastUnreadAt: null,
        jobs: [],
      });
    }
    return byWorker.get(name);
  }

  for (const job of jobs || []) {
    if (!job?.id) continue;
    const read = reads.get(job.id);
    const readAt = String(read?.readAt || "");
    const jobUpdatedAt = String(job.updatedAt || job.finishedAt || job.createdAt || "");
    // Use a strict timestamp comparison: append/update/read can share the same
    // millisecond in tests and in fast local runs. Equal timestamps are not a
    // safe proof that the read marker is newer than the job events.
    const canTrustReadMarker = Boolean(read && readAt && jobUpdatedAt && jobUpdatedAt.localeCompare(readAt) < 0);
    const cursor = canTrustReadMarker
      ? {
          eventOffset: Number(read.eventOffset || 0),
          lastEventAt: read.lastEventAt || job.updatedAt || job.createdAt || null,
        }
      : jobEventCursor(job);
    const readOffset = Number(read?.eventOffset || 0);
    const unreadEvents = Math.max(0, Number(cursor.eventOffset || 0) - readOffset);
    const unread = unreadEvents > 0;
    const item = {
      jobId: job.id,
      worker: job.worker || "",
      unread,
      unreadEvents,
      eventOffset: cursor.eventOffset,
      readOffset,
      lastUnreadAt: unread ? cursor.lastEventAt : null,
      status: job.status || "",
      task: job.task || "",
    };
    byJob.set(job.id, item);
    const workerState = ensureWorker(job.worker || "");
    if (unread) {
      workerState.unreadJobs += 1;
      workerState.unreadEvents += unreadEvents;
      workerState.jobs.push(item);
      if (!workerState.lastUnreadAt || String(cursor.lastEventAt || "").localeCompare(String(workerState.lastUnreadAt || "")) > 0) {
        workerState.lastUnreadAt = cursor.lastEventAt;
      }
    }
  }

  return { byWorker, byJob };
}

export function markWorkerJobsRead(workersDir, jobs = [], { readBy = "web" } = {}) {
  const summary = buildWorkerJobUnreadSummary(workersDir, jobs);
  const reads = [];
  let unreadEvents = 0;
  for (const job of jobs || []) {
    if (!job?.id) continue;
    const unread = summary.byJob.get(job.id);
    if (!unread?.unread) continue;
    unreadEvents += Number(unread.unreadEvents || 0);
    reads.push(markWebJobRead(workersDir, job, { readBy }));
  }
  return {
    count: reads.length,
    unreadEvents,
    reads,
  };
}

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { codexNotificationToStreamEvents } from "../codex-backend.mjs";
import { appendJobEvent, compactJobTimelineEvents, createJob, formatJobEvent, latestReplyFromEvents, tailJobEvents } from "../jobs.mjs";

function compact(method) {
  return codexNotificationToStreamEvents({ method, params: { threadId: "thread-test", turnId: "turn-test", item: { id: "compact-test", type: "contextCompaction" } } });
}

test("Codex compaction lifecycle is visible without becoming an assistant reply", () => {
  const [started] = compact("item/started");
  const [completed] = compact("item/completed");
  assert.deepEqual({ type: started.type, phase: started.phase, itemId: started.itemId }, { type: "compaction", phase: "started", itemId: "compact-test" });
  assert.equal(completed.phase, "completed");
  assert.equal(completed.itemId, started.itemId);
  assert.match(formatJobEvent(started), /^\[compact:started\]/);
  assert.match(formatJobEvent(completed), /^\[compact:completed\]/);
  assert.equal(latestReplyFromEvents([started, completed]), "");
  const timeline = compactJobTimelineEvents([{ type: "text", text: "before" }, started, completed, { type: "text", text: "after" }]);
  assert.deepEqual(timeline.map((e) => e.type), ["text", "compaction", "compaction", "text"]);
});

test("Codex retry flag survives mapping and terminal errors remain errors", () => {
  for (const willRetry of [true, false, undefined]) {
    const params = { error: { message: "idle timeout waiting for SSE" }, ...(willRetry === undefined ? {} : { willRetry }) };
    const [event] = codexNotificationToStreamEvents({ method: "error", params });
    assert.equal(event.type, "error");
    assert.equal(event.message, params.error.message);
    assert.equal(event.willRetry, willRetry);
    assert.match(formatJobEvent(event), willRetry === true ? /^\[retry\]/ : /^\[error\]/);
  }
  // Never infer a retry (or success) from an error's free-form message.
  const [legacy] = codexNotificationToStreamEvents({ method: "error", params: { message: "Reconnecting... 1/2" } });
  assert.equal(Object.hasOwn(legacy, "willRetry"), false);
});

test("Compaction and retry events round-trip through the official job event store", () => {
  const dir = mkdtempSync(join(tmpdir(), "ox-compact-event-"));
  try {
    const job = createJob(dir, { kind: "talk", worker: "fixture", project: "test", task: "no real employee" });
    const events = [...compact("item/started"), ...codexNotificationToStreamEvents({ method: "error", params: { error: { message: "Reconnecting... 1/2" }, willRetry: true } }), ...compact("item/completed")];
    for (const event of events) appendJobEvent(job, event);
    const saved = tailJobEvents(job, 20).filter((e) => e.type === "compaction" || e.type === "error");
    assert.deepEqual(saved.map(({ type, phase, willRetry }) => ({ type, phase, willRetry })), events.map(({ type, phase, willRetry }) => ({ type, phase, willRetry })));
    assert.equal(job.status, "queued");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { mergeHubWorkers } from "../device-hub-client.mjs";

test("original factory worker list merges only workers from other hub devices", () => {
  const local = [{ name: "Codex", displayName: "牛来" }];
  const merged = mergeHubWorkers(local, {
    connection: { localDeviceId: "local" },
    state: { devices: [
      { id: "local", name: "书房电脑", online: true, workers: [{ id: "Codex" }] },
      { id: "laptop", name: "笔记本", online: true, lastSeenAt: "2026-09-06T00:00:00Z", workers: [{ id: "Kimi", displayName: "柯南", backend: "kimi", status: "idle" }] },
    ] },
  });
  assert.equal(merged.length, 2);
  assert.equal(merged[1].displayName, "柯南");
  assert.equal(merged[1].deviceName, "笔记本");
  assert.equal(merged[1].remote, true);
  assert.match(merged[1].name, /^remote:laptop:Kimi$/);
});

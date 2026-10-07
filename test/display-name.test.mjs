import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { scanWorkerEntries } from "../worker-registry-snapshot.mjs";

test("worker displayName survives hire and config events without changing id", () => {
  const map = scanWorkerEntries([
    { type: "custom", customType: "ox-worker-hire", data: { workerId: "Codex", role: "programmer" } },
    { type: "custom", customType: "ox-worker-config", data: { workerId: "Codex", displayName: "牛来" } },
  ]);
  assert.equal(map.get("Codex").id, "Codex");
  assert.equal(map.get("Codex").displayName, "牛来");
});

test("web API and UI expose displayName while keeping worker name for routes", () => {
  const root = new URL("..", import.meta.url);
  const server = readFileSync(new URL("web-server.mjs", root), "utf8");
  const app = readFileSync(new URL("web/app.js", root), "utf8");
  assert.match(server, /displayName:\s*workerDisplayName\(name, regInfo\)/);
  assert.match(app, /function workerDisplayName/);
  assert.match(app, /value: worker\.name, text: workerDisplayName\(worker\)/);
});

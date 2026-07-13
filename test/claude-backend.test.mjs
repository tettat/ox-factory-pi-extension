import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runClaudeWorkerStreaming } from "../claude-backend.mjs";
import { scanWorkerEntries } from "../worker-registry-snapshot.mjs";

function makeWorker(overrides = {}) {
  return {
    id: "克劳",
    sessionFile: "",
    role: "programmer",
    backend: "claude",
    model: "model_api/test",
    thinking: "xhigh",
    claudeSessionId: "11111111-1111-4111-8111-111111111111",
    claudeSessionInitialized: false,
    claudePermissionMode: "dontAsk",
    status: "idle",
    hired: "2026-07-11",
    projects: [],
    promotions: [],
    responsibilities: [],
    ...overrides,
  };
}

function createFakeClaude(tmp, scriptBody) {
  const script = join(tmp, "fake-claude.mjs");
  const argvLog = join(tmp, "argv.json");
  writeFileSync(script, `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nconst argvLog = ${JSON.stringify(argvLog)};\nwriteFileSync(argvLog, JSON.stringify(process.argv.slice(2)));\n${scriptBody}\n`, "utf-8");
  chmodSync(script, 0o755);
  return { script, argvLog };
}

const fakeSuccessBody = `
const sessionArgIndex = process.argv.indexOf('--session-id');
const resumeArgIndex = process.argv.indexOf('--resume');
const sessionId = sessionArgIndex >= 0 ? process.argv[sessionArgIndex + 1] : process.argv[resumeArgIndex + 1];
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId, model: 'model_api/test' }));
console.log(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '想一下' } } }));
console.log(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } } }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'Hello', stop_reason: 'end_turn', session_id: sessionId, usage: { input_tokens: 10, cache_read_input_tokens: 2, cache_creation_input_tokens: 1, output_tokens: 4 } }));
`;

test("Claude backend first run uses --session-id, streams output, and maps token usage", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "ox-claude-test-"));
  try {
    mkdirSync(join(tmp, "workers"), { recursive: true });
    const { script, argvLog } = createFakeClaude(tmp, fakeSuccessBody);
    const worker = makeWorker({ claudeCommand: script });
    const events = [];
    const patches = [];

    const result = await runClaudeWorkerStreaming({
      worker,
      task: "Say hello",
      project: "talk",
      cwd: tmp,
      workersDir: join(tmp, "workers"),
      agentDef: "",
      onWorkerPatch: (patch) => patches.push(patch),
    }, (event) => events.push(event));

    const argv = JSON.parse(readFileSync(argvLog, "utf-8"));
    assert.equal(argv.includes("--session-id"), true);
    assert.equal(argv.includes(worker.claudeSessionId), true);
    assert.equal(argv.includes("--resume"), false);
    assert.equal(argv.includes("--continue"), false);
    assert.equal(argv.includes("--model"), true);
    assert.equal(argv.includes("model_api/test"), true);
    assert.equal(argv.includes("--effort"), true);
    assert.equal(argv.includes("xhigh"), true);

    assert.equal(result.exitCode, 0);
    assert.equal(result.output, "Hello");
    assert.equal(result.turns, 1);
    assert.equal(result.inputTokens, 10);
    assert.equal(result.cachedInputTokens, 3);
    assert.equal(result.outputTokens, 4);
    assert.equal(result.totalTokens, 14);
    assert.equal(result.model, "model_api/test");
    assert.equal(result.claudeSessionId, worker.claudeSessionId);
    assert.deepEqual(events.map((event) => event.type), ["claude_session", "thinking", "text", "done"]);
    assert.equal(patches.some((patch) => patch.claudeSessionInitialized === true), true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("Claude backend initialized worker resumes the stored session instead of creating a new one", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "ox-claude-test-"));
  try {
    mkdirSync(join(tmp, "workers"), { recursive: true });
    const { script, argvLog } = createFakeClaude(tmp, fakeSuccessBody);
    const worker = makeWorker({ claudeCommand: script, claudeSessionInitialized: true });

    await runClaudeWorkerStreaming({
      worker,
      task: "Continue",
      project: "talk",
      cwd: tmp,
      workersDir: join(tmp, "workers"),
      agentDef: "",
      onWorkerPatch: () => {},
    }, () => {});

    const argv = JSON.parse(readFileSync(argvLog, "utf-8"));
    assert.equal(argv.includes("--resume"), true);
    assert.equal(argv.includes(worker.claudeSessionId), true);
    assert.equal(argv.includes("--session-id"), false);
    assert.equal(argv.includes("--continue"), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("worker registry snapshot preserves Claude backend fields", () => {
  const entries = [
    {
      type: "custom",
      customType: "ox-worker-hire",
      data: {
        workerId: "克劳",
        role: "programmer",
        backend: "claude",
        model: "model_api/test",
        thinking: "xhigh",
        hired: "2026-07-11",
        sessionFile: "/tmp/ignored.jsonl",
        claudeSessionId: "22222222-2222-4222-8222-222222222222",
        claudeSessionInitialized: true,
        claudeCwd: "/tmp/project",
        claudeCommand: "claude",
        claudePermissionMode: "dontAsk",
        claudeTools: "default",
      },
    },
  ];

  const workers = scanWorkerEntries(entries);
  const worker = workers.get("克劳");
  assert.equal(worker.backend, "claude");
  assert.equal(worker.claudeSessionId, "22222222-2222-4222-8222-222222222222");
  assert.equal(worker.claudeSessionInitialized, true);
  assert.equal(worker.claudeCwd, "/tmp/project");
  assert.equal(worker.claudePermissionMode, "dontAsk");
  assert.equal(worker.claudeTools, "default");
});

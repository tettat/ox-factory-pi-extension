import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  appendJobEvent,
  compactJobTimelineEvents,
  createJob,
  formatJobDetails,
  formatJobEvent,
  formatJobLine,
  appendJobEventIfOpen,
  markOpenJobsStale,
  recoverOpenJobsOnStartup,
  recordJobHeartbeat,
  readJobEventsSince,
  listJobs,
  readJob,
  tailJobEvents,
  updateJob,
} from "../jobs.mjs";
import {
  formatPickedJob,
  markJobRead,
  parsePickCommandArgs,
  pickUnreadJob,
  readJobReadState,
} from "../job-pick.mjs";
import {
  buildFactoryReportContext,
  formatFactoryReportContext,
} from "../report-context.mjs";
import {
  buildFactoryTokenReport,
  buildFactoryTokenTrend,
  formatFactoryTokenReport,
} from "../token-report.mjs";
import {
  buildFactoryCompactionRequest,
  buildFactoryCompactionReport,
  formatFactoryCompactionReport,
  handleFactoryCompactionCompleted,
  handleFactoryCompactionEvent,
  prepareSessionCompactionFixture,
  readFactoryCompactionShadowRecords,
  serializeFactoryCompactionMessages,
} from "../compaction.mjs";
import {
  buildFactoryQualityReport,
  formatFactoryQualityReport,
  readQualityMonitorConfig,
  scoreUserEmotion,
  writeQualityMonitorConfig,
} from "../quality-metrics.mjs";
import {
  buildJobNotifications,
  notificationSettingsFile,
  readNotificationSettings,
  shouldNotifyJob,
  writeNotificationSettings,
} from "../notifications.mjs";
import {
  grantPermission,
  hasPermission,
  localAdminsFile,
  listMessages,
  listPermissions,
  markMessageRead,
  markWorkerMessagesRead,
  revokePermission,
  sendAuthorizedMessage,
  sendTaskResultMessage,
} from "../comm.mjs";
import {
  acceptWorkerTaskRequest,
  cancelWorkerTaskRequest,
  claimWorkerTaskRequest,
  createWorkerTaskRequest,
  editWorkerTaskRequest,
  failWorkerTaskRequest,
  getWorkerTaskRequest,
  listPendingWorkerTaskRequests,
  listWorkerTaskRequests,
  reportWorkerTaskResult,
  recoverStaleWorkerTaskRequests,
  workerTaskRequestsFile,
} from "../task-requests.mjs";
import {
  completeOutsourceRun,
  createOutsourceRun,
  getOutsourceProfile,
  getOutsourceRun,
  listOutsourceProfiles,
  listOutsourceRuns,
  markOutsourceRunRunning,
  OUTSOURCE_TERMINAL_STATUSES,
  normalizeOutsourceProfile,
  outsourceProfilesFile,
  outsourceRunsFile,
  upsertOutsourceProfile,
} from "../outsource-agents.mjs";
import {
  buildOutsourcePiArgs,
  getPiInvocation,
} from "../outsource-runner.mjs";
import {
  renderOutsourceWaitResult,
  startOutsourceRunJob,
} from "../outsource-dispatcher.mjs";
import {
  listWorkerResponsibilities,
  removeWorkerResponsibility,
  setWorkerResponsibility,
} from "../responsibilities.mjs";
import {
  addProjectProgress,
  formatProjectMarkdown,
  formatProjectsMarkdown,
  listProjects,
  resolveProject,
  setProjectMember,
  setProjectTodo,
  setProjectWorktree,
  upsertProject,
} from "../projects.mjs";
import {
  buildCodexBaseInstructions,
  buildCodexTaskContent,
  codexNotificationToStreamEvents,
  createCodexTokenUsageTracker,
  extractCodexTokenUsage,
  extractCodexThreadTokenUsage,
  assertCodexThreadBinding,
  reconcileCodexThreadId,
  canReplaceMissingCodexThread,
  assertWorkerThinkingSupported,
  normalizeCodexEffort,
  normalizeCodexModel,
  subtractCodexTokenUsage,
} from "../codex-backend.mjs";
import {
  selectCanonicalCodexThread,
} from "../codex-thread-audit.mjs";
import {
  buildFactoryWorkerHandbook,
} from "../factory-handbook.mjs";
import {
  buildWorkerSystemPrompt,
  buildWorkerTaskPrompt,
} from "../worker-prompts.mjs";

import {
  buildKimiCliArgs,
  kimiStreamLineToEvents,
} from "../kimi-backend.mjs";
import {
  markdownPreviewText,
} from "../markdown-preview.mjs";
import {
  parseCodexRolloutLines,
  repairCodexJobTokenMetadata,
  summarizeSegments,
} from "../codex-rollout-token-report.mjs";
import { selectNextPending, shouldRunInProcess } from "../queue-utils.mjs";
import { repairToolResultParents } from "../session-repair.mjs";
import {
  resolveProjectMarkdownDocRef,
  isOutsourceJob,
  isOutsourceWorkerName,
  uniqueWorkers,
  buildWorkersView,
  buildProjectStrips,
  computeReliableFinishedAt,
  computeReliableElapsedMs,
  serializeOutsourceRun,
} from "../web-server.mjs";
import {
  acceptWebTalkRequest,
  acceptWebTalkJobControlRequest,
  cancelWebTalkRequest,
  claimWebTalkRequest,
  createWebTalkRequest,
  createWebTalkJobControlRequest,
  editWebTalkRequest,
  failWebTalkRequest,
  failWebTalkJobControlRequest,
  getWebTalkRequest,
  getWebTalkJobControlRequest,
  listPendingWebTalkJobControlRequests,
  listPendingWebTalkRequests,
  listWebTalkJobControlRequests,
  listWebTalkRequests,
  webTalkRequestsFile,
} from "../web-talk.mjs";
import {
  buildWorkerJobUnreadSummary,
  markWorkerJobsRead,
  markWebJobRead,
} from "../web-job-read.mjs";
import {
  acceptMainAgentTalkRequest,
  claimMainAgentTalkRequest,
  createMainAgentTalkRequest,
  failMainAgentTalkRequest,
  getMainAgentTalkRequest,
  listMainAgentTalkRequests,
  listPendingMainAgentTalkRequests,
} from "../main-agent-talk.mjs";
import {
  scanWorkerEntries,
} from "../worker-registry-snapshot.mjs";

const testDir = dirname(fileURLToPath(import.meta.url));

test("repairToolResultParents reconnects orphan tool results to their assistant tool call", () => {
  const entries = [
    {
      id: "assistant-1",
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "factory_check", arguments: {} }],
      },
    },
    {
      id: "tool-1",
      parentId: "missing-parent",
      type: "message",
      message: { role: "toolResult", toolCallId: "call-1", toolName: "factory_check", content: [] },
    },
  ];

  const { entries: repaired, fixes } = repairToolResultParents(entries);

  assert.equal(fixes.length, 1);
  assert.equal(repaired[1].parentId, "assistant-1");
});

test("job store persists job metadata and append-only event history", () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-job-test-"));
  try {
    const job = createJob(workersDir, {
      kind: "talk",
      worker: "dongzi",
      project: "chat",
      task: "say hi",
      cwd: "/tmp/project",
      sessionFile: "/tmp/session.jsonl",
    });

    appendJobEvent(job, { type: "text", text: "hello" });
    updateJob(job, { status: "running", pid: 1234 });
    updateJob(job, { status: "done", summary: "hello", exitCode: 0 });

    const stored = readJob(job.jobFile);
    assert.equal(stored.status, "done");
    assert.equal(stored.pid, 1234);
    assert.equal(stored.summary, "hello");
    assert.equal(tailJobEvents(job, 10).length, 2);
    assert.match(formatJobLine(stored), /done/);
    assert.deepEqual(listJobs(workersDir).map((j) => j.id), [job.id]);
  } finally {
    rmSync(workersDir, { recursive: true, force: true });
  }
});



test("pickUnreadJob selects terminal unread jobs and persists read state", () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-pick-test-"));
  try {
    const oldJob = createJob(workersDir, {
      kind: "talk",
      worker: "DeveloperA",
      project: "showcase",
      task: "旧结果",
    });
    appendJobEvent(oldJob, { type: "done", text: "旧结果完成" });
    updateJob(oldJob, { status: "done", summary: "旧摘要", updatedAt: "2026-07-01T00:00:00.000Z" });

    const newJob = createJob(workersDir, {
      kind: "talk",
      worker: "ReviewerA",
      project: "pi",
      task: "新结果",
    });
    appendJobEvent(newJob, { type: "done", text: "新结果完成" });
    updateJob(newJob, { status: "done", summary: "新摘要", updatedAt: "2026-07-02T00:00:00.000Z" });

    const picked = pickUnreadJob(workersDir, { limit: 10, markRead: true, readBy: "tester" });
    assert.equal(picked.job.id, newJob.id);
    assert.equal(picked.readEvent.jobId, newJob.id);
    assert.match(formatPickedJob(picked), /新结果完成/);
    assert.equal(readJobReadState(workersDir).has(newJob.id), true);

    const second = pickUnreadJob(workersDir, { limit: 10, markRead: false });
    assert.equal(second.job.id, oldJob.id);

    markJobRead(workersDir, { jobId: oldJob.id, readBy: "tester" });
    const empty = pickUnreadJob(workersDir, { limit: 10 });
    assert.equal(empty, null);
  } finally {
    rmSync(workersDir, { recursive: true, force: true });
  }
});

test("parsePickCommandArgs supports peek without marking read", () => {
  assert.deepEqual(parsePickCommandArgs("--peek"), {
    worker: undefined,
    mode: "random",
    markRead: false,
    peek: true,
  });
  assert.deepEqual(parsePickCommandArgs("ReviewerA --peek"), {
    worker: "ReviewerA",
    mode: "random",
    markRead: false,
    peek: true,
  });
  assert.deepEqual(parsePickCommandArgs("--latest DeveloperA"), {
    worker: "DeveloperA",
    mode: "latest",
    markRead: true,
    peek: false,
  });
});

test("readJobEventsSince returns new events after a known offset", () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-job-offset-test-"));
  try {
    const job = createJob(workersDir, {
      kind: "talk",
      worker: "dongzi",
      project: "chat",
      task: "start",
    });

    appendJobEvent(job, { type: "text", text: "first" });
    const firstRead = readJobEventsSince(job, 0);
    assert.equal(firstRead.nextOffset, 2);
    assert.deepEqual(firstRead.events.map((event) => event.text), ["start", "first"]);

    appendJobEvent(job, { type: "text", text: "second" });
    const secondRead = readJobEventsSince(job, firstRead.nextOffset);
    assert.equal(secondRead.nextOffset, 3);
    assert.deepEqual(secondRead.events.map((event) => event.text), ["second"]);
  } finally {
    rmSync(workersDir, { recursive: true, force: true });
  }
});

test("selectNextPending skips future scheduled jobs and returns due jobs", () => {
  const now = new Date("2026-06-26T00:00:00Z");
  const entries = [
    { status: "pending", worker: "future", task: "later", scheduled: "2026-06-26T00:10:00Z" },
    { status: "done", worker: "done", task: "ignore" },
    { status: "pending", worker: "due", task: "now", scheduled: "2026-06-25T23:59:00Z", repeat: 30 },
  ];

  assert.deepEqual(selectNextPending(entries, now), { index: 2, item: entries[2] });
});

test("selectNextPending reports no runnable job when every pending job is scheduled in the future", () => {
  const now = new Date("2026-06-26T00:00:00Z");
  const entries = [
    { status: "pending", worker: "future", task: "later", scheduled: "2026-06-26T00:10:00Z" },
  ];

  assert.equal(selectNextPending(entries, now), null);
});

test("shouldRunInProcess keeps immediate one-shot queue work out of the detached runner", () => {
  assert.equal(shouldRunInProcess({ mode: "auto" }), true);
  assert.equal(shouldRunInProcess({}), true);
  assert.equal(shouldRunInProcess({ mode: "runner" }), false);
  assert.equal(shouldRunInProcess({ repeat: 30 }), false);
  assert.equal(shouldRunInProcess({ scheduled: "2026-06-26T09:00:00Z" }), false);
});

test("formatJobEvent renders tool arguments and tool results", () => {
  assert.equal(
    formatJobEvent({ type: "tool_start", name: "bash", args: { command: "pnpm test", timeout: 10 } }),
    "[tool:start] bash: pnpm test",
  );

  assert.equal(
    formatJobEvent({
      type: "tool_end",
      name: "bash",
      isError: false,
      result: { content: [{ type: "text", text: "PASS 6 tests\n" }] },
    }),
    "[tool:end] bash: PASS 6 tests",
  );
});

test("formatJobEvent renders streaming tool output chunks", () => {
  assert.equal(
    formatJobEvent({ type: "tool_output", name: "bash", text: "PASS 9 tests\n" }),
    "[tool:output] bash: PASS 9 tests",
  );
});

test("compactJobTimelineEvents merges streamed text and tool chunks for web display", () => {
  const compacted = compactJobTimelineEvents([
    { time: "2026-07-08T00:00:00.000Z", type: "text", text: "你好，" },
    { time: "2026-07-08T00:00:00.100Z", type: "text", text: "我开始处理。" },
    { time: "2026-07-08T00:00:01.000Z", type: "tool_start", name: "bash", args: { command: "pnpm test" } },
    { time: "2026-07-08T00:00:01.100Z", type: "tool_output", name: "bash", text: "PASS " },
    { time: "2026-07-08T00:00:01.200Z", type: "tool_output", name: "bash", text: "82 tests\n" },
    {
      time: "2026-07-08T00:00:02.000Z",
      type: "tool_end",
      name: "bash",
      isError: false,
      result: { output: "PASS 82 tests\n", exitCode: 0 },
    },
    { time: "2026-07-08T00:00:03.000Z", type: "done", turns: 1, inputTokens: 10, outputTokens: 20, text: "最终回复全文" },
  ]);

  assert.equal(compacted.length, 3);
  assert.deepEqual(compacted[0], {
    time: "2026-07-08T00:00:00.000Z",
    type: "text",
    text: "你好，我开始处理。",
  });
  assert.equal(compacted[1].type, "tool");
  assert.equal(compacted[1].name, "bash");
  assert.equal(compacted[1].output, "PASS 82 tests\n");
  assert.equal(
    formatJobEvent(compacted[1]),
    "[tool] bash: pnpm test | output: PASS 82 tests",
  );
  assert.equal(compacted[2].type, "done");
  assert.equal(compacted[2].text, "");
  assert.equal(formatJobEvent(compacted[2]), "[done] 1 rounds, input 10, output 20");
});

test("compactJobTimelineEvents merges streamed thinking chunks and drops think delimiters", () => {
  const compacted = compactJobTimelineEvents([
    { time: "2026-07-13T00:00:00.000Z", type: "thinking", text: "先看" },
    { time: "2026-07-13T00:00:00.100Z", type: "thinking", text: "数据" },
    { time: "2026-07-13T00:00:00.200Z", type: "text", text: "</think>" },
    { time: "2026-07-13T00:00:01.000Z", type: "tool_start", name: "bash", args: { command: "echo ok" } },
    { time: "2026-07-13T00:00:01.100Z", type: "tool_end", name: "bash", result: { output: "ok\n" } },
    { time: "2026-07-13T00:00:02.000Z", type: "thinking", text: "继续" },
    { time: "2026-07-13T00:00:02.100Z", type: "thinking", text: "判断" },
    { time: "2026-07-13T00:00:02.200Z", type: "text", text: "最终回复" },
  ]);

  assert.deepEqual(compacted.map((e) => e.type), ["thinking", "tool", "thinking", "text"]);
  assert.equal(compacted[0].text, "先看数据");
  assert.equal(compacted[2].text, "继续判断");
  assert.equal(compacted[3].text, "最终回复");
});

test("codex backend maps worker thinking levels to Codex reasoning effort", () => {
  assert.equal(normalizeCodexEffort("off"), "none");
  assert.equal(normalizeCodexEffort("minimal"), "low");
  assert.equal(normalizeCodexEffort("high"), "high");
  assert.equal(normalizeCodexEffort("xhigh"), "xhigh");
  assert.equal(normalizeCodexEffort("max"), "max");
  assert.equal(normalizeCodexEffort("ultra"), "ultra");
  assert.equal(normalizeCodexEffort(undefined), undefined);
});

test("max and ultra thinking are accepted for Codex/Claude workers but rejected for Pi workers", () => {
  assert.equal(assertWorkerThinkingSupported("codex", "max"), "max");
  assert.equal(assertWorkerThinkingSupported("codex", "ultra"), "ultra");
  assert.equal(assertWorkerThinkingSupported("claude", "max"), "max");
  assert.equal(assertWorkerThinkingSupported("claude", "ultra"), "ultra");
  assert.equal(assertWorkerThinkingSupported("pi", "xhigh"), "xhigh");
  assert.throws(() => assertWorkerThinkingSupported("pi", "max"), /not supported by Pi|Codex\/Claude/i);
  assert.throws(() => assertWorkerThinkingSupported("pi", "ultra"), /not supported by Pi|Codex\/Claude/i);
});

test("codex backend normalizes conversational model aliases", () => {
  assert.equal(normalizeCodexModel("5.5"), "gpt-5.5");
  assert.equal(normalizeCodexModel("5.4"), "gpt-5.4");
  assert.equal(normalizeCodexModel("gpt5.5"), "gpt-5.5");
  assert.equal(normalizeCodexModel("Codex-5.5"), "gpt-5.5");
  assert.equal(normalizeCodexModel("gpt-5.5"), "gpt-5.5");
  assert.equal(normalizeCodexModel(undefined), undefined);
});

test("codex backend refuses to run workers without a persisted thread binding", () => {
  assert.equal(
    assertCodexThreadBinding({ id: "LocalAdmin", codexThreadId: "thread-1" }),
    "thread-1",
  );

  assert.throws(
    () => assertCodexThreadBinding({ id: "WorkerJ", codexThreadId: "" }),
    /missing codexThreadId|refuse/i,
  );
  assert.throws(
    () => assertCodexThreadBinding({ id: "WorkerK" }),
    /missing codexThreadId|refuse/i,
  );
});

test("codex backend can replace a missing rollout for an uninitialized fresh hire", () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-codex-empty-thread-"));
  try {
    const failed = createJob(workersDir, {
      worker: "园子",
      project: "talk",
      task: "hello",
      cwd: workersDir,
      sessionFile: join(workersDir, "sessions", "园子.jsonl"),
    });
    updateJob(failed, { status: "failed" });

    assert.equal(
      canReplaceMissingCodexThread({
        id: "园子",
        backend: "codex",
        codexThreadId: "empty-thread-without-rollout",
        codexThreadInitialized: false,
      }, workersDir),
      true,
    );
  } finally {
    rmSync(workersDir, { recursive: true, force: true });
  }
});

test("codex backend refuses to replace a missing rollout when worker has successful history", () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-codex-existing-thread-"));
  try {
    const done = createJob(workersDir, {
      worker: "园子",
      project: "talk",
      task: "prior successful work",
      cwd: workersDir,
      sessionFile: join(workersDir, "sessions", "园子.jsonl"),
    });
    updateJob(done, { status: "done" });

    assert.equal(
      canReplaceMissingCodexThread({
        id: "园子",
        backend: "codex",
        codexThreadId: "real-thread-that-should-not-be-replaced",
      }, workersDir),
      false,
    );
  } finally {
    rmSync(workersDir, { recursive: true, force: true });
  }
});

test("codex backend persists the actual resumed thread id when app-server canonicalizes it", () => {
  const patches = [];
  const callbackObservedThreadIds = [];
  const worker = {
    id: "WorkerJ",
    model: "gpt-5.5",
    codexThreadId: "seed-thread",
    codexServerUrl: "ws://127.0.0.1:48177",
  };

  const threadId = reconcileCodexThreadId(worker, "actual-thread", (patch) => {
    callbackObservedThreadIds.push(worker.codexThreadId);
    patches.push(patch);
    Object.assign(worker, patch);
  });

  assert.equal(threadId, "actual-thread");
  assert.equal(worker.codexThreadId, "actual-thread");
  assert.deepEqual(callbackObservedThreadIds, ["seed-thread"]);
  assert.deepEqual(patches, [{
    codexThreadId: "actual-thread",
    codexServerUrl: "ws://127.0.0.1:48177",
    model: "gpt-5.5",
  }]);
});

test("codex thread audit selects the long-running rollout when registry points at a seed thread", () => {
  const selected = selectCanonicalCodexThread({
    worker: { id: "WorkerJ", codexThreadId: "seed-thread" },
    rollouts: [
      { threadId: "latest-short", turns: 1, lastAt: "2026-07-08T06:00:00.000Z" },
      { threadId: "long-mainline", turns: 33, lastAt: "2026-07-07T08:00:00.000Z" },
    ],
  });

  assert.equal(selected.threadId, "long-mainline");
  assert.equal(selected.reason, "registry-missing-use-observed-mainline");
});

test("codex thread audit keeps an existing registry thread when it has rollout evidence", () => {
  const selected = selectCanonicalCodexThread({
    worker: { id: "LocalAdmin", codexThreadId: "registry-thread" },
    rollouts: [
      { threadId: "registry-thread", turns: 10, lastAt: "2026-07-07T08:00:00.000Z" },
      { threadId: "older-thread", turns: 50, lastAt: "2026-07-01T08:00:00.000Z" },
    ],
  });

  assert.equal(selected.threadId, "registry-thread");
  assert.equal(selected.reason, "registry-has-rollout-evidence");
});

test("codex backend converts app-server notifications into worker stream events", () => {
  assert.deepEqual(
    codexNotificationToStreamEvents({
      method: "item/started",
      params: {
        item: { type: "commandExecution", command: "pnpm test", cwd: "/tmp/project" },
      },
    }),
    [{ type: "tool_start", name: "bash", args: { command: "pnpm test", cwd: "/tmp/project" } }],
  );

  assert.deepEqual(
    codexNotificationToStreamEvents({
      method: "item/commandExecution/outputDelta",
      params: { delta: "PASS\n" },
    }),
    [{ type: "tool_output", name: "bash", text: "PASS\n" }],
  );

  assert.deepEqual(
    codexNotificationToStreamEvents({
      method: "item/completed",
      params: {
        item: {
          type: "commandExecution",
          command: "pnpm test",
          aggregatedOutput: "PASS\n",
          exitCode: 0,
        },
      },
    }),
    [{ type: "tool_end", name: "bash", result: { command: "pnpm test", output: "PASS\n", exitCode: 0 }, isError: false }],
  );
});

test("formatJobDetails prefers final done text over truncated summary", () => {
  const job = {
    id: "job-1",
    status: "done",
    worker: "dongzi",
    project: "talk",
    task: "implement it",
    createdAt: "2026-06-26T00:00:00.000Z",
    updatedAt: "2026-06-26T00:00:10.000Z",
    summary: "short truncated",
  };
  const text = formatJobDetails(job, [
    { type: "text", text: "hel" },
    { type: "text", text: "lo" },
    { type: "tool_start", name: "bash", args: { command: "pnpm test" } },
    { type: "tool_end", name: "bash", result: { content: [{ type: "text", text: "PASS\n" }] }, isError: false },
    { type: "done", turns: 1, inputTokens: 10, outputTokens: 20, text: "FULL ANSWER" },
  ]);

  assert.match(text, /Latest reply:[\s\S]*FULL ANSWER/);
  assert.doesNotMatch(text, /Latest reply:[\s\S]*short truncated/);
  assert.match(text, /bash: pnpm test/);
  assert.match(text, /bash: PASS/);
});

test("markOpenJobsStale marks leftover queued and running jobs from a dead Pi process", () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-job-stale-test-"));
  try {
    const queued = createJob(workersDir, {
      kind: "talk",
      worker: "dongzi",
      project: "talk",
      task: "queued work",
    });
    const running = createJob(workersDir, {
      kind: "talk",
      worker: "dongzi",
      project: "talk",
      task: "running work",
    });
    updateJob(running, { status: "running" });
    const done = createJob(workersDir, {
      kind: "talk",
      worker: "dongzi",
      project: "talk",
      task: "finished work",
    });
    updateJob(done, { status: "done" });

    const count = markOpenJobsStale(workersDir, "previous Pi exited");

    assert.equal(count, 2);
    assert.equal(readJob(queued.jobFile).status, "stale");
    assert.equal(readJob(running.jobFile).status, "stale");
    assert.equal(readJob(done.jobFile).status, "done");
    assert.match(formatJobDetails(readJob(running.jobFile), tailJobEvents(running, 5)), /previous Pi exited/);
  } finally {
    rmSync(workersDir, { recursive: true, force: true });
  }
});

test("recoverOpenJobsOnStartup keeps fresh heartbeat jobs as orphan-running", () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-job-recover-fresh-test-"));
  try {
    const running = createJob(workersDir, {
      kind: "talk",
      worker: "dongzi",
      project: "talk",
      task: "running across reload",
    });
    updateJob(running, { status: "running" });
    recordJobHeartbeat(running, {
      now: new Date("2026-06-30T10:00:00.000Z"),
      ownerPid: process.pid,
      ownerInstanceId: "old-extension-instance",
      heartbeatIntervalMs: 5000,
    });

    const summary = recoverOpenJobsOnStartup(workersDir, "previous Pi exited", {
      now: new Date("2026-06-30T10:00:10.000Z"),
      heartbeatTimeoutMs: 30000,
    });

    const recovered = readJob(running.jobFile);
    assert.equal(summary.recovered, 1);
    assert.equal(summary.stale, 0);
    assert.equal(recovered.status, "orphan-running");
    assert.equal(recovered.recoveryState, "orphan-running");
    assert.match(formatJobDetails(recovered, tailJobEvents(recovered, 5)), /fresh heartbeat/);
  } finally {
    rmSync(workersDir, { recursive: true, force: true });
  }
});

test("recoverOpenJobsOnStartup stales expired heartbeat and legacy open jobs", () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-job-recover-expired-test-"));
  try {
    const expired = createJob(workersDir, {
      kind: "talk",
      worker: "dongzi",
      project: "talk",
      task: "expired heartbeat",
    });
    updateJob(expired, {
      status: "running",
      heartbeatAt: "2026-06-30T10:00:00.000Z",
      ownerPid: process.pid,
      ownerInstanceId: "old-extension-instance",
    });
    const legacyQueued = createJob(workersDir, {
      kind: "talk",
      worker: "dongzi",
      project: "talk",
      task: "legacy queued",
    });

    const summary = recoverOpenJobsOnStartup(workersDir, "previous Pi exited", {
      now: new Date("2026-06-30T10:02:00.000Z"),
      heartbeatTimeoutMs: 30000,
    });

    assert.equal(summary.recovered, 0);
    assert.equal(summary.stale, 2);
    assert.equal(readJob(expired.jobFile).status, "stale");
    assert.equal(readJob(legacyQueued.jobFile).status, "stale");
  } finally {
    rmSync(workersDir, { recursive: true, force: true });
  }
});

test("appendJobEventIfOpen records late events without polluting stale jobs", () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-job-late-event-test-"));
  try {
    const job = createJob(workersDir, {
      kind: "talk",
      worker: "dongzi",
      project: "talk",
      task: "late output",
    });
    updateJob(job, { status: "stale", error: "expired heartbeat" });

    const result = appendJobEventIfOpen(job, { type: "text", text: "late text after stale" });
    const events = tailJobEvents(job, 5);

    assert.equal(result.appended, false);
    assert.equal(readJob(job.jobFile).status, "stale");
    assert.equal(events.at(-1).type, "late_event_after_terminal");
    assert.equal(events.at(-1).originalType, "text");
    assert.match(formatJobEvent(events.at(-1)), /late event after terminal/);
  } finally {
    rmSync(workersDir, { recursive: true, force: true });
  }
});

test("startup recovery uses heartbeat-aware recovery instead of unconditional stale", () => {
  const indexSource = readFileSync(join(testDir, "../index.ts"), "utf8");
  assert.match(indexSource, /recoverOpenJobsOnStartup/);
  assert.doesNotMatch(
    indexSource,
    /markOpenJobsStale\(\s*getWorkersDir\(\),\s*["']previous Pi process exited before this in-process job completed["']/,
  );
});

test("worker jobs write heartbeat metadata and suppress late stale events", () => {
  const spawnerSource = readFileSync(join(testDir, "../spawner.ts"), "utf8");
  assert.match(spawnerSource, /recordJobHeartbeat/);
  assert.match(spawnerSource, /ownerInstanceId/);
  assert.match(spawnerSource, /appendJobEventIfOpen/);
});

test("report context treats jobs as primary daily activity beyond queue entries", () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-report-test-"));
  try {
    const dongziJob = createJob(workersDir, {
      kind: "talk",
      worker: "DeveloperA",
      project: "落地页",
      task: "迭代展示页",
    });
    appendJobEvent(dongziJob, { type: "done", text: "完成展示页首屏和 CTA 调整", inputTokens: 100, outputTokens: 20 });
    updateJob(dongziJob, {
      status: "done",
      summary: "完成展示页首屏和 CTA 调整",
      createdAt: "2026-06-30T01:00:00.000Z",
      finishedAt: "2026-06-30T01:20:00.000Z",
      error: "previous Pi process exited before this in-process job completed",
    });

    writeFileSync(
      join(workersDir, "queue.jsonl"),
      `${JSON.stringify({
        status: "done",
        worker: "小绿",
        project: "履历整理",
        task: "整理员工履历",
        time: "2026-06-30T02:00:00.000Z",
      })}\n`,
      "utf8",
    );

    const context = buildFactoryReportContext({
      workersDir,
      date: "2026-06-30",
      workers: [{ id: "DeveloperA", role: "programmer", status: "idle", projects: [], promotions: [], responsibilities: [] }],
    });

    assert.equal(context.totals.jobs, 1);
    assert.equal(context.totals.queueEntries, 1);
    assert.equal(context.queue.statusCounts.done, 1);

    const dongzi = context.workers.find((worker) => worker.worker === "DeveloperA");
    assert.equal(dongzi.jobs.done, 1);
    assert.equal(dongzi.queue.done ?? 0, 0);
    assert.match(dongzi.highlights[0], /展示页/);
    assert.ok(dongzi.warnings.some((warning) => warning.includes("stale")));

    const xiaolv = context.workers.find((worker) => worker.worker === "小绿");
    assert.equal(xiaolv.jobs.done ?? 0, 0);
    assert.equal(xiaolv.queue.done, 1);

    const markdown = formatFactoryReportContext(context);
    assert.match(markdown, /全员产出表/);
    assert.match(markdown, /DeveloperA/);
    assert.match(markdown, /小绿/);
    assert.match(markdown, /禁止只凭 queue/);
  } finally {
    rmSync(workersDir, { recursive: true, force: true });
  }
});

test("report context summarizes worker sessions and main-session management events", () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-report-session-test-"));
  try {
    const sessionsDir = join(workersDir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, "LocalAdmin.jsonl"),
      [
        JSON.stringify({
          type: "message",
          timestamp: "2026-06-30T03:00:00.000Z",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "开始分析日报数据源。" },
              { type: "toolCall", name: "bash", arguments: { command: "rg queue" } },
            ],
            usage: {
              input: 1200,
              output: 300,
              cost: { total: 0.42 },
            },
          },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const context = buildFactoryReportContext({
      workersDir,
      date: "2026-06-30",
      sessionEntries: [
        {
          type: "custom",
          customType: "ox-worker-promote",
          timestamp: "2026-06-30T04:00:00.000Z",
          data: { workerId: "Foreman", from: "programmer", to: "foreman", date: "2026-06-30" },
        },
      ],
    });

    const paipai = context.workers.find((worker) => worker.worker === "LocalAdmin");
    assert.equal(paipai.session.assistantMessages, 1);
    assert.equal(paipai.session.toolCalls.bash, 1);
    assert.equal(paipai.session.inputTokens, 1200);
    assert.equal(paipai.session.outputTokens, 300);
    assert.equal(paipai.session.cost, 0.42);
    assert.equal(context.managementEvents.length, 1);
    assert.equal(context.managementEvents[0].type, "ox-worker-promote");
  } finally {
    rmSync(workersDir, { recursive: true, force: true });
  }
});

test("report-sources CLI prints the same multi-source daily context for workers", () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-report-cli-test-"));
  try {
    const job = createJob(workersDir, {
      kind: "talk",
      worker: "Foreman",
      project: "工厂日报",
      task: "生成日报",
    });
    updateJob(job, {
      status: "done",
      summary: "汇总全员产出",
      createdAt: "2026-06-30T05:00:00.000Z",
      finishedAt: "2026-06-30T05:10:00.000Z",
    });

    const output = execFileSync(process.execPath, [
      join(testDir, "../report-sources.mjs"),
      "--workers-dir",
      workersDir,
      "--date",
      "2026-06-30",
    ], { encoding: "utf8" });

    assert.match(output, /工厂日报上下文/);
    assert.match(output, /Foreman/);
    assert.match(output, /禁止只凭 queue/);
  } finally {
    rmSync(workersDir, { recursive: true, force: true });
  }
});

test("authorized communication denies ungranted workers and allows explicit grants", () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-comm-auth-test-"));
  try {
    assert.equal(hasPermission(workersDir, { subject: "ReviewerC", action: "message:send", target: "DeveloperA" }), false);

    assert.throws(
      () => sendAuthorizedMessage(workersDir, { from: "ReviewerC", to: "DeveloperA", content: "你那边进展如何？" }),
      /没有权限/,
    );

    const grant = grantPermission(workersDir, {
      subject: "ReviewerC",
      actions: ["message:send"],
      targets: ["DeveloperA"],
      grantedBy: "秘书",
      note: "允许ReviewerC联系DeveloperA做开发协作",
    });

    assert.equal(grant.subject, "ReviewerC");
    assert.equal(hasPermission(workersDir, { subject: "ReviewerC", action: "message:send", target: "DeveloperA" }), true);

    const sent = sendAuthorizedMessage(workersDir, { from: "ReviewerC", to: "DeveloperA", content: "你那边进展如何？" });
    assert.equal(sent.from, "ReviewerC");
    assert.equal(sent.to, "DeveloperA");

    const inbox = listMessages(workersDir, { worker: "DeveloperA" });
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].content, "你那边进展如何？");
    assert.equal(inbox[0].read, false);

    markMessageRead(workersDir, { messageId: sent.id, worker: "DeveloperA" });
    assert.equal(listMessages(workersDir, { worker: "DeveloperA", unreadOnly: true }).length, 0);

    revokePermission(workersDir, {
      subject: "ReviewerC",
      actions: ["message:send"],
      targets: ["DeveloperA"],
      revokedBy: "秘书",
    });
    assert.equal(hasPermission(workersDir, { subject: "ReviewerC", action: "message:send", target: "DeveloperA" }), false);
  } finally {
    rmSync(workersDir, { recursive: true, force: true });
  }
});

test("local admin config grants factory admin permissions without hardcoded worker names", () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-local-admin-test-"));
  try {
    writeFileSync(localAdminsFile(workersDir), JSON.stringify({ admins: ["LocalAdmin"] }, null, 2));

    assert.equal(hasPermission(workersDir, { subject: "LocalAdmin", action: "permission:manage", target: "ReviewerA" }), true);
    assert.equal(hasPermission(workersDir, { subject: "LocalAdmin", action: "worker:fire", target: "ReviewerA" }), true);
    assert.equal(hasPermission(workersDir, { subject: "ReviewerC", action: "worker:fire", target: "ReviewerA" }), false);

    const indexSource = readFileSync(join(testDir, "../index.ts"), "utf8");
    const fireToolSource = indexSource.slice(
      indexSource.indexOf('name: "factory_fire"'),
      indexSource.indexOf('name: "factory_list"'),
    );
    assert.match(fireToolSource, /actor:\s*Type\.Optional/);
    assert.match(fireToolSource, /action:\s*"worker:fire"/);
  } finally {
    rmSync(workersDir, { recursive: true, force: true });
  }
});

test("secretary can communicate by default and explicit broadcast grants use message:broadcast", () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-comm-secretary-test-"));
  try {
    assert.equal(hasPermission(workersDir, { subject: "秘书", action: "message:broadcast", target: "*" }), true);
    sendAuthorizedMessage(workersDir, { from: "秘书", to: "*", content: "今天日报先看 factory_report_context。" });
    assert.equal(listMessages(workersDir, { worker: "DeveloperA" }).length, 1);

    assert.throws(
      () => sendAuthorizedMessage(workersDir, { from: "Foreman", to: "*", content: "大家都来开会。" }),
      /没有权限/,
    );

    grantPermission(workersDir, {
      subject: "Foreman",
      actions: ["message:broadcast"],
      targets: ["*"],
      grantedBy: "秘书",
    });
    sendAuthorizedMessage(workersDir, { from: "Foreman", to: "*", content: "请各位同步今日进展。" });
    assert.equal(listPermissions(workersDir, { subject: "Foreman" }).length, 1);
    assert.equal(listMessages(workersDir, { worker: "ReviewerC" }).length, 2);
  } finally {
    rmSync(workersDir, { recursive: true, force: true });
  }
});

test("worker messages can be bulk-marked read when opening worker detail", () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-comm-bulk-read-test-"));
  try {
    const direct = sendAuthorizedMessage(workersDir, { from: "秘书", to: "DeveloperA", content: "直接消息" });
    const broadcast = sendAuthorizedMessage(workersDir, { from: "秘书", to: "*", content: "广播消息" });
    grantPermission(workersDir, {
      subject: "DeveloperA",
      actions: ["message:broadcast"],
      targets: ["*"],
      grantedBy: "秘书",
    });
    const ownBroadcast = sendAuthorizedMessage(workersDir, { from: "DeveloperA", to: "*", content: "DeveloperA自己的广播" });

    assert.equal(listMessages(workersDir, { worker: "DeveloperA", unreadOnly: true }).length, 3);

    const read = markWorkerMessagesRead(workersDir, { worker: "DeveloperA" });
    assert.equal(read.count, 2);
    assert.deepEqual(read.reads.map((entry) => entry.messageId).sort(), [broadcast.id, direct.id].sort());
    assert.equal(listMessages(workersDir, { worker: "DeveloperA" }).find((m) => m.id === direct.id).read, true);
    assert.equal(listMessages(workersDir, { worker: "DeveloperA" }).find((m) => m.id === broadcast.id).read, true);
    assert.equal(listMessages(workersDir, { worker: "DeveloperA" }).find((m) => m.id === ownBroadcast.id).read, false);

    const again = markWorkerMessagesRead(workersDir, { worker: "DeveloperA" });
    assert.equal(again.count, 0);
  } finally {
    rmSync(workersDir, { recursive: true, force: true });
  }
});

test("comm CLI lets authorized worker subprocesses send and read messages", () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-comm-cli-test-"));
  try {
    grantPermission(workersDir, {
      subject: "LocalAdmin",
      actions: ["message:send"],
      targets: ["DeveloperA"],
      grantedBy: "秘书",
    });

    const cli = join(testDir, "../comm-cli.mjs");
    const sent = execFileSync(process.execPath, [
      cli,
      "send",
      "--workers-dir",
      workersDir,
      "--from",
      "LocalAdmin",
      "--to",
      "DeveloperA",
      "--content",
      "CLI 授权消息",
    ], { encoding: "utf8" });
    assert.match(sent, /sent msg_/);

    const inbox = execFileSync(process.execPath, [
      cli,
      "inbox",
      "--workers-dir",
      workersDir,
      "--worker",
      "DeveloperA",
    ], { encoding: "utf8" });
    assert.match(inbox, /CLI 授权消息/);

    assert.throws(
      () => execFileSync(process.execPath, [
        cli,
        "send",
        "--workers-dir",
        workersDir,
        "--from",
        "广志",
        "--to",
        "DeveloperA",
        "--content",
        "未授权消息",
      ], { encoding: "utf8", stdio: "pipe" }),
      /Command failed/,
    );
  } finally {
    rmSync(workersDir, { recursive: true, force: true });
  }
});

test("worker task requests are event-sourced for authorized subagent delegation", () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-worker-task-test-"));
  try {
    const request = createWorkerTaskRequest(workersDir, {
      from: "WorkerL",
      to: "WorkerB",
      task: "请调研 subagent 派活接口",
      project: "talk",
      cwd: "/repo",
      mode: "steer",
      source: "worker",
    });
    assert.equal(request.status, "pending");
    assert.equal(request.from, "WorkerL");
    assert.equal(request.to, "WorkerB");
    assert.equal(request.mode, "steer");
    assert.equal(listPendingWorkerTaskRequests(workersDir).length, 1);
    const rawRequestEvent = JSON.parse(readFileSync(workerTaskRequestsFile(workersDir), "utf8").trim().split("\n")[0]);
    assert.equal(rawRequestEvent.type, "request");
    assert.equal(rawRequestEvent.permissionAction, "work:assign");

    const claimed = claimWorkerTaskRequest(workersDir, {
      requestId: request.id,
      claimedBy: "poller-a",
    });
    assert.equal(claimed.status, "processing");
    assert.equal(claimed.claimedBy, "poller-a");
    assert.equal(listPendingWorkerTaskRequests(workersDir).length, 0);

    const duplicateClaim = claimWorkerTaskRequest(workersDir, {
      requestId: request.id,
      claimedBy: "poller-b",
    });
    assert.equal(duplicateClaim, null);

    const accepted = acceptWorkerTaskRequest(workersDir, {
      requestId: request.id,
      jobId: "job-1",
      deliveryMode: "queue",
      placement: "已排队",
    });
    assert.equal(accepted.status, "accepted");
    assert.equal(accepted.jobId, "job-1");

    const reported = reportWorkerTaskResult(workersDir, {
      requestId: request.id,
      jobId: "job-1",
      messageId: "msg-1",
      resultStatus: "done",
      summary: "已经完成",
    });
    assert.equal(reported.status, "reported");
    assert.equal(reported.resultStatus, "done");
    assert.equal(reported.resultMessageId, "msg-1");

    const failedRequest = createWorkerTaskRequest(workersDir, {
      from: "WorkerL",
      to: "WorkerB",
      task: "第二个任务",
    });
    const failed = failWorkerTaskRequest(workersDir, {
      requestId: failedRequest.id,
      error: "WorkerL 没有权限对 WorkerB 执行 work:assign",
    });
    assert.equal(failed.status, "failed");
    assert.equal(failed.error, "WorkerL 没有权限对 WorkerB 执行 work:assign");
    assert.equal(listWorkerTaskRequests(workersDir).length, 2);
    assert.equal(getWorkerTaskRequest(workersDir, request.id).status, "reported");
  } finally {
    rmSync(workersDir, { recursive: true, force: true });
  }
});

test("worker task requests support pending edit and cancel", () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-worker-task-edit-test-"));
  try {
    const request = createWorkerTaskRequest(workersDir, {
      from: "WorkerL",
      to: "WorkerB",
      task: "先看一下",
      mode: "auto",
    });

    const edited = editWorkerTaskRequest(workersDir, {
      requestId: request.id,
      task: "改成排队执行",
      project: "talk",
      mode: "queue",
      from: "WorkerL",
    });
    assert.equal(edited.status, "pending");
    assert.equal(edited.task, "改成排队执行");
    assert.equal(edited.mode, "queue");
    assert.equal(edited.project, "talk");
    assert.equal(listPendingWorkerTaskRequests(workersDir)[0].task, "改成排队执行");

    const cancelled = cancelWorkerTaskRequest(workersDir, {
      requestId: request.id,
      reason: "派活者撤回",
      from: "WorkerL",
    });
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.cancelReason, "派活者撤回");
    assert.equal(listPendingWorkerTaskRequests(workersDir).length, 0);
  } finally {
    rmSync(workersDir, { recursive: true, force: true });
  }
});

test("worker task processing claims recover after timeout", () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-worker-task-recover-test-"));
  try {
    const request = createWorkerTaskRequest(workersDir, {
      from: "WorkerL",
      to: "WorkerB",
      task: "可能会卡在 processing 的任务",
    });

    const claimed = claimWorkerTaskRequest(workersDir, {
      requestId: request.id,
      claimedBy: "pi:old",
    });
    assert.equal(claimed.status, "processing");
    assert.equal(getWorkerTaskRequest(workersDir, request.id).status, "processing");
    assert.equal(listPendingWorkerTaskRequests(workersDir).length, 0);

    const recovered = recoverStaleWorkerTaskRequests(workersDir, {
      now: new Date(Date.parse(claimed.claimedAt) + 180_000),
      timeoutMs: 60_000,
      recoveredBy: "pi:new",
    });
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].id, request.id);
    assert.equal(recovered[0].status, "pending");
    assert.equal(recovered[0].recoveredBy, "pi:new");
    assert.equal(listPendingWorkerTaskRequests(workersDir).length, 1);

    const reclaimed = claimWorkerTaskRequest(workersDir, {
      requestId: request.id,
      claimedBy: "pi:new",
    });
    assert.equal(reclaimed.status, "processing");
    assert.equal(reclaimed.claimedBy, "pi:new");
  } finally {
    rmSync(workersDir, { recursive: true, force: true });
  }
});

test("task result messages return to assigner without reverse message grant", () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-task-result-message-test-"));
  try {
    assert.equal(hasPermission(workersDir, { subject: "WorkerB", action: "message:send", target: "WorkerL" }), false);
    const result = sendTaskResultMessage(workersDir, {
      from: "WorkerB",
      to: "WorkerL",
      content: "派活任务已完成。",
      jobId: "job-1",
      taskRequestId: "task-1",
      resultStatus: "done",
    });
    assert.equal(result.kind, "task_result");
    assert.equal(result.from, "WorkerB");
    assert.equal(result.to, "WorkerL");
    assert.equal(result.jobId, "job-1");
    assert.equal(result.taskRequestId, "task-1");
    const inbox = listMessages(workersDir, { worker: "WorkerL" });
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].read, false);
    assert.equal(inbox[0].kind, "task_result");
  } finally {
    rmSync(workersDir, { recursive: true, force: true });
  }
});

test("comm CLI lets authorized workers assign task requests", () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-task-cli-test-"));
  try {
    grantPermission(workersDir, {
      subject: "WorkerL",
      actions: ["work:assign"],
      targets: ["WorkerB"],
      grantedBy: "秘书",
    });

    const cli = join(testDir, "../comm-cli.mjs");
    const output = execFileSync(process.execPath, [
      cli,
      "assign",
      "--workers-dir",
      workersDir,
      "--from",
      "WorkerL",
      "--to",
      "WorkerB",
      "--task",
      "请调研派活接口",
      "--project",
      "talk",
      "--mode",
      "queue",
    ], { encoding: "utf8" });
    assert.match(output, /assigned/);
    const requests = listWorkerTaskRequests(workersDir);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].from, "WorkerL");
    assert.equal(requests[0].to, "WorkerB");
    assert.equal(requests[0].source, "cli");
    assert.equal(requests[0].mode, "queue");

    assert.throws(
      () => execFileSync(process.execPath, [
        cli,
        "assign",
        "--workers-dir",
        workersDir,
        "--from",
        "WorkerL",
        "--to",
        "DesignerA",
        "--task",
        "未授权派活",
      ], { encoding: "utf8", stdio: "pipe" }),
      /没有权限|Command failed/,
    );
  } finally {
    rmSync(workersDir, { recursive: true, force: true });
  }
});

test("agent assigned jobs skip user emotion scoring", () => {
  const spawnerSource = readFileSync(join(testDir, "..", "spawner.ts"), "utf8");

  assert.match(spawnerSource, /function shouldSkipUserEmotionScore/);
  assert.match(spawnerSource, /kind === "assigned-task"/);
  assert.match(spawnerSource, /kind === "inbox"/);
  assert.match(spawnerSource, /job\?\.source === "factory_command"/);
  assert.match(spawnerSource, /sourceTaskRequestId/);
  assert.match(spawnerSource, /sourceMessageId/);
  assert.match(spawnerSource, /job\?\.assignedBy/);
  assert.match(spawnerSource, /job\?\.returnTo/);
  assert.match(spawnerSource, /recordQualityEmotionAsync\(job,\s*""\)/);
  assert.doesNotMatch(spawnerSource, /recordQualityEmotionAsync\(finishedJob/);
});

test("factory command is recorded as talk with assigner metadata", () => {
  const indexSource = readFileSync(join(testDir, "../index.ts"), "utf8");
  const webServerSource = readFileSync(join(testDir, "../web-server.mjs"), "utf8");
  const webAppSource = readFileSync(join(testDir, "../web/app.js"), "utf8");

  assert.match(indexSource, /assignedBy:\s*Type\.Optional/);
  assert.match(indexSource, /source:\s*"factory_command"/);
  assert.match(indexSource, /displayChannel:\s*"talk"/);
  assert.match(indexSource, /assignedBy:\s*params\.assignedBy \|\| "主agent"/);
  assert.match(indexSource, /kind:\s*"talk"/);
  assert.match(webServerSource, /kind:\s*job\.kind \|\| ""/);
  assert.match(webServerSource, /displayChannel:\s*job\.displayChannel \|\| ""/);
  assert.match(webServerSource, /assignedBy:\s*job\.assignedBy \|\| ""/);
  assert.match(webAppSource, /j\.project === "talk" \|\| j\.kind === "talk" \|\| j\.displayChannel === "talk"/);
});

test("worker task assignment is exposed as factory tool and Pi drain", () => {
  const indexSource = readFileSync(join(testDir, "../index.ts"), "utf8");

  assert.match(indexSource, /listPendingWorkerTaskRequests/);
  assert.match(indexSource, /claimWorkerTaskRequest/);
  assert.match(indexSource, /recoverStaleWorkerTaskRequests/);
  assert.match(indexSource, /acceptWorkerTaskRequest/);
  assert.match(indexSource, /failWorkerTaskRequest/);
  assert.match(indexSource, /reportWorkerTaskResult/);
  assert.match(indexSource, /sendTaskResultMessage/);
  assert.match(indexSource, /ensureWorkerTaskPoller/);
  assert.match(indexSource, /name:\s*"factory_task_assign"/);
  assert.match(indexSource, /name:\s*"factory_task_status"/);
  assert.match(indexSource, /action:\s*"work:assign"/);
  assert.match(indexSource, /kind:\s*"assigned-task"/);
  assert.match(indexSource, /sourceTaskRequestId/);
  assert.match(indexSource, /assignedBy/);
});

test("outsource profiles are configurable white-paper agent definitions", () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-outsource-profile-test-"));
  try {
    const profile = upsertOutsourceProfile(workersDir, {
      name: "codex-coder",
      description: "匿名 Codex 写代码外包",
      backend: "codex",
      model: "5.5",
      thinking: "high",
      tools: ["read", "bash", "edit", "write"],
      skills: false,
      systemPrompt: "你是匿名外包程序员，只完成给定任务。",
      maxTurns: 30,
      defaultWait: true,
    });

    assert.equal(profile.name, "codex-coder");
    assert.equal(profile.backend, "codex");
    assert.equal(profile.skills, false);
    assert.deepEqual(profile.tools, ["read", "bash", "edit", "write"]);
    assert.equal(getOutsourceProfile(workersDir, "codex-coder").model, "5.5");
    assert.equal(listOutsourceProfiles(workersDir).length, 1);
    assert.ok(existsSync(outsourceProfilesFile(workersDir)));
  } finally {
    rmSync(workersDir, { recursive: true, force: true });
  }
});

test("outsource profiles support Claude Code backend options", () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-outsource-claude-profile-test-"));
  try {
    const profile = upsertOutsourceProfile(workersDir, {
      name: "cc-bag",
      description: "匿名 Claude Code 外包",
      backend: "claude",
      model: "sonnet",
      thinking: "low",
      claudePermissionMode: "bypassPermissions",
      claudeTools: "Read,Bash,Grep",
      claudeAllowedTools: "Read,Bash",
      claudeDisallowedTools: "Edit,Write",
      claudeBare: true,
      claudeCommand: "claude",
    });

    assert.equal(profile.backend, "claude");
    assert.equal(profile.model, "sonnet");
    assert.equal(profile.thinking, "low");
    assert.equal(profile.claudePermissionMode, "bypassPermissions");
    assert.equal(profile.claudeTools, "Read,Bash,Grep");
    assert.deepEqual(profile.claudeAllowedTools, ["Read", "Bash"]);
    assert.deepEqual(profile.claudeDisallowedTools, ["Edit", "Write"]);
    assert.equal(profile.claudeBare, true);
    assert.equal(profile.claudeCommand, "claude");
    assert.equal(getOutsourceProfile(workersDir, "cc-bag").backend, "claude");

    const runnerSource = readFileSync(join(testDir, "../outsource-runner.mjs"), "utf8");
    assert.match(runnerSource, /runClaudeWorkerStreaming/);
    assert.match(runnerSource, /backend === "claude"/);
  } finally {
    rmSync(workersDir, { recursive: true, force: true });
  }
});

test("outsource runs persist lifecycle events and derived results", () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-outsource-run-test-"));
  try {
    upsertOutsourceProfile(workersDir, {
      name: "pi-coder",
      description: "匿名 Pi 写代码外包",
      tools: ["read", "bash"],
      skills: false,
    });
    const run = createOutsourceRun(workersDir, {
      profile: "pi-coder",
      task: "实现一个按钮",
      project: "talk",
      requestedBy: "WorkerL",
      groupId: "ogroup_demo",
      cwd: "/repo",
    });
    assert.equal(run.status, "queued");
    assert.equal(run.profile, "pi-coder");

    const running = markOutsourceRunRunning(workersDir, {
      runId: run.id,
      jobId: "job-1",
      pid: 123,
    });
    assert.equal(running.status, "running");
    assert.equal(running.jobId, "job-1");

    const done = completeOutsourceRun(workersDir, {
      runId: run.id,
      status: "done",
      summary: "完成按钮",
      fullOutput: "完成按钮，测试通过。",
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    });
    assert.equal(done.status, "done");
    assert.equal(done.summary, "完成按钮");
    assert.equal(done.fullOutput, "完成按钮，测试通过。");
    assert.equal(done.inputTokens, 10);
    assert.equal(getOutsourceRun(workersDir, run.id).status, "done");
    assert.equal(listOutsourceRuns(workersDir, { groupId: "ogroup_demo" }).length, 1);
    assert.ok(existsSync(outsourceRunsFile(workersDir)));
  } finally {
    rmSync(workersDir, { recursive: true, force: true });
  }
});

test("outsource runs mirror stale linked jobs during recovery", () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-outsource-stale-test-"));
  try {
    const job = createJob(workersDir, {
      kind: "outsource-run",
      worker: "外包:whitepaper-a",
      project: "talk",
      task: "后台任务",
    });
    updateJob(job, { status: "running", startedAt: "2026-07-09T00:00:00.000Z" });
    const run = createOutsourceRun(workersDir, {
      profileName: "whitepaper-a",
      task: "后台任务",
      project: "talk",
      requestedBy: "DesignerA",
      jobId: job.id,
    });
    markOutsourceRunRunning(workersDir, {
      runId: run.id,
      jobId: job.id,
      pid: 99999999,
      startedAt: "2026-07-09T00:00:00.000Z",
    });

    const summary = recoverOpenJobsOnStartup(workersDir, "previous Pi process exited", {
      now: new Date("2026-07-09T00:01:00.000Z"),
      checkOwnerPid: false,
    });

    assert.equal(summary.stale, 1);
    const staleRun = getOutsourceRun(workersDir, run.id);
    assert.equal(readJob(job.jobFile).status, "stale");
    assert.equal(staleRun.status, "stale");
    assert.equal(staleRun.error, "previous Pi process exited");
    assert.equal(staleRun.events.some((event) => event.type === "stale"), true);
    assert.equal(OUTSOURCE_TERMINAL_STATUSES.has("stale"), true);
  } finally {
    rmSync(workersDir, { recursive: true, force: true });
  }
});

test("outsource Pi runner does not recursively spawn outsource CLI with Pi flags", () => {
  const piArgs = ["--mode", "json", "-p", "--no-session", "Task: 搜索功能"];
  const invocation = getPiInvocation(piArgs, {
    currentScript: "/tmp/ox-factory-host/.pi/extensions/ox-factory/outsource-cli.mjs",
    execPath: "/usr/local/bin/node",
    exists: () => true,
  });

  assert.equal(invocation.command, "pi");
  assert.deepEqual(invocation.args, piArgs);
  assert.notEqual(invocation.args[0], "/tmp/ox-factory-host/.pi/extensions/ox-factory/outsource-cli.mjs");
});

test("outsource worker does not recursively spawn itself with Pi flags", () => {
  const piArgs = ["--mode", "json", "-p", "--no-session", "Task: 删除左导航"];
  const invocation = getPiInvocation(piArgs, {
    currentScript: "/tmp/ox-factory-host/.pi/extensions/ox-factory/outsource-worker.mjs",
    execPath: "/usr/local/bin/node",
    exists: () => true,
  });

  assert.equal(invocation.command, "pi");
  assert.deepEqual(invocation.args, piArgs);
  assert.notEqual(invocation.args[0], "/tmp/ox-factory-host/.pi/extensions/ox-factory/outsource-worker.mjs");
});

test("outsource Pi runner builds memoryless white-paper child process arguments", () => {
  const built = buildOutsourcePiArgs({
    profile: {
      name: "pi-coder",
      backend: "pi",
      model: "doubao-seed-code",
      thinking: "medium",
      tools: ["read", "bash", "edit", "write"],
      skills: false,
    },
    task: "实现一个函数",
    systemPromptPath: "/tmp/outsourcing.md",
  });

  assert.deepEqual(built.args.slice(0, 4), ["--mode", "json", "-p", "--no-session"]);
  assert.ok(built.args.includes("--no-skills"));
  assert.ok(built.args.includes("--system-prompt"));
  assert.ok(built.args.includes("/tmp/outsourcing.md"));
  assert.ok(built.args.includes("--tools"));
  assert.ok(built.args.includes("read,bash,edit,write"));
  assert.ok(built.args.includes("--model"));
  assert.ok(built.args.includes("doubao-seed-code"));
  assert.ok(built.args.at(-1).includes("Task: 实现一个函数"));
});

test("outsource dispatcher starts a runnable job and completes the same run", async () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-outsource-dispatch-test-"));
  try {
    const profile = upsertOutsourceProfile(workersDir, {
      name: "whitepaper-a",
      backend: "pi",
      model: "model_api/experimental_0630",
      tools: ["read", "bash"],
      skills: false,
    });

    const { run, job, promise } = startOutsourceRunJob({
      workersDir,
      profile,
      task: "只回复 ok",
      project: "talk",
      cwd: workersDir,
      requestedBy: "DesignerA",
      runner: async (_input, onEvent) => {
        onEvent({ type: "text", text: "ok" });
        return {
          exitCode: 0,
          output: "ok",
          stderr: "",
          turns: 1,
          inputTokens: 3,
          cachedInputTokens: 0,
          outputTokens: 1,
          reasoningOutputTokens: 0,
          totalTokens: 4,
          model: "fake-model",
        };
      },
    });

    assert.equal(run.status, "running");
    assert.equal(run.jobId, job.id);
    assert.equal(job.worker, "外包:whitepaper-a");

    const result = await promise;
    assert.equal(result.output, "ok");

    const done = getOutsourceRun(workersDir, run.id);
    assert.equal(done.status, "done");
    assert.equal(done.summary, "ok");
    assert.equal(done.jobId, job.id);
    assert.equal(done.requestedBy, "DesignerA");
    assert.equal(readJob(job.jobFile).status, "done");
    assert.match(renderOutsourceWaitResult({ status: "completed", mode: "all", runs: [done] }), /外包执行完成/);
  } finally {
    rmSync(workersDir, { recursive: true, force: true });
  }
});

test("outsource dispatcher detaches background runs from the calling process", async () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-outsource-detach-test-"));
  try {
    const profile = upsertOutsourceProfile(workersDir, {
      name: "whitepaper-a",
      backend: "pi",
      model: "model_api/experimental_0630",
      tools: ["read", "bash"],
      skills: false,
    });

    let runnerCalled = false;
    let spawned = null;
    const { run, job, promise } = startOutsourceRunJob({
      workersDir,
      profile,
      task: "后台跑，不要依赖父进程",
      project: "talk",
      cwd: workersDir,
      requestedBy: "DesignerA",
      detached: true,
      spawnDetached: (input) => {
        spawned = input;
        return { pid: 12345 };
      },
      runner: async () => {
        runnerCalled = true;
        return { exitCode: 0, output: "should not run in parent" };
      },
    });

    assert.equal(runnerCalled, false);
    assert.equal(spawned?.run?.id, run.id);
    assert.equal(spawned?.job?.id, job.id);
    assert.equal(readJob(job.jobFile).status, "running");
    assert.equal(readJob(job.jobFile).ownerPid, 12345);
    assert.equal(getOutsourceRun(workersDir, run.id).status, "running");

    const result = await promise;
    assert.equal(result.detached, true);
    assert.equal(result.pid, 12345);
  } finally {
    rmSync(workersDir, { recursive: true, force: true });
  }
});

test("outsource CLI is documented for workers and uses the shared dispatcher", () => {
  const packageJson = readFileSync(join(testDir, "../package.json"), "utf8");
  const handbook = readFileSync(join(testDir, "../factory-handbook.mjs"), "utf8");
  const cli = readFileSync(join(testDir, "../outsource-cli.mjs"), "utf8");
  const indexSource = readFileSync(join(testDir, "../index.ts"), "utf8");

  assert.match(packageJson, /outsource-dispatcher\.mjs/);
  assert.match(packageJson, /outsource-cli\.mjs/);
  assert.match(handbook, /outsource-cli\.mjs/);
  assert.match(handbook, /--from/);
  assert.match(handbook, /--profile/);
  assert.match(cli, /startOutsourceRunJob/);
  assert.match(cli, /command === "run"/);
  assert.match(cli, /--task-file/);
  assert.match(indexSource, /from "\.\/outsource-dispatcher\.mjs"/);
});

test("web outsource run API starts the shared dispatcher instead of creating orphan queued runs", () => {
  const webServerSource = readFileSync(join(testDir, "../web-server.mjs"), "utf8");

  assert.match(webServerSource, /startOutsourceRunJob/);
  assert.match(webServerSource, /from "\.\/outsource-dispatcher\.mjs"/);
  assert.doesNotMatch(webServerSource, /createOutsourceRun/);
  assert.doesNotMatch(webServerSource, /sendAuthorizedMessage/);
  assert.doesNotMatch(webServerSource, /真正调度需要 Pi 主 agent/);
});

test("outsource mode is exposed as factory tools without replacing worker delegation", () => {
  const indexSource = readFileSync(join(testDir, "../index.ts"), "utf8");
  const dispatcherSource = readFileSync(join(testDir, "../outsource-dispatcher.mjs"), "utf8");
  const packageJson = readFileSync(join(testDir, "../package.json"), "utf8");

  assert.match(indexSource, /name:\s*"factory_outsource_profiles"/);
  assert.match(indexSource, /name:\s*"factory_outsource_run"/);
  assert.match(indexSource, /name:\s*"factory_outsource_status"/);
  assert.match(indexSource, /name:\s*"factory_outsource_wait"/);
  assert.match(indexSource, /name:\s*"factory_outsource_result"/);
  assert.match(indexSource, /startOutsourceRunJob/);
  assert.match(indexSource, /waitForOutsourceRuns/);
  assert.match(dispatcherSource, /runOutsourceAgentStreaming/);
  assert.match(dispatcherSource, /kind:\s*"outsource-run"/);
  assert.match(dispatcherSource, /background/);
  assert.match(packageJson, /outsource-agents\.mjs/);
  assert.match(packageJson, /outsource-runner\.mjs/);
  assert.match(packageJson, /outsource-dispatcher\.mjs/);
});

test("codex worker and outsource execution have no default wall-clock timeout", () => {
  const codexBackendSource = readFileSync(join(testDir, "../codex-backend.mjs"), "utf8");
  const outsourceRunnerSource = readFileSync(join(testDir, "../outsource-runner.mjs"), "utf8");
  const outsourceAgentsSource = readFileSync(join(testDir, "../outsource-agents.mjs"), "utf8");
  const outsourceCliSource = readFileSync(join(testDir, "../outsource-cli.mjs"), "utf8");
  const indexSource = readFileSync(join(testDir, "../index.ts"), "utf8");
  const profile = normalizeOutsourceProfile({ name: "whitepaper-a", backend: "codex" });

  assert.equal(profile.timeoutMs, 0);
  assert.doesNotMatch(codexBackendSource, /Timed out waiting for Codex turn completion/);
  assert.doesNotMatch(outsourceRunnerSource, /Timed out waiting for Codex outsource turn completion/);
  assert.match(outsourceAgentsSource, /timeoutMs\s*=\s*0/);
  assert.match(outsourceAgentsSource, /Number\(timeoutMs\)\s*>\s*0/);
  assert.doesNotMatch(outsourceCliSource, /30 \* 60 \* 1000/);
  assert.doesNotMatch(indexSource, /profile\.timeoutMs \|\| 30 \* 60 \* 1000/);
  assert.doesNotMatch(indexSource, /params\.timeoutMs \|\| 30 \* 60 \* 1000/);
  assert.match(indexSource, /不填\/0=不超时/);
});

test("outsource mode is tracked in quality checklist and market report", () => {
  const checklist = readFileSync(join(testDir, "../docs/ox-factory-quality-checklist.md"), "utf8");
  const tracker = readFileSync(join(testDir, "../docs/ox-factory-improvement-tracker.md"), "utf8");
  const report = readFileSync(join(testDir, "../docs/ox-factory-subagent-market-report.md"), "utf8");

  assert.match(checklist, /OF-037/);
  assert.match(checklist, /外包模式/);
  assert.match(checklist, /白纸/);
  assert.match(tracker, /OF-037/);
  assert.match(report, /OutsourceAgentProfile|外包模式/);
});

test("web task requests are event-sourced for dashboard delegation", () => {
  const webServerSource = readFileSync(join(testDir, "../web-server.mjs"), "utf8");

  assert.match(webServerSource, /createWorkerTaskRequest/);
  assert.match(webServerSource, /listWorkerTaskRequests/);
  assert.match(webServerSource, /getWorkerTaskRequest/);
  assert.match(webServerSource, /POST \/api\/task-requests/);
  assert.match(webServerSource, /handleWorkerTaskRequestCreate/);
  assert.match(webServerSource, /handleWorkerTaskRequestStatus/);
  assert.doesNotMatch(webServerSource, /createJob\(workersDir,\s*\{\s*kind:\s*"assigned-task"/);
});

test("web dashboard exposes factory task board and keeps worker request audit route", () => {
  const html = readFileSync(join(testDir, "../web/index.html"), "utf8");
  const webAppSource = readFileSync(join(testDir, "../web/app.js"), "utf8");
  const styleSource = readFileSync(join(testDir, "../web/styles.css"), "utf8");

  assert.match(html, /data-route="tasks"/);
  assert.match(html, /data-i18n="nav\.tasks"/);
  assert.match(webAppSource, /"nav\.tasks":\s*"任务看板"/);
  assert.match(webAppSource, /async function renderTaskRequests/);
  assert.match(webAppSource, /api\("\/api\/task-requests/);
  assert.match(webAppSource, /route === "task-requests"/);
  assert.match(webAppSource, /renderTaskRequests\(\)/);
  assert.match(webAppSource, /openTaskRequestDrawer/);
  assert.match(styleSource, /\.task-grid/);
  assert.match(styleSource, /\.task-request-card/);
});

test("worker responsibilities are append-only, upserted, and removable", () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-responsibility-test-"));
  try {
    setWorkerResponsibility(workersDir, {
      worker: "DeveloperA",
      project: "牛马工厂 Web 大盘",
      relation: "lead",
      scope: "负责本地 Web 的前端体验、项目态势和视觉 polish",
      updatedBy: "主agent",
    });
    setWorkerResponsibility(workersDir, {
      worker: "DeveloperA",
      project: "牛马工厂 Web 大盘",
      relation: "lead",
      scope: "负责 Overview 大盘、项目态势和 War Room 视觉",
      updatedBy: "LocalAdmin",
    });
    setWorkerResponsibility(workersDir, {
      worker: "Foreman",
      project: "工厂日报",
      relation: "owner",
      scope: "负责日报上下文核对和每日归档",
    });

    const dongzi = listWorkerResponsibilities(workersDir, { worker: "DeveloperA" });
    assert.equal(dongzi.length, 1);
    assert.equal(dongzi[0].worker, "DeveloperA");
    assert.equal(dongzi[0].project, "牛马工厂 Web 大盘");
    assert.equal(dongzi[0].relation, "lead");
    assert.equal(dongzi[0].scope, "负责 Overview 大盘、项目态势和 War Room 视觉");
    assert.equal(dongzi[0].status, "active");
    assert.equal(dongzi[0].updatedBy, "LocalAdmin");

    const all = listWorkerResponsibilities(workersDir);
    assert.deepEqual(
      new Set(all.map((r) => r.worker)),
      new Set(["DeveloperA", "Foreman"]),
    );

    removeWorkerResponsibility(workersDir, {
      worker: "DeveloperA",
      project: "牛马工厂 Web 大盘",
      relation: "lead",
      updatedBy: "主agent",
    });

    assert.equal(listWorkerResponsibilities(workersDir, { worker: "DeveloperA" }).length, 0);
    const inactive = listWorkerResponsibilities(workersDir, { worker: "DeveloperA", includeInactive: true });
    assert.equal(inactive.length, 1);
    assert.equal(inactive[0].status, "removed");
  } finally {
    rmSync(workersDir, { recursive: true, force: true });
  }
});

test("project store records lightweight project metadata and operational state", () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-project-test-"));
  try {
    const created = upsertProject(workersDir, {
      id: "ox-factory-web",
      name: "牛马工厂 Web 大盘",
      summary: "本地只读工厂驾驶舱",
      status: "active",
      priority: "P1",
      aliases: ["web-dashboard", "工厂大盘"],
      truthRef: "docs/ox-projects/ox-factory-web.md",
      truthType: "markdown",
      truthNote: "项目 checklist 以此文档为准",
      dashboardUrl: "http://127.0.0.1:8787",
      updatedBy: "LocalAdmin",
    });
    assert.equal(created.id, "ox-factory-web");
    assert.equal(created.name, "牛马工厂 Web 大盘");
    assert.equal(created.truth.ref, "docs/ox-projects/ox-factory-web.md");
    assert.deepEqual(new Set(created.aliases), new Set(["web-dashboard", "工厂大盘"]));

    upsertProject(workersDir, {
      id: "ox-factory-web",
      summary: "本地只读工厂驾驶舱，展示员工、项目、任务、token、日报和压缩评估",
      aliases: ["factory-dashboard"],
    });
    upsertProject(workersDir, {
      id: "ox-factory-web",
      aliases: ["大盘"],
    });
    setProjectMember(workersDir, {
      project: "工厂大盘",
      worker: "DesignerA",
      relation: "designer",
      note: "负责 Web 视觉和交互",
    });
    setProjectTodo(workersDir, {
      project: "web-dashboard",
      todoId: "project-page",
      title: "新增项目视角页面",
      status: "todo",
      owner: "DesignerA",
      evidence: "docs/ox-factory-project-entity-design.md",
    });
    setProjectWorktree(workersDir, {
      project: "ox-factory-web",
      worktreeId: "hachimura-ui",
      path: ".pi/workers/worktrees/ox-factory-web/hachimura-ui",
      branch: "feat/project-view",
      worker: "DesignerA",
      status: "active",
    });
    addProjectProgress(workersDir, {
      project: "factory-dashboard",
      text: "Project Entity MVP 进入实现阶段",
      status: "doing",
      owner: "LocalAdmin",
      evidence: "projects.jsonl",
    });

    const project = resolveProject(workersDir, "工厂大盘");
    assert.equal(project.id, "ox-factory-web");
    assert.match(project.summary, /token/);
    assert.deepEqual(new Set(project.aliases), new Set(["web-dashboard", "工厂大盘", "factory-dashboard", "大盘"]));
    assert.equal(project.members.length, 1);
    assert.equal(project.members[0].worker, "DesignerA");
    assert.equal(project.todos.length, 1);
    assert.equal(project.todos[0].id, "project-page");
    assert.equal(project.worktrees.length, 1);
    assert.equal(project.worktrees[0].branch, "feat/project-view");
    assert.equal(project.progress.length, 1);
    assert.match(project.progress[0].text, /MVP/);

    const projects = listProjects(workersDir);
    assert.equal(projects.length, 1);
    assert.match(formatProjectsMarkdown(projects), /牛马工厂 Web 大盘/);
    assert.match(formatProjectMarkdown(project), /## Worktrees/);
    assert.match(formatProjectMarkdown(project), /新增项目视角页面/);
  } finally {
    rmSync(workersDir, { recursive: true, force: true });
  }
});

test("project markdown doc resolver only serves registered local markdown refs", () => {
  const root = mkdtempSync(join(tmpdir(), "ox-project-doc-test-"));
  try {
    const extensionRoot = join(root, "ext");
    const repoRoot = join(root, "repo");
    mkdirSync(join(extensionRoot, "docs"), { recursive: true });
    mkdirSync(join(repoRoot, "notes"), { recursive: true });
    writeFileSync(join(extensionRoot, "docs", "project.md"), "# Project Doc\n", "utf8");
    writeFileSync(join(repoRoot, "notes", "extra.md"), "# Extra Doc\n", "utf8");

    const project = {
      id: "demo",
      truth: { type: "markdown", ref: "docs/project.md" },
      links: [{ type: "markdown", label: "extra", ref: "notes/extra.md" }],
    };

    const truth = resolveProjectMarkdownDocRef({ project, extensionRoot, repoRoot });
    assert.equal(truth.ok, true);
    assert.equal(truth.ref, "docs/project.md");
    assert.equal(truth.filePath, join(extensionRoot, "docs", "project.md"));

    const extra = resolveProjectMarkdownDocRef({ project, ref: "notes/extra.md", extensionRoot, repoRoot });
    assert.equal(extra.ok, true);
    assert.equal(extra.filePath, join(repoRoot, "notes", "extra.md"));

    const rejected = resolveProjectMarkdownDocRef({ project, ref: "../secret.md", extensionRoot, repoRoot });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.status, 403);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("token report prefers session usage and uses job tokens only as fallback", () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-token-report-test-"));
  try {
    const sessionsDir = join(workersDir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, "LocalAdmin.jsonl"),
      [
        JSON.stringify({
          type: "message",
          timestamp: "2026-06-30T01:00:00.000Z",
          message: {
            role: "assistant",
            model: "MiniMax-M3",
            usage: { input: 1000, cacheRead: 800, cacheWrite: 0, output: 200, reasoningOutputTokens: 50, totalTokens: 2000 },
          },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const paipaiJob = createJob(workersDir, {
      kind: "talk",
      worker: "LocalAdmin",
      project: "talk",
      task: "同一天同一个员工的 job token 不应和 session 重复相加",
    });
    updateJob(paipaiJob, {
      status: "done",
      createdAt: "2026-06-30T01:05:00.000Z",
      finishedAt: "2026-06-30T01:10:00.000Z",
      inputTokens: 9999,
      outputTokens: 999,
    });

    const codexJob = createJob(workersDir, {
      kind: "talk",
      worker: "小码",
      project: "codex",
      task: "Codex job fallback",
    });
    updateJob(codexJob, {
      status: "done",
      createdAt: "2026-06-30T02:00:00.000Z",
      finishedAt: "2026-06-30T02:10:00.000Z",
      inputTokens: 300,
      cachedInputTokens: 120,
      outputTokens: 40,
      reasoningOutputTokens: 7,
      totalTokens: 340,
      model: "gpt-5.5",
    });

    const report = buildFactoryTokenReport({ workersDir, date: "2026-06-30" });
    const paipai = report.workers.find((worker) => worker.worker === "LocalAdmin");
    assert.equal(paipai.reported.inputTokens, 1000);
    assert.equal(paipai.reported.outputTokens, 200);
    assert.equal(paipai.reported.totalTokens, 1200);
    assert.equal(paipai.reported.cachedInputTokens, 800);
    assert.equal(paipai.reported.reasoningOutputTokens, 50);
    assert.equal(paipai.reported.totalWithCachedTokens, 2000);
    assert.equal(paipai.source, "session");
    assert.equal(paipai.job.inputTokens, 9999);

    const codex = report.workers.find((worker) => worker.worker === "小码");
    assert.equal(codex.reported.inputTokens, 300);
    assert.equal(codex.reported.outputTokens, 40);
    assert.equal(codex.reported.cachedInputTokens, 120);
    assert.equal(codex.reported.reasoningOutputTokens, 7);
    assert.equal(codex.reported.totalTokens, 340);
    assert.equal(codex.reported.totalWithCachedTokens, 460);
    assert.equal(codex.source, "job");

    assert.equal(report.totals.inputTokens, 1300);
    assert.equal(report.totals.cachedInputTokens, 920);
    assert.equal(report.totals.outputTokens, 240);
    assert.equal(report.totals.reasoningOutputTokens, 57);
    assert.equal(report.totals.totalWithCachedTokens, 2460);
    assert.match(formatFactoryTokenReport(report), /工厂 Token 报告/);
    assert.doesNotMatch(formatFactoryTokenReport(report), /成本|¥|cost/i);
  } finally {
    rmSync(workersDir, { recursive: true, force: true });
  }
});

test("codex rollout token report sums per-task cumulative usage deltas", () => {
  const lines = [
    JSON.stringify({
      timestamp: "2026-07-05T15:59:50.000Z",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 40,
            output_tokens: 10,
            reasoning_output_tokens: 3,
            total_tokens: 110,
          },
          last_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 40,
            output_tokens: 10,
            total_tokens: 110,
          },
        },
      },
    }),
    JSON.stringify({ timestamp: "2026-07-05T16:00:00.000Z", payload: { type: "task_started" } }),
    JSON.stringify({ timestamp: "2026-07-05T16:00:01.000Z", payload: { type: "user_message", message: "今天在北京时间" } }),
    JSON.stringify({
      timestamp: "2026-07-05T16:01:00.000Z",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 130,
            cached_input_tokens: 60,
            output_tokens: 12,
            reasoning_output_tokens: 4,
            total_tokens: 142,
          },
          last_token_usage: {
            input_tokens: 30,
            cached_input_tokens: 20,
            output_tokens: 2,
            total_tokens: 32,
          },
        },
      },
    }),
    JSON.stringify({
      timestamp: "2026-07-05T16:02:00.000Z",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 180,
            cached_input_tokens: 90,
            output_tokens: 20,
            reasoning_output_tokens: 8,
            total_tokens: 200,
          },
          last_token_usage: {
            input_tokens: 50,
            cached_input_tokens: 30,
            output_tokens: 8,
            total_tokens: 58,
          },
        },
      },
    }),
    JSON.stringify({ timestamp: "2026-07-05T16:02:05.000Z", payload: { type: "task_complete" } }),
  ];

  const segments = parseCodexRolloutLines(lines, { date: "2026-07-06", timezoneOffsetMinutes: 8 * 60 });
  assert.equal(segments.length, 1);
  assert.equal(segments[0].date, "2026-07-06");
  assert.equal(segments[0].prompt, "今天在北京时间");
  assert.deepEqual(segments[0].usage, {
    inputTokens: 80,
    cachedInputTokens: 50,
    outputTokens: 10,
    reasoningOutputTokens: 5,
    totalTokens: 90,
    totalWithCachedTokens: 140,
  });

  const summary = summarizeSegments(segments);
  assert.equal(summary.segmentCount, 1);
  assert.equal(summary.totals.totalTokens, 90);
  assert.equal(summary.totals.totalWithCachedTokens, 140);
});

test("codex rollout token repair can patch matched done job metadata", () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-codex-token-repair-test-"));
  try {
    const job = createJob(workersDir, {
      kind: "talk",
      worker: "DeveloperB",
      project: "talk",
      task: "发布 showcase",
    });
    updateJob(job, {
      status: "done",
      createdAt: "2026-07-06T01:00:00.000Z",
      finishedAt: "2026-07-06T01:10:00.000Z",
      inputTokens: 10,
      cachedInputTokens: 5,
      outputTokens: 1,
      totalTokens: 11,
    });
    const report = {
      date: "2026-07-06",
      timezoneOffset: "+08:00",
      worker: "DeveloperB",
      threadId: "thread-1",
      rolloutFile: "/tmp/rollout.jsonl",
      segments: [{
        startAt: "2026-07-06T01:00:01.000Z",
        endAt: "2026-07-06T01:05:00.000Z",
        prompt: "你的名字叫 **DeveloperB**。\n## 任务\n发布 showcase",
        usage: {
          inputTokens: 100,
          cachedInputTokens: 80,
          outputTokens: 20,
          reasoningOutputTokens: 7,
          totalTokens: 120,
          totalWithCachedTokens: 200,
        },
      }],
    };

    const preview = repairCodexJobTokenMetadata(report, { workersDir, apply: false });
    assert.equal(preview.changed, 1);
    assert.equal(readJob(job.jobFile).totalTokens, 11);

    const applied = repairCodexJobTokenMetadata(report, { workersDir, apply: true });
    assert.equal(applied.changed, 1);
    const repaired = readJob(job.jobFile);
    assert.equal(repaired.inputTokens, 100);
    assert.equal(repaired.cachedInputTokens, 80);
    assert.equal(repaired.outputTokens, 20);
    assert.equal(repaired.reasoningOutputTokens, 7);
    assert.equal(repaired.totalTokens, 120);
    assert.equal(repaired.tokenSource, "codex-rollout-delta");
    assert.equal(repaired.tokenRepair.previous.totalTokens, 11);
  } finally {
    rmSync(workersDir, { recursive: true, force: true });
  }
});

test("token trend aggregates multiple days from one token index", () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-token-trend-test-"));
  try {
    const sessionsDir = join(workersDir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, "LocalAdmin.jsonl"),
      [
        JSON.stringify({
          type: "message",
          timestamp: "2026-07-02T01:00:00.000Z",
          message: { role: "assistant", usage: { input: 100, output: 20, cacheRead: 30 } },
        }),
        JSON.stringify({
          type: "message",
          timestamp: "2026-07-04T01:00:00.000Z",
          message: { role: "assistant", usage: { input: 200, output: 50, cacheRead: 70 } },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const job = createJob(workersDir, {
      kind: "talk",
      worker: "小码",
      project: "codex",
      task: "trend fallback",
    });
    updateJob(job, {
      status: "done",
      createdAt: "2026-07-03T02:00:00.000Z",
      finishedAt: "2026-07-03T02:10:00.000Z",
      inputTokens: 40,
      outputTokens: 10,
    });
    // updateJob stamps updatedAt with "now"; pin it so this test does not
    // depend on the calendar date it is executed.
    job.updatedAt = "2026-07-03T02:10:00.000Z";
    writeFileSync(job.jobFile, `${JSON.stringify(job, null, 2)}\n`, "utf8");

    const trend = buildFactoryTokenTrend({
      workersDir,
      days: 3,
      endDate: new Date("2026-07-04T12:00:00.000Z"),
    });
    assert.deepEqual(trend.days.map((day) => day.date), ["2026-07-02", "2026-07-03", "2026-07-04"]);
    assert.equal(trend.days[0].totalWithCachedTokens, 150);
    assert.equal(trend.days[1].totalWithCachedTokens, 50);
    assert.equal(trend.days[2].totalWithCachedTokens, 320);
    assert.equal(trend.summary.totalWithCachedTokens, 520);
  } finally {
    rmSync(workersDir, { recursive: true, force: true });
  }
});

test("token report CLI prints token-only output", () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-token-cli-test-"));
  try {
    const job = createJob(workersDir, {
      kind: "talk",
      worker: "DeveloperA",
      project: "token",
      task: "token smoke",
    });
    updateJob(job, {
      status: "done",
      createdAt: "2026-06-30T03:00:00.000Z",
      finishedAt: "2026-06-30T03:10:00.000Z",
      inputTokens: 1738735,
      cachedInputTokens: 9500000,
      outputTokens: 360000,
      reasoningOutputTokens: 1200,
      totalTokens: 2098735,
    });

    const output = execFileSync(process.execPath, [
      join(testDir, "../token-report-cli.mjs"),
      "--workers-dir",
      workersDir,
      "--date",
      "2026-06-30",
    ], { encoding: "utf8" });

    assert.match(output, /工厂 Token 报告/);
    assert.match(output, /DeveloperA/);
    assert.match(output, /1\.74M/);
    assert.match(output, /9\.50M/);
    assert.match(output, /360K/);
    assert.match(output, /1\.20K/);
    assert.match(output, /2\.10M/);
    assert.match(output, /11\.60M/);
    assert.doesNotMatch(output, /1,738,735/);
    assert.match(output, /缓存输入 Token/);
    assert.match(output, /含缓存合计/);
    assert.doesNotMatch(output, /成本|¥|cost/i);

    const jsonOutput = execFileSync(process.execPath, [
      join(testDir, "../token-report-cli.mjs"),
      "--workers-dir",
      workersDir,
      "--date",
      "2026-06-30",
      "--json",
    ], { encoding: "utf8" });
    const jsonReport = JSON.parse(jsonOutput);
    const dongzi = jsonReport.workers.find((worker) => worker.worker === "DeveloperA");
    assert.equal(dongzi.reported.inputTokens, 1738735);
    assert.equal(dongzi.reported.cachedInputTokens, 9500000);
    assert.equal(dongzi.reported.outputTokens, 360000);
    assert.equal(dongzi.reported.reasoningOutputTokens, 1200);
    assert.equal(dongzi.reported.totalTokens, 2098735);
    assert.equal(dongzi.reported.totalWithCachedTokens, 11598735);
  } finally {
    rmSync(workersDir, { recursive: true, force: true });
  }
});



test("factory pick is exposed as a tool and slash command", () => {
  const indexSource = readFileSync(join(testDir, "../index.ts"), "utf8");
  assert.match(indexSource, /name:\s*"factory_pick"/);
  assert.match(indexSource, /registerCommand\("pick"/);
  assert.match(indexSource, /--peek/);
  assert.match(indexSource, /pickUnreadJob/);
});

test("pick command attaches the picked worker to talk unless peeking", () => {
  const indexSource = readFileSync(join(testDir, "../index.ts"), "utf8");
  const attachBlock = indexSource.match(/function attachPickedJobToTalk[\s\S]*?\n  }\n\n  pi\.registerCommand\("talk"/)?.[0] || "";
  const pickBlock = indexSource.match(/pi\.registerCommand\("pick"[\s\S]*?\n  }\);\n\n  pi\.registerCommand\("report"/)?.[0] || "";

  assert.match(attachBlock, /talkTarget\s*=\s*workerId/);
  assert.match(attachBlock, /activeTalkJobId\s*=\s*isTerminalJob\(picked\.job\)\s*\?\s*null\s*:\s*picked\.job\.id/);
  assert.match(attachBlock, /sendTalkMessage\(workerId/);
  assert.match(attachBlock, /customType:\s*"ox-talk-attached"/);
  assert.match(pickBlock, /!pickArgs\.peek/);
  assert.match(pickBlock, /attachPickedJobToTalk\(picked,\s*content,\s*ctx\)/);
});

test("token report is exposed as a natural-language tool without a slash command", () => {
  const indexSource = readFileSync(join(testDir, "../index.ts"), "utf8");

  assert.doesNotMatch(indexSource, /registerCommand\(["']tokens["']/);
  assert.match(indexSource, /factory_token_report/);
  assert.match(indexSource, /自然语言/);
  assert.match(indexSource, /token 消耗/);
});

test("command mode and message wake are exposed as factory tools", () => {
  const indexSource = readFileSync(join(testDir, "../index.ts"), "utf8");

  assert.match(indexSource, /name:\s*"factory_command"/);
  assert.match(indexSource, /wake:\s*Type\.Optional/);
  assert.match(indexSource, /enqueueWorkerCommand/);
});

test("worker vacation status and job cancellation are exposed", () => {
  const indexSource = readFileSync(join(testDir, "../index.ts"), "utf8");
  const registrySource = readFileSync(join(testDir, "../registry.ts"), "utf8");
  const typesSource = readFileSync(join(testDir, "../types.ts"), "utf8");
  const webServerSource = readFileSync(join(testDir, "../web-server.mjs"), "utf8");
  const workerRegistrySnapshotSource = readFileSync(join(testDir, "../worker-registry-snapshot.mjs"), "utf8");

  assert.match(typesSource, /WorkerStatus = "idle" \| "working" \| "vacation" \| "fired"/);
  assert.match(typesSource, /STATUS: "ox-worker-status"/);
  assert.match(registrySource, /export function setWorkerStatus/);
  assert.match(registrySource, /EntryTypes\.STATUS/);
  assert.match(registrySource, /w\.status !== "vacation"/);
  assert.match(indexSource, /name:\s*"factory_worker_status"/);
  assert.match(indexSource, /name:\s*"factory_cancel_job"/);
  assert.match(indexSource, /registerCommand\("cancel"/);
  assert.match(indexSource, /workerJobControllers/);
  assert.match(indexSource, /cancelWorkerJob/);
  assert.match(indexSource, /Codex 后端.*当前 turn/);
  assert.match(indexSource, /Pi 后端.*当前 job 后优先执行/);
  assert.match(indexSource, /canSteerActiveCodexTurn/);
  assert.match(workerRegistrySnapshotSource, /ox-worker-status/);
  assert.match(webServerSource, /regInfo\.status === "vacation"/);
});

test("ox web command starts and opens the local dashboard", () => {
  const indexSource = readFileSync(join(testDir, "../index.ts"), "utf8");

  assert.match(indexSource, /registerCommand\("ox-web"/);
  assert.match(indexSource, /ensureOxWebDashboard/);
  assert.match(indexSource, /isOxWebDashboardHealthy/);
  assert.match(indexSource, /checkOxWebDashboard/);
  assert.match(indexSource, /\/api\/task-requests\?limit=1/);
  assert.match(indexSource, /stopOxWebDashboardOnPort/);
  assert.match(indexSource, /listeningPidForPort/);
  assert.match(indexSource, /检测到旧版牛马工厂 Web 服务/);
  assert.match(indexSource, /web-server\.mjs/);
  assert.match(indexSource, /openExternalUrl/);
  assert.match(indexSource, /127\.0\.0\.1/);
  assert.match(indexSource, /--status/);
  assert.match(indexSource, /--no-open/);
});

test("web health advertises feature flags used by ox-web stale detection", () => {
  const webServerSource = readFileSync(join(testDir, "../web-server.mjs"), "utf8");
  const indexSource = readFileSync(join(testDir, "../index.ts"), "utf8");

  assert.match(webServerSource, /features:\s*\{/);
  assert.match(webServerSource, /taskRequests:\s*true/);
  assert.match(webServerSource, /factoryTasks:\s*true/);
  assert.match(webServerSource, /compactJobTimeline:\s*true/);
  assert.match(indexSource, /parsed\?\.features\?\.taskRequests[\s\S]{0,120}parsed\?\.features\?\.factoryTasks/);
});

test("web talk requests are event-sourced and do not create jobs in web-server", () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-web-talk-test-"));
  try {
    const request = createWebTalkRequest(workersDir, {
      worker: "DesignerA",
      message: "你好",
      from: "web",
    });
    assert.equal(request.status, "pending");
    assert.equal(listPendingWebTalkRequests(workersDir).length, 1);
    const rawRequestEvent = JSON.parse(readFileSync(webTalkRequestsFile(workersDir), "utf8").trim().split("\n")[0]);
    assert.equal(rawRequestEvent.type, "request_v2");

    const claimed = claimWebTalkRequest(workersDir, {
      requestId: request.id,
      claimedBy: "poller-a",
    });
    assert.equal(claimed.status, "processing");
    assert.equal(claimed.claimedBy, "poller-a");
    assert.equal(listPendingWebTalkRequests(workersDir).length, 0);

    const duplicateClaim = claimWebTalkRequest(workersDir, {
      requestId: request.id,
      claimedBy: "poller-b",
    });
    assert.equal(duplicateClaim, null);

    const accepted = acceptWebTalkRequest(workersDir, {
      requestId: request.id,
      jobId: "job-1",
      deliveryMode: "message",
      placement: "马上开始",
    });
    assert.equal(accepted.status, "accepted");
    assert.equal(accepted.jobId, "job-1");
    assert.equal(listPendingWebTalkRequests(workersDir).length, 0);
    assert.equal(getWebTalkRequest(workersDir, request.id).status, "accepted");

    const failedRequest = createWebTalkRequest(workersDir, {
      worker: "DesignerA",
      message: "第二条",
    });
    const failed = failWebTalkRequest(workersDir, {
      requestId: failedRequest.id,
      error: "员工休假",
    });
    assert.equal(failed.status, "failed");
    assert.equal(failed.error, "员工休假");
    assert.equal(listWebTalkRequests(workersDir).length, 2);

    const webServerSource = readFileSync(join(testDir, "../web-server.mjs"), "utf8");
    const indexSource = readFileSync(join(testDir, "../index.ts"), "utf8");
    assert.match(webServerSource, /createWebTalkRequest/);
    assert.match(webServerSource, /getWorkerRegistry\(workersDir\)/);
    assert.match(webServerSource, /Codex 后端员工的真实 session/);
    assert.doesNotMatch(webServerSource, /sessions\/ 下找不到对应 session/);
    assert.doesNotMatch(webServerSource, /createJob\(workersDir,\s*\{\s*kind:\s*"talk"/);
    assert.match(indexSource, /listPendingWebTalkRequests/);
    assert.match(indexSource, /claimWebTalkRequest/);
    assert.match(indexSource, /const requestedMode = request\.mode === "queue" \|\| request\.mode === "steer" \? request\.mode : undefined/);
    assert.match(indexSource, /startTalkMessage\(w!, message, ctx, requestedMode, \{ attach: false, notify: false \}\)/);
    assert.match(indexSource, /options:\s*\{ attach\?: boolean; notify\?: boolean \}/);
    assert.match(indexSource, /const notifyConsole = options\.notify !== false/);
    assert.match(indexSource, /if \(notifyConsole\) ctx\?\.ui\?\.notify/);
  } finally {
    rmSync(workersDir, { recursive: true, force: true });
  }
});

test("web talk requests preserve delivery mode and support pending edit/cancel", () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-web-talk-mode-test-"));
  try {
    const request = createWebTalkRequest(workersDir, {
      worker: "DesignerA",
      message: "先看看",
      from: "web",
      mode: "steer",
    });
    assert.equal(request.mode, "steer");

    const edited = editWebTalkRequest(workersDir, {
      requestId: request.id,
      message: "改成排队执行",
      mode: "queue",
      from: "web",
    });
    assert.equal(edited.status, "pending");
    assert.equal(edited.message, "改成排队执行");
    assert.equal(edited.mode, "queue");
    assert.equal(listPendingWebTalkRequests(workersDir)[0].message, "改成排队执行");

    const cancelled = cancelWebTalkRequest(workersDir, {
      requestId: request.id,
      reason: "用户撤回",
      from: "web",
    });
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.cancelReason, "用户撤回");
    assert.equal(listPendingWebTalkRequests(workersDir).length, 0);
  } finally {
    rmSync(workersDir, { recursive: true, force: true });
  }
});

test("web job control requests are event-sourced for accepted job cancel/edit", () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-web-job-control-test-"));
  try {
    const cancel = createWebTalkJobControlRequest(workersDir, {
      action: "cancel",
      jobId: "job-1",
      worker: "DesignerA",
      reason: "用户取消",
      from: "web",
    });
    assert.equal(cancel.status, "pending");
    assert.equal(cancel.action, "cancel");
    assert.equal(listPendingWebTalkJobControlRequests(workersDir).length, 1);

    const accepted = acceptWebTalkJobControlRequest(workersDir, {
      requestId: cancel.id,
      status: "aborting",
      message: "已请求中止运行中的 job",
    });
    assert.equal(accepted.status, "accepted");
    assert.equal(accepted.resultStatus, "aborting");
    assert.equal(getWebTalkJobControlRequest(workersDir, cancel.id).status, "accepted");

    const edit = createWebTalkJobControlRequest(workersDir, {
      action: "edit",
      jobId: "job-2",
      worker: "DesignerA",
      message: "改后的队列任务",
      from: "web",
    });
    const failed = failWebTalkJobControlRequest(workersDir, {
      requestId: edit.id,
      error: "job 已运行，不能编辑",
    });
    assert.equal(failed.status, "failed");
    assert.equal(listWebTalkJobControlRequests(workersDir).length, 2);
  } finally {
    rmSync(workersDir, { recursive: true, force: true });
  }
});

test("web job unread summary marks workers unread until job detail is read", () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-web-unread-test-"));
  try {
    const job = createJob(workersDir, {
      kind: "talk",
      worker: "DesignerA",
      project: "talk",
      task: "做页面",
    });
    appendJobEvent(job, { type: "text", text: "第一段进度" });
    updateJob(job, { status: "running" });

    const before = buildWorkerJobUnreadSummary(workersDir, [readJob(job.jobFile)]);
    assert.equal(before.byWorker.get("DesignerA").unreadJobs, 1);
    assert.equal(before.byWorker.get("DesignerA").unreadEvents, 1);

    const read = markWebJobRead(workersDir, readJob(job.jobFile), { readBy: "web" });
    assert.equal(read.jobId, job.id);
    const afterRead = buildWorkerJobUnreadSummary(workersDir, [readJob(job.jobFile)]);
    assert.equal(afterRead.byWorker.get("DesignerA").unreadJobs, 0);

    appendJobEvent(job, { type: "text", text: "第二段进度" });
    updateJob(job, { status: "running" });
    const afterUpdate = buildWorkerJobUnreadSummary(workersDir, [readJob(job.jobFile)]);
    assert.equal(afterUpdate.byWorker.get("DesignerA").unreadJobs, 1);
    assert.equal(afterUpdate.byWorker.get("DesignerA").unreadEvents, 1);
  } finally {
    rmSync(workersDir, { recursive: true, force: true });
  }
});

test("worker jobs can be bulk-marked read when opening worker detail", () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-web-worker-job-read-test-"));
  try {
    const job = createJob(workersDir, {
      kind: "talk",
      worker: "DesignerA",
      project: "talk",
      task: "做页面",
    });
    appendJobEvent(job, { type: "text", text: "第一段进度" });
    updateJob(job, { status: "running" });

    const before = buildWorkerJobUnreadSummary(workersDir, [readJob(job.jobFile)]);
    assert.equal(before.byWorker.get("DesignerA").unreadJobs, 1);

    const read = markWorkerJobsRead(workersDir, [readJob(job.jobFile)], { readBy: "web" });
    assert.equal(read.count, 1);
    assert.equal(read.unreadEvents, 1);

    const after = buildWorkerJobUnreadSummary(workersDir, [readJob(job.jobFile)]);
    assert.equal(after.byWorker.get("DesignerA").unreadJobs, 0);

    const again = markWorkerJobsRead(workersDir, [readJob(job.jobFile)], { readBy: "web" });
    assert.equal(again.count, 0);
  } finally {
    rmSync(workersDir, { recursive: true, force: true });
  }
});

test("web inbox messages can be marked read from the UI", () => {
  const webServerSource = readFileSync(join(testDir, "../web-server.mjs"), "utf8");
  const appSource = readFileSync(join(testDir, "../web/app.js"), "utf8");

  assert.match(webServerSource, /POST \/api\/messages\/\*\/read/);
  assert.match(webServerSource, /handleMessageMutation/);
  assert.match(webServerSource, /markMessageRead/);
  assert.match(webServerSource, /handleWorkerMessagesRead/);
  assert.match(webServerSource, /markWorkerMessagesRead/);
  assert.match(webServerSource, /handleWorkerRead/);
  assert.match(webServerSource, /markWorkerJobsRead/);
  assert.match(webServerSource, /unreadMessages/);
  assert.match(webServerSource, /unreadJobUpdates/);
  assert.match(webServerSource, /lastInteractionAt/);
  assert.match(webServerSource, /listWebTalkRequests/);

  assert.match(appSource, /markMessageReadFromUi/);
  assert.match(appSource, /markWorkerReadFromUi/);
  assert.match(appSource, /api\/workers\/\$\{encodeURIComponent\(worker\)\}\/read/);
  assert.match(appSource, /api\/messages\/\$\{encodeURIComponent\(message\.id\)\}\/read/);
  assert.match(appSource, /msg-list__item--unread/);
  assert.match(appSource, /refreshWorkerUnreadBadges/);
  assert.match(appSource, /clearWorkerCardUnreadLocally/);
  assert.match(appSource, /worker-card__talk-preview/);
  assert.match(appSource, /syncWorkerCardTalkPreview/);
  assert.doesNotMatch(appSource, /cssEscape/);
  assert.match(appSource, /lastInteractionAt/);
  assert.match(appSource, /最近交互靠前/);
});

test("worker list search is debounced name-only filtering without empty-state block", () => {
  const appSource = readFileSync(join(testDir, "../web/app.js"), "utf8");
  const styleSource = readFileSync(join(testDir, "../web/styles.css"), "utf8");

  assert.match(appSource, /function scheduleWorkerCardsFilter/);
  assert.match(appSource, /setTimeout\(\(\) => \{/);
  assert.match(appSource, /name\.includes\(q\)/);
  assert.doesNotMatch(appSource, /role\.includes\(q\)/);
  assert.doesNotMatch(appSource, /workerSearchEmpty/);
  assert.doesNotMatch(appSource, /没有匹配的员工/);
  assert.doesNotMatch(styleSource, /\.workers__search-empty/);
  assert.match(styleSource, /\.worker-card\[hidden\]\s*\{[^}]*display:\s*none\s*!important/s);
});

test("web navigation omits internal rollout priority labels", () => {
  const indexSource = readFileSync(join(testDir, "../web/index.html"), "utf8");
  const appSource = readFileSync(join(testDir, "../web/app.js"), "utf8");
  const styleSource = readFileSync(join(testDir, "../web/styles.css"), "utf8");

  assert.doesNotMatch(indexSource, /sidenav__pill/);
  assert.doesNotMatch(indexSource, /sidenav__foot/);
  assert.doesNotMatch(indexSource, /Phase 1/);
  assert.doesNotMatch(appSource, /"nav\.(?:phase|readonly)"/);
  assert.doesNotMatch(styleSource, /\.sidenav__(?:pill|foot|hint)/);
});

test("worker list keeps IM metadata and unread controls in stable card regions", () => {
  const appSource = readFileSync(join(testDir, "../web/app.js"), "utf8");
  const styleSource = readFileSync(join(testDir, "../web/styles.css"), "utf8");

  assert.match(appSource, /worker-card__headline/);
  assert.match(appSource, /worker-card__aside/);
  assert.match(appSource, /aside\.appendChild\(badge\)/);
  assert.match(styleSource, /\.worker-card\s*\{[^}]*grid-template-columns:/s);
  assert.match(styleSource, /\.worker-card__talk-preview\s*\{[^}]*-webkit-line-clamp:\s*1/s);
});

test("worker cards are compact one-line talk entries with avatar and status dot only", () => {
  const appSource = readFileSync(join(testDir, "../web/app.js"), "utf8");
  const styleSource = readFileSync(join(testDir, "../web/styles.css"), "utf8");

  assert.match(appSource, /function workerAvatarNode/);
  assert.match(appSource, /worker-card__status-dot/);
  assert.match(appSource, /worker\?\.avatar/);
  assert.doesNotMatch(appSource, /worker-card__role/);
  assert.doesNotMatch(appSource, /worker-card__meta/);
  assert.match(styleSource, /\.worker-card__talk-preview\s*\{[^}]*-webkit-line-clamp:\s*1/s);
});

test("overview worker preview list uses configured worker avatars", () => {
  const appSource = readFileSync(join(testDir, "../web/app.js"), "utf8");
  const previewBlock = appSource.match(/function workerPreview\(workers\) \{[\s\S]*?\n  \}/)?.[0] || "";

  assert.match(previewBlock, /workerAvatarNode\(w\)/);
  assert.doesNotMatch(previewBlock, /avatar__char[^]*\(w\.name \|\| "\?"\)\.slice\(0,\s*1\)/);
});

test("worker detail uses preloaded jobs for initial talk history", () => {
  const appSource = readFileSync(join(testDir, "../web/app.js"), "utf8");

  assert.match(appSource, /buildTalkPanel\(name,\s*d,\s*d\.jobs\s*\|\|\s*\[\]\)/);
  assert.match(appSource, /renderTalkHistory\(worker,\s*initialJobs,\s*d\.talkRequests\s*\|\|\s*\[\]\)/);
});

test("workers view includes latest talk reply preview for worker cards", () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-worker-talk-preview-"));
  try {
    mkdirSync(join(workersDir, "sessions"), { recursive: true });
    writeFileSync(join(workersDir, "sessions", "DesignerA.jsonl"), "", "utf8");
    sendTaskResultMessage(workersDir, {
      from: "DesignerA",
      to: "LocalAdmin",
      content: "这条来自消息盒子，不应该展示在员工卡片。",
      jobId: "mail-1",
      taskRequestId: "task-1",
    });
    const job = createJob(workersDir, {
      kind: "talk",
      worker: "DesignerA",
      project: "talk",
      task: "改员工卡片摘要",
      cwd: "/repo",
    });
    updateJob(job, {
      status: "done",
      summary: "我已经完成员工列表改造，可以显示最近 talk 返回摘要。",
      fullOutput: "我已经完成员工列表改造，可以显示最近 talk 返回摘要。",
    });

    const workers = buildWorkersView(workersDir, [readJob(job.jobFile)], { workers: [] }, []);
    const hachimon = workers.find((worker) => worker.name === "DesignerA");
    assert.ok(hachimon);
    assert.equal(hachimon.lastMessage, undefined);
    assert.equal(hachimon.lastTalkReply.jobId, job.id);
    assert.equal(hachimon.lastTalkReply.contentPreview, "我已经完成员工列表改造，可以显示最近 talk 返回摘要。");
  } finally {
    rmSync(workersDir, { recursive: true, force: true });
  }
});

test("markdownPreviewText strips markdown syntax for worker card snippets", () => {
  assert.equal(markdownPreviewText("## 完成情况\n\n- 已完成"), "完成情况 已完成");
  assert.equal(markdownPreviewText("| 文件 | 状态 |\n| --- | --- |\n| a | done |"), "[表格]");
  assert.equal(markdownPreviewText("![截图](./done.png)\n后续说明"), "[图片]");
  assert.equal(markdownPreviewText("> **结论**：[可以合入](https://example.com)。"), "结论：可以合入。");
  assert.equal(markdownPreviewText("```js\nconsole.log(1)\n```"), "[代码]");
});

test("workers view normalizes markdown in latest talk reply preview", () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-worker-markdown-talk-preview-"));
  try {
    mkdirSync(join(workersDir, "sessions"), { recursive: true });
    writeFileSync(join(workersDir, "sessions", "WorkerB.jsonl"), "", "utf8");
    const job = createJob(workersDir, {
      kind: "talk",
      worker: "WorkerB",
      project: "talk",
      task: "汇报页面修复",
      cwd: "/repo",
    });
    updateJob(job, {
      status: "done",
      fullOutput: "## 完成情况\n\n- 已修复按钮展示\n- 已跑 smoke",
    });

    const workers = buildWorkersView(workersDir, [readJob(job.jobFile)], { workers: [] }, []);
    const baobao = workers.find((worker) => worker.name === "WorkerB");
    assert.ok(baobao);
    assert.equal(baobao.lastTalkReply.contentPreview, "完成情况 已修复按钮展示 已跑 smoke");
  } finally {
    rmSync(workersDir, { recursive: true, force: true });
  }
});

test("worker list cards show talk reply preview instead of jobs and token chips", () => {
  const appSource = readFileSync(join(testDir, "../web/app.js"), "utf8");
  const styleSource = readFileSync(join(testDir, "../web/styles.css"), "utf8");

  assert.match(appSource, /worker-card__talk-preview/);
  assert.match(appSource, /workerCardTalkPreviewText/);
  assert.match(styleSource, /worker-card__talk-preview/);
  assert.doesNotMatch(appSource, /worker-card__message-preview/);
  assert.doesNotMatch(appSource, /workerCardMessagePreviewText/);
  assert.doesNotMatch(appSource, /worker-card__stat--jobs/);
  assert.doesNotMatch(appSource, /worker-card__stat--tokens/);
});

test("web UI exposes browser TTS notification settings", () => {
  const html = readFileSync(join(testDir, "../web/index.html"), "utf8");
  const appSource = readFileSync(join(testDir, "../web/app.js"), "utf8");
  const styleSource = readFileSync(join(testDir, "../web/styles.css"), "utf8");

  assert.match(html, /#\/notifications/);
  assert.match(appSource, /renderNotificationsSettings/);
  assert.match(appSource, /function kvRow/);
  assert.match(appSource, /speechSynthesis/);
  assert.match(appSource, /selectNotificationVoice/);
  assert.match(appSource, /xiaoxiao|tingting|mei/);
  assert.ok(appSource.includes('api("/api/notification-settings"'));
  assert.ok(appSource.includes("api(`/api/notifications?since="));
  assert.match(styleSource, /notification-settings/);
});

test("worker avatar can be configured and is exposed to web views", () => {
  const typesSource = readFileSync(join(testDir, "../types.ts"), "utf8");
  const registrySource = readFileSync(join(testDir, "../registry.ts"), "utf8");
  const snapshotSource = readFileSync(join(testDir, "../worker-registry-snapshot.mjs"), "utf8");
  const indexSource = readFileSync(join(testDir, "../index.ts"), "utf8");
  const webServerSource = readFileSync(join(testDir, "../web-server.mjs"), "utf8");
  const appSource = readFileSync(join(testDir, "../web/app.js"), "utf8");

  assert.match(typesSource, /avatar\?:\s*string\s*\|\s*null/);
  assert.match(registrySource, /"avatar"/);
  assert.match(snapshotSource, /"avatar"/);
  assert.match(indexSource, /avatar:\s*Type\.Optional/);
  assert.match(indexSource, /patch\.avatar/);
  assert.match(webServerSource, /avatar:\s*regInfo\.avatar/);
  assert.match(webServerSource, /\/api\/avatars\//);
  assert.match(webServerSource, /OX_FACTORY_AVATAR_DIR/);
  assert.match(appSource, /api\\\/avatars/);
});

test("web server imports filesystem helpers used by worker views", () => {
  const webServerSource = readFileSync(join(testDir, "../web-server.mjs"), "utf8");

  assert.match(webServerSource, /import \{[^}]*readdirSync[^}]*\} from "node:fs"/s);
  assert.match(webServerSource, /function listSessionWorkers/);
});

test("worker registry snapshot keeps codex workers after fire and re-hire", () => {
  const entries = [
    {
      type: "custom",
      customType: "ox-worker-hire",
      data: {
        workerId: "ReviewerA",
        role: "programmer",
        backend: "codex",
        model: "gpt-5.5",
        thinking: "xhigh",
        codexThreadId: "old-thread",
        sessionFile: "/tmp/workers/sessions/ReviewerA.jsonl",
      },
    },
    { type: "custom", customType: "ox-worker-fire", data: { workerId: "ReviewerA" } },
    {
      type: "custom",
      customType: "ox-worker-hire",
      data: {
        workerId: "ReviewerA",
        role: "programmer",
        backend: "codex",
        model: "gpt-5.5",
        thinking: "xhigh",
        codexThreadId: "new-thread",
        codexSandbox: "danger-full-access",
        sessionFile: "/tmp/workers/sessions/ReviewerA.jsonl",
      },
    },
    {
      type: "custom",
      customType: "ox-worker-config",
      data: {
        workerId: "ReviewerA",
        codexApprovalPolicy: "never",
      },
    },
  ];

  const registry = scanWorkerEntries(entries);
  const bumei = registry.get("ReviewerA");
  assert.equal(bumei?.backend, "codex");
  assert.equal(bumei?.status, "idle");
  assert.equal(bumei?.codexThreadId, "new-thread");
  assert.equal(bumei?.codexSandbox, "danger-full-access");
  assert.equal(bumei?.codexApprovalPolicy, "never");
});

test("main agent talk requests are event-sourced", () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-main-agent-talk-test-"));
  try {
    const request = createMainAgentTalkRequest(workersDir, {
      message: "秘书，帮我看一下状态",
      from: "web",
    });
    assert.equal(request.status, "pending");
    assert.equal(listPendingMainAgentTalkRequests(workersDir).length, 1);

    const claimed = claimMainAgentTalkRequest(workersDir, {
      requestId: request.id,
      claimedBy: "poller-a",
    });
    assert.equal(claimed.status, "processing");
    assert.equal(claimed.claimedBy, "poller-a");
    assert.equal(listPendingMainAgentTalkRequests(workersDir).length, 0);

    const duplicateClaim = claimMainAgentTalkRequest(workersDir, {
      requestId: request.id,
      claimedBy: "poller-b",
    });
    assert.equal(duplicateClaim, null);

    const accepted = acceptMainAgentTalkRequest(workersDir, {
      requestId: request.id,
      deliveryMode: "idle",
      placement: "主 agent 空闲，已投递",
    });
    assert.equal(accepted.status, "accepted");
    assert.equal(accepted.deliveryMode, "idle");
    assert.equal(listPendingMainAgentTalkRequests(workersDir).length, 0);
    assert.equal(getMainAgentTalkRequest(workersDir, request.id).status, "accepted");

    const failedRequest = createMainAgentTalkRequest(workersDir, {
      message: "第二条",
    });
    const failed = failMainAgentTalkRequest(workersDir, {
      requestId: failedRequest.id,
      error: "主 agent 当前不可接入",
    });
    assert.equal(failed.status, "failed");
    assert.equal(failed.error, "主 agent 当前不可接入");
    assert.equal(listMainAgentTalkRequests(workersDir).length, 2);
  } finally {
    rmSync(workersDir, { recursive: true, force: true });
  }
});

test("main agent web bridge is exposed without stealing active talk mode", () => {
  const webServerSource = readFileSync(join(testDir, "../web-server.mjs"), "utf8");
  const indexSource = readFileSync(join(testDir, "../index.ts"), "utf8");

  assert.match(webServerSource, /POST \/api\/main-agent\/talk/);
  assert.match(webServerSource, /handleMainAgentTranscript/);
  assert.match(webServerSource, /createMainAgentTalkRequest/);
  assert.match(indexSource, /listPendingMainAgentTalkRequests/);
  assert.match(indexSource, /claimMainAgentTalkRequest/);
  assert.match(indexSource, /ensureMainAgentTalkPoller/);
  assert.match(indexSource, /mainAgentActive \|\| talkTarget/);
  assert.match(indexSource, /pi\.sendUserMessage\(message\)/);
});

test("web talk drain can recover codex workers from full main-session registry", () => {
  const indexSource = readFileSync(join(testDir, "../index.ts"), "utf8");

  assert.match(indexSource, /recoverWorkerFromRegistrySnapshot/);
  assert.match(indexSource, /getWorkerRegistrySnapshot\(getWorkersDir\(\)\)/);
  assert.match(indexSource, /const w = recoverWorkerFromRegistrySnapshot\(workerId\)/);
  assert.match(indexSource, /缺少 Codex thread 绑定/);
});

test("web job detail exposes full worker reply instead of summary-only truncation", () => {
  const webServerSource = readFileSync(join(testDir, "../web-server.mjs"), "utf8");
  const webAppSource = readFileSync(join(testDir, "../web/app.js"), "utf8");
  const webStyleSource = readFileSync(join(testDir, "../web/styles.css"), "utf8");

  assert.match(webServerSource, /JOB_DETAIL_REPLY_MAX_CHARS\s*=\s*200_000/);
  assert.match(webServerSource, /fullReply:\s*fullReply\.text \|\| null/);
  assert.match(webServerSource, /fullReplyTruncated:\s*fullReply\.truncated/);
  assert.match(webServerSource, /job\.fullOutput \|\| latestReply \|\| job\.summary/);
  assert.match(webServerSource, /compactJobTimelineEvents/);
  assert.match(webServerSource, /jobDetailEventDisplayText/);
  assert.match(webAppSource, /const replyText = d\.fullReply \|\| d\.latestReply \|\| d\.summary \|\| ""/);
  assert.match(webAppSource, /text:\s*"AI 响应"/);
  assert.match(webAppSource, /响应过长，已展示前/);
  assert.match(webAppSource, /function renderJobEventItem/);
  assert.match(webAppSource, /text:\s*`执行过程 \(\$\{d\.events\.length\}\)`/);
  assert.match(webAppSource, /timeline__item--assistant/);
  assert.match(webAppSource, /timeline__tool-card/);
  assert.match(webStyleSource, /\.timeline__content/);
  assert.match(webStyleSource, /\.timeline__text--assistant/);
  assert.match(webStyleSource, /\.timeline__tool-card/);
});

test("web job detail exposes stop action for active jobs", () => {
  const webAppSource = readFileSync(join(testDir, "../web/app.js"), "utf8");
  const webStyleSource = readFileSync(join(testDir, "../web/styles.css"), "utf8");

  assert.match(webAppSource, /function isCancellableJob/);
  assert.match(webAppSource, /function cancelJobFromDrawer/);
  assert.match(webAppSource, /\/api\/jobs\/\$\{encodeURIComponent\(jobId\)\}\/cancel/);
  assert.match(webAppSource, /停止 job/);
  assert.match(webStyleSource, /\.btn--danger/);
  assert.match(webStyleSource, /\.drawer__actions/);
});

test("worker talk list exposes request edit cancel and active job stop controls", () => {
  const webServerSource = readFileSync(join(testDir, "../web-server.mjs"), "utf8");
  const webAppSource = readFileSync(join(testDir, "../web/app.js"), "utf8");
  const webStyleSource = readFileSync(join(testDir, "../web/styles.css"), "utf8");

  assert.match(webServerSource, /talkRequests:\s*talkRequests\.map/);
  assert.match(webServerSource, /listWebTalkRequests\(workersDir,\s*\{\s*worker:\s*name/);

  assert.match(webAppSource, /function renderTalkRequestItem/);
  assert.match(webAppSource, /function editTalkRequestFromList/);
  assert.match(webAppSource, /function cancelTalkRequestFromList/);
  assert.match(webAppSource, /function editQueuedTalkJobFromList/);
  assert.match(webAppSource, /function stopTalkJobFromList/);
  assert.match(webAppSource, /renderTalkHistory\(worker,\s*initialJobs,\s*d\.talkRequests\s*\|\|\s*\[\]\)/);
  assert.match(webAppSource, /api\/talk-requests\?worker=\$\{encodeURIComponent\(worker\)\}/);
  assert.match(webAppSource, /api\/talk-requests\/\$\{encodeURIComponent\(request\.id\)\}/);
  assert.match(webAppSource, /api\/talk-requests\/\$\{encodeURIComponent\(request\.id\)\}\/cancel/);
  assert.match(webAppSource, /api\/jobs\/\$\{encodeURIComponent\(jobId\)\}\/cancel/);
  assert.match(webAppSource, /api\/jobs\/\$\{encodeURIComponent\(job\.id\)\}/);
  assert.match(webAppSource, /method:\s*"PATCH"/);
  assert.match(webAppSource, /text:\s*queued\s*\?\s*"取消"\s*:\s*"停止"/);
  assert.match(webAppSource, /text:\s*"编辑"/);
  assert.match(webAppSource, /text:\s*"取消"/);

  assert.match(webStyleSource, /\.talk-list__actions/);
  assert.match(webStyleSource, /\.talk-list__item--request/);
});

test("worker talk list sorts jobs by submitted time instead of heartbeat updates", () => {
  const webAppSource = readFileSync(join(testDir, "../web/app.js"), "utf8");

  assert.match(webAppSource, /function talkJobSortTime\(job\) \{/);
  assert.match(webAppSource, /return job\?\.createdAt \|\| job\?\.updatedAt \|\| "";/);
  assert.match(webAppSource, /\.\.\.talkJobs\.map\(\(job\) => \(\{ type: "job", at: talkJobSortTime\(job\), job \}\)\)/);
  assert.match(webAppSource, /text: fmtRelative\(talkJobSortTime\(j\)\)/);
});

test("talk live output does not persist custom messages by default", () => {
  const indexSource = readFileSync(join(testDir, "../index.ts"), "utf8");
  assert.match(indexSource, /function shouldPersistTalkLiveMessages/);
  assert.match(indexSource, /OX_FACTORY_TALK_LIVE_MESSAGES/);
  assert.match(indexSource, /if \(!shouldPersistTalkLiveMessages\(\)\) return;/);
  assert.match(indexSource, /tailJobEvents\(job,\s*20\)/);
  assert.match(indexSource, /tailJobEvents\(finished,\s*20\)/);
  assert.doesNotMatch(indexSource, /当前 talk 面板会跟随输出/);
});

test("web dashboard exposes a real i18n language switch", () => {
  const html = readFileSync(join(testDir, "../web/index.html"), "utf8");
  const appSource = readFileSync(join(testDir, "../web/app.js"), "utf8");
  const styleSource = readFileSync(join(testDir, "../web/styles.css"), "utf8");

  assert.match(html, /id="langSwitch"/);
  assert.match(html, /id="langSwitchText"/);
  assert.match(html, /data-i18n="brand\.title"/);
  assert.match(appSource, /LANG_STORAGE_KEY/);
  assert.match(appSource, /function applyStaticI18n/);
  assert.match(appSource, /function setLanguage/);
  assert.match(appSource, /#langSwitch/);
  assert.match(styleSource, /\.lang-switch/);
});

test("web topbar i18n helper is not shadowed by totals locals", () => {
  const appSource = readFileSync(join(testDir, "../web/app.js"), "utf8");
  const setTopbarBlock = appSource.match(/function setTopbar\(overview\) \{[\s\S]*?\n  \}/)?.[0] || "";

  assert.match(setTopbarBlock, /const totals = overview\?\.totals \|\| \{\}/);
  assert.doesNotMatch(setTopbarBlock, /const t = overview\?\.totals/);
  assert.match(setTopbarBlock, /\$\("#lastUpdated"\)\.textContent = `\$\{t\("topbar\.updatedAt"\)\}/);
});

test("tokens page route-refreshes when date or trend filters change", () => {
  const webAppSource = readFileSync(join(testDir, "../web/app.js"), "utf8");

  assert.match(webAppSource, /function applyTokenFilters/);
  assert.match(webAppSource, /oninput:\s*\(e\)\s*=>\s*applyTokenFilters\(\{\s*date:/);
  assert.match(webAppSource, /onchange:\s*\(e\)\s*=>\s*applyTokenFilters\(\{\s*date:/);
  assert.match(webAppSource, /onchange:\s*\(e\)\s*=>\s*applyTokenFilters\(\{\s*trend:/);
  assert.match(webAppSource, /history\.replaceState\(null,\s*""\s*,\s*newHash\)/);
  assert.match(webAppSource, /void route\(\)/);
  assert.doesNotMatch(webAppSource, /STATE\.tokensDate\s*=\s*e\.target\.value;\s*renderTokens\(\);/);
  assert.doesNotMatch(webAppSource, /STATE\.tokensTrendDays\s*=\s*Number\(e\.target\.value\);\s*renderTokens\(\);/);
});

test("quality emotion chart filters out zero scores", () => {
  const webAppSource = readFileSync(join(testDir, "../web/app.js"), "utf8");
  const chartLineBlock = webAppSource.match(/function chartLine\([\s\S]*?\n  function showChartTip/)?.[0] || "";

  assert.match(webAppSource, /function isValidEmotionScore/);
  assert.match(webAppSource, /const emotionTurns = turns\.filter\(\(t\) => isValidEmotionScore\(t\.emotionScore\)\)/);
  assert.match(webAppSource, /chartLine\("情绪评分（情绪旁路开启时）",\s*emotionTurns,/);
  assert.doesNotMatch(chartLineBlock, /s\.key === "emotionScore"/);
});

test("quality metric tables expose sortable numeric columns", () => {
  const webAppSource = readFileSync(join(testDir, "../web/app.js"), "utf8");
  const styleSource = readFileSync(join(testDir, "../web/styles.css"), "utf8");

  assert.match(webAppSource, /function sortableNumericTh/);
  assert.match(webAppSource, /function sortTableByHeader/);
  assert.match(webAppSource, /data:\s*\{\s*sortValue:/);
  assert.match(webAppSource, /sortableNumericTh\("会话轮次"\)/);
  assert.match(webAppSource, /sortableNumericTh\("当前上下文"\)/);
  assert.match(webAppSource, /sortableNumericTh\("历史文件"\)/);
  assert.match(webAppSource, /sessionFileTokens/);
  assert.match(webAppSource, /sortableNumericTh\("压缩"\)/);
  assert.match(webAppSource, /sortableNumericTh\("平均耗时"\)/);
  assert.match(webAppSource, /sortableNumericTh\("情绪"\)/);
  assert.match(webAppSource, /sortableNumericTh\("输入"\)/);
  assert.match(webAppSource, /sortableNumericTh\("输出"\)/);
  assert.match(webAppSource, /sortableNumericTh\("上下文"\)/);
  assert.match(styleSource, /\.table__sort-btn/);
  assert.match(styleSource, /\.table__sort-indicator/);
});



test("kimi backend builds resume prompt args without unsupported auto flags", () => {
  const args = buildKimiCliArgs({
    worker: {
      id: "小月",
      role: "programmer",
      backend: "kimi",
      model: "moonshot-v1",
      kimiSessionId: "session_demo",
      kimiSessionInitialized: true,
    },
    taskContent: "完成一个页面",
  });

  assert.deepEqual(args, ["-r", "session_demo", "--output-format", "stream-json", "--model", "moonshot-v1", "-p", "完成一个页面"]);
  assert.equal(args.includes("--auto"), false);
  assert.equal(args.includes("--yolo"), false);
});

test("kimi backend converts stream-json assistant/tool/meta lines into factory stream events", () => {
  const state = { output: "", sessionId: "", observedSessionId: false, turns: 0 };

  assert.deepEqual(
    kimiStreamLineToEvents('{"role":"assistant","tool_calls":[{"type":"function","id":"tool_1","function":{"name":"Write","arguments":"{\\"path\\":\\"hello.txt\\",\\"content\\":\\"ok\\"}"}}]}', state),
    [{ type: "tool_start", name: "Write", args: { path: "hello.txt", content: "ok" } }],
  );

  assert.deepEqual(
    kimiStreamLineToEvents('{"role":"tool","tool_call_id":"tool_1","content":"Wrote 2 bytes to hello.txt"}', state),
    [{ type: "tool_end", name: "tool_1", result: "Wrote 2 bytes to hello.txt", isError: false }],
  );

  assert.deepEqual(
    kimiStreamLineToEvents('{"role":"assistant","content":"done"}', state),
    [{ type: "text", text: "done" }],
  );
  assert.equal(state.output, "done");
  assert.equal(state.turns, 1);

  assert.deepEqual(
    kimiStreamLineToEvents('{"role":"meta","type":"session.resume_hint","session_id":"session_abc","command":"kimi -r session_abc"}', state),
    [{ type: "kimi_session", sessionId: "session_abc", text: "Kimi session: session_abc" }],
  );
  assert.equal(state.sessionId, "session_abc");
  assert.equal(state.observedSessionId, true);
});

test("kimi backend tolerates raw non-json stdout lines", () => {
  const state = { output: "", sessionId: "", observedSessionId: false, turns: 0 };
  assert.deepEqual(
    kimiStreamLineToEvents('/private/tmp/kimi-tool-smoke', state),
    [{ type: "tool_output", name: "kimi", text: "/private/tmp/kimi-tool-smoke\n" }],
  );
});

test("factory source exposes Kimi as a first-class worker backend", () => {
  const indexSource = readFileSync(join(testDir, "../index.ts"), "utf8");
  const spawnerSource = readFileSync(join(testDir, "../spawner.ts"), "utf8");
  const registrySource = readFileSync(join(testDir, "../registry.ts"), "utf8");
  const typesSource = readFileSync(join(testDir, "../types.ts"), "utf8");
  const handbookSource = readFileSync(join(testDir, "../worker-prompts.mjs"), "utf8");

  assert.match(typesSource, /WorkerBackend = "pi" \| "codex" \| "claude" \| "kimi"/);
  assert.match(indexSource, /StringEnum\(\["pi", "codex", "claude", "kimi"\]/);
  assert.match(indexSource, /kimiCommand/);
  assert.match(spawnerSource, /runKimiWorkerStreaming/);
  assert.match(spawnerSource, /backend \?\? "pi"\) === "kimi"/);
  assert.match(registrySource, /kimiSessionId/);
  assert.match(handbookSource, /Kimi Code/);
});

test("one-click installer installs the Pi extension and configures DeepSeek defaults", () => {
  const installerPath = join(testDir, "../scripts/install.sh");
  assert.equal(existsSync(installerPath), true);
  const installerSource = readFileSync(installerPath, "utf8");

  assert.match(installerSource, /command -v pi/);
  assert.match(installerSource, /pi install "\$REPO_URL" --local --approve/);
  assert.match(installerSource, /pi install "\$REPO_URL" --approve/);
  assert.match(installerSource, /DEEPSEEK_API_KEY/);
  assert.match(installerSource, /auth\.json/);
  assert.match(installerSource, /defaultProvider.*deepseek/s);
  assert.match(installerSource, /deepseek-v4-pro/);
  assert.doesNotMatch(installerSource, /plat_[A-Za-z0-9]/);
  assert.doesNotMatch(installerSource, /sk-[A-Za-z0-9]/);
});

test("worker config exposes codex sandbox updates without full-config churn", () => {
  const indexSource = readFileSync(join(testDir, "../index.ts"), "utf8");
  const registrySource = readFileSync(join(testDir, "../registry.ts"), "utf8");
  const codexSource = readFileSync(join(testDir, "../codex-backend.mjs"), "utf8");

  assert.match(indexSource, /name:\s*"factory_worker_config"/);
  assert.match(indexSource, /workerId:\s*Type\.Optional/);
  assert.match(indexSource, /params\.name\s*\|\|\s*params\.workerId/);
  assert.match(indexSource, /codexSandbox:\s*Type\.Optional/);
  assert.match(indexSource, /danger-full-access/);
  assert.match(indexSource, /resetCodexThread:\s*Type\.Optional/);
  assert.match(indexSource, /codexThreadId\s*=\s*null/);
  assert.match(indexSource, /buildCodexThreadHandoff/);
  assert.match(registrySource, /const allowedKeys/);
  assert.match(registrySource, /codexThreadHandoff/);
  assert.match(codexSource, /旧 Codex thread handoff/);
  const updateWorkerConfigSource = registrySource.slice(
    registrySource.indexOf("export function updateWorkerConfig"),
    registrySource.indexOf("function responsibilityKey"),
  );
  assert.doesNotMatch(updateWorkerConfigSource, /backend:\s*w\.backend[\s\S]*codexSandbox:\s*w\.codexSandbox/);
});

test("codex hires default to full access unless sandbox is explicitly provided", () => {
  const indexSource = readFileSync(join(testDir, "../index.ts"), "utf8");
  const hireToolSource = indexSource.slice(
    indexSource.indexOf('name: "factory_hire"'),
    indexSource.indexOf('name: "factory_fire"'),
  );

  assert.match(hireToolSource, /description:\s*"Codex sandbox，默认 danger-full-access。"/);
  assert.match(hireToolSource, /default:\s*"danger-full-access"/);
  assert.match(hireToolSource, /codexSandbox:\s*params\.codexSandbox\s*\?\?\s*"danger-full-access"/);
});

test("codex base instructions include reset handoff once a thread is reset", () => {
  const instructions = buildCodexBaseInstructions({
    id: "ReviewerA",
    role: "programmer",
    codexThreadHandoff: "旧 thread: abc\n最近 job: touch 失败，需要 full access",
  }, "", { workersDir: "/tmp/ox-workers" });

  assert.match(instructions, /旧 Codex thread handoff/);
  assert.match(instructions, /旧 thread: abc/);
  assert.match(instructions, /touch 失败/);
  assert.match(instructions, /牛马工厂工作手册/);
  assert.match(instructions, /comm-cli\.mjs send/);
  assert.match(instructions, /comm-cli\.mjs assign/);
});

test("factory worker handbook documents authorized comm cli for every backend", () => {
  const handbook = buildFactoryWorkerHandbook({
    id: "WorkerG",
    role: "programmer",
  }, { workersDir: "/tmp/ox-workers", backend: "codex" });

  assert.match(handbook, /牛马工厂工作手册/);
  assert.match(handbook, /授权式通信/);
  assert.match(handbook, /comm-cli\.mjs check --workers-dir \/tmp\/ox-workers --subject "WorkerG" --action message:send --target 对方员工/);
  assert.match(handbook, /comm-cli\.mjs send --workers-dir \/tmp\/ox-workers --from "WorkerG" --to 对方员工 --content "消息内容"/);
  assert.match(handbook, /comm-cli\.mjs assign --workers-dir \/tmp\/ox-workers --from "WorkerG" --to 对方员工 --task "任务内容"/);
  assert.match(handbook, /--action work:assign/);
  assert.match(handbook, /comm-cli\.mjs inbox --workers-dir \/tmp\/ox-workers --worker "WorkerG"/);
  assert.match(handbook, /留言不是派活/);
});

test("worker system prompt carries stable identity, handbook, and role definition", () => {
  const systemPrompt = buildWorkerSystemPrompt({
    id: "WorkerB",
    role: "programmer",
    backend: "pi",
  }, {
    workersDir: "/tmp/ox-workers",
    backend: "pi",
    agentDef: "你是测试角色定义。",
  });

  assert.match(systemPrompt, /你的名字叫 \*\*WorkerB\*\*，职位是 programmer。/);
  assert.match(systemPrompt, /牛马工厂工作手册/);
  assert.match(systemPrompt, /当前后端：pi/);
  assert.match(systemPrompt, /comm-cli\.mjs send --workers-dir \/tmp\/ox-workers --from "WorkerB" --to 对方员工/);
  assert.match(systemPrompt, /你是测试角色定义。/);
});

test("worker task prompt contains only per-turn project, task, and context", () => {
  const content = buildWorkerTaskPrompt({
    project: "talk",
    task: "修一下按钮",
    additionalContext: "用户看到空白按钮",
  });

  assert.match(content, /## 项目: talk/);
  assert.match(content, /## 任务\n修一下按钮/);
  assert.match(content, /## 附加上下文\n用户看到空白按钮/);
  assert.doesNotMatch(content, /你的名字叫/);
  assert.doesNotMatch(content, /职位是 programmer/);
  assert.doesNotMatch(content, /牛马工厂工作手册/);
  assert.doesNotMatch(content, /comm-cli\.mjs/);
  assert.doesNotMatch(content, /不要直接改 messages\/permissions 文件/);
});

test("codex task content keeps stable worker context out of user prompt", () => {
  const content = buildCodexTaskContent({
    worker: { id: "WorkerG", role: "programmer" },
    task: "给DeveloperB发一条消息问进展",
    project: "talk",
    workersDir: "/tmp/ox-workers",
  });

  assert.match(content, /## 项目: talk/);
  assert.match(content, /## 任务\n给DeveloperB发一条消息问进展/);
  assert.doesNotMatch(content, /你的名字叫/);
  assert.doesNotMatch(content, /牛马工厂工作手册/);
  assert.doesNotMatch(content, /comm-cli\.mjs send --workers-dir \/tmp\/ox-workers --from "WorkerG" --to 对方员工/);
  assert.doesNotMatch(content, /不要直接改 messages\/permissions 文件/);
});

test("codex token usage extractor supports common app-server usage shapes", () => {
  assert.deepEqual(
    extractCodexTokenUsage({ usage: { inputTokens: 12, outputTokens: 3 } }),
    { inputTokens: 12, cachedInputTokens: 0, outputTokens: 3, reasoningOutputTokens: 0, totalTokens: 15 },
  );
  assert.deepEqual(
    extractCodexTokenUsage({ tokenUsage: { input_tokens: 20, cached_input_tokens: 11, output_tokens: 5, reasoning_output_tokens: 2, total_tokens: 25 } }),
    { inputTokens: 20, cachedInputTokens: 11, outputTokens: 5, reasoningOutputTokens: 2, totalTokens: 25 },
  );
  assert.deepEqual(
    extractCodexTokenUsage({ usage: { prompt_tokens: 7, completion_tokens: 8 } }),
    { inputTokens: 7, cachedInputTokens: 0, outputTokens: 8, reasoningOutputTokens: 0, totalTokens: 15 },
  );
  assert.deepEqual(
    extractCodexTokenUsage({
      tokenUsage: {
        total: { inputTokens: 999, cachedInputTokens: 900, outputTokens: 111, reasoningOutputTokens: 30, totalTokens: 1110 },
        last: { inputTokens: 31, cachedInputTokens: 20, outputTokens: 9, reasoningOutputTokens: 2, totalTokens: 40 },
      },
    }),
    { inputTokens: 31, cachedInputTokens: 20, outputTokens: 9, reasoningOutputTokens: 2, totalTokens: 40 },
  );
  assert.deepEqual(extractCodexTokenUsage({}), { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 });
});

test("codex token usage tracker computes cumulative total deltas instead of last call usage", () => {
  const tracker = createCodexTokenUsageTracker();
  const first = tracker.remember({
    turnId: "turn-1",
    tokenUsage: {
      total: { inputTokens: 1000, cachedInputTokens: 800, outputTokens: 100, reasoningOutputTokens: 30, totalTokens: 1100 },
      last: { inputTokens: 100, cachedInputTokens: 80, outputTokens: 10, reasoningOutputTokens: 3, totalTokens: 110 },
    },
  });
  assert.deepEqual(first, { inputTokens: 100, cachedInputTokens: 80, outputTokens: 10, reasoningOutputTokens: 3, totalTokens: 110 });

  const second = tracker.remember({
    turnId: "turn-1",
    tokenUsage: {
      total: { inputTokens: 1250, cachedInputTokens: 990, outputTokens: 160, reasoningOutputTokens: 45, totalTokens: 1410 },
      last: { inputTokens: 250, cachedInputTokens: 190, outputTokens: 60, reasoningOutputTokens: 15, totalTokens: 310 },
    },
  });
  assert.deepEqual(second, { inputTokens: 350, cachedInputTokens: 270, outputTokens: 70, reasoningOutputTokens: 18, totalTokens: 420 });
  assert.deepEqual(tracker.get("turn-1"), second);

  assert.deepEqual(
    extractCodexThreadTokenUsage({
      info: {
        total_token_usage: { input_tokens: 10, cached_input_tokens: 8, output_tokens: 2, total_tokens: 12 },
        last_token_usage: { input_tokens: 3, cached_input_tokens: 2, output_tokens: 1, total_tokens: 4 },
      },
    }),
    {
      total: { inputTokens: 10, cachedInputTokens: 8, outputTokens: 2, reasoningOutputTokens: 0, totalTokens: 12 },
      last: { inputTokens: 3, cachedInputTokens: 2, outputTokens: 1, reasoningOutputTokens: 0, totalTokens: 4 },
    },
  );
  assert.deepEqual(
    subtractCodexTokenUsage(
      { inputTokens: 10, cachedInputTokens: 8, outputTokens: 2, reasoningOutputTokens: 1, totalTokens: 12 },
      { inputTokens: 3, cachedInputTokens: 2, outputTokens: 1, reasoningOutputTokens: 0, totalTokens: 4 },
    ),
    { inputTokens: 7, cachedInputTokens: 6, outputTokens: 1, reasoningOutputTokens: 1, totalTokens: 8 },
  );
});

test("factory compaction prompt keeps worker state and truncates large tool output", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "实现牛马工厂 token 统计" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "我会先读 token-report。" },
        { type: "toolCall", name: "bash", arguments: { command: "node --test", cwd: "/repo" } },
      ],
    },
    { role: "toolResult", content: [{ type: "text", text: "PASS\n".repeat(1200) }] },
  ];

  const serialized = serializeFactoryCompactionMessages(messages, { maxToolResultChars: 80 });
  assert.match(serialized, /\[User\]: 实现牛马工厂 token 统计/);
  assert.match(serialized, /\[Assistant tool calls\]: bash\(command="node --test", cwd="\/repo"\)/);
  assert.match(serialized, /\[Tool result\]: PASS/);
  assert.match(serialized, /\[\.\.\. \d+ more characters truncated\]/);

  const request = buildFactoryCompactionRequest({
    worker: { id: "LocalAdmin", role: "programmer" },
    reason: "manual",
    preparation: {
      messagesToSummarize: messages,
      turnPrefixMessages: [],
      previousSummary: "之前已经完成日报数据源修复。",
      firstKeptEntryId: "keep-1",
      tokensBefore: 123456,
      isSplitTurn: false,
      fileOps: { read: new Set(["a.ts"]), edited: new Set(["b.ts"]), written: new Set() },
    },
    maxConversationChars: 500,
  });

  assert.equal(request.firstKeptEntryId, "keep-1");
  assert.equal(request.tokensBefore, 123456);
  assert.match(request.prompt, /你是牛马工厂的上下文压缩员/);
  assert.match(request.prompt, /员工：LocalAdmin/);
  assert.match(request.prompt, /之前已经完成日报数据源修复/);
  assert.match(request.prompt, /## Worker State/);
  assert.match(request.prompt, /## Next Turn Instructions/);
});

test("prepareSessionCompactionFixture builds a safe compaction sample from a copied worker session", () => {
  const dir = mkdtempSync(join(tmpdir(), "ox-compaction-fixture-"));
  try {
    const sessionFile = join(dir, "员工副本.jsonl");
    const entries = [
      { type: "session", version: 3, id: "s", timestamp: "2026-07-01T00:00:00.000Z", cwd: "/repo" },
      { type: "message", id: "u1", parentId: null, timestamp: "2026-07-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "任务一" }] } },
      { type: "message", id: "a1", parentId: "u1", timestamp: "2026-07-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "完成任务一" }] } },
      { type: "compaction", id: "c1", parentId: "a1", timestamp: "2026-07-01T00:00:03.000Z", summary: "旧摘要", firstKeptEntryId: "u1", tokensBefore: 100 },
      { type: "message", id: "u2", parentId: "c1", timestamp: "2026-07-01T00:00:04.000Z", message: { role: "user", content: [{ type: "text", text: "任务二" }] } },
      { type: "message", id: "a2", parentId: "u2", timestamp: "2026-07-01T00:00:05.000Z", message: { role: "assistant", content: [{ type: "text", text: "正在任务二" }] } },
    ];
    writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");

    const sample = prepareSessionCompactionFixture(sessionFile, {
      keepRecentMessages: 1,
      maxMessagesToSummarize: 10,
    });

    assert.equal(sample.workerId, "员工副本");
    assert.equal(sample.preparation.firstKeptEntryId, "a2");
    assert.equal(sample.preparation.previousSummary, "旧摘要");
    assert.equal(sample.preparation.messagesToSummarize.length, 3);
    assert.ok(sample.preparation.tokensBefore > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shadow compaction runs Codex side channel and records comparison without replacing Pi compaction", async () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-compaction-shadow-test-"));
  try {
    const sessionFile = join(workersDir, "sessions", "LocalAdmin.jsonl");
    mkdirSync(dirname(sessionFile), { recursive: true });
    writeFileSync(sessionFile, "", "utf8");

    let codexCalls = 0;
    const event = {
      reason: "manual",
      customInstructions: "shadow only",
      preparation: {
        firstKeptEntryId: "keep-1",
        tokensBefore: 4096,
        messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "继续做压缩对比" }] }],
        turnPrefixMessages: [],
        isSplitTurn: false,
        fileOps: { read: new Set([".pi/extensions/ox-factory/compaction.mjs"]), edited: new Set(), written: new Set() },
      },
    };
    const ctx = {
      cwd: "/repo",
      sessionManager: { getSessionFile: () => sessionFile },
      ui: { notify() {} },
    };

    const beforeResult = await handleFactoryCompactionEvent(event, ctx, {
      mode: "shadow",
      scope: "all",
      workersDir,
      workers: ["LocalAdmin"],
      runCodexCompactionFn: async () => {
        codexCalls += 1;
        return {
          summary: "## Worker State\nLocalAdmin\n\n## Next Turn Instructions\n1. 继续 shadow 对比\n\n## Factory Context\n保留工厂语义。",
          firstKeptEntryId: "keep-1",
          tokensBefore: 4096,
          estimatedTokensAfter: 42,
          details: {
            model: "gpt-5.5",
            usage: { inputTokens: 100, cachedInputTokens: 20, outputTokens: 30, reasoningOutputTokens: 0, totalTokens: 130 },
          },
        };
      },
    });

    assert.equal(beforeResult, undefined);
    assert.equal(codexCalls, 1);

    const record = await handleFactoryCompactionCompleted({
      reason: "manual",
      compactionEntry: {
        summary: "## Goal\n默认 Pi 摘要\n\n## Next Steps\n1. 继续",
        firstKeptEntryId: "keep-1",
        tokensBefore: 4096,
      },
      fromExtension: false,
    }, ctx, {
      workersDir,
      awaitShadowWrite: true,
    });

    assert.equal(record.decision, "pi_used_codex_shadow_only");
    assert.equal(record.worker, "LocalAdmin");
    assert.equal(record.pi.summaryChars, "## Goal\n默认 Pi 摘要\n\n## Next Steps\n1. 继续".length);
    assert.equal(record.codex.status, "done");
    assert.equal(record.codex.hasFactoryContext, true);
    assert.equal(record.codex.hasNextTurnInstructions, true);
    assert.ok(record.pi.summaryFile.endsWith(".pi.md"));
    assert.ok(record.codex.summaryFile.endsWith(".codex.md"));

    const records = readFactoryCompactionShadowRecords(workersDir);
    assert.equal(records.length, 1);
    assert.equal(records[0].id, record.id);

    const report = buildFactoryCompactionReport({ workersDir, limit: 5 });
    assert.equal(report.records.length, 1);
    const markdown = formatFactoryCompactionReport(report);
    assert.match(markdown, /压缩对比报告/);
    assert.match(markdown, /LocalAdmin/);
    assert.match(markdown, /shadow/);
  } finally {
    rmSync(workersDir, { recursive: true, force: true });
  }
});

test("shadow compaction respects worker graylist and off mode", async () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-compaction-gray-test-"));
  try {
    const sessionFile = join(workersDir, "sessions", "DeveloperA.jsonl");
    mkdirSync(dirname(sessionFile), { recursive: true });
    let calls = 0;
    const event = {
      reason: "manual",
      preparation: {
        firstKeptEntryId: "keep-2",
        tokensBefore: 100,
        messagesToSummarize: [{ role: "user", content: "hello" }],
        turnPrefixMessages: [],
      },
    };
    const ctx = { cwd: "/repo", sessionManager: { getSessionFile: () => sessionFile } };
    const result = await handleFactoryCompactionEvent(event, ctx, {
      mode: "shadow",
      scope: "all",
      workersDir,
      workers: ["LocalAdmin"],
      runCodexCompactionFn: async () => {
        calls += 1;
        return { summary: "unused", firstKeptEntryId: "keep-2", tokensBefore: 100, details: {} };
      },
    });

    assert.equal(result, undefined);
    assert.equal(calls, 0);

    await handleFactoryCompactionEvent(event, ctx, {
      mode: "off",
      scope: "all",
      workersDir,
      workers: ["DeveloperA"],
      runCodexCompactionFn: async () => {
        calls += 1;
        return { summary: "unused", firstKeptEntryId: "keep-2", tokensBefore: 100, details: {} };
      },
    });
    assert.equal(calls, 0);
  } finally {
    rmSync(workersDir, { recursive: true, force: true });
  }
});

test("main agent shadow compaction is evaluation-only and records target separately", async () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-compaction-main-shadow-test-"));
  try {
    const sessionFile = join(tmpdir(), ".pi", "agent", "sessions", "--repo--", "2026-07-02T00-00-00_main.jsonl");
    let codexCalls = 0;
    const event = {
      reason: "threshold",
      customInstructions: "只评估主 agent 压缩质量，不采纳",
      preparation: {
        firstKeptEntryId: "main-keep",
        tokensBefore: 612626,
        messagesToSummarize: [{ role: "user", content: "我们继续完善牛马工厂可视化和主 agent 压缩评估" }],
        turnPrefixMessages: [],
        isSplitTurn: false,
        fileOps: { read: new Set(["docs/ox-factory-improvement-tracker.md"]), edited: new Set(), written: new Set() },
      },
    };
    const ctx = {
      cwd: "/tmp/ox-factory-host",
      sessionManager: { getSessionFile: () => sessionFile },
      ui: { notify() {} },
    };

    const result = await handleFactoryCompactionEvent(event, ctx, {
      mode: "shadow",
      scope: "main",
      workersDir,
      runCodexCompactionFn: async ({ worker }) => {
        codexCalls += 1;
        assert.equal(worker.id, "主agent");
        assert.equal(worker.role, "main-agent");
        return {
          summary: "## Main Agent State\n保留用户偏好和工厂路线图。\n\n## Factory Context\n牛马工厂可视化。\n\n## Next Turn Instructions\n1. 继续只评估不采纳。\n\n## Commands & Verification\n- 待验证",
          firstKeptEntryId: "main-keep",
          tokensBefore: 612626,
          details: { model: "gpt-5.5" },
        };
      },
    });

    assert.equal(result, undefined);
    assert.equal(codexCalls, 1);

    const record = await handleFactoryCompactionCompleted({
      reason: "threshold",
      compactionEntry: {
        summary: "## Goal\nPi 主 agent 默认摘要\n\n## Next Steps\n1. 保持主链路",
        firstKeptEntryId: "main-keep",
        tokensBefore: 612626,
      },
      fromExtension: false,
    }, ctx, {
      workersDir,
      awaitShadowWrite: true,
    });

    assert.equal(record.targetType, "main");
    assert.equal(record.worker, "主agent");
    assert.equal(record.decision, "pi_used_codex_shadow_only");

    const mainReport = buildFactoryCompactionReport({ workersDir, targetType: "main" });
    assert.equal(mainReport.records.length, 1);
    assert.equal(mainReport.records[0].worker, "主agent");
    assert.match(formatFactoryCompactionReport(mainReport), /主agent/);
  } finally {
    rmSync(workersDir, { recursive: true, force: true });
  }
});

test("main agent shadow compaction is enabled by default without env flags", async () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-compaction-main-default-test-"));
  const previousMode = process.env.OX_FACTORY_CODEX_COMPACTION_MODE;
  const previousScope = process.env.OX_FACTORY_CODEX_COMPACTION_SCOPE;
  const previousLegacy = process.env.OX_FACTORY_CODEX_COMPACTION;
  delete process.env.OX_FACTORY_CODEX_COMPACTION_MODE;
  delete process.env.OX_FACTORY_CODEX_COMPACTION_SCOPE;
  delete process.env.OX_FACTORY_CODEX_COMPACTION;
  try {
    const sessionFile = join(tmpdir(), ".pi", "agent", "sessions", "--repo--", "2026-07-02T08-23-00_main.jsonl");
    let calls = 0;
    const event = {
      reason: "threshold",
      preparation: {
        firstKeptEntryId: "main-default-keep",
        tokensBefore: 647126,
        messagesToSummarize: [{ role: "user", content: "主 agent 默认 shadow 压缩评估" }],
        turnPrefixMessages: [],
      },
    };
    const ctx = {
      cwd: "/repo",
      sessionManager: { getSessionFile: () => sessionFile },
      ui: { notify() {} },
    };

    const result = await handleFactoryCompactionEvent(event, ctx, {
      workersDir,
      runCodexCompactionFn: async ({ worker }) => {
        calls += 1;
        assert.equal(worker.id, "主agent");
        assert.equal(worker.targetType, "main");
        return {
          summary: "## Main Agent State\n默认开启 shadow。\n\n## Factory Context\n牛马工厂。\n\n## Next Turn Instructions\n1. 继续。",
          firstKeptEntryId: "main-default-keep",
          tokensBefore: 647126,
          details: { model: "gpt-5.5" },
        };
      },
    });

    assert.equal(result, undefined);
    assert.equal(calls, 1);

    const record = await handleFactoryCompactionCompleted({
      reason: "threshold",
      compactionEntry: {
        summary: "## Goal\nPi 主 agent 摘要",
        firstKeptEntryId: "main-default-keep",
        tokensBefore: 647126,
      },
    }, ctx, {
      workersDir,
      awaitShadowWrite: true,
    });

    assert.equal(record.targetType, "main");
    assert.equal(record.worker, "主agent");
  } finally {
    if (previousMode === undefined) delete process.env.OX_FACTORY_CODEX_COMPACTION_MODE;
    else process.env.OX_FACTORY_CODEX_COMPACTION_MODE = previousMode;
    if (previousScope === undefined) delete process.env.OX_FACTORY_CODEX_COMPACTION_SCOPE;
    else process.env.OX_FACTORY_CODEX_COMPACTION_SCOPE = previousScope;
    if (previousLegacy === undefined) delete process.env.OX_FACTORY_CODEX_COMPACTION;
    else process.env.OX_FACTORY_CODEX_COMPACTION = previousLegacy;
    rmSync(workersDir, { recursive: true, force: true });
  }
});

test("worker shadow compaction is enabled by default without env flags", async () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-compaction-worker-default-test-"));
  const previousMode = process.env.OX_FACTORY_CODEX_COMPACTION_MODE;
  const previousScope = process.env.OX_FACTORY_CODEX_COMPACTION_SCOPE;
  const previousWorkers = process.env.OX_FACTORY_CODEX_COMPACTION_WORKERS;
  const previousLegacy = process.env.OX_FACTORY_CODEX_COMPACTION;
  delete process.env.OX_FACTORY_CODEX_COMPACTION_MODE;
  delete process.env.OX_FACTORY_CODEX_COMPACTION_SCOPE;
  delete process.env.OX_FACTORY_CODEX_COMPACTION_WORKERS;
  delete process.env.OX_FACTORY_CODEX_COMPACTION;
  try {
    const sessionFile = join(workersDir, "sessions", "WorkerB.jsonl");
    mkdirSync(dirname(sessionFile), { recursive: true });
    let calls = 0;
    const event = {
      reason: "threshold",
      preparation: {
        firstKeptEntryId: "worker-default-keep",
        tokensBefore: 111740,
        messagesToSummarize: [{ role: "user", content: "WorkerB默认 worker shadow 压缩评估" }],
        turnPrefixMessages: [],
      },
    };
    const ctx = {
      cwd: "/repo",
      sessionManager: { getSessionFile: () => sessionFile },
      ui: { notify() {} },
    };

    const result = await handleFactoryCompactionEvent(event, ctx, {
      workersDir,
      runCodexCompactionFn: async ({ worker }) => {
        calls += 1;
        assert.equal(worker.id, "WorkerB");
        assert.equal(worker.targetType, "worker");
        return {
          summary: "## Worker State\nWorkerB默认开启 shadow。\n\n## Factory Context\n牛马工厂。\n\n## Next Turn Instructions\n1. 继续。",
          firstKeptEntryId: "worker-default-keep",
          tokensBefore: 111740,
          details: { model: "gpt-5.5" },
        };
      },
    });

    assert.equal(result, undefined);
    assert.equal(calls, 1);

    const record = await handleFactoryCompactionCompleted({
      reason: "threshold",
      compactionEntry: {
        summary: "## Goal\nPi worker 摘要",
        firstKeptEntryId: "worker-default-keep",
        tokensBefore: 111740,
      },
    }, ctx, {
      workersDir,
      awaitShadowWrite: true,
    });

    assert.equal(record.targetType, "worker");
    assert.equal(record.worker, "WorkerB");
    assert.equal(record.decision, "pi_used_codex_shadow_only");
  } finally {
    if (previousMode === undefined) delete process.env.OX_FACTORY_CODEX_COMPACTION_MODE;
    else process.env.OX_FACTORY_CODEX_COMPACTION_MODE = previousMode;
    if (previousScope === undefined) delete process.env.OX_FACTORY_CODEX_COMPACTION_SCOPE;
    else process.env.OX_FACTORY_CODEX_COMPACTION_SCOPE = previousScope;
    if (previousWorkers === undefined) delete process.env.OX_FACTORY_CODEX_COMPACTION_WORKERS;
    else process.env.OX_FACTORY_CODEX_COMPACTION_WORKERS = previousWorkers;
    if (previousLegacy === undefined) delete process.env.OX_FACTORY_CODEX_COMPACTION;
    else process.env.OX_FACTORY_CODEX_COMPACTION = previousLegacy;
    rmSync(workersDir, { recursive: true, force: true });
  }
});

test("main agent compaction refuses apply mode unless explicitly forced", async () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-compaction-main-apply-test-"));
  try {
    const sessionFile = join(tmpdir(), ".pi", "agent", "sessions", "--repo--", "2026-07-02T00-00-00_main.jsonl");
    let calls = 0;
    const notices = [];
    const event = {
      reason: "manual",
      preparation: {
        firstKeptEntryId: "main-apply-keep",
        tokensBefore: 1000,
        messagesToSummarize: [{ role: "user", content: "不要真的替换主 agent 压缩" }],
        turnPrefixMessages: [],
      },
    };
    const ctx = {
      cwd: "/repo",
      sessionManager: { getSessionFile: () => sessionFile },
      ui: { notify(message, level) { notices.push({ message, level }); } },
    };

    const result = await handleFactoryCompactionEvent(event, ctx, {
      mode: "apply",
      scope: "main",
      workersDir,
      runCodexCompactionFn: async () => {
        calls += 1;
        return { summary: "should not run", firstKeptEntryId: "main-apply-keep", tokensBefore: 1000, details: {} };
      },
    });

    assert.equal(result, undefined);
    assert.equal(calls, 0);
    assert.equal(notices.length, 1);
    assert.match(notices[0].message, /主 agent.*shadow/i);
  } finally {
    rmSync(workersDir, { recursive: true, force: true });
  }
});

test("compaction report CLI prints shadow comparison records", () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-compaction-report-cli-test-"));
  try {
    mkdirSync(workersDir, { recursive: true });
    writeFileSync(
      join(workersDir, "compaction-shadow.jsonl"),
      `${JSON.stringify({
        id: "cmp_shadow_cli",
        time: "2026-07-02T01:00:00.000Z",
        worker: "DeveloperA",
        decision: "pi_used_codex_shadow_only",
        pi: { summaryChars: 1000, estimatedTokens: 250, summaryFile: "compactions/cmp.pi.md" },
        codex: {
          status: "done",
          summaryChars: 800,
          estimatedTokens: 200,
          latencyMs: 1234,
          hasFactoryContext: true,
          hasNextTurnInstructions: true,
          hasCommandsVerification: false,
          summaryFile: "compactions/cmp.codex.md",
        },
      })}\n`,
      "utf8",
    );

    const output = execFileSync(process.execPath, [
      join(testDir, "../compaction-report.mjs"),
      "--workers-dir",
      workersDir,
      "--limit",
      "5",
    ], { encoding: "utf8" });

    assert.match(output, /压缩对比报告/);
    assert.match(output, /DeveloperA/);
    assert.match(output, /pi_used_codex_shadow_only/);

    const jsonOutput = execFileSync(process.execPath, [
      join(testDir, "../compaction-report.mjs"),
      "--workers-dir",
      workersDir,
      "--json",
    ], { encoding: "utf8" });
    const report = JSON.parse(jsonOutput);
    assert.equal(report.records[0].worker, "DeveloperA");
  } finally {
    rmSync(workersDir, { recursive: true, force: true });
  }
});

test("quality report estimates active context from latest compaction boundary", () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-quality-active-context-test-"));
  try {
    mkdirSync(join(workersDir, "sessions"), { recursive: true });
    const veryLongHistory = "旧历史".repeat(2000);
    const keptMessage = "保留消息";
    const summary = "压缩摘要";
    writeFileSync(join(workersDir, "sessions", "WorkerC.jsonl"), [
      JSON.stringify({ type: "message", id: "old1", parentId: null, timestamp: "2026-07-07T08:00:00Z", message: { role: "user", content: veryLongHistory } }),
      JSON.stringify({ type: "message", id: "keep1", parentId: "old1", timestamp: "2026-07-07T09:00:00Z", message: { role: "user", content: keptMessage } }),
      JSON.stringify({ type: "compaction", id: "cmp1", parentId: "keep1", timestamp: "2026-07-07T09:30:00Z", summary, tokensBefore: 12345, firstKeptEntryId: "keep1" }),
    ].join("\n") + "\n", "utf8");

    const report = buildFactoryQualityReport({ workersDir, worker: "WorkerC", limit: 20 });
    const session = report.workers[0].session;
    assert.equal(session.compactionCount, 1);
    assert.equal(session.latestTokensBefore, 12345);
    assert.ok(session.sessionFileTokens > session.activeContextTokens * 10);
    assert.ok(session.activeContextTokens < 20);
    assert.equal(session.estimatedContextTokens, session.activeContextTokens);
  } finally {
    rmSync(workersDir, { recursive: true, force: true });
  }
});

test("quality report correlates context, compactions, input/output, latency and tools", () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-quality-report-test-"));
  try {
    const job = createJob(workersDir, {
      worker: "WorkerB",
      project: "talk",
      task: "这个回复不太行，你重新检查一下页面报错。",
      cwd: "/repo",
      sessionFile: join(workersDir, "sessions", "WorkerB.jsonl"),
    });
    appendJobEvent(job, { type: "started", message: "start" });
    appendJobEvent(job, { type: "tool_start", name: "bash", args: { command: "node --check web/app.js" } });
    appendJobEvent(job, { type: "tool_end", name: "bash", result: { exitCode: 0 } });
    appendJobEvent(job, { type: "done", text: "已经定位到变量遮蔽，并修复完成。" });
    updateJob(job, {
      status: "done",
      createdAt: "2026-07-07T10:00:00.000Z",
      startedAt: "2026-07-07T10:00:00.000Z",
      finishedAt: "2026-07-07T10:00:12.000Z",
      elapsedSeconds: 12,
      summary: "已经定位到变量遮蔽，并修复完成。",
      fullOutput: "已经定位到变量遮蔽，并修复完成。",
      model: "MiniMax-M3",
      inputTokens: 100,
      cachedInputTokens: 300,
      outputTokens: 20,
      reasoningOutputTokens: 5,
      totalTokens: 120,
    });

    mkdirSync(join(workersDir, "sessions"), { recursive: true });
    writeFileSync(join(workersDir, "sessions", "WorkerB.jsonl"), [
      JSON.stringify({ type: "message", id: "u1", timestamp: "2026-07-07T09:00:00Z", message: { role: "user", content: "早期输入" } }),
      JSON.stringify({ type: "message", id: "a1", timestamp: "2026-07-07T09:00:02Z", message: { role: "assistant", content: [{ type: "text", text: "早期输出" }] } }),
      JSON.stringify({ type: "compaction", id: "cmp1", timestamp: "2026-07-07T09:30:00Z", summary: "压缩摘要", tokensBefore: 8888, firstKeptEntryId: "u1" }),
    ].join("\n") + "\n", "utf8");

    const report = buildFactoryQualityReport({ workersDir, date: "2026-07-07", limit: 20 });
    assert.equal(report.config.enabled, false);
    assert.equal(report.workers.length, 1);
    assert.equal(report.workers[0].worker, "WorkerB");
    assert.equal(report.workers[0].session.compactionCount, 1);
    assert.equal(report.workers[0].session.messageCount, 2);
    assert.ok(report.workers[0].session.estimatedContextTokens > 0);
    assert.equal(report.workers[0].jobs.count, 1);
    assert.equal(report.workers[0].jobs.avgResponseMs, 12000);
    assert.equal(report.workers[0].jobs.toolCalls, 1);
    assert.equal(report.turns[0].inputChars, "这个回复不太行，你重新检查一下页面报错。".length);
    assert.equal(report.turns[0].taskChars, "这个回复不太行，你重新检查一下页面报错。".length);
    assert.equal(report.turns[0].outputChars, "已经定位到变量遮蔽，并修复完成。".length);
    assert.equal(report.turns[0].summaryChars, "已经定位到变量遮蔽，并修复完成。".length);
    assert.equal(report.turns[0].elapsedSeconds, 12);
    assert.equal(report.turns[0].cachedInputTokens, 300);
    assert.equal(report.turns[0].reasoningOutputTokens, 5);
    assert.equal(report.turns[0].model, "MiniMax-M3");
    assert.equal(report.turns[0].emotionScore, null);
    assert.match(formatFactoryQualityReport(report), /WorkerB/);
    assert.match(formatFactoryQualityReport(report), /工具调用/);
  } finally {
    rmSync(workersDir, { recursive: true, force: true });
  }
});

test("quality report backfills all usable history and drops inconsistent jobs", () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-quality-history-test-"));
  try {
    mkdirSync(join(workersDir, "sessions"), { recursive: true });
    writeFileSync(join(workersDir, "sessions", "WorkerB.jsonl"), [
      JSON.stringify({ type: "message", id: "u1", timestamp: "2026-07-05T09:00:00Z", message: { role: "user", content: "历史输入" } }),
      JSON.stringify({ type: "message", id: "a1", timestamp: "2026-07-05T09:00:02Z", message: { role: "assistant", content: [{ type: "text", text: "历史输出" }] } }),
      JSON.stringify({ type: "compaction", id: "cmp1", timestamp: "2026-07-06T09:30:00Z", summary: "历史压缩", tokensBefore: 2000 }),
      JSON.stringify({ type: "message", id: "u2", timestamp: "2026-07-07T09:00:00Z", message: { role: "user", content: "今天输入" } }),
    ].join("\n") + "\n", "utf8");

    const oldJob = createJob(workersDir, {
      worker: "WorkerB",
      project: "talk",
      task: "历史任务",
      cwd: "/repo",
      sessionFile: join(workersDir, "sessions", "WorkerB.jsonl"),
    });
    appendJobEvent(oldJob, { type: "tool_start", name: "bash", args: {} });
    appendJobEvent(oldJob, { type: "done", text: "历史完成" });
    updateJob(oldJob, {
      status: "done",
      createdAt: "2026-07-05T10:00:00.000Z",
      startedAt: "2026-07-05T10:00:00.000Z",
      finishedAt: "2026-07-05T10:00:10.000Z",
      elapsedSeconds: 10,
      fullOutput: "历史完成",
    });

    const todayJob = createJob(workersDir, {
      worker: "WorkerB",
      project: "talk",
      task: "今天任务",
      cwd: "/repo",
      sessionFile: join(workersDir, "sessions", "WorkerB.jsonl"),
    });
    appendJobEvent(todayJob, { type: "done", text: "今天完成" });
    updateJob(todayJob, {
      status: "done",
      createdAt: "2026-07-07T10:00:00.000Z",
      startedAt: "2026-07-07T10:00:00.000Z",
      finishedAt: "2026-07-07T10:00:04.000Z",
      elapsedSeconds: 4,
      fullOutput: "今天完成",
    });

    const runningJob = createJob(workersDir, { worker: "WorkerB", project: "talk", task: "还没完", cwd: "/repo" });
    updateJob(runningJob, { status: "running", createdAt: "2026-07-07T11:00:00.000Z" });

    const badDateJob = createJob(workersDir, { worker: "WorkerB", project: "talk", task: "坏时间", cwd: "/repo" });
    updateJob(badDateJob, { status: "done", createdAt: "not-a-date", fullOutput: "坏时间完成" });

    const noOutputJob = createJob(workersDir, { worker: "WorkerB", project: "talk", task: "无输出", cwd: "/repo" });
    updateJob(noOutputJob, { status: "done", createdAt: "2026-07-07T12:00:00.000Z" });

    const report = buildFactoryQualityReport({ workersDir, date: "all", limit: "all" });
    assert.equal(report.date, "all");
    assert.equal(report.totals.turns, 2);
    assert.equal(report.history.droppedJobs, 3);
    assert.deepEqual(report.dates.map((d) => d.date), ["2026-07-05", "2026-07-07"]);
    assert.equal(report.dates[0].turns, 1);
    assert.equal(report.dates[1].turns, 1);
    assert.ok(report.turns.every((turn) => turn.status === "done"));
    assert.equal(report.turns.find((turn) => turn.taskPreview === "历史任务").toolCalls, 1);
  } finally {
    rmSync(workersDir, { recursive: true, force: true });
  }
});

test("quality monitor config is persisted and factory tool is exposed", () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-quality-config-test-"));
  try {
    assert.equal(readQualityMonitorConfig(workersDir).enabled, false);
    const config = writeQualityMonitorConfig(workersDir, {
      enabled: true,
      provider: "deepseek",
      endpoint: "https://api.deepseek.com/v1/chat/completions",
      model: "deepseek-chat",
      apiKeyEnv: "DEEPSEEK_API_KEY",
    });
    assert.equal(config.enabled, true);
    assert.equal(readQualityMonitorConfig(workersDir).provider, "deepseek");

    const indexSource = readFileSync(join(testDir, "../index.ts"), "utf8");
    const webServerSource = readFileSync(join(testDir, "../web-server.mjs"), "utf8");
    const webAppSource = readFileSync(join(testDir, "../web/app.js"), "utf8");
    assert.match(indexSource, /name:\s*"factory_quality_monitor_config"/);
    assert.match(webServerSource, /\/api\/quality-metrics/);
    assert.match(webServerSource, /date === "all"/);
    assert.match(webServerSource, /qualityMetricsCache/);
    assert.match(webAppSource, /renderQualityMetrics/);
    assert.match(webAppSource, /qualityDateMode/);
    assert.match(webAppSource, /qualityMetricsHost/);
    assert.match(webAppSource, /modelForTurn/);
    assert.match(webAppSource, /turn\??\.model/);
  } finally {
    rmSync(workersDir, { recursive: true, force: true });
  }
});

test("quality emotion scorer writes bounded 1-5 scores when enabled", async () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-quality-emotion-test-"));
  const oldKey = process.env.DEEPSEEK_API_KEY;
  try {
    process.env.DEEPSEEK_API_KEY = "test-key";
    const job = createJob(workersDir, {
      worker: "WorkerB",
      project: "talk",
      task: "这次做得不错，继续。",
      cwd: "/repo",
      sessionFile: join(workersDir, "sessions", "WorkerB.jsonl"),
    });
    updateJob(job, { status: "done", summary: "收到，我继续。" });
    writeQualityMonitorConfig(workersDir, {
      enabled: true,
      provider: "deepseek",
      endpoint: "https://api.deepseek.com/v1/chat/completions",
      model: "deepseek-chat",
      apiKeyEnv: "DEEPSEEK_API_KEY",
    });
    const calls = [];
    const result = await scoreUserEmotion({
      workersDir,
      job,
      userText: job.task,
      assistantText: "收到，我继续。",
      fetchFn: async (url, init) => {
        calls.push({ url, init });
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { content: JSON.stringify({ score: 4, label: "认可", reason: "用户给出正向反馈" }) } }],
          }),
        };
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(result.status, "scored");
    assert.equal(result.score, 4);
    const report = buildFactoryQualityReport({ workersDir, limit: 20 });
    assert.equal(report.totals.scoredTurns, 1);
    assert.equal(report.turns[0].emotionScore, 4);
  } finally {
    if (oldKey == null) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = oldKey;
    rmSync(workersDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 外包隔离：员工 tab 不应出现外包虚拟 worker
// ---------------------------------------------------------------------------

test("isOutsourceJob detects kind=outsource-run and defensive worker name", () => {
  assert.equal(isOutsourceJob({ kind: "outsource-run" }), true);
  assert.equal(isOutsourceJob({ kind: "OUTSOURCE-RUN" }), true);
  assert.equal(isOutsourceJob({ kind: "talk" }), false);
  assert.equal(isOutsourceJob({ kind: "assigned-task" }), false);
  assert.equal(isOutsourceJob({ worker: "外包:whitepaper-a", kind: "talk" }), true);
  assert.equal(isOutsourceJob({ worker: "DeveloperA", kind: "talk" }), false);
  assert.equal(isOutsourceJob({}), false);
});

test("isOutsourceWorkerName detects 外包: prefix defensively", () => {
  assert.equal(isOutsourceWorkerName("外包:whitepaper-a"), true);
  assert.equal(isOutsourceWorkerName("外包:WorkerC"), true);
  assert.equal(isOutsourceWorkerName("外包"), false);
  assert.equal(isOutsourceWorkerName("DeveloperA"), false);
  assert.equal(isOutsourceWorkerName(""), false);
  assert.equal(isOutsourceWorkerName(null), false);
  assert.equal(isOutsourceWorkerName(undefined), false);
});

test("uniqueEmployeeWorkers excludes outsource-run job workers but keeps real session workers", () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-outsource-isolation-unique-"));
  try {
    // 真实员工 session 文件
    const sessionsDir = join(workersDir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, "DeveloperA.jsonl"), "", "utf8");
    writeFileSync(join(sessionsDir, "LocalAdmin.jsonl"), "", "utf8");

    // 正式 job
    const normalJob = createJob(workersDir, {
      kind: "talk",
      worker: "DeveloperA",
      project: "落地页",
      task: "做个按钮",
    });
    updateJob(normalJob, { status: "done" });

    // 只有 job 没有 session 的正式员工
    const jobOnlyJob = createJob(workersDir, {
      kind: "talk",
      worker: "Foreman",
      project: "工厂日报",
      task: "生成日报",
    });
    updateJob(jobOnlyJob, { status: "done" });

    // outsource-run job — 其 worker 不应进入员工列表
    const outsourceJob = createJob(workersDir, {
      kind: "outsource-run",
      worker: "外包:whitepaper-a",
      project: "后台任务",
      task: "后台处理",
    });
    updateJob(outsourceJob, { status: "done" });

    const result = uniqueWorkers(workersDir);

    assert.ok(result.includes("DeveloperA"), "正式 session 员工应保留");
    assert.ok(result.includes("LocalAdmin"), "正式 session 员工应保留");
    assert.ok(result.includes("Foreman"), "正式 job-only 员工应保留");
    assert.ok(!result.includes("外包:whitepaper-a"), "外包虚拟 worker 不应进入员工列表");
    assert.ok(!result.some((w) => w.startsWith("外包:")), "不应有任何 外包: 前缀的 worker");
  } finally {
    rmSync(workersDir, { recursive: true, force: true });
  }
});

test("buildEmployeeWorkersView filters 外包: names from registry and sessions", () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-outsource-isolation-view-"));
  try {
    const sessionsDir = join(workersDir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, "DeveloperA.jsonl"), "", "utf8");
    // 污染：外包 session 文件（历史数据/registry 污染）
    writeFileSync(join(sessionsDir, "外包:WorkerC.jsonl"), "", "utf8");

    const normalJob = createJob(workersDir, {
      kind: "talk",
      worker: "DeveloperA",
      project: "落地页",
      task: "做按钮",
    });
    updateJob(normalJob, { status: "done", summary: "按钮做好了" });

    const outsourceJob = createJob(workersDir, {
      kind: "outsource-run",
      worker: "外包:whitepaper-a",
      project: "后台任务",
      task: "后台处理",
    });
    updateJob(outsourceJob, { status: "done", summary: "后台完成" });

    // 模拟 registry 里有外包污染
    const fakeRegistry = new Map();
    fakeRegistry.set("DeveloperA", { role: "programmer", status: "idle" });
    fakeRegistry.set("外包:污染", { role: "outsource", status: "idle" });

    const jobs = [normalJob, outsourceJob];
    const view = buildWorkersView(workersDir, jobs, { workers: [] }, [], fakeRegistry);

    const names = view.map((w) => w.name);
    assert.ok(names.includes("DeveloperA"), "正式员工应在视图中");
    assert.ok(!names.some((n) => n.startsWith("外包:")), "外包: 前缀的 worker 应被过滤");
    assert.ok(!names.includes("外包:WorkerC"), "外包 session 污染应被过滤");
    assert.ok(!names.includes("外包:whitepaper-a"), "外包 job worker 应被过滤");
    assert.ok(!names.includes("外包:污染"), "外包 registry 污染应被过滤");
  } finally {
    rmSync(workersDir, { recursive: true, force: true });
  }
});

test("buildProjectStripsForEmployees excludes outsource virtual workers from participants but keeps job count", () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-outsource-project-strips-"));
  try {
    const sessionsDir = join(workersDir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, "DeveloperA.jsonl"), "", "utf8");

    // 正式员工的 job
    const normalJob = createJob(workersDir, {
      kind: "talk",
      worker: "DeveloperA",
      project: "落地页",
      task: "做按钮",
    });
    updateJob(normalJob, { status: "done", summary: "按钮做好了" });

    // 外包执行的 job（同一个项目）
    const outsourceJob = createJob(workersDir, {
      kind: "outsource-run",
      worker: "外包:whitepaper-a",
      project: "落地页",
      task: "后台数据处理",
    });
    updateJob(outsourceJob, { status: "done", summary: "数据处理完成" });

    const strips = buildProjectStrips(workersDir);
    const project = strips.find((s) => s.name === "落地页");

    assert.ok(project, "项目条应存在");
    assert.equal(project.total, 2, "项目 job 计数应包含外包执行的 job");
    assert.equal(project.byStatus.done, 2, "done 状态计数应包含外包 job");
    assert.ok(project.participants.includes("DeveloperA"), "正式员工应在 participants 中");
    assert.ok(!project.participants.includes("外包:whitepaper-a"), "外包虚拟 worker 不应在 participants 中");
    assert.ok(!project.participants.some((p) => p.startsWith("外包:")), "participants 不应有 外包: 前缀");
  } finally {
    rmSync(workersDir, { recursive: true, force: true });
  }
});

test("computeReliableFinishedAt falls back through finishedAt/completedAt/cancelledAt/staleAt/updatedAt", () => {
  assert.equal(computeReliableFinishedAt({ finishedAt: "2026-07-10T10:00:00Z" }), "2026-07-10T10:00:00Z");
  assert.equal(computeReliableFinishedAt({ completedAt: "2026-07-10T11:00:00Z" }), "2026-07-10T11:00:00Z");
  assert.equal(computeReliableFinishedAt({ cancelledAt: "2026-07-10T12:00:00Z" }), "2026-07-10T12:00:00Z");
  assert.equal(computeReliableFinishedAt({ staleAt: "2026-07-10T13:00:00Z" }), "2026-07-10T13:00:00Z");
  assert.equal(
    computeReliableFinishedAt({ status: "done", updatedAt: "2026-07-10T14:00:00Z" }),
    "2026-07-10T14:00:00Z",
  );
  assert.equal(
    computeReliableFinishedAt({ status: "running", updatedAt: "2026-07-10T14:00:00Z" }),
    null,
    "运行中的 updatedAt 不是完成时间",
  );
  // 优先级：finishedAt > completedAt > cancelledAt > staleAt > updatedAt
  assert.equal(
    computeReliableFinishedAt({
      finishedAt: "2026-07-10T10:00:00Z",
      completedAt: "2026-07-10T11:00:00Z",
      cancelledAt: "2026-07-10T12:00:00Z",
      staleAt: "2026-07-10T13:00:00Z",
      updatedAt: "2026-07-10T14:00:00Z",
      status: "done",
    }),
    "2026-07-10T10:00:00Z",
  );
  assert.equal(computeReliableFinishedAt({}), null);
  assert.equal(computeReliableFinishedAt(null), null);
});

test("computeReliableElapsedMs uses startedAt or createdAt to finishedAt when elapsedMs not persisted", () => {
  // 有持久化 elapsedMs 时直接返回
  assert.equal(
    computeReliableElapsedMs({ elapsedMs: 5000 }, {}),
    5000,
  );
  // 合法的 0ms 应被接受
  assert.equal(
    computeReliableElapsedMs({ elapsedMs: 0 }, {}),
    0,
    "elapsedMs=0 是合法值，应直接返回",
  );
  // 负数应被拒绝
  assert.equal(
    computeReliableElapsedMs({ elapsedMs: -100 }, {}),
    null,
    "负数 elapsedMs 应返回 null",
  );
  // 非有限数应被拒绝
  assert.equal(
    computeReliableElapsedMs({ elapsedMs: NaN }, {}),
    null,
    "NaN elapsedMs 应返回 null",
  );
  // 用 startedAt → finishedAt
  assert.equal(
    computeReliableElapsedMs(
      { startedAt: "2026-07-10T10:00:00Z" },
      { finishedAt: "2026-07-10T10:00:05Z" },
    ),
    5000,
  );
  // 用 createdAt → finishedAt (fallback)
  assert.equal(
    computeReliableElapsedMs(
      { createdAt: "2026-07-10T10:00:00Z" },
      { finishedAt: "2026-07-10T10:00:03Z" },
    ),
    3000,
  );
  // startedAt 优先于 createdAt
  assert.equal(
    computeReliableElapsedMs(
      { startedAt: "2026-07-10T10:00:02Z", createdAt: "2026-07-10T10:00:00Z" },
      { finishedAt: "2026-07-10T10:00:05Z" },
    ),
    3000,
  );
  // 无足够数据返回 null
  assert.equal(computeReliableElapsedMs({}, {}), null);
  assert.equal(computeReliableElapsedMs({ createdAt: "2026-07-10T10:00:00Z" }, {}), null);
});

test("serializeOutsourceRun includes fullOutput and reliable finishedAt/elapsedMs", () => {
  const fullText = "这是完整的外包输出。".repeat(10);
  const run = {
    id: "run-1",
    profileName: "whitepaper-a",
    status: "done",
    task: "实现一个功能",
    summary: "完成了",
    fullOutput: fullText,
    startedAt: "2026-07-10T10:00:00.000Z",
    finishedAt: "2026-07-10T10:00:05.000Z",
    elapsedMs: 5000,
  };
  const detail = serializeOutsourceRun(run, { includeFullOutput: true });
  assert.equal(detail.runId, "run-1");
  assert.equal(detail.status, "done");
  assert.equal(detail.fullOutput, fullText, "detail 应包含 fullOutput");
  assert.equal(detail.finishedAt, "2026-07-10T10:00:05.000Z", "应使用可靠 finishedAt");
  assert.equal(detail.elapsedMs, 5000, "应使用持久化 elapsedMs");
  assert.equal(detail.taskLength, 6, "应暴露任务字符长度，便于观察输入规模");
  assert.equal(detail.terminal, true);

  // 列表视图不含 fullOutput
  const listItem = serializeOutsourceRun(run, { includeFullOutput: false });
  assert.equal(listItem.fullOutput, undefined, "列表不应包含 fullOutput");
  assert.equal(listItem.elapsedMs, 5000);
  assert.equal(listItem.finishedAt, "2026-07-10T10:00:05.000Z");
  assert.equal(listItem.taskLength, 6);
});

test("outsource web UI exposes task length next to elapsed runtime", () => {
  const appSource = readFileSync(join(testDir, "../web/app.js"), "utf8");
  assert.match(appSource, /任务长度/);
  assert.match(appSource, /r\.taskLength/);
  assert.match(appSource, /outsource-run__task-length/);
});

test("serializeOutsourceRun falls back through reliable time fields", () => {
  // 没有 finishedAt / elapsedMs，只有 staleAt + startedAt
  const run = {
    id: "run-2",
    profileName: "WorkerC",
    status: "stale",
    startedAt: "2026-07-10T09:00:00.000Z",
    staleAt: "2026-07-10T09:30:00.000Z",
  };
  const s = serializeOutsourceRun(run, { includeFullOutput: true });
  assert.equal(s.finishedAt, "2026-07-10T09:30:00.000Z", "finishedAt 应 fallback 到 staleAt");
  assert.equal(s.elapsedMs, 30 * 60 * 1000, "elapsedMs 应从 startedAt→staleAt 计算");
  assert.equal(s.terminal, true);
});

test("serializeOutsourceRun accepts elapsedMs=0", () => {
  const run = {
    id: "run-3",
    status: "done",
    startedAt: "2026-07-10T10:00:00.000Z",
    finishedAt: "2026-07-10T10:00:00.000Z",
    elapsedMs: 0,
  };
  const s = serializeOutsourceRun(run);
  assert.equal(s.elapsedMs, 0, "合法的 0ms 应被接受，不应 fallback 到计算值");
});

test("serializeOutsourceRun keeps running updates separate from terminal timing", () => {
  const run = {
    id: "run-live",
    status: "running",
    startedAt: "2026-07-10T10:00:00.000Z",
    updatedAt: "2026-07-10T10:05:00.000Z",
  };
  const serialized = serializeOutsourceRun(run);
  assert.equal(serialized.updatedAt, run.updatedAt);
  assert.equal(serialized.finishedAt, null);
  assert.equal(serialized.elapsedMs, null);
  assert.equal(serialized.terminal, false);
});

test("serializeOutsourceRun returns null elapsedMs for invalid dates", () => {
  const run = {
    id: "run-4",
    status: "running",
    startedAt: "not-a-date",
    finishedAt: "also-bad",
  };
  const s = serializeOutsourceRun(run);
  assert.equal(s.finishedAt, "also-bad");
  assert.equal(s.elapsedMs, null, "无效日期应返回 null");
});

test("outsource run list/detail include fullOutput via serializeOutsourceRun", async () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-outsource-serialize-"));
  try {
    upsertOutsourceProfile(workersDir, {
      name: "whitepaper-a",
      backend: "pi",
      tools: ["read", "bash"],
      skills: false,
    });
    const run = createOutsourceRun(workersDir, {
      profileName: "whitepaper-a",
      task: "实现一个功能",
      project: "test-project",
      requestedBy: "WorkerL",
    });
    markOutsourceRunRunning(workersDir, {
      runId: run.id,
      jobId: "job-test-1",
      startedAt: "2026-07-09T10:00:00.000Z",
    });
    const fullText = "这是完整的外包输出，包含详细的实现说明。".repeat(10);
    completeOutsourceRun(workersDir, {
      runId: run.id,
      status: "done",
      summary: "完成功能实现",
      fullOutput: fullText,
      usage: { inputTokens: 100, outputTokens: 200, totalTokens: 300 },
    });

    // 直接用 getOutsourceRun 拿到的对象走 serializeOutsourceRun（模拟 handler 行为）
    const detailRun = getOutsourceRun(workersDir, run.id);
    const detail = serializeOutsourceRun(detailRun, { includeFullOutput: true });
    assert.ok(detail.fullOutput, "detail JSON 应包含 fullOutput");
    assert.equal(detail.fullOutput.length, fullText.length);
    assert.ok(detail.finishedAt, "detail 应有可靠 finishedAt");
    assert.ok(detail.elapsedMs != null, "detail 应有可靠 elapsedMs");

    // 列表视图不含 fullOutput
    const listItem = serializeOutsourceRun(detailRun, { includeFullOutput: false });
    assert.equal(listItem.fullOutput, undefined, "列表项不应包含 fullOutput");
    assert.ok(listItem.finishedAt, "列表项应有可靠 finishedAt");
    assert.ok(listItem.elapsedMs != null, "列表项应有可靠 elapsedMs");
  } finally {
    rmSync(workersDir, { recursive: true, force: true });
  }
});

test("notification settings are opt-in and persisted under workers config", () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-notification-settings-"));
  try {
    const initial = readNotificationSettings(workersDir);
    assert.equal(initial.enabled, false);
    assert.equal(initial.jobTerminal.enabled, true);
    assert.deepEqual(initial.jobTerminal.statuses, ["done"]);

    const written = writeNotificationSettings(workersDir, {
      enabled: true,
      pollIntervalMs: 250,
      jobTerminal: {
        statuses: ["done", "failed", "unknown"],
        workers: ["派派"],
        excludedKinds: ["steer"],
        excludedSources: ["system"],
        template: "{worker} 完成了 {project}",
        failureTemplate: "{worker} 挂了",
      },
    });

    assert.equal(written.enabled, true);
    assert.equal(written.pollIntervalMs, 1000, "轮询间隔下限应防止前端过度请求");
    assert.deepEqual(written.jobTerminal.statuses, ["done", "failed"]);
    assert.ok(existsSync(notificationSettingsFile(workersDir)));

    const reread = readNotificationSettings(workersDir);
    assert.deepEqual(reread, written);
  } finally {
    rmSync(workersDir, { recursive: true, force: true });
  }
});

test("job notifications only include configured non-steer terminal jobs", () => {
  const settings = {
    enabled: true,
    jobTerminal: {
      statuses: ["done"],
      workers: ["派派"],
      excludedKinds: ["steer"],
      excludedSources: ["quality_emotion"],
      template: "{worker} 任务完成",
    },
  };
  const base = {
    id: "job-1",
    worker: "派派",
    status: "done",
    kind: "talk",
    source: "web",
    project: "talk",
    finishedAt: "2026-07-22T10:00:00.000Z",
  };

  assert.equal(shouldNotifyJob(base, settings), true);
  assert.equal(shouldNotifyJob({ ...base, kind: "steer" }, settings), false);
  assert.equal(shouldNotifyJob({ ...base, source: "quality_emotion" }, settings), false);
  assert.equal(shouldNotifyJob({ ...base, status: "failed" }, settings), false);
  assert.equal(shouldNotifyJob({ ...base, worker: "八村" }, settings), false);

  const notifications = buildJobNotifications([
    { ...base, id: "old", finishedAt: "2026-07-22T09:59:59.000Z" },
    base,
    { ...base, id: "steer", kind: "steer", finishedAt: "2026-07-22T10:01:00.000Z" },
  ], settings, { since: "2026-07-22T09:59:59.500Z" });

  assert.deepEqual(notifications.map((n) => n.id), ["job:job-1:done"]);
  assert.equal(notifications[0].message, "派派 任务完成");
});

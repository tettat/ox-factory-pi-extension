import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  appendJobEvent,
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
  grantPermission,
  hasPermission,
  listMessages,
  listPermissions,
  markMessageRead,
  revokePermission,
  sendAuthorizedMessage,
} from "../comm.mjs";
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
  normalizeCodexEffort,
  normalizeCodexModel,
  subtractCodexTokenUsage,
} from "../codex-backend.mjs";
import {
  buildFactoryWorkerHandbook,
} from "../factory-handbook.mjs";
import {
  parseCodexRolloutLines,
  repairCodexJobTokenMetadata,
  summarizeSegments,
} from "../codex-rollout-token-report.mjs";
import { selectNextPending, shouldRunInProcess } from "../queue-utils.mjs";
import { repairToolResultParents } from "../session-repair.mjs";
import { resolveProjectMarkdownDocRef } from "../web-server.mjs";
import {
  acceptWebTalkRequest,
  createWebTalkRequest,
  failWebTalkRequest,
  getWebTalkRequest,
  listPendingWebTalkRequests,
  listWebTalkRequests,
} from "../web-talk.mjs";

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
      worker: "东子",
      project: "showcase",
      task: "旧结果",
    });
    appendJobEvent(oldJob, { type: "done", text: "旧结果完成" });
    updateJob(oldJob, { status: "done", summary: "旧摘要", updatedAt: "2026-07-01T00:00:00.000Z" });

    const newJob = createJob(workersDir, {
      kind: "talk",
      worker: "步美",
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
  assert.deepEqual(parsePickCommandArgs("步美 --peek"), {
    worker: "步美",
    mode: "random",
    markRead: false,
    peek: true,
  });
  assert.deepEqual(parsePickCommandArgs("--latest 东子"), {
    worker: "东子",
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

test("codex backend maps worker thinking levels to Codex reasoning effort", () => {
  assert.equal(normalizeCodexEffort("off"), "none");
  assert.equal(normalizeCodexEffort("minimal"), "low");
  assert.equal(normalizeCodexEffort("high"), "high");
  assert.equal(normalizeCodexEffort("xhigh"), "xhigh");
  assert.equal(normalizeCodexEffort(undefined), undefined);
});

test("codex backend normalizes conversational model aliases", () => {
  assert.equal(normalizeCodexModel("5.5"), "gpt-5.5");
  assert.equal(normalizeCodexModel("5.4"), "gpt-5.4");
  assert.equal(normalizeCodexModel("gpt5.5"), "gpt-5.5");
  assert.equal(normalizeCodexModel("Codex-5.5"), "gpt-5.5");
  assert.equal(normalizeCodexModel("gpt-5.5"), "gpt-5.5");
  assert.equal(normalizeCodexModel(undefined), undefined);
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
      worker: "东子",
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
      workers: [{ id: "东子", role: "programmer", status: "idle", projects: [], promotions: [], responsibilities: [] }],
    });

    assert.equal(context.totals.jobs, 1);
    assert.equal(context.totals.queueEntries, 1);
    assert.equal(context.queue.statusCounts.done, 1);

    const dongzi = context.workers.find((worker) => worker.worker === "东子");
    assert.equal(dongzi.jobs.done, 1);
    assert.equal(dongzi.queue.done ?? 0, 0);
    assert.match(dongzi.highlights[0], /展示页/);
    assert.ok(dongzi.warnings.some((warning) => warning.includes("stale")));

    const xiaolv = context.workers.find((worker) => worker.worker === "小绿");
    assert.equal(xiaolv.jobs.done ?? 0, 0);
    assert.equal(xiaolv.queue.done, 1);

    const markdown = formatFactoryReportContext(context);
    assert.match(markdown, /全员产出表/);
    assert.match(markdown, /东子/);
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
      join(sessionsDir, "派派.jsonl"),
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
          data: { workerId: "布朗尼", from: "programmer", to: "foreman", date: "2026-06-30" },
        },
      ],
    });

    const paipai = context.workers.find((worker) => worker.worker === "派派");
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
      worker: "布朗尼",
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
    assert.match(output, /布朗尼/);
    assert.match(output, /禁止只凭 queue/);
  } finally {
    rmSync(workersDir, { recursive: true, force: true });
  }
});

test("authorized communication denies ungranted workers and allows explicit grants", () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-comm-auth-test-"));
  try {
    assert.equal(hasPermission(workersDir, { subject: "美伢", action: "message:send", target: "东子" }), false);

    assert.throws(
      () => sendAuthorizedMessage(workersDir, { from: "美伢", to: "东子", content: "你那边进展如何？" }),
      /没有权限/,
    );

    const grant = grantPermission(workersDir, {
      subject: "美伢",
      actions: ["message:send"],
      targets: ["东子"],
      grantedBy: "秘书",
      note: "允许美伢联系东子做开发协作",
    });

    assert.equal(grant.subject, "美伢");
    assert.equal(hasPermission(workersDir, { subject: "美伢", action: "message:send", target: "东子" }), true);

    const sent = sendAuthorizedMessage(workersDir, { from: "美伢", to: "东子", content: "你那边进展如何？" });
    assert.equal(sent.from, "美伢");
    assert.equal(sent.to, "东子");

    const inbox = listMessages(workersDir, { worker: "东子" });
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].content, "你那边进展如何？");
    assert.equal(inbox[0].read, false);

    markMessageRead(workersDir, { messageId: sent.id, worker: "东子" });
    assert.equal(listMessages(workersDir, { worker: "东子", unreadOnly: true }).length, 0);

    revokePermission(workersDir, {
      subject: "美伢",
      actions: ["message:send"],
      targets: ["东子"],
      revokedBy: "秘书",
    });
    assert.equal(hasPermission(workersDir, { subject: "美伢", action: "message:send", target: "东子" }), false);
  } finally {
    rmSync(workersDir, { recursive: true, force: true });
  }
});

test("paipai is a builtin factory admin with worker fire permission", () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-paipai-admin-test-"));
  try {
    assert.equal(hasPermission(workersDir, { subject: "派派", action: "permission:manage", target: "步美" }), true);
    assert.equal(hasPermission(workersDir, { subject: "派派", action: "worker:fire", target: "步美" }), true);
    assert.equal(hasPermission(workersDir, { subject: "美伢", action: "worker:fire", target: "步美" }), false);

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
    assert.equal(listMessages(workersDir, { worker: "东子" }).length, 1);

    assert.throws(
      () => sendAuthorizedMessage(workersDir, { from: "布朗尼", to: "*", content: "大家都来开会。" }),
      /没有权限/,
    );

    grantPermission(workersDir, {
      subject: "布朗尼",
      actions: ["message:broadcast"],
      targets: ["*"],
      grantedBy: "秘书",
    });
    sendAuthorizedMessage(workersDir, { from: "布朗尼", to: "*", content: "请各位同步今日进展。" });
    assert.equal(listPermissions(workersDir, { subject: "布朗尼" }).length, 1);
    assert.equal(listMessages(workersDir, { worker: "美伢" }).length, 2);
  } finally {
    rmSync(workersDir, { recursive: true, force: true });
  }
});

test("comm CLI lets authorized worker subprocesses send and read messages", () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-comm-cli-test-"));
  try {
    grantPermission(workersDir, {
      subject: "派派",
      actions: ["message:send"],
      targets: ["东子"],
      grantedBy: "秘书",
    });

    const cli = join(testDir, "../comm-cli.mjs");
    const sent = execFileSync(process.execPath, [
      cli,
      "send",
      "--workers-dir",
      workersDir,
      "--from",
      "派派",
      "--to",
      "东子",
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
      "东子",
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
        "东子",
        "--content",
        "未授权消息",
      ], { encoding: "utf8", stdio: "pipe" }),
      /Command failed/,
    );
  } finally {
    rmSync(workersDir, { recursive: true, force: true });
  }
});

test("worker responsibilities are append-only, upserted, and removable", () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-responsibility-test-"));
  try {
    setWorkerResponsibility(workersDir, {
      worker: "东子",
      project: "牛马工厂 Web 大盘",
      relation: "lead",
      scope: "负责本地 Web 的前端体验、项目态势和视觉 polish",
      updatedBy: "主agent",
    });
    setWorkerResponsibility(workersDir, {
      worker: "东子",
      project: "牛马工厂 Web 大盘",
      relation: "lead",
      scope: "负责 Overview 大盘、项目态势和 War Room 视觉",
      updatedBy: "派派",
    });
    setWorkerResponsibility(workersDir, {
      worker: "布朗尼",
      project: "工厂日报",
      relation: "owner",
      scope: "负责日报上下文核对和每日归档",
    });

    const dongzi = listWorkerResponsibilities(workersDir, { worker: "东子" });
    assert.equal(dongzi.length, 1);
    assert.equal(dongzi[0].worker, "东子");
    assert.equal(dongzi[0].project, "牛马工厂 Web 大盘");
    assert.equal(dongzi[0].relation, "lead");
    assert.equal(dongzi[0].scope, "负责 Overview 大盘、项目态势和 War Room 视觉");
    assert.equal(dongzi[0].status, "active");
    assert.equal(dongzi[0].updatedBy, "派派");

    const all = listWorkerResponsibilities(workersDir);
    assert.deepEqual(
      new Set(all.map((r) => r.worker)),
      new Set(["东子", "布朗尼"]),
    );

    removeWorkerResponsibility(workersDir, {
      worker: "东子",
      project: "牛马工厂 Web 大盘",
      relation: "lead",
      updatedBy: "主agent",
    });

    assert.equal(listWorkerResponsibilities(workersDir, { worker: "东子" }).length, 0);
    const inactive = listWorkerResponsibilities(workersDir, { worker: "东子", includeInactive: true });
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
      updatedBy: "派派",
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
      worker: "八村",
      relation: "designer",
      note: "负责 Web 视觉和交互",
    });
    setProjectTodo(workersDir, {
      project: "web-dashboard",
      todoId: "project-page",
      title: "新增项目视角页面",
      status: "todo",
      owner: "八村",
      evidence: "docs/ox-factory-project-entity-design.md",
    });
    setProjectWorktree(workersDir, {
      project: "ox-factory-web",
      worktreeId: "hachimura-ui",
      path: ".pi/workers/worktrees/ox-factory-web/hachimura-ui",
      branch: "feat/project-view",
      worker: "八村",
      status: "active",
    });
    addProjectProgress(workersDir, {
      project: "factory-dashboard",
      text: "Project Entity MVP 进入实现阶段",
      status: "doing",
      owner: "派派",
      evidence: "projects.jsonl",
    });

    const project = resolveProject(workersDir, "工厂大盘");
    assert.equal(project.id, "ox-factory-web");
    assert.match(project.summary, /token/);
    assert.deepEqual(new Set(project.aliases), new Set(["web-dashboard", "工厂大盘", "factory-dashboard", "大盘"]));
    assert.equal(project.members.length, 1);
    assert.equal(project.members[0].worker, "八村");
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
      join(sessionsDir, "派派.jsonl"),
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
      worker: "派派",
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
    const paipai = report.workers.find((worker) => worker.worker === "派派");
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
      worker: "光彦",
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
      worker: "光彦",
      threadId: "thread-1",
      rolloutFile: "/tmp/rollout.jsonl",
      segments: [{
        startAt: "2026-07-06T01:00:01.000Z",
        endAt: "2026-07-06T01:05:00.000Z",
        prompt: "你的名字叫 **光彦**。\n## 任务\n发布 showcase",
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
      join(sessionsDir, "派派.jsonl"),
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
      worker: "东子",
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
    assert.match(output, /东子/);
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
    const dongzi = jsonReport.workers.find((worker) => worker.worker === "东子");
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
  assert.match(webServerSource, /ox-worker-status/);
  assert.match(webServerSource, /regInfo\.status === "vacation"/);
});

test("ox web command starts and opens the local dashboard", () => {
  const indexSource = readFileSync(join(testDir, "../index.ts"), "utf8");

  assert.match(indexSource, /registerCommand\("ox-web"/);
  assert.match(indexSource, /ensureOxWebDashboard/);
  assert.match(indexSource, /isOxWebDashboardHealthy/);
  assert.match(indexSource, /web-server\.mjs/);
  assert.match(indexSource, /openExternalUrl/);
  assert.match(indexSource, /127\.0\.0\.1/);
  assert.match(indexSource, /--status/);
  assert.match(indexSource, /--no-open/);
});

test("web talk requests are event-sourced and do not create jobs in web-server", () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-web-talk-test-"));
  try {
    const request = createWebTalkRequest(workersDir, {
      worker: "八村",
      message: "你好",
      from: "web",
    });
    assert.equal(request.status, "pending");
    assert.equal(listPendingWebTalkRequests(workersDir).length, 1);

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
      worker: "八村",
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
    assert.match(indexSource, /startTalkMessage\(w!, message, ctx, undefined, \{ attach: false, notify: false \}\)/);
    assert.match(indexSource, /options:\s*\{ attach\?: boolean; notify\?: boolean \}/);
    assert.match(indexSource, /const notifyConsole = options\.notify !== false/);
    assert.match(indexSource, /if \(notifyConsole\) ctx\?\.ui\?\.notify/);
  } finally {
    rmSync(workersDir, { recursive: true, force: true });
  }
});

test("web job detail exposes full worker reply instead of summary-only truncation", () => {
  const webServerSource = readFileSync(join(testDir, "../web-server.mjs"), "utf8");
  const webAppSource = readFileSync(join(testDir, "../web/app.js"), "utf8");

  assert.match(webServerSource, /JOB_DETAIL_REPLY_MAX_CHARS\s*=\s*200_000/);
  assert.match(webServerSource, /fullReply:\s*fullReply\.text \|\| null/);
  assert.match(webServerSource, /fullReplyTruncated:\s*fullReply\.truncated/);
  assert.match(webServerSource, /job\.fullOutput \|\| latestReply \|\| job\.summary/);
  assert.match(webAppSource, /const replyText = d\.fullReply \|\| d\.latestReply \|\| d\.summary \|\| ""/);
  assert.match(webAppSource, /text:\s*"AI 响应"/);
  assert.match(webAppSource, /响应过长，已展示前/);
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
    id: "步美",
    role: "programmer",
    codexThreadHandoff: "旧 thread: abc\n最近 job: touch 失败，需要 full access",
  }, "", { workersDir: "/tmp/ox-workers" });

  assert.match(instructions, /旧 Codex thread handoff/);
  assert.match(instructions, /旧 thread: abc/);
  assert.match(instructions, /touch 失败/);
  assert.match(instructions, /牛马工厂工作手册/);
  assert.match(instructions, /comm-cli\.mjs send/);
});

test("factory worker handbook documents authorized comm cli for every backend", () => {
  const handbook = buildFactoryWorkerHandbook({
    id: "乔治",
    role: "programmer",
  }, { workersDir: "/tmp/ox-workers", backend: "codex" });

  assert.match(handbook, /牛马工厂工作手册/);
  assert.match(handbook, /授权式通信/);
  assert.match(handbook, /comm-cli\.mjs check --workers-dir \/tmp\/ox-workers --subject "乔治" --action message:send --target 对方员工/);
  assert.match(handbook, /comm-cli\.mjs send --workers-dir \/tmp\/ox-workers --from "乔治" --to 对方员工 --content "消息内容"/);
  assert.match(handbook, /comm-cli\.mjs inbox --workers-dir \/tmp\/ox-workers --worker "乔治"/);
  assert.match(handbook, /留言不是派活/);
});

test("codex task content repeats factory handbook so existing threads learn comm tools", () => {
  const content = buildCodexTaskContent({
    worker: { id: "乔治", role: "programmer" },
    task: "给光彦发一条消息问进展",
    project: "talk",
    workersDir: "/tmp/ox-workers",
  });

  assert.match(content, /## 任务\n给光彦发一条消息问进展/);
  assert.match(content, /牛马工厂工作手册/);
  assert.match(content, /comm-cli\.mjs send --workers-dir \/tmp\/ox-workers --from "乔治" --to 对方员工/);
  assert.match(content, /不要直接改 messages\/permissions 文件/);
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
    worker: { id: "派派", role: "programmer" },
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
  assert.match(request.prompt, /员工：派派/);
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
    const sessionFile = join(workersDir, "sessions", "派派.jsonl");
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
      workers: ["派派"],
      runCodexCompactionFn: async () => {
        codexCalls += 1;
        return {
          summary: "## Worker State\n派派\n\n## Next Turn Instructions\n1. 继续 shadow 对比\n\n## Factory Context\n保留工厂语义。",
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
    assert.equal(record.worker, "派派");
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
    assert.match(markdown, /派派/);
    assert.match(markdown, /shadow/);
  } finally {
    rmSync(workersDir, { recursive: true, force: true });
  }
});

test("shadow compaction respects worker graylist and off mode", async () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-compaction-gray-test-"));
  try {
    const sessionFile = join(workersDir, "sessions", "东子.jsonl");
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
      workers: ["派派"],
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
      workers: ["东子"],
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
      cwd: "/Users/bytedance/Code/alpha_mind",
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
    const sessionFile = join(workersDir, "sessions", "包包.jsonl");
    mkdirSync(dirname(sessionFile), { recursive: true });
    let calls = 0;
    const event = {
      reason: "threshold",
      preparation: {
        firstKeptEntryId: "worker-default-keep",
        tokensBefore: 111740,
        messagesToSummarize: [{ role: "user", content: "包包默认 worker shadow 压缩评估" }],
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
        assert.equal(worker.id, "包包");
        assert.equal(worker.targetType, "worker");
        return {
          summary: "## Worker State\n包包默认开启 shadow。\n\n## Factory Context\n牛马工厂。\n\n## Next Turn Instructions\n1. 继续。",
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
    assert.equal(record.worker, "包包");
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
        worker: "东子",
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
    assert.match(output, /东子/);
    assert.match(output, /pi_used_codex_shadow_only/);

    const jsonOutput = execFileSync(process.execPath, [
      join(testDir, "../compaction-report.mjs"),
      "--workers-dir",
      workersDir,
      "--json",
    ], { encoding: "utf8" });
    const report = JSON.parse(jsonOutput);
    assert.equal(report.records[0].worker, "东子");
  } finally {
    rmSync(workersDir, { recursive: true, force: true });
  }
});

test("quality report correlates context, compactions, input/output, latency and tools", () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-quality-report-test-"));
  try {
    const job = createJob(workersDir, {
      worker: "包包",
      project: "talk",
      task: "这个回复不太行，你重新检查一下页面报错。",
      cwd: "/repo",
      sessionFile: join(workersDir, "sessions", "包包.jsonl"),
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
    writeFileSync(join(workersDir, "sessions", "包包.jsonl"), [
      JSON.stringify({ type: "message", id: "u1", timestamp: "2026-07-07T09:00:00Z", message: { role: "user", content: "早期输入" } }),
      JSON.stringify({ type: "message", id: "a1", timestamp: "2026-07-07T09:00:02Z", message: { role: "assistant", content: [{ type: "text", text: "早期输出" }] } }),
      JSON.stringify({ type: "compaction", id: "cmp1", timestamp: "2026-07-07T09:30:00Z", summary: "压缩摘要", tokensBefore: 8888, firstKeptEntryId: "u1" }),
    ].join("\n") + "\n", "utf8");

    const report = buildFactoryQualityReport({ workersDir, date: "2026-07-07", limit: 20 });
    assert.equal(report.config.enabled, false);
    assert.equal(report.workers.length, 1);
    assert.equal(report.workers[0].worker, "包包");
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
    assert.match(formatFactoryQualityReport(report), /包包/);
    assert.match(formatFactoryQualityReport(report), /工具调用/);
  } finally {
    rmSync(workersDir, { recursive: true, force: true });
  }
});

test("quality report backfills all usable history and drops inconsistent jobs", () => {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-quality-history-test-"));
  try {
    mkdirSync(join(workersDir, "sessions"), { recursive: true });
    writeFileSync(join(workersDir, "sessions", "包包.jsonl"), [
      JSON.stringify({ type: "message", id: "u1", timestamp: "2026-07-05T09:00:00Z", message: { role: "user", content: "历史输入" } }),
      JSON.stringify({ type: "message", id: "a1", timestamp: "2026-07-05T09:00:02Z", message: { role: "assistant", content: [{ type: "text", text: "历史输出" }] } }),
      JSON.stringify({ type: "compaction", id: "cmp1", timestamp: "2026-07-06T09:30:00Z", summary: "历史压缩", tokensBefore: 2000 }),
      JSON.stringify({ type: "message", id: "u2", timestamp: "2026-07-07T09:00:00Z", message: { role: "user", content: "今天输入" } }),
    ].join("\n") + "\n", "utf8");

    const oldJob = createJob(workersDir, {
      worker: "包包",
      project: "talk",
      task: "历史任务",
      cwd: "/repo",
      sessionFile: join(workersDir, "sessions", "包包.jsonl"),
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
      worker: "包包",
      project: "talk",
      task: "今天任务",
      cwd: "/repo",
      sessionFile: join(workersDir, "sessions", "包包.jsonl"),
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

    const runningJob = createJob(workersDir, { worker: "包包", project: "talk", task: "还没完", cwd: "/repo" });
    updateJob(runningJob, { status: "running", createdAt: "2026-07-07T11:00:00.000Z" });

    const badDateJob = createJob(workersDir, { worker: "包包", project: "talk", task: "坏时间", cwd: "/repo" });
    updateJob(badDateJob, { status: "done", createdAt: "not-a-date", fullOutput: "坏时间完成" });

    const noOutputJob = createJob(workersDir, { worker: "包包", project: "talk", task: "无输出", cwd: "/repo" });
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
      worker: "包包",
      project: "talk",
      task: "这次做得不错，继续。",
      cwd: "/repo",
      sessionFile: join(workersDir, "sessions", "包包.jsonl"),
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

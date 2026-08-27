import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FactoryTaskConflictError,
  archiveFactoryTask,
  beginFactoryTaskDispatch,
  createFactoryTask,
  factoryTasksFile,
  getFactoryTask,
  linkFactoryTaskRequest,
  listDueFactoryTasks,
  listFactoryTaskStatuses,
  listFactoryTasks,
  markFactoryTaskRunning,
  restoreFactoryTask,
  settleFactoryTaskExecution,
  splitFactoryTask,
  updateFactoryTask,
} from "../task-board.mjs";

function withWorkersDir(fn) {
  const workersDir = mkdtempSync(join(tmpdir(), "ox-factory-task-board-"));
  try {
    return fn(workersDir);
  } finally {
    rmSync(workersDir, { recursive: true, force: true });
  }
}

test("factory task board creates tasks with free-form status and append-only history", () => {
  withWorkersDir((workersDir) => {
    const task = createFactoryTask(workersDir, {
      title: "设计任务看板",
      description: "给人和员工共同使用",
      context: "整个工厂共用一套",
      project: "talk",
      status: "设计中",
      assignee: "阿哲",
      priority: "high",
      labels: ["web", "协作", "web"],
      creator: "用户",
    });

    assert.match(task.id, /^ftask_/);
    assert.equal(task.status, "设计中");
    assert.equal(task.execution.state, "idle");
    assert.equal(task.revision, 1);
    assert.deepEqual(task.labels, ["web", "协作"]);

    const stored = getFactoryTask(workersDir, task.id, { includeEvents: true });
    assert.equal(stored.title, "设计任务看板");
    assert.equal(stored.events.length, 1);
    assert.equal(stored.events[0].type, "task:created");
    assert.match(readFileSync(factoryTasksFile(workersDir), "utf8"), /"task:created"/);
  });
});

test("factory task board updates arbitrary statuses and rejects stale revisions", () => {
  withWorkersDir((workersDir) => {
    const task = createFactoryTask(workersDir, { title: "实现 API", status: "TODO", creator: "用户" });
    const updated = updateFactoryTask(workersDir, task.id, {
      status: "待安全评审",
      context: "先由阿哲自检",
      updatedBy: "阿哲",
      expectedRevision: task.revision,
    });

    assert.equal(updated.status, "待安全评审");
    assert.equal(updated.revision, 2);
    assert.throws(
      () => updateFactoryTask(workersDir, task.id, {
        status: "完成",
        expectedRevision: task.revision,
        updatedBy: "用户",
      }),
      (error) => error instanceof FactoryTaskConflictError && error.currentRevision === 2,
    );
  });
});

test("factory task board filters global tasks and derives only statuses currently in the result", () => {
  withWorkersDir((workersDir) => {
    createFactoryTask(workersDir, { title: "Talk 设计", project: "talk", status: "设计中", assignee: "阿哲" });
    createFactoryTask(workersDir, { title: "Talk 验收", project: "talk", status: "待验收", assignee: "八村", labels: ["web"] });
    createFactoryTask(workersDir, { title: "Factory 完成", project: "factory", status: "完成", assignee: "阿哲" });

    const talk = listFactoryTasks(workersDir, { project: "talk", assignee: "阿哲" });
    assert.deepEqual(talk.map((task) => task.title), ["Talk 设计"]);
    assert.deepEqual(listFactoryTaskStatuses(workersDir, { project: "talk" }), ["设计中", "待验收"]);
    assert.deepEqual(listFactoryTaskStatuses(workersDir), ["设计中", "待验收", "完成"]);
    assert.equal(listFactoryTasks(workersDir, { query: "验收", labels: ["web"] }).length, 1);
  });
});

test("factory task board splits independently assignable children and archives separately", () => {
  withWorkersDir((workersDir) => {
    const parent = createFactoryTask(workersDir, { title: "交付任务看板", project: "talk", status: "进行中" });
    const children = splitFactoryTask(workersDir, parent.id, {
      actor: "阿哲",
      children: [
        { title: "实现后端", assignee: "阿哲", status: "进行中" },
        { title: "验收页面", assignee: "八村", status: "TODO" },
      ],
    });

    assert.equal(children.length, 2);
    assert.ok(children.every((child) => child.parentTaskId === parent.id));
    assert.deepEqual(getFactoryTask(workersDir, parent.id).childTaskIds, children.map((child) => child.id));

    const archived = archiveFactoryTask(workersDir, children[1].id, { actor: "用户" });
    assert.ok(archived.archivedAt);
    assert.equal(listFactoryTasks(workersDir).length, 2);
    assert.equal(listFactoryTasks(workersDir, { includeArchived: true }).length, 3);
    assert.equal(restoreFactoryTask(workersDir, children[1].id, { actor: "用户" }).archivedAt, null);
  });
});

test("factory task board tracks scheduled and idempotent execution evidence without changing display status", () => {
  withWorkersDir((workersDir) => {
    const now = new Date("2026-08-27T10:00:00.000Z");
    const task = createFactoryTask(workersDir, {
      title: "十点执行",
      status: "待验收",
      assignee: "阿哲",
      triggerAt: "2026-08-27T09:59:00.000Z",
      mode: "auto",
    });
    assert.equal(task.execution.state, "scheduled");
    assert.deepEqual(listDueFactoryTasks(workersDir, { now }).map((item) => item.id), [task.id]);

    const dispatching = beginFactoryTaskDispatch(workersDir, task.id, {
      actor: "web-scheduler",
      now,
      leaseMs: 30_000,
    });
    assert.equal(dispatching.execution.state, "dispatching");
    assert.match(dispatching.execution.executionKey, /^fexec_/);

    const linked = linkFactoryTaskRequest(workersDir, task.id, {
      executionKey: dispatching.execution.executionKey,
      requestId: "wtask-1",
      actor: "web-scheduler",
    });
    assert.equal(linked.execution.state, "queued");
    assert.equal(linked.execution.taskRequestId, "wtask-1");

    const running = markFactoryTaskRunning(workersDir, task.id, {
      executionKey: dispatching.execution.executionKey,
      requestId: "wtask-1",
      jobId: "job-1",
      actor: "pi",
    });
    assert.equal(running.execution.state, "running");

    const done = settleFactoryTaskExecution(workersDir, task.id, {
      executionKey: dispatching.execution.executionKey,
      state: "succeeded",
      jobId: "job-1",
      summary: "已完成并通过单测",
      actor: "pi",
    });
    assert.equal(done.execution.state, "succeeded");
    assert.equal(done.execution.resultSummary, "已完成并通过单测");
    assert.equal(done.status, "待验收");
    assert.deepEqual(listDueFactoryTasks(workersDir, { now }), []);
  });
});

test("factory task board recovers only expired dispatch leases", () => {
  withWorkersDir((workersDir) => {
    const task = createFactoryTask(workersDir, { title: "恢复派活", assignee: "阿哲" });
    beginFactoryTaskDispatch(workersDir, task.id, {
      actor: "web-scheduler",
      now: new Date("2026-08-27T10:00:00.000Z"),
      leaseMs: 30_000,
      executionKey: "fexec-fixed",
    });

    assert.equal(listDueFactoryTasks(workersDir, { now: new Date("2026-08-27T10:00:10.000Z") }).length, 0);
    const recovered = listDueFactoryTasks(workersDir, { now: new Date("2026-08-27T10:00:31.000Z") });
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].execution.executionKey, "fexec-fixed");
  });
});

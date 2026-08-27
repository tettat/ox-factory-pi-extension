import {
  beginFactoryTaskDispatch,
  linkFactoryTaskRequest,
  listDueFactoryTasks,
} from "./task-board.mjs";
import {
  createWorkerTaskRequest,
  findWorkerTaskRequestByExecutionKey,
} from "./task-requests.mjs";

function clean(value) {
  return String(value ?? "").trim();
}

export function factoryTaskAssignmentText(task) {
  return [
    `任务标题：${task.title}`,
    task.description ? `\n任务说明：\n${task.description}` : "",
    task.context ? `\n任务上下文：\n${task.context}` : "",
    task.parentTaskId ? `\n父任务：${task.parentTaskId}` : "",
    task.labels?.length ? `\n标签：${task.labels.join("、")}` : "",
    "",
    `请在执行过程中通过牛马工厂任务工具更新任务 ${task.id} 的人类可见状态、上下文和证据。执行完成不代表必须直接改成“完成”；请根据实际业务阶段选择状态，例如“待验收”。`,
  ].filter(Boolean).join("\n");
}

function linkExistingOrNewRequest(workersDir, task, dispatching, options) {
  const executionKey = dispatching.execution.executionKey;
  const existing = findWorkerTaskRequestByExecutionKey(workersDir, executionKey);
  const request = existing || createWorkerTaskRequest(workersDir, {
    from: clean(options.from || task.creator || "用户") || "用户",
    to: task.assignee,
    task: factoryTaskAssignmentText(task),
    project: task.project || "factory-task",
    cwd: clean(options.cwd),
    mode: options.mode || task.mode || "auto",
    source: options.source || "factory-task-board",
    factoryTaskId: task.id,
    executionKey,
  });
  const linked = linkFactoryTaskRequest(workersDir, task.id, {
    executionKey,
    requestId: request.id,
    actor: options.actor || "factory-task-dispatcher",
    now: options.now,
  });
  return { task: linked, request, reusedRequest: Boolean(existing) };
}

export function dispatchFactoryTask(workersDir, taskId, options = {}) {
  const dispatching = beginFactoryTaskDispatch(workersDir, taskId, {
    actor: options.actor || "factory-task-dispatcher",
    now: options.now,
    leaseMs: options.leaseMs,
    executionKey: options.executionKey,
    expectedRevision: options.expectedRevision,
    force: options.force === true,
  });
  return linkExistingOrNewRequest(workersDir, dispatching, dispatching, options);
}

export function dispatchDueFactoryTasks(workersDir, options = {}) {
  const due = listDueFactoryTasks(workersDir, {
    now: options.now,
    limit: options.limit || 10,
  });
  const dispatched = [];
  const errors = [];
  for (const task of due) {
    try {
      dispatched.push(dispatchFactoryTask(workersDir, task.id, {
        ...options,
        force: false,
        expectedRevision: task.revision,
      }));
    } catch (error) {
      errors.push({ taskId: task.id, error: error?.message || String(error) });
    }
  }
  return { checked: due.length, dispatched, errors };
}

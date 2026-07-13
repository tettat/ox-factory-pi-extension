import {
  appendJobEvent,
  appendJobEventIfOpen,
  createJob,
  isTerminalJob,
  readJob,
  updateJob,
} from "./jobs.mjs";
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendOutsourceRunEvent,
  completeOutsourceRun,
  createOutsourceRun,
  failOutsourceRun,
  formatOutsourceRuns,
  getOutsourceProfile,
  getOutsourceRun,
  markOutsourceRunRunning,
} from "./outsource-agents.mjs";
import { runOutsourceAgentStreaming } from "./outsource-runner.mjs";

export function normalizeOutsourceWait(params = {}, profile = {}) {
  if (params?.wait !== undefined) return Boolean(params.wait);
  if (params?.background !== undefined) return !Boolean(params.background);
  return profile?.defaultWait !== false;
}

function outsourceSummaryLine(run = {}) {
  const icon = run.status === "done" ? "✅" : run.status === "failed" ? "❌" : run.status === "cancelled" ? "⏹️" : "🔄";
  const profile = run.profileName || run.profile || "-";
  const job = run.jobId ? ` job=\`${run.jobId}\`` : "";
  const error = run.error ? `\nerror: ${String(run.error).slice(0, 500)}` : "";
  const summary = run.summary ? `\n\n${String(run.summary).slice(0, 1500)}` : "";
  return `${icon} ${run.status || "unknown"} | run=\`${run.id}\` | profile=${profile}${job}${error}${summary}`;
}

export function renderOutsourceWaitResult(waited = {}) {
  const runs = waited?.runs || [];
  if (waited?.status === "timeout") {
    return [`⏳ 等待外包 run 超时。`, "", formatOutsourceRuns(runs)].join("\n");
  }
  return [
    `## 外包执行完成 (${waited?.mode || "all"})`,
    "",
    ...runs.map(outsourceSummaryLine),
  ].join("\n\n");
}

export function renderOutsourceResult(run, verbose = false) {
  if (!run) return "❌ 未找到外包 run";
  const profile = run.profileName || run.profile || "-";
  const usage = run.totalTokens == null ? "" : `\n- tokens: ↑${run.inputTokens || 0} ↓${run.outputTokens || 0} total=${run.totalTokens || 0}`;
  const full = verbose && run.fullOutput ? `\n\n## 完整输出\n\n${run.fullOutput}` : "";
  return [
    `## 外包 Run ${run.id}`,
    "",
    `- status: ${run.status}`,
    `- profile: ${profile}`,
    `- group: ${run.groupId || "-"}`,
    run.jobId ? `- job: ${run.jobId}` : null,
    `- requestedBy: ${run.requestedBy || "用户"}`,
    `- project: ${run.project || "outsource"}`,
    usage || null,
    run.error ? `- error: ${run.error}` : null,
    "",
    "## 摘要",
    "",
    run.summary || run.fullOutput || "(暂无输出)",
    full,
  ].filter(Boolean).join("\n");
}

function createOutsourceRunJob(input = {}) {
  const workersDir = String(input.workersDir || "").trim();
  if (!workersDir) throw new Error("workersDir 不能为空");
  const profile = input.profile;
  const task = String(input.task || "").trim();
  const project = String(input.project || "outsource").trim() || "outsource";
  const cwd = input.cwd || process.cwd();
  if (!profile?.name) throw new Error("外包 profile 不能为空");
  if (!task) throw new Error("外包 task 不能为空");

  const job = createJob(workersDir, {
    kind: "outsource-run",
    worker: `外包:${profile.name}`,
    project,
    task,
    cwd,
    sessionFile: "",
  });
  const run = createOutsourceRun(workersDir, {
    profileName: profile.name,
    profileSnapshot: profile,
    task,
    project,
    cwd,
    requestedBy: input.requestedBy || "用户",
    groupId: input.groupId,
    wait: input.wait,
    background: input.background,
    jobId: job.id,
  });

  return { workersDir, profile, task, project, cwd, job, run };
}

function outsourceWorkerScriptPath() {
  return join(dirname(fileURLToPath(import.meta.url)), "outsource-worker.mjs");
}

export function spawnDetachedOutsourceRunProcess({ workersDir, run, job, execPath = process.execPath } = {}) {
  if (!workersDir) throw new Error("workersDir 不能为空");
  if (!run?.id) throw new Error("outsource run 不能为空");
  if (!job?.id) throw new Error("outsource job 不能为空");
  const logDir = join(workersDir, "logs", "outsource");
  mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, `${run.id}.log`);
  const errorLogFile = join(logDir, `${run.id}.err.log`);
  const outFd = openSync(logFile, "a");
  const errFd = openSync(errorLogFile, "a");
  let child;
  try {
    child = spawn(execPath, [
      outsourceWorkerScriptPath(),
      "--workers-dir",
      workersDir,
      "--run-id",
      run.id,
    ], {
      cwd: run.cwd || job.cwd || process.cwd(),
      detached: true,
      stdio: ["ignore", outFd, errFd],
      env: { ...process.env },
    });
    child.unref();
    return { pid: child.pid, logFile, errorLogFile };
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }
}

function markDetachedRunDispatched(workersDir, run, job, spawned = {}) {
  const startedAt = new Date().toISOString();
  const updatedJob = updateJob(job, {
    status: "running",
    startedAt: job.startedAt || startedAt,
    ownerPid: spawned.pid || null,
    ownerInstanceId: spawned.pid ? `outsource-worker-${spawned.pid}` : "outsource-worker",
    heartbeatAt: startedAt,
    detached: true,
    logFile: spawned.logFile || "",
    errorLogFile: spawned.errorLogFile || "",
  });
  appendJobEvent(updatedJob, {
    type: "dispatched",
    message: "anonymous outsource run detached into a dedicated worker process",
    pid: spawned.pid || null,
    logFile: spawned.logFile || "",
    errorLogFile: spawned.errorLogFile || "",
  });
  markOutsourceRunRunning(workersDir, {
    runId: run.id,
    jobId: job.id,
    pid: spawned.pid || null,
    owner: spawned.pid ? `outsource-worker:${spawned.pid}` : "outsource-worker",
    startedAt,
  });
  return updatedJob;
}

export function startOutsourceRunJob(input = {}) {
  const { workersDir, job, run } = createOutsourceRunJob(input);

  if (input.detached) {
    const spawnDetached = input.spawnDetached || spawnDetachedOutsourceRunProcess;
    let spawned;
    try {
      spawned = spawnDetached({ workersDir, run, job });
      const updatedJob = markDetachedRunDispatched(workersDir, run, job, spawned);
      return {
        run: getOutsourceRun(workersDir, run.id) || run,
        job: updatedJob,
        child: spawned,
        promise: Promise.resolve({ detached: true, pid: spawned?.pid || null, exitCode: 0 }),
      };
    } catch (error) {
      const message = error?.message || String(error);
      const failedJob = updateJob(job, {
        status: "failed",
        finishedAt: new Date().toISOString(),
        exitCode: 1,
        error: message,
      });
      appendJobEvent(failedJob, { type: "error", message });
      failOutsourceRun(workersDir, { runId: run.id, error: message });
      throw error;
    }
  }

  const controller = new AbortController();
  const promise = runExistingOutsourceRunJob({
    workersDir,
    runId: run.id,
    signal: controller.signal,
    runner: input.runner,
  });

  if (input.signal) {
    const abort = () => controller.abort();
    if (input.signal.aborted) abort();
    else input.signal.addEventListener("abort", abort, { once: true });
  }

  return { run: getOutsourceRun(workersDir, run.id) || run, job: readJob(job), controller, promise };
}

export async function runExistingOutsourceRunJob(input = {}) {
  const workersDir = String(input.workersDir || "").trim();
  if (!workersDir) throw new Error("workersDir 不能为空");
  const run = getOutsourceRun(workersDir, input.runId);
  if (!run) throw new Error(`未找到外包 run: ${input.runId || "(empty)"}`);
  const jobId = input.jobId || run.jobId;
  if (!jobId) throw new Error(`外包 run ${run.id} 缺少 linked job`);
  const jobFile = join(workersDir, "jobs", `${jobId}.json`);
  const job = readJob(jobFile);
  if (isTerminalJob(job)) {
    return {
      exitCode: job.status === "done" ? 0 : 1,
      output: job.fullOutput || job.summary || "",
      stderr: job.error || "",
      turns: job.turns || 0,
      inputTokens: job.inputTokens || 0,
      cachedInputTokens: job.cachedInputTokens || 0,
      outputTokens: job.outputTokens || 0,
      reasoningOutputTokens: job.reasoningOutputTokens || 0,
      totalTokens: job.totalTokens || 0,
      model: job.model || "",
      stopReason: job.stopReason || job.status,
      errorMessage: job.error || "",
    };
  }

  const profile = run.profileSnapshot || getOutsourceProfile(workersDir, run.profileName || run.profile);
  const task = run.task || job.task || "";
  const cwd = run.cwd || job.cwd || process.cwd();
  const runner = input.runner || runOutsourceAgentStreaming;
  const controller = new AbortController();
  if (input.signal) {
    const abort = () => controller.abort();
    if (input.signal.aborted) abort();
    else input.signal.addEventListener("abort", abort, { once: true });
  }

  const startedAt = new Date().toISOString();
  updateJob(job, {
    status: "running",
    startedAt: job.startedAt || startedAt,
    ownerPid: process.pid,
    ownerInstanceId: `outsource-${process.pid}`,
    heartbeatAt: startedAt,
  });
  appendJobEvent(job, {
    type: "started",
    text: task,
    message: "anonymous outsource run started; no worker memory/session is used",
  });
  markOutsourceRunRunning(workersDir, {
    runId: run.id,
    jobId: job.id,
    pid: process.pid,
    owner: `pi:${process.pid}`,
    startedAt,
  });

  let lastHeartbeatMs = Date.now();
  const heartbeat = () => {
    const now = Date.now();
    if (now - lastHeartbeatMs < 1000) return;
    lastHeartbeatMs = now;
    try {
      updateJob(job, { heartbeatAt: new Date().toISOString(), ownerPid: process.pid });
    } catch {}
  };

  const startedMs = Date.now();
  const finishIfOpen = (patch, event) => {
    const current = readJob(job);
    if (isTerminalJob(current)) return current;
    const updated = updateJob(current, patch);
    appendJobEvent(updated, event);
    return updated;
  };

  return await runner(
    { profile, task, cwd, workersDir, signal: controller.signal },
    (event = {}) => {
      heartbeat();
      appendJobEventIfOpen(job, event);
      appendOutsourceRunEvent(workersDir, {
        type: "stream",
        runId: run.id,
        streamType: event.type,
        text: event.text || event.message || "",
        name: event.name || "",
        isError: Boolean(event.isError),
      });
    },
  ).then((result = {}) => {
    const elapsedSeconds = Math.max(0, Math.round((Date.now() - startedMs) / 1000));
    const failed = result.exitCode !== 0 || ["error", "aborted"].includes(result.stopReason ?? "");
    const patch = {
      status: failed ? "failed" : "done",
      finishedAt: new Date().toISOString(),
      elapsedSeconds,
      exitCode: result.exitCode ?? 0,
      stopReason: result.stopReason,
      turns: result.turns,
      inputTokens: result.inputTokens,
      cachedInputTokens: result.cachedInputTokens,
      outputTokens: result.outputTokens,
      reasoningOutputTokens: result.reasoningOutputTokens,
      totalTokens: result.totalTokens,
      model: result.model,
      codexThreadId: result.codexThreadId,
      codexTurnId: result.codexTurnId,
      summary: result.output ? String(result.output).slice(0, 1000) : "",
      fullOutput: result.output || "",
    };
    if (failed) patch.error = result.errorMessage || result.stderr || `outsource agent exited with code ${result.exitCode}`;
    finishIfOpen(patch, { type: patch.status, text: patch.error || patch.summary || "" });
    completeOutsourceRun(workersDir, {
      runId: run.id,
      status: failed ? "failed" : "done",
      summary: patch.summary || patch.error || "",
      fullOutput: result.output || "",
      usage: result,
      error: patch.error || "",
      model: result.model || "",
    });
    return result;
  }).catch((error) => {
    const elapsedSeconds = Math.max(0, Math.round((Date.now() - startedMs) / 1000));
    const message = error?.message || String(error);
    finishIfOpen({
      status: "failed",
      finishedAt: new Date().toISOString(),
      elapsedSeconds,
      exitCode: 1,
      error: message,
    }, { type: "error", message });
    failOutsourceRun(workersDir, { runId: run.id, error: message });
    return {
      exitCode: 1,
      output: "",
      stderr: message,
      turns: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
      stopReason: "error",
      errorMessage: message,
    };
  });
}

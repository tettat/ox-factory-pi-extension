/**
 * 牛马工厂 — Worker 进程管理
 *
 * 负责 spawn pi 子进程、git worktree 管理、结果收集。
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { WorkerRole, Worker } from "./types.ts";
import { getAgentDef, getWorkersDir, recordProject, updateWorkerConfig } from "./registry.ts";
import {
  appendJobEvent,
  appendJobEventIfOpen,
  DEFAULT_JOB_HEARTBEAT_INTERVAL_MS,
  isTerminalJob,
  readJob,
  recordJobHeartbeat,
  updateJob,
} from "./jobs.mjs";
import { runCodexWorkerStreaming, steerCodexWorker } from "./codex-backend.mjs";
import { buildFactoryWorkerHandbook } from "./factory-handbook.mjs";
import { scoreUserEmotion } from "./quality-metrics.mjs";

const OWNER_INSTANCE_ID = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// ─── pi 调用方式 ───────────────────────────────────────

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");

  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }

  return { command: "pi", args };
}

// ─── Worktree ───────────────────────────────────────────

export function getWorktreePath(projectName: string, workerId: string): string {
  return path.join(getWorkersDir(), "worktrees", projectName, workerId);
}

export async function createWorktree(projectName: string, workerId: string, baseBranch?: string): Promise<string> {
  const wtPath = getWorktreePath(projectName, workerId);

  // 清理旧 worktree
  if (fs.existsSync(wtPath)) {
    await new Promise<void>((resolve) => {
      const proc = spawn("git", ["worktree", "remove", "--force", wtPath], {
        cwd: process.cwd(),
        stdio: "ignore",
      });
      proc.on("close", () => resolve());
      setTimeout(() => resolve(), 5000);
    });
  }

  fs.mkdirSync(path.dirname(wtPath), { recursive: true });

  const branchName = `ox/${projectName}/${workerId}-${Date.now().toString(36)}`;
  const args = ["worktree", "add", "-b", branchName, wtPath];
  if (baseBranch) {
    args.push(baseBranch);
  }

  return new Promise((resolve, reject) => {
    const proc = spawn("git", args, { cwd: process.cwd(), stdio: "pipe" });
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => {
      if (code === 0) resolve(wtPath);
      else reject(new Error(`git worktree add failed: ${stderr}`));
    });
  });
}

export async function cleanupWorktree(projectName: string, workerId: string) {
  const wtPath = getWorktreePath(projectName, workerId);
  if (!fs.existsSync(wtPath)) return;

  return new Promise<void>((resolve) => {
    const proc = spawn("git", ["worktree", "remove", "--force", wtPath], {
      cwd: process.cwd(),
      stdio: "ignore",
    });
    proc.on("close", () => {
      // 清理父目录
      try { fs.rmdirSync(path.dirname(wtPath)); } catch {}
      resolve();
    });
  });
}

// ─── Spawn Worker ───────────────────────────────────────

export interface SpawnResult {
  exitCode: number;
  output: string;
  stderr: string;
  turns: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  stopReason?: string;
  errorMessage?: string;
  model?: string;
}

export interface SpawnOptions {
  worker: Worker;
  task: string;
  project: string;
  cwd?: string;
  additionalContext?: string;
  signal?: AbortSignal;
  onProgress?: (text: string) => void;
  deliveryMode?: "message" | "queue" | "steer";
}

function usageNumber(...values: unknown[]): number {
  for (const value of values) {
    if (value == null) continue;
    const numberValue = Number(value);
    if (Number.isFinite(numberValue)) return numberValue;
  }
  return 0;
}

function addUsageToResult(result: SpawnResult, usage: any) {
  if (!usage) return;
  const inputTokens = usageNumber(usage.inputTokens, usage.input_tokens, usage.input, usage.promptTokens, usage.prompt_tokens, usage.prompt);
  const cachedInputTokens =
    usageNumber(usage.cachedInputTokens, usage.cached_input_tokens, usage.cachedInput, usage.cached_input, usage.cached) +
    usageNumber(usage.cacheRead, usage.cache_read, usage.cache_read_tokens) +
    usageNumber(usage.cacheWrite, usage.cache_write, usage.cache_write_tokens, usage.cacheWrite1h, usage.cache_write_1h, usage.cacheWrite5m, usage.cache_write_5m);
  const outputTokens = usageNumber(usage.outputTokens, usage.output_tokens, usage.output, usage.completionTokens, usage.completion_tokens, usage.completion);
  const reasoningOutputTokens = usageNumber(usage.reasoningOutputTokens, usage.reasoning_output_tokens, usage.reasoningOutput, usage.reasoning_output);
  const totalTokens = inputTokens + outputTokens || usageNumber(usage.totalTokens, usage.total_tokens, usage.total);
  result.inputTokens += inputTokens;
  result.cachedInputTokens += cachedInputTokens;
  result.outputTokens += outputTokens;
  result.reasoningOutputTokens += reasoningOutputTokens;
  result.totalTokens += totalTokens;
}

function communicationInstructions(worker: Worker): string {
  return buildFactoryWorkerHandbook(worker, {
    workersDir: getWorkersDir(),
    backend: worker.backend ?? "pi",
  });
}

export async function spawnWorker(options: SpawnOptions): Promise<SpawnResult> {
  const { worker, task, project, cwd, additionalContext, signal, onProgress } = options;

  if ((worker.backend ?? "pi") === "codex") {
    return spawnWorkerStreaming(options, (event) => {
      if (event.type === "text") onProgress?.(event.text.slice(0, 100));
    });
  }

  const args: string[] = ["--mode", "json", "-p", "--session", worker.sessionFile, "--name", `${worker.role}-${worker.id}`];

  if (worker.model) {
    args.push("--model", worker.model);
  }
  if (worker.thinking) {
    args.push("--thinking", worker.thinking);
  }

  // 写入 agent 定义作为临时文件
  const agentDef = getAgentDef(worker.role);
  let tmpDir: string | null = null;
  let tmpFilePath: string | null = null;

  if (agentDef.trim()) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ox-factory-"));
    tmpFilePath = path.join(tmpDir, `agent-${worker.id}.md`);
    fs.writeFileSync(tmpFilePath, agentDef, "utf-8");
    args.push("--append-system-prompt", tmpFilePath);
  }

  // 任务内容
  let taskContent = `你的名字叫 **${worker.id}**，职位是 ${worker.role}。\n\n## 项目: ${project}\n\n## 任务\n${task}`;
  if (additionalContext) {
    taskContent += `\n\n## 附加上下文\n${additionalContext}`;
  }
  taskContent += `\n\n${communicationInstructions(worker)}`;
  taskContent += `\n\n请开始工作。完成后按你的角色格式输出汇报。`;
  args.push(taskContent);

  const workCwd = cwd ?? process.cwd();

  const result: SpawnResult = {
    exitCode: 0,
    output: "",
    stderr: "",
    turns: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  };

  // 收集流式文本
  let collectedText = "";

  try {
    result.exitCode = await new Promise<number>((resolve) => {
      const invocation = getPiInvocation(args);
      const proc = spawn(invocation.command, invocation.args, {
        cwd: workCwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });

      let buffer = "";

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: any;
        try { event = JSON.parse(line); } catch { return; }

        if (event.type === "message_end" && event.message) {
          const msg = event.message as any;
          if (msg.role === "assistant") {
            result.turns++;
            addUsageToResult(result, msg.usage);
            if (msg.model) result.model = msg.model;
            if (msg.stopReason) result.stopReason = msg.stopReason;
            if (msg.errorMessage) result.errorMessage = msg.errorMessage;

            // 从 message.content 提取文本
            if (msg.content && Array.isArray(msg.content)) {
              for (const part of msg.content) {
                if (part.type === "text") {
                  collectedText = part.text;
                }
              }
            }
          }
        }

        // 收集流式文本增量
        if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
          const delta = event.assistantMessageEvent.delta;
          collectedText += delta;
          onProgress?.(delta.slice(0, 100));
        }
      };

      proc.stdout.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });

      proc.stderr.on("data", (data) => {
        result.stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (buffer.trim()) processLine(buffer);
        resolve(code ?? 0);
      });

      proc.on("error", () => resolve(1));

      if (signal) {
        const killProc = () => {
          proc.kill("SIGTERM");
          setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000);
        };
        if (signal.aborted) killProc();
        else signal.addEventListener("abort", killProc, { once: true });
      }
    });

    result.output = collectedText || "(无文本输出)";
    return result;
  } finally {
    if (tmpFilePath) try { fs.unlinkSync(tmpFilePath); } catch {}
    if (tmpDir) try { fs.rmdirSync(tmpDir); } catch {}
  }
}

// ─── 流式 Spawn（factory_talk 用）──────────────────────

export type StreamEvent =
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | { type: "tool_start"; name: string; args: unknown }
  | { type: "tool_output"; name: string; text: string }
  | { type: "tool_end"; name: string; result?: unknown; isError?: boolean }
  | { type: "done"; turns: number; inputTokens: number; cachedInputTokens?: number; outputTokens: number; reasoningOutputTokens?: number; totalTokens?: number; model?: string; exitCode?: number; stopReason?: string; text?: string }
  | { type: "error"; message: string };

export async function spawnWorkerStreaming(
  options: SpawnOptions,
  onEvent: (event: StreamEvent) => void,
): Promise<SpawnResult> {
  const { worker, task, project, cwd, additionalContext, signal } = options;

  if ((worker.backend ?? "pi") === "codex") {
    return runCodexWorkerStreaming(
      {
        worker,
        task,
        project,
        cwd,
        additionalContext,
        signal,
        agentDef: getAgentDef(worker.role),
        workersDir: getWorkersDir(),
        onWorkerPatch: (patch: Partial<Worker>) => updateWorkerConfig(worker.id, patch),
      },
      onEvent,
    ) as Promise<SpawnResult>;
  }

  const args: string[] = ["--mode", "json", "-p", "--session", worker.sessionFile, "--name", `${worker.role}-${worker.id}`];

  if (worker.model) args.push("--model", worker.model);
  if (worker.thinking) args.push("--thinking", worker.thinking);

  const agentDef = getAgentDef(worker.role);
  let tmpDir: string | null = null;
  let tmpFilePath: string | null = null;

  if (agentDef.trim()) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ox-factory-talk-"));
    tmpFilePath = path.join(tmpDir, `agent-${worker.id}.md`);
    fs.writeFileSync(tmpFilePath, agentDef, "utf-8");
    args.push("--append-system-prompt", tmpFilePath);
  }

  let taskContent = `你的名字叫 **${worker.id}**，职位是 ${worker.role}。\n\n`;
  if (project) taskContent += `## 项目: ${project}\n\n`;
  taskContent += `## 任务\n${task}`;
  if (additionalContext) taskContent += `\n\n## 附加上下文\n${additionalContext}`;
  taskContent += `\n\n${communicationInstructions(worker)}`;
  args.push(taskContent);

  const workCwd = cwd ?? process.cwd();

  const result: SpawnResult = { exitCode: 0, output: "", stderr: "", turns: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 };
  let collectedText = "";
  let thinkingBuffer = "";
  let emittedError = false;
  const emitError = (message: string) => {
    if (emittedError) return;
    emittedError = true;
    onEvent({ type: "error", message });
  };

  try {
    result.exitCode = await new Promise<number>((resolve) => {
      const invocation = getPiInvocation(args);
      const proc = spawn(invocation.command, invocation.args, {
        cwd: workCwd, shell: false, stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });

      let buffer = "";

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: any;
        try { event = JSON.parse(line); } catch { return; }

        // thinking delta
        if (event.type === "message_update" && event.assistantMessageEvent?.type === "thinking_delta") {
          thinkingBuffer += event.assistantMessageEvent.delta;
          onEvent({ type: "thinking", text: event.assistantMessageEvent.delta });
        }

        // text delta
        if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
          const delta = event.assistantMessageEvent.delta || "";
          collectedText += delta;
          onEvent({ type: "text", text: delta });
        }

        // tool call start
        if (event.type === "tool_execution_start") {
          onEvent({ type: "tool_start", name: event.toolName, args: event.args ?? event.input ?? {} });
        }

        // tool call end
        if (event.type === "tool_execution_end") {
          onEvent({
            type: "tool_end",
            name: event.toolName,
            result: event.result ?? event.output ?? event.toolResult ?? event.content ?? event.message ?? event.error,
            isError: Boolean(event.isError || event.error || event.status === "error"),
          });
        }

        // message end - track usage
        if (event.type === "message_end" && event.message) {
          const msg = event.message as any;
          if (msg.role === "assistant") {
            result.turns++;
            addUsageToResult(result, msg.usage);
            if (msg.model) result.model = msg.model;
            if (msg.stopReason) result.stopReason = msg.stopReason;
            if (msg.errorMessage) result.errorMessage = msg.errorMessage;
            if (["error", "aborted"].includes(msg.stopReason ?? "")) {
              emitError(msg.errorMessage || msg.stopReason || "worker stopped with an error");
            }
            // 提取完整文本输出
            if (msg.content && Array.isArray(msg.content)) {
              for (const part of msg.content) {
                if (part.type === "text") {
                  result.output = part.text;
                }
              }
            }
          }
        }
      };

      proc.stdout.on("data", (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });

      proc.stderr.on("data", (data: Buffer) => { result.stderr += data.toString(); });
      proc.on("close", (code) => { if (buffer.trim()) processLine(buffer); resolve(code ?? 0); });
      proc.on("error", (error) => {
        result.stderr += error?.message || String(error);
        resolve(1);
      });

      if (signal) {
        const kill = () => { proc.kill("SIGTERM"); setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000); };
        if (signal.aborted) kill();
        else signal.addEventListener("abort", kill, { once: true });
      }
    });

    const failed = result.exitCode !== 0 || ["error", "aborted"].includes(result.stopReason ?? "");
    if (!result.output && collectedText) result.output = collectedText;
    if (failed) {
      emitError(result.errorMessage || result.stderr || `worker exited with code ${result.exitCode}`);
    }
    onEvent({
      type: "done",
      turns: result.turns,
      inputTokens: result.inputTokens,
      cachedInputTokens: result.cachedInputTokens,
      outputTokens: result.outputTokens,
      reasoningOutputTokens: result.reasoningOutputTokens,
      totalTokens: result.totalTokens,
      model: result.model,
      exitCode: result.exitCode,
      stopReason: result.stopReason,
      text: result.output,
    });
    return result;
  } finally {
    if (tmpFilePath) try { fs.unlinkSync(tmpFilePath); } catch {}
    if (tmpDir) try { fs.rmdirSync(tmpDir); } catch {}
  }
}

export function startWorkerJob(
  options: SpawnOptions,
  job: any,
  onEvent?: (event: StreamEvent) => void,
): { job: any; promise: Promise<SpawnResult> } {
  const startedAt = new Date().toISOString();
  const heartbeatIntervalMs = DEFAULT_JOB_HEARTBEAT_INTERVAL_MS;
  updateJob(job, {
    status: "running",
    startedAt,
    ownerPid: process.pid,
    ownerInstanceId: OWNER_INSTANCE_ID,
    ownerStartedAt: startedAt,
    heartbeatAt: startedAt,
    heartbeatIntervalMs,
  });
  appendJobEvent(job, {
    type: "started",
    text: options.task,
    ownerPid: process.pid,
    ownerInstanceId: OWNER_INSTANCE_ID,
  });

  let lastHeartbeatMs = Date.now();
  const heartbeat = (force = false) => {
    const now = Date.now();
    if (!force && now - lastHeartbeatMs < Math.max(1000, heartbeatIntervalMs / 2)) return;
    lastHeartbeatMs = now;
    recordJobHeartbeat(job, {
      ownerPid: process.pid,
      ownerInstanceId: OWNER_INSTANCE_ID,
      ownerStartedAt: startedAt,
      heartbeatIntervalMs,
    });
  };
  const heartbeatTimer = setInterval(() => heartbeat(true), heartbeatIntervalMs);
  (heartbeatTimer as any).unref?.();

  const appendLiveEvent = (event: StreamEvent) => {
    heartbeat();
    appendJobEventIfOpen(job, event);
    onEvent?.(event);
  };

  const finishIfOpen = (patch: any, terminalEvent: any) => {
    const current = readJob(job);
    if (isTerminalJob(current)) {
      appendJobEvent(current, {
        type: "late_event_after_terminal",
        originalType: terminalEvent?.type || patch.status || "finish",
        terminalStatus: current.status,
        message: `late finish ignored because job is already ${current.status}`,
      });
      return current;
    }
    const updated = updateJob(current, patch);
    appendJobEvent(updated, terminalEvent);
    return updated;
  };

  const recordQualityEmotionAsync = (finishedJob: any, assistantText: string) => {
    const userText = options.task || "";
    if (!userText.trim()) return;
    void scoreUserEmotion({
      workersDir: getWorkersDir(),
      job: finishedJob,
      userText,
      assistantText,
    }).then((record: any) => {
      if (!record || record.status === "disabled") return;
      appendJobEvent(finishedJob, {
        type: record.status === "scored" ? "quality_emotion" : "quality_emotion_status",
        status: record.status,
        score: record.score ?? null,
        label: record.label || "",
        reason: record.reason || record.error || "",
        provider: record.provider || "",
        model: record.model || "",
        apiKeyEnv: record.apiKeyEnv || undefined,
      });
    }).catch((error: any) => {
      appendJobEvent(finishedJob, {
        type: "quality_emotion_error",
        message: error?.message || String(error),
      });
    });
  };

  const startedMs = Date.now();
  const run = options.deliveryMode === "steer" && (options.worker.backend ?? "pi") === "codex" && options.worker.codexActiveTurnId
    ? steerCodexWorker({ ...options, workersDir: getWorkersDir() }, (event: StreamEvent) => {
        appendLiveEvent(event);
      }) as Promise<SpawnResult>
    : spawnWorkerStreaming(options, (event) => {
        appendLiveEvent(event);
      });

  const promise = run.then((result) => {
    const elapsedSeconds = Math.max(0, Math.round((Date.now() - startedMs) / 1000));
    const failed = result.exitCode !== 0 || ["error", "aborted"].includes(result.stopReason ?? "");
    const patch: any = {
      status: failed ? "failed" : "done",
      finishedAt: new Date().toISOString(),
      elapsedSeconds,
      exitCode: result.exitCode,
      stopReason: result.stopReason,
      turns: result.turns,
      inputTokens: result.inputTokens,
      cachedInputTokens: result.cachedInputTokens,
      outputTokens: result.outputTokens,
      reasoningOutputTokens: result.reasoningOutputTokens,
      totalTokens: result.totalTokens,
      model: result.model,
      summary: result.output ? result.output.slice(0, 1000) : "",
      fullOutput: result.output || "",
    };
    if (failed) patch.error = result.errorMessage || result.stderr || `worker exited with code ${result.exitCode}`;
    const finishedJob = finishIfOpen(patch, { type: patch.status, text: patch.error || patch.summary || "" });
    recordQualityEmotionAsync(finishedJob, result.output || patch.error || "");
    return result;
  }).catch((error: any) => {
    const elapsedSeconds = Math.max(0, Math.round((Date.now() - startedMs) / 1000));
    const message = error?.message || String(error);
    const finishedJob = finishIfOpen({
      status: "failed",
      finishedAt: new Date().toISOString(),
      elapsedSeconds,
      exitCode: 1,
      error: message,
    }, { type: "error", message });
    recordQualityEmotionAsync(finishedJob, message);
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
  }).finally(() => {
    clearInterval(heartbeatTimer);
  });

  return { job, promise };
}

// ─── 并发执行 ───────────────────────────────────────────

export async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array(items.length);
  let nextIndex = 0;
  const workers = new Array(limit).fill(null).map(async () => {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await fn(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}

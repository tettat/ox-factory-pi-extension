import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  CodexAppServerClient,
  codexNotificationToStreamEvents,
  createCodexTokenUsageTracker,
  ensureCodexAppServer,
  extractCodexTokenUsage,
  getCodexServerUrl,
  normalizeCodexEffort,
  normalizeCodexModel,
} from "./codex-backend.mjs";
import { runClaudeWorkerStreaming } from "./claude-backend.mjs";

const DEFAULT_OUTSOURCE_SYSTEM_PROMPT = [
  "你是牛马工厂临时外包 agent。",
  "你没有长期身份、长期记忆、员工姓名或工厂社交关系，只执行当前任务。",
  "不要声称自己是某个牛马工厂员工；只根据任务、工作目录和显式可用工具工作。",
  "完成后请给出：完成情况、文件变更、验证结果、风险/后续建议。",
].join("\n");

export function getPiInvocation(args, options = {}) {
  const currentScript = options.currentScript ?? process.argv[1];
  const execPath = options.execPath ?? process.execPath;
  const exists = options.exists ?? existsSync;
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  const callerIsOutsource =
    typeof currentScript === "string" &&
    (currentScript.endsWith("outsource-cli.mjs") ||
      currentScript.endsWith("outsource-runner.mjs") ||
      currentScript.endsWith("outsource-worker.mjs"));

  // outsource-cli/outsource-runner 内部启动 Pi 子进程时，args 是给 Pi CLI 的。
  // 不能再用当前脚本递归启动自己，否则 `--mode json` 会被 outsource-cli 当成子命令解析。
  if (callerIsOutsource) return { command: "pi", args };

  if (currentScript && !isBunVirtualScript && exists(currentScript)) {
    return { command: execPath, args: [currentScript, ...args] };
  }

  const execName = basename(execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) return { command: execPath, args };
  return { command: "pi", args };
}

function numberValue(...values) {
  for (const value of values) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return 0;
}

function addUsage(result, usage = {}) {
  const inputTokens = numberValue(usage.inputTokens, usage.input_tokens, usage.input, usage.promptTokens, usage.prompt_tokens);
  const cachedInputTokens = numberValue(usage.cachedInputTokens, usage.cached_input_tokens, usage.cachedInput, usage.cached_input, usage.cached);
  const outputTokens = numberValue(usage.outputTokens, usage.output_tokens, usage.output, usage.completionTokens, usage.completion_tokens);
  const reasoningOutputTokens = numberValue(usage.reasoningOutputTokens, usage.reasoning_output_tokens, usage.reasoningOutput, usage.reasoning_output);
  const totalTokens = numberValue(usage.totalTokens, usage.total_tokens, usage.total) || inputTokens + outputTokens;
  result.inputTokens += inputTokens;
  result.cachedInputTokens += cachedInputTokens;
  result.outputTokens += outputTokens;
  result.reasoningOutputTokens += reasoningOutputTokens;
  result.totalTokens += totalTokens;
}

function hasNonZeroTokenUsage(usage) {
  return Boolean(
    (usage?.inputTokens || 0) ||
    (usage?.cachedInputTokens || 0) ||
    (usage?.outputTokens || 0) ||
    (usage?.reasoningOutputTokens || 0) ||
    (usage?.totalTokens || 0)
  );
}

function normalizeToolList(profile = {}) {
  if (Array.isArray(profile.tools)) return profile.tools.filter(Boolean).map(String);
  if (typeof profile.tools === "string") return profile.tools.split(",").map((item) => item.trim()).filter(Boolean);
  return [];
}

function normalizeSkills(profile = {}) {
  if (profile.skills == null) return false;
  if (typeof profile.skills === "boolean") return profile.skills;
  if (Array.isArray(profile.skills)) return profile.skills;
  const value = String(profile.skills).trim();
  if (!value || /^(false|none|off|0)$/i.test(value)) return false;
  if (/^(true|all|on|1)$/i.test(value)) return true;
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

export function buildOutsourcePiArgs({ profile = {}, task = "", systemPromptPath = "" } = {}) {
  const args = ["--mode", "json", "-p", "--no-session"];
  args.push("--name", `outsource-${profile.name || "agent"}`);
  if (profile.model) args.push("--model", String(profile.model));
  if (profile.thinking) args.push("--thinking", String(profile.thinking));
  const skills = normalizeSkills(profile);
  if (skills === false || (Array.isArray(skills) && skills.length === 0)) {
    args.push("--no-skills");
  } else if (Array.isArray(skills)) {
    args.push("--skills", skills.join(","));
  }
  const tools = normalizeToolList(profile);
  if (tools.length > 0) args.push("--tools", tools.join(","));
  if (systemPromptPath) args.push("--system-prompt", systemPromptPath);
  args.push(`Task: ${String(task || "").trim()}`);
  return { args };
}

function createSystemPromptFile(profile = {}) {
  const prompt = String(profile.systemPrompt || DEFAULT_OUTSOURCE_SYSTEM_PROMPT).trim();
  const tmpDir = mkdtempSync(join(tmpdir(), "ox-outsource-"));
  const file = join(tmpDir, `profile-${profile.name || "agent"}.md`);
  writeFileSync(file, `${prompt}\n`, "utf8");
  return { tmpDir, file };
}

function emptyResult(profile = {}) {
  return {
    exitCode: 0,
    output: "",
    stderr: "",
    turns: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    model: profile.model || "",
  };
}

export async function runOutsourcePiStreaming({ profile = {}, task = "", cwd, signal } = {}, onEvent = () => {}) {
  const { tmpDir, file } = createSystemPromptFile(profile);
  const { args } = buildOutsourcePiArgs({ profile, task, systemPromptPath: file });
  const result = emptyResult(profile);
  let collectedText = "";
  let emittedError = false;
  const emitError = (message) => {
    if (emittedError) return;
    emittedError = true;
    onEvent({ type: "error", message });
  };

  try {
    result.exitCode = await new Promise((resolve) => {
      const invocation = getPiInvocation(args);
      const proc = spawn(invocation.command, invocation.args, {
        cwd: cwd || process.cwd(),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });
      result.pid = proc.pid;
      let buffer = "";
      const processLine = (line) => {
        if (!line.trim()) return;
        let event;
        try { event = JSON.parse(line); } catch { return; }

        if (event.type === "message_update" && event.assistantMessageEvent?.type === "thinking_delta") {
          onEvent({ type: "thinking", text: event.assistantMessageEvent.delta || "" });
        }
        if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
          const delta = event.assistantMessageEvent.delta || "";
          collectedText += delta;
          onEvent({ type: "text", text: delta });
        }
        if (event.type === "tool_execution_start") {
          onEvent({ type: "tool_start", name: event.toolName || "tool", args: event.args ?? event.input ?? {} });
        }
        if (event.type === "tool_execution_output") {
          onEvent({ type: "tool_output", name: event.toolName || "tool", text: String(event.output ?? event.text ?? "") });
        }
        if (event.type === "tool_execution_end") {
          onEvent({
            type: "tool_end",
            name: event.toolName || "tool",
            result: event.result ?? event.output ?? event.toolResult ?? event.content ?? event.message ?? event.error,
            isError: Boolean(event.isError || event.error || event.status === "error"),
          });
        }
        if (event.type === "message_end" && event.message?.role === "assistant") {
          const msg = event.message;
          result.turns++;
          addUsage(result, msg.usage || {});
          if (msg.model) result.model = msg.model;
          if (msg.stopReason) result.stopReason = msg.stopReason;
          if (msg.errorMessage) result.errorMessage = msg.errorMessage;
          if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
              if (part.type === "text") result.output = part.text || result.output;
            }
          }
          if (["error", "aborted"].includes(msg.stopReason || "")) emitError(msg.errorMessage || msg.stopReason);
        }
      };
      proc.stdout.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });
      proc.stderr.on("data", (data) => { result.stderr += data.toString(); });
      proc.on("close", (code) => { if (buffer.trim()) processLine(buffer); resolve(code ?? 0); });
      proc.on("error", (error) => {
        result.stderr += error?.message || String(error);
        resolve(1);
      });
      if (signal) {
        const kill = () => {
          proc.kill("SIGTERM");
          setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000);
        };
        if (signal.aborted) kill();
        else signal.addEventListener("abort", kill, { once: true });
      }
    });
    if (!result.output && collectedText) result.output = collectedText;
    if (result.exitCode !== 0) {
      result.stopReason = result.stopReason || "error";
      result.errorMessage = result.errorMessage || result.stderr || `outsource agent exited with code ${result.exitCode}`;
      emitError(result.errorMessage);
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
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

export async function runOutsourceCodexStreaming({ profile = {}, task = "", cwd, workersDir, signal } = {}, onEvent = () => {}) {
  const worker = {
    id: `outsource-${profile.name || "agent"}`,
    role: "programmer",
    backend: "codex",
    model: normalizeCodexModel(profile.model),
    thinking: profile.thinking,
    codexServerUrl: profile.codexServerUrl,
    codexApprovalPolicy: profile.codexApprovalPolicy || "never",
    codexSandbox: profile.codexSandbox || "workspace-write",
  };
  const url = getCodexServerUrl(worker);
  const client = new CodexAppServerClient(url);
  const result = emptyResult(worker);
  const tokenUsageTracker = createCodexTokenUsageTracker();
  let threadId = "";
  let turnId = "";
  let resolveCompleted;
  const completedPromise = new Promise((resolve) => {
    resolveCompleted = resolve;
  });

  try {
    await ensureCodexAppServer(url, { workersDir: workersDir || process.cwd() });
    await client.connect();
    await client.initialize();
    const startThread = await client.request("thread/start", {
      cwd: cwd || process.cwd(),
      approvalPolicy: worker.codexApprovalPolicy,
      sandbox: worker.codexSandbox,
      model: worker.model || null,
      baseInstructions: String(profile.systemPrompt || DEFAULT_OUTSOURCE_SYSTEM_PROMPT),
      ephemeral: true,
    });
    threadId = startThread.thread.id;
    result.codexThreadId = threadId;
    onEvent({ type: "codex_thread", threadId, text: `Codex outsource thread: ${threadId}` });

    client.onNotification((message) => {
      const params = message.params || {};
      if (params.threadId && params.threadId !== threadId) return;
      if (message.method === "turn/started" && params.turn?.id) {
        turnId = params.turn.id;
        result.codexTurnId = turnId;
      }
      if (message.method === "thread/tokenUsage/updated") {
        tokenUsageTracker.remember(params, turnId);
      }
      for (const event of codexNotificationToStreamEvents(message)) {
        if (event.type === "text") result.output += event.text || "";
        onEvent(event);
      }
      if (message.method === "turn/completed" && params.turn) {
        if (turnId && params.turn.id !== turnId) return;
        resolveCompleted(params.turn);
      }
    });

    const start = await client.request("turn/start", {
      threadId,
      input: [{ type: "text", text: String(task || ""), text_elements: [] }],
      cwd: cwd || process.cwd(),
      model: worker.model || null,
      effort: normalizeCodexEffort(worker.thinking),
    });
    turnId = start.turn.id;
    result.codexTurnId = turnId;

    if (signal) {
      const interrupt = () => {
        client.request("turn/interrupt", { threadId, turnId }, 5000).catch(() => {});
      };
      if (signal.aborted) interrupt();
      else signal.addEventListener("abort", interrupt, { once: true });
    }

    const turn = await completedPromise;
    const directUsage = extractCodexTokenUsage(turn);
    const capturedUsage = tokenUsageTracker.get(turn.id || turnId);
    const usage = hasNonZeroTokenUsage(capturedUsage) ? capturedUsage : directUsage;
    Object.assign(result, {
      turns: 1,
      inputTokens: usage.inputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      outputTokens: usage.outputTokens,
      reasoningOutputTokens: usage.reasoningOutputTokens,
      totalTokens: usage.totalTokens || usage.inputTokens + usage.outputTokens,
    });
    if (turn.status !== "completed") {
      result.exitCode = 1;
      result.stopReason = turn.status;
      result.errorMessage = turn.error?.message || turn.status;
      result.stderr = result.errorMessage;
      onEvent({ type: "error", message: result.errorMessage });
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
      codexThreadId: result.codexThreadId,
      codexTurnId: result.codexTurnId,
    });
    return result;
  } catch (error) {
    result.exitCode = 1;
    result.stopReason = "error";
    result.errorMessage = error?.message || String(error);
    result.stderr = result.errorMessage;
    onEvent({ type: "error", message: result.errorMessage });
    onEvent({ type: "done", turns: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0, model: result.model, exitCode: 1, stopReason: "error", text: result.output, codexThreadId: result.codexThreadId, codexTurnId: result.codexTurnId });
    return result;
  } finally {
    client.close();
  }
}

export async function runOutsourceClaudeStreaming({ profile = {}, task = "", project = "", cwd, workersDir, signal } = {}, onEvent = () => {}) {
  const worker = {
    id: `outsource-${profile.name || "agent"}`,
    role: "programmer",
    backend: "claude",
    model: profile.model || "",
    thinking: profile.thinking,
    claudeSessionId: randomUUID(),
    claudeSessionInitialized: false,
    claudeCwd: cwd || process.cwd(),
    claudeCommand: profile.claudeCommand,
    claudePermissionMode: profile.claudePermissionMode || "bypassPermissions",
    claudeTools: profile.claudeTools,
    claudeAllowedTools: profile.claudeAllowedTools,
    claudeDisallowedTools: profile.claudeDisallowedTools,
    claudeBare: profile.claudeBare,
  };
  return runClaudeWorkerStreaming(
    {
      worker,
      task,
      project,
      cwd,
      additionalContext: "",
      signal,
      agentDef: String(profile.systemPrompt || DEFAULT_OUTSOURCE_SYSTEM_PROMPT),
      workersDir: workersDir || process.cwd(),
    },
    onEvent,
  );
}

export async function runOutsourceAgentStreaming(options = {}, onEvent = () => {}) {
  const profile = options.profile || {};
  const backend = String(profile.backend || "pi").toLowerCase();
  if (backend === "codex") return runOutsourceCodexStreaming(options, onEvent);
  if (backend === "claude") return runOutsourceClaudeStreaming(options, onEvent);
  return runOutsourcePiStreaming(options, onEvent);
}

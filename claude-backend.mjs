import { spawn } from "node:child_process";
import { buildWorkerSystemPrompt, buildWorkerTaskPrompt } from "./worker-prompts.mjs";

const CLAUDE_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const CLAUDE_PERMISSION_MODES = new Set(["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"]);

function clean(value) {
  return String(value || "").trim();
}

function numberValue(...values) {
  for (const value of values) {
    if (value == null) continue;
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function stringList(value) {
  if (Array.isArray(value)) return value.map(clean).filter(Boolean);
  if (typeof value === "string") return value.split(/[\s,]+/).map(clean).filter(Boolean);
  return [];
}

export function normalizeClaudeEffort(thinking) {
  const value = clean(thinking).toLowerCase();
  if (!value || value === "off" || value === "minimal") return "";
  if (value === "ultra") return "max";
  if (CLAUDE_EFFORTS.has(value)) return value;
  return "";
}

export function extractClaudeUsage(usage = {}) {
  const inputTokens = numberValue(usage.inputTokens, usage.input_tokens, usage.input, usage.promptTokens, usage.prompt_tokens);
  const cachedInputTokens =
    numberValue(usage.cachedInputTokens, usage.cached_input_tokens, usage.cachedInput, usage.cached_input) +
    numberValue(usage.cacheReadInputTokens, usage.cache_read_input_tokens, usage.cache_read_tokens, usage.cache_read) +
    numberValue(usage.cacheCreationInputTokens, usage.cache_creation_input_tokens, usage.cache_creation_tokens, usage.cache_creation) +
    numberValue(usage.cacheCreation?.ephemeral_1h_input_tokens, usage.cache_creation?.ephemeral_1h_input_tokens) +
    numberValue(usage.cacheCreation?.ephemeral_5m_input_tokens, usage.cache_creation?.ephemeral_5m_input_tokens);
  const outputTokens = numberValue(usage.outputTokens, usage.output_tokens, usage.output, usage.completionTokens, usage.completion_tokens);
  const reasoningOutputTokens = numberValue(usage.reasoningOutputTokens, usage.reasoning_output_tokens, usage.reasoningOutput, usage.reasoning_output);
  const totalTokens = numberValue(usage.totalTokens, usage.total_tokens, usage.total) || inputTokens + outputTokens;
  return { inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, totalTokens };
}

export function assertClaudeSessionBinding(worker) {
  const sessionId = clean(worker?.claudeSessionId);
  if (!sessionId) {
    throw new Error(`Claude worker ${worker?.id || "(unknown)"} missing claudeSessionId; refusing to start a new empty session.`);
  }
  return sessionId;
}

export function buildClaudeTaskContent({ task, project, additionalContext }) {
  return buildWorkerTaskPrompt({ task, project, additionalContext });
}

function claudeCommand(worker) {
  return clean(worker?.claudeCommand) || clean(process.env.OX_CLAUDE_COMMAND) || "claude";
}

function sessionInitialized(worker) {
  return Boolean(worker?.claudeSessionInitialized);
}

function permissionMode(worker) {
  const mode = clean(worker?.claudePermissionMode) || clean(process.env.OX_CLAUDE_PERMISSION_MODE);
  return CLAUDE_PERMISSION_MODES.has(mode) ? mode : "";
}

export function buildClaudeCliArgs({ worker, taskContent, systemPrompt }) {
  const sessionId = assertClaudeSessionBinding(worker);
  const args = ["-p", "--verbose", "--output-format", "stream-json"];

  if (worker?.claudeBare) args.push("--bare");

  if (sessionInitialized(worker)) args.push("--resume", sessionId);
  else args.push("--session-id", sessionId);

  const name = clean(worker?.role) && clean(worker?.id) ? `${worker.role}-${worker.id}` : clean(worker?.id || worker?.name);
  if (name) args.push("--name", name);

  const model = clean(worker?.model);
  if (model) args.push("--model", model);

  const effort = normalizeClaudeEffort(worker?.thinking);
  if (effort) args.push("--effort", effort);

  const mode = permissionMode(worker);
  if (mode) args.push("--permission-mode", mode);

  if (worker?.claudeTools !== undefined && worker?.claudeTools !== null) {
    args.push("--tools", String(worker.claudeTools));
  }

  const allowedTools = stringList(worker?.claudeAllowedTools);
  if (allowedTools.length > 0) args.push("--allowedTools", allowedTools.join(","));

  const disallowedTools = stringList(worker?.claudeDisallowedTools);
  if (disallowedTools.length > 0) args.push("--disallowedTools", disallowedTools.join(","));

  const prompt = clean(systemPrompt);
  if (prompt) args.push("--append-system-prompt", prompt);

  args.push(taskContent || "");
  return args;
}

function resultFromUsage(result, usage) {
  const parsed = extractClaudeUsage(usage);
  result.inputTokens = parsed.inputTokens;
  result.cachedInputTokens = parsed.cachedInputTokens;
  result.outputTokens = parsed.outputTokens;
  result.reasoningOutputTokens = parsed.reasoningOutputTokens;
  result.totalTokens = parsed.totalTokens;
}

function modelFromModelUsage(modelUsage) {
  if (!modelUsage || typeof modelUsage !== "object") return "";
  const entries = Object.keys(modelUsage).filter(Boolean);
  return entries[0] || "";
}

function addClaudeEvent(message, state, onEvent) {
  if (!message || typeof message !== "object") return;

  if (message.type === "system" && message.subtype === "init") {
    const sessionId = clean(message.session_id || message.sessionId);
    if (sessionId) {
      state.result.claudeSessionId = sessionId;
      state.observedSessionId = true;
      onEvent({ type: "claude_session", sessionId, text: `Claude session: ${sessionId}` });
    }
    if (message.model) state.result.model = message.model;
    return;
  }

  if (message.type === "stream_event") {
    const event = message.event || {};
    if (event.type === "content_block_delta") {
      const delta = event.delta || {};
      if (delta.type === "thinking_delta") {
        const text = String(delta.thinking || delta.text || "");
        if (text) onEvent({ type: "thinking", text });
      } else if (delta.type === "text_delta") {
        const text = String(delta.text || "");
        if (text) {
          state.result.output += text;
          onEvent({ type: "text", text });
        }
      }
    }
    if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
      onEvent({ type: "tool_start", name: event.content_block.name || "tool", args: event.content_block.input || {} });
    }
    if (event.type === "message_delta") {
      if (event.delta?.stop_reason) state.result.stopReason = event.delta.stop_reason;
      if (event.usage) resultFromUsage(state.result, event.usage);
    }
    return;
  }

  if (message.type === "assistant" && message.message) {
    if (message.message.model) state.result.model = message.message.model;
    if (message.message.usage && !state.seenFinalResult) resultFromUsage(state.result, message.message.usage);
    if (message.message.stop_reason) state.result.stopReason = message.message.stop_reason;
    return;
  }

  if (message.type === "result") {
    state.seenFinalResult = true;
    state.result.turns = numberValue(message.num_turns, message.turns) || 1;
    state.result.output = String(message.result ?? state.result.output ?? "");
    state.result.stopReason = message.stop_reason || message.terminal_reason || state.result.stopReason;
    state.result.model = message.model || modelFromModelUsage(message.modelUsage) || state.result.model;
    state.result.claudeSessionId = clean(message.session_id || message.sessionId) || state.result.claudeSessionId;
    if (clean(message.session_id || message.sessionId)) state.observedSessionId = true;
    if (message.usage) resultFromUsage(state.result, message.usage);
    if (message.is_error || message.subtype === "error" || message.api_error_status) {
      state.result.exitCode = 1;
      state.result.errorMessage = message.error || message.api_error_status || message.stop_reason || "Claude CLI returned an error";
      state.result.stderr = state.result.errorMessage;
    }
  }
}

function isSessionAlreadyInUse(stderr) {
  return /session id .*already in use/i.test(String(stderr || ""));
}

async function runClaudeProcess({ worker, task, project, cwd, additionalContext, signal, agentDef, workersDir, onWorkerPatch }, onEvent, forceResume = false) {
  const taskContent = buildClaudeTaskContent({ task, project, additionalContext });
  const systemPrompt = buildWorkerSystemPrompt(worker, { agentDef, workersDir, backend: "claude" });
  const command = claudeCommand(worker);
  const args = buildClaudeCliArgs({
    worker: forceResume ? { ...worker, claudeSessionInitialized: true } : worker,
    taskContent,
    systemPrompt,
  });
  const workCwd = cwd || worker.claudeCwd || process.cwd();

  const result = {
    exitCode: 0,
    output: "",
    stderr: "",
    turns: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    model: clean(worker.model),
    claudeSessionId: clean(worker.claudeSessionId),
  };
  const state = { result, seenFinalResult: false, observedSessionId: false };

  result.exitCode = await new Promise((resolve) => {
    const proc = spawn(command, args, {
      cwd: workCwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stdoutBuffer = "";
    let stderr = "";
    const abort = () => {
      try { proc.kill("SIGTERM"); } catch {}
    };
    if (signal) {
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }

    const processLine = (line) => {
      if (!line.trim()) return;
      let message;
      try { message = JSON.parse(line); } catch { return; }
      addClaudeEvent(message, state, onEvent);
    };

    proc.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) processLine(line);
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", (error) => {
      stderr += error?.message || String(error);
    });
    proc.on("close", (code, sig) => {
      if (stdoutBuffer.trim()) processLine(stdoutBuffer);
      result.stderr = stderr;
      if (sig) {
        result.stopReason = "aborted";
        result.errorMessage = `Claude CLI terminated by ${sig}`;
      }
      resolve(code ?? (sig ? 1 : 0));
    });
  });

  if (result.exitCode !== 0 && !result.errorMessage) {
    result.errorMessage = result.stderr || `Claude CLI exited with code ${result.exitCode}`;
    result.stopReason = result.stopReason || "error";
  }

  if (!state.seenFinalResult && result.exitCode === 0) {
    result.output = result.output || "(无文本输出)";
    result.turns = result.turns || 1;
  }

  const sessionId = clean(result.claudeSessionId || worker.claudeSessionId);
  if (sessionId && state.observedSessionId) {
    onWorkerPatch?.({
      claudeSessionId: sessionId,
      claudeSessionInitialized: true,
      claudeCwd: workCwd,
    });
  }

  return result;
}

function emitClaudeDone(result, onEvent) {
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
    claudeSessionId: result.claudeSessionId,
  });
}

export async function runClaudeWorkerStreaming(options, onEvent) {
  try {
    const result = await runClaudeProcess(options, onEvent, false);
    if (result.exitCode !== 0 && !options.worker.claudeSessionInitialized && isSessionAlreadyInUse(result.stderr)) {
      const retryResult = await runClaudeProcess({ ...options, worker: { ...options.worker, claudeSessionInitialized: true } }, onEvent, true);
      if (retryResult.exitCode !== 0) onEvent({ type: "error", message: retryResult.errorMessage || retryResult.stderr || `Claude CLI exited with code ${retryResult.exitCode}` });
      emitClaudeDone(retryResult, onEvent);
      return retryResult;
    }
    if (result.exitCode !== 0) onEvent({ type: "error", message: result.errorMessage || result.stderr || `Claude CLI exited with code ${result.exitCode}` });
    emitClaudeDone(result, onEvent);
    return result;
  } catch (error) {
    const message = error?.message || String(error);
    onEvent({ type: "error", message });
    onEvent({ type: "done", turns: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0, model: options.worker?.model, exitCode: 1, stopReason: "error", text: "" });
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
      model: options.worker?.model,
      claudeSessionId: options.worker?.claudeSessionId,
    };
  }
}

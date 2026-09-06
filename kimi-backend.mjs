import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildWorkerSystemPrompt, buildWorkerTaskPrompt } from "./worker-prompts.mjs";

function clean(value) {
  return String(value || "").trim();
}

function defaultKimiCommand() {
  if (clean(process.env.OX_KIMI_COMMAND)) return clean(process.env.OX_KIMI_COMMAND);
  const bundled = join(homedir(), ".kimi-code", "bin", process.platform === "win32" ? "kimi.exe" : "kimi");
  if (existsSync(bundled)) return bundled;
  return "kimi";
}

function kimiCommand(worker = {}) {
  return clean(worker.kimiCommand) || defaultKimiCommand();
}

export function buildKimiTaskContent({ worker, task, project, additionalContext, agentDef, workersDir }) {
  const taskContent = buildWorkerTaskPrompt({ task, project, additionalContext });
  if (worker?.kimiSessionInitialized) return taskContent;

  const systemPrompt = buildWorkerSystemPrompt(worker, {
    agentDef,
    workersDir,
    backend: "kimi",
  }).trim();
  if (!systemPrompt) return taskContent;
  return [
    "以下是你的稳定系统设定，请在后续整个 Kimi session 中持续遵守：",
    "",
    systemPrompt,
    "",
    "---",
    "",
    taskContent,
  ].join("\n");
}

export function buildKimiCliArgs({ worker = {}, taskContent = "" } = {}) {
  const args = [];
  const sessionId = clean(worker.kimiSessionId);
  if (worker.kimiSessionInitialized && sessionId) {
    args.push("--session", sessionId);
  }

  args.push("--output-format", "stream-json");

  const model = clean(worker.model);
  if (model) args.push("--model", model);

  // Kimi Code 0.31.0 rejects --prompt with --auto/--yolo, but prompt mode
  // can still run regular tools. Keep args minimal and let local Kimi config
  // decide provider/tool policy.
  args.push("-p", taskContent);
  return args;
}

function parseToolArgs(raw) {
  if (raw == null || raw === "") return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return String(raw);
  }
}

export function kimiStreamLineToEvents(line, state = {}) {
  const text = String(line || "");
  if (!text.trim()) return [];

  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return [{ type: "tool_output", name: "kimi", text: `${text}\n` }];
  }

  if (!message || typeof message !== "object") return [];

  if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
    return message.tool_calls.map((call) => ({
      type: "tool_start",
      name: clean(call?.function?.name) || clean(call?.name) || clean(call?.type) || "tool",
      args: parseToolArgs(call?.function?.arguments ?? call?.arguments ?? call?.input),
    }));
  }

  if (message.role === "tool") {
    return [{
      type: "tool_end",
      name: clean(message.name) || clean(message.tool_call_id) || "tool",
      result: message.content ?? message.result ?? "",
      isError: Boolean(message.is_error || message.isError || message.error || message.status === "error" || message.status === "failed"),
    }];
  }

  if (message.role === "assistant" && typeof message.content === "string") {
    const content = message.content;
    state.output = `${state.output || ""}${content}`;
    state.turns = (state.turns || 0) + 1;
    return content ? [{ type: "text", text: content }] : [];
  }

  if (message.role === "meta" && message.type === "session.resume_hint") {
    const sessionId = clean(message.session_id || message.sessionId);
    if (!sessionId) return [];
    state.sessionId = sessionId;
    state.observedSessionId = true;
    return [{ type: "kimi_session", sessionId, text: `Kimi session: ${sessionId}` }];
  }

  return [];
}

export async function runKimiWorkerStreaming(options, onEvent) {
  const { worker, task, project, cwd, additionalContext, signal, agentDef, workersDir, onWorkerPatch } = options;
  const workCwd = cwd || worker.kimiCwd || process.cwd();
  const taskContent = buildKimiTaskContent({ worker, task, project, additionalContext, agentDef, workersDir });
  const command = kimiCommand(worker);
  const args = buildKimiCliArgs({ worker, taskContent });
  const state = {
    output: "",
    sessionId: clean(worker.kimiSessionId),
    observedSessionId: false,
    turns: 0,
  };
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
    kimiSessionId: clean(worker.kimiSessionId),
  };

  try {
    result.exitCode = await new Promise((resolve) => {
      const proc = spawn(command, args, {
        cwd: workCwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });

      let stdoutBuffer = "";
      let stderr = "";

      const emitLine = (line) => {
        for (const event of kimiStreamLineToEvents(line, state)) {
          onEvent(event);
        }
      };

      proc.stdout.on("data", (chunk) => {
        stdoutBuffer += chunk.toString();
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() || "";
        for (const line of lines) emitLine(line);
      });

      proc.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      proc.on("error", (error) => {
        stderr += error?.message || String(error);
      });

      proc.on("close", (code, sig) => {
        if (stdoutBuffer.trim()) emitLine(stdoutBuffer);
        result.stderr = stderr;
        if (sig) {
          result.stopReason = "aborted";
          result.errorMessage = `Kimi CLI terminated by ${sig}`;
        }
        resolve(code ?? (sig ? 1 : 0));
      });

      const abort = () => {
        try { proc.kill("SIGTERM"); } catch {}
      };
      if (signal) {
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      }
    });

    result.output = state.output || "(无文本输出)";
    result.turns = state.turns || (result.output ? 1 : 0);
    result.kimiSessionId = clean(state.sessionId || worker.kimiSessionId);

    if (result.exitCode !== 0 && !result.errorMessage) {
      result.errorMessage = result.stderr || `Kimi CLI exited with code ${result.exitCode}`;
      result.stopReason = result.stopReason || "error";
    }

    if (result.kimiSessionId && state.observedSessionId) {
      onWorkerPatch?.({
        kimiSessionId: result.kimiSessionId,
        kimiSessionInitialized: true,
        kimiCwd: workCwd,
      });
    }

    if (result.exitCode !== 0) {
      onEvent({ type: "error", message: result.errorMessage || result.stderr || `Kimi CLI exited with code ${result.exitCode}` });
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
      kimiSessionId: result.kimiSessionId,
    });

    return result;
  } catch (error) {
    const message = error?.message || String(error);
    onEvent({ type: "error", message });
    onEvent({ type: "done", turns: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0, model: worker?.model, exitCode: 1, stopReason: "error", text: "", kimiSessionId: worker?.kimiSessionId });
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
      model: worker?.model,
      kimiSessionId: worker?.kimiSessionId,
    };
  }
}

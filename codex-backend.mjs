import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildFactoryWorkerHandbook } from "./factory-handbook.mjs";

export const DEFAULT_CODEX_SERVER_URL = "ws://127.0.0.1:48177";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function normalizeCodexEffort(thinking) {
  if (!thinking) return undefined;
  if (thinking === "off") return "none";
  if (thinking === "minimal") return "low";
  if (["low", "medium", "high", "xhigh"].includes(thinking)) return thinking;
  return undefined;
}

export function normalizeCodexModel(model) {
  if (!model) return undefined;
  const value = String(model).trim();
  if (!value) return undefined;
  const lowered = value.toLowerCase();
  if (/^\d+(?:\.\d+)?(?:-[a-z0-9-]+)?$/.test(lowered)) return `gpt-${lowered}`;
  if (/^gpt\d/.test(lowered)) return lowered.replace(/^gpt/, "gpt-");
  if (/^codex-?5/.test(lowered)) return lowered.replace(/^codex-?/, "gpt-");
  if (value.startsWith("GPT-")) return lowered;
  return value;
}

function messageText(value, fallback = "") {
  if (value == null) return fallback;
  if (typeof value === "string") return value;
  if (typeof value.message === "string") return value.message;
  try { return JSON.stringify(value); } catch { return fallback; }
}

function firstNumber(...values) {
  for (const value of values) {
    const numberValue = Number(value);
    if (Number.isFinite(numberValue)) return numberValue;
  }
  return 0;
}

function isObject(value) {
  return value !== null && typeof value === "object";
}

const TOKEN_INPUT_KEYS = ["inputTokens", "input_tokens", "input", "promptTokens", "prompt_tokens", "prompt"];
const TOKEN_CACHED_INPUT_KEYS = ["cachedInputTokens", "cached_input_tokens", "cachedInput", "cached_input", "cached", "cacheReadInputTokens", "cache_read_input_tokens"];
const TOKEN_OUTPUT_KEYS = ["outputTokens", "output_tokens", "output", "completionTokens", "completion_tokens", "completion"];
const TOKEN_REASONING_OUTPUT_KEYS = ["reasoningOutputTokens", "reasoning_output_tokens", "reasoningOutput", "reasoning_output"];
const TOKEN_TOTAL_KEYS = ["totalTokens", "total_tokens", "total"];

function hasTokenFields(value) {
  if (!isObject(value)) return false;
  return [
    ...TOKEN_INPUT_KEYS,
    ...TOKEN_CACHED_INPUT_KEYS,
    ...TOKEN_OUTPUT_KEYS,
    ...TOKEN_REASONING_OUTPUT_KEYS,
    ...TOKEN_TOTAL_KEYS,
  ].some((key) => value[key] != null);
}

function normalizeTokenUsageShape(value) {
  if (!isObject(value)) return {};
  // Codex app-server v2 sends ThreadTokenUsage as
  // { total: TokenUsageBreakdown, last: TokenUsageBreakdown, ... }.
  // Keep this legacy extractor on `last` because callers expect a single
  // non-cumulative usage object. The streaming job path below uses
  // createCodexTokenUsageTracker() to compute total cumulative deltas instead.
  if (hasTokenFields(value.last)) return value.last;
  if (hasTokenFields(value.last_token_usage)) return value.last_token_usage;
  if (hasTokenFields(value.total)) return value.total;
  if (hasTokenFields(value.total_token_usage)) return value.total_token_usage;
  return value;
}

export function extractCodexTokenUsage(turn = {}) {
  const candidates = [
    turn?.usage,
    turn?.tokenUsage,
    turn?.tokens,
    turn?.metrics?.usage,
    turn?.params?.tokenUsage,
    turn?.params?.usage,
    turn,
  ];

  for (const candidate of candidates) {
    const usage = normalizeTokenUsageShape(candidate);
    if (!hasTokenFields(usage)) continue;
    const inputTokens = firstNumber(...TOKEN_INPUT_KEYS.map((key) => usage[key]));
    const cachedInputTokens = firstNumber(...TOKEN_CACHED_INPUT_KEYS.map((key) => usage[key]));
    const outputTokens = firstNumber(...TOKEN_OUTPUT_KEYS.map((key) => usage[key]));
    const reasoningOutputTokens = firstNumber(...TOKEN_REASONING_OUTPUT_KEYS.map((key) => usage[key]));
    const explicitTotalTokens = firstNumber(...TOKEN_TOTAL_KEYS.map((key) => usage[key]));
    const totalTokens = explicitTotalTokens || inputTokens + outputTokens;
    return { inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, totalTokens };
  }

  return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 };
}

function zeroTokenUsage() {
  return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 };
}

export function subtractCodexTokenUsage(after = {}, before = {}) {
  const afterUsage = normalizeTokenUsageShape(after);
  const beforeUsage = normalizeTokenUsageShape(before);
  const inputTokens = Math.max(0, firstNumber(...TOKEN_INPUT_KEYS.map((key) => afterUsage[key])) - firstNumber(...TOKEN_INPUT_KEYS.map((key) => beforeUsage[key])));
  const cachedInputTokens = Math.max(0, firstNumber(...TOKEN_CACHED_INPUT_KEYS.map((key) => afterUsage[key])) - firstNumber(...TOKEN_CACHED_INPUT_KEYS.map((key) => beforeUsage[key])));
  const outputTokens = Math.max(0, firstNumber(...TOKEN_OUTPUT_KEYS.map((key) => afterUsage[key])) - firstNumber(...TOKEN_OUTPUT_KEYS.map((key) => beforeUsage[key])));
  const reasoningOutputTokens = Math.max(0, firstNumber(...TOKEN_REASONING_OUTPUT_KEYS.map((key) => afterUsage[key])) - firstNumber(...TOKEN_REASONING_OUTPUT_KEYS.map((key) => beforeUsage[key])));
  const totalTokens = Math.max(0, firstNumber(...TOKEN_TOTAL_KEYS.map((key) => afterUsage[key])) - firstNumber(...TOKEN_TOTAL_KEYS.map((key) => beforeUsage[key]))) || inputTokens + outputTokens;
  return { inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, totalTokens };
}

function extractTokenUsagePair(candidate) {
  if (!isObject(candidate)) return null;
  const total = candidate.total || candidate.totalTokenUsage || candidate.total_token_usage || candidate.info?.total_token_usage || candidate.info?.totalTokenUsage;
  const last = candidate.last || candidate.lastTokenUsage || candidate.last_token_usage || candidate.info?.last_token_usage || candidate.info?.lastTokenUsage;
  if (hasTokenFields(total) || hasTokenFields(last)) {
    return {
      total: hasTokenFields(total) ? extractCodexTokenUsage(total) : zeroTokenUsage(),
      last: hasTokenFields(last) ? extractCodexTokenUsage(last) : zeroTokenUsage(),
    };
  }
  return null;
}

export function extractCodexThreadTokenUsage(turn = {}) {
  const candidates = [
    turn?.usage,
    turn?.tokenUsage,
    turn?.tokens,
    turn?.metrics?.usage,
    turn?.params?.tokenUsage,
    turn?.params?.usage,
    turn?.params,
    turn?.info,
    turn,
  ];

  for (const candidate of candidates) {
    const pair = extractTokenUsagePair(candidate);
    if (pair) return pair;
  }

  return { total: zeroTokenUsage(), last: zeroTokenUsage() };
}

export function createCodexTokenUsageTracker() {
  const byTurn = new Map();
  let latestCumulative = zeroTokenUsage();
  let latestDelta = zeroTokenUsage();

  const remember = (params = {}, activeTurnId = "") => {
    const { total, last } = extractCodexThreadTokenUsage(params);
    const id = params.turnId || params.turn?.id || activeTurnId || "";
    if (hasNonZeroTokenUsage(total)) {
      if (id) {
        const state = byTurn.get(id) || {};
        if (!state.baseline) {
          state.baseline = hasNonZeroTokenUsage(last)
            ? subtractCodexTokenUsage(total, last)
            : latestCumulative;
        }
        state.total = total;
        state.last = last;
        state.delta = subtractCodexTokenUsage(total, state.baseline);
        byTurn.set(id, state);
        latestDelta = state.delta;
      } else {
        latestDelta = hasNonZeroTokenUsage(last) ? last : subtractCodexTokenUsage(total, latestCumulative);
      }
      latestCumulative = total;
      return latestDelta;
    }

    const directUsage = extractCodexTokenUsage(params);
    if (hasNonZeroTokenUsage(directUsage)) {
      if (id) {
        const state = byTurn.get(id) || {};
        state.delta = directUsage;
        byTurn.set(id, state);
      }
      latestDelta = directUsage;
    }
    return latestDelta;
  };

  const get = (id = "") => byTurn.get(id)?.delta || latestDelta || zeroTokenUsage();

  return { remember, get };
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

export function getCodexServerUrl(worker = {}) {
  return worker.codexServerUrl || process.env.OX_CODEX_APP_SERVER_URL || DEFAULT_CODEX_SERVER_URL;
}

export function codexNotificationToStreamEvents(message) {
  if (!message || typeof message !== "object") return [];
  const params = message.params || {};
  const item = params.item || {};

  switch (message.method) {
    case "item/agentMessage/delta":
      return params.delta ? [{ type: "text", text: params.delta }] : [];
    case "item/reasoning/textDelta":
    case "item/reasoning/summaryTextDelta":
      return params.delta ? [{ type: "thinking", text: params.delta }] : [];
    case "item/started":
      if (item.type === "commandExecution") {
        return [{ type: "tool_start", name: "bash", args: { command: item.command, cwd: item.cwd } }];
      }
      if (item.type === "mcpToolCall") {
        return [{ type: "tool_start", name: `${item.server}.${item.tool}`, args: item.arguments ?? {} }];
      }
      if (item.type === "dynamicToolCall") {
        return [{ type: "tool_start", name: item.tool || "tool", args: item.arguments ?? {} }];
      }
      return [];
    case "item/commandExecution/outputDelta":
      return params.delta ? [{ type: "tool_output", name: "bash", text: params.delta }] : [];
    case "item/mcpToolCall/progress":
      return params.delta || params.message
        ? [{ type: "tool_output", name: params.tool || "mcp", text: params.delta || params.message }]
        : [];
    case "item/completed":
      if (item.type === "commandExecution") {
        return [{
          type: "tool_end",
          name: "bash",
          result: { command: item.command, output: item.aggregatedOutput || "", exitCode: item.exitCode },
          isError: item.status === "failed" || (item.exitCode != null && item.exitCode !== 0),
        }];
      }
      if (item.type === "mcpToolCall") {
        return [{
          type: "tool_end",
          name: `${item.server}.${item.tool}`,
          result: item.result ?? item.error ?? null,
          isError: item.status === "failed" || Boolean(item.error),
        }];
      }
      if (item.type === "dynamicToolCall") {
        return [{
          type: "tool_end",
          name: item.tool || "tool",
          result: item.contentItems ?? null,
          isError: item.success === false || item.status === "failed",
        }];
      }
      return [];
    case "error":
      return [{ type: "error", message: messageText(params.message || params.error, "codex app-server error") }];
    default:
      return [];
  }
}

export function buildCodexBaseInstructions(worker, agentDef = "", { workersDir } = {}) {
  const handoff = typeof worker.codexThreadHandoff === "string" ? worker.codexThreadHandoff.trim() : "";
  return [
    `你的名字叫 **${worker.id}**，职位是 ${worker.role}。`,
    "",
    "你是牛马工厂里的 Codex 员工。保持这个身份和长期上下文，不要因为新的 turn 忘记之前的工作。",
    "",
    buildFactoryWorkerHandbook(worker, { workersDir, backend: "codex" }),
    handoff ? `\n## 旧 Codex thread handoff\n\n${handoff}` : "",
    agentDef.trim() ? `\n${agentDef.trim()}` : "",
  ].join("\n").trim();
}

function wsToHttpReadyz(url) {
  const parsed = new URL(url);
  parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
  parsed.pathname = "/readyz";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

async function isReady(url) {
  try {
    const response = await fetch(wsToHttpReadyz(url), { signal: AbortSignal.timeout(1000) });
    return response.ok;
  } catch {
    return false;
  }
}

function shouldAutoStart(url) {
  const parsed = new URL(url);
  return (parsed.protocol === "ws:" || parsed.protocol === "http:") && LOCAL_HOSTS.has(parsed.hostname);
}

export async function ensureCodexAppServer(url, { workersDir = process.cwd(), timeoutMs = 10000 } = {}) {
  if (await isReady(url)) return { started: false, url };
  if (!shouldAutoStart(url)) {
    throw new Error(`Codex app-server is not reachable at ${url}`);
  }

  const logDir = join(workersDir, "codex");
  mkdirSync(logDir, { recursive: true });
  const logStream = createWriteStream(join(logDir, "app-server.log"), { flags: "a" });
  const command = process.env.OX_CODEX_APP_SERVER_CMD || "codex";
  const child = spawn(command, ["app-server", "--listen", url], {
    cwd: process.cwd(),
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });
  child.stdout.pipe(logStream, { end: false });
  child.stderr.pipe(logStream, { end: false });
  child.unref();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isReady(url)) return { started: true, url, pid: child.pid };
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for Codex app-server at ${url}; see ${join(logDir, "app-server.log")}`);
}

export class CodexAppServerClient {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.notificationHandlers = new Set();
    this.ws = null;
  }

  onNotification(handler) {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  async connect() {
    if (typeof WebSocket !== "function") {
      throw new Error("Global WebSocket is unavailable; run Pi with Node 22+ or provide a WebSocket runtime");
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;

    this.ws = new WebSocket(this.url);
    this.ws.onmessage = (event) => this.#handleMessage(event.data);

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out connecting to ${this.url}`)), 5000);
      this.ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      this.ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error(`Failed to connect to ${this.url}`));
      };
    });
  }

  close() {
    try { this.ws?.close(); } catch {}
    this.ws = null;
  }

  async initialize() {
    const result = await this.request("initialize", {
      clientInfo: { name: "pi-ox-factory", title: "Pi Ox Factory", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized");
    return result;
  }

  notify(method, params) {
    this.ws?.send(JSON.stringify({ method, params }));
  }

  request(method, params, timeoutMs = 30000) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  #handleMessage(data) {
    let message;
    try { message = JSON.parse(String(data)); } catch { return; }

    if (message.id && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }

    for (const handler of this.notificationHandlers) {
      try { handler(message); } catch {}
    }
  }
}

function sandboxMode(worker) {
  return worker.codexSandbox || process.env.OX_CODEX_SANDBOX || "workspace-write";
}

function approvalPolicy(worker) {
  return worker.codexApprovalPolicy || process.env.OX_CODEX_APPROVAL_POLICY || "never";
}

export function buildCodexTaskContent({ worker, task, project, additionalContext, workersDir }) {
  const lines = [`你的名字叫 **${worker.id}**，职位是 ${worker.role}。`, ""];
  if (project) lines.push(`## 项目: ${project}`, "");
  lines.push("## 任务", task);
  if (additionalContext) lines.push("", "## 附加上下文", additionalContext);
  lines.push("", buildFactoryWorkerHandbook(worker, { workersDir, backend: "codex" }));
  return lines.join("\n");
}

async function startThread(client, { worker, cwd, agentDef, workersDir, ephemeral = false }) {
  const model = normalizeCodexModel(worker.model);
  return client.request("thread/start", {
    cwd: cwd || process.cwd(),
    approvalPolicy: approvalPolicy(worker),
    sandbox: sandboxMode(worker),
    model: model || null,
    baseInstructions: buildCodexBaseInstructions(worker, agentDef, { workersDir }),
    ephemeral,
  });
}

function shouldReplaceCodexThread(error) {
  const message = error?.message || String(error || "");
  return /no rollout found|thread .*not found|unknown thread/i.test(message);
}

export async function createCodexWorkerThread({ worker, cwd, agentDef, workersDir }) {
  const url = getCodexServerUrl(worker);
  await ensureCodexAppServer(url, { workersDir });
  const client = new CodexAppServerClient(url);
  const model = normalizeCodexModel(worker.model);
  if (model && model !== worker.model) worker.model = model;
  try {
    await client.connect();
    await client.initialize();
    const start = await startThread(client, { worker, cwd, agentDef, workersDir, ephemeral: false });
    return {
      threadId: start.thread.id,
      serverUrl: url,
      model: start.model || model,
      cwd: start.cwd,
    };
  } finally {
    client.close();
  }
}

async function ensureThread(client, { worker, cwd, agentDef, workersDir, onWorkerPatch }) {
  const url = getCodexServerUrl(worker);
  await ensureCodexAppServer(url, { workersDir });
  const model = normalizeCodexModel(worker.model);
  if (model && model !== worker.model) {
    worker.model = model;
    onWorkerPatch?.({ model });
  }

  if (worker.codexThreadId) {
    try {
      const resume = await client.request("thread/resume", {
        threadId: worker.codexThreadId,
        cwd: cwd || process.cwd(),
        approvalPolicy: approvalPolicy(worker),
        sandbox: sandboxMode(worker),
        model: model || null,
        baseInstructions: buildCodexBaseInstructions(worker, agentDef, { workersDir }),
      });
      return resume.thread.id;
    } catch (error) {
      if (!shouldReplaceCodexThread(error)) throw error;
      const created = await startThread(client, { worker, cwd, agentDef, workersDir, ephemeral: false });
      const threadId = created.thread.id;
      worker.codexThreadId = threadId;
      worker.codexServerUrl = url;
      worker.codexThreadHandoff = null;
      onWorkerPatch?.({ codexThreadId: threadId, codexServerUrl: url, model: model || worker.model, codexThreadHandoff: null });
      return threadId;
    }
  }

  const created = await startThread(client, { worker, cwd, agentDef, workersDir, ephemeral: false });
  const threadId = created.thread.id;
  worker.codexThreadId = threadId;
  worker.codexServerUrl = url;
  worker.codexThreadHandoff = null;
  onWorkerPatch?.({ codexThreadId: threadId, codexServerUrl: url, model: model || worker.model, codexThreadHandoff: null });
  return threadId;
}

export async function runCodexWorkerStreaming(options, onEvent) {
  const { worker, task, project, cwd, additionalContext, signal, agentDef, workersDir, onWorkerPatch } = options;
  const url = getCodexServerUrl(worker);
  const model = normalizeCodexModel(worker.model);
  if (model && model !== worker.model) {
    worker.model = model;
    onWorkerPatch?.({ model });
  }
  const client = new CodexAppServerClient(url);
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
    model: model || worker.model,
  };
  let turnId = "";
  let completedTurn = null;
  const tokenUsageTracker = createCodexTokenUsageTracker();
  const capturedTokenUsage = (id) => tokenUsageTracker.get(id);
  const waitForCapturedTokenUsage = async (id, timeoutMs = 1000) => {
    let usage = capturedTokenUsage(id);
    if (hasNonZeroTokenUsage(usage)) return usage;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      usage = capturedTokenUsage(id);
      if (hasNonZeroTokenUsage(usage)) return usage;
    }
    return capturedTokenUsage(id);
  };
  let resolveCompleted;
  let rejectCompleted;
  const completedPromise = new Promise((resolve, reject) => {
    resolveCompleted = resolve;
    rejectCompleted = reject;
  });
  const timeout = setTimeout(() => rejectCompleted(new Error("Timed out waiting for Codex turn completion")), 30 * 60 * 1000);

  try {
    await ensureCodexAppServer(url, { workersDir });
    await client.connect();
    await client.initialize();
    const threadId = await ensureThread(client, { worker, cwd, agentDef, workersDir, onWorkerPatch });

    client.onNotification((message) => {
      const params = message.params || {};
      if (params.threadId && params.threadId !== threadId) return;

      if (message.method === "turn/started" && params.turn?.id) {
        turnId = params.turn.id;
        worker.codexActiveTurnId = turnId;
        onWorkerPatch?.({ codexActiveTurnId: turnId });
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
        completedTurn = params.turn;
        resolveCompleted(params.turn);
      }
    });

    const start = await client.request("turn/start", {
      threadId,
      input: [{ type: "text", text: buildCodexTaskContent({ worker, task, project, additionalContext, workersDir }), text_elements: [] }],
      cwd: cwd || process.cwd(),
      model: model || null,
      effort: normalizeCodexEffort(worker.thinking),
    });

    turnId = start.turn.id;
    worker.codexActiveTurnId = turnId;
    onWorkerPatch?.({ codexActiveTurnId: turnId });

    if (signal) {
      const interrupt = () => {
        client.request("turn/interrupt", { threadId, turnId }, 5000).catch(() => {});
      };
      if (signal.aborted) interrupt();
      else signal.addEventListener("abort", interrupt, { once: true });
    }

    const turn = await completedPromise;
    clearTimeout(timeout);
    result.turns = 1;
    const turnUsage = extractCodexTokenUsage(turn);
    const capturedUsage = await waitForCapturedTokenUsage(turn.id);
    const usage = hasNonZeroTokenUsage(capturedUsage) ? capturedUsage : turnUsage;
    result.inputTokens += usage.inputTokens;
    result.cachedInputTokens += usage.cachedInputTokens;
    result.outputTokens += usage.outputTokens;
    result.reasoningOutputTokens += usage.reasoningOutputTokens;
    result.totalTokens += usage.totalTokens || usage.inputTokens + usage.outputTokens;
    if (turn.status !== "completed") {
      result.exitCode = 1;
      result.stopReason = turn.status;
      result.errorMessage = turn.error?.message || turn.status;
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
    });
    return result;
  } catch (error) {
    clearTimeout(timeout);
    result.exitCode = 1;
    result.stopReason = "error";
    result.errorMessage = error?.message || String(error);
    result.stderr = result.errorMessage;
    onEvent({ type: "error", message: result.errorMessage });
    onEvent({ type: "done", turns: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0, model: result.model, exitCode: 1, stopReason: "error", text: result.output });
    return result;
  } finally {
    clearTimeout(timeout);
    worker.codexActiveTurnId = undefined;
    onWorkerPatch?.({ codexActiveTurnId: undefined });
    client.close();
  }
}

export async function steerCodexWorker(options, onEvent) {
  const { worker, task, workersDir } = options;
  if (!worker.codexThreadId || !worker.codexActiveTurnId) {
    throw new Error(`Codex worker ${worker.id} has no active turn to steer`);
  }
  const url = getCodexServerUrl(worker);
  const model = normalizeCodexModel(worker.model);
  if (model && model !== worker.model) worker.model = model;
  await ensureCodexAppServer(url, { workersDir });
  const client = new CodexAppServerClient(url);
  try {
    await client.connect();
    await client.initialize();
    await client.request("turn/steer", {
      threadId: worker.codexThreadId,
      expectedTurnId: worker.codexActiveTurnId,
      input: [{ type: "text", text: task, text_elements: [] }],
    });
    const text = `Steer accepted for active turn ${worker.codexActiveTurnId}`;
    onEvent?.({ type: "text", text });
    onEvent?.({ type: "done", turns: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0, model: model || worker.model, exitCode: 0, text });
    return { exitCode: 0, output: text, stderr: "", turns: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0, model: model || worker.model };
  } finally {
    client.close();
  }
}

import { randomUUID } from "node:crypto";
import { basename, extname, join } from "node:path";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import {
  DEFAULT_CODEX_SERVER_URL,
  CodexAppServerClient,
  ensureCodexAppServer,
  extractCodexTokenUsage,
  normalizeCodexModel,
} from "./codex-backend.mjs";

export const FACTORY_COMPACTION_VERSION = 1;

const DEFAULT_MAX_TOOL_RESULT_CHARS = 2_000;
const DEFAULT_MAX_CONVERSATION_CHARS = 60_000;
const DEFAULT_CODEX_COMPACTION_TIMEOUT_MS = 120_000;
const SHADOW_JSONL = "compaction-shadow.jsonl";
const SHADOW_DIR = "compactions";
const MAIN_AGENT_LABEL = "主agent";
const pendingShadowCompactions = new Map();

function isObject(value) {
  return value !== null && typeof value === "object";
}

function compactWhitespace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function contentToText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return compactWhitespace(JSON.stringify(content));
  return content
    .filter((part) => part && typeof part === "object")
    .map((part) => {
      if (part.type === "text") return part.text || "";
      if (part.type === "thinking") return part.thinking || part.text || "";
      if (part.type === "image") return `[image:${part.mimeType || "unknown"}]`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function truncateMiddle(text, maxChars) {
  const value = String(text ?? "");
  if (!maxChars || value.length <= maxChars) return value;
  if (maxChars < 80) return `${value.slice(0, maxChars)}\n\n[... ${value.length - maxChars} more characters truncated]`;
  const marker = `\n\n[... ${value.length - maxChars} more characters truncated]\n\n`;
  const side = Math.max(20, Math.floor((maxChars - marker.length) / 2));
  return `${value.slice(0, side)}${marker}${value.slice(-side)}`;
}

function stringifyToolArgs(args = {}) {
  if (!isObject(args)) return JSON.stringify(args);
  return Object.entries(args)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(", ");
}

export function serializeFactoryCompactionMessages(messages = [], options = {}) {
  const maxToolResultChars = Number(options.maxToolResultChars) || DEFAULT_MAX_TOOL_RESULT_CHARS;
  const parts = [];

  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const role = message.role;

    if (role === "user") {
      const text = contentToText(message.content);
      if (text) parts.push(`[User]: ${text}`);
      continue;
    }

    if (role === "assistant") {
      const textParts = [];
      const thinkingParts = [];
      const toolCalls = [];
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "text") textParts.push(block.text || "");
        else if (block.type === "thinking") thinkingParts.push(block.thinking || block.text || "");
        else if (block.type === "toolCall") toolCalls.push(`${block.name || "tool"}(${stringifyToolArgs(block.arguments || {})})`);
      }
      if (thinkingParts.filter(Boolean).length > 0) parts.push(`[Assistant thinking]: ${thinkingParts.filter(Boolean).join("\n")}`);
      if (textParts.filter(Boolean).length > 0) parts.push(`[Assistant]: ${textParts.filter(Boolean).join("\n")}`);
      if (toolCalls.length > 0) parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
      continue;
    }

    if (role === "toolResult") {
      const text = contentToText(message.content);
      if (text) parts.push(`[Tool result]: ${truncateMiddle(text, maxToolResultChars)}`);
      continue;
    }

    if (role === "bashExecution") {
      const command = message.command || "";
      const output = truncateMiddle(message.output || "", maxToolResultChars);
      parts.push(`[Bash]: ${command}\n${output}`);
      continue;
    }

    if (role === "custom") {
      const text = contentToText(message.content);
      if (text) parts.push(`[Custom:${message.customType || "unknown"}]: ${text}`);
      continue;
    }

    if (role === "branchSummary") {
      if (message.summary) parts.push(`[Branch summary]: ${message.summary}`);
      continue;
    }

    if (role === "compactionSummary") {
      if (message.summary) parts.push(`[Compaction summary]: ${message.summary}`);
    }
  }

  return parts.join("\n\n");
}

function normalizeFileList(value) {
  if (!value) return [];
  if (value instanceof Set) return [...value].filter(Boolean).sort();
  if (Array.isArray(value)) return value.filter(Boolean).sort();
  return [];
}

function normalizeFileOps(fileOps = {}) {
  return {
    readFiles: normalizeFileList(fileOps.readFiles || fileOps.read),
    modifiedFiles: [...new Set([
      ...normalizeFileList(fileOps.modifiedFiles),
      ...normalizeFileList(fileOps.edited),
      ...normalizeFileList(fileOps.written),
    ])].sort(),
  };
}

function extractFileOpsFromMessages(messages = []) {
  const read = new Set();
  const edited = new Set();
  const written = new Set();
  for (const message of messages) {
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block?.type !== "toolCall") continue;
      const path = typeof block.arguments?.path === "string" ? block.arguments.path : "";
      if (!path) continue;
      if (block.name === "read") read.add(path);
      else if (block.name === "edit") edited.add(path);
      else if (block.name === "write") written.add(path);
    }
  }
  return { read, edited, written };
}

function truncateConversation(text, maxConversationChars) {
  return truncateMiddle(text, Number(maxConversationChars) || DEFAULT_MAX_CONVERSATION_CHARS);
}

function estimateTokensFromText(text) {
  return Math.ceil(String(text || "").length / 4);
}

function workerLabel(worker = {}) {
  return [worker.id || worker.name || "未知员工", worker.role ? `(${worker.role})` : ""].filter(Boolean).join(" ");
}

function shortId(prefix = "cmp_shadow") {
  return `${prefix}_${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}_${randomUUID().slice(0, 8)}`;
}

function workerIdFromSessionFile(sessionFile = "", fallback = "主agent") {
  const ext = extname(sessionFile);
  return basename(sessionFile || fallback, ext || undefined) || fallback;
}

function sessionLooksLikeWorker(sessionFile = "", workersDir = "") {
  const normalized = String(sessionFile || "").replaceAll("\\", "/");
  const normalizedWorkersDir = String(workersDir || "").replaceAll("\\", "/").replace(/\/$/, "");
  if (normalizedWorkersDir && normalized.startsWith(`${normalizedWorkersDir}/sessions/`) && normalized.endsWith(".jsonl")) {
    return true;
  }
  return (normalized.includes("/.pi/workers/sessions/") || normalized.includes("/workers/sessions/")) &&
    normalized.endsWith(".jsonl");
}

function sessionLooksLikeMainAgent(sessionFile = "") {
  const normalized = String(sessionFile || "").replaceAll("\\", "/");
  return (normalized.includes("/.pi/agent/sessions/") || normalized.includes("/agent/sessions/")) &&
    normalized.endsWith(".jsonl");
}

function parseList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function getCompactionMode(options = {}) {
  return getCompactionModeSetting(options).mode;
}

function getCompactionModeSetting(options = {}) {
  const explicitValue = options.mode ?? process.env.OX_FACTORY_CODEX_COMPACTION_MODE;
  const explicit = String(explicitValue || "").trim().toLowerCase();
  if (["off", "shadow", "apply"].includes(explicit)) return { mode: explicit, explicit: true };
  // Backward-compatible switch from the first Codex compaction MVP.
  if (process.env.OX_FACTORY_CODEX_COMPACTION === "1") return { mode: "apply", explicit: true };
  return { mode: "off", explicit: false };
}

function isWorkerAllowed(workerId, options = {}) {
  const allowed = parseList(options.workers ?? process.env.OX_FACTORY_CODEX_COMPACTION_WORKERS);
  if (allowed.length === 0) return true;
  return allowed.includes(workerId) || allowed.includes("*");
}

function normalizeScopes(scope) {
  const scopes = parseList(scope || "workers").map((item) => item.toLowerCase());
  return scopes.length > 0 ? scopes : ["workers"];
}

function mainAgentLabel(options = {}) {
  return String(options.mainAgentName || process.env.OX_FACTORY_MAIN_AGENT_NAME || MAIN_AGENT_LABEL).trim() || MAIN_AGENT_LABEL;
}

function resolveCompactionTarget(sessionFile = "", options = {}) {
  if (sessionLooksLikeWorker(sessionFile, options.workersDir)) {
    return {
      targetType: "worker",
      worker: workerIdFromSessionFile(sessionFile),
      role: options.role || "worker",
    };
  }
  if (sessionLooksLikeMainAgent(sessionFile) || normalizeScopes(options.scope).includes("main")) {
    return {
      targetType: "main",
      worker: mainAgentLabel(options),
      role: "main-agent",
    };
  }
  return {
    targetType: "unknown",
    worker: workerIdFromSessionFile(sessionFile),
    role: options.role || "worker",
  };
}

function targetMatchesScope(target, scope) {
  const scopes = normalizeScopes(scope);
  if (scopes.includes("all")) return target.targetType !== "unknown";
  if (target.targetType === "worker") return scopes.includes("worker") || scopes.includes("workers");
  if (target.targetType === "main") return scopes.includes("main") || scopes.includes("main-agent") || scopes.includes("mainagent");
  return false;
}

function shadowKey({ sessionFile = "", firstKeptEntryId = "", tokensBefore = 0 } = {}) {
  return `${sessionFile}::${firstKeptEntryId}::${tokensBefore}`;
}

function shadowJsonlFile(workersDir) {
  return join(workersDir, SHADOW_JSONL);
}

function shadowOutputDir(workersDir) {
  return join(workersDir, SHADOW_DIR);
}

function relativeShadowPath(workersDir, file) {
  if (typeof file !== "string") return "";
  const prefix = `${workersDir}/`;
  return file.startsWith(prefix) ? file.slice(prefix.length) : file;
}

function countMatches(text, pattern) {
  return (String(text || "").match(pattern) || []).length;
}

function extractSections(summary = "") {
  const sections = [];
  for (const match of String(summary || "").matchAll(/^##+\s+(.+)$/gm)) {
    sections.push(match[1].trim());
  }
  return sections;
}

function analyzeSummary(summary = "") {
  const text = String(summary || "");
  const sections = extractSections(text);
  return {
    summaryChars: text.length,
    estimatedTokens: estimateTokensFromText(text),
    sections,
    hasFactoryContext: /Factory Context|工厂|job|queue|dispatch|talk/i.test(text),
    hasNextTurnInstructions: /Next Turn Instructions|下一步|Next Steps/i.test(text),
    hasCommandsVerification: /Commands? & Verification|命令|验证|已执行|结果/i.test(text),
    filePathCount: countMatches(text, /(?:^|\s)(?:\.{0,2}\/|\/Users\/|backend\/|clients\/|\.pi\/)[^\s`，。；,;)]+/g),
    todoCount: countMatches(text, /(?:- \[ \]|TODO|待办|下一步|In Progress)/gi),
  };
}

function ensureShadowStorage(workersDir) {
  mkdirSync(workersDir, { recursive: true });
  mkdirSync(shadowOutputDir(workersDir), { recursive: true });
}

function appendJsonl(file, value) {
  appendFileSync(file, `${JSON.stringify(value)}\n`, "utf8");
}

function safeFileStem(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, "_");
}

function writeShadowMarkdownFiles(workersDir, id, piSummary, codexSummary) {
  ensureShadowStorage(workersDir);
  const stem = safeFileStem(id);
  const piFile = join(shadowOutputDir(workersDir), `${stem}.pi.md`);
  const codexFile = join(shadowOutputDir(workersDir), `${stem}.codex.md`);
  writeFileSync(piFile, String(piSummary || ""), "utf8");
  writeFileSync(codexFile, String(codexSummary || ""), "utf8");
  return {
    piSummaryFile: relativeShadowPath(workersDir, piFile),
    codexSummaryFile: relativeShadowPath(workersDir, codexFile),
  };
}

function buildShadowRecord({
  workersDir,
  sessionFile,
  worker,
  targetType = "worker",
  reason,
  startedAt,
  piEntry,
  codexResult,
  codexError,
}) {
  const id = shortId();
  const piSummary = piEntry?.summary || "";
  const codexSummary = codexResult?.summary || "";
  const files = writeShadowMarkdownFiles(workersDir, id, piSummary, codexSummary || `Codex shadow failed: ${codexError?.message || codexError || "unknown error"}\n`);
  const piMetrics = analyzeSummary(piSummary);
  const codexMetrics = analyzeSummary(codexSummary);
  const finishedAt = new Date().toISOString();
  const latencyMs = startedAt ? Date.now() - new Date(startedAt).getTime() : undefined;
  return {
    id,
    time: finishedAt,
    sessionFile,
    worker,
    targetType,
    reason,
    firstKeptEntryId: piEntry?.firstKeptEntryId || codexResult?.firstKeptEntryId || "",
    tokensBefore: Number(piEntry?.tokensBefore || codexResult?.tokensBefore || 0),
    decision: "pi_used_codex_shadow_only",
    pi: {
      ...piMetrics,
      summaryFile: files.piSummaryFile,
      fromExtension: Boolean(piEntry?.fromHook),
    },
    codex: {
      status: codexError ? "failed" : "done",
      ...codexMetrics,
      summaryFile: files.codexSummaryFile,
      latencyMs,
      model: codexResult?.details?.model,
      usage: codexResult?.details?.usage || {},
      error: codexError ? (codexError.message || String(codexError)) : undefined,
    },
  };
}

function writeShadowRecord(workersDir, record) {
  ensureShadowStorage(workersDir);
  appendJsonl(shadowJsonlFile(workersDir), record);
  return record;
}

function startShadowCompaction({ key, sessionFile, target, event, ctx, options }) {
  const runFn = options.runCodexCompactionFn || runCodexCompaction;
  const startedAt = new Date().toISOString();
  const promise = Promise.resolve()
    .then(() => runFn({
      worker: { id: target.worker, role: target.role, targetType: target.targetType },
      preparation: event.preparation,
      reason: event.reason,
      customInstructions: event.customInstructions,
      cwd: ctx?.cwd || process.cwd(),
      model: options.model || process.env.OX_FACTORY_CODEX_COMPACTION_MODEL || "gpt-5.5",
      codexServerUrl: options.codexServerUrl || process.env.OX_CODEX_APP_SERVER_URL || DEFAULT_CODEX_SERVER_URL,
      workersDir: options.workersDir || process.cwd(),
      targetType: target.targetType,
    }))
    .then((result) => ({ result }))
    .catch((error) => ({ error }));
  pendingShadowCompactions.set(key, { sessionFile, target, reason: event.reason, startedAt, promise });
  return promise;
}

export function buildFactoryCompactionRequest({
  worker = {},
  preparation,
  reason = "manual",
  customInstructions = "",
  maxConversationChars = DEFAULT_MAX_CONVERSATION_CHARS,
  targetType = worker.targetType || "worker",
} = {}) {
  if (!preparation) throw new Error("preparation is required");
  const messagesToSummarize = Array.isArray(preparation.messagesToSummarize) ? preparation.messagesToSummarize : [];
  const turnPrefixMessages = Array.isArray(preparation.turnPrefixMessages) ? preparation.turnPrefixMessages : [];
  const historyText = serializeFactoryCompactionMessages(messagesToSummarize);
  const turnPrefixText = serializeFactoryCompactionMessages(turnPrefixMessages);
  const conversationText = [
    historyText ? `### History Messages\n${historyText}` : "",
    turnPrefixText ? `### Split Turn Prefix\n${turnPrefixText}` : "",
  ].filter(Boolean).join("\n\n---\n\n") || "(no messages)";
  const compressedConversationText = truncateConversation(conversationText, maxConversationChars);
  const { readFiles, modifiedFiles } = normalizeFileOps(preparation.fileOps || {});
  const previousSummary = preparation.previousSummary ? `\n\n## Previous Summary\n${preparation.previousSummary}` : "";
  const extraFocus = customInstructions ? `\n\n## Extra Focus\n${customInstructions}` : "";
  const tokenLine = Number.isFinite(Number(preparation.tokensBefore))
    ? `- tokensBefore: ${Number(preparation.tokensBefore).toLocaleString("en-US")}`
    : "";

  const isMainAgent = targetType === "main";
  const outputFormat = [
    isMainAgent ? "## Main Agent State" : "## Worker State",
    isMainAgent ? "- 主会话：" : "- 员工：",
    "- 角色：",
    isMainAgent ? "- 用户长期目标 / 当前工厂目标：" : "- 当前项目 / 当前任务：",
    "- 当前工作目录 / 分支（如有）：",
    "",
    "## User Intent",
    "- 用户真正想要什么：",
    "",
    "## Active Task",
    "### Done",
    "- [x] ",
    "### In Progress",
    "- [ ] ",
    "### Blocked",
    "- ",
    "",
    "## Key Decisions",
    "- **决策**：原因",
    "",
    "## Code / Files",
    "### Modified",
    "- ",
    "### Relevant / Read",
    "- ",
    "",
    "## Commands & Verification",
    "- 已执行：",
    "- 结果：",
    "- 下次优先验证：",
    "",
    "## Factory Context",
    "- job / queue / dispatch / talk 线索：",
    "- 相关员工 / 权限 / 通信线索：",
    "- 日报 / token / 履历需要保留的事实：",
    "",
    "## Next Turn Instructions",
    "1. ",
    "2. ",
    "3. ",
    "",
    "## Things To Avoid",
    "- ",
  ].join("\n");

  const prompt = [
    isMainAgent
      ? "你是牛马工厂的主 agent 上下文压缩评估员。你的任务是把 Pi 主会话压缩成可恢复用户长期意图和工厂调度状态的交接摘要。"
      : "你是牛马工厂的上下文压缩员。你的任务是把 Pi 员工会话压缩成可恢复工作的交接摘要。",
    "",
    "强约束：",
    "- 只输出结构化 Markdown 摘要，不要继续对话。",
    "- 不要调用工具，不要改文件，不要执行命令。",
    "- 优先保留用户意图、当前任务、关键决策、文件路径、命令结果、下一步。",
    "- 如果日志/工具输出被截断，明确说明不要把缺失内容当事实。",
    isMainAgent
      ? "- 摘要要服务于主 agent reload/resume 后继续理解用户、项目路线图、员工调度和已确认需求。"
      : "- 摘要要服务于员工 reload/resume 后继续工作，而不是服务于日报文案。",
    isMainAgent ? "- 区分“已确认需求 / 讨论中的想法 / 后续待定”，不要把 brainstorm 误写成承诺。" : "",
    "",
    isMainAgent ? "## Main Agent" : "## Worker",
    isMainAgent ? `- 主会话：${worker.id || worker.name || MAIN_AGENT_LABEL}` : `- 员工：${worker.id || worker.name || "未知员工"}`,
    `- 角色：${worker.role || "unknown"}`,
    `- 压缩触发：${reason}`,
    tokenLine,
    `- firstKeptEntryId: ${preparation.firstKeptEntryId || ""}`,
    `- splitTurn: ${Boolean(preparation.isSplitTurn)}`,
    readFiles.length ? `- 已读文件线索：${readFiles.join(", ")}` : "- 已读文件线索：无",
    modifiedFiles.length ? `- 修改文件线索：${modifiedFiles.join(", ")}` : "- 修改文件线索：无",
    previousSummary,
    extraFocus,
    "",
    "## Required Output Format",
    "请严格使用以下标题：",
    "",
    outputFormat,
    "",
    "## Conversation To Compress",
    "<conversation>",
    compressedConversationText,
    "</conversation>",
  ].filter(Boolean).join("\n");

  return {
    prompt,
    firstKeptEntryId: preparation.firstKeptEntryId,
    tokensBefore: Number(preparation.tokensBefore || 0),
    metadata: {
      version: FACTORY_COMPACTION_VERSION,
      targetType,
      worker: workerLabel(worker),
      reason,
      messagesToSummarize: messagesToSummarize.length,
      turnPrefixMessages: turnPrefixMessages.length,
      readFiles,
      modifiedFiles,
      truncated: compressedConversationText.length < conversationText.length,
      sourceChars: conversationText.length,
      promptChars: prompt.length,
    },
  };
}

function messageFromEntry(entry) {
  if (entry?.type === "message") return entry.message;
  if (entry?.type === "custom_message") {
    return {
      role: "custom",
      customType: entry.customType,
      content: entry.content,
      details: entry.details,
      timestamp: entry.timestamp,
    };
  }
  if (entry?.type === "branch_summary") {
    return { role: "branchSummary", summary: entry.summary, fromId: entry.fromId, timestamp: entry.timestamp };
  }
  return undefined;
}

function readJsonl(file) {
  return readFileSync(file, "utf8")
    .split(/\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

export function prepareSessionCompactionFixture(sessionFile, options = {}) {
  if (!existsSync(sessionFile)) throw new Error(`session file not found: ${sessionFile}`);
  const keepRecentMessages = Math.max(0, Number(options.keepRecentMessages ?? 6));
  const maxMessagesToSummarize = Math.max(1, Number(options.maxMessagesToSummarize ?? 24));
  const entries = readJsonl(sessionFile).filter((entry) => entry.type !== "session");
  const messageEntries = entries
    .map((entry) => ({ entry, message: messageFromEntry(entry) }))
    .filter((item) => item.message);
  if (messageEntries.length <= keepRecentMessages) {
    throw new Error(`not enough messages to compact: messages=${messageEntries.length}, keepRecentMessages=${keepRecentMessages}`);
  }

  const summarizeItems = messageEntries.slice(0, Math.max(0, messageEntries.length - keepRecentMessages));
  const keptItems = messageEntries.slice(-keepRecentMessages);
  const cappedSummarizeItems = summarizeItems.slice(-maxMessagesToSummarize);
  const messagesToSummarize = cappedSummarizeItems.map((item) => item.message);
  const keptMessages = keptItems.map((item) => item.message);
  const latestCompaction = [...entries].reverse().find((entry) => entry.type === "compaction" && entry.summary);
  const serializedAll = serializeFactoryCompactionMessages(messageEntries.map((item) => item.message));
  const fileOps = extractFileOpsFromMessages(messagesToSummarize);
  const ext = extname(sessionFile);
  const workerId = basename(sessionFile, ext || undefined);

  return {
    sessionFile,
    workerId,
    entries: entries.length,
    messageCount: messageEntries.length,
    keptMessages,
    preparation: {
      firstKeptEntryId: keptItems[0]?.entry?.id || entries.at(-1)?.id || "",
      messagesToSummarize,
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: estimateTokensFromText(serializedAll),
      previousSummary: latestCompaction?.summary,
      fileOps,
      settings: {
        enabled: true,
        reserveTokens: 16_384,
        keepRecentTokens: estimateTokensFromText(serializeFactoryCompactionMessages(keptMessages)),
      },
    },
  };
}

function extractTextFromUnknown(value, depth = 0) {
  if (depth > 6 || value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => extractTextFromUnknown(item, depth + 1)).filter(Boolean).join("\n");
  if (!isObject(value)) return "";
  if (value.type === "text" && typeof value.text === "string") return value.text;
  if (typeof value.text === "string") return value.text;
  if (typeof value.output === "string") return value.output;
  if (typeof value.message === "string") return value.message;
  if (value.content) return extractTextFromUnknown(value.content, depth + 1);
  if (value.items) return extractTextFromUnknown(value.items, depth + 1);
  return "";
}

export async function runCodexCompaction({
  worker = {},
  preparation,
  reason = "manual",
  customInstructions = "",
  cwd = process.cwd(),
  model = "gpt-5.5",
  codexServerUrl = DEFAULT_CODEX_SERVER_URL,
  workersDir = process.cwd(),
  timeoutMs = DEFAULT_CODEX_COMPACTION_TIMEOUT_MS,
  maxConversationChars = DEFAULT_MAX_CONVERSATION_CHARS,
  targetType = worker.targetType || "worker",
} = {}) {
  const request = buildFactoryCompactionRequest({
    worker,
    preparation,
    reason,
    customInstructions,
    maxConversationChars,
    targetType,
  });

  const normalizedModel = normalizeCodexModel(model) || model;
  await ensureCodexAppServer(codexServerUrl, { workersDir, timeoutMs: 15_000 });

  const client = new CodexAppServerClient(codexServerUrl);
  let output = "";
  let activeTurnId = "";
  let completedTurn = null;
  let latestUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 };
  let resolveCompleted;
  let rejectCompleted;
  const completed = new Promise((resolve, reject) => {
    resolveCompleted = resolve;
    rejectCompleted = reject;
  });
  const timer = setTimeout(() => rejectCompleted(new Error(`Timed out waiting for Codex compaction after ${timeoutMs}ms`)), timeoutMs);

  try {
    await client.connect();
    await client.initialize();
    const startThread = await client.request("thread/start", {
      cwd,
      approvalPolicy: "never",
      sandbox: "read-only",
      model: normalizedModel || null,
      baseInstructions: [
        "You are a context compression backend for Pi ox-factory.",
        "Never use tools. Never edit files. Only return the requested structured Markdown summary.",
      ].join("\n"),
      ephemeral: true,
    });
    const threadId = startThread.thread.id;

    client.onNotification((message) => {
      const params = message.params || {};
      if (params.threadId && params.threadId !== threadId) return;
      if (message.method === "item/agentMessage/delta" && params.delta) output += params.delta;
      if (message.method === "thread/tokenUsage/updated") {
        const usage = extractCodexTokenUsage(params);
        if (usage.inputTokens || usage.cachedInputTokens || usage.outputTokens || usage.reasoningOutputTokens || usage.totalTokens) {
          latestUsage = usage;
        }
      }
      if (message.method === "turn/started" && params.turn?.id) activeTurnId = params.turn.id;
      if (message.method === "turn/completed" && params.turn) {
        if (activeTurnId && params.turn.id !== activeTurnId) return;
        completedTurn = params.turn;
        resolveCompleted(params.turn);
      }
      if (message.method === "error") {
        rejectCompleted(new Error(params.message || params.error?.message || "Codex compaction error"));
      }
    });

    const startTurn = await client.request("turn/start", {
      threadId,
      input: [{ type: "text", text: request.prompt, text_elements: [] }],
      cwd,
      model: normalizedModel || null,
      effort: "medium",
    });
    activeTurnId = startTurn.turn.id;
    const turn = await completed;
    clearTimeout(timer);

    if (!output.trim()) output = extractTextFromUnknown(turn || completedTurn);
    const summary = output.trim();
    if (!summary) throw new Error("Codex compaction produced an empty summary");
    if (turn?.status && turn.status !== "completed") {
      throw new Error(`Codex compaction turn ended with status ${turn.status}`);
    }

    return {
      summary,
      firstKeptEntryId: request.firstKeptEntryId,
      tokensBefore: request.tokensBefore,
      estimatedTokensAfter: estimateTokensFromText(summary),
      details: {
        compressor: "codex",
        version: FACTORY_COMPACTION_VERSION,
        model: normalizedModel,
        reason,
        generatedAt: new Date().toISOString(),
        ...request.metadata,
        usage: latestUsage,
      },
    };
  } finally {
    clearTimeout(timer);
    client.close();
  }
}

export function shouldUseFactoryCodexCompaction({ sessionFile = "", scope = "workers" } = {}) {
  const target = resolveCompactionTarget(sessionFile, { scope });
  return targetMatchesScope(target, scope);
}

export async function handleFactoryCompactionEvent(event, ctx, options = {}) {
  const sessionFile = ctx?.sessionManager?.getSessionFile?.() || "";
  const modeSetting = getCompactionModeSetting(options);
  const configuredScope = options.scope ?? process.env.OX_FACTORY_CODEX_COMPACTION_SCOPE;
  const initialScope = configuredScope || "workers";
  const target = resolveCompactionTarget(sessionFile, { ...options, scope: initialScope });
  const scope = configuredScope || (target.targetType === "main" ? "main" : "workers");
  const targetInScope = targetMatchesScope(target, scope);
  const mode = (!modeSetting.explicit && targetInScope && (target.targetType === "main" || target.targetType === "worker"))
    ? "shadow"
    : modeSetting.mode;
  if (mode === "off") return undefined;
  if (!targetInScope) return undefined;
  if (target.targetType === "worker" && !isWorkerAllowed(target.worker, options)) return undefined;
  if (target.targetType === "main" && mode === "apply" && options.allowMainApply !== true && process.env.OX_FACTORY_CODEX_COMPACTION_ALLOW_MAIN_APPLY !== "1") {
    ctx?.ui?.notify?.("主 agent Codex 压缩只允许 shadow 评估，不会替换 Pi 默认压缩。", "warning");
    return undefined;
  }

  if (mode === "shadow") {
    const key = shadowKey({
      sessionFile,
      firstKeptEntryId: event?.preparation?.firstKeptEntryId,
      tokensBefore: event?.preparation?.tokensBefore,
    });
    startShadowCompaction({ key, sessionFile, target, event, ctx, options });
    return undefined;
  }

  try {
    const runFn = options.runCodexCompactionFn || runCodexCompaction;
    const compaction = await runFn({
      worker: { id: target.worker, role: target.role, targetType: target.targetType },
      preparation: event.preparation,
      reason: event.reason,
      customInstructions: event.customInstructions,
      cwd: ctx?.cwd || process.cwd(),
      model: options.model || process.env.OX_FACTORY_CODEX_COMPACTION_MODEL || "gpt-5.5",
      codexServerUrl: options.codexServerUrl || process.env.OX_CODEX_APP_SERVER_URL || DEFAULT_CODEX_SERVER_URL,
      workersDir: options.workersDir || process.cwd(),
      targetType: target.targetType,
    });
    return { compaction };
  } catch (error) {
    ctx?.ui?.notify?.(`Codex 压缩失败，回退 Pi 默认压缩：${error?.message || String(error)}`, "warning");
    return undefined;
  }
}

export async function handleFactoryCompactionCompleted(event, ctx, options = {}) {
  const workersDir = options.workersDir || process.cwd();
  const sessionFile = ctx?.sessionManager?.getSessionFile?.() || "";
  const key = shadowKey({
    sessionFile,
    firstKeptEntryId: event?.compactionEntry?.firstKeptEntryId,
    tokensBefore: event?.compactionEntry?.tokensBefore,
  });
  const pending = pendingShadowCompactions.get(key);
  if (!pending) return undefined;
  pendingShadowCompactions.delete(key);

  const write = async () => {
    const { result, error } = await pending.promise;
    const record = buildShadowRecord({
      workersDir,
      sessionFile,
      worker: pending.target?.worker || workerIdFromSessionFile(sessionFile),
      targetType: pending.target?.targetType || "worker",
      reason: event?.reason || pending.reason,
      startedAt: pending.startedAt,
      piEntry: event?.compactionEntry,
      codexResult: result,
      codexError: error,
    });
    return writeShadowRecord(workersDir, record);
  };

  if (options.awaitShadowWrite) return write();
  void write().catch((error) => {
    ctx?.ui?.notify?.(`Codex shadow 压缩对比记录失败：${error?.message || String(error)}`, "warning");
  });
  return { scheduled: true };
}

export function readFactoryCompactionShadowRecords(workersDir, { limit = 50, worker, targetType } = {}) {
  const file = shadowJsonlFile(workersDir);
  if (!existsSync(file)) return [];
  const records = readFileSync(file, "utf8")
    .split(/\n/)
    .filter((line) => line.trim())
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
  const filtered = records.filter((record) => {
    if (worker && record.worker !== worker) return false;
    if (targetType && (record.targetType || "worker") !== targetType) return false;
    return true;
  });
  return filtered.slice(-Math.max(1, Number(limit) || 50)).reverse();
}

export function buildFactoryCompactionReport({ workersDir, limit = 20, worker, targetType } = {}) {
  const records = readFactoryCompactionShadowRecords(workersDir, { limit, worker, targetType });
  const totals = records.reduce((acc, record) => {
    acc.records += 1;
    if (record.codex?.status === "done") acc.codexDone += 1;
    if (record.codex?.status === "failed") acc.codexFailed += 1;
    acc.piTokens += Number(record.pi?.estimatedTokens || 0);
    acc.codexTokens += Number(record.codex?.estimatedTokens || 0);
    acc.codexLatencyMs += Number(record.codex?.latencyMs || 0);
    return acc;
  }, { records: 0, codexDone: 0, codexFailed: 0, piTokens: 0, codexTokens: 0, codexLatencyMs: 0 });
  if (totals.codexDone > 0) totals.avgCodexLatencyMs = Math.round(totals.codexLatencyMs / totals.codexDone);
  return {
    generatedAt: new Date().toISOString(),
    workersDir,
    worker: worker || "",
    targetType: targetType || "",
    limit,
    totals,
    records,
  };
}

function compactNumber(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return "0";
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function formatFactoryCompactionReport(report) {
  const lines = [
    `# 压缩对比报告 — ${report.generatedAt?.slice(0, 10) || ""}`,
    "",
    `> 数据源：${join(report.workersDir || ".pi/workers", SHADOW_JSONL)}`,
    "",
    "## 总览",
    "",
    `- 对比记录：${report.totals.records}`,
    `- Codex 成功：${report.totals.codexDone}`,
    `- Codex 失败：${report.totals.codexFailed}`,
    `- Pi 摘要估算：${compactNumber(report.totals.piTokens)} tokens`,
    `- Codex 摘要估算：${compactNumber(report.totals.codexTokens)} tokens`,
    report.totals.avgCodexLatencyMs ? `- Codex 平均耗时：${report.totals.avgCodexLatencyMs}ms` : "",
    "",
  ].filter((line) => line !== "");

  if (report.records.length === 0) {
    lines.push("暂无 shadow 压缩对比记录。");
    return lines.join("\n");
  }

  lines.push("## 最近记录", "");
  lines.push("| 时间 | 对象 | 员工/会话 | 决策 | Pi 长度/估算 | Codex 状态 | Codex 长度/估算 | Codex 耗时 | 结构命中 |");
  lines.push("| --- | --- | --- | --- | ---: | --- | ---: | ---: | --- |");
  for (const record of report.records) {
    const hits = [
      record.codex?.hasFactoryContext ? "工厂" : "",
      record.codex?.hasNextTurnInstructions ? "下一步" : "",
      record.codex?.hasCommandsVerification ? "验证" : "",
    ].filter(Boolean).join("、") || "—";
    lines.push([
      record.time || "-",
      record.targetType || "worker",
      record.worker || "-",
      record.decision || "shadow",
      `${record.pi?.summaryChars ?? 0}/${record.pi?.estimatedTokens ?? 0}`,
      record.codex?.status || "-",
      `${record.codex?.summaryChars ?? 0}/${record.codex?.estimatedTokens ?? 0}`,
      record.codex?.latencyMs ?? "-",
      hits,
    ].join(" | ").replace(/^/, "| ").replace(/$/, " |"));
  }

  lines.push("", "## 文件");
  for (const record of report.records.slice(0, 10)) {
    lines.push(`- ${record.worker || "-"} ${record.time || ""}: Pi=\`${record.pi?.summaryFile || "-"}\` Codex=\`${record.codex?.summaryFile || "-"}\``);
  }
  return lines.join("\n");
}

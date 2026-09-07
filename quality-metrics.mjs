import { summarizeApiCosts, readApiPrices } from "./api-cost.mjs";
import { summarizeModelExecution } from "./model-execution-stats.mjs";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import { listJobs } from "./jobs.mjs";

/** fallback: read API key from Pi's auth.json when env var is missing */
function readAuthApiKey(provider) {
  try {
    const authPath = join(homedir(), ".pi", "agent", "auth.json");
    if (!existsSync(authPath)) return null;
    const auth = JSON.parse(readFileSync(authPath, "utf8"));
    return auth?.[provider]?.key || null;
  } catch { return null; }
}

const QUALITY_CONFIG_FILE = "quality-monitor.json";
const EMOTION_JSONL = "quality-emotion.jsonl";
const DEFAULT_LIMIT = 100;
const MAX_HISTORY_TURNS = 100000;
const MAX_REASONABLE_RESPONSE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_REASONABLE_TEXT_CHARS = 2_000_000;
const TERMINAL_STATUSES = new Set(["done", "failed", "aborted", "stale"]);

const DEFAULT_CONFIG = {
  version: 1,
  enabled: false,
  provider: "deepseek",
  endpoint: "https://api.deepseek.com/v1/chat/completions",
  model: "deepseek-chat",
  apiKeyEnv: "DEEPSEEK_API_KEY",
  scoreScale: "1=强烈不满/情绪差，3=中性，5=满意/情绪好",
  updatedAt: "",
  updatedBy: "",
};

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(file) {
  mkdirSync(dirname(file), { recursive: true });
}

function readJsonFile(file, fallback) {
  if (!existsSync(file)) return { ...fallback };
  try {
    return { ...fallback, ...JSON.parse(readFileSync(file, "utf8")) };
  } catch {
    return { ...fallback };
  }
}

function writeJsonFile(file, value) {
  ensureDir(file);
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function appendJsonl(file, value) {
  ensureDir(file);
  appendFileSync(file, `${JSON.stringify(value)}\n`, "utf8");
}

function readJsonl(file) {
  if (!existsSync(file)) return [];
  return parseJsonlText(readFileSync(file, "utf8"));
}

function parseJsonlText(text) {
  return String(text || "")
    .split(/\n/)
    .filter((line) => line.trim())
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function qualityConfigFile(workersDir) {
  return join(workersDir, QUALITY_CONFIG_FILE);
}

function emotionFile(workersDir) {
  return join(workersDir, EMOTION_JSONL);
}

export function readQualityMonitorConfig(workersDir) {
  const config = readJsonFile(qualityConfigFile(workersDir), DEFAULT_CONFIG);
  return normalizeQualityMonitorConfig(config);
}

export function writeQualityMonitorConfig(workersDir, patch = {}) {
  const previous = readQualityMonitorConfig(workersDir);
  const next = normalizeQualityMonitorConfig({
    ...previous,
    ...patch,
    updatedAt: nowIso(),
  });
  writeJsonFile(qualityConfigFile(workersDir), next);
  return next;
}

function normalizeQualityMonitorConfig(config = {}) {
  const provider = String(config.provider || DEFAULT_CONFIG.provider).trim() || DEFAULT_CONFIG.provider;
  const endpoint = String(config.endpoint || defaultEndpoint(provider)).trim();
  return {
    ...DEFAULT_CONFIG,
    ...config,
    enabled: Boolean(config.enabled),
    provider,
    endpoint,
    model: String(config.model || defaultModel(provider)).trim() || defaultModel(provider),
    apiKeyEnv: String(config.apiKeyEnv || defaultApiKeyEnv(provider)).trim() || defaultApiKeyEnv(provider),
  };
}

function defaultEndpoint(provider) {
  const value = String(provider || "").toLowerCase();
  if (value === "minimax") return "https://api.minimax.chat/v1/text/chatcompletion_v2";
  return DEFAULT_CONFIG.endpoint;
}

function defaultModel(provider) {
  const value = String(provider || "").toLowerCase();
  if (value === "minimax") return "MiniMax-M1";
  return DEFAULT_CONFIG.model;
}

function defaultApiKeyEnv(provider) {
  const value = String(provider || "").toLowerCase();
  if (value === "minimax") return "MINIMAX_API_KEY";
  return DEFAULT_CONFIG.apiKeyEnv;
}

function isObject(value) {
  return value !== null && typeof value === "object";
}

function contentToText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(contentToText).filter(Boolean).join("\n");
  if (isObject(content)) {
    if (typeof content.text === "string") return content.text;
    if (typeof content.thinking === "string") return content.thinking;
    if (content.content) return contentToText(content.content);
    try { return JSON.stringify(content); } catch { return ""; }
  }
  return String(content ?? "");
}

function messageText(message = {}) {
  if (!isObject(message)) return "";
  if (message.role && message.content != null) return contentToText(message.content);
  if (message.message) return messageText(message.message);
  return contentToText(message.content || message.text || message.summary || "");
}

function estimateTokens(text) {
  return Math.ceil(String(text || "").length / 4);
}

function localDateString(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function durationMs(job = {}) {
  if (Number.isFinite(Number(job.elapsedSeconds))) return Math.max(0, Math.round(Number(job.elapsedSeconds) * 1000));
  const start = new Date(job.startedAt || job.createdAt || "");
  const end = new Date(job.finishedAt || job.updatedAt || "");
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return 0;
  return Math.max(0, end.getTime() - start.getTime());
}

function readEventStats(job = {}) {
  const stats = {
    toolCalls: 0,
    doneText: "",
    textOutput: "",
    parseErrors: 0,
    eventCount: 0,
  };
  if (!job.eventFile || !existsSync(job.eventFile)) return stats;
  let text = "";
  try {
    text = readFileSync(job.eventFile, "utf8");
  } catch {
    return { ...stats, parseErrors: 1 };
  }
  for (const line of text.split(/\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      stats.parseErrors += 1;
      continue;
    }
    stats.eventCount += 1;
    if (event.type === "tool_start") stats.toolCalls += 1;
    if (event.type === "done" && (event.text || event.message)) {
      stats.doneText = String(event.text || event.message || "");
    }
    if (event.type === "text" && event.text && stats.textOutput.length < MAX_REASONABLE_TEXT_CHARS) {
      stats.textOutput += String(event.text);
    }
  }
  return stats;
}

function outputTextForJob(job = {}, eventStats = {}) {
  if (job.fullOutput) return String(job.fullOutput);
  if (job.summary) return String(job.summary);
  if (eventStats.doneText) return String(eventStats.doneText);
  return eventStats.textOutput || String(job.error || "");
}

function sessionFileForWorker(workersDir, worker) {
  return join(workersDir, "sessions", `${worker}.jsonl`);
}

function readSessionData(workersDir, worker, cache) {
  const file = sessionFileForWorker(workersDir, worker);
  if (cache?.has(file)) return cache.get(file);
  let data;
  if (!existsSync(file)) {
    data = { file, exists: false, entries: [], bytes: 0 };
  } else {
    try {
      const text = readFileSync(file, "utf8");
      data = { file, exists: true, entries: parseJsonlText(text), bytes: Buffer.byteLength(text, "utf8") };
    } catch {
      data = { file, exists: false, entries: [], bytes: 0 };
    }
  }
  cache?.set(file, data);
  return data;
}

function entryTimeMs(entry) {
  const raw = entry?.timestamp || entry?.time || entry?.createdAt || entry?.updatedAt || "";
  if (!raw) return NaN;
  const date = new Date(raw);
  return Number.isFinite(date.getTime()) ? date.getTime() : NaN;
}

function sessionEntryText(entry) {
  if (!entry || typeof entry !== "object") return "";
  if (entry.type === "message") return messageText(entry.message);
  if (entry.type === "custom_message") return contentToText(entry.content);
  if (entry.type === "branch_summary") return String(entry.summary || "");
  if (entry.type === "compaction") return String(entry.summary || "");
  return "";
}

function isContextMessageEntry(entry) {
  return Boolean(entry && ["message", "custom_message", "branch_summary"].includes(entry.type));
}

function buildActiveSessionContextText(entries = []) {
  const latestCompactionIndex = entries.reduce((latest, entry, index) => (entry?.type === "compaction" ? index : latest), -1);
  if (latestCompactionIndex < 0) {
    return entries.filter(isContextMessageEntry).map(sessionEntryText).filter(Boolean).join("\n");
  }

  const compaction = entries[latestCompactionIndex];
  const activeParts = [String(compaction.summary || "")].filter(Boolean);

  let foundFirstKept = false;
  for (let i = 0; i < latestCompactionIndex; i += 1) {
    const entry = entries[i];
    if (entry?.id && entry.id === compaction.firstKeptEntryId) foundFirstKept = true;
    if (foundFirstKept && isContextMessageEntry(entry)) {
      const text = sessionEntryText(entry);
      if (text) activeParts.push(text);
    }
  }

  for (let i = latestCompactionIndex + 1; i < entries.length; i += 1) {
    const entry = entries[i];
    if (isContextMessageEntry(entry)) {
      const text = sessionEntryText(entry);
      if (text) activeParts.push(text);
    }
  }

  return activeParts.join("\n");
}

function readSessionStats(workersDir, worker, options = {}) {
  const data = readSessionData(workersDir, worker, options.cache);
  const file = data.file;
  const asOf = options.at || "";
  const asOfMs = asOf ? new Date(asOf).getTime() : NaN;
  if (!data.exists) {
    return {
      sessionFile: file,
      exists: false,
      asOf,
      messageCount: 0,
      userTurns: 0,
      assistantTurns: 0,
      compactionCount: 0,
      latestCompactionAt: null,
      latestTokensBefore: 0,
      estimatedContextTokens: 0,
      activeContextTokens: 0,
      sessionFileTokens: 0,
      bytes: 0,
    };
  }

  const entries = data.entries.filter((entry) => {
    const ts = entryTimeMs(entry);
    return !(Number.isFinite(asOfMs) && Number.isFinite(ts) && ts > asOfMs);
  });
  let sessionFileText = "";
  let messageCount = 0;
  let userTurns = 0;
  let assistantTurns = 0;
  let compactionCount = 0;
  let latestCompactionAt = null;
  let latestTokensBefore = 0;

  for (const entry of entries) {
    if (entry.type === "message") {
      messageCount += 1;
      const role = entry.message?.role || "";
      if (role === "user") userTurns += 1;
      if (role === "assistant") assistantTurns += 1;
      sessionFileText += `\n${messageText(entry.message)}`;
    } else if (entry.type === "compaction") {
      compactionCount += 1;
      latestCompactionAt = entry.timestamp || latestCompactionAt;
      latestTokensBefore = Number(entry.tokensBefore || latestTokensBefore || 0);
      sessionFileText += `\n${entry.summary || ""}`;
    } else if (entry.type === "custom_message" || entry.type === "branch_summary") {
      sessionFileText += `\n${sessionEntryText(entry)}`;
    }
  }

  const activeContextTokens = estimateTokens(buildActiveSessionContextText(entries));
  const sessionFileTokens = estimateTokens(sessionFileText);

  return {
    sessionFile: file,
    exists: true,
    asOf,
    messageCount,
    userTurns,
    assistantTurns,
    compactionCount,
    latestCompactionAt,
    latestTokensBefore,
    estimatedContextTokens: activeContextTokens,
    activeContextTokens,
    sessionFileTokens,
    bytes: data.bytes,
  };
}

function listSessionWorkers(workersDir) {
  const dir = join(workersDir, "sessions");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => name.replace(/\.jsonl$/, ""));
}

function readEmotionRecords(workersDir) {
  return readJsonl(emotionFile(workersDir));
}

function latestEmotionByJob(records = []) {
  const map = new Map();
  for (const record of records) {
    if (record.jobId) map.set(record.jobId, record);
  }
  return map;
}

function average(values = []) {
  const nums = values.map(Number).filter((n) => Number.isFinite(n));
  if (!nums.length) return 0;
  return Math.round(nums.reduce((sum, n) => sum + n, 0) / nums.length);
}

function averageFloat(values = []) {
  const nums = values.map(Number).filter((n) => Number.isFinite(n));
  if (!nums.length) return null;
  return Math.round((nums.reduce((sum, n) => sum + n, 0) / nums.length) * 10) / 10;
}

function normalizeDateFilter(date) {
  const value = String(date || "").trim().toLowerCase();
  if (!value || value === "all" || value === "*" || value === "history") return { label: value ? "all" : "", date: "" };
  return { label: String(date).trim(), date: String(date).trim() };
}

function normalizeLimit(limit) {
  if (String(limit || "").trim().toLowerCase() === "all") return MAX_HISTORY_TURNS;
  return Math.max(1, Number(limit) || DEFAULT_LIMIT);
}

function dropReasonForJob(job, outputText, responseMs) {
  if (!job || !job.id) return "missing_job_id";
  if (!job.worker) return "missing_worker";
  if (!localDateString(job.createdAt || job.updatedAt)) return "bad_created_at";
  if (!TERMINAL_STATUSES.has(job.status)) return "non_terminal";
  if (!String(job.task || "").trim()) return "empty_input";
  if (!String(outputText || "").trim()) return "empty_output";
  if (String(job.task || "").length > MAX_REASONABLE_TEXT_CHARS) return "input_too_large";
  if (String(outputText || "").length > MAX_REASONABLE_TEXT_CHARS) return "output_too_large";
  if (responseMs > MAX_REASONABLE_RESPONSE_MS) return "response_too_large";
  return "";
}

function addDrop(dropStats, reason) {
  dropStats.total += 1;
  dropStats.byReason[reason] = (dropStats.byReason[reason] || 0) + 1;
}

function summarizeTurnsByDate(turns = []) {
  const map = new Map();
  for (const turn of turns) {
    const date = localDateString(turn.createdAt || turn.updatedAt);
    if (!date) continue;
    if (!map.has(date)) {
      map.set(date, {
        date,
        turns: 0,
        workers: new Set(),
        inputChars: [],
        outputChars: [],
        responseMs: [],
        toolCalls: 0,
        compactions: [],
        emotions: [],
      });
    }
    const item = map.get(date);
    item.turns += 1;
    if (turn.worker) item.workers.add(turn.worker);
    item.inputChars.push(turn.inputChars);
    item.outputChars.push(turn.outputChars);
    item.responseMs.push(turn.responseMs);
    item.toolCalls += turn.toolCalls || 0;
    item.compactions.push(turn.sessionCompactions || 0);
    if (turn.emotionScore != null) item.emotions.push(turn.emotionScore);
  }
  return [...map.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((item) => ({
      date: item.date,
      turns: item.turns,
      workers: item.workers.size,
      avgInputChars: average(item.inputChars),
      avgOutputChars: average(item.outputChars),
      avgResponseMs: average(item.responseMs),
      toolCalls: item.toolCalls,
      maxSessionCompactions: Math.max(0, ...item.compactions.map(Number).filter((n) => Number.isFinite(n))),
      avgEmotionScore: averageFloat(item.emotions),
    }));
}

export function appendEmotionScore(workersDir, record = {}) {
  const normalized = {
    type: "emotion_score",
    id: record.id || `emo_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: record.createdAt || nowIso(),
    jobId: String(record.jobId || ""),
    worker: String(record.worker || ""),
    score: normalizeEmotionScore(record.score),
    label: record.label || "",
    reason: record.reason || "",
    provider: record.provider || "manual",
    model: record.model || "",
  };
  appendJsonl(emotionFile(workersDir), normalized);
  return normalized;
}

export function normalizeEmotionScore(value) {
  const score = Math.round(Number(value));
  if (!Number.isFinite(score)) return null;
  return Math.max(1, Math.min(5, score));
}

export function buildFactoryQualityReport({ workersDir, date, limit = DEFAULT_LIMIT, worker } = {}) {
  const config = readQualityMonitorConfig(workersDir);
  const dateFilter = normalizeDateFilter(date);
  const maxTurns = normalizeLimit(limit);
  const apiPrices = readApiPrices(workersDir);
  // 回溯历史时不能先按 limit 截最近 N 条，否则看前几天会被当天新 job 挤掉。
  // jobs 只存轻量 metadata，因此这里扫描足够多历史记录，再做日期过滤和展示截断。
  const scannedJobs = listJobs(workersDir, { worker, limit: 100000 });
  const dropStats = { total: 0, byReason: {} };
  const jobs = scannedJobs
    .filter((job) => !dateFilter.date || localDateString(job.createdAt || job.updatedAt) === dateFilter.date)
    .slice(-maxTurns);
  const emotionByJob = latestEmotionByJob(readEmotionRecords(workersDir));
  const workerNames = [...new Set([
    ...listSessionWorkers(workersDir),
    ...jobs.map((job) => job.worker).filter(Boolean),
  ])].filter((name) => !worker || name === worker).sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
  const sessionCache = new Map();
  const sessionByWorker = new Map(workerNames.map((name) => [name, readSessionStats(workersDir, name, { cache: sessionCache })]));

  const turns = jobs.map((job) => {
    const eventStats = readEventStats(job);
    const outputText = outputTextForJob(job, eventStats);
    const responseMs = durationMs(job);
    const dropReason = dropReasonForJob(job, outputText, responseMs);
    if (dropReason) {
      addDrop(dropStats, dropReason);
      return null;
    }
    const emotion = emotionByJob.get(job.id) || null;
    const session = readSessionStats(workersDir, job.worker, {
      at: job.createdAt || job.startedAt || job.updatedAt,
      cache: sessionCache,
    });
    const taskText = String(job.task || "");
    const summaryText = String(job.summary || "");
    const inputTokens = Number(job.inputTokens || 0);
    const cachedInputTokens = Number(job.cachedInputTokens || 0);
    const outputTokens = Number(job.outputTokens || 0);
    const reasoningOutputTokens = Number(job.reasoningOutputTokens || 0);
    const totalTokens = Number(job.totalTokens || 0);
    const totalWithCachedTokens = Number(job.totalWithCachedTokens || 0)
      || inputTokens + cachedInputTokens + outputTokens + reasoningOutputTokens;
    return {
      jobId: job.id,
      worker: job.worker,
      project: job.project || "",
      status: job.status,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      model: job.model || "",
      backend: job.backend || "",
      inputChars: taskText.length,
      taskChars: taskText.length,
      outputChars: outputText.length,
      summaryChars: summaryText.length,
      responseMs,
      elapsedMs: responseMs,
      elapsedSeconds: Number(job.elapsedSeconds || 0) || Math.round(responseMs / 1000),
      toolCalls: eventStats.toolCalls,
      inputTokens,
      cachedInputTokens,
      outputTokens,
      reasoningOutputTokens,
      totalTokens,
      totalWithCachedTokens,
      sessionContextTokens: session.estimatedContextTokens,
      sessionCompactions: session.compactionCount,
      sessionUserTurns: session.userTurns,
      emotionScore: emotion?.score ?? null,
      emotionLabel: emotion?.label || "",
      emotionReason: emotion?.reason || "",
      taskPreview: taskText.slice(0, 120),
      outputPreview: outputText.slice(0, 160),
      contextStrategy: session.asOf ? "session_replay_before_job" : "session_current_snapshot",
    };
  }).filter(Boolean).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

  const turnsByWorker = new Map();
  for (const turn of turns) {
    const list = turnsByWorker.get(turn.worker) || [];
    list.push(turn);
    turnsByWorker.set(turn.worker, list);
  }

  const workers = workerNames.map((name) => {
    const workerTurns = turnsByWorker.get(name) || [];
    const session = sessionByWorker.get(name) || readSessionStats(workersDir, name, { cache: sessionCache });
    return {
      worker: name,
      session,
      jobs: {
        count: workerTurns.length,
        avgInputChars: average(workerTurns.map((turn) => turn.inputChars)),
        avgOutputChars: average(workerTurns.map((turn) => turn.outputChars)),
        avgResponseMs: average(workerTurns.map((turn) => turn.responseMs)),
        toolCalls: workerTurns.reduce((sum, turn) => sum + turn.toolCalls, 0),
        avgEmotionScore: averageFloat(workerTurns.map((turn) => turn.emotionScore).filter((score) => score != null)),
        totalInputTokens: workerTurns.reduce((sum, turn) => sum + turn.inputTokens, 0),
        totalOutputTokens: workerTurns.reduce((sum, turn) => sum + turn.outputTokens, 0),
      },
    };
  });

  return {
    generatedAt: nowIso(),
    date: dateFilter.label,
    workersDir,
    config: publicQualityConfig(config),
    totals: {
      workers: workers.length,
      turns: turns.length,
      scoredTurns: turns.filter((turn) => turn.emotionScore != null).length,
      avgEmotionScore: averageFloat(turns.map((turn) => turn.emotionScore).filter((score) => score != null)),
      avgResponseMs: average(turns.map((turn) => turn.responseMs)),
      toolCalls: turns.reduce((sum, turn) => sum + turn.toolCalls, 0),
      compactions: workers.reduce((sum, item) => sum + item.session.compactionCount, 0),
    },
    workers,
    turns,
    dates: summarizeTurnsByDate(turns),
    apiCost: summarizeApiCosts(jobs, apiPrices),
    costByWorker: workers.map(item => ({worker:item.worker, ...summarizeApiCosts(jobs.filter(job=>job.worker===item.worker), apiPrices)})),
    models: summarizeModelExecution(jobs).map(item => ({...item,
      apiCost: summarizeApiCosts(jobs.filter(job=>(String(job.model || '').trim() || '未记录模型')===item.model), apiPrices),
    })),
    history: {
      backfilled: true,
      exactContextPerTurn: false,
      scannedJobs: scannedJobs.length,
      candidateJobs: jobs.length,
      usableJobs: turns.length,
      droppedJobs: dropStats.total,
      dropReasons: dropStats.byReason,
      contextStrategy: "按员工 session JSONL 时间戳回放到 job.createdAt；缺少时间戳的老记录按可见记录估算。",
    },
  };
}

function publicQualityConfig(config) {
  return {
    enabled: Boolean(config.enabled),
    provider: config.provider,
    endpoint: config.endpoint,
    model: config.model,
    apiKeyEnv: config.apiKeyEnv,
    scoreScale: config.scoreScale,
    updatedAt: config.updatedAt || "",
    updatedBy: config.updatedBy || "",
  };
}

function fmtNumber(value) {
  return Number(value || 0).toLocaleString("en-US");
}

export function formatFactoryQualityReport(report = {}) {
  const lines = [
    "## 工厂回复质量观测",
    "",
    `- 生成时间：${report.generatedAt || "-"}`,
    `- 日期：${report.date || "全部"}`,
    `- 情绪评分：${report.config?.enabled ? "开启" : "关闭"} (${report.config?.provider || "-"}/${report.config?.model || "-"})`,
    `- 样本 turn：${report.totals?.turns || 0}，已评分：${report.totals?.scoredTurns || 0}，平均情绪：${report.totals?.avgEmotionScore ?? "-"}`,
    "",
    "| 员工 | 会话轮次 | 当前上下文 tok | 历史文件 tok | 压缩次数 | Job 样本 | 平均输入字 | 平均输出字 | 平均耗时 | 工具调用 | 平均情绪 |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const worker of report.workers || []) {
    lines.push(`| ${worker.worker} | ${worker.session?.userTurns || 0} | ${fmtNumber(worker.session?.activeContextTokens ?? worker.session?.estimatedContextTokens ?? 0)} | ${fmtNumber(worker.session?.sessionFileTokens || 0)} | ${worker.session?.compactionCount || 0} | ${worker.jobs?.count || 0} | ${worker.jobs?.avgInputChars || 0} | ${worker.jobs?.avgOutputChars || 0} | ${worker.jobs?.avgResponseMs || 0}ms | ${worker.jobs?.toolCalls || 0} | ${worker.jobs?.avgEmotionScore ?? "-"} |`);
  }
  return lines.join("\n");
}

export function buildEmotionScoringPrompt({ userText, assistantText = "" } = {}) {
  return [
    "你是牛马工厂的用户情绪评分器。只根据用户这一轮输入判断用户对上一轮 AI 表现的情绪。",
    "输出 JSON：{\"score\":1-5,\"label\":\"...\",\"reason\":\"...\"}",
    "评分标准：1=强烈不满/生气/认为 AI 没做好；2=不满或明显质疑；3=中性/普通指令；4=满意或认可；5=非常满意/鼓励/强烈正反馈。",
    "注意：低分意味着上一轮回复可能质量差；高分意味着用户情绪好。不要输出多余文本。",
    "",
    `用户输入：${String(userText || "")}`,
    assistantText ? `上一轮 AI 输出摘要：${String(assistantText || "").slice(0, 1000)}` : "上一轮 AI 输出摘要：未提供",
  ].join("\n");
}

export async function scoreUserEmotion({ workersDir, job, userText, assistantText = "", fetchFn = globalThis.fetch } = {}) {
  const config = readQualityMonitorConfig(workersDir);
  if (!config.enabled) return { status: "disabled", score: null };
  const apiKey = process.env[config.apiKeyEnv] || readAuthApiKey(config.provider);
  if (!apiKey) return { status: "missing_api_key", score: null, apiKeyEnv: config.apiKeyEnv, hint: "set env or ensure ~/.pi/agent/auth.json has the key" };
  if (typeof fetchFn !== "function") return { status: "fetch_unavailable", score: null };

  const response = await fetchFn(config.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: "system", content: "You are a strict JSON-only sentiment scorer." },
        { role: "user", content: buildEmotionScoringPrompt({ userText, assistantText }) },
      ],
      temperature: 0,
    }),
  });
  if (!response.ok) return { status: "http_error", score: null, statusCode: response.status, error: await response.text() };
  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content || data?.output_text || "";
  const parsed = parseEmotionContent(content);
  const record = appendEmotionScore(workersDir, {
    jobId: job?.id,
    worker: job?.worker,
    score: parsed.score,
    label: parsed.label,
    reason: parsed.reason,
    provider: config.provider,
    model: config.model,
  });
  return { status: "scored", ...record };
}

function parseEmotionContent(content) {
  const text = String(content || "").trim();
  try {
    const json = JSON.parse(text.replace(/^```json\s*/i, "").replace(/```$/i, ""));
    return {
      score: normalizeEmotionScore(json.score),
      label: String(json.label || ""),
      reason: String(json.reason || ""),
    };
  } catch {
    return {
      score: normalizeEmotionScore(text.match(/[1-5]/)?.[0]),
      label: "",
      reason: text.slice(0, 200),
    };
  }
}

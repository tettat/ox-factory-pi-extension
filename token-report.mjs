import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { basename, join } from "node:path";

import { listJobs } from "./jobs.mjs";

function pad2(value) {
  return String(value).padStart(2, "0");
}

export function localDateString(value = new Date()) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function touchesDate(record, date) {
  return touchedDates(record).includes(date);
}

function touchedDates(record) {
  return [...new Set([
    record?.timestamp,
    record?.time,
    record?.date,
    record?.createdAt,
    record?.startedAt,
    record?.updatedAt,
    record?.finishedAt,
  ].filter(Boolean).map(localDateString).filter(Boolean))];
}

function zeroTokens() {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    totalWithCachedTokens: 0,
  };
}

function numeric(value) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

function firstNumber(...values) {
  for (const value of values) {
    if (value == null) continue;
    const numberValue = Number(value);
    if (Number.isFinite(numberValue)) return numberValue;
  }
  return 0;
}

function normalizeTokens(inputOrUsage, output, total) {
  if (inputOrUsage && typeof inputOrUsage === "object") {
    const usage = inputOrUsage;
    const inputTokens = firstNumber(usage.inputTokens, usage.input_tokens, usage.input, usage.promptTokens, usage.prompt_tokens, usage.prompt);
    const cachedInputTokens =
      firstNumber(usage.cachedInputTokens, usage.cached_input_tokens, usage.cachedInput, usage.cached_input, usage.cached, usage.cacheReadInputTokens, usage.cache_read_input_tokens) +
      firstNumber(usage.cacheRead, usage.cache_read, usage.cache_read_tokens) +
      firstNumber(usage.cacheWrite, usage.cache_write, usage.cache_write_tokens, usage.cacheWrite1h, usage.cache_write_1h, usage.cacheWrite5m, usage.cache_write_5m);
    const outputTokens = firstNumber(usage.outputTokens, usage.output_tokens, usage.output, usage.completionTokens, usage.completion_tokens, usage.completion);
    const reasoningOutputTokens = firstNumber(usage.reasoningOutputTokens, usage.reasoning_output_tokens, usage.reasoningOutput, usage.reasoning_output);
    // Keep `totalTokens` as the legacy provider-neutral total: input + output.
    // Some Pi session entries include cacheRead in usage.totalTokens, while Codex
    // reports cached input as a subset/side field. `totalWithCachedTokens` is the
    // dashboard-like view that makes cached input explicit.
    const totalTokens = inputTokens + outputTokens || firstNumber(usage.totalTokens, usage.total_tokens, usage.total);
    const totalWithCachedTokens = firstNumber(usage.totalWithCachedTokens, usage.total_with_cached_tokens, inputTokens + cachedInputTokens + outputTokens);
    return { inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, totalTokens, totalWithCachedTokens };
  }

  const inputTokens = numeric(inputOrUsage);
  const outputTokens = numeric(output);
  const totalTokens = total == null ? inputTokens + outputTokens : numeric(total);
  return {
    inputTokens,
    cachedInputTokens: 0,
    outputTokens,
    reasoningOutputTokens: 0,
    totalTokens,
    totalWithCachedTokens: inputTokens + outputTokens,
  };
}

function addTokens(target, inputOrUsage, output, total) {
  const usage = normalizeTokens(inputOrUsage, output, total);
  target.inputTokens += usage.inputTokens;
  target.cachedInputTokens += usage.cachedInputTokens;
  target.outputTokens += usage.outputTokens;
  target.reasoningOutputTokens += usage.reasoningOutputTokens;
  target.totalTokens += usage.totalTokens;
  target.totalWithCachedTokens += usage.totalWithCachedTokens;
}

function hasTokens(tokens) {
  return Boolean(
    tokens.inputTokens ||
    tokens.cachedInputTokens ||
    tokens.outputTokens ||
    tokens.reasoningOutputTokens ||
    tokens.totalTokens ||
    tokens.totalWithCachedTokens
  );
}

function createWorkerSummary(worker) {
  return {
    worker,
    session: zeroTokens(),
    job: zeroTokens(),
    reported: zeroTokens(),
    source: "none",
    warnings: [],
  };
}

function ensureWorker(map, worker) {
  const name = String(worker || "未知员工");
  if (!map.has(name)) map.set(name, createWorkerSummary(name));
  return map.get(name);
}

function readJsonl(file) {
  if (!existsSync(file)) return { entries: [], warnings: [] };
  const entries = [];
  const warnings = [];
  readFileSync(file, "utf8").split("\n").forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      warnings.push(`${file}:${index + 1} 不是合法 JSONL，已跳过`);
    }
  });
  return { entries, warnings };
}

function tokenSourceFingerprint(workersDir) {
  const parts = [];
  for (const [dirName, suffix] of [["sessions", ".jsonl"], ["jobs", ".json"]]) {
    const dir = join(workersDir, dirName);
    if (!existsSync(dir)) {
      parts.push(`${dirName}:missing`);
      continue;
    }
    let count = 0;
    let size = 0;
    let maxMtime = 0;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(suffix)) continue;
      const stat = statSync(join(dir, name));
      if (!stat.isFile()) continue;
      count += 1;
      size += stat.size;
      maxMtime = Math.max(maxMtime, Math.trunc(stat.mtimeMs));
    }
    parts.push(`${dirName}:${count}:${size}:${maxMtime}`);
  }
  return parts.join("|");
}

function extractSessionUsage(entry) {
  const usage = entry?.message?.usage || entry?.usage;
  if (!usage || typeof usage !== "object") return null;
  return normalizeTokens(usage);
}

function summarizeSessions(workersDir, date, workerMap, warnings) {
  const sessionsDir = join(workersDir, "sessions");
  if (!existsSync(sessionsDir)) return;
  for (const name of readdirSync(sessionsDir)) {
    if (!name.endsWith(".jsonl")) continue;
    const worker = basename(name, ".jsonl");
    const file = join(sessionsDir, name);
    const result = readJsonl(file);
    warnings.push(...result.warnings);
    const summary = ensureWorker(workerMap, worker);
    for (const entry of result.entries) {
      if (!touchesDate(entry, date)) continue;
      if (entry.type !== "message") continue;
      if (entry.message?.role !== "assistant") continue;
      const usage = extractSessionUsage(entry);
      if (!usage) continue;
      addTokens(summary.session, usage);
    }
  }
}

function summarizeJobs(workersDir, date, workerMap) {
  const jobs = listJobs(workersDir, { limit: 100000 }).filter((job) => touchesDate(job, date));
  for (const job of jobs) {
    const summary = ensureWorker(workerMap, job.worker);
    addTokens(summary.job, job);
  }
}

const tokenIndexCache = new Map();

function buildTokenIndex(workersDir) {
  const dates = new Map();
  const warnings = [];
  const knownSessionWorkers = new Set();

  const ensureDateWorker = (date, worker) => {
    if (!dates.has(date)) dates.set(date, new Map());
    return ensureWorker(dates.get(date), worker);
  };

  const sessionsDir = join(workersDir, "sessions");
  if (existsSync(sessionsDir)) {
    for (const name of readdirSync(sessionsDir)) {
      if (!name.endsWith(".jsonl")) continue;
      const worker = basename(name, ".jsonl");
      knownSessionWorkers.add(worker);
      const file = join(sessionsDir, name);
      const result = readJsonl(file);
      warnings.push(...result.warnings);
      for (const entry of result.entries) {
        if (entry.type !== "message") continue;
        if (entry.message?.role !== "assistant") continue;
        const usage = extractSessionUsage(entry);
        if (!usage) continue;
        for (const date of touchedDates(entry)) {
          addTokens(ensureDateWorker(date, worker).session, usage);
        }
      }
    }
  }

  for (const job of listJobs(workersDir, { limit: 100000 })) {
    for (const date of touchedDates(job)) {
      addTokens(ensureDateWorker(date, job.worker).job, job);
    }
  }

  return { dates, warnings, knownSessionWorkers };
}

function getTokenIndex(workersDir) {
  const fingerprint = tokenSourceFingerprint(workersDir);
  const cached = tokenIndexCache.get(workersDir);
  if (cached?.fingerprint === fingerprint) return cached.index;
  const index = buildTokenIndex(workersDir);
  tokenIndexCache.set(workersDir, { fingerprint, index });
  return index;
}

function cloneTokens(tokens) {
  return { ...zeroTokens(), ...(tokens || {}) };
}

function cloneSummary(summary) {
  return {
    worker: summary.worker,
    session: cloneTokens(summary.session),
    job: cloneTokens(summary.job),
    reported: zeroTokens(),
    source: "none",
    warnings: [...(summary.warnings || [])],
  };
}

function buildReportFromIndex(index, { date, worker } = {}) {
  const reportDate = localDateString(date || new Date());
  const sourceMap = index.dates.get(reportDate) || new Map();
  const warnings = [...(index.warnings || [])];
  const reportMap = new Map();
  for (const name of index.knownSessionWorkers || []) {
    reportMap.set(name, createWorkerSummary(name));
  }
  for (const summary of sourceMap.values()) {
    reportMap.set(summary.worker, cloneSummary(summary));
  }
  const summaries = [...reportMap.values()];

  for (const summary of summaries) chooseReported(summary);
  let workers = sortWorkers(summaries);
  if (worker) workers = workers.filter((item) => item.worker === worker);

  const totals = zeroTokens();
  for (const summary of workers) {
    addTokens(totals, summary.reported);
  }

  return {
    date: reportDate,
    generatedAt: new Date().toISOString(),
    workers,
    totals,
    warnings,
  };
}

function chooseReported(summary) {
  if (hasTokens(summary.session)) {
    summary.reported = { ...summary.session };
    summary.source = "session";
    if (hasTokens(summary.job)) {
      summary.warnings.push("同时存在 session/job token；已按 session 口径上报，避免重复相加。");
    }
    return;
  }
  if (hasTokens(summary.job)) {
    summary.reported = { ...summary.job };
    summary.source = "job";
    return;
  }
  summary.reported = zeroTokens();
  summary.source = "none";
}

function sortWorkers(workers) {
  return workers.sort((a, b) => {
    if (a.reported.totalWithCachedTokens !== b.reported.totalWithCachedTokens) return b.reported.totalWithCachedTokens - a.reported.totalWithCachedTokens;
    if (a.reported.totalTokens !== b.reported.totalTokens) return b.reported.totalTokens - a.reported.totalTokens;
    return a.worker.localeCompare(b.worker, "zh-Hans-CN");
  });
}

export function buildFactoryTokenReport({ workersDir, date, worker } = {}) {
  if (!workersDir) throw new Error("workersDir is required");
  return buildReportFromIndex(getTokenIndex(workersDir), { date, worker });
}

export function buildFactoryTokenTrend({ workersDir, days = 7, endDate = new Date() } = {}) {
  if (!workersDir) throw new Error("workersDir is required");
  const normalizedDays = Math.min(60, Math.max(1, Number(days) || 7));
  const index = getTokenIndex(workersDir);
  const dayList = [];
  const today = endDate instanceof Date ? endDate : new Date(endDate);
  for (let i = normalizedDays - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const dateStr = localDateString(d);
    const r = buildReportFromIndex(index, { date: dateStr });
    dayList.push({
      date: dateStr,
      totalTokens: r.totals.totalTokens,
      totalWithCachedTokens: r.totals.totalWithCachedTokens,
      inputTokens: r.totals.inputTokens,
      outputTokens: r.totals.outputTokens,
      cachedInputTokens: r.totals.cachedInputTokens,
      reasoningOutputTokens: r.totals.reasoningOutputTokens,
    });
  }
  return {
    generatedAt: new Date().toISOString(),
    days: dayList,
    summary: {
      totalDays: dayList.length,
      totalWithCachedTokens: dayList.reduce((a, b) => a + (b.totalWithCachedTokens || 0), 0),
      avgWithCachedTokens: dayList.length
        ? Math.round(dayList.reduce((a, b) => a + (b.totalWithCachedTokens || 0), 0) / dayList.length)
        : 0,
    },
  };
}

function formatTokenCount(value) {
  const numberValue = Number(value || 0);
  if (!Number.isFinite(numberValue) || numberValue === 0) return "0";
  const sign = numberValue < 0 ? "-" : "";
  const absolute = Math.abs(numberValue);
  if (absolute >= 1_000_000) return `${sign}${(absolute / 1_000_000).toFixed(2)}M`;
  if (absolute >= 1_000) {
    const thousands = absolute / 1_000;
    return `${sign}${Number.isInteger(thousands) ? String(thousands) : thousands.toFixed(2)}K`;
  }
  return `${sign}${new Intl.NumberFormat("en-US").format(absolute)}`;
}

export function formatFactoryTokenReport(report) {
  const lines = [
    `# 工厂 Token 报告 — ${report.date}`,
    "",
    "| 员工 | 输入 Token | 缓存输入 Token | 输出 Token | 推理输出 Token | 总 Token | 含缓存合计 | 数据来源 | 备注 |",
    "|---|---:|---:|---:|---:|---:|---:|---|---|",
  ];

  if (report.workers.length === 0) {
    lines.push("| — | 0 | 0 | 0 | 0 | 0 | 0 | none | 当日暂无 token 记录 |");
  } else {
    for (const worker of report.workers) {
      lines.push(
        `| ${worker.worker} | ${formatTokenCount(worker.reported.inputTokens)} | ${formatTokenCount(worker.reported.cachedInputTokens)} | ${formatTokenCount(worker.reported.outputTokens)} | ${formatTokenCount(worker.reported.reasoningOutputTokens)} | ${formatTokenCount(worker.reported.totalTokens)} | ${formatTokenCount(worker.reported.totalWithCachedTokens)} | ${worker.source} | ${worker.warnings.join("<br>") || "—"} |`,
      );
    }
  }

  lines.push("");
  lines.push("## 合计");
  lines.push("");
  lines.push(`- 输入 Token：${formatTokenCount(report.totals.inputTokens)}`);
  lines.push(`- 缓存输入 Token：${formatTokenCount(report.totals.cachedInputTokens)}`);
  lines.push(`- 输出 Token：${formatTokenCount(report.totals.outputTokens)}`);
  lines.push(`- 推理输出 Token：${formatTokenCount(report.totals.reasoningOutputTokens)}`);
  lines.push(`- 总 Token（输入+输出 / provider total）：${formatTokenCount(report.totals.totalTokens)}`);
  lines.push(`- 含缓存合计（输入+缓存输入+输出）：${formatTokenCount(report.totals.totalWithCachedTokens)}`);

  if (report.warnings.length > 0) {
    lines.push("");
    lines.push("## 数据警告");
    for (const warning of report.warnings) lines.push(`- ${warning}`);
  }

  return lines.join("\n");
}

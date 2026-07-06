#!/usr/bin/env node
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

import { listJobs, writeJob } from "./jobs.mjs";
import { buildFactoryTokenReport } from "./token-report.mjs";

const TOKEN_KEYS = [
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "totalTokens",
  "totalWithCachedTokens",
];

function zeroUsage() {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    totalWithCachedTokens: 0,
  };
}

function firstNumber(...values) {
  for (const value of values) {
    if (value == null) continue;
    const numberValue = Number(value);
    if (Number.isFinite(numberValue)) return numberValue;
  }
  return 0;
}

export function normalizeCodexUsage(value) {
  if (!value || typeof value !== "object") return zeroUsage();
  const inputTokens = firstNumber(value.inputTokens, value.input_tokens, value.input, value.promptTokens, value.prompt_tokens);
  const cachedInputTokens = firstNumber(
    value.cachedInputTokens,
    value.cached_input_tokens,
    value.cachedInput,
    value.cached_input,
    value.cached,
    value.cacheReadInputTokens,
    value.cache_read_input_tokens,
  );
  const outputTokens = firstNumber(value.outputTokens, value.output_tokens, value.output, value.completionTokens, value.completion_tokens);
  const reasoningOutputTokens = firstNumber(
    value.reasoningOutputTokens,
    value.reasoning_output_tokens,
    value.reasoningOutput,
    value.reasoning_output,
  );
  const totalTokens = firstNumber(value.totalTokens, value.total_tokens, value.total, inputTokens + outputTokens);
  const totalWithCachedTokens = firstNumber(
    value.totalWithCachedTokens,
    value.total_with_cached_tokens,
    inputTokens + cachedInputTokens + outputTokens,
  );
  return { inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, totalTokens, totalWithCachedTokens };
}

export function subtractUsage(after, before = zeroUsage()) {
  const normalizedAfter = normalizeCodexUsage(after);
  const normalizedBefore = normalizeCodexUsage(before);
  const result = zeroUsage();
  for (const key of TOKEN_KEYS) {
    result[key] = Math.max(0, (normalizedAfter[key] || 0) - (normalizedBefore[key] || 0));
  }
  return result;
}

function addUsage(target, usage) {
  const normalized = normalizeCodexUsage(usage);
  for (const key of TOKEN_KEYS) target[key] += normalized[key] || 0;
  return target;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function parseTimezoneOffset(value) {
  if (!value) return 8 * 60;
  if (value === "local") return -new Date().getTimezoneOffset();
  const match = /^([+-])(\d{2}):?(\d{2})?$/.exec(String(value));
  if (!match) throw new Error(`invalid timezone offset: ${value}`);
  const sign = match[1] === "-" ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3] || 0));
}

export function localDateStringWithOffset(value = new Date(), offsetMinutes = 8 * 60) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const shifted = new Date(date.getTime() + offsetMinutes * 60 * 1000);
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
}

function localTimeStringWithOffset(value, offsetMinutes = 8 * 60) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const shifted = new Date(date.getTime() + offsetMinutes * 60 * 1000);
  return `${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())}:${pad2(shifted.getUTCSeconds())}`;
}

function lineTimestamp(record) {
  return record?.timestamp || record?.ts || record?.time || record?.created_at || record?.createdAt || "";
}

function extractUserText(payload) {
  const direct = payload?.message || payload?.text || payload?.input;
  if (typeof direct === "string") return direct;
  const parts = [];
  const visit = (value) => {
    if (value == null) return;
    if (typeof value === "string") {
      parts.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value === "object") {
      if (typeof value.text === "string") parts.push(value.text);
      else if (typeof value.content === "string") parts.push(value.content);
      else if (Array.isArray(value.content)) visit(value.content);
    }
  };
  visit(payload?.items || payload?.content || payload?.message);
  return parts.join("\n").trim();
}

function tokenUsageFromPayload(payload) {
  const info = payload?.info || payload?.usage || payload;
  return info?.total_token_usage || info?.totalTokenUsage || info?.total || payload?.total_token_usage || payload?.totalTokenUsage;
}

export function parseCodexRolloutLines(lines, { date, timezoneOffsetMinutes = 8 * 60 } = {}) {
  const segments = [];
  let latestTotalUsage = zeroUsage();
  let current = null;

  const finishCurrent = (timestamp) => {
    if (!current) return;
    const endUsage = latestTotalUsage;
    const delta = subtractUsage(endUsage, current.beforeUsage);
    const segment = {
      ...current,
      endAt: timestamp || current.endAt || current.startAt,
      endUsage,
      usage: delta,
      date: localDateStringWithOffset(current.startAt, timezoneOffsetMinutes),
    };
    if (!date || segment.date === date) segments.push(segment);
    current = null;
  };

  for (const rawLine of lines) {
    const line = String(rawLine || "").trim();
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = record?.payload || {};
    const type = payload?.type || record?.type;
    const timestamp = lineTimestamp(record) || new Date().toISOString();

    if (type === "token_count" || payload?.info?.total_token_usage || payload?.total_token_usage) {
      const totalUsage = tokenUsageFromPayload(payload);
      if (totalUsage) latestTotalUsage = normalizeCodexUsage(totalUsage);
      continue;
    }

    if (type === "task_started") {
      finishCurrent(timestamp);
      current = {
        startAt: timestamp,
        beforeUsage: latestTotalUsage,
        prompt: "",
      };
      continue;
    }

    if (type === "user_message" && current && !current.prompt) {
      current.prompt = extractUserText(payload);
      continue;
    }

    if (type === "task_complete") {
      finishCurrent(timestamp);
    }
  }

  return segments;
}

export function summarizeSegments(segments) {
  const totals = zeroUsage();
  for (const segment of segments) addUsage(totals, segment.usage);
  return {
    segmentCount: segments.length,
    totals,
  };
}

function parseJsonlFile(file) {
  return readFileSync(file, "utf8").split(/\r?\n/);
}

export function parseCodexRolloutFile(file, options = {}) {
  return parseCodexRolloutLines(parseJsonlFile(file), options);
}

function walkFiles(root, predicate, results = []) {
  if (!existsSync(root)) return results;
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkFiles(path, predicate, results);
    else if (!predicate || predicate(path, st)) results.push({ path, mtimeMs: st.mtimeMs });
  }
  return results;
}

export function findCodexRolloutFile(threadId, sessionsRoot = join(homedir(), ".codex", "sessions")) {
  if (!threadId) return "";
  const files = walkFiles(sessionsRoot, (path) => basename(path).startsWith("rollout-") && basename(path).endsWith(".jsonl") && path.includes(threadId));
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files[0]?.path || "";
}

function extractThreadIdFromRolloutPath(file) {
  const name = basename(file);
  const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(name);
  return match?.[1] || "";
}

function listRolloutFiles(sessionsRoot = join(homedir(), ".codex", "sessions")) {
  const files = walkFiles(sessionsRoot, (path) => basename(path).startsWith("rollout-") && basename(path).endsWith(".jsonl"));
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files.map((file) => file.path);
}

function textSimilarity(a, b) {
  const left = String(a || "").replace(/\s+/g, "");
  const right = String(b || "").replace(/\s+/g, "");
  if (!left || !right) return 0;
  if (left.includes(right) || right.includes(left)) return Math.min(left.length, right.length);
  let score = 0;
  for (let i = 0; i < Math.min(left.length, right.length, 80); i += 1) {
    if (left[i] === right[i]) score += 1;
  }
  return score;
}

function jobLocalDate(job, timezoneOffsetMinutes) {
  return localDateStringWithOffset(job.createdAt || job.startedAt || job.updatedAt || job.finishedAt, timezoneOffsetMinutes);
}

export function findCodexRolloutFileForWorker({ workersDir, worker, date, sessionsRoot, timezoneOffsetMinutes = 8 * 60 } = {}) {
  if (!workersDir || !worker) return null;
  const workerJobs = listJobs(workersDir, { limit: 100000 })
    .filter((job) => job.worker === worker && (!date || jobLocalDate(job, timezoneOffsetMinutes) === date))
    .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
  if (workerJobs.length === 0) return null;

  let best = null;
  for (const file of listRolloutFiles(sessionsRoot)) {
    let segments;
    try {
      segments = parseCodexRolloutFile(file, { date, timezoneOffsetMinutes });
    } catch {
      continue;
    }
    if (segments.length === 0) continue;
    let score = 0;
    for (const job of workerJobs) {
      const jobTime = new Date(job.createdAt || job.startedAt || job.updatedAt || 0).getTime();
      if (!Number.isFinite(jobTime)) continue;
      let matched = false;
      for (const segment of segments) {
        const segmentTime = new Date(segment.startAt).getTime();
        const deltaMs = Math.abs(segmentTime - jobTime);
        const promptScore = textSimilarity(job.task, segment.prompt);
        if (deltaMs <= 2 * 60 * 1000 || promptScore >= 12) {
          score += Math.max(1, 120_000 - Math.min(deltaMs, 120_000)) + promptScore * 1000;
          matched = true;
          break;
        }
      }
      if (!matched) score -= 1;
    }
    if (!best || score > best.score) {
      best = { file, threadId: extractThreadIdFromRolloutPath(file), score };
    }
  }
  return best && best.score > 0 ? best : null;
}

function readJsonl(file) {
  if (!file || !existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function readCodexWorkerRegistry(workersDir) {
  const sessionFile = join(workersDir, "sessions", "main.jsonl");
  const registry = new Map();
  for (const entry of readJsonl(sessionFile)) {
    const call = entry?.message?.content?.find?.((item) => item?.type === "toolCall" && ["factory_hire", "factory_worker_config", "factory_fire"].includes(item.name));
    if (!call) continue;
    const args = call.arguments || {};
    const worker = args.worker || args.name || args.workerId;
    if (!worker) continue;
    if (call.name === "factory_fire") {
      registry.delete(worker);
      continue;
    }
    const existing = registry.get(worker) || {};
    registry.set(worker, { ...existing, ...args, worker });
  }
  return registry;
}

function compactText(value, max = 72) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text || "—";
  return `${text.slice(0, max - 1)}…`;
}

function formatTokenCount(value) {
  const numberValue = Number(value || 0);
  if (!Number.isFinite(numberValue) || numberValue === 0) return "0";
  const sign = numberValue < 0 ? "-" : "";
  const absolute = Math.abs(numberValue);
  if (absolute >= 1_000_000) return `${sign}${(absolute / 1_000_000).toFixed(2)}M`;
  if (absolute >= 1_000) return `${sign}${(absolute / 1_000).toFixed(2)}K`;
  return `${sign}${new Intl.NumberFormat("en-US").format(absolute)}`;
}

function ratio(a, b) {
  if (!b) return a ? "∞" : "—";
  return `${(a / b).toFixed(2)}x`;
}

function normalizeArgs(argv) {
  const args = {
    format: "markdown",
    sessionsRoot: join(homedir(), ".codex", "sessions"),
    timezoneOffset: "+08:00",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--workers-dir") args.workersDir = argv[++i];
    else if (arg === "--worker") args.worker = argv[++i];
    else if (arg === "--thread") args.threadId = argv[++i];
    else if (arg === "--date") args.date = argv[++i];
    else if (arg === "--format") args.format = argv[++i];
    else if (arg === "--json") args.format = "json";
    else if (arg === "--apply-jobs") args.applyJobs = true;
    else if (arg === "--repair-preview") args.repairPreview = true;
    else if (arg === "--sessions-root") args.sessionsRoot = argv[++i];
    else if (arg === "--timezone-offset") args.timezoneOffset = argv[++i];
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`unknown arg: ${arg}`);
  }
  args.date ||= localDateStringWithOffset(new Date(), parseTimezoneOffset(args.timezoneOffset));
  return args;
}

function usage() {
  return [
    "Usage: node codex-rollout-token-report.mjs --workers-dir DIR [--worker 员工 | --thread THREAD_ID] [--date YYYY-MM-DD] [--format markdown|json] [--repair-preview|--apply-jobs]",
    "",
    "By default this is read-only. --repair-preview shows job patches; --apply-jobs writes matched done job token metadata.",
  ].join("\n");
}

function buildCurrentJobComparison({ workersDir, date, worker }) {
  if (!workersDir || !existsSync(workersDir)) return null;
  try {
    const report = buildFactoryTokenReport({ workersDir, date, worker });
    return report.workers.find((item) => !worker || item.worker === worker) || null;
  } catch {
    return null;
  }
}

export function buildCodexRolloutTokenReport(options) {
  const timezoneOffsetMinutes = parseTimezoneOffset(options.timezoneOffset || "+08:00");
  let workerConfig = null;
  let threadId = options.threadId;
  if (!threadId && options.worker && options.workersDir) {
    workerConfig = readCodexWorkerRegistry(options.workersDir).get(options.worker) || null;
    threadId = workerConfig?.codexThreadId || workerConfig?.threadId || "";
  }
  let inferred = null;
  if (!threadId && options.worker && options.workersDir) {
    inferred = findCodexRolloutFileForWorker({
      workersDir: options.workersDir,
      worker: options.worker,
      date: options.date,
      sessionsRoot: options.sessionsRoot,
      timezoneOffsetMinutes,
    });
    threadId = inferred?.threadId || "";
  }
  if (!threadId && !inferred?.file) throw new Error("thread id is required; pass --thread or --worker with --workers-dir");
  const rolloutFile = options.rolloutFile || inferred?.file || findCodexRolloutFile(threadId, options.sessionsRoot);
  if (!rolloutFile) throw new Error(`cannot find Codex rollout for thread ${threadId} under ${options.sessionsRoot}`);
  threadId ||= extractThreadIdFromRolloutPath(rolloutFile);
  const segments = parseCodexRolloutFile(rolloutFile, { date: options.date, timezoneOffsetMinutes });
  const summary = summarizeSegments(segments);
  const jobSummary = buildCurrentJobComparison({ workersDir: options.workersDir, date: options.date, worker: options.worker });
  return {
    generatedAt: new Date().toISOString(),
    date: options.date,
    timezoneOffset: options.timezoneOffset || "+08:00",
    worker: options.worker || workerConfig?.worker || "",
    threadId,
    rolloutFile,
    segments,
    summary,
    currentFactoryReport: jobSummary,
    notes: [
      "rollout totals are computed as cumulative total_token_usage deltas between task_started and task_complete.",
      "this report is read-only and does not modify factory job metadata.",
    ],
  };
}

function isRepairableJob(job) {
  return job?.status === "done";
}

function matchingScore(job, segment) {
  const promptScore = textSimilarity(job.task, segment.prompt);
  const jobTime = new Date(job.createdAt || job.startedAt || job.updatedAt || 0).getTime();
  const segmentTime = new Date(segment.startAt || 0).getTime();
  const deltaMs = Number.isFinite(jobTime) && Number.isFinite(segmentTime)
    ? Math.abs(segmentTime - jobTime)
    : Number.POSITIVE_INFINITY;
  const timeScore = Number.isFinite(deltaMs) ? Math.max(0, 10 * 60 * 1000 - deltaMs) / 1000 : 0;
  const matched = promptScore >= 12 || deltaMs <= 2 * 60 * 1000;
  return {
    matched,
    score: matched ? promptScore * 1000 + timeScore : 0,
    promptScore,
    deltaMs,
  };
}

export function matchCodexRolloutSegmentsToJobs({ workersDir, worker, date, segments, timezoneOffsetMinutes = 8 * 60 } = {}) {
  if (!workersDir || !worker) return { matches: [], unmatchedJobs: [], unmatchedSegments: segments || [] };
  const jobs = listJobs(workersDir, { limit: 100000 })
    .filter((job) => job.worker === worker && isRepairableJob(job) && (!date || jobLocalDate(job, timezoneOffsetMinutes) === date))
    .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
  const unusedSegments = new Set(segments || []);
  const matches = [];
  const unmatchedJobs = [];

  for (const job of jobs) {
    let best = null;
    for (const segment of unusedSegments) {
      const candidate = matchingScore(job, segment);
      if (!candidate.matched) continue;
      if (!best || candidate.score > best.score) best = { job, segment, ...candidate };
    }
    if (best) {
      unusedSegments.delete(best.segment);
      matches.push(best);
    } else {
      unmatchedJobs.push(job);
    }
  }

  return { matches, unmatchedJobs, unmatchedSegments: [...unusedSegments] };
}

function repairPatchForMatch(match, report) {
  const usage = normalizeCodexUsage(match.segment.usage);
  return {
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    outputTokens: usage.outputTokens,
    reasoningOutputTokens: usage.reasoningOutputTokens,
    totalTokens: usage.totalTokens,
    tokenSource: "codex-rollout-delta",
    tokenRepairedAt: new Date().toISOString(),
    tokenRepair: {
      source: "codex-rollout-token-report",
      rolloutFile: report.rolloutFile,
      threadId: report.threadId,
      segmentStartAt: match.segment.startAt,
      segmentEndAt: match.segment.endAt,
      previous: {
        inputTokens: match.job.inputTokens || 0,
        cachedInputTokens: match.job.cachedInputTokens || 0,
        outputTokens: match.job.outputTokens || 0,
        reasoningOutputTokens: match.job.reasoningOutputTokens || 0,
        totalTokens: match.job.totalTokens || 0,
      },
      match: {
        score: match.score,
        promptScore: match.promptScore,
        deltaMs: Number.isFinite(match.deltaMs) ? match.deltaMs : null,
      },
    },
  };
}

export function repairCodexJobTokenMetadata(report, { workersDir, apply = false } = {}) {
  const timezoneOffsetMinutes = parseTimezoneOffset(report.timezoneOffset || "+08:00");
  const matched = matchCodexRolloutSegmentsToJobs({
    workersDir,
    worker: report.worker,
    date: report.date,
    segments: report.segments,
    timezoneOffsetMinutes,
  });
  const changes = matched.matches.map((match) => {
    const patch = repairPatchForMatch(match, report);
    if (apply) writeJob({ ...match.job, ...patch });
    return {
      jobId: match.job.id,
      jobFile: match.job.jobFile,
      task: match.job.task,
      segmentStartAt: match.segment.startAt,
      segmentEndAt: match.segment.endAt,
      old: patch.tokenRepair.previous,
      new: {
        inputTokens: patch.inputTokens,
        cachedInputTokens: patch.cachedInputTokens,
        outputTokens: patch.outputTokens,
        reasoningOutputTokens: patch.reasoningOutputTokens,
        totalTokens: patch.totalTokens,
      },
      score: match.score,
      applied: apply,
    };
  });
  return {
    applied: apply,
    changed: changes.length,
    changes,
    unmatchedJobs: matched.unmatchedJobs.map((job) => ({ id: job.id, task: job.task, status: job.status })),
    unmatchedSegments: matched.unmatchedSegments.map((segment) => ({
      startAt: segment.startAt,
      endAt: segment.endAt,
      prompt: segment.prompt,
      usage: segment.usage,
    })),
  };
}

function formatUsageSummary(usage) {
  return [
    formatTokenCount(usage.inputTokens),
    formatTokenCount(usage.cachedInputTokens),
    formatTokenCount(usage.outputTokens),
    formatTokenCount(usage.reasoningOutputTokens),
    formatTokenCount(usage.totalTokens),
    formatTokenCount(usage.totalWithCachedTokens),
  ];
}

export function formatCodexRolloutTokenReport(report) {
  const lines = [
    `# Codex Rollout Token 回算 — ${report.worker || report.threadId} — ${report.date}`,
    "",
    `- 线程：${report.threadId}`,
    `- rollout：${report.rolloutFile}`,
    `- 时区：${report.timezoneOffset}`,
    `- 任务段：${report.summary.segmentCount}`,
    `- 说明：只读回算，不修改工厂 job metadata。`,
    "",
    "## 回算合计（rollout total_token_usage delta）",
    "",
    "| 输入 | 缓存输入 | 输出 | 推理输出 | 总 | 含缓存合计 |",
    "|---:|---:|---:|---:|---:|---:|",
    `| ${formatUsageSummary(report.summary.totals).join(" | ")} |`,
  ];

  if (report.currentFactoryReport) {
    const reported = report.currentFactoryReport.reported || {};
    lines.push(
      "",
      "## 当前工厂 token_report 口径",
      "",
      "| 输入 | 缓存输入 | 输出 | 推理输出 | 总 | 含缓存合计 | 来源 |",
      "|---:|---:|---:|---:|---:|---:|---|",
      `| ${formatUsageSummary(reported).join(" | ")} | ${report.currentFactoryReport.source || "—"} |`,
      "",
      "## 差异倍数（rollout / 当前上报）",
      "",
      "| 输入 | 缓存输入 | 输出 | 推理输出 | 总 | 含缓存合计 |",
      "|---:|---:|---:|---:|---:|---:|",
      `| ${ratio(report.summary.totals.inputTokens, reported.inputTokens)} | ${ratio(report.summary.totals.cachedInputTokens, reported.cachedInputTokens)} | ${ratio(report.summary.totals.outputTokens, reported.outputTokens)} | ${ratio(report.summary.totals.reasoningOutputTokens, reported.reasoningOutputTokens)} | ${ratio(report.summary.totals.totalTokens, reported.totalTokens)} | ${ratio(report.summary.totals.totalWithCachedTokens, reported.totalWithCachedTokens)} |`,
    );
  }

  lines.push(
    "",
    "## 任务段明细",
    "",
    "| 开始 | 结束 | 输入 | 缓存输入 | 输出 | 推理输出 | 总 | 含缓存合计 | 任务摘要 |",
    "|---|---|---:|---:|---:|---:|---:|---:|---|",
  );
  for (const segment of report.segments) {
    lines.push(
      `| ${localTimeStringWithOffset(segment.startAt, parseTimezoneOffset(report.timezoneOffset))} | ${localTimeStringWithOffset(segment.endAt, parseTimezoneOffset(report.timezoneOffset))} | ${formatUsageSummary(segment.usage).join(" | ")} | ${compactText(segment.prompt)} |`,
    );
  }
  if (report.segments.length === 0) lines.push("| — | — | 0 | 0 | 0 | 0 | 0 | 0 | 当日无 rollout task 段 |");
  if (report.jobRepair) {
    lines.push(
      "",
      `## Job metadata ${report.jobRepair.applied ? "修复结果" : "修复预览"}`,
      "",
      `- 匹配 job：${report.jobRepair.changed}`,
      `- 未匹配 done job：${report.jobRepair.unmatchedJobs.length}`,
      `- 未匹配 rollout 段：${report.jobRepair.unmatchedSegments.length}`,
      `- 写入状态：${report.jobRepair.applied ? "已写入" : "未写入，仅预览"}`,
      "",
      "| Job | 旧总 Token | 新总 Token | 旧含缓存估算 | 新含缓存估算 | 任务摘要 |",
      "|---|---:|---:|---:|---:|---|",
    );
    for (const change of report.jobRepair.changes) {
      const oldWithCached = (change.old.inputTokens || 0) + (change.old.cachedInputTokens || 0) + (change.old.outputTokens || 0);
      const newWithCached = (change.new.inputTokens || 0) + (change.new.cachedInputTokens || 0) + (change.new.outputTokens || 0);
      lines.push(`| ${change.jobId} | ${formatTokenCount(change.old.totalTokens)} | ${formatTokenCount(change.new.totalTokens)} | ${formatTokenCount(oldWithCached)} | ${formatTokenCount(newWithCached)} | ${compactText(change.task, 60)} |`);
    }
    if (report.jobRepair.changes.length === 0) lines.push("| — | 0 | 0 | 0 | 0 | 无匹配变更 |");
  }
  return lines.join("\n");
}

async function main() {
  const args = normalizeArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  const report = buildCodexRolloutTokenReport(args);
  if (args.applyJobs || args.repairPreview) {
    report.jobRepair = repairCodexJobTokenMetadata(report, { workersDir: args.workersDir, apply: Boolean(args.applyJobs) });
  }
  if (args.format === "json") console.log(JSON.stringify(report, null, 2));
  else console.log(formatCodexRolloutTokenReport(report));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  });
}

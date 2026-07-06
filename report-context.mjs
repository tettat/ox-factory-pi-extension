import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { basename, join } from "node:path";

import { latestReplyFromEvents, listJobs, tailJobEvents } from "./jobs.mjs";

const JOB_STATUSES = ["queued", "running", "done", "failed", "aborted", "stale"];
const QUEUE_STATUSES = ["pending", "running", "done", "failed", "stale"];
const MANAGEMENT_CUSTOM_TYPES = new Set([
  "ox-worker-hire",
  "ox-worker-fire",
  "ox-worker-promote",
  "ox-worker-project",
  "ox-worker-config",
  "ox-race",
]);

function zeroCounts(keys) {
  return Object.fromEntries(keys.map((key) => [key, 0]));
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

export function localDateString(value = new Date()) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function targetDateString(date) {
  return localDateString(date || new Date());
}

function compactText(value, max = 180) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function dateCandidates(record) {
  if (!record || typeof record !== "object") return [];
  const nestedData = record.data && typeof record.data === "object" ? record.data : {};
  return [
    record.timestamp,
    record.time,
    record.date,
    record.createdAt,
    record.startedAt,
    record.updatedAt,
    record.finishedAt,
    record.scheduled,
    nestedData.date,
    nestedData.hired,
    nestedData.time,
  ].filter(Boolean);
}

function touchesDate(record, date) {
  return dateCandidates(record).some((value) => localDateString(value) === date);
}

function safeReadJsonl(file) {
  if (!existsSync(file)) return { entries: [], warnings: [] };
  const entries = [];
  const warnings = [];
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      entries.push(JSON.parse(trimmed));
    } catch (error) {
      warnings.push(`${file}:${index + 1} 不是合法 JSONL，已跳过`);
    }
  });
  return { entries, warnings };
}

function createWorkerSummary(worker, profile = {}) {
  return {
    worker,
    role: profile.role || "",
    status: profile.status || "",
    active: false,
    jobs: zeroCounts(JOB_STATUSES),
    queue: zeroCounts(QUEUE_STATUSES),
    session: {
      assistantMessages: 0,
      userMessages: 0,
      toolResultMessages: 0,
      toolCalls: {},
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cost: 0,
    },
    highlights: [],
    sources: [],
    warnings: [],
  };
}

function ensureWorker(map, worker, profile = {}) {
  const name = String(worker || "未知员工");
  if (!map.has(name)) map.set(name, createWorkerSummary(name, profile));
  const summary = map.get(name);
  if (profile.role && !summary.role) summary.role = profile.role;
  if (profile.status && !summary.status) summary.status = profile.status;
  return summary;
}

function addHighlight(summary, text) {
  const value = compactText(text, 160);
  if (!value) return;
  if (summary.highlights.includes(value)) return;
  if (summary.highlights.length >= 5) return;
  summary.highlights.push(value);
}

function addWarning(summary, warning) {
  if (!warning) return;
  if (!summary.warnings.includes(warning)) summary.warnings.push(warning);
}

function extractUsage(entry) {
  const usage = entry?.message?.usage || entry?.usage;
  if (!usage || typeof usage !== "object") return null;
  const cost = typeof usage.cost === "number" ? usage.cost : usage.cost?.total;
  return {
    input: Number(usage.input ?? usage.inputTokens ?? 0) || 0,
    output: Number(usage.output ?? usage.outputTokens ?? 0) || 0,
    total: Number(usage.totalTokens ?? usage.total ?? 0) || 0,
    cost: Number(cost ?? 0) || 0,
  };
}

function countToolCalls(summary, content) {
  if (!Array.isArray(content)) return;
  for (const item of content) {
    if (item?.type !== "toolCall") continue;
    const name = item.name || "unknown";
    summary.session.toolCalls[name] = (summary.session.toolCalls[name] || 0) + 1;
  }
}

function summarizeSessionFile(file, worker, date, workerMap, dataQualityWarnings) {
  const { entries, warnings } = safeReadJsonl(file);
  dataQualityWarnings.push(...warnings);
  const summary = ensureWorker(workerMap, worker);
  let touched = false;

  for (const entry of entries) {
    if (!touchesDate(entry, date)) continue;
    touched = true;
    if (entry.type !== "message") continue;
    const role = entry.message?.role;
    if (role === "assistant") summary.session.assistantMessages += 1;
    else if (role === "user") summary.session.userMessages += 1;
    else if (role === "toolResult") summary.session.toolResultMessages += 1;

    const usage = extractUsage(entry);
    if (usage) {
      summary.session.inputTokens += usage.input;
      summary.session.outputTokens += usage.output;
      summary.session.totalTokens += usage.total;
      summary.session.cost += usage.cost;
    }
    countToolCalls(summary, entry.message?.content);
  }

  if (touched) {
    summary.active = true;
    summary.sources.push({ source: "session", file });
  }
}

function summarizeWorkerSessions(workersDir, date, workerMap, dataQualityWarnings) {
  const sessionsDir = join(workersDir, "sessions");
  if (!existsSync(sessionsDir)) return;
  for (const name of readdirSync(sessionsDir)) {
    if (!name.endsWith(".jsonl")) continue;
    const worker = basename(name, ".jsonl");
    summarizeSessionFile(join(sessionsDir, name), worker, date, workerMap, dataQualityWarnings);
  }
}

function summarizeJob(job, workerMap, dataQualityWarnings) {
  const summary = ensureWorker(workerMap, job.worker);
  const status = JOB_STATUSES.includes(job.status) ? job.status : "queued";
  summary.jobs[status] += 1;
  summary.active = true;
  summary.sources.push({
    source: "jobs",
    id: job.id,
    status: job.status,
    kind: job.kind,
    project: job.project || "",
  });

  let events = [];
  try {
    events = tailJobEvents(job, 100);
  } catch (error) {
    dataQualityWarnings.push(`job ${job.id} events 读取失败：${error.message}`);
  }

  const latestReply = latestReplyFromEvents(events);
  addHighlight(summary, job.summary || latestReply || job.fullOutput || job.task);

  if (job.status === "done" && job.error) {
    addWarning(summary, `job ${job.id} 已完成但带 stale/error 痕迹：${compactText(job.error, 100)}`);
    dataQualityWarnings.push(`job ${job.id} status=done 但 error 非空，日报计入产出并标记风险。`);
  } else if (job.status === "stale") {
    addWarning(summary, `job ${job.id} 被标记 stale，需要确认是否仍有产出。`);
  } else if (job.status === "failed" || job.status === "aborted") {
    addWarning(summary, `job ${job.id} ${job.status}：${compactText(job.error || job.task, 100)}`);
  }
}

function summarizeQueue(workersDir, date, workerMap, dataQualityWarnings) {
  const queue = {
    file: join(workersDir, "queue.jsonl"),
    entries: [],
    statusCounts: zeroCounts(QUEUE_STATUSES),
  };
  const { entries, warnings } = safeReadJsonl(queue.file);
  dataQualityWarnings.push(...warnings);

  for (const entry of entries) {
    if (!touchesDate(entry, date)) continue;
    queue.entries.push({
      status: entry.status || "pending",
      worker: entry.worker || "",
      project: entry.project || "",
      task: compactText(entry.task || "", 300),
      summary: compactText(entry.summary || "", 300),
      time: entry.time || "",
      scheduled: entry.scheduled || "",
      repeat: entry.repeat,
    });
    const status = QUEUE_STATUSES.includes(entry.status) ? entry.status : "pending";
    queue.statusCounts[status] += 1;

    const summary = ensureWorker(workerMap, entry.worker);
    summary.queue[status] += 1;
    summary.active = true;
    summary.sources.push({
      source: "queue",
      status,
      project: entry.project || "",
      time: entry.time || entry.scheduled || "",
    });
    if (summary.highlights.length === 0) {
      addHighlight(summary, `${entry.project || "队列任务"}：${entry.summary || entry.task || status}`);
    }
  }
  return queue;
}

function summarizeManagementEvent(entry) {
  if (entry.type === "custom") {
    return {
      source: "main-session",
      type: entry.customType || "custom",
      time: entry.timestamp || entry.time || entry.data?.date || "",
      worker: entry.data?.workerId || entry.data?.worker || entry.data?.name || "",
      summary: compactText(entry.data?.summary || entry.data?.project || entry.data?.task || entry.data?.to || entry.customType, 180),
      data: entry.data || {},
    };
  }

  const toolCall = entry?.message?.content?.find?.((item) => item?.type === "toolCall");
  if (toolCall) {
    const args = typeof toolCall.arguments === "object" && toolCall.arguments ? toolCall.arguments : {};
    return {
      source: "main-session",
      type: toolCall.name,
      time: entry.timestamp || entry.time || "",
      worker: args.worker || args.name || "",
      summary: compactText(args.project || args.task || args.message || toolCall.name, 180),
      data: args,
    };
  }

  return null;
}

function summarizeManagementEvents(sessionEntries, date) {
  if (!Array.isArray(sessionEntries)) return [];
  const events = [];
  for (const entry of sessionEntries) {
    if (!touchesDate(entry, date)) continue;
    const isManagementCustom = entry.type === "custom" && MANAGEMENT_CUSTOM_TYPES.has(entry.customType);
    const isFactoryToolCall =
      entry.type === "message" &&
      entry.message?.role === "assistant" &&
      Array.isArray(entry.message?.content) &&
      entry.message.content.some((item) => item?.type === "toolCall" && /^factory_|^ox-/.test(item.name || ""));
    if (!isManagementCustom && !isFactoryToolCall) continue;
    const event = summarizeManagementEvent(entry);
    if (event) events.push(event);
  }
  return events;
}

function sortWorkerSummaries(workers) {
  return workers.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    const aWork = a.jobs.done + a.jobs.running + a.jobs.queued + a.queue.done + a.queue.running + a.session.assistantMessages;
    const bWork = b.jobs.done + b.jobs.running + b.jobs.queued + b.queue.done + b.queue.running + b.session.assistantMessages;
    if (aWork !== bWork) return bWork - aWork;
    return a.worker.localeCompare(b.worker, "zh-Hans-CN");
  });
}

function compactJob(job) {
  return {
    id: job.id,
    kind: job.kind,
    worker: job.worker,
    project: job.project || "",
    task: compactText(job.task || "", 300),
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    summary: compactText(job.summary || job.fullOutput || "", 300),
    error: compactText(job.error || "", 200),
  };
}

export function buildFactoryReportContext({
  workersDir,
  date,
  workers = [],
  sessionEntries = [],
  includeSessions = true,
} = {}) {
  if (!workersDir) throw new Error("workersDir is required");
  const reportDate = targetDateString(date);
  const workerMap = new Map();
  const dataQualityWarnings = [];

  for (const worker of workers || []) {
    ensureWorker(workerMap, worker.id || worker.worker || worker.name, worker);
  }

  const jobs = listJobs(workersDir, { limit: 100000 }).filter((job) => touchesDate(job, reportDate));
  for (const job of jobs) summarizeJob(job, workerMap, dataQualityWarnings);

  const queue = summarizeQueue(workersDir, reportDate, workerMap, dataQualityWarnings);
  if (includeSessions) summarizeWorkerSessions(workersDir, reportDate, workerMap, dataQualityWarnings);

  const managementEvents = summarizeManagementEvents(sessionEntries, reportDate);
  for (const event of managementEvents) {
    if (!event.worker) continue;
    const summary = ensureWorker(workerMap, event.worker);
    summary.active = true;
    summary.sources.push({ source: "main-session", type: event.type, time: event.time });
  }

  const workerSummaries = sortWorkerSummaries([...workerMap.values()]);
  return {
    date: reportDate,
    generatedAt: new Date().toISOString(),
    sources: {
      jobs: join(workersDir, "jobs"),
      queue: queue.file,
      sessions: join(workersDir, "sessions"),
      mainSession: Array.isArray(sessionEntries) && sessionEntries.length > 0 ? "sessionManager.getEntries()" : "",
    },
    totals: {
      workers: workerSummaries.length,
      activeWorkers: workerSummaries.filter((worker) => worker.active).length,
      jobs: jobs.length,
      queueEntries: queue.entries.length,
      managementEvents: managementEvents.length,
    },
    workers: workerSummaries,
    jobs: jobs.map(compactJob),
    queue,
    managementEvents,
    dataQualityWarnings: [...new Set(dataQualityWarnings)],
  };
}

function formatCounts(counts, keys) {
  return keys
    .map((key) => `${key}:${counts[key] || 0}`)
    .join(" ");
}

function formatToolCalls(toolCalls) {
  const entries = Object.entries(toolCalls || {}).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return "—";
  return entries.slice(0, 5).map(([name, count]) => `${name}×${count}`).join(", ");
}

function formatListForTable(items, limit = 3) {
  if (!items || items.length === 0) return "—";
  const visible = items.slice(0, limit);
  const rest = items.length - visible.length;
  return [...visible, rest > 0 ? `另 ${rest} 条…` : ""].filter(Boolean).join("<br>");
}

// 清理表格 cell 内容：彻底去掉嵌入的 markdown 语法，只保留纯文本
function escapeTableCell(text) {
  if (text == null) return "";
  let s = String(text);
  // 1. 去掉代码块 ```...```（含内容）
  s = s.replace(/```[\s\S]*?```/g, "");
  // 2. 去掉行内代码反引号，保留内容
  s = s.replace(/`([^`\n]+)`/g, "$1");
  // 3. 去掉粗体/斜体标记 **text** *text* __text__ _text_
  s = s.replace(/\*\*([^\*\n]+)\*\*/g, "$1");
  s = s.replace(/__([^_\n]+)__/g, "$1");
  s = s.replace(/(^|[^\*])\*([^\*\n]+)\*(?!\*)/g, "$1$2");
  s = s.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, "$1$2");
  // 4. 去掉链接标记 [text](url) → text
  s = s.replace(/\[([^\]\n]+)\]\([^)\s]+\)/g, "$1");
  // 5. 去掉标题标记 #/##/###/####（不限于行首）
  s = s.replace(/#{1,4}\s+/g, "");
  // 6. 去掉引用 >
  s = s.replace(/(^|\s)>(\s|$)/g, "$1$2");
  // 7. 去掉列表标记 - / * / + / 1.
  s = s.replace(/(^|\s)[-*+]\s+/g, "$1• ");
  s = s.replace(/(^|\s)\d+\.\s+/g, "$1");
  // 8. 去掉水平线 ---
  s = s.replace(/(^|\s)-{3,}(\s|$)/g, "$1 $2");
  // 9. 去掉表格结构残留：\| col \| col \| 模式 → 用空格替换 |
  //    先把所有 | 替换为空格（表格分隔符的角色已经不需要了，cell 内不需要 |）
  s = s.replace(/\|/g, " ");
  // 10. 去掉表格分隔线残留 :---: ---:
  s = s.replace(/:?-{3,}:?/g, " ");
  // 11. 折叠多余空白
  s = s.replace(/[ \t]+/g, " ");
  s = s.replace(/\s*<br>\s*/gi, "<br>");
  s = s.replace(/(<br>){3,}/g, "<br><br>");
  s = s.replace(/(<br>\s*){2,}/g, "<br>");
  s = s.trim();
  // 12. 截断过长内容（cell 里不需要太长）
  if (s.length > 200) s = s.slice(0, 200) + "…";
  return s;
}

export function formatFactoryReportContext(context) {
  const lines = [
    `# 工厂日报上下文 — ${context.date}`,
    "",
    `> 数据源：jobs=${context.sources.jobs}；queue=${context.sources.queue}；sessions=${context.sources.sessions}${context.sources.mainSession ? "；main-session=当前主会话" : ""}`,
    "> 规则：禁止只凭 queue 判断“工厂空转”；queue 只代表 runner/cron/factory_queue 队列流水，jobs 才是今日任务主账本。",
    "",
    "## 总览",
    "",
    `- 活跃员工：${context.totals.activeWorkers}/${context.totals.workers}`,
    `- jobs：${context.totals.jobs}`,
    `- queue entries：${context.totals.queueEntries}`,
    `- 管理动作：${context.totals.managementEvents}`,
    "",
    "## 全员产出表",
    "",
    "| 员工 | 活跃 | Jobs | Queue | Session |",
    "|---|---:|---|---|---|",
  ];

  for (const worker of context.workers) {
    const jobs = formatCounts(worker.jobs, ["queued", "running", "done", "failed", "aborted", "stale"]);
    const queue = formatCounts(worker.queue, ["pending", "running", "done", "failed", "stale"]);
    const session = [
      `assistant:${worker.session.assistantMessages}`,
      worker.session.inputTokens || worker.session.outputTokens ? `↑${worker.session.inputTokens} ↓${worker.session.outputTokens}` : "",
      worker.session.cost ? `¥${worker.session.cost.toFixed(4)}` : "",
    ].filter(Boolean).join(" ");
    lines.push(`| ${worker.worker} | ${worker.active ? "是" : "否"} | ${jobs} | ${queue} | ${escapeTableCell(session || "—")} |`);
  }

  lines.push("");
  lines.push("## 员工今日线索与风险");
  lines.push("");
  for (const worker of context.workers) {
    const highlights = worker.highlights || [];
    const warnings = worker.warnings || [];
    if (highlights.length === 0 && warnings.length === 0) continue;
    lines.push(`### ${worker.worker}`);
    if (highlights.length > 0) {
      lines.push("");
      lines.push("**线索：**");
      for (const h of highlights.slice(0, 5)) {
        const clean = escapeTableCell(h);
        if (clean) lines.push(`- ${clean}`);
      }
      if (highlights.length > 5) lines.push(`- 另 ${highlights.length - 5} 条…`);
    }
    if (warnings.length > 0) {
      lines.push("");
      lines.push("**风险：**");
      for (const w of warnings.slice(0, 5)) {
        const clean = escapeTableCell(w);
        if (clean) lines.push(`- ${clean}`);
      }
      if (warnings.length > 5) lines.push(`- 另 ${warnings.length - 5} 条…`);
    }
    lines.push("");
  }

  lines.push("");
  lines.push("## Queue / Cron 任务");
  lines.push("");
  lines.push(`- ${formatCounts(context.queue.statusCounts, ["pending", "running", "done", "failed", "stale"])}`);
  for (const entry of context.queue.entries.slice(-20).reverse()) {
    lines.push(`- ${entry.status || "pending"} | ${entry.worker || "未知员工"} | ${entry.project || "未命名项目"} | ${compactText(entry.summary || entry.task || "", 120)}`);
  }

  lines.push("");
  lines.push("## 管理动作");
  lines.push("");
  if (context.managementEvents.length === 0) {
    lines.push("- 无");
  } else {
    for (const event of context.managementEvents.slice(-30).reverse()) {
      lines.push(`- ${event.time || "-"} | ${event.type} | ${event.worker || "-"} | ${event.summary || "-"}`);
    }
  }

  lines.push("");
  lines.push("## 数据质量与风险");
  lines.push("");
  if (context.dataQualityWarnings.length === 0) {
    lines.push("- 暂无明显数据质量风险。");
  } else {
    for (const warning of context.dataQualityWarnings.slice(0, 30)) {
      lines.push(`- ${warning}`);
    }
  }

  return lines.join("\n");
}

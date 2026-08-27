import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const TERMINAL_STATUSES = new Set(["done", "failed", "aborted", "stale"]);
const DEFAULT_EXCLUDED_KINDS = ["steer", "quality_emotion", "compact", "compaction", "shadow", "heartbeat"];
const DEFAULT_EXCLUDED_SOURCES = ["steer", "quality_emotion", "compact", "compaction", "shadow", "system"];

export const DEFAULT_NOTIFICATION_SETTINGS = Object.freeze({
  enabled: false,
  pollIntervalMs: 5000,
  jobTerminal: {
    enabled: true,
    statuses: ["done"],
    workers: [],
    excludedKinds: DEFAULT_EXCLUDED_KINDS,
    excludedSources: DEFAULT_EXCLUDED_SOURCES,
    template: "{worker} 任务完成",
    failureTemplate: "{worker} 任务失败",
  },
});

export function notificationSettingsFile(workersDir) {
  return join(workersDir, "config", "notifications.json");
}

function asArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim()).filter(Boolean);
}

function clampPollIntervalMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_NOTIFICATION_SETTINGS.pollIntervalMs;
  return Math.min(60000, Math.max(1000, Math.round(n)));
}

export function normalizeNotificationSettings(input = {}) {
  const jobTerminal = input.jobTerminal || {};
  const statuses = asArray(jobTerminal.statuses).filter((s) => TERMINAL_STATUSES.has(s));
  return {
    enabled: Boolean(input.enabled),
    pollIntervalMs: clampPollIntervalMs(input.pollIntervalMs),
    jobTerminal: {
      enabled: jobTerminal.enabled !== false,
      statuses: statuses.length ? statuses : [...DEFAULT_NOTIFICATION_SETTINGS.jobTerminal.statuses],
      workers: asArray(jobTerminal.workers),
      excludedKinds: asArray(jobTerminal.excludedKinds).length
        ? asArray(jobTerminal.excludedKinds)
        : [...DEFAULT_NOTIFICATION_SETTINGS.jobTerminal.excludedKinds],
      excludedSources: asArray(jobTerminal.excludedSources).length
        ? asArray(jobTerminal.excludedSources)
        : [...DEFAULT_NOTIFICATION_SETTINGS.jobTerminal.excludedSources],
      template: String(jobTerminal.template || DEFAULT_NOTIFICATION_SETTINGS.jobTerminal.template),
      failureTemplate: String(jobTerminal.failureTemplate || DEFAULT_NOTIFICATION_SETTINGS.jobTerminal.failureTemplate),
    },
  };
}

export function readNotificationSettings(workersDir) {
  const file = notificationSettingsFile(workersDir);
  if (!existsSync(file)) return normalizeNotificationSettings(DEFAULT_NOTIFICATION_SETTINGS);
  try {
    return normalizeNotificationSettings(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return normalizeNotificationSettings(DEFAULT_NOTIFICATION_SETTINGS);
  }
}

export function writeNotificationSettings(workersDir, nextSettings) {
  const file = notificationSettingsFile(workersDir);
  mkdirSync(dirname(file), { recursive: true });
  const settings = normalizeNotificationSettings(nextSettings);
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  return settings;
}

function matchesConfiguredWorker(job, workers) {
  if (!workers?.length) return true;
  const worker = String(job.worker || "").trim();
  return workers.includes(worker);
}

function renderTemplate(template, job) {
  const statusText = job.status === "done" ? "完成" : "失败";
  const values = {
    worker: job.worker || "员工",
    status: job.status || "",
    statusText,
    project: job.project || "",
    kind: job.kind || "",
    source: job.source || "",
    assignedBy: job.assignedBy || "",
  };
  return String(template || "")
    .replace(/\{(worker|status|statusText|project|kind|source|assignedBy)\}/g, (_, key) => values[key] || "")
    .replace(/\s+/g, " ")
    .trim();
}

export function shouldNotifyJob(job, settings = DEFAULT_NOTIFICATION_SETTINGS) {
  const cfg = normalizeNotificationSettings(settings);
  const rule = cfg.jobTerminal;
  if (!cfg.enabled || !rule.enabled) return false;
  if (!TERMINAL_STATUSES.has(job?.status)) return false;
  if (!rule.statuses.includes(job.status)) return false;
  if (!matchesConfiguredWorker(job, rule.workers)) return false;
  const kind = String(job.kind || "").trim();
  const source = String(job.source || "").trim();
  if (kind && rule.excludedKinds.includes(kind)) return false;
  if (source && rule.excludedSources.includes(source)) return false;
  return true;
}

export function buildJobNotification(job, settings = DEFAULT_NOTIFICATION_SETTINGS) {
  if (!shouldNotifyJob(job, settings)) return null;
  const cfg = normalizeNotificationSettings(settings);
  const template = job.status === "done" ? cfg.jobTerminal.template : cfg.jobTerminal.failureTemplate;
  const at = job.finishedAt || job.updatedAt || job.createdAt || new Date().toISOString();
  return {
    id: `job:${job.id}:${job.status}`,
    type: "job_terminal",
    jobId: job.id,
    worker: job.worker || "",
    status: job.status || "",
    kind: job.kind || "",
    source: job.source || "",
    assignedBy: job.assignedBy || "",
    project: job.project || "",
    message: renderTemplate(template, job) || `${job.worker || "员工"} 任务完成`,
    at,
  };
}

export function buildJobNotifications(jobs, settings = DEFAULT_NOTIFICATION_SETTINGS, { since = "", limit = 50 } = {}) {
  const sinceMs = since ? Date.parse(since) : Number.NaN;
  const max = Math.min(200, Math.max(1, Number(limit) || 50));
  return (jobs || [])
    .map((job) => buildJobNotification(job, settings))
    .filter(Boolean)
    .filter((item) => {
      if (!Number.isFinite(sinceMs)) return true;
      const atMs = Date.parse(item.at);
      return Number.isFinite(atMs) && atMs > sinceMs;
    })
    .sort((a, b) => String(a.at).localeCompare(String(b.at)))
    .slice(-max);
}

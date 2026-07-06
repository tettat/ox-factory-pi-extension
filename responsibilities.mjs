import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const ACTIVE_STATUSES = new Set(["active", "paused", "done"]);

function nowIso() {
  return new Date().toISOString();
}

function randomId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function ensureDir(file) {
  mkdirSync(dirname(file), { recursive: true });
}

function appendJsonl(file, entry) {
  ensureDir(file);
  appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
}

function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
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

function clean(value) {
  return String(value ?? "").trim();
}

function normalizeProject(value) {
  return clean(value) || "通用职责";
}

function normalizeRelation(value) {
  return clean(value) || "contributor";
}

function normalizeStatus(value) {
  const status = clean(value) || "active";
  if (!ACTIVE_STATUSES.has(status)) throw new Error(`未知职责状态: ${status}`);
  return status;
}

function responsibilityKey(record) {
  return [
    clean(record.worker),
    normalizeProject(record.project),
    normalizeRelation(record.relation),
  ].join("\u0000");
}

export function responsibilitiesFile(workersDir) {
  return join(workersDir, "responsibilities.jsonl");
}

export function setWorkerResponsibility(workersDir, input = {}) {
  const worker = clean(input.worker);
  if (!worker) throw new Error("worker 不能为空");
  const scope = clean(input.scope);
  if (!scope) throw new Error("scope 不能为空");

  const record = {
    type: "set",
    id: randomId("resp"),
    worker,
    project: normalizeProject(input.project),
    relation: normalizeRelation(input.relation),
    scope,
    status: normalizeStatus(input.status),
    note: clean(input.note),
    updatedBy: clean(input.updatedBy) || "主agent",
    updatedAt: nowIso(),
  };
  record.key = responsibilityKey(record);
  appendJsonl(responsibilitiesFile(workersDir), record);
  return record;
}

export function removeWorkerResponsibility(workersDir, input = {}) {
  const worker = clean(input.worker);
  if (!worker) throw new Error("worker 不能为空");
  const record = {
    type: "remove",
    id: randomId("resp_rm"),
    worker,
    project: normalizeProject(input.project),
    relation: normalizeRelation(input.relation),
    scope: "",
    status: "removed",
    note: clean(input.note),
    updatedBy: clean(input.updatedBy) || "主agent",
    updatedAt: nowIso(),
  };
  record.key = responsibilityKey(record);
  appendJsonl(responsibilitiesFile(workersDir), record);
  return record;
}

export function readResponsibilityEvents(workersDir) {
  return readJsonl(responsibilitiesFile(workersDir));
}

export function listWorkerResponsibilities(workersDir, { worker, includeInactive = false } = {}) {
  const targetWorker = clean(worker);
  const latest = new Map();
  for (const event of readResponsibilityEvents(workersDir)) {
    if (!event || !event.worker) continue;
    const normalized = {
      ...event,
      worker: clean(event.worker),
      project: normalizeProject(event.project),
      relation: normalizeRelation(event.relation),
      scope: clean(event.scope),
      status: event.type === "remove" ? "removed" : clean(event.status) || "active",
      updatedBy: clean(event.updatedBy) || "主agent",
      updatedAt: clean(event.updatedAt),
    };
    normalized.key = event.key || responsibilityKey(normalized);
    latest.set(normalized.key, normalized);
  }

  return [...latest.values()]
    .filter((record) => !targetWorker || record.worker === targetWorker)
    .filter((record) => includeInactive || record.status !== "removed")
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export function formatResponsibility(record) {
  const relation = record.relation && record.relation !== "contributor" ? ` · ${record.relation}` : "";
  const status = record.status && record.status !== "active" ? ` · ${record.status}` : "";
  return `${record.project}${relation}${status}：${record.scope}`;
}

export function summarizeResponsibilities(records = [], { max = 3 } = {}) {
  const active = records.filter((record) => record.status !== "removed");
  if (active.length === 0) return "";
  return active.slice(0, max).map(formatResponsibility).join("\n");
}

export function formatResponsibilitiesMarkdown(records = []) {
  if (records.length === 0) return "暂无职责记录。";
  const lines = [
    "| 员工 | 项目 | 关系 | 状态 | 职责范围 | 更新人 | 更新时间 |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const record of records) {
    lines.push([
      record.worker,
      record.project,
      record.relation,
      record.status,
      record.scope || "—",
      record.updatedBy || "—",
      record.updatedAt || "—",
    ].map((cell) => String(cell).replace(/\|/g, "\\|")).join(" | ").replace(/^/, "| ").replace(/$/, " |"));
  }
  return lines.join("\n");
}

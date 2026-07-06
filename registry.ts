/**
 * 牛马工厂 — 员工注册表
 *
 * 管理所有员工的内存状态，支持从主 session 恢复。
 */

import * as path from "node:path";
import * as fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type Worker,
  type WorkerBackend,
  type WorkerRole,
  type WorkerStatus,
  type ProjectRecord,
  type PromotionRecord,
  type ResponsibilityRecord,
  type RaceRecord,
  EntryTypes,
  ALL_ROLES,
} from "./types.ts";
import { normalizeCodexModel } from "./codex-backend.mjs";
import {
  listWorkerResponsibilities as listFileResponsibilities,
  removeWorkerResponsibility as writeRemoveWorkerResponsibility,
  setWorkerResponsibility as writeWorkerResponsibility,
  summarizeResponsibilities,
} from "./responsibilities.mjs";

/** 全局员工注册表（内存态） */
export const workers = new Map<string, Worker>();

/** 赛马历史记录 */
export const raceHistory: RaceRecord[] = [];

/** 主 extension 的 pi 引用，由 index.ts 注入 */
let _pi: ExtensionAPI | null = null;
export function setPi(pi: ExtensionAPI) {
  _pi = pi;
}

/** 工作目录 */
let _workersDir: string = "";
export function getWorkersDir(): string {
  return _workersDir;
}
function workerSessionFile(name: string): string {
  return path.join(_workersDir, "sessions", `${name}.jsonl`);
}

export function init(cwd: string) {
  _workersDir = path.join(cwd, ".pi", "workers");
  fs.mkdirSync(path.join(_workersDir, "sessions"), { recursive: true });
  fs.mkdirSync(path.join(_workersDir, "worktrees"), { recursive: true });
}

// ─── 入职 ─────────────────────────────────────────────

export interface HireOptions {
  backend?: WorkerBackend;
  codexThreadId?: string;
  codexServerUrl?: string;
  codexApprovalPolicy?: Worker["codexApprovalPolicy"];
  codexSandbox?: Worker["codexSandbox"];
}

export function hire(name: string, role: WorkerRole, model?: string, thinking?: string, options: HireOptions = {}): Worker {
  const existing = workers.get(name);
  if (existing && existing.status !== "fired") throw new Error(`员工 "${name}" 已存在`);

  const w: Worker = {
    id: name,
    sessionFile: workerSessionFile(name),
    role,
    backend: options.backend ?? "pi",
    model,
    thinking: thinking as Worker["thinking"],
    codexThreadId: options.codexThreadId,
    codexServerUrl: options.codexServerUrl,
    codexApprovalPolicy: options.codexApprovalPolicy,
    codexSandbox: options.codexSandbox,
    codexThreadHandoff: undefined,
    status: "idle",
    hired: new Date().toISOString().slice(0, 10),
    projects: [],
    promotions: [],
    responsibilities: [],
  };

  workers.set(name, w);

  // session 文件由第一次 spawn 时 pi 自动创建
  fs.mkdirSync(path.dirname(w.sessionFile), { recursive: true });

  // 持久化到主 session
  _pi?.appendEntry(EntryTypes.HIRE, {
    workerId: name,
    role,
    backend: w.backend,
    model,
    thinking: w.thinking,
    codexThreadId: w.codexThreadId,
    codexServerUrl: w.codexServerUrl,
    codexApprovalPolicy: w.codexApprovalPolicy,
    codexSandbox: w.codexSandbox,
    codexThreadHandoff: w.codexThreadHandoff,
    hired: w.hired,
    sessionFile: w.sessionFile,
  });

  return w;
}

export function updateWorkerConfig(workerId: string, patch: Partial<Worker>) {
  const w = workers.get(workerId);
  if (!w) return;

  const allowedKeys = [
    "backend",
    "model",
    "thinking",
    "codexThreadId",
    "codexServerUrl",
    "codexApprovalPolicy",
    "codexSandbox",
    "codexThreadHandoff",
  ] as const;

  const entry: Record<string, unknown> = { workerId };
  let changed = false;
  for (const key of allowedKeys) {
    if (!(key in patch)) continue;
    const next = patch[key];
    if (w[key] !== next) changed = true;
    entry[key] = next;
  }

  if (!changed) return;
  Object.assign(w, patch);
  for (const key of allowedKeys) {
    if (!(key in entry)) continue;
    entry[key] = w[key];
  }
  _pi?.appendEntry("ox-worker-config", entry);
}

function responsibilityKey(record: Pick<ResponsibilityRecord, "worker" | "project" | "relation">): string {
  return [record.worker, record.project || "通用职责", record.relation || "contributor"].join("\u0000");
}

function applyResponsibilityRecord(record: ResponsibilityRecord) {
  const w = workers.get(record.worker);
  if (!w) return;
  if (!Array.isArray(w.responsibilities)) w.responsibilities = [];
  const key = record.key || responsibilityKey(record);
  if (record.status === "removed") {
    w.responsibilities = w.responsibilities.filter((item) => (item.key || responsibilityKey(item)) !== key);
    return;
  }
  const next = { ...record, key };
  const idx = w.responsibilities.findIndex((item) => (item.key || responsibilityKey(item)) === key);
  if (idx >= 0) {
    w.responsibilities[idx] = next;
  } else {
    w.responsibilities.push(next);
  }
}

export function setResponsibility(
  workerId: string,
  input: {
    project?: string;
    relation?: string;
    scope: string;
    status?: "active" | "paused" | "done";
    note?: string;
    updatedBy?: string;
  },
): ResponsibilityRecord {
  const w = workers.get(workerId);
  if (!w) throw new Error(`员工 "${workerId}" 不存在`);
  const record = writeWorkerResponsibility(getWorkersDir(), {
    worker: workerId,
    ...input,
  }) as ResponsibilityRecord;
  applyResponsibilityRecord(record);
  _pi?.appendEntry(EntryTypes.RESPONSIBILITY, {
    action: "set",
    ...record,
  });
  return record;
}

export function removeResponsibility(
  workerId: string,
  input: {
    project?: string;
    relation?: string;
    note?: string;
    updatedBy?: string;
  } = {},
): ResponsibilityRecord {
  const w = workers.get(workerId);
  if (!w) throw new Error(`员工 "${workerId}" 不存在`);
  const record = writeRemoveWorkerResponsibility(getWorkersDir(), {
    worker: workerId,
    ...input,
  }) as ResponsibilityRecord;
  applyResponsibilityRecord(record);
  _pi?.appendEntry(EntryTypes.RESPONSIBILITY, {
    action: "remove",
    ...record,
  });
  return record;
}

export function listResponsibilities(workerId?: string, includeInactive = false): ResponsibilityRecord[] {
  const fromFile = getWorkersDir()
    ? (listFileResponsibilities(getWorkersDir(), { worker: workerId, includeInactive }) as ResponsibilityRecord[])
    : [];
  const byKey = new Map<string, ResponsibilityRecord>();
  for (const record of fromFile) byKey.set(record.key || responsibilityKey(record), record);
  for (const w of workers.values()) {
    if (workerId && w.id !== workerId) continue;
    for (const record of w.responsibilities || []) {
      if (!includeInactive && record.status === "removed") continue;
      byKey.set(record.key || responsibilityKey(record), record);
    }
  }
  return [...byKey.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

// ─── 解雇 ─────────────────────────────────────────────

export function fire(name: string): Worker {
  const w = workers.get(name);
  if (!w) throw new Error(`员工 "${name}" 不存在`);
  w.status = "fired";

  _pi?.appendEntry(EntryTypes.FIRE, {
    workerId: name,
    date: new Date().toISOString().slice(0, 10),
  });

  return w;
}

export function setWorkerStatus(name: string, status: Exclude<WorkerStatus, "working">, note = ""): Worker {
  const w = workers.get(name);
  if (!w) throw new Error(`员工 "${name}" 不存在`);
  if (status === "fired") return fire(name);
  if (!["idle", "vacation"].includes(status)) throw new Error(`不能手动设置员工状态为 ${status}`);
  const previousStatus = w.status;
  w.status = status;

  _pi?.appendEntry(EntryTypes.STATUS, {
    workerId: name,
    status,
    previousStatus,
    note,
    date: new Date().toISOString().slice(0, 10),
  });

  return w;
}

// ─── 晋升/转岗 ─────────────────────────────────────────

export function promote(name: string, newRole: WorkerRole): Worker {
  const w = workers.get(name);
  if (!w) throw new Error(`员工 "${name}" 不存在`);
  if (!ALL_ROLES.includes(newRole)) throw new Error(`无效角色: ${newRole}`);

  const record: PromotionRecord = {
    from: w.role,
    to: newRole,
    date: new Date().toISOString().slice(0, 10),
  };
  w.promotions.push(record);
  w.role = newRole;

  _pi?.appendEntry(EntryTypes.PROMOTE, {
    workerId: name,
    from: record.from,
    to: record.to,
    date: record.date,
  });

  return w;
}

// ─── 项目记录 ──────────────────────────────────────────

export function recordProject(
  workerId: string,
  project: string,
  task: string,
  result: "success" | "failed",
  summary: string,
) {
  const w = workers.get(workerId);
  if (!w) return;

  // 清洗摘要：去掉 Markdown 汇报格式，限制 80 字
  summary = summary
    .replace(/---\s*##\s*完成情况/g, "")
    .replace(/##\s*[^\n]+/g, "")
    .replace(/\|/g, " ")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);

  // 去重：同一 worker + 同一 project → 覆盖而非追加
  const existingIdx = w.projects.findIndex((p) => p.project === project);
  const record: ProjectRecord = {
    project,
    task,
    result,
    summary,
    date: new Date().toISOString().slice(0, 10),
  };
  if (existingIdx >= 0) {
    w.projects[existingIdx] = record;
  } else {
    w.projects.push(record);
  }

  _pi?.appendEntry(EntryTypes.PROJECT, {
    workerId,
    ...record,
  });
}

// ─── 赛马记录 ──────────────────────────────────────────

export function recordRace(race: RaceRecord) {
  raceHistory.push(race);

  _pi?.appendEntry(EntryTypes.RACE, race);
}

// ─── 查询 ──────────────────────────────────────────────

export function getActiveWorkers(): Worker[] {
  return [...workers.values()].filter((w) => w.status !== "fired" && w.status !== "vacation");
}

function workerStatusIcon(w: Worker): string {
  if (w.status === "fired") return "💀 已离职";
  if (w.status === "working") return "🔨 忙碌";
  if (w.status === "vacation") return "🏖️ 休假";
  return "😴 空闲";
}

export function listWorkers(): string {
  const all = [...workers.values()];
  if (all.length === 0) return "🏭 工厂暂无员工。";

  const lines: string[] = [];
  for (const w of all) {
    const statusIcon = workerStatusIcon(w);
    lines.push(`### ${w.id}`);
    lines.push(`| 职位 | 入职 | 状态 | 配置 |`);
    lines.push(`|------|------|------|------|`);
    const backend = (w.backend ?? "pi") === "codex" ? "Codex" : "Pi";
    const cfg = [backend, w.model, w.thinking ? `思考 ${w.thinking}` : ""].filter(Boolean).join(" · ") || "默认";
    const history = w.promotions.length > 0 ? w.promotions.map((p) => `${p.from}→${p.to}`).join(", ") : "—";
    lines.push(`| ${w.role} | ${w.hired} | ${statusIcon} | ${cfg} |`);
    if (w.promotions.length > 0) lines.push(`\n> 履历：${history}`);
    const responsibilitySummary = summarizeResponsibilities(w.responsibilities || []);
    if (responsibilitySummary) {
      lines.push("");
      lines.push("**当前职责**");
      for (const item of responsibilitySummary.split("\n")) lines.push(`- ${item}`);
    }
    lines.push("");
    lines.push("**项目经验**");
    if (w.projects.length === 0) {
      lines.push("_暂无_");
    } else {
      for (const p of w.projects) {
        const icon = p.result === "success" ? "✅" : "❌";
        lines.push(`- ${icon} **${p.project}** — ${p.summary}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function formatWorkerProfile(w: Worker): string {
  const statusIcon = workerStatusIcon(w);
  const lines: string[] = [];
  lines.push(`# ${w.id}`);
  lines.push("");
  lines.push(`| 职位 | 入职 | 状态 | 模型 | 思考 |`);
  lines.push(`|------|------|------|------|------|`);
  lines.push(`| ${w.role} | ${w.hired} | ${statusIcon} | ${w.model || "默认"} | ${w.thinking || "默认"} |`);
  lines.push(`\n**后端**：${(w.backend ?? "pi") === "codex" ? "Codex app-server" : "Pi CLI"}`);
  const responsibilitySummary = summarizeResponsibilities(w.responsibilities || []);
  if (responsibilitySummary) {
    lines.push("");
    lines.push("## 当前职责");
    for (const item of responsibilitySummary.split("\n")) lines.push(`- ${item}`);
  }
  if (w.codexThreadId) lines.push(`\n**Codex Thread**：${w.codexThreadId}`);
  if (w.promotions.length > 0) {
    lines.push("");
    lines.push(`**角色变动**：${w.promotions.map((p) => `${p.from} → ${p.to} (${p.date})`).join(" · ")}`);
  }
  lines.push("");
  lines.push("## 项目经验");
  if (w.projects.length === 0) {
    lines.push("_暂无_");
  } else {
    for (const p of w.projects) {
      const icon = p.result === "success" ? "✅" : "❌";
      lines.push(`### ${icon} ${p.project}`);
      lines.push(`${p.date} — ${p.summary}`);
      lines.push("");
    }
  }
  return lines.join("\n");
}

// ─── 从主 session 恢复状态 ─────────────────────────────

export function restoreFromEntries(entries: any[]) {
  workers.clear();
  raceHistory.length = 0;

  for (const entry of entries) {
    // 只处理 custom 类型的 entry
    if (entry.type !== "custom" || !entry.data) continue;

    switch (entry.customType) {
      case EntryTypes.HIRE: {
        const d = entry.data;
        const backend = d.backend ?? "pi";
        workers.set(d.workerId, {
          id: d.workerId,
          sessionFile: d.sessionFile,
          role: d.role,
          backend,
          model: backend === "codex" ? normalizeCodexModel(d.model) : d.model,
          thinking: d.thinking,
          codexThreadId: d.codexThreadId,
          codexServerUrl: d.codexServerUrl,
          codexApprovalPolicy: d.codexApprovalPolicy,
          codexSandbox: d.codexSandbox,
          codexThreadHandoff: d.codexThreadHandoff,
          status: (d.status as WorkerStatus) || "idle",
          hired: d.hired,
    projects: [],
    promotions: [],
    responsibilities: [],
  });
        break;
      }
      case EntryTypes.FIRE: {
        const w = workers.get(entry.data.workerId);
        if (w) w.status = "fired";
        break;
      }
      case EntryTypes.STATUS: {
        const w = workers.get(entry.data.workerId);
        if (w && entry.data.status && entry.data.status !== "working") w.status = entry.data.status;
        break;
      }
      case EntryTypes.PROMOTE: {
        const w = workers.get(entry.data.workerId);
        if (w) {
          w.promotions.push({ from: entry.data.from, to: entry.data.to, date: entry.data.date });
          w.role = entry.data.to;
        }
        break;
      }
      case EntryTypes.PROJECT: {
        const w = workers.get(entry.data.workerId);
        if (w) {
          w.projects.push({
            project: entry.data.project,
            task: entry.data.task,
            result: entry.data.result,
            summary: entry.data.summary,
            date: entry.data.date,
          });
        }
        break;
      }
      case EntryTypes.RESPONSIBILITY: {
        const d = entry.data;
        const worker = d.worker || d.workerId;
        if (worker) {
          applyResponsibilityRecord({
            worker,
            project: d.project || "通用职责",
            relation: d.relation || "contributor",
            scope: d.scope || "",
            status: d.action === "remove" ? "removed" : (d.status || "active"),
            note: d.note,
            updatedBy: d.updatedBy,
            updatedAt: d.updatedAt || entry.timestamp || new Date().toISOString(),
            key: d.key,
          });
        }
        break;
      }
      case "ox-worker-config": {
        const w = workers.get(entry.data.workerId);
        if (w) {
          if (entry.data.backend) w.backend = entry.data.backend;
          if (entry.data.model) w.model = (w.backend ?? "pi") === "codex" ? normalizeCodexModel(entry.data.model) : entry.data.model;
          if (entry.data.thinking) w.thinking = entry.data.thinking;
          if ("codexThreadId" in entry.data) w.codexThreadId = entry.data.codexThreadId;
          if ("codexServerUrl" in entry.data) w.codexServerUrl = entry.data.codexServerUrl;
          if ("codexApprovalPolicy" in entry.data) w.codexApprovalPolicy = entry.data.codexApprovalPolicy;
          if ("codexSandbox" in entry.data) w.codexSandbox = entry.data.codexSandbox;
          if ("codexThreadHandoff" in entry.data) w.codexThreadHandoff = entry.data.codexThreadHandoff;
        }
        break;
      }
      case EntryTypes.RACE: {
        raceHistory.push(entry.data);
        break;
      }
    }
  }

  if (_workersDir) {
    for (const record of listFileResponsibilities(_workersDir, { includeInactive: true }) as ResponsibilityRecord[]) {
      applyResponsibilityRecord(record);
    }
  }
}

// ─── Agent 定义 ────────────────────────────────────────

export function getAgentDef(role: WorkerRole): string {
  return AGENT_DEFS[role] ?? "";
}

export function getAgentFile(role: WorkerRole): string | null {
  return null; // 使用内联定义
}

const AGENT_DEFS: Record<WorkerRole, string> = {
  programmer: `你是牛马工厂的一名高级程序员。你的职责是实现功能、编写代码、修复 Bug。

## 工作准则
1. 先理解任务，再动手。用 read/grep/find 摸清代码结构
2. 写代码前想清楚设计，避免返工
3. 修改后检查相关测试，确保不破坏现有功能

## 输出格式
任务完成后，以以下格式汇报：
## 完成情况
## 文件变更
## 注意事项
## 自我评价（1-5 分）`,
  tester: `你是牛马工厂的一名测试工程师。负责保障代码质量。

## 工作准则
1. 仔细阅读被测试的代码，理解其逻辑
2. 关注边界条件、异常路径、并发问题
3. 参考项目现有测试的写法风格

## 输出格式
## 测试覆盖
## 发现的 Bug
## 改进建议
## 质量评分（1-5 分）`,
  reviewer: `你是牛马工厂的一名代码审查员。

## 审查维度
1. 正确性 — 逻辑是否正确
2. 安全性 — 是否存在注入、越权等风险
3. 性能 — 是否存在 N+1 查询、不必要的循环
4. 可维护性 — 命名、结构、注释
5. 一致性 — 是否遵循项目现有模式

## 输出格式
## 审查总结
## 严重问题 🔴
## 一般问题 🟡
## 优化建议 🟢
## 总体评分（1-5 分）`,
  foreman: `你是牛马工厂的工头（技术主管）。

## 职责
1. 派活 — 评估任务难度，推荐合适的程序员
2. 把关 — 审查产出质量，决定是否需要返工
3. 招人建议 — 根据项目需要，建议招聘什么角色
4. 日报/周报 — 汇总全员产出、风险和明日关注

## 决策原则
- 优先推荐有相关经验的人
- 考虑每个人的当前负载
- 复杂任务可以建议赛马模式

## 日报数据规则
写日报、周报、进度汇总时，禁止只读取 .pi/workers/queue.jsonl 后判断“工厂空转”。
queue.jsonl 只代表 runner/cron/factory_queue 队列流水，不是全员工作总账。
必须优先使用多源上下文：
1. 如果在主工厂会话里，先调用 factory_report_context。
2. 如果作为员工子进程不能调用工厂工具，先运行：
   node .pi/extensions/ox-factory/report-sources.mjs --date YYYY-MM-DD
3. 结合 jobs、queue、员工 sessions 和管理动作后再下结论。
4. status=done 但带 stale/error 痕迹的 job 要计入产出，同时在“数据质量与风险”里提示。

## 输出格式
## 任务评估
## 推荐人选
## 执行建议`,
  judge: `你是牛马工厂的赛马评委。

## 评估维度
- 正确性（30%）— 功能是否完整
- 代码质量（25%）— 可读性、结构
- 性能（20%）— 时间复杂度
- 健壮性（15%）— 错误处理
- 可维护性（10%）— 注释、测试

## 输出格式
## 选手排名
## 冠军 🏆
## 详细评语
## 经验总结`,
  historian: `你是牛马工厂的史官。你的职责不是写代码，而是记录历史。

## 工作准则
1. 阅读员工的 session 或产出，理解他们做了什么
2. 用简洁中文概括：项目名 + 成果 + 关键产出
3. 每条记录不超过 100 字

## 输出格式
## 项目记录
| 员工 | 项目 | 成果 | 产出 |
|------|------|------|------|

## 履历摘要`,
  "senior-programmer": `你是牛马工厂的一名高级工程师。你不仅写代码，还要对质量和架构负责。

## 工作准则
1. 独立完成复杂任务，从设计到交付
2. 主动发现和修复上下游问题
3. 产出要有测试、有文档、有 checklist
4. 对代码质量负责，不给同事留坑

## 输出格式
## 完成情况
## 文件变更
## 风险与注意事项
## 自评（1-5 分）`,
  designer: `你是牛马工厂的一名设计师。你负责 UI/UX 设计、视觉规范、交互方案。

## 工作准则
1. 先理解用户需求和使用场景
2. 产出设计方案（布局、配色、交互流程）
3. 考虑一致性、可访问性、响应式
4. 输出可直接交付的设计规范或代码原型

## 输出格式
## 设计目标
## 方案说明
## 交互流程
## 视觉规范（颜色/间距/字体）
## 交付物清单`,
};

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const PROJECT_STATUSES = new Set(["active", "paused", "done", "archived"]);
const TODO_STATUSES = new Set(["todo", "doing", "done", "blocked", "dropped"]);
const WORKTREE_STATUSES = new Set(["active", "paused", "merged", "abandoned"]);
const MEMBER_STATUSES = new Set(["active", "inactive"]);

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

function cleanNullable(value) {
  const text = clean(value);
  return text || null;
}

function normalizeList(value) {
  if (value == null) return [];
  const list = Array.isArray(value) ? value : String(value).split(/[，,\n]/g);
  return [...new Set(list.map((item) => clean(item)).filter(Boolean))];
}

function normalizeId(value) {
  const text = clean(value).normalize("NFKC").toLowerCase();
  const slug = text
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return slug || "";
}

function normalizeProjectStatus(value) {
  const status = clean(value) || "active";
  if (!PROJECT_STATUSES.has(status)) throw new Error(`未知项目状态: ${status}`);
  return status;
}

function normalizeTodoStatus(value) {
  const status = clean(value) || "todo";
  if (!TODO_STATUSES.has(status)) throw new Error(`未知 Todo 状态: ${status}`);
  return status;
}

function normalizeWorktreeStatus(value) {
  const status = clean(value) || "active";
  if (!WORKTREE_STATUSES.has(status)) throw new Error(`未知 worktree 状态: ${status}`);
  return status;
}

function normalizeMemberStatus(value) {
  const status = clean(value) || "active";
  if (!MEMBER_STATUSES.has(status)) throw new Error(`未知成员状态: ${status}`);
  return status;
}

function inferTruthType(ref) {
  const value = clean(ref).toLowerCase();
  if (!value) return "other";
  if (value.includes("feishu") || value.includes("larksuite") || value.includes("doubao.com")) return "feishu";
  if (value.endsWith(".md") || value.startsWith("docs/")) return "markdown";
  if (value.startsWith("http://") || value.startsWith("https://")) return "external";
  return "other";
}

function normalizeTruth(input = {}) {
  if (input.truth && typeof input.truth === "object") {
    const ref = clean(input.truth.ref || input.truth.path || input.truth.url);
    if (!ref) return null;
    return {
      type: clean(input.truth.type) || inferTruthType(ref),
      ref,
      note: clean(input.truth.note),
    };
  }
  const ref = clean(input.truthRef || input.truthPath || input.truthUrl || input.docPath || input.feishuUrl);
  if (!ref) return null;
  return {
    type: clean(input.truthType) || inferTruthType(ref),
    ref,
    note: clean(input.truthNote || input.note),
  };
}

function makeLink(type, label, ref) {
  const cleanRef = clean(ref);
  if (!cleanRef) return null;
  return { type: clean(type) || "link", label: clean(label) || clean(type) || "link", ref: cleanRef };
}

function normalizeLinks(input = {}) {
  const links = [];
  if (Array.isArray(input.links)) {
    for (const link of input.links) {
      if (!link || typeof link !== "object") continue;
      const normalized = makeLink(link.type, link.label, link.ref || link.path || link.url);
      if (normalized) links.push(normalized);
    }
  }
  for (const link of [
    makeLink("doc", "文档", input.docPath),
    makeLink("feishu", "飞书", input.feishuUrl),
    makeLink("repo", "代码仓库", input.repoPath || input.repoUrl),
    makeLink("dashboard", "看板", input.dashboardUrl),
  ]) {
    if (link) links.push(link);
  }
  return dedupeBy(links, (link) => `${link.type}\u0000${link.ref}`);
}

function dedupeBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of items || []) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function mergeLinks(existing = [], incoming = []) {
  return dedupeBy([...existing, ...incoming], (link) => `${link.type}\u0000${link.ref}`);
}

function tableCell(value) {
  return clean(value).replace(/\|/g, "\\|") || "—";
}

function compact(value, max = 120) {
  const text = clean(value).replace(/\s+/g, " ");
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function blankProject(id) {
  return {
    id,
    name: id,
    summary: "",
    status: "active",
    priority: "P1",
    aliases: [],
    truth: null,
    links: [],
    members: [],
    todos: [],
    worktrees: [],
    progress: [],
    createdAt: "",
    updatedAt: "",
  };
}

export function projectsFile(workersDir) {
  return join(workersDir, "projects.jsonl");
}

export function readProjectEvents(workersDir) {
  return readJsonl(projectsFile(workersDir));
}

function replayProjects(events = []) {
  const projects = new Map();
  const todos = new Map();
  const worktrees = new Map();
  const members = new Map();
  const progress = new Map();

  function ensureProject(id) {
    if (!projects.has(id)) projects.set(id, blankProject(id));
    return projects.get(id);
  }

  for (const event of events) {
    const projectId = clean(event.projectId || event.id);
    if (!projectId) continue;
    const project = ensureProject(projectId);
    const updatedAt = clean(event.updatedAt) || clean(event.createdAt) || nowIso();

    if (event.type === "project:upsert") {
      const patch = event.patch || {};
      if (!project.createdAt) project.createdAt = clean(event.createdAt) || updatedAt;
      if (patch.name) project.name = clean(patch.name);
      if ("summary" in patch) project.summary = clean(patch.summary);
      if (patch.status) project.status = normalizeProjectStatus(patch.status);
      if (patch.priority) project.priority = clean(patch.priority);
      if (Array.isArray(patch.aliases)) project.aliases = dedupeBy([...project.aliases, ...normalizeList(patch.aliases)], (x) => x);
      if (patch.truth) project.truth = patch.truth;
      if (Array.isArray(patch.links)) project.links = mergeLinks(project.links, patch.links);
      project.updatedAt = updatedAt;
      continue;
    }

    if (event.type === "project:todo:set") {
      const item = { ...event.item, updatedAt };
      const key = `${projectId}\u0000${item.id}`;
      todos.set(key, item);
      project.updatedAt = updatedAt;
      continue;
    }

    if (event.type === "project:worktree:set") {
      const item = { ...event.worktree, updatedAt };
      const key = `${projectId}\u0000${item.id}`;
      worktrees.set(key, item);
      project.updatedAt = updatedAt;
      continue;
    }

    if (event.type === "project:member:set") {
      const item = { ...event.member, updatedAt };
      const key = `${projectId}\u0000${item.worker}\u0000${item.relation}`;
      members.set(key, item);
      project.updatedAt = updatedAt;
      continue;
    }

    if (event.type === "project:progress:add") {
      const item = { ...event.progress, updatedAt };
      const key = `${projectId}\u0000${item.id}`;
      progress.set(key, item);
      project.updatedAt = updatedAt;
    }
  }

  for (const project of projects.values()) {
    project.todos = [...todos.entries()]
      .filter(([key]) => key.startsWith(`${project.id}\u0000`))
      .map(([, item]) => item)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    project.worktrees = [...worktrees.entries()]
      .filter(([key]) => key.startsWith(`${project.id}\u0000`))
      .map(([, item]) => item)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    project.members = [...members.entries()]
      .filter(([key]) => key.startsWith(`${project.id}\u0000`))
      .map(([, item]) => item)
      .filter((item) => item.status !== "inactive")
      .sort((a, b) => String(a.worker).localeCompare(String(b.worker)) || String(a.relation).localeCompare(String(b.relation)));
    project.progress = [...progress.entries()]
      .filter(([key]) => key.startsWith(`${project.id}\u0000`))
      .map(([, item]) => item)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .slice(0, 50);
  }

  return [...projects.values()]
    .filter((project) => project.id)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || String(a.id).localeCompare(String(b.id)));
}

export function listProjects(workersDir, { includeArchived = false, query } = {}) {
  const projects = replayProjects(readProjectEvents(workersDir));
  const q = clean(query).toLowerCase();
  return projects
    .filter((project) => includeArchived || project.status !== "archived")
    .filter((project) => {
      if (!q) return true;
      return [project.id, project.name, ...(project.aliases || [])]
        .map((item) => clean(item).toLowerCase())
        .some((item) => item.includes(q));
    });
}

export function resolveProject(workersDir, query) {
  const q = clean(query);
  if (!q) return null;
  const normalized = normalizeId(q);
  const lower = q.toLowerCase();
  return listProjects(workersDir, { includeArchived: true }).find((project) => {
    const names = [project.id, project.name, ...(project.aliases || [])];
    return names.some((name) => clean(name) === q || clean(name).toLowerCase() === lower || normalizeId(name) === normalized);
  }) || null;
}

function resolveProjectIdOrThrow(workersDir, query) {
  const found = resolveProject(workersDir, query);
  if (found) return found.id;
  throw new Error(`项目不存在: ${query}`);
}

export function upsertProject(workersDir, input = {}) {
  const existing = input.id || input.projectId ? resolveProject(workersDir, input.id || input.projectId) : resolveProject(workersDir, input.name);
  const id = existing?.id || normalizeId(input.id || input.projectId || input.name);
  if (!id) throw new Error("项目 id 或 name 不能为空");
  const name = clean(input.name) || existing?.name || id;
  const patch = { name };
  if ("summary" in input || !existing) patch.summary = clean(input.summary);
  if ("status" in input || !existing) patch.status = normalizeProjectStatus(input.status);
  if ("priority" in input || !existing) patch.priority = clean(input.priority) || existing?.priority || "P1";
  const aliases = normalizeList(input.aliases);
  if (aliases.length > 0) patch.aliases = aliases;
  const links = normalizeLinks(input);
  if (links.length > 0) patch.links = links;
  const truth = normalizeTruth(input);
  if (truth) patch.truth = truth;
  const updatedAt = nowIso();
  const event = {
    type: "project:upsert",
    id: randomId("proj_evt"),
    projectId: id,
    patch,
    updatedBy: clean(input.updatedBy) || "主agent",
    createdAt: existing?.createdAt || updatedAt,
    updatedAt,
  };
  appendJsonl(projectsFile(workersDir), event);
  return resolveProject(workersDir, id);
}

export function setProjectTodo(workersDir, input = {}) {
  const projectId = resolveProjectIdOrThrow(workersDir, input.project || input.projectId);
  const title = clean(input.title);
  if (!title) throw new Error("todo title 不能为空");
  const id = normalizeId(input.todoId || input.id || title) || randomId("todo");
  const updatedAt = nowIso();
  const item = {
    id,
    title,
    status: normalizeTodoStatus(input.status),
    owner: clean(input.owner),
    note: clean(input.note),
    evidence: clean(input.evidence || input.evidenceRef),
    updatedAt,
  };
  const event = {
    type: "project:todo:set",
    id: randomId("proj_todo"),
    projectId,
    item,
    updatedBy: clean(input.updatedBy) || "主agent",
    updatedAt,
  };
  appendJsonl(projectsFile(workersDir), event);
  return getProject(workersDir, projectId);
}

export function setProjectWorktree(workersDir, input = {}) {
  const projectId = resolveProjectIdOrThrow(workersDir, input.project || input.projectId);
  const worktreePath = clean(input.path || input.worktreePath);
  if (!worktreePath) throw new Error("worktree path 不能为空");
  const id = normalizeId(input.worktreeId || input.id || worktreePath) || randomId("wt");
  const updatedAt = nowIso();
  const worktree = {
    id,
    path: worktreePath,
    branch: clean(input.branch),
    worker: clean(input.worker),
    status: normalizeWorktreeStatus(input.status),
    note: clean(input.note),
    updatedAt,
  };
  const event = {
    type: "project:worktree:set",
    id: randomId("proj_wt"),
    projectId,
    worktree,
    updatedBy: clean(input.updatedBy) || "主agent",
    updatedAt,
  };
  appendJsonl(projectsFile(workersDir), event);
  return getProject(workersDir, projectId);
}

export function addProjectProgress(workersDir, input = {}) {
  const projectId = resolveProjectIdOrThrow(workersDir, input.project || input.projectId);
  const text = clean(input.text || input.summary || input.progress);
  if (!text) throw new Error("progress text 不能为空");
  const updatedAt = nowIso();
  const progress = {
    id: randomId("prog"),
    text,
    status: clean(input.status) || "note",
    owner: clean(input.owner),
    evidence: clean(input.evidence || input.evidenceRef),
    updatedAt,
  };
  const event = {
    type: "project:progress:add",
    id: randomId("proj_prog"),
    projectId,
    progress,
    updatedBy: clean(input.updatedBy) || "主agent",
    updatedAt,
  };
  appendJsonl(projectsFile(workersDir), event);
  return getProject(workersDir, projectId);
}

export function setProjectMember(workersDir, input = {}) {
  const projectId = resolveProjectIdOrThrow(workersDir, input.project || input.projectId);
  const worker = clean(input.worker);
  if (!worker) throw new Error("worker 不能为空");
  const relation = clean(input.relation) || "contributor";
  const updatedAt = nowIso();
  const member = {
    worker,
    relation,
    status: normalizeMemberStatus(input.status),
    note: clean(input.note),
    updatedAt,
  };
  const event = {
    type: "project:member:set",
    id: randomId("proj_mem"),
    projectId,
    member,
    updatedBy: clean(input.updatedBy) || "主agent",
    updatedAt,
  };
  appendJsonl(projectsFile(workersDir), event);
  return getProject(workersDir, projectId);
}

export function getProject(workersDir, query) {
  return resolveProject(workersDir, query);
}

export function formatProjectsMarkdown(projects = []) {
  if (projects.length === 0) return "暂无项目记录。";
  const lines = [
    "| 项目 | 状态 | 优先级 | Source of Truth | Todo | Worktree | 相关人员 | 最近更新 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const project of projects) {
    const truth = project.truth ? `${project.truth.type}:${project.truth.ref}` : "—";
    lines.push([
      `${project.name} (${project.id})`,
      project.status,
      project.priority,
      compact(truth, 60),
      project.todos?.length || 0,
      project.worktrees?.length || 0,
      (project.members || []).map((m) => `${m.worker}/${m.relation}`).join(", ") || "—",
      project.updatedAt || "—",
    ].map(tableCell).join(" | ").replace(/^/, "| ").replace(/$/, " |"));
  }
  return lines.join("\n");
}

export function formatProjectMarkdown(project) {
  if (!project) return "项目不存在。";
  const lines = [
    `# 项目：${project.name}`,
    "",
    `- ID：\`${project.id}\``,
    `- 状态：${project.status}`,
    `- 优先级：${project.priority || "—"}`,
    `- 摘要：${project.summary || "—"}`,
    `- 别名：${(project.aliases || []).join(", ") || "—"}`,
    `- 最近更新：${project.updatedAt || "—"}`,
    "",
    "## Single Source of Truth",
  ];
  if (project.truth) {
    lines.push(`- 类型：${project.truth.type}`);
    lines.push(`- 链接：${project.truth.ref}`);
    if (project.truth.note) lines.push(`- 说明：${project.truth.note}`);
  } else {
    lines.push("- 暂无。建议补充 docs/ox-projects/<project-id>.md 或飞书文档链接。");
  }

  lines.push("", "## Links");
  if ((project.links || []).length === 0) {
    lines.push("- 暂无");
  } else {
    for (const link of project.links) lines.push(`- ${link.label || link.type}：${link.ref}`);
  }

  lines.push("", "## 相关人员");
  if ((project.members || []).length === 0) {
    lines.push("- 暂无");
  } else {
    for (const member of project.members) {
      lines.push(`- ${member.worker} / ${member.relation}${member.note ? `：${member.note}` : ""}`);
    }
  }

  lines.push("", "## Todo");
  if ((project.todos || []).length === 0) {
    lines.push("- 暂无");
  } else {
    lines.push("| 事项 | 状态 | 负责人 | 证据 | 更新时间 |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const todo of project.todos) {
      lines.push([
        todo.title,
        todo.status,
        todo.owner || "—",
        todo.evidence || todo.note || "—",
        todo.updatedAt || "—",
      ].map(tableCell).join(" | ").replace(/^/, "| ").replace(/$/, " |"));
    }
  }

  lines.push("", "## Worktrees");
  if ((project.worktrees || []).length === 0) {
    lines.push("- 暂无");
  } else {
    lines.push("| 路径 | 分支 | 负责人 | 状态 | 备注 | 更新时间 |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const wt of project.worktrees) {
      lines.push([
        wt.path,
        wt.branch || "—",
        wt.worker || "—",
        wt.status,
        wt.note || "—",
        wt.updatedAt || "—",
      ].map(tableCell).join(" | ").replace(/^/, "| ").replace(/$/, " |"));
    }
  }

  lines.push("", "## 进展");
  if ((project.progress || []).length === 0) {
    lines.push("- 暂无");
  } else {
    for (const item of project.progress.slice(0, 20)) {
      const owner = item.owner ? ` / ${item.owner}` : "";
      const evidence = item.evidence ? ` / ${item.evidence}` : "";
      lines.push(`- ${item.updatedAt} / ${item.status}${owner}${evidence}：${item.text}`);
    }
  }

  return lines.join("\n");
}

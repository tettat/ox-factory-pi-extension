import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const BUILTIN_ADMINS = new Set(["秘书", "主agent", "主Agent", "user", "用户", "secretary", "派派"]);
const KNOWN_ACTIONS = new Set([
  "*",
  "message:send",
  "message:broadcast",
  "work:request",
  "work:assign",
  "permission:manage",
  "worker:fire",
]);

function nowIso() {
  return new Date().toISOString();
}

function randomId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function ensureDir(file) {
  mkdirSync(dirname(file), { recursive: true });
}

export function permissionsFile(workersDir) {
  return join(workersDir, "permissions.json");
}

export function permissionEventsFile(workersDir) {
  return join(workersDir, "permission-events.jsonl");
}

export function messagesFile(workersDir) {
  return join(workersDir, "messages.jsonl");
}

function normalizeList(value, fallback = []) {
  if (value == null) return fallback;
  const list = Array.isArray(value) ? value : [value];
  return [...new Set(list.map((item) => String(item || "").trim()).filter(Boolean))];
}

function normalizeActions(actions) {
  const list = normalizeList(actions);
  if (list.length === 0) throw new Error("actions 不能为空");
  for (const action of list) {
    if (!KNOWN_ACTIONS.has(action)) throw new Error(`未知权限动作: ${action}`);
  }
  return list;
}

function normalizeTargets(targets) {
  const list = normalizeList(targets);
  if (list.length === 0) throw new Error("targets 不能为空");
  return list;
}

function readJsonFile(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonFile(file, data) {
  ensureDir(file);
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
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

function initialPermissionsState() {
  return { version: 1, grants: [] };
}

export function readPermissions(workersDir) {
  const state = readJsonFile(permissionsFile(workersDir), initialPermissionsState());
  if (!Array.isArray(state.grants)) state.grants = [];
  if (!state.version) state.version = 1;
  return state;
}

function writePermissions(workersDir, state) {
  writeJsonFile(permissionsFile(workersDir), state);
}

function isBuiltinAdmin(subject) {
  return BUILTIN_ADMINS.has(String(subject || "").trim());
}

function grantMatches(grant, { subject, action, target }) {
  if (grant.revokedAt) return false;
  if (grant.subject !== subject) return false;
  const actions = grant.actions || [];
  const targets = grant.targets || [];
  const actionMatch = actions.includes("*") || actions.includes(action);
  const targetMatch = targets.includes("*") || targets.includes(target);
  return actionMatch && targetMatch;
}

export function hasPermission(workersDir, { subject, action, target }) {
  const normalizedSubject = String(subject || "").trim();
  if (!normalizedSubject) return false;
  if (isBuiltinAdmin(normalizedSubject)) return true;
  if (!KNOWN_ACTIONS.has(action)) return false;
  const normalizedTarget = String(target || "").trim();
  if (!normalizedTarget) return false;
  const state = readPermissions(workersDir);
  return state.grants.some((grant) => grantMatches(grant, {
    subject: normalizedSubject,
    action,
    target: normalizedTarget,
  }));
}

export function grantPermission(workersDir, input) {
  const subject = String(input.subject || "").trim();
  if (!subject) throw new Error("subject 不能为空");
  const actions = normalizeActions(input.actions);
  const targets = normalizeTargets(input.targets);
  const grantedBy = String(input.grantedBy || "秘书").trim();
  const state = readPermissions(workersDir);

  const existing = state.grants.find((grant) =>
    !grant.revokedAt &&
    grant.subject === subject &&
    JSON.stringify(grant.actions) === JSON.stringify(actions) &&
    JSON.stringify(grant.targets) === JSON.stringify(targets)
  );
  if (existing) return existing;

  const grant = {
    id: randomId("grant"),
    subject,
    actions,
    targets,
    grantedBy,
    note: String(input.note || "").trim(),
    createdAt: nowIso(),
  };
  state.grants.push(grant);
  writePermissions(workersDir, state);
  appendJsonl(permissionEventsFile(workersDir), { type: "grant", ...grant });
  return grant;
}

function intersects(left = [], right = []) {
  if (right.length === 0) return true;
  return left.some((item) => right.includes(item));
}

export function revokePermission(workersDir, input) {
  const subject = String(input.subject || "").trim();
  if (!subject) throw new Error("subject 不能为空");
  const actions = input.actions == null ? [] : normalizeActions(input.actions);
  const targets = input.targets == null ? [] : normalizeTargets(input.targets);
  const revokedBy = String(input.revokedBy || "秘书").trim();
  const state = readPermissions(workersDir);
  const revokedAt = nowIso();
  const revoked = [];

  state.grants = state.grants.filter((grant) => {
    const match =
      !grant.revokedAt &&
      grant.subject === subject &&
      intersects(grant.actions || [], actions) &&
      intersects(grant.targets || [], targets);
    if (!match) return true;
    revoked.push({ ...grant, revokedAt, revokedBy });
    return false;
  });

  writePermissions(workersDir, state);
  for (const grant of revoked) {
    appendJsonl(permissionEventsFile(workersDir), { type: "revoke", ...grant });
  }
  return revoked;
}

export function listPermissions(workersDir, { subject } = {}) {
  const state = readPermissions(workersDir);
  return state.grants.filter((grant) => !subject || grant.subject === subject);
}

function requiredMessageAction(to) {
  return String(to || "").trim() === "*" ? "message:broadcast" : "message:send";
}

export function sendAuthorizedMessage(workersDir, input) {
  const from = String(input.from || "秘书").trim();
  const to = String(input.to || "").trim();
  const content = String(input.content || "").trim();
  if (!from) throw new Error("from 不能为空");
  if (!to) throw new Error("to 不能为空");
  if (!content) throw new Error("content 不能为空");

  const action = requiredMessageAction(to);
  if (!hasPermission(workersDir, { subject: from, action, target: to })) {
    throw new Error(`${from} 没有权限对 ${to} 执行 ${action}`);
  }

  const message = {
    type: "message",
    id: randomId("msg"),
    from,
    to,
    content,
    createdAt: nowIso(),
  };
  appendJsonl(messagesFile(workersDir), message);
  return message;
}

function messageVisibleTo(message, worker, includeSent) {
  if (message.type !== "message") return false;
  if (message.to === "*" || message.to === worker) return true;
  return Boolean(includeSent && message.from === worker);
}

export function listMessages(workersDir, { worker, unreadOnly = false, includeSent = false, limit = 50 } = {}) {
  const name = String(worker || "").trim();
  if (!name) throw new Error("worker 不能为空");
  const entries = readJsonl(messagesFile(workersDir));
  const reads = new Set(
    entries
      .filter((entry) => entry.type === "read" && entry.worker === name)
      .map((entry) => entry.messageId),
  );

  const messages = entries
    .filter((entry) => messageVisibleTo(entry, name, includeSent))
    .map((entry) => ({ ...entry, read: reads.has(entry.id) }))
    .filter((entry) => !unreadOnly || !entry.read)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  return messages.slice(-Math.max(1, Number(limit) || 50));
}

export function markMessageRead(workersDir, { messageId, worker }) {
  const id = String(messageId || "").trim();
  const name = String(worker || "").trim();
  if (!id) throw new Error("messageId 不能为空");
  if (!name) throw new Error("worker 不能为空");
  const existing = readJsonl(messagesFile(workersDir)).find((entry) => entry.type === "read" && entry.messageId === id && entry.worker === name);
  if (existing) return existing;
  const event = {
    type: "read",
    messageId: id,
    worker: name,
    readAt: nowIso(),
  };
  appendJsonl(messagesFile(workersDir), event);
  return event;
}

export function formatPermissions(grants) {
  if (!grants.length) return "暂无授权。";
  return [
    "| 授权对象 | 动作 | 目标 | 授权人 | 备注 | 时间 |",
    "|---|---|---|---|---|---|",
    ...grants.map((grant) =>
      `| ${grant.subject} | ${(grant.actions || []).join(", ")} | ${(grant.targets || []).join(", ")} | ${grant.grantedBy || "-"} | ${grant.note || "-"} | ${grant.createdAt || "-"} |`
    ),
  ].join("\n");
}

export function formatMessages(messages, title = "员工消息") {
  if (!messages.length) return `## ${title}\n\n暂无消息。`;
  const lines = [`## ${title}`, ""];
  for (const message of messages) {
    const read = message.read ? "已读" : "未读";
    lines.push(`- ${read} | \`${message.id}\` | **${message.from}** → **${message.to}** | ${message.createdAt}`);
    lines.push(`  ${message.content}`);
  }
  return lines.join("\n");
}

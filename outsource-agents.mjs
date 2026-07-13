import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const OUTSOURCE_DEFAULT_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
export const OUTSOURCE_TERMINAL_STATUSES = new Set(["done", "failed", "cancelled", "stale", "aborted"]);
const LINKED_JOB_TERMINAL_STATUSES = new Set(["done", "failed", "aborted", "stale"]);

function nowIso() {
  return new Date().toISOString();
}

function randomId(prefix = "orun") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function appendJsonl(file, entry) {
  mkdirSync(dirname(file), { recursive: true });
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

function nonEmptyString(value, fallback = "") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function normalizeList(value, fallback = []) {
  if (value == null) return [...fallback];
  if (Array.isArray(value)) {
    return value
      .flatMap((item) => String(item ?? "").split(","))
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeBackend(value) {
  const backend = nonEmptyString(value, "pi").toLowerCase();
  if (!["pi", "codex"].includes(backend)) {
    throw new Error(`不支持的外包后端: ${value}`);
  }
  return backend;
}

function normalizeSkills(value) {
  if (value == null) return false;
  if (typeof value === "boolean") return value;
  const list = normalizeList(value);
  if (list.length === 0) return false;
  const lowered = list.map((item) => item.toLowerCase());
  if (lowered.length === 1 && ["false", "none", "off", "no", "0"].includes(lowered[0])) return false;
  if (lowered.length === 1 && ["true", "all", "on", "yes", "1"].includes(lowered[0])) return true;
  return list;
}

function normalizeTools(value) {
  const tools = normalizeList(value, OUTSOURCE_DEFAULT_TOOLS);
  const seen = new Set();
  const normalized = [];
  for (const tool of tools) {
    if (!/^[\p{L}\p{N}_.:@/-]+$/u.test(tool)) {
      throw new Error(`非法工具名: ${tool}`);
    }
    if (seen.has(tool)) continue;
    seen.add(tool);
    normalized.push(tool);
  }
  return normalized.length > 0 ? normalized : [...OUTSOURCE_DEFAULT_TOOLS];
}

function normalizePositiveNumber(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(numberValue)));
}

function normalizeNonNegativeNumber(value, fallback = 0, max = Number.MAX_SAFE_INTEGER) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.max(0, Math.min(max, Math.floor(numberValue)));
}

function summarize(text, max = 1000) {
  const value = String(text ?? "");
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n...(${value.length - max} chars omitted)`;
}

function usageNumber(...values) {
  for (const value of values) {
    const numberValue = Number(value);
    if (Number.isFinite(numberValue)) return numberValue;
  }
  return 0;
}

function normalizeUsage(usage = {}) {
  const inputTokens = usageNumber(usage.inputTokens, usage.input_tokens, usage.input, usage.promptTokens, usage.prompt_tokens);
  const cachedInputTokens = usageNumber(usage.cachedInputTokens, usage.cached_input_tokens, usage.cachedInput, usage.cached_input, usage.cached);
  const outputTokens = usageNumber(usage.outputTokens, usage.output_tokens, usage.output, usage.completionTokens, usage.completion_tokens);
  const reasoningOutputTokens = usageNumber(usage.reasoningOutputTokens, usage.reasoning_output_tokens, usage.reasoningOutput, usage.reasoning_output);
  const totalTokens = usageNumber(usage.totalTokens, usage.total_tokens, usage.total) || inputTokens + outputTokens;
  return { inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, totalTokens };
}

export function outsourceProfilesFile(workersDir) {
  return join(workersDir, "outsource-profiles.jsonl");
}

export function outsourceRunsFile(workersDir) {
  return join(workersDir, "outsource-runs.jsonl");
}

export function normalizeOutsourceProfile(input = {}) {
  const name = nonEmptyString(input.name || input.id || input.profile);
  if (!name) throw new Error("外包 profile name 不能为空");
  if (/\s/.test(name)) throw new Error("外包 profile name 不能包含空白字符");
  const backend = normalizeBackend(input.backend || "pi");
  const model = nonEmptyString(input.model || (backend === "codex" ? "gpt-5.4" : ""));
  const profile = {
    name,
    description: nonEmptyString(input.description),
    backend,
    model,
    thinking: nonEmptyString(input.thinking),
    tools: normalizeTools(input.tools),
    skills: normalizeSkills(input.skills),
    systemPrompt: nonEmptyString(input.systemPrompt || input.system_prompt),
    maxTurns: normalizePositiveNumber(input.maxTurns ?? input.max_turns, 1, 1, 50),
    defaultWait: input.defaultWait == null ? true : Boolean(input.defaultWait),
    timeoutMs: normalizeNonNegativeNumber(input.timeoutMs ?? input.timeout_ms, 0),
  };
  if (!profile.thinking) delete profile.thinking;
  if (!profile.model) delete profile.model;
  if (!profile.systemPrompt) delete profile.systemPrompt;
  return profile;
}

export function upsertOutsourceProfile(workersDir, input = {}) {
  const normalized = normalizeOutsourceProfile(input);
  const existing = getOutsourceProfile(workersDir, normalized.name);
  const timestamp = nowIso();
  appendJsonl(outsourceProfilesFile(workersDir), {
    type: "profile_upserted",
    profile: {
      ...existing,
      ...normalized,
      createdAt: existing?.createdAt || timestamp,
      updatedAt: timestamp,
    },
    createdAt: timestamp,
    actor: nonEmptyString(input.actor || input.updatedBy || input.createdBy, "用户"),
  });
  return getOutsourceProfile(workersDir, normalized.name);
}

export function deleteOutsourceProfile(workersDir, { name, actor = "用户", reason = "" } = {}) {
  const id = nonEmptyString(name);
  if (!id) throw new Error("外包 profile name 不能为空");
  appendJsonl(outsourceProfilesFile(workersDir), {
    type: "profile_deleted",
    name: id,
    actor: nonEmptyString(actor, "用户"),
    reason: nonEmptyString(reason),
    deletedAt: nowIso(),
  });
  return { name: id, deleted: true };
}

export function listOutsourceProfiles(workersDir) {
  const byName = new Map();
  for (const event of readJsonl(outsourceProfilesFile(workersDir))) {
    if (event.type === "profile_upserted" && event.profile?.name) {
      byName.set(event.profile.name, { ...event.profile });
    } else if (event.type === "profile_deleted" && event.name) {
      byName.delete(event.name);
    }
  }
  return [...byName.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

export function getOutsourceProfile(workersDir, name) {
  const id = nonEmptyString(name);
  if (!id) return null;
  return listOutsourceProfiles(workersDir).find((profile) => profile.name === id) || null;
}

export function createOutsourceRun(workersDir, input = {}) {
  const suppliedProfile = input.profileSnapshot || (typeof input.profile === "object" ? input.profile : null);
  const profileNameInput = typeof input.profile === "string" ? input.profile : input.profileName;
  const profile = suppliedProfile || getOutsourceProfile(workersDir, input.profileName || profileNameInput);
  const profileName = nonEmptyString(input.profileName || profile?.name || profileNameInput);
  const task = nonEmptyString(input.task || input.message);
  if (!profileName) throw new Error("外包 run profileName 不能为空");
  if (!task) throw new Error("外包 run task 不能为空");
  const timestamp = nowIso();
  const run = {
    type: "run_created",
    id: input.id || randomId("orun"),
    groupId: input.groupId || randomId("ogroup"),
    profile: profileName,
    profileName,
    profileSnapshot: profile && typeof profile === "object" ? { ...profile } : null,
    requestedBy: nonEmptyString(input.requestedBy || input.from, "用户"),
    project: nonEmptyString(input.project, "outsource"),
    cwd: input.cwd == null ? "" : String(input.cwd),
    task,
    status: "queued",
    createdAt: timestamp,
    updatedAt: timestamp,
    wait: input.wait == null ? undefined : Boolean(input.wait),
    background: input.background == null ? undefined : Boolean(input.background),
    jobId: input.jobId || null,
  };
  appendJsonl(outsourceRunsFile(workersDir), run);
  return getOutsourceRun(workersDir, run.id);
}

export function appendOutsourceRunEvent(workersDir, event = {}) {
  const runId = nonEmptyString(event.runId || event.id);
  if (!runId) throw new Error("outsource run event 缺少 runId");
  const entry = {
    ...event,
    runId,
    type: nonEmptyString(event.type, "event"),
    createdAt: event.createdAt || nowIso(),
  };
  appendJsonl(outsourceRunsFile(workersDir), entry);
  return getOutsourceRun(workersDir, runId);
}

export function markOutsourceRunRunning(workersDir, { runId, jobId, pid, owner, startedAt } = {}) {
  return appendOutsourceRunEvent(workersDir, {
    type: "running",
    runId,
    jobId: jobId || null,
    pid: pid || null,
    owner: owner || null,
    startedAt: startedAt || nowIso(),
  });
}

export function completeOutsourceRun(workersDir, { runId, status = "done", summary = "", fullOutput = "", usage = {}, result = {}, error = "", model = "" } = {}) {
  const normalizedStatus = status === "failed" ? "failed" : status === "cancelled" ? "cancelled" : "done";
  return appendOutsourceRunEvent(workersDir, {
    type: "completed",
    runId,
    status: normalizedStatus,
    summary: summarize(summary || fullOutput || error, 1000),
    fullOutput: String(fullOutput || summary || error || ""),
    result: result || {},
    error: String(error || ""),
    usage: normalizeUsage(usage),
    model: String(model || ""),
    completedAt: nowIso(),
  });
}

export function failOutsourceRun(workersDir, { runId, error, summary = "", usage = {}, model = "" } = {}) {
  return completeOutsourceRun(workersDir, {
    runId,
    status: "failed",
    summary: summary || error,
    fullOutput: summary || "",
    usage,
    error,
    model,
  });
}

export function cancelOutsourceRun(workersDir, { runId, actor = "用户", reason = "cancelled" } = {}) {
  return appendOutsourceRunEvent(workersDir, {
    type: "cancelled",
    runId,
    status: "cancelled",
    actor: nonEmptyString(actor, "用户"),
    reason: nonEmptyString(reason, "cancelled"),
    cancelledAt: nowIso(),
  });
}

export function markOutsourceRunsStaleForJob(workersDir, job = {}, reason = "linked job became stale") {
  const jobId = typeof job === "string" ? job : job?.id;
  if (!jobId) return [];
  const events = readJsonl(outsourceRunsFile(workersDir));
  const runIds = new Set();
  for (const event of events) {
    if (event.jobId === jobId) {
      const id = runIdForEvent(event);
      if (id) runIds.add(id);
    }
  }
  if (runIds.size === 0) return [];

  const terminalIds = new Set();
  for (const event of events) {
    const id = runIdForEvent(event);
    if (!runIds.has(id)) continue;
    if (
      event.type === "completed" ||
      event.type === "cancelled" ||
      event.type === "stale" ||
      event.type === "aborted" ||
      OUTSOURCE_TERMINAL_STATUSES.has(event.status)
    ) {
      terminalIds.add(id);
    }
  }

  const staleAt = job?.finishedAt || job?.updatedAt || nowIso();
  const updated = [];
  for (const runId of runIds) {
    if (terminalIds.has(runId)) continue;
    updated.push(appendOutsourceRunEvent(workersDir, {
      type: "stale",
      runId,
      jobId,
      status: "stale",
      reason: nonEmptyString(reason, "linked job became stale"),
      error: nonEmptyString(job?.error || reason, "linked job became stale"),
      staleAt,
    }));
  }
  return updated;
}

function runIdForEvent(event) {
  return event.id || event.runId;
}

function deriveRun(events) {
  const created = events.find((event) => event.type === "run_created") || events[0] || {};
  const run = {
    ...created,
    id: runIdForEvent(created),
    status: created.status || "queued",
    events: events.map((event) => ({ ...event })),
  };
  for (const event of events) {
    if (event.type === "running") {
      Object.assign(run, {
        status: "running",
        profile: run.profileName || run.profile || "",
        jobId: event.jobId || run.jobId || null,
        pid: event.pid || null,
        owner: event.owner || null,
        startedAt: event.startedAt || event.createdAt,
        updatedAt: event.createdAt || event.startedAt || run.updatedAt,
      });
    } else if (event.type === "completed") {
      const usage = normalizeUsage(event.usage || {});
      Object.assign(run, {
        status: event.status || "done",
        profile: run.profileName || run.profile || "",
        summary: event.summary || run.summary || "",
        fullOutput: event.fullOutput || run.fullOutput || "",
        result: event.result || run.result || {},
        error: event.error || run.error || "",
        usage,
        inputTokens: usage.inputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        outputTokens: usage.outputTokens,
        reasoningOutputTokens: usage.reasoningOutputTokens,
        totalTokens: usage.totalTokens,
        model: event.model || run.model || "",
        completedAt: event.completedAt || event.createdAt,
        updatedAt: event.completedAt || event.createdAt || run.updatedAt,
      });
    } else if (event.type === "cancelled") {
      Object.assign(run, {
        status: "cancelled",
        cancelReason: event.reason || "cancelled",
        cancelledBy: event.actor || null,
        cancelledAt: event.cancelledAt || event.createdAt,
        updatedAt: event.cancelledAt || event.createdAt || run.updatedAt,
      });
    } else if (event.type === "stale" || event.type === "aborted") {
      const status = event.type === "aborted" ? "aborted" : "stale";
      Object.assign(run, {
        status,
        jobId: event.jobId || run.jobId || null,
        error: event.error || event.reason || run.error || "",
        staleReason: event.reason || run.staleReason || "",
        staleAt: event.staleAt || event.createdAt,
        updatedAt: event.staleAt || event.createdAt || run.updatedAt,
      });
    } else if (event.type !== "run_created") {
      run.updatedAt = event.createdAt || run.updatedAt;
    }
  }
  return run;
}

function readLinkedJob(workersDir, jobId) {
  const id = nonEmptyString(jobId);
  if (!id) return null;
  const file = join(workersDir, "jobs", `${id}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function mirrorLinkedJobTerminalStatus(workersDir, run) {
  if (!run?.jobId || OUTSOURCE_TERMINAL_STATUSES.has(run.status)) return run;
  const job = readLinkedJob(workersDir, run.jobId);
  if (!job || !LINKED_JOB_TERMINAL_STATUSES.has(job.status)) return run;
  const usage = normalizeUsage(job);
  return {
    ...run,
    status: job.status,
    jobStatus: job.status,
    error: run.error || job.error || "",
    summary: run.summary || job.summary || "",
    fullOutput: run.fullOutput || job.fullOutput || "",
    usage: run.usage || usage,
    inputTokens: run.inputTokens ?? usage.inputTokens,
    cachedInputTokens: run.cachedInputTokens ?? usage.cachedInputTokens,
    outputTokens: run.outputTokens ?? usage.outputTokens,
    reasoningOutputTokens: run.reasoningOutputTokens ?? usage.reasoningOutputTokens,
    totalTokens: run.totalTokens ?? usage.totalTokens,
    finishedAt: run.finishedAt || job.finishedAt || null,
    staleAt: job.status === "stale" ? (run.staleAt || job.finishedAt || job.updatedAt || null) : run.staleAt,
    updatedAt: job.updatedAt || job.finishedAt || run.updatedAt,
  };
}

export function listOutsourceRuns(workersDir, { runId, groupId, profile, profileName, status, requestedBy, limit = 100 } = {}) {
  const events = readJsonl(outsourceRunsFile(workersDir));
  const byId = new Map();
  for (const event of events) {
    const id = runIdForEvent(event);
    if (!id) continue;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(event);
  }
  const targetProfile = profileName || profile;
  return [...byId.values()]
    .map(deriveRun)
    .map((run) => mirrorLinkedJobTerminalStatus(workersDir, run))
    .filter((run) => !runId || run.id === runId)
    .filter((run) => !groupId || run.groupId === groupId)
    .filter((run) => !targetProfile || run.profileName === targetProfile)
    .filter((run) => !status || run.status === status)
    .filter((run) => !requestedBy || run.requestedBy === requestedBy)
    .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")))
    .slice(-Math.max(1, Number(limit) || 100));
}

export function getOutsourceRun(workersDir, runId) {
  const id = nonEmptyString(runId);
  if (!id) return null;
  return listOutsourceRuns(workersDir, { runId: id, limit: 10000 })[0] || null;
}

export function formatOutsourceProfiles(profiles = []) {
  if (!profiles.length) return "暂无外包 profile。用 factory_outsource_profiles action=upsert 添加。";
  return [
    "## 外包 Profiles",
    "",
    "| name | backend | model | tools | skills | wait | desc |",
    "|---|---|---|---|---|---|---|",
    ...profiles.map((profile) =>
      `| ${profile.name} | ${profile.backend || "pi"} | ${profile.model || "-"} | ${(profile.tools || []).join(", ") || "-"} | ${Array.isArray(profile.skills) ? profile.skills.join(", ") : String(profile.skills)} | ${profile.defaultWait !== false ? "yes" : "no"} | ${(profile.description || "-").replace(/\|/g, "\\|")} |`
    ),
  ].join("\n");
}

export function formatOutsourceRuns(runs = []) {
  if (!runs.length) return "暂无外包 run。";
  return [
    "## 外包 Runs",
    "",
    "| status | run | group | profile | job | requestedBy | updated | task |",
    "|---|---|---|---|---|---|---|---|",
    ...runs.map((run) =>
      `| ${run.status || "-"} | \`${run.id}\` | \`${run.groupId || "-"}\` | ${run.profileName || "-"} | ${run.jobId ? `\`${run.jobId}\`` : "-"} | ${run.requestedBy || "-"} | ${run.updatedAt || run.createdAt || "-"} | ${String(run.task || "").replace(/\s+/g, " ").slice(0, 80).replace(/\|/g, "\\|")} |`
    ),
  ].join("\n");
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      const abort = () => {
        clearTimeout(timer);
        reject(new Error("wait aborted"));
      };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }
  });
}

export async function waitForOutsourceRuns(workersDir, { runId, groupId, mode = "all", timeoutMs = 0, pollIntervalMs = 500, signal } = {}) {
  if (!runId && !groupId) throw new Error("waitForOutsourceRuns 需要 runId 或 groupId");
  const startedAt = Date.now();
  const timeoutLimitMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : 0;
  const selectedMode = mode === "next" ? "next" : "all";
  let observedIds = new Set();
  while (true) {
    const current = listOutsourceRuns(workersDir, { runId, groupId, limit: 10000 });
    for (const run of current) observedIds.add(run.id);
    const observed = current.filter((run) => observedIds.has(run.id));
    const terminal = observed.filter((run) => OUTSOURCE_TERMINAL_STATUSES.has(run.status));
    if (observed.length > 0) {
      if (selectedMode === "next" && terminal.length > 0) {
        return { status: "completed", mode: selectedMode, runs: observed, completed: terminal };
      }
      if (selectedMode === "all" && terminal.length === observed.length) {
        return { status: "completed", mode: selectedMode, runs: observed, completed: terminal };
      }
    }
    if (timeoutLimitMs > 0 && Date.now() - startedAt >= timeoutLimitMs) {
      return { status: "timeout", mode: selectedMode, runs: observed, completed: terminal };
    }
    await sleep(Math.max(50, Number(pollIntervalMs) || 500), signal);
  }
}

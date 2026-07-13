#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  findMainSessionFile,
  getWorkerRegistrySnapshot,
} from "./worker-registry-snapshot.mjs";

function safeJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function walkRolloutFiles(dir, out = []) {
  if (!dir || !existsSync(dir)) return out;
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const fp = join(dir, name.name);
    if (name.isDirectory()) {
      walkRolloutFiles(fp, out);
    } else if (name.isFile() && name.name.startsWith("rollout-") && name.name.endsWith(".jsonl")) {
      out.push(fp);
    }
  }
  return out;
}

function extractWorkerName(baseInstructions = "") {
  const match = String(baseInstructions || "").match(/你的名字叫\s+\*\*(.*?)\*\*/);
  return match?.[1]?.trim() || "";
}

function extractFirstTask(message = "") {
  const text = String(message || "");
  const match = text.match(/## 任务\n([\s\S]*?)(?:\n\n##|\n## 牛马工厂工作手册|\Z)/);
  return (match?.[1] || text).trim().replace(/\s+/g, " ").slice(0, 160);
}

export function scanCodexWorkerRollouts(codexSessionsDir = join(homedir(), ".codex", "sessions")) {
  const byWorker = new Map();
  for (const file of walkRolloutFiles(codexSessionsDir)) {
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    if (lines.length === 0) continue;
    const first = safeJson(lines[0]);
    if (first?.type !== "session_meta") continue;
    const payload = first.payload || {};
    if (payload.originator !== "pi-ox-factory") continue;
    const threadId = String(payload.id || "").trim();
    const worker = extractWorkerName(payload.base_instructions?.text || "");
    if (!threadId || !worker) continue;

    let turns = 0;
    let firstTask = "";
    let lastAt = first.timestamp || payload.timestamp || "";
    for (const line of lines) {
      const entry = safeJson(line);
      if (!entry) continue;
      lastAt = entry.timestamp || lastAt;
      const event = entry.payload || {};
      if (entry.type === "event_msg" && event.type === "task_started") turns += 1;
      if (!firstTask && entry.type === "event_msg" && event.type === "user_message") {
        firstTask = extractFirstTask(event.message || "");
      }
    }

    const rollouts = byWorker.get(worker) || [];
    rollouts.push({
      worker,
      threadId,
      file,
      turns,
      firstTask,
      firstAt: first.timestamp || payload.timestamp || "",
      lastAt,
    });
    byWorker.set(worker, rollouts);
  }

  for (const rollouts of byWorker.values()) {
    rollouts.sort((a, b) => String(a.firstAt || "").localeCompare(String(b.firstAt || "")));
  }
  return byWorker;
}

export function selectCanonicalCodexThread({ worker, rollouts = [] } = {}) {
  const registryThread = String(worker?.codexThreadId || "").trim();
  const usable = (rollouts || []).filter((rollout) => String(rollout.threadId || "").trim());
  const registryRollout = registryThread
    ? usable.find((rollout) => rollout.threadId === registryThread)
    : null;
  if (registryRollout) {
    return {
      threadId: registryThread,
      previousThreadId: registryThread,
      reason: "registry-has-rollout-evidence",
      changed: false,
      rollout: registryRollout,
    };
  }
  if (usable.length === 0) {
    return {
      threadId: registryThread,
      previousThreadId: registryThread,
      reason: registryThread ? "registry-only-no-rollout-evidence" : "missing-no-rollout-evidence",
      changed: false,
      rollout: null,
    };
  }

  const [mainline] = [...usable].sort((a, b) => {
    const turnDiff = Number(b.turns || 0) - Number(a.turns || 0);
    if (turnDiff !== 0) return turnDiff;
    return String(b.lastAt || b.firstAt || "").localeCompare(String(a.lastAt || a.firstAt || ""));
  });
  return {
    threadId: mainline.threadId,
    previousThreadId: registryThread,
    reason: registryThread ? "registry-missing-use-observed-mainline" : "missing-use-observed-mainline",
    changed: mainline.threadId !== registryThread,
    rollout: mainline,
  };
}

export function auditCodexThreads({
  workersDir,
  codexSessionsDir = join(homedir(), ".codex", "sessions"),
} = {}) {
  if (!workersDir) throw new Error("--workers-dir is required");
  const registry = getWorkerRegistrySnapshot(workersDir);
  const rolloutsByWorker = scanCodexWorkerRollouts(codexSessionsDir);
  const workers = [...registry.values()].filter((worker) => (worker.backend || "pi") === "codex");
  const entries = workers.map((worker) => {
    const rollouts = rolloutsByWorker.get(worker.id) || [];
    const selected = selectCanonicalCodexThread({ worker, rollouts });
    const status = selected.changed ? "mismatch" : selected.reason.includes("no-rollout") ? "unknown" : "ok";
    return {
      worker: worker.id,
      model: worker.model || "",
      registryThreadId: worker.codexThreadId || "",
      canonicalThreadId: selected.threadId || "",
      status,
      reason: selected.reason,
      rolloutCount: rollouts.length,
      selectedRollout: selected.rollout,
      rollouts,
    };
  });
  return {
    workersDir,
    codexSessionsDir,
    generatedAt: new Date().toISOString(),
    entries,
    totals: {
      workers: entries.length,
      ok: entries.filter((entry) => entry.status === "ok").length,
      mismatch: entries.filter((entry) => entry.status === "mismatch").length,
      unknown: entries.filter((entry) => entry.status === "unknown").length,
    },
  };
}

function appendWorkerConfigPatch(sessionFile, worker, threadId) {
  const entry = {
    type: "custom",
    customType: "ox-worker-config",
    data: {
      workerId: worker.id,
      codexThreadId: threadId,
      codexServerUrl: worker.codexServerUrl,
      model: worker.model,
      codexThreadHandoff: null,
    },
    id: randomUUID().slice(0, 8),
    timestamp: new Date().toISOString(),
  };
  appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`, "utf8");
  return entry;
}

export function repairCodexThreadBindings({
  workersDir,
  codexSessionsDir = join(homedir(), ".codex", "sessions"),
  apply = false,
} = {}) {
  const report = auditCodexThreads({ workersDir, codexSessionsDir });
  const sessionFile = findMainSessionFile(workersDir);
  if (apply && !sessionFile) throw new Error("Cannot find main Pi session file for registry repair");
  const registry = getWorkerRegistrySnapshot(workersDir);
  const repairs = [];
  for (const entry of report.entries) {
    if (entry.status !== "mismatch" || !entry.canonicalThreadId) continue;
    const worker = registry.get(entry.worker);
    if (!worker) continue;
    const repair = {
      worker: entry.worker,
      previousThreadId: entry.registryThreadId,
      canonicalThreadId: entry.canonicalThreadId,
      reason: entry.reason,
      selectedRollout: entry.selectedRollout,
      applied: false,
    };
    if (apply) {
      repair.entry = appendWorkerConfigPatch(sessionFile, worker, entry.canonicalThreadId);
      repair.applied = true;
    }
    repairs.push(repair);
  }
  return {
    ...report,
    sessionFile,
    apply,
    repairs,
  };
}

function parseArgs(argv) {
  const options = { workersDir: "", codexSessionsDir: join(homedir(), ".codex", "sessions"), apply: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--workers-dir") options.workersDir = argv[++i] || "";
    else if (arg === "--codex-sessions-dir") options.codexSessionsDir = argv[++i] || options.codexSessionsDir;
    else if (arg === "--apply") options.apply = true;
    else if (arg === "--json") options.json = true;
  }
  return options;
}

function formatRepairReport(report) {
  const lines = [
    "# Codex Thread Audit",
    "",
    `- workersDir: ${report.workersDir}`,
    `- codexSessionsDir: ${report.codexSessionsDir}`,
    `- mainSession: ${report.sessionFile || "(not found)"}`,
    `- totals: ${report.totals.ok} ok / ${report.totals.mismatch} mismatch / ${report.totals.unknown} unknown`,
    `- apply: ${report.apply ? "yes" : "no"}`,
    "",
    "| Worker | Status | Registry | Canonical | Rollouts | Reason |",
    "|---|---:|---|---|---:|---|",
  ];
  for (const entry of report.entries) {
    lines.push(`| ${entry.worker} | ${entry.status} | \`${entry.registryThreadId || "-"}\` | \`${entry.canonicalThreadId || "-"}\` | ${entry.rolloutCount} | ${entry.reason} |`);
  }
  if (report.repairs.length > 0) {
    lines.push("", "## Repairs");
    for (const repair of report.repairs) {
      lines.push(`- ${repair.applied ? "applied" : "preview"} ${repair.worker}: \`${repair.previousThreadId || "-"}\` -> \`${repair.canonicalThreadId}\``);
    }
  }
  return `${lines.join("\n")}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const report = repairCodexThreadBindings(options);
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else process.stdout.write(formatRepairReport(report));
  } catch (error) {
    console.error(error?.message || String(error));
    process.exit(1);
  }
}

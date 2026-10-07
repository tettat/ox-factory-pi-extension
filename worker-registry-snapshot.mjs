import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const registryCache = { map: null, file: null, mtime: 0 };

export function findMainSessionFile(workersDir) {
  const configured = process.env.OX_FACTORY_MAIN_SESSION_FILE;
  if (configured) return existsSync(resolve(configured)) ? resolve(configured) : null;
  const projectRoot = resolve(workersDir, "..", "..");
  const sanitized = projectRoot.replace(/^\//, "").replace(/\//g, "-");
  const sessionDirName = "--" + sanitized + "--";
  const mainSessionDir = join(homedir(), ".pi", "agent", "sessions", sessionDirName);
  if (!existsSync(mainSessionDir)) return null;
  const files = readdirSync(mainSessionDir)
    .filter((f) => f.endsWith(".jsonl") && !f.includes(".bak"))
    .map((f) => {
      const fp = join(mainSessionDir, f);
      return { fp, mtime: statSync(fp).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return files[0]?.fp || null;
}

function applyWorkerPatch(worker, data) {
  const fields = [
    "backend",
    "displayName",
    "avatar",
    "model",
    "thinking",
    "codexThreadId",
    "codexThreadInitialized",
    "codexServerUrl",
    "codexApprovalPolicy",
    "codexSandbox",
    "codexThreadHandoff",
    "claudeSessionId",
    "claudeSessionInitialized",
    "claudeCwd",
    "claudeCommand",
    "claudePermissionMode",
    "claudeTools",
    "claudeAllowedTools",
    "claudeDisallowedTools",
    "claudeBare",
    "kimiSessionId",
    "kimiSessionInitialized",
    "kimiCwd",
    "kimiCommand",
    "sessionFile",
  ];
  for (const field of fields) {
    if (field in data) worker[field] = data[field];
  }
}

export function scanWorkerEntries(entries) {
  const workers = new Map();
  for (const entry of entries || []) {
    if (!entry || entry.type !== "custom") continue;
    const ct = entry.customType;
    if (!ct || !ct.startsWith("ox-worker-")) continue;
    const data = entry.data || {};
    const workerId = data.workerId || data.worker;
    if (!workerId) continue;

    if (ct === "ox-worker-hire") {
      const worker = {
        id: workerId,
        role: data.role || null,
        backend: data.backend || "pi",
        displayName: data.displayName || null,
        avatar: data.avatar || null,
        model: data.model || null,
        thinking: data.thinking || null,
        hired: data.hired || null,
        status: data.status || "idle",
        fired: false,
        sessionFile: data.sessionFile || null,
      };
      applyWorkerPatch(worker, data);
      workers.set(workerId, worker);
      continue;
    }

    const worker = workers.get(workerId);
    if (!worker) continue;

    if (ct === "ox-worker-config") {
      applyWorkerPatch(worker, data);
    } else if (ct === "ox-worker-promote") {
      if (data.to) worker.role = data.to;
    } else if (ct === "ox-worker-fire") {
      worker.fired = true;
      worker.status = "fired";
    } else if (ct === "ox-worker-status") {
      if (data.status && data.status !== "working") worker.status = data.status;
    }
  }

  for (const [name, worker] of workers) {
    if (worker.fired) workers.delete(name);
  }
  return workers;
}

export function scanWorkerEntriesFromFile(sessionFile) {
  if (!sessionFile || !existsSync(sessionFile)) return new Map();
  const entries = [];
  const lines = readFileSync(sessionFile, "utf8").split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // ignore corrupt lines; registry recovery must be best-effort
    }
  }
  return scanWorkerEntries(entries);
}

export function getWorkerRegistrySnapshot(workersDir) {
  const sessionFile = findMainSessionFile(workersDir);
  if (!sessionFile) return new Map();
  const mtime = statSync(sessionFile).mtimeMs;
  if (registryCache.map && registryCache.file === sessionFile && registryCache.mtime === mtime) {
    return registryCache.map;
  }
  const map = scanWorkerEntriesFromFile(sessionFile);
  registryCache.map = map;
  registryCache.file = sessionFile;
  registryCache.mtime = mtime;
  return map;
}

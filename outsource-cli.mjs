#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  formatOutsourceProfiles,
  formatOutsourceRuns,
  getOutsourceProfile,
  getOutsourceRun,
  listOutsourceProfiles,
  listOutsourceRuns,
  waitForOutsourceRuns,
} from "./outsource-agents.mjs";
import {
  normalizeOutsourceWait,
  renderOutsourceResult,
  renderOutsourceWaitResult,
  startOutsourceRunJob,
} from "./outsource-dispatcher.mjs";

function arg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return "";
  return process.argv[index + 1] || "";
}

function flag(name) {
  return process.argv.includes(name);
}

function usage() {
  return [
    "Usage:",
    "  node .pi/extensions/ox-factory/outsource-cli.mjs profiles [--workers-dir DIR]",
    "  node .pi/extensions/ox-factory/outsource-cli.mjs run --from 员工 --profile 外包 --task 任务 [--project 项目] [--cwd DIR] [--group-id ID] [--wait|--background] [--workers-dir DIR]",
    "  node .pi/extensions/ox-factory/outsource-cli.mjs run --from 员工 --profile 外包 --task-file /tmp/task.md [--wait] [--workers-dir DIR]",
    "  node .pi/extensions/ox-factory/outsource-cli.mjs status [--run-id ID] [--group-id ID] [--profile 外包] [--status queued|running|done|failed|cancelled] [--workers-dir DIR]",
    "  node .pi/extensions/ox-factory/outsource-cli.mjs wait --run-id ID|--group-id ID [--timeout-ms MS] [--workers-dir DIR]",
    "",
    "备注：默认不设置墙钟超时；只有显式传 --timeout-ms 时才会超时返回。",
    "  node .pi/extensions/ox-factory/outsource-cli.mjs result --run-id ID [--wait] [--verbose] [--workers-dir DIR]",
    "",
    "说明：外包 agent 是白纸临时进程，不复用员工身份、记忆或 session。请把背景、文件路径、验收标准写进 task。",
  ].join("\n");
}

function readTask() {
  const file = arg("--task-file");
  if (file) return readFileSync(file, "utf8");
  return arg("--task") || arg("--content");
}

const command = process.argv[2] || "";
if (!command || flag("--help") || flag("-h")) {
  console.log(usage());
  process.exit(command ? 0 : 1);
}

const workersDir = arg("--workers-dir") || join(process.cwd(), ".pi", "workers");

try {
  if (command === "profiles" || command === "list-profiles") {
    console.log(formatOutsourceProfiles(listOutsourceProfiles(workersDir)));
    process.exit(0);
  }

  if (command === "run") {
    const profileName = arg("--profile");
    const profile = getOutsourceProfile(workersDir, profileName);
    if (!profile) throw new Error(`未找到外包 profile: ${profileName || "(empty)"}`);
    const task = readTask();
    if (!String(task || "").trim()) throw new Error("task 不能为空，请传 --task 或 --task-file");
    const shouldWait = normalizeOutsourceWait({
      wait: flag("--wait") ? true : undefined,
      background: flag("--background") ? true : undefined,
    }, profile);
    const { run, job, promise } = startOutsourceRunJob({
      workersDir,
      profile,
      task,
      project: arg("--project") || "outsource",
      cwd: arg("--cwd") || process.cwd(),
      requestedBy: arg("--from") || arg("--requested-by") || "员工",
      groupId: arg("--group-id"),
      wait: shouldWait,
      background: !shouldWait,
      detached: !shouldWait,
    });
    if (!shouldWait) {
      console.log(`started ${run.id} job=${job.id} profile=${profile.name}`);
      process.exit(0);
    }
    await promise;
    const waited = await waitForOutsourceRuns(workersDir, {
      runId: run.id,
      mode: "all",
      timeoutMs: Number(arg("--timeout-ms")) || profile.timeoutMs || 0,
    });
    console.log(renderOutsourceWaitResult(waited));
    process.exit(waited.status === "timeout" ? 3 : 0);
  }

  if (command === "status") {
    const runs = listOutsourceRuns(workersDir, {
      runId: arg("--run-id"),
      groupId: arg("--group-id"),
      profile: arg("--profile"),
      status: arg("--status"),
      limit: Number(arg("--limit")) || 20,
    }).reverse();
    console.log(formatOutsourceRuns(runs));
    process.exit(0);
  }

  if (command === "wait") {
    const waited = await waitForOutsourceRuns(workersDir, {
      runId: arg("--run-id"),
      groupId: arg("--group-id"),
      mode: arg("--mode") || "all",
      timeoutMs: Number(arg("--timeout-ms")) || 0,
      pollIntervalMs: Number(arg("--poll-ms")) || 500,
    });
    console.log(renderOutsourceWaitResult(waited));
    process.exit(waited.status === "timeout" ? 3 : 0);
  }

  if (command === "result") {
    const runId = arg("--run-id");
    if (!runId) throw new Error("run-id 不能为空");
    if (flag("--wait")) {
      await waitForOutsourceRuns(workersDir, {
        runId,
        mode: "all",
        timeoutMs: Number(arg("--timeout-ms")) || 0,
      });
    }
    console.log(renderOutsourceResult(getOutsourceRun(workersDir, runId), flag("--verbose")));
    process.exit(0);
  }

  console.error(`unknown command: ${command}`);
  console.error(usage());
  process.exit(1);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

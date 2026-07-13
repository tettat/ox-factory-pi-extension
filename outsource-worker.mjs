#!/usr/bin/env node
import { runExistingOutsourceRunJob } from "./outsource-dispatcher.mjs";

function arg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return "";
  return process.argv[index + 1] || "";
}

const workersDir = arg("--workers-dir");
const runId = arg("--run-id");
const jobId = arg("--job-id");

if (!workersDir || !runId) {
  console.error("Usage: node outsource-worker.mjs --workers-dir DIR --run-id RUN_ID [--job-id JOB_ID]");
  process.exit(2);
}

try {
  const result = await runExistingOutsourceRunJob({ workersDir, runId, jobId });
  process.exit(result?.exitCode ? 1 : 0);
} catch (error) {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
}

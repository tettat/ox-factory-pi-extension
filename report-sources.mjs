#!/usr/bin/env node
import { join } from "node:path";

import { buildFactoryReportContext, formatFactoryReportContext } from "./report-context.mjs";

function readArg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return "";
  return process.argv[index + 1] || "";
}

function hasArg(name) {
  return process.argv.includes(name);
}

if (hasArg("--help") || hasArg("-h")) {
  console.log([
    "Usage: node .pi/extensions/ox-factory/report-sources.mjs [--date YYYY-MM-DD] [--workers-dir DIR] [--json] [--no-sessions]",
    "",
    "聚合牛马工厂日报数据源：jobs、queue、员工 sessions。",
    "注意：queue.jsonl 只代表 runner/cron/factory_queue 队列流水，不代表全员工作总账。",
  ].join("\n"));
  process.exit(0);
}

const workersDir = readArg("--workers-dir") || join(process.cwd(), ".pi", "workers");
const date = readArg("--date") || undefined;
const includeSessions = !hasArg("--no-sessions");
const context = buildFactoryReportContext({ workersDir, date, includeSessions });

if (hasArg("--json")) {
  console.log(JSON.stringify(context, null, 2));
} else {
  console.log(formatFactoryReportContext(context));
}

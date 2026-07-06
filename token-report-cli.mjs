#!/usr/bin/env node
import { join } from "node:path";

import { buildFactoryTokenReport, formatFactoryTokenReport } from "./token-report.mjs";

function arg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return "";
  return process.argv[index + 1] || "";
}

function flag(name) {
  return process.argv.includes(name);
}

if (flag("--help") || flag("-h")) {
  console.log([
    "Usage: node .pi/extensions/ox-factory/token-report-cli.mjs [--date YYYY-MM-DD] [--worker 员工] [--workers-dir DIR] [--json]",
    "",
    "只统计 input/output/total token，不计算成本，不做绩效评分。",
  ].join("\n"));
  process.exit(0);
}

const workersDir = arg("--workers-dir") || join(process.cwd(), ".pi", "workers");
const report = buildFactoryTokenReport({
  workersDir,
  date: arg("--date") || undefined,
  worker: arg("--worker") || undefined,
});

if (flag("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(formatFactoryTokenReport(report));
}

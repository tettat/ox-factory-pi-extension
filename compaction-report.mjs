#!/usr/bin/env node
import { join } from "node:path";

import {
  buildFactoryCompactionReport,
  formatFactoryCompactionReport,
} from "./compaction.mjs";

function arg(name, fallback = undefined) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function usage() {
  console.log([
    "Usage:",
    "  node .pi/extensions/ox-factory/compaction-report.mjs [--workers-dir DIR] [--worker NAME] [--target main|worker] [--limit N] [--json]",
    "",
    "Options:",
    "  --workers-dir DIR  Factory workers dir; default .pi/workers",
    "  --worker NAME      Only show one worker",
    "  --target TYPE      Only show one target type: main or worker",
    "  --limit N          Recent record limit; default 20",
    "  --json             Print raw JSON report",
  ].join("\n"));
}

if (hasFlag("--help") || hasFlag("-h")) {
  usage();
  process.exit(0);
}

try {
  const workersDir = arg("--workers-dir", join(process.cwd(), ".pi", "workers"));
  const report = buildFactoryCompactionReport({
    workersDir,
    worker: arg("--worker", ""),
    targetType: arg("--target", ""),
    limit: Number(arg("--limit", 20)),
  });
  if (hasFlag("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatFactoryCompactionReport(report));
  }
} catch (error) {
  console.error(error?.message || String(error));
  process.exit(1);
}

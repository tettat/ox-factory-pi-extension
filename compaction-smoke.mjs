#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildFactoryCompactionRequest,
  prepareSessionCompactionFixture,
  runCodexCompaction,
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
    "  node .pi/extensions/ox-factory/compaction-smoke.mjs --session FILE [--worker NAME] [--role ROLE]",
    "",
    "Options:",
    "  --session FILE          Worker session jsonl to read (read-only)",
    "  --worker NAME           Worker name; defaults to session filename",
    "  --role ROLE             Worker role; defaults to worker",
    "  --model MODEL           Codex model; default gpt-5.5",
    "  --codex-server-url URL  Codex app-server URL; default ws://127.0.0.1:48177",
    "  --workers-dir DIR       Factory workers dir for Codex app-server logs; default .pi/workers",
    "  --keep-recent N         Recent messages to keep out of sample; default 6",
    "  --max-messages N        Messages to summarize in smoke sample; default 24",
    "  --max-chars N           Max serialized conversation chars sent to Codex; default 60000",
    "  --timeout-ms N          Codex turn timeout; default 120000",
    "  --output FILE           Write compaction JSON result to file",
    "  --dry-run               Only build prompt; do not call Codex",
    "  --json                  Print JSON",
  ].join("\n"));
}

const sessionFile = arg("--session");
if (!sessionFile || hasFlag("--help") || hasFlag("-h")) {
  usage();
  process.exit(sessionFile ? 0 : 1);
}

try {
  const sample = prepareSessionCompactionFixture(sessionFile, {
    keepRecentMessages: Number(arg("--keep-recent", 6)),
    maxMessagesToSummarize: Number(arg("--max-messages", 24)),
  });
  const worker = {
    id: arg("--worker", sample.workerId),
    role: arg("--role", "worker"),
  };
  const maxConversationChars = Number(arg("--max-chars", 60_000));

  if (hasFlag("--dry-run")) {
    const request = buildFactoryCompactionRequest({
      worker,
      preparation: sample.preparation,
      reason: "smoke",
      maxConversationChars,
    });
    const result = {
      dryRun: true,
      sessionFile,
      worker,
      messageCount: sample.messageCount,
      firstKeptEntryId: request.firstKeptEntryId,
      tokensBefore: request.tokensBefore,
      metadata: request.metadata,
      prompt: request.prompt,
    };
    if (arg("--output")) writeFileSync(arg("--output"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
    if (hasFlag("--json")) console.log(JSON.stringify(result, null, 2));
    else {
      console.log("# Codex Compaction Dry Run");
      console.log(`- worker: ${worker.id}`);
      console.log(`- session: ${sessionFile}`);
      console.log(`- messages: ${sample.messageCount}`);
      console.log(`- summarize: ${request.metadata.messagesToSummarize}`);
      console.log(`- firstKeptEntryId: ${request.firstKeptEntryId}`);
      console.log(`- promptChars: ${request.metadata.promptChars}`);
    }
    process.exit(0);
  }

  const result = await runCodexCompaction({
    worker,
    preparation: sample.preparation,
    reason: "smoke",
    cwd: process.cwd(),
    model: arg("--model", "gpt-5.5"),
    codexServerUrl: arg("--codex-server-url", process.env.OX_CODEX_APP_SERVER_URL || "ws://127.0.0.1:48177"),
    workersDir: arg("--workers-dir", join(process.cwd(), ".pi", "workers")),
    timeoutMs: Number(arg("--timeout-ms", 120_000)),
    maxConversationChars,
  });

  const payload = {
    sessionFile,
    worker,
    messageCount: sample.messageCount,
    compaction: result,
  };
  if (arg("--output")) writeFileSync(arg("--output"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  if (hasFlag("--json")) console.log(JSON.stringify(payload, null, 2));
  else {
    console.log("# Codex Compaction Smoke");
    console.log(`- worker: ${worker.id}`);
    console.log(`- session: ${sessionFile}`);
    console.log(`- messages: ${sample.messageCount}`);
    console.log(`- summarized: ${result.details.messagesToSummarize}`);
    console.log(`- firstKeptEntryId: ${result.firstKeptEntryId}`);
    console.log(`- tokensBefore(est): ${result.tokensBefore}`);
    console.log(`- estimatedTokensAfter: ${result.estimatedTokensAfter}`);
    console.log(`- model: ${result.details.model}`);
    console.log("");
    console.log(result.summary);
  }
} catch (error) {
  console.error(error?.message || String(error));
  process.exit(1);
}

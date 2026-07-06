#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const sourcePath = join(here, "index.ts");
const source = readFileSync(sourcePath, "utf8");
const validName = /^[A-Za-z0-9_-]+$/;

let hasError = false;
const toolNamePattern = /pi\.registerTool\(\s*\{[\s\S]*?name:\s*["']([^"']+)["']/g;

for (const match of source.matchAll(toolNamePattern)) {
  const name = match[1];
  if (!validName.test(name)) {
    const line = source.slice(0, match.index).split("\n").length;
    console.error(`${sourcePath}:${line}: invalid tool name ${JSON.stringify(name)}`);
    hasError = true;
  }
}

if (hasError) {
  process.exit(1);
}

console.log("All ox-factory tool names are provider-safe.");

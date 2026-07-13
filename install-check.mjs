#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

function argValue(name, fallback) {
  const index = args.indexOf(name);
  if (index >= 0 && args[index + 1]) return args[index + 1];
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : fallback;
}

const strict = args.includes("--strict");
const codex = args.includes("--codex");
const hostDir = resolve(argValue("--host-dir", resolve(here, "../../..")));
const workersDir = resolve(argValue("--workers-dir", join(hostDir, ".pi", "workers")));

let failures = 0;
let warnings = 0;

function ok(message) {
  console.log(`ok   ${message}`);
}

function warn(message) {
  warnings += 1;
  console.warn(`warn ${message}`);
}

function fail(message) {
  failures += 1;
  console.error(`fail ${message}`);
}

function requireFile(path, label = path) {
  if (existsSync(path)) ok(`${label} exists`);
  else fail(`${label} is missing`);
}

function isInside(child, parent) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep));
}

function walkFiles(root, visit) {
  for (const name of readdirSync(root)) {
    if ([".git", "node_modules", ".pnpm-store"].includes(name)) continue;
    if (name === ".pi" && root === here) continue;
    const path = join(root, name);
    const stat = statSync(path);
    if (stat.isDirectory()) walkFiles(path, visit);
    else visit(path);
  }
}

console.log("# Ox Factory install check");
console.log(`extension: ${here}`);
console.log(`host:      ${hostDir}`);
console.log(`workers:   ${workersDir}`);
console.log("");

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor >= 18) ok(`Node ${process.version} is supported for local tools and web dashboard`);
else fail(`Node ${process.version} is too old; use Node 18+`);

if (typeof WebSocket === "function") {
  ok("global WebSocket is available for Codex app-server backend");
} else if (codex) {
  fail("global WebSocket is unavailable; Codex backend needs Node 22+ or a runtime that provides WebSocket");
} else {
  warn("global WebSocket is unavailable; Pi/web features can run, but Codex backend needs Node 22+ or a WebSocket runtime");
}

requireFile(join(here, "package.json"), "package.json");
requireFile(join(here, "README.md"), "README.md");
requireFile(join(here, "INSTALL.md"), "INSTALL.md");
requireFile(join(here, "index.ts"), "index.ts");
requireFile(join(here, "scripts", "install.sh"), "scripts/install.sh");
requireFile(join(here, "web-server.mjs"), "web-server.mjs");
requireFile(join(here, "validate-tools.mjs"), "validate-tools.mjs");

const expectedPiExtensions = join(hostDir, ".pi", "extensions");
if (dirname(here) === expectedPiExtensions) {
  ok("extension is installed at <host>/.pi/extensions/ox-factory");
} else {
  const message = `extension is not under ${expectedPiExtensions}; Pi may not auto-load it unless symlinked/copied`;
  strict ? fail(message) : warn(message);
}

if (existsSync(workersDir)) {
  ok("workers runtime directory exists");
  if (isInside(workersDir, here)) fail("workers runtime directory is inside the extension source tree");
  else ok("workers runtime directory is outside the extension source tree");
} else {
  warn("workers runtime directory does not exist yet; Pi will create it after first load/use");
}

const piVersion = spawnSync("pi", ["--version"], { encoding: "utf8", timeout: 5000 });
if (piVersion.error?.code === "ENOENT") {
  warn("pi command not found on PATH; install/run from a Pi environment before using the extension");
} else if (piVersion.status === 0) {
  ok(`pi command is available (${(piVersion.stdout || piVersion.stderr).trim() || "version ok"})`);
} else {
  warn("pi command exists but `pi --version` did not exit 0; verify your Pi CLI manually");
}

const secretPattern = /(^|[^A-Za-z0-9_])(Bearer\s+[A-Za-z0-9._~+/=-]{10,}|plat_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,})/m;
const secretHits = [];
walkFiles(here, (path) => {
  if (secretHits.length >= 20) return;
  const rel = relative(here, path);
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".zip"].some((suffix) => rel.endsWith(suffix))) return;
  let text = "";
  try { text = readFileSync(path, "utf8"); } catch { return; }
  if (secretPattern.test(text)) secretHits.push(rel);
});
if (secretHits.length) {
  fail(`possible token/secret literals found: ${secretHits.join(", ")}`);
} else {
  ok("no obvious Bearer/plat_/sk_/cloud key literals found in extension source");
}

console.log("");
if (failures > 0) {
  console.error(`Install check failed: ${failures} failure(s), ${warnings} warning(s).`);
  process.exit(1);
}
console.log(`Install check passed with ${warnings} warning(s).`);
console.log("Next: run `npm run verify`, then reload/restart Pi from the host project.");

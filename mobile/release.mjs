#!/usr/bin/env node
// Code-only Hub/Connector bundle; the full factory is installed separately.
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, realpathSync, readdirSync, lstatSync } from 'node:fs';
import { resolve, dirname, relative, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const outputBase = join(root, 'output'), output = resolve(root, process.argv[2] || 'output/mobile-release');
const inside = (child, parent) => { const r = relative(parent, child); return r && r !== '..' && !r.startsWith('../') && !r.startsWith('..\\') && !isAbsolute(r); };
if (!inside(output, outputBase)) throw new Error('Release destination must be a new directory under repository/output');
if (existsSync(output)) throw new Error('Release directory already exists; choose a fresh versioned path');
for (let p = dirname(output); p !== root; p = dirname(p)) if (existsSync(p) && lstatSync(p).isSymbolicLink()) throw new Error('Release parent cannot be a symlink');
const files = new Set();
function add(name) {
  const absolute = resolve(root, name), canonical = realpathSync(absolute);
  if (!inside(canonical, root)) throw new Error('Source escapes repository');
  if (files.has(name)) return;
  files.add(name);
  if (!name.endsWith('.mjs')) return;
  const source = readFileSync(absolute, 'utf8');
  for (const [, specifier] of source.matchAll(/\b(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g)) {
    const dep = relative(root, resolve(dirname(absolute), specifier)).replaceAll('\\', '/');
    if (!dep.endsWith('.mjs') || !(dep.startsWith('mobile/') || !dep.includes('/'))) throw new Error('Unexpected runtime dependency');
    add(dep);
  }
}
for (const name of ['cli.mjs', 'factory-adapter.mjs', 'release.mjs', 'netlify.mjs', 'netlify-hub.mjs', 'netlify-runtime.mjs', 'package.json', 'package-lock.json', 'README.md', 'SECURITY.md', 'NETLIFY.md']) add('mobile/' + name);
for (const entry of readdirSync(join(root, 'mobile/web'), { withFileTypes: true })) {
  if (!entry.isFile()) throw new Error('Unexpected asset directory or symlink');
  add('mobile/web/' + entry.name);
}
for (const name of ['Caddyfile.example', 'ox-mobile-hub.service', 'WINDOWS-SERVICE.md']) add('mobile/deploy/' + name);
const manifest = [];
for (const name of [...files].sort()) {
  const destination = join(output, name); mkdirSync(dirname(destination), { recursive: true }); copyFileSync(join(root, name), destination);
  const bytes = readFileSync(destination); manifest.push({ path: name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
const { version } = JSON.parse(readFileSync(join(root, 'mobile/package.json'), 'utf8'));
writeFileSync(join(output, 'MANIFEST.json'), JSON.stringify({ version, kind: 'hub-connector', factoryInstalledSeparately: true, createdAt: new Date().toISOString(), files: manifest }, null, 2));
console.log(JSON.stringify({ output, files: manifest.length, version, runtimeDirectoriesIncluded: false }));

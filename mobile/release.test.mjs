import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

test('release preserves repository module layout and excludes private operations files', async t => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  mkdirSync(join(root, 'output'), { recursive: true });
  const parent = mkdtempSync(join(root, 'output', 'release-test-')), output = join(parent, 'bundle');
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  execFileSync(process.execPath, [join(root, 'mobile/release.mjs'), output], { cwd: root, windowsHide: true });
  const manifest = JSON.parse(readFileSync(join(output, 'MANIFEST.json'), 'utf8'));
  assert.equal(manifest.version, JSON.parse(readFileSync(join(root, 'mobile/package.json'), 'utf8')).version);
  assert.equal(manifest.factoryInstalledSeparately, true);
  assert.ok(manifest.files.some(f => f.path === 'jobs.mjs'));
  assert.ok(manifest.files.some(f => f.path === 'mobile/factory-adapter.mjs'));
  for (const f of manifest.files) {
    assert.ok(existsSync(resolve(output, f.path)));
    assert.doesNotMatch(f.path, /(^|\/)(?:\.pi|node_modules|qa)\/|STATUS\.md|connector-config|owner-login|factory-extension\//);
  }
  const adapter = await import(pathToFileURL(join(output, 'mobile/factory-adapter.mjs')).href);
  assert.equal(typeof adapter.createFactoryAdapter, 'function');
});

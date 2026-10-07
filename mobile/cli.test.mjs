import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readJson, writeJson } from './store.mjs';
import { createMobileHub } from './hub.mjs';
const run = promisify(execFile), cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
test('standalone Hub initialization, loopback-only management and connector import do not need a remote factory', async t => {
  const root = mkdtempSync(join(tmpdir(), 'ox-mobile-cli-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, 'server'), connectorDir = join(root, 'pc'), workersDir = join(root, 'workers'); mkdirSync(workersDir);
  await run(process.execPath, [cli, 'hub-init', '--state', stateDir, '--origin', 'https://factory.example.com']);
  assert.equal(existsSync(join(stateDir, 'connector-config.json')), false);
  const bootstrap = readJson(join(stateDir, 'connector-bootstrap.json'));
  const imported = await run(process.execPath, [cli, 'connector-import', '--state', connectorDir, '--bootstrap-file', join(stateDir, 'connector-bootstrap.json'), '--actor', 'fixture-human', '--workers', workersDir]);
  assert.ok(!imported.stdout.includes(bootstrap.credential));
  assert.equal(readJson(join(connectorDir, 'connector-config.json')).credential, bootstrap.credential);
  await assert.rejects(run(process.execPath, [cli, 'connector-import', '--state', connectorDir, '--bootstrap-file', join(stateDir, 'connector-bootstrap.json'), '--actor', 'someone-else']));
  const h = createMobileHub({ stateFile: join(stateDir, 'hub-state.json'), origin: 'https://factory.example.com' });
  await new Promise(r => h.server.listen(0, '127.0.0.1', r));
  try {
    writeJson(join(stateDir, 'hub-config.json'), { origin: 'https://factory.example.com', host: '127.0.0.1', port: h.server.address().port });
    const output = join(root, 'private-pairing.json');
    const result = await run(process.execPath, [cli, 'pairing', '--state', stateDir, '--output', output]);
    const invitation = readJson(output); assert.match(invitation.url, /^https:\/\/factory\.example\.com\/#pair=/); assert.ok(!result.stdout.includes(invitation.code));
  } finally { h.server.closeAllConnections(); await new Promise(r => h.server.close(r)); }
});
test('CLI rejects unknown options and invalid ports before initializing files', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ox-mobile-cli-invalid-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const options of [['--port', 'NaN'], ['--port', '0'], ['--host', '0.0.0.0']]) await assert.rejects(run(process.execPath, [cli, 'hub-init', '--state', dir, '--origin', 'https://factory.example.com', ...options]));
  assert.equal(existsSync(join(dir, 'hub-state.json')), false);
});

test('new-computer CLI enrollment starts its own Connector and passes doctor with isolated endpoints', { timeout: 15000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'ox-enroll-cli-')), state = join(root, 'device'), workers = join(root, 'workers');
  mkdirSync(workers);
  const { writeFileSync } = await import('node:fs');
  const { token } = await import('./protocol.mjs');
  const secret = token(), code = token(), principal = 'owner_fixture_cli';
  const codeFile = join(root, 'enrollment.txt'); writeFileSync(codeFile, code);
  let child, exited, syncs = 0, enrolled = false;
  const factory = createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(req.url === '/api/workers' ? { workers: [] } : { ok: true })); });
  const hub = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/health') { res.end(JSON.stringify({ service: 'ox-factory-mobile-hub' })); return; }
    let data = ''; for await (const chunk of req) data += chunk;
    if (req.url === '/connector/enroll' && !enrolled && JSON.parse(data).code === code) {
      enrolled = true; res.writeHead(201); res.end(JSON.stringify({ credential: secret, deviceId: 'factory_fixture_cli', principalId: principal })); return;
    }
    if (req.url === '/connector/sync' && req.headers.authorization === `Bearer ${secret}`) {
      syncs++; res.end(JSON.stringify({ version: 1, commands: [], acknowledgements: [] })); return;
    }
    res.writeHead(401); res.end('{}');
  });
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    if (exited) await exited;
    for (const server of [hub, factory]) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
    rmSync(root, { recursive: true, force: true });
  });
  for (const server of [hub, factory]) await new Promise(r => server.listen(0, '127.0.0.1', r));
  const args = [cli, 'enroll', '--state', state, '--hub', `http://127.0.0.1:${hub.address().port}`, '--factory', `http://127.0.0.1:${factory.address().port}`, '--workers', workers, '--actor', 'fixture-human', '--name', 'Second factory', '--code-file', codeFile, '--allow-loopback-http', 'true'];
  const result = await run(process.execPath, args);
  assert.equal(JSON.parse(result.stdout).enrolled, true);
  assert.ok(!result.stdout.includes(secret) && !result.stdout.includes(code));
  const config = readJson(join(state, 'connector-config.json'));
  assert.equal(config.grants[principal].actor, 'fixture-human');
  await assert.rejects(run(process.execPath, args)); // Existing identities are never overwritten.
  child = spawn(process.execPath, [cli, 'connector', '--state', state], { windowsHide: true, stdio: 'ignore' });
  let spawnError;
  exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', e => { spawnError = e; resolve(); }); });
  const deadline = Date.now() + 7000;
  while (!spawnError && child.exitCode === null && Date.now() < deadline && readJson(join(state, 'connector', 'health.json'), null)?.status !== 'connected') await new Promise(r => setTimeout(r, 25));
  assert.ifError(spawnError); assert.ok(syncs > 0);
  const diagnosis = await run(process.execPath, [cli, 'doctor', '--state', state]);
  assert.equal(JSON.parse(diagnosis.stdout).ready, true);
  assert.ok(!diagnosis.stdout.includes(secret));
});

test('CLI connector records a real process heartbeat against isolated simulated endpoints', { timeout: 15000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'ox-mobile-cli-health-')), stateDir = join(root, 'connector'), workersDir = join(root, 'workers');
  mkdirSync(stateDir); mkdirSync(workersDir);
  let child, exited, syncs = 0;
  const factory = createServer((req, res) => {
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(req.url === '/api/workers' ? { workers: [] } : { ok: true }));
  });
  const hub = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/health') { res.end(JSON.stringify({ service: 'ox-factory-mobile-hub' })); return; }
    if (req.url !== '/connector/sync' || req.headers.authorization !== 'Bearer fixture-private-device-credential') { res.writeHead(401); res.end('{}'); return; }
    req.resume(); req.on('end', () => { syncs++; res.end(JSON.stringify({ version: 1, commands: [], acknowledgements: [] })); });
  });
  t.after(async () => {
    // Only terminate the disposable child created by this test, never an existing service.
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    if (exited) await exited;
    for (const server of [hub, factory]) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
    rmSync(root, { recursive: true, force: true });
  });
  for (const server of [hub, factory]) await new Promise(r => server.listen(0, '127.0.0.1', r));
  const config = { hub: `http://127.0.0.1:${hub.address().port}`, credential: 'fixture-private-device-credential',
    factoryUrl: `http://127.0.0.1:${factory.address().port}`, stateDir, workersDir, allowInsecureLoopback: true, grants: {} };
  writeJson(join(root, 'connector-config.json'), config);
  child = spawn(process.execPath, [cli, 'connector', '--state', root], { windowsHide: true, stdio: 'ignore' });
  let spawnError;
  exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', error => { spawnError = error; resolve(); }); });
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline && !spawnError && child.exitCode === null && readJson(join(stateDir, 'health.json'), null)?.status !== 'connected') {
    await new Promise(r => setTimeout(r, 25));
  }
  assert.ifError(spawnError); assert.ok(syncs > 0);
  const heartbeat = readJson(join(stateDir, 'health.json'));
  assert.equal(heartbeat.status, 'connected'); assert.equal(heartbeat.pid, child.pid);
  assert.ok(!JSON.stringify(heartbeat).includes(config.credential));
  const { stdout } = await run(process.execPath, [cli, 'doctor', '--state', root]);
  const report = JSON.parse(stdout); assert.equal(report.ready, true); assert.equal(report.connectorRuntime.health.healthy, true);
  assert.ok(!stdout.includes(config.credential));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { inspectMobileState } from './doctor.mjs';
import { CONNECTOR_HEALTH_MAX_AGE_MS, createConnectorHealthReporter, inspectConnectorHealth, inspectProcessLock } from './runtime-health.mjs';
import { readJson, writeJson } from './store.mjs';

const run = promisify(execFile), cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
const START = Date.parse('2026-09-22T12:00:00Z');
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ox-mobile-doctor-')), stateDir = join(root, 'connector'), workersDir = join(root, 'workers');
  mkdirSync(stateDir); mkdirSync(workersDir);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = { hub: 'https://hub.example.com', credential: 'fixture-device-secret-not-for-output',
    factoryUrl: 'http://127.0.0.1:8787', workersDir, stateDir, grants: { fixture: { actor: 'fixture-human', role: 'owner' } } };
  writeJson(join(root, 'connector-config.json'), config);
  let time = START;
  const now = () => time, pid = 43210, lock = { state: 'pid-present', pid };
  const health = createConnectorHealthReporter(config, { now, pid });
  writeFileSync(join(stateDir, 'connector.lock'), String(pid));
  const fetchImpl = async (url, options) => {
    assert.equal(options.redirect, 'error'); assert.ok(options.signal); assert.equal(options.headers, undefined);
    assert.ok([config.hub + '/health', config.factoryUrl + '/api/health'].includes(String(url)));
    return { ok: true, json: async () => ({ service: 'ox-factory-mobile-hub' }) };
  };
  return { root, config, now, pid, lock, health, fetchImpl, probe: () => {},
    advance(ms) { time += ms; }, inspect: () => inspectConnectorHealth(config, lock, { now }) };
}

test('diagnostic locks are read-only and probe only valid positive PIDs with signal zero', t => {
  const f = fixture(t), file = join(f.root, 'check.lock'); let calls = 0;
  const probe = pid => { assert.equal(pid, f.pid); calls++; };
  assert.equal(inspectProcessLock(file, { probe }).state, 'missing');
  for (const raw of ['', '0', '-1', '1.5', 'NaN', 'Infinity', '999999999999999999999', '2147483648', '123\n456']) {
    writeFileSync(file, raw); assert.equal(inspectProcessLock(file, { probe }).state, 'invalid');
    assert.equal(readFileSync(file, 'utf8'), raw);
  }
  assert.equal(calls, 0);
  writeFileSync(file, String(f.pid)); assert.deepEqual(inspectProcessLock(file, { probe }), f.lock);
  assert.equal(calls, 1);
  for (const [code, state] of [['ESRCH', 'stale'], ['EPERM', 'unverified'], ['EACCES', 'unverified']]) {
    assert.equal(inspectProcessLock(file, { probe() { throw Object.assign(new Error(), { code }); } }).state, state);
    assert.equal(readFileSync(file, 'utf8'), String(f.pid));
  }
});

test('heartbeat stores no credentials, throttles steady-state writes, and records transitions immediately', t => {
  const f = fixture(t), file = join(f.config.stateDir, 'health.json');
  assert.equal(f.inspect().state, 'starting'); assert.equal(f.inspect().healthy, false);
  f.health('connected'); assert.equal(f.inspect().healthy, true);
  const first = readFileSync(file, 'utf8');
  assert.ok(!first.includes(f.config.credential)); assert.ok(!first.includes(f.config.hub));
  f.advance(1000); f.health('connected'); assert.equal(readFileSync(file, 'utf8'), first);
  f.advance(4000); f.health('connected'); assert.equal(readJson(file).observedAt, START + 5000);
  f.health('DEVICE_AUTH_FAILED'); assert.equal(f.inspect().healthy, false); assert.equal(f.inspect().state, 'DEVICE_AUTH_FAILED');
  f.health('connected'); assert.equal(f.inspect().healthy, true);
  f.health('stopped'); assert.equal(f.inspect().healthy, false); assert.equal(f.inspect().state, 'stopped');
});

test('heartbeat cannot certify an exited, mismatched, stale, future or differently configured process', t => {
  const f = fixture(t); f.health('connected');
  for (const state of ['stale', 'unverified', 'missing', 'invalid']) {
    const result = inspectConnectorHealth(f.config, { state, pid: f.pid }, { now: f.now });
    assert.equal(result.healthy, false); assert.equal(result.state, 'process-not-confirmed');
  }
  assert.equal(inspectConnectorHealth(f.config, { ...f.lock, pid: f.pid + 1 }, { now: f.now }).state, 'pid-mismatch');
  assert.equal(inspectConnectorHealth({ ...f.config, credential: 'changed-secret' }, f.lock, { now: f.now }).state, 'config-mismatch');
  f.advance(CONNECTOR_HEALTH_MAX_AGE_MS + 1); assert.equal(f.inspect().state, 'stale'); assert.equal(f.inspect().healthy, false);
  f.advance(-CONNECTOR_HEALTH_MAX_AGE_MS - 2); assert.equal(f.inspect().state, 'clock-skew');
});

test('malformed or absent heartbeat remains unconfirmed and is never repaired by inspection', t => {
  const f = fixture(t), file = join(f.config.stateDir, 'health.json'), valid = readJson(file);
  for (const change of [{ version: 2 }, { pid: 0 }, { status: 'secret\nraw-log' }, { observedAt: 0 },
    { observedAt: 9e15 }, { lastConnectedAt: START + 1 }, { status: 'connected', lastConnectedAt: null }]) {
    writeJson(file, { ...valid, ...change }); const before = readFileSync(file, 'utf8');
    assert.equal(f.inspect().state, 'invalid'); assert.equal(readFileSync(file, 'utf8'), before);
  }
  writeFileSync(file, '{broken'); assert.equal(f.inspect().state, 'invalid'); assert.equal(readFileSync(file, 'utf8'), '{broken');
  const another = join(f.root, 'unstarted'); mkdirSync(another);
  assert.equal(inspectConnectorHealth({ ...f.config, stateDir: another }, f.lock).state, 'not-recorded');
  assert.deepEqual(readdirSync(another), []);
});

test('doctor does not equate two reachable HTTP endpoints with a working connector', async t => {
  const f = fixture(t); f.health('connected');
  const lockFile = join(f.config.stateDir, 'connector.lock'), healthFile = join(f.config.stateDir, 'health.json');
  const before = [readFileSync(lockFile, 'utf8'), readFileSync(healthFile, 'utf8')];
  const report = await inspectMobileState(f.root, { ...f, probe() { throw Object.assign(new Error(), { code: 'ESRCH' }); } });
  assert.equal(report.hubReachable, true); assert.equal(report.factoryReachable, true); assert.equal(report.ready, false);
  assert.deepEqual(report.issues, ['CONNECTOR_NOT_CONFIRMED']);
  assert.equal(report.connectorRuntime.lock.state, 'stale');
  assert.deepEqual([readFileSync(lockFile, 'utf8'), readFileSync(healthFile, 'utf8')], before);
  const publicReport = JSON.stringify(report);
  for (const secret of [f.config.credential, readJson(healthFile).fingerprint, 'fixture-human', f.config.workersDir]) assert.ok(!publicReport.includes(secret));
});

test('doctor supports remote-only connector and local Hub plus connector without claiming end-to-end acceptance', async t => {
  const f = fixture(t); f.health('connected');
  let report = await inspectMobileState(f.root, f);
  assert.equal(report.ready, true); assert.equal(report.hubConfigured, false); assert.equal(report.hubRuntime, null);
  assert.equal(report.scope, 'configured-services-only');
  writeJson(join(f.root, 'hub-config.json'), { origin: f.config.hub });
  report = await inspectMobileState(f.root, f); assert.equal(report.ready, false); assert.deepEqual(report.issues, ['HUB_PROCESS_NOT_CONFIRMED']);
  writeFileSync(join(f.root, 'hub.lock'), String(f.pid + 1));
  report = await inspectMobileState(f.root, f); assert.equal(report.ready, true);
  writeJson(join(f.root, 'hub-config.json'), { origin: 'https://another.example.com' });
  report = await inspectMobileState(f.root, f); assert.equal(report.ready, false); assert.ok(report.issues.includes('HUB_TARGET_MISMATCH'));
});

test('doctor missing state is read-only and a standalone Hub needs both its lock and health endpoint', async t => {
  const f = fixture(t), dir = join(f.root, 'absent'); let calls = 0;
  const fetchImpl = async () => { calls++; return { ok: true, json: async () => ({ service: 'ox-factory-mobile-hub' }) }; };
  let report = await inspectMobileState(dir, { fetchImpl });
  assert.equal(report.ready, false); assert.deepEqual(report.issues, ['NOT_CONFIGURED']); assert.equal(calls, 0);
  mkdirSync(dir); writeJson(join(dir, 'hub-config.json'), { origin: f.config.hub });
  writeFileSync(join(dir, 'hub.lock'), String(f.pid));
  report = await inspectMobileState(dir, { fetchImpl, probe: f.probe });
  assert.equal(report.ready, true); assert.equal(report.connectorConfigured, false); assert.equal(report.connectorRuntime, null);
  assert.deepEqual(readdirSync(dir).sort(), ['hub-config.json', 'hub.lock']);
});

test('doctor validates every transport before networking and sends neither cookies nor device secrets', async t => {
  const f = fixture(t); let calls = 0;
  for (const change of [{ hub: 'http://untrusted.example.com' }, { hub: 'https://user:password@example.com' },
    { factoryUrl: 'http://example.com' }, { factoryUrl: 'http://user:password@127.0.0.1:8787' },
    { factoryUrl: 'http://127.0.0.1:8787/path' }, { factoryUrl: 'http://127.0.0.1:8787/#secret' }]) {
    writeJson(join(f.root, 'connector-config.json'), { ...f.config, ...change });
    await assert.rejects(inspectMobileState(f.root, { fetchImpl: async () => { calls++; } }));
  }
  assert.equal(calls, 0);
});

test('doctor fails closed on wrong Hub responses, factory outages and missing worker directories', async t => {
  const f = fixture(t); f.health('connected');
  for (const mode of ['network', 'http', 'wrong-service', 'html']) {
    const report = await inspectMobileState(f.root, { ...f, fetchImpl: async () => {
      if (mode === 'network') throw new Error('network');
      return { ok: mode !== 'http', json: async () => { if (mode === 'html') throw new Error('not JSON'); return { service: 'wrong-service' }; } };
    } });
    assert.equal(report.ready, false); assert.ok(report.issues.includes('HUB_UNREACHABLE'));
  }
  writeJson(join(f.root, 'connector-config.json'), { ...f.config, workersDir: join(f.root, 'missing-workers') });
  const report = await inspectMobileState(f.root, f);
  assert.equal(report.ready, false); assert.ok(report.issues.includes('FACTORY_DIRECTORY_MISSING'));
});

test('doctor CLI returns exit 2 rather than success for an unconfigured runtime', async t => {
  const f = fixture(t), dir = join(f.root, 'empty'); mkdirSync(dir);
  await assert.rejects(run(process.execPath, [cli, 'doctor', '--state', dir]), error => {
    assert.equal(error.code, 2); const report = JSON.parse(error.stdout);
    assert.equal(report.ready, false); assert.deepEqual(report.issues, ['NOT_CONFIGURED']); return true;
  });
  assert.deepEqual(readdirSync(dir), []);
});

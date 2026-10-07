// Local diagnostics only: never delete locks, signal a service, or expose credentials.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hash } from './protocol.mjs';
import { readJson, writeJson } from './store.mjs';

export const CONNECTOR_HEALTH_MAX_AGE_MS = 60_000;
const WRITE_INTERVAL_MS = 5_000;
const validPid = pid => Number.isInteger(pid) && pid > 0 && pid <= 0x7fffffff;
const validTime = time => Number.isSafeInteger(time) && time > 0 && time <= 8_640_000_000_000_000;
const validStatus = status => typeof status === 'string' && /^(connected|starting|stopped|[A-Z][A-Z0-9_]{1,99})$/.test(status);

export function inspectProcessLock(file, { probe = pid => process.kill(pid, 0) } = {}) {
  let raw;
  try { raw = readFileSync(file, 'utf8').trim(); }
  catch (error) { return { state: error.code === 'ENOENT' ? 'missing' : 'unreadable', pid: null }; }
  const pid = Number(raw);
  // In particular, never let a malformed lock become process.kill(0/-1, 0).
  if (!/^[1-9][0-9]*$/.test(raw) || !validPid(pid)) return { state: 'invalid', pid: null };
  try { probe(pid); return { state: 'pid-present', pid }; }
  catch (error) { return { state: error.code === 'ESRCH' ? 'stale' : 'unverified', pid }; }
}

function configFingerprint(config) {
  // The fingerprint stays in the private state directory, not in doctor output.
  // Grants are intentionally excluded: they are reloaded on each operation.
  return hash(JSON.stringify([config.hub, config.credential, config.factoryUrl, config.workersDir, config.stateDir]));
}

export function createConnectorHealthReporter(config, { now = Date.now, pid = process.pid } = {}) {
  const file = join(config.stateDir, 'health.json'), fingerprint = configFingerprint(config);
  let lastStatus, lastWrite = 0, lastConnectedAt = null;
  function record(status) {
    if (!validStatus(status)) status = 'NETWORK_UNAVAILABLE';
    const observedAt = now();
    if (status === 'connected') lastConnectedAt = observedAt;
    if (status === lastStatus && observedAt >= lastWrite && observedAt - lastWrite < WRITE_INTERVAL_MS) return;
    writeJson(file, { version: 1, pid, fingerprint, status, observedAt, lastConnectedAt });
    lastStatus = status; lastWrite = observedAt;
  }
  record('starting');
  return record;
}

export function inspectConnectorHealth(config, lock, { now = Date.now } = {}) {
  let record;
  try { record = readJson(join(config.stateDir, 'health.json'), null); }
  catch { return { healthy: false, state: 'invalid' }; }
  if (!record) return { healthy: false, state: 'not-recorded' };
  if (record.version !== 1 || !validPid(record.pid) || !validStatus(record.status) || !validTime(record.observedAt)
      || (record.lastConnectedAt !== null && (!validTime(record.lastConnectedAt) || record.lastConnectedAt > record.observedAt))
      || (record.status === 'connected' && record.lastConnectedAt !== record.observedAt)) return { healthy: false, state: 'invalid' };
  if (record.fingerprint !== configFingerprint(config)) return { healthy: false, state: 'config-mismatch' };
  const ageMs = now() - record.observedAt;
  const summary = { healthy: false, state: record.status, observedAt: new Date(record.observedAt).toISOString(),
    lastConnectedAt: record.lastConnectedAt === null ? null : new Date(record.lastConnectedAt).toISOString(), ageMs };
  if (ageMs < 0) return { ...summary, state: 'clock-skew' };
  if (lock.state !== 'pid-present') return { ...summary, state: 'process-not-confirmed' };
  if (lock.pid !== record.pid) return { ...summary, state: 'pid-mismatch' };
  if (ageMs > CONNECTOR_HEALTH_MAX_AGE_MS) return { ...summary, state: 'stale' };
  return { ...summary, healthy: record.status === 'connected' };
}

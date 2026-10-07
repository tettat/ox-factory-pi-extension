import { join } from 'node:path';
import { Fault, VERSION, safeError } from './protocol.mjs';
import { readJson, writeJson } from './store.mjs';

export function validateHubUrl(value, allowInsecureLoopback = false) {
  const u = new URL(value);
  if (u.origin !== value || u.username || u.password || (u.protocol !== 'https:' && !(allowInsecureLoopback && u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)))) throw new Error('Connector requires an HTTPS origin (loopback development is opt-in)');
  return u;
}
export function createConnector({ hub, credential, stateDir, adapter, allowInsecureLoopback = false, fetchImpl = fetch, maxSyncBodyBytes = 14.5 * 1024 * 1024 }) {
  validateHubUrl(hub, allowInsecureLoopback);
  if (!Number.isInteger(maxSyncBodyBytes) || maxSyncBodyBytes < 4096 || maxSyncBodyBytes > 14.5 * 1024 * 1024) throw new Error('Invalid connector payload limit');
  const file = join(stateDir, 'outbox.json'), outbox = readJson(file, { results: [] });
  const save = () => writeJson(file, outbox);
  let snapshotDue = 0;
  async function request(path, payload) {
    const response = await fetchImpl(hub + path, { method: 'POST', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, body: JSON.stringify(payload), redirect: 'error', signal: AbortSignal.timeout(25000) });
    if (!response.ok) throw new Fault(response.status === 401 ? 'DEVICE_AUTH_FAILED' : response.status === 403 ? 'COMMAND_NOT_AUTHORIZED' : 'HUB_UNAVAILABLE', response.status);
    return response.json();
  }
  async function cycle({ forceSnapshot = false } = {}) {
    let snapshot, reachable;
    if (Date.now() >= snapshotDue || forceSnapshot) {
      try { snapshot = await adapter.snapshot(); }
      catch { reachable = false; }
      snapshotDue = Date.now() + (reachable === false ? 2000 : 2500);
    }
    const payload = { version: VERSION, ...(snapshot ? { snapshot } : {}), ...(reachable === false ? { reachable: false } : {}), results: [] };
    for (const result of outbox.results.slice(0, 20)) {
      if (Buffer.byteLength(JSON.stringify({ ...payload, results: [...payload.results, result] })) > maxSyncBodyBytes) {
        if (!payload.results.length && payload.snapshot) { delete payload.snapshot; snapshotDue = 0; }
        else break;
      }
      if (Buffer.byteLength(JSON.stringify({ ...payload, results: [...payload.results, result] })) > maxSyncBodyBytes) throw new Fault('RESULT_TOO_LARGE');
      payload.results.push(result);
    }
    if (Buffer.byteLength(JSON.stringify(payload)) > maxSyncBodyBytes) throw new Fault('SNAPSHOT_TOO_LARGE');
    const response = await request('/connector/sync', payload);
    if (response.version !== VERSION || !Array.isArray(response.commands) || !Array.isArray(response.acknowledgements)) throw new Fault('PROTOCOL_MISMATCH');
    outbox.results = outbox.results.filter(r => !response.acknowledgements.includes(r.id)); save();
    for (const command of response.commands) {
      if (outbox.results.some(r => r.id === command.id)) continue;
      try { await request('/connector/authorize', { id: command.id, deliveryToken: command.deliveryToken }); }
      catch (error) {
        if (error.code !== 'COMMAND_NOT_AUTHORIZED') throw error;
        outbox.results.push({ id: command.id, digest: command.digest, deliveryToken: command.deliveryToken, ok: false, error: 'COMMAND_NOT_AUTHORIZED' }); save(); continue;
      }
      let result;
      try { result = { ok: true, data: await adapter.execute(command) }; }
      catch (error) { result = { ok: false, error: safeError(error) }; }
      // A large read result must not poison the durable outbox and disconnect
      // every subsequent command. Report the failed transfer, never re-execute.
      if (Buffer.byteLength(JSON.stringify(result)) > maxSyncBodyBytes - 2048) result = { ok: false, error: 'RESULT_TOO_LARGE' };
      outbox.results.push({ id: command.id, digest: command.digest, deliveryToken: command.deliveryToken, ...result }); save();
    }
    return response;
  }
  async function run(signal, onStatus = () => {}) {
    let delay = 1000;
    while (!signal?.aborted) {
      try {
        const response = await cycle();
        delay = Number.isInteger(response.nextPollMs) ? Math.max(1000, Math.min(10000, response.nextPollMs)) : 1000;
        onStatus('connected');
      }
      catch (error) { onStatus(error instanceof Fault ? error.code : 'NETWORK_UNAVAILABLE'); delay = Math.min(delay * 2, 30000); }
      await new Promise(resolve => {
        const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, delay + Math.floor(Math.random() * 250)); signal?.addEventListener('abort', done, { once: true });
      });
    }
  }
  return { cycle, run };
}

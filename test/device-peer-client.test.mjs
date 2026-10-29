import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createServer } from 'node:http';
import { peerRequest, isLocalPeerRequest } from '../device-peer-client.mjs';
import { selectPcConnector } from '../mobile/pc-connector.mjs';
import { cachedHubState, fetchHubState, syncLocalFactory, mergeHubWorkers } from '../device-hub-client.mjs';
import { buildRouter } from '../web-server.mjs';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ox-pc-peer-')), workersDir = join(root, '.pi/workers'), stateDir = join(root, '.pi/cf-state');
  mkdirSync(workersDir, { recursive: true }); mkdirSync(stateDir, { recursive: true });
  t.after(() => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + 'ox-pc-peer-')); rmSync(root, { recursive: true, force: true }); });
  const configFile = join(root, '.pi/cf-config.json'), hub = 'https://cf.example.com', credential = 'x'.repeat(43);
  writeFileSync(configFile, JSON.stringify({ hub, credential, workersDir, stateDir }));
  selectPcConnector({ workersDir, configFile });
  const directory = { version: 1, hub, localDeviceId: 'device_local', receivedAt: Date.now(), devices: [{ id: 'device_local', online: true, workers: [{ id: 'same' }] }, { id: 'device_other', online: true, workers: [{ id: 'same' }] }] };
  writeFileSync(join(stateDir, 'hub-directory.json'), JSON.stringify(directory));
  return { root, workersDir, stateDir, hub, credential, configFile };
}
test('PC directory uses selected CF runtime and never sends snapshots to old Hub', async t => {
  const f = fixture(t); writeFileSync(join(f.root, '.pi/hub-connection.json'), JSON.stringify({ url: 'https://old.example.com', token: 'old_secret' }));
  assert.equal(cachedHubState(f.workersDir).connection.url, f.hub); assert.equal((await fetchHubState(f.workersDir)).connection.url, f.hub);
  const ws = mergeHubWorkers([{ name: 'same' }], cachedHubState(f.workersDir)); assert.equal(ws.length, 2); assert.equal(ws[1].deviceId, 'device_other'); assert.equal(ws[1].nameCollision, true);
  assert.equal(await syncLocalFactory(f.workersDir, []), false);
  writeFileSync(join(f.stateDir, 'hub-directory.json'), '{}'); assert.equal(await fetchHubState(f.workersDir), null);
});
test('peer call uses only selected Hub credentials and rejects injected actor/URL/actions', async t => {
  const f = fixture(t); let calls = 0;
  const fetchImpl = async (url, options) => { calls++; assert.equal(url, f.hub + '/connector/peer-command'); assert.equal(options.headers.authorization, 'Bearer ' + f.credential); assert.equal(options.redirect, 'error'); return Response.json({ command: { state: 'queued' } }, { status: 202 }); };
  const body = { id: 'command_fixture', deviceId: 'device_other', action: 'talk.send', body: { worker: 'employee', message: 'synthetic test only' }, createdAt: Date.now() };
  assert.equal((await peerRequest(f.workersDir, 'peer-command', body, fetchImpl)).command.state, 'queued');
  for (const patch of [{ actor: 'owner' }, { hub: 'https://evil.example' }, { action: 'task.create' }, { createdAt: 'wrong' }]) await assert.rejects(peerRequest(f.workersDir, 'peer-command', { ...body, ...patch }, fetchImpl));
  assert.equal(calls, 1);
  const bad = async () => ({ ok: false, status: 503, json: async () => { throw Error('private proxy HTML'); } });
  await assert.rejects(peerRequest(f.workersDir, 'directory', {}, bad), e => e.code === 'PEER_HUB_UNAVAILABLE');
});
test('peer endpoints reject cross-origin / LAN / DNS-rebinding and require Origin for mutation', () => {
  const req = { socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:8787', origin: 'http://127.0.0.1:8787' } };
  assert.equal(isLocalPeerRequest(req, { mutation: true }), true);
  for (const patch of [{ origin: 'https://evil.example' }, { host: 'evil.example', origin: 'http://evil.example' }, { origin: undefined }, { 'sec-fetch-site': 'cross-site' }]) assert.equal(isLocalPeerRequest({ ...req, headers: { ...req.headers, ...patch } }, { mutation: true }), false);
  assert.equal(isLocalPeerRequest({ ...req, socket: { remoteAddress: '192.0.2.1' } }), false);
});
test('actual PC router exposes only sanitized selection status; blocks cross-site reads and writes', async t => {
  const f = fixture(t), server = createServer(buildRouter({ workersDir: f.workersDir }));
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => { server.closeAllConnections(); server.close(r); }));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const r = await fetch(origin + '/api/device-peer/status'), data = await r.json(); assert.equal(r.status, 200); assert.equal(data.hub, f.hub); assert.equal(data.directoryFresh, true); assert.ok(!JSON.stringify(data).includes(f.credential));
  assert.equal((await fetch(origin + '/api/device-peer/status', { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(origin + '/api/device-peer/command', { method: 'POST', body: '{}' })).status, 403);
});

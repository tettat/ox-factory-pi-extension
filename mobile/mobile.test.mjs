import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { get as httpGet } from 'node:http';
import { randomUUID } from 'node:crypto';
import { initialState, createMobileHub } from './hub.mjs';
import { createConnector, validateHubUrl } from './connector.mjs';
import { createFactoryAdapter } from './factory-adapter.mjs';
import { validateAction, token, commandDigest, hash } from './protocol.mjs';
import { writeJson, readJson } from './store.mjs';
import { listWebTalkRequests, createWebTalkRequest } from '../web-talk.mjs';
import { listWorkerTaskRequests } from '../task-requests.mjs';
import { listFactoryTasks, getFactoryTask } from '../task-board.mjs';
import { createJob, updateJob, appendJobEvent } from '../jobs.mjs';

async function freePort() { const s = createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
async function fixture(t, hubOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ox-mobile-test-')), workersDir = join(root, 'workers'); mkdirSync(workersDir);
  const origin = `http://127.0.0.1:${await freePort()}`, stateFile = join(root, 'hub.json'), principalId = 'owner_test_01', deviceId = 'device_test_01', secret = token(), code = token(), admin = token();
  const state = initialState({ principalId, deviceId, deviceName: '测试工厂', deviceSecret: secret, pairingCode: code, adminSecret: admin }); writeJson(stateFile, state);
  const grants = { [principalId]: { actor: '用户', role: 'owner' }, second_principal: { actor: '用户', role: 'owner' } };
  const registry = async () => [{ id: '测试员工', displayName: '测试员工', backend: 'codex', role: 'programmer', status: 'idle' }];
  const adapter = createFactoryAdapter({ workersDir, stateDir: join(root, 'factory'), registry, grants });
  const h = createMobileHub({ stateFile, origin, allowInsecureLoopback: true, ...hubOptions }); await new Promise(r => h.server.listen(new URL(origin).port, '127.0.0.1', r));
  t.after(async () => { h.server.closeAllConnections(); await new Promise(r => h.server.close(r)); rmSync(root, { recursive: true, force: true }); });
  const connectorOptions = { hub: origin, credential: secret, stateDir: join(root, 'connector'), adapter, allowInsecureLoopback: true };
  const connector = createConnector(connectorOptions);
  async function request(path, body, auth = null, extraHeaders = {}) {
    const response = await fetch(origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(body === undefined ? {} : { 'content-type': 'application/json', origin }), ...(auth ? { cookie: auth.cookie, 'x-ox-csrf': auth.csrf } : {}), ...extraHeaders }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    let data; try { data = await response.json(); } catch { data = null; }
    return { status: response.status, data, headers: response.headers };
  }
  async function login(pairingCode = code) {
    const r = await request('/api/login', { code: pairingCode, name: '测试手机' }); assert.equal(r.status, 200);
    const cookie = r.headers.get('set-cookie').split(';')[0]; const profile = await request('/api/me', undefined, { cookie });
    return { cookie, ...profile.data };
  }
  await connector.cycle();
  const owner = await login();
  const envelope = (action, body) => ({ id: randomUUID(), deviceId, action, body, createdAt: Date.now() });
  async function complete(envelope, auth = owner) { const q = await request('/api/commands', envelope, auth); assert.equal(q.status, 202); await connector.cycle(); await connector.cycle(); return (await request(`/api/commands/${envelope.id}`, undefined, auth)).data.command; }
  return { root, workersDir, principalId, deviceId, secret, code, admin, grants, registry, adapter, h, origin, connector, connectorOptions, request, login, owner, envelope, complete };
}

test('protocol rejects privilege injection, paths, unknown actions, invalid images, public plaintext transport', () => {
  assert.throws(() => validateAction('talk.send', { worker: 'employee', message: 'x', from: '用户' }));
  assert.throws(() => validateAction('shell.exec', { command: 'whoami' }));
  assert.throws(() => validateAction('worker.detail', { worker: '../../secret' }));
  assert.throws(() => validateAction('worker.detail', { worker: 'remote:another:worker' }));
  assert.throws(() => validateAction('image.upload', { worker: 'worker', mimeType: 'image/svg+xml', data: 'YWJj' }));
  assert.throws(() => validateHubUrl('http://example.com', true));
  assert.throws(() => validateHubUrl('https://user:password@example.com'));
  assert.doesNotThrow(() => validateHubUrl('http://127.0.0.1:1234', true));
  assert.doesNotThrow(() => validateHubUrl('https://factory.example.com'));
});

test('project summaries sync through Hub and a viewer can request only read-only project details', async t => {
  const f=await fixture(t),invitation=await f.request('/api/pairings',{role:'viewer',devices:[f.deviceId]},f.owner),viewer=await f.login(invitation.data.code);
  const snapshot=(await f.request('/api/state',undefined,viewer)).data.devices[0].snapshot;
  assert.deepEqual(snapshot.projects,[]);assert.equal(snapshot.projectsAvailable,true);
  const result=await f.complete(f.envelope('project.detail',{projectId:'not-registered'}),viewer);
  assert.equal(result.result.error,'PROJECT_NOT_FOUND');
  assert.equal((await f.request('/api/commands',f.envelope('project.detail',{projectId:'../secret'}),viewer)).status,400);
  assert.equal((await f.request('/api/commands',f.envelope('task.create',{title:'must-not-write'}),viewer)).status,403);
});

test('revoking a pairing issuer invalidates unused phone invitations', async t => {
  const f = await fixture(t);
  const invitation = await f.request('/api/pairings', { role: 'owner', devices: ['*'] }, f.owner);
  assert.equal(invitation.status, 201);
  assert.equal((await f.request('/api/logout', {}, f.owner)).status, 200);
  assert.equal((await f.request('/api/login', { code: invitation.data.code, name: 'old code' })).status, 401);
});
test('invalid-code rate limiting does not lock out valid pairing behind a shared proxy', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 21; i++) await f.request('/api/login', { code: 'invalid-code', name: 'bad attempt' });
  assert.equal((await f.request('/api/login', { code: 'invalid-code', name: 'limited' })).status, 429);
  const invitation = await f.request('/api/pairings', { role: 'viewer', devices: [f.deviceId] }, f.owner);
  assert.equal((await f.login(invitation.data.code)).role, 'viewer');
});

test('device-scoped owner cannot revoke or inspect a wider owner credential', async t => {
  const f = await fixture(t);
  const invitation = await f.request('/api/pairings', { role: 'owner', devices: [f.deviceId] }, f.owner);
  const scoped = await f.login(invitation.data.code);
  const access = (await f.request('/api/access', undefined, scoped)).data;
  assert.equal(access.sessions.some(s => s.id === f.owner.id), false); assert.deepEqual(access.audit, []);
  assert.equal((await f.request('/api/revoke', { kind: 'session', id: f.owner.id }, scoped)).status, 404);
  assert.equal((await f.request('/api/pairings', { role: 'owner', devices: ['*'] }, scoped)).status, 400);
});

test('operator can create a board task only with an authorized assigned worker', async t => {
  const f = await fixture(t), invitation = await f.request('/api/pairings', { role: 'operator', devices: [f.deviceId] }, f.owner);
  const operator = await f.login(invitation.data.code);
  const c = await f.complete(f.envelope('task.create', { title: 'operator task', worker: '测试员工' }), operator);
  assert.equal(c.result.ok, true); assert.equal(c.result.data.task.assignee, '测试员工');
  assert.equal((await f.complete(f.envelope('task.create', { title: 'unassigned' }), operator)).result.error, 'OWNER_REQUIRED');
});

test('reserved object keys cannot become command IDs and revoking a local grant hides old receipts', async t => {
  const f = await fixture(t), e = f.envelope('talk.send', { worker: '测试员工', message: 'private receipt' });
  await f.complete(e);
  assert.equal((await f.request('/api/commands', { ...e, id: '__proto__' }, f.owner)).status, 400);
  f.grants[f.principalId].revoked = true; await f.connector.cycle({ forceSnapshot: true });
  const state = (await f.request('/api/state', undefined, f.owner)).data;
  assert.deepEqual(state.devices, []); assert.deepEqual(state.commands, []);
});

test('image preview requires a worker-linked attachment and returns the original bytes', async t => {
  const f = await fixture(t), data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=';
  const upload = await f.complete(f.envelope('image.upload', { worker: '测试员工', mimeType: 'image/png', name: 'pixel.png', data }));
  const attachmentId = upload.result.data.attachment.id;
  const result = await f.complete(f.envelope('image.read', { worker: '测试员工', attachmentId }));
  assert.equal(result.result.data.data, data);
  assert.ok(!(await f.request('/api/state', undefined, f.owner)).data.commands.some(c => c.action === 'image.read'));
  const unknown = await f.complete(f.envelope('image.read', { worker: '测试员工', attachmentId: 'unowned-attachment' }));
  assert.equal(unknown.result.error, 'ATTACHMENT_NOT_FOUND');
});

test('push subscription API is authenticated, CSRF protected, and tied to the phone credential', async t => {
  const driver = { publicKey: 'fixture-key', send: async () => {} };
  const f = await fixture(t, { pushDriver: driver });
  assert.equal((await f.request('/api/push')).status, 401);
  assert.equal((await f.request('/api/push', undefined, f.owner)).data.available, true);
  const point = Buffer.alloc(65, 1); point[0] = 4;
  const subscription = { endpoint: 'https://web.push.apple.com/fixture', keys: { p256dh: point.toString('base64url'), auth: Buffer.alloc(16).toString('base64url') } };
  assert.equal((await f.request('/api/push/subscribe', { subscription }, f.owner, { 'x-ox-csrf': 'bad' })).status, 403);
  assert.equal((await f.request('/api/push/subscribe', { subscription }, f.owner)).status, 200);
  assert.equal((await f.request('/api/push', undefined, f.owner)).data.subscribed, true);
  assert.ok(!JSON.stringify((await f.request('/api/state', undefined, f.owner)).data).includes(subscription.endpoint));
  await f.request('/api/logout', {}, f.owner); assert.equal(f.h.state.pushSubscriptions[f.owner.id], undefined);
});

test('large connector results are batched below request limits and preserved until acknowledged', async t => {
  const root = mkdtempSync(join(tmpdir(), 'ox-mobile-batch-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const oversizedSnapshot = { observedAt: 'fixture', padding: 'x'.repeat(2 * 1024 * 1024) };
  const responses = [], ids = ['command_batch_01', 'command_batch_02']; let issued = false;
  const connector = createConnector({ hub: 'https://hub.example', credential: token(), stateDir: root,
    adapter: { snapshot: async () => oversizedSnapshot, execute: async () => ({ data: 'a'.repeat(13 * 1024 * 1024) }) },
    fetchImpl: async (url, options) => {
      const payload = JSON.parse(options.body);
      if (url.endsWith('/authorize')) return { ok: true, json: async () => ({ ok: true }) };
      assert.ok(Buffer.byteLength(options.body) < 15 * 1024 * 1024); responses.push(payload);
      const commands = issued ? [] : ids.map(id => ({ id, deliveryToken: 'test-delivery', digest: 'test-digest' })); issued = true;
      return { ok: true, json: async () => ({ version: 1, acknowledgements: payload.results.map(r => r.id), commands }) };
    },
  });
  await connector.cycle(); await connector.cycle({ forceSnapshot: true }); await connector.cycle({ forceSnapshot: true });
  assert.deepEqual(responses.flatMap(p => p.results.map(r => r.id)), ids);
  assert.equal(responses[1].snapshot, undefined); assert.deepEqual(readJson(join(root, 'outbox.json')).results, []);
});

test('factory outage does not block accepted result receipts and is reported as offline', async t => {
  const f = await fixture(t), e = f.envelope('talk.send', { worker: '测试员工', message: 'receipt before factory outage' });
  assert.equal((await f.request('/api/commands', e, f.owner)).status, 202);
  await f.connector.cycle(); // Original factory intent exists; result remains in outbox.
  const connector = createConnector({ ...f.connectorOptions, adapter: { snapshot: async () => { throw Error('factory temporarily down'); }, execute: async () => { throw Error('must not execute'); } } });
  await connector.cycle();
  const state = (await f.request('/api/state', undefined, f.owner)).data;
  assert.equal(state.devices[0].online, false); assert.equal(state.commands.find(c => c.id === e.id).state, 'done');
  assert.equal((await f.request('/api/commands', f.envelope('talk.send', { worker: '测试员工', message: 'offline write' }), f.owner)).status, 503);
  await f.connector.cycle({ forceSnapshot: true }); assert.equal((await f.request('/api/state', undefined, f.owner)).data.devices[0].online, true);
});
test('corrupt state fails closed instead of recreating credentials', () => {
  const root = mkdtempSync(join(tmpdir(), 'ox-state-test-'));
  try { const file = join(root, 'bad.json'); writeFileSync(file, '{broken'); assert.throws(() => readJson(file, {})); }
  finally { rmSync(root, { recursive: true, force: true }); }
});
test('PWA shell is public but business API is authenticated and cookie-bound', async t => {
  const f = await fixture(t);
  const shell = await fetch(f.origin); assert.equal(shell.status, 200); assert.match(await shell.text(), /随身工作台/);
  assert.match(shell.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal((await f.request('/api/state')).status, 401);
  assert.equal((await f.request('/api/state', undefined, null, { authorization: `Bearer ${f.secret}` })).status, 401);
  const state = await f.request('/api/state', undefined, f.owner);
  assert.equal(state.data.devices.length, 1); assert.equal(state.data.devices[0].online, true);
  assert.equal(state.data.devices[0].snapshot.workers[0].id, '测试员工');
  assert.ok(!JSON.stringify(state.data).includes(f.secret)); assert.ok(!JSON.stringify(state.data).includes('credentialHash'));
  assert.match(f.owner.cookie, /^oxmobile-dev=/);
});
test('one-time pairing, origin, CSRF and Host protections', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/login', { code: f.code, name: 'again' })).status, 401);
  assert.equal((await f.request('/api/logout', {}, f.owner, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await f.request('/api/logout', {}, f.owner, { 'x-ox-csrf': 'wrong' })).status, 403);
  const hostileHostStatus = await new Promise((resolve, reject) => { const req = httpGet(f.origin + '/api/me', { headers: { host: 'evil.example', cookie: f.owner.cookie } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); });
  assert.equal(hostileHostStatus, 421);
  const r = await f.request('/management/pairing', { role: 'viewer' }, null, { authorization: `Bearer ${f.admin}` }); assert.equal(r.status, 201);
  const viewer = await f.login(r.data.code); assert.equal(viewer.role, 'viewer');
  assert.equal((await f.request('/management/pairing', { role: 'owner' }, f.owner)).status, 401);
});
test('real factory talk intent delivered once through Hub and connector; result receipt returns', async t => {
  const f = await fixture(t), e = f.envelope('talk.send', { worker: '测试员工', message: '你好，测试闭环', mode: 'queue' });
  const c = await f.complete(e); assert.equal(c.state, 'done'); assert.equal(c.result.data.request.status, 'pending');
  const requests = listWebTalkRequests(f.workersDir); assert.equal(requests.length, 1); assert.equal(requests[0].from, '用户'); assert.equal(requests[0].mode, 'queue');
  assert.equal((await f.request('/api/commands', e, f.owner)).status, 200);
  assert.equal((await f.request('/api/commands', { ...e, body: { ...e.body, message: 'different' } }, f.owner)).status, 409);
  await f.connector.cycle(); assert.equal(listWebTalkRequests(f.workersDir).length, 1);
});
test('new connector ledger after crash recovers an existing talk intent by factory idempotency key', async t => {
  const f = await fixture(t), body = validateAction('talk.send', { worker: '测试员工', message: 'crash recovery' });
  const c = { id: randomUUID(), principalId: f.principalId, role: 'owner', action: 'talk.send', body, digest: commandDigest('talk.send', body), expiresAt: Date.now() + 60000 };
  const first = await f.adapter.execute(c);
  const restarted = createFactoryAdapter({ workersDir: f.workersDir, stateDir: join(f.root, 'empty-ledger'), grants: f.grants, registry: f.registry });
  const second = await restarted.execute(c);
  assert.equal(first.request.id, second.request.id); assert.equal(listWebTalkRequests(f.workersDir).length, 1);
  assert.throws(() => createWebTalkRequest(f.workersDir, { worker: '测试员工', from: '用户', message: 'changed', idempotencyKey: `mobile:${hash(`${c.principalId}:${c.id}`)}` }), /conflict/);
});
test('lost receipt response and connector restart do not duplicate dispatch', async t => {
  const f = await fixture(t), e = f.envelope('task.assign', { worker: '测试员工', message: '派活重试测试', project: 'test', mode: 'auto' });
  assert.equal((await f.request('/api/commands', e, f.owner)).status, 202); await f.connector.cycle();
  let dropped = false;
  const flaky = createConnector({ ...f.connectorOptions, fetchImpl: async (url, options) => { const r = await fetch(url, options); if (!dropped && url.endsWith('/connector/sync')) { dropped = true; await r.text(); throw Error('response lost'); } return r; } });
  await assert.rejects(flaky.cycle());
  const restarted = createConnector(f.connectorOptions); await restarted.cycle();
  assert.equal(listWorkerTaskRequests(f.workersDir).length, 1);
  const c = (await f.request(`/api/commands/${e.id}`, undefined, f.owner)).data.command; assert.equal(c.state, 'done');
  assert.equal(JSON.parse(readFileSync(join(f.root, 'connector', 'outbox.json'))).results.length, 0);
});
test('viewer can read results but cannot talk, assign, create pairing or revoke', async t => {
  const f = await fixture(t), invite = await f.request('/api/pairings', { role: 'viewer', devices: [f.deviceId] }, f.owner), viewer = await f.login(invite.data.code);
  assert.equal((await f.request('/api/commands', f.envelope('talk.send', { worker: '测试员工', message: 'no' }), viewer)).status, 403);
  assert.equal((await f.request('/api/pairings', { role: 'owner', devices: ['*'] }, viewer)).status, 403);
  assert.equal((await f.request('/api/revoke', { kind: 'session', id: f.owner.id }, viewer)).status, 403);
  const result = await f.complete(f.envelope('worker.detail', { worker: '测试员工' }), viewer); assert.equal(result.result.data.worker.id, '测试员工');
});
test('factory permission is checked independently of Hub owner role', async t => {
  const f = await fixture(t); f.grants[f.principalId].actor = '无授权员工';
  const c = await f.complete(f.envelope('task.assign', { worker: '测试员工', message: 'should not run' }));
  assert.equal(c.result.error, 'FACTORY_PERMISSION_DENIED'); assert.equal(listWorkerTaskRequests(f.workersDir).length, 0);
});
test('revoked phone cancels undispatched commands and cannot authenticate again', async t => {
  const f = await fixture(t), invite = await f.request('/api/pairings', { role: 'operator', devices: ['*'] }, f.owner), phone = await f.login(invite.data.code);
  const e = f.envelope('task.assign', { worker: '测试员工', message: 'cancel before delivery' }); assert.equal((await f.request('/api/commands', e, phone)).status, 202);
  assert.equal((await f.request('/api/revoke', { kind: 'session', id: phone.id }, f.owner)).status, 200);
  await f.connector.cycle(); assert.equal(listWorkerTaskRequests(f.workersDir).length, 0); assert.equal((await f.request('/api/state', undefined, phone)).status, 401);
});
test('device credentials cannot claim another device, accept forged receipts or call phone API', async t => {
  const f = await fixture(t), e = f.envelope('talk.send', { worker: '测试员工', message: 'proof' }); await f.request('/api/commands', e, f.owner);
  const headers = { authorization: `Bearer ${f.secret}` };
  assert.equal((await f.request('/connector/sync', { version: 1, results: [], deviceId: 'other_device' }, null, headers)).status, 400);
  const fake = await f.request('/connector/sync', { version: 1, results: [{ id: e.id, deliveryToken: 'wrong', digest: 'wrong', ok: true, data: { forged: true } }] }, null, headers);
  assert.deepEqual(fake.data.acknowledgements, []);
  assert.equal((await f.request(`/api/commands/${e.id}`, undefined, f.owner)).data.command.state, 'delivering');
  assert.equal((await f.request('/api/revoke', { kind: 'device', id: f.deviceId }, f.owner)).status, 200);
  assert.equal((await f.request('/connector/sync', { version: 1, results: [] }, null, headers)).status, 401);
});
test('unknown/unauthorized device and stale mobile requests fail without queueing', async t => {
  const f = await fixture(t), e = f.envelope('task.assign', { worker: '测试员工', message: 'x' });
  assert.equal((await f.request('/api/commands', { ...e, deviceId: 'unknown_device' }, f.owner)).status, 403);
  assert.equal((await f.request('/api/commands', { ...e, createdAt: Date.now() - 700000 }, f.owner)).status, 409);
  f.h.state.devices[f.deviceId].lastSeenAt = Date.now() - 30000;
  assert.equal((await f.request('/api/commands', e, f.owner)).status, 503);
  assert.equal(Object.keys(f.h.state.commands).length, 0);
});
test('task board create and revision-checked update remain factory truth', async t => {
  const f = await fixture(t), created = await f.complete(f.envelope('task.create', { title: '手机看板任务', description: '需求说明', project: 'mobile' }));
  const task = created.result.data.task; assert.equal(listFactoryTasks(f.workersDir).length, 1);
  const updated = await f.complete(f.envelope('task.update', { taskId: task.id, revision: task.revision, status: '待验收', context: '保留业务状态' }));
  assert.equal(updated.result.data.task.status, '待验收'); assert.equal(getFactoryTask(f.workersDir, task.id).status, '待验收');
  const stale = await f.complete(f.envelope('task.update', { taskId: task.id, revision: task.revision, status: '错误覆盖' })); assert.equal(stale.state, 'failed');
  assert.equal(getFactoryTask(f.workersDir, task.id).status, '待验收');
});
test('genuine factory job reply returns without exposing paths or raw tool events', async t => {
  const f = await fixture(t), job = createJob(f.workersDir, { worker: '测试员工', task: '测试结果', project: 'test', cwd: 'SECRET_WORKSPACE' });
  appendJobEvent(job, { type: 'tool', text: 'DO_NOT_PUBLISH_TOOL_ARGUMENTS' }); appendJobEvent(job, { type: 'done', text: '任务已完成，结果为 42。' }); updateJob(job, { status: 'done' });
  const c = await f.complete(f.envelope('job.detail', { jobId: job.id })); assert.equal(c.result.data.reply, '任务已完成，结果为 42。');
  assert.ok(!JSON.stringify(c.result).includes('SECRET_WORKSPACE')); assert.ok(!JSON.stringify(c.result).includes('DO_NOT_PUBLISH_TOOL_ARGUMENTS'));
});
test('image content validated, tied to principal/worker, and accepted as a factory talk attachment', async t => {
  const f = await fixture(t), png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF9sAAAAASUVORK5CYII=';
  const uploaded = await f.complete(f.envelope('image.upload', { worker: '测试员工', name: 'test.png', mimeType: 'image/png', data: png })); assert.equal(uploaded.state, 'done');
  const attachmentId = uploaded.result.data.attachment.id;
  const body = validateAction('talk.send', { worker: '测试员工', message: 'foreign attachment', attachmentIds: [attachmentId] });
  await assert.rejects(f.adapter.execute({ id: randomUUID(), principalId: 'second_principal', role: 'owner', action: 'talk.send', body, digest: commandDigest('talk.send', body), expiresAt: Date.now() + 60000 }), /ATTACHMENT_NOT_OWNED/);
  const sent = await f.complete(f.envelope('talk.send', { worker: '测试员工', message: '请看图片', attachmentIds: [attachmentId] })); assert.equal(sent.state, 'done');
  assert.equal(listWebTalkRequests(f.workersDir)[0].attachments[0].id, attachmentId);
});
test('service worker never intercepts API or command storage', () => {
  const source = readFileSync(new URL('./web/sw.js', import.meta.url), 'utf8');
  assert.match(source, /!SHELL\.includes\(url\.pathname\)/); assert.ok(!source.includes("'/api/"));
});

test('cloud-size connector splits receipts and an oversized read never poisons its outbox', async t => {
  const f = await fixture(t); let size = 2500;
  const connector = createConnector({ ...f.connectorOptions, stateDir: join(f.root, 'limited-connector'), maxSyncBodyBytes: 8192,
    adapter: { snapshot: () => f.adapter.snapshot(), execute: async () => ({ text: 'x'.repeat(size) }) } });
  for (let i = 0; i < 3; i++) await f.request('/api/commands', f.envelope('tasks.list', {}), f.owner);
  await connector.cycle(); await connector.cycle(); await connector.cycle();
  assert.ok(Object.values(f.h.state.commands).every(c => c.state === 'done'));
  size = 20000; const big = f.envelope('tasks.list', {}); await f.request('/api/commands', big, f.owner);
  await connector.cycle(); await connector.cycle();
  assert.equal(f.h.state.commands[big.id].result.error, 'RESULT_TOO_LARGE');
  size = 20; const small = f.envelope('tasks.list', {}); await f.request('/api/commands', small, f.owner);
  await connector.cycle(); await connector.cycle();
  assert.equal(f.h.state.commands[small.id].state, 'done');
});
test('second factory enrollment is one-time; identical worker names remain device-scoped', async t => {
  const f = await fixture(t), issued = await f.request('/api/enrollments', {}, f.owner);
  assert.equal(issued.status, 201);
  const enrolled = await f.request('/connector/enroll', { code: issued.data.code, name: '第二工厂' }); assert.equal(enrolled.status, 201);
  assert.equal((await f.request('/connector/enroll', { code: issued.data.code, name: 'duplicate' })).status, 401);
  const dir2 = join(f.root, 'factory-two'); mkdirSync(dir2);
  const adapter2 = createFactoryAdapter({ workersDir: dir2, stateDir: join(f.root, 'ledger-two'), registry: f.registry, grants: { [enrolled.data.principalId]: { actor: '用户', role: 'owner' } } });
  const second = createConnector({ hub: f.origin, credential: enrolled.data.credential, stateDir: join(f.root, 'outbox-two'), adapter: adapter2, allowInsecureLoopback: true });
  await second.cycle();
  const directory = await f.request('/api/state', undefined, f.owner); assert.equal(directory.data.devices.length, 2);
  const e = { ...f.envelope('talk.send', { worker: '测试员工', message: '只发给第二设备' }), deviceId: enrolled.data.deviceId };
  await f.request('/api/commands', e, f.owner); await f.connector.cycle(); assert.equal(listWebTalkRequests(f.workersDir).length, 0);
  await second.cycle(); await second.cycle(); assert.equal(listWebTalkRequests(dir2).length, 1); assert.equal(listWebTalkRequests(f.workersDir).length, 0);
  const invite = await f.request('/api/pairings', { role: 'viewer', devices: [f.deviceId] }, f.owner), restricted = await f.login(invite.data.code);
  assert.equal((await f.request('/api/state', undefined, restricted)).data.devices.length, 1);
  assert.equal((await f.request('/api/commands', { ...f.envelope('worker.detail', { worker: '测试员工' }), deviceId: enrolled.data.deviceId }, restricted)).status, 403);
});
test('revoking an enrollment issuer invalidates their outstanding device enrollment', async t => {
  const f = await fixture(t), invite = await f.request('/api/pairings', { role: 'owner', devices: ['*'] }, f.owner), other = await f.login(invite.data.code);
  const enrollment = await f.request('/api/enrollments', {}, other); assert.equal(enrollment.status, 201);
  await f.request('/api/revoke', { kind: 'session', id: other.id }, f.owner);
  assert.equal((await f.request('/connector/enroll', { code: enrollment.data.code, name: 'late device' })).status, 401);
});

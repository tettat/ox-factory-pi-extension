import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initialState } from './hub.mjs';
import { createPasswordRecord } from './password.mjs';
import { createNetlifyHubHandler } from './netlify-runtime.mjs';
import { prepareNetlifyHub } from './netlify-hub.mjs';

const origin = 'https://fixture.netlify.app', siteId = '11111111-2222-3333-4444-555555555555';
const password = 'fixture-only-password-32-characters', deviceSecret = 'x'.repeat(43), principalId = 'owner_fixture', deviceId = 'factory_fixture';
const passwordRecord = createPasswordRecord(password);
const context = { site: { id: siteId, url: origin }, deploy: { context: 'production', published: true }, ip: '192.0.2.123' };
function fixture() {
  let value = initialState({ principalId, deviceId, deviceName: 'isolated simulation', deviceSecret, pairingCode: 'fixture-only-pairing', adminSecret: 'fixture-only-admin' });
  value.sharedLogin = passwordRecord;
  let revision = 1, conflicts = 0, time = Date.now(), reads = 0, writes = 0;
  const store = {
    async getWithMetadata(key, options) { reads++; assert.equal(key, 'state'); assert.equal(options.consistency, 'strong'); return { data: structuredClone(value), etag: String(revision) }; },
    async setJSON(key, data, options) {
      writes++; assert.equal(key, 'state'); assert.deepEqual(Object.keys(options), ['onlyIfMatch']);
      if (conflicts > 0) { conflicts--; revision++; return { modified: false }; }
      if (options.onlyIfMatch !== String(revision)) return { modified: false };
      value = structuredClone(data); return { modified: true, etag: String(++revision) };
    },
  };
  const handler = createNetlifyHubHandler({ store, origin, siteId, now: () => time });
  async function request(path, body, headers = {}, ctx = context) {
    return handler(new Request(origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { origin, 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }), ctx);
  }
  async function login() {
    const response = await request('/api/login', { code: password, name: 'fixture phone' }); assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie').split(';')[0];
    const me = await (await request('/api/me', undefined, { cookie })).json();
    return { cookie, 'x-ox-csrf': me.csrf };
  }
  async function sync() {
    return request('/connector/sync', { version: 1, results: [], snapshot: { protocolVersion: 1, observedAt: new Date(time).toISOString(), reachable: true, workers: [], jobs: [], tasks: [], requests: [], grants: { [principalId]: 'owner' } } }, { authorization: `Bearer ${deviceSecret}` });
  }
  return { store, handler, request, login, sync, get state() { return value; }, get reads() { return reads; }, get writes() { return writes; },
    advance(ms) { time += ms; }, conflict(count) { conflicts = count; } };
}

test('cloud Hub is production-site-only; no preview, old deploy, arbitrary path or management access', async () => {
  const f = fixture();
  for (const ctx of [{}, { ...context, site: { ...context.site, id: 'another' } }, { ...context, deploy: { context: 'deploy-preview', published: false } }, { ...context, deploy: { context: 'production', published: false } }]) assert.equal((await f.request('/health', undefined, {}, ctx)).status, 403);
  for (const path of ['/management/pairing', '/.netlify/functions/mobile-hub', '/hub-state.json', '/']) assert.equal((await f.request(path)).status, 404);
  assert.equal(f.reads, 0);
  assert.equal((await f.handler(new Request('https://other.example/health'), context)).status, 403);
  assert.equal((await f.request('/health')).status, 200);
});

test('fixed password can log in repeatedly; only a hash is persisted and the cookie remains secure', async () => {
  const f = fixture();
  assert.equal((await f.request('/api/me')).status, 401);
  assert.equal((await (await f.request('/api/auth-info')).json()).mode, 'password');
  const response = await f.request('/api/login', { code: password });
  assert.equal(response.status, 200); assert.match(response.headers.get('set-cookie'), /^__Host-oxmobile=/);
  for (const flag of ['Secure', 'HttpOnly', 'SameSite=Strict']) assert.ok(response.headers.get('set-cookie').includes(flag));
  await f.login(); assert.equal(Object.keys(f.state.sessions).length, 2);
  assert.ok(!JSON.stringify(f.state).includes(password));
  assert.equal(response.headers.get('netlify-cdn-cache-control'), 'no-store');
});

test('password failures are durable across invocations and enforce a bounded per-client rate limit', async () => {
  const f = fixture();
  for (let i = 0; i < 8; i++) assert.equal((await f.request('/api/login', { code: 'wrong-password-long-enough' })).status, 401);
  assert.equal((await f.request('/api/login', { code: password })).status, 429);
  assert.equal(Object.values(f.state.passwordAttempts)[0].count, 8);
  f.advance(600001); await f.login();
  assert.equal(Object.keys(f.state.passwordAttempts).length, 0);
});

test('Origin, CSRF, device authentication and data scopes still apply to cloud hosting', async () => {
  const f = fixture();
  assert.equal((await f.request('/api/login', { code: password }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await f.request('/connector/sync', { version: 1, results: [] })).status, 401);
  const session = await f.login();
  assert.equal((await f.request('/api/logout', {}, { cookie: session.cookie })).status, 403);
  assert.equal((await f.request('/api/logout', {}, session)).status, 200);
  assert.equal((await f.request('/api/me', undefined, session)).status, 401);
});

test('simultaneous cloud instances do not overwrite one another: conflicting logins retry CAS', async () => {
  const f = fixture();
  const responses = await Promise.all([f.request('/api/login', { code: password, name: 'first' }), f.request('/api/login', { code: password, name: 'second' })]);
  assert.ok(responses.every(r => r.status === 200));
  assert.deepEqual(Object.values(f.state.sessions).map(s => s.name).sort(), ['first', 'second']);
  assert.ok(f.writes >= 3);
});

test('command retries retain one ID, and the device lease/receipt are committed before returning', async () => {
  const f = fixture(), session = await f.login(); await f.sync();
  const envelope = { id: randomUUID(), deviceId, action: 'tasks.list', body: {}, createdAt: Date.now() };
  f.conflict(1);
  let response = await f.request('/api/commands', envelope, session); assert.equal(response.status, 202);
  const id = (await response.json()).command.id;
  response = await f.request('/api/commands', envelope, session); assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(f.state.commands), [id]);
  const delivery = await (await f.sync()).json(); assert.equal(delivery.commands.length, 1);
  assert.equal(f.state.commands[id].state, 'delivering');
  const lease = delivery.commands[0];
  response = await f.request('/connector/authorize', { id, deliveryToken: lease.deliveryToken }, { authorization: `Bearer ${deviceSecret}` });
  assert.equal(response.status, 200);
  response = await f.request('/connector/sync', { version: 1, results: [{ id, digest: lease.digest, deliveryToken: lease.deliveryToken, ok: true, data: { tasks: [] } }] }, { authorization: `Bearer ${deviceSecret}` });
  assert.deepEqual((await response.json()).acknowledgements, [id]); assert.equal(f.state.commands[id].state, 'done');
});

test('even no-snapshot sync persists lastSeenAt across invocations and returns bounded idle polling', async () => {
  const f = fixture(); await f.sync(); const before = f.state.devices[deviceId].lastSeenAt;
  f.advance(10000);
  const response = await f.request('/connector/sync', { version: 1, results: [] }, { authorization: `Bearer ${deviceSecret}` });
  assert.equal(f.state.devices[deviceId].lastSeenAt, before + 10000); assert.equal((await response.json()).nextPollMs, 3000);
});

test('cloud Hub leases only one command at a time to respect provider response limits', async () => {
  const f = fixture(), session = await f.login(); await f.sync();
  for (let i = 0; i < 3; i++) assert.equal((await f.request('/api/commands', { id: randomUUID(), deviceId, action: 'tasks.list', body: {}, createdAt: Date.now() }, session)).status, 202);
  assert.equal((await (await f.sync()).json()).commands.length, 1);
  assert.equal(Object.values(f.state.commands).filter(c => c.state === 'queued').length, 2);
});

test('CAS exhaustion or storage failure never issues an uncommitted login cookie', async () => {
  const f = fixture(); f.conflict(10);
  let response = await f.request('/api/login', { code: password });
  assert.equal(response.status, 503); assert.equal(response.headers.get('set-cookie'), null); assert.equal(Object.keys(f.state.sessions).length, 0);
  f.store.getWithMetadata = async () => { throw Error('internal-provider-private-token'); };
  response = await f.request('/api/me'); assert.equal(response.status, 503); assert.ok(!(await response.text()).includes('private-token'));
  f.store.getWithMetadata = async () => null;
  assert.equal((await (await f.request('/health')).json()).error, 'HUB_NOT_CONFIGURED');
});

test('cloud payload limits are enforced before accessing the store', async () => {
  const f = fixture();
  const response = await f.handler(new Request(origin + '/api/login', { method: 'POST', body: 'x'.repeat(4 * 1024 * 1024 + 1) }), context);
  assert.equal(response.status, 413); assert.equal(f.reads, 0);
});

test('cloud bundle keeps runtime code outside public and contains no local Hub state or bootstrap', t => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  mkdirSync(join(root, 'output'), { recursive: true });
  const parent = mkdtempSync(join(root, 'output/netlify-hub-test-')), output = join(parent, 'bundle');
  assert.ok(parent.startsWith(join(root, 'output') + '/') || parent.startsWith(join(root, 'output') + '\\'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const report = prepareNetlifyHub({ output, origin, siteId });
  assert.equal(report.stateIncluded, false); assert.equal(report.mode, 'persistent-netlify-hub');
  assert.deepEqual(readdirSync(join(output, 'public')).sort(), ['_headers', 'app.js', 'icon.svg', 'index.html', 'manifest.webmanifest', 'style.css', 'sw.js', 'ui.js']);
  const config = readFileSync(join(output, 'netlify.toml'), 'utf8');
  assert.ok(!config.includes('[[redirects]]')); assert.ok(config.includes('directory = "functions"'));
  const html = readFileSync(join(output, 'public', 'index.html'), 'utf8');
  assert.ok(html.includes('ox-login')); assert.ok(!html.includes('content="pending"'));
});

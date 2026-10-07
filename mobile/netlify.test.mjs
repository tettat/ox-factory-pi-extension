import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { request } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { browserGateway } from './netlify-proxy.mjs';
import { netlifyConfig, prepareNetlify } from './netlify.mjs';
import { initialState, createMobileHub } from './hub.mjs';
import { token } from './protocol.mjs';
import { readJson, writeJson } from './store.mjs';

const origin = 'https://hub.example.com', browserOrigin = 'https://fixture.netlify.app';
function sign(secret, changes = {}, header = { alg: 'HS256', typ: 'JWT' }) {
  const parts = [header, { iss: 'netlify', site_url: browserOrigin, deploy_context: 'production', exp: Math.floor(Date.now() / 1000) + 60, ...changes }].map(x => Buffer.from(JSON.stringify(x)).toString('base64url'));
  return parts.join('.') + '.' + createHmac('sha256', secret).update(parts.join('.')).digest('base64url');
}

test('Netlify gateway requires HTTPS, unique secret and a signed production site identity', () => {
  const secret = token(), config = { origin, browserOrigin, netlifyProxy: { secret } };
  assert.throws(() => browserGateway({ origin, browserOrigin }));
  assert.throws(() => browserGateway({ ...config, origin: 'http://127.0.0.1:8791' }));
  assert.throws(() => browserGateway({ ...config, browserOrigin: origin }));
  assert.throws(() => browserGateway({ ...config, netlifyProxy: { secret: 'hardcoded-pin' } }));
  const { check } = browserGateway(config);
  const valid = sign(secret);
  assert.doesNotThrow(() => check({ headers: { 'x-nf-sign': valid } }, '/api/me'));
  for (const value of [undefined, valid + ',spoof', sign(token()), sign(secret, { exp: 0 }), sign(secret, { exp: '9999999999' }), sign(secret, { iss: 'evil' }), sign(secret, { site_url: 'https://evil.example' }), sign(secret, { deploy_context: 'deploy-preview' }), sign(secret, { nbf: 9999999999 }), sign(secret, {}, { alg: 'none' }), sign(secret, {}, { alg: 'HS256', crit: ['custom'] })]) {
    assert.throws(() => check({ headers: { 'x-nf-sign': value } }, '/api/login'), e => e.code === 'GATEWAY_AUTH_FAILED');
  }
  assert.throws(() => check({ headers: { 'x-nf-sign': valid, origin: 'https://evil.example' } }, '/api/me'), e => e.code === 'ORIGIN_REJECTED');
  assert.doesNotThrow(() => check({ headers: {} }, '/connector/sync')); // separate device auth remains mandatory in Hub
});

test('signed proxy login preserves Host, Origin, CSRF, secure cookies and direct connector isolation', async t => {
  const root = mkdtempSync(join(tmpdir(), 'ox-netlify-hub-')), stateFile = join(root, 'hub.json');
  const secret = token(), code = token(), admin = token(), credential = token();
  writeJson(stateFile, initialState({ principalId: 'owner_fixture', deviceId: 'device_fixture', deviceName: 'fixture', deviceSecret: credential, pairingCode: code, adminSecret: admin }));
  const { server } = createMobileHub({ stateFile, origin, browserOrigin, netlifyProxy: { secret } });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); rmSync(root, { recursive: true, force: true }); });
  async function call(path, body, extra = {}) {
    return new Promise((resolveResponse, reject) => {
      const req = request({ hostname: '127.0.0.1', port: server.address().port, path, method: body === undefined ? 'GET' : 'POST', headers: { host: new URL(origin).host, 'content-type': 'application/json', 'x-nf-sign': sign(secret), origin: browserOrigin, ...extra } }, res => {
        let content = ''; res.on('data', c => { content += c; }); res.on('end', () => resolveResponse({ status: res.statusCode, headers: res.headers, data: JSON.parse(content) }));
      });
      req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  assert.equal((await call('/api/me')).status, 401);
  assert.equal((await call('/api/login', { code }, { 'x-nf-sign': '' })).status, 403);
  assert.equal((await call('/api/login', { code }, { host: 'evil.example' })).status, 421);
  assert.equal((await call('/api/login', { code }, { origin })).status, 403);
  const login = await call('/api/login', { code, name: 'fixture phone' });
  assert.equal(login.status, 200);
  const rawCookie = login.headers['set-cookie'][0], cookie = rawCookie.split(';')[0];
  assert.match(rawCookie, /^__Host-oxmobile=/); assert.match(rawCookie, /HttpOnly/); assert.match(rawCookie, /SameSite=Strict/); assert.match(rawCookie, /; Secure/); assert.doesNotMatch(rawCookie, /Domain=/i);
  const me = await call('/api/me', undefined, { cookie }); assert.equal(me.status, 200);
  assert.equal(me.headers['access-control-allow-origin'], undefined); assert.equal(me.headers['cache-control'], 'no-store');
  assert.equal((await call('/api/me', undefined, { cookie, 'x-nf-sign': '' })).status, 403);
  assert.equal((await call('/api/logout', {}, { cookie })).status, 403);
  const pairing = await call('/management/pairing', { role: 'owner' }, { authorization: 'Bearer ' + admin, 'x-nf-sign': '' });
  assert.equal(pairing.status, 201); assert.ok(pairing.data.url.startsWith(browserOrigin + '/#pair='));
  assert.equal((await call('/connector/sync', { version: 1, results: [] }, { 'x-nf-sign': '' })).status, 401);
  assert.equal((await call('/connector/sync', { version: 1, results: [] }, { authorization: 'Bearer ' + credential, 'x-nf-sign': '' })).status, 200);
  assert.equal((await call('/api/logout', {}, { cookie, 'x-ox-csrf': me.data.csrf })).status, 200);
});

test('Hub CLI stores proxy key privately and gives phone links the Netlify origin', async t => {
  const root = mkdtempSync(join(tmpdir(), 'ox-netlify-cli-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const secret = token(), keyFile = join(root, 'secret.txt'), state = join(root, 'state'); writeFileSync(keyFile, secret);
  const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url)), run = promisify(execFile);
  await assert.rejects(run(process.execPath, [cli, 'hub-init', '--state', state, '--origin', origin, '--browser-origin', browserOrigin]));
  assert.equal(existsSync(join(state, 'hub-state.json')), false);
  const result = await run(process.execPath, [cli, 'hub-init', '--state', state, '--origin', origin, '--browser-origin', browserOrigin, '--netlify-secret-file', keyFile]);
  assert.ok(!result.stdout.includes(secret));
  const config = readJson(join(state, 'hub-config.json'));
  assert.equal(config.netlifyProxy.secret, secret); assert.equal(config.browserOrigin, browserOrigin);
  assert.ok(readFileSync(join(state, 'first-pairing.txt'), 'utf8').startsWith(browserOrigin + '/#pair='));
  assert.equal(readJson(join(state, 'connector-bootstrap.json')).hub, origin);
});

test('Netlify deployment is public-asset-only and fails closed while Hub is missing', async t => {
  const allowed = resolve(dirname(fileURLToPath(import.meta.url)), '../output'); mkdirSync(allowed, { recursive: true });
  const root = mkdtempSync(join(allowed, 'netlify-package-test-'));
  t.after(() => { assert.ok(resolve(root).startsWith(allowed + '/netlify-package-test-') || resolve(root).startsWith(allowed + '\\netlify-package-test-')); rmSync(root, { recursive: true, force: true }); });
  const output = join(root, 'package'), report = prepareNetlify({ output });
  assert.equal(report.mode, 'frontend-only-backend-not-configured');
  assert.deepEqual(readdirSync(join(output, 'public')).sort(), ['_headers', '_redirects', 'app.js', 'backend-unavailable.json', 'icon.svg', 'index.html', 'manifest.webmanifest', 'style.css', 'sw.js', 'ui.js']);
  assert.deepEqual(readJson(join(output, 'public/backend-unavailable.json')), { error: 'HUB_NOT_CONFIGURED' });
  assert.match(readFileSync(join(output, 'public/index.html'), 'utf8'), /name="ox-backend" content="pending"/);
  assert.match(readFileSync(join(output, 'public/_headers'), 'utf8'), /Cache-Control: no-store/);
  assert.match(readFileSync(join(output, 'public/_headers'), 'utf8'), /Content-Type: application\/manifest\+json/);
  assert.equal(existsSync(join(output, 'functions')), false);
  assert.throws(() => prepareNetlify({ output }));
  assert.throws(() => prepareNetlify({ output: join(tmpdir(), 'not-allowed') }));
  const config = netlifyConfig(origin);
  assert.match(config, /signed = "OX_PROXY_SIGNING_KEY"/); assert.match(config, /https:\/\/hub.example.com\/api\/:splat/);
  assert.doesNotMatch(config, /Access-Control-Allow-Origin|management|connector|8787|48178/);
  for (const invalid of ['http://hub.example.com', 'https://hub.example.com/path', 'https://secret@hub.example.com', origin + '/']) assert.throws(() => netlifyConfig(invalid));
});

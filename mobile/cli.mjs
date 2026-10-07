#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { hostname } from 'node:os';
import { request as httpRequest } from 'node:http';
import { token, hash } from './protocol.mjs';
import { readJson, writeJson, lockProcess } from './store.mjs';
import { initialState, createMobileHub } from './hub.mjs';
import { createConnector, validateHubUrl } from './connector.mjs';
import { loadPushDriver } from './push.mjs';
import { browserGateway } from './netlify-proxy.mjs';
import { inspectMobileState } from './doctor.mjs';
import { createConnectorHealthReporter } from './runtime-health.mjs';

function args(argv) {
  const [command, ...rest] = argv, options = {};
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith('--') || !rest[i + 1] || rest[i + 1].startsWith('--')) throw new Error('Expected --option value');
    const key = rest[i].slice(2); if (Object.hasOwn(options, key)) throw new Error('Duplicate option'); options[key] = rest[++i];
  }
  return { command, options };
}
async function main() {
  const { command, options: o } = args(process.argv.slice(2));
  const allowed = {
    init: ['state', 'actor', 'origin', 'port', 'allow-loopback-http', 'workers', 'factory', 'name', 'browser-origin', 'netlify-secret-file'],
    'hub-init': ['state', 'origin', 'port', 'allow-loopback-http', 'name', 'browser-origin', 'netlify-secret-file'],
    'connector-import': ['state', 'bootstrap-file', 'actor', 'workers', 'factory', 'allow-loopback-http'],
    enroll: ['state', 'actor', 'code-file', 'hub', 'allow-loopback-http', 'workers', 'factory', 'name'],
    hub: ['state'], connector: ['state', 'config', 'runtime-state'], pairing: ['state', 'role', 'output'],
    'push-init': ['state', 'subject'], doctor: ['state'],
  };
  if (allowed[command] && Object.keys(o).some(k => !allowed[command].includes(k))) throw new Error('Unknown option for this command');
  const dir = resolve(o.state || '.pi/mobile');
  const configFile = join(dir, 'hub-config.json'), stateFile = join(dir, 'hub-state.json');
  if (command === 'doctor') {
    const report = await inspectMobileState(dir);
    console.log(JSON.stringify(report, null, 2)); process.exitCode = report.ready ? 0 : 2; return;
  }
  if (command === 'connector-import') {
    const file = join(dir, 'connector-config.json');
    if (existsSync(file)) throw new Error('Connector already configured; refusing to replace a device credential');
    if (!o['bootstrap-file'] || !o.actor) throw new Error('connector-import requires --bootstrap-file and an explicit local --actor');
    const b = readJson(resolve(o['bootstrap-file']), null), dev = o['allow-loopback-http'] === 'true';
    if (!b || b.version !== 1 || !/^factory_[A-Za-z0-9_-]+$/.test(b.deviceId) || !/^owner_[A-Za-z0-9_-]+$/.test(b.principalId) || !/^[A-Za-z0-9_-]{43}$/.test(b.credential)) throw new Error('Invalid connector bootstrap');
    validateHubUrl(b.hub, dev);
    const workersDir = resolve(o.workers || '.pi/workers'); if (!existsSync(workersDir)) throw new Error('Factory workers directory must already exist');
    writeJson(file, { hub: b.hub, credential: b.credential, workersDir, stateDir: join(dir, 'connector'), factoryUrl: o.factory || 'http://127.0.0.1:8787', allowInsecureLoopback: dev, grants: { [b.principalId]: { actor: o.actor, role: 'owner' } } });
    console.log(JSON.stringify({ imported: true, deviceId: b.deviceId, note: 'Bootstrap contains a device secret. Keep it private; no factory permissions were changed.' })); return;
  }
  if (command === 'push-init') {
    const file = join(dir, 'push-private.json');
    if (existsSync(file)) throw new Error('Push keys already exist; do not rotate without re-enrolling phone subscriptions');
    if (!o.subject || !/^(mailto:|https:\/\/)/.test(o.subject)) throw new Error('push-init requires --subject mailto:admin@example.com or an HTTPS contact URL');
    const { default: webpush } = await import('web-push');
    const keys = { subject: o.subject, ...webpush.generateVAPIDKeys() };
    webpush.setVapidDetails(keys.subject, keys.publicKey, keys.privateKey);
    writeJson(file, keys); console.log(JSON.stringify({ configured: true, privateConfig: file, note: 'Only the new Hub uses these keys at startup. No factory services restarted.' })); return;
  }
  if (command === 'enroll') {
    const file = join(dir, 'connector-config.json');
    if (existsSync(file)) throw new Error('Connector already configured; do not overwrite an existing factory identity');
    if (!o.actor || !o['code-file'] || !o.hub) throw new Error('enroll requires --actor, --hub and --code-file (never put a credential in process arguments)');
    const dev = o['allow-loopback-http'] === 'true'; validateHubUrl(o.hub, dev);
    const workersDir = resolve(o.workers || '.pi/workers'); if (!existsSync(workersDir)) throw new Error('Factory workers directory must already exist');
    const code = readFileSync(resolve(o['code-file']), 'utf8').trim();
    const response = await fetch(o.hub + '/connector/enroll', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name: o.name || hostname() }), redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Enrollment rejected: HTTP ${response.status}`);
    const enrollment = await response.json();
    writeJson(file, { hub: o.hub, credential: enrollment.credential, workersDir, stateDir: join(dir, 'connector'), factoryUrl: o.factory || 'http://127.0.0.1:8787', allowInsecureLoopback: dev, grants: { [enrollment.principalId]: { actor: o.actor, role: 'owner' } } });
    console.log(JSON.stringify({ enrolled: true, deviceId: enrollment.deviceId, connectorConfig: file, note: 'The explicit local actor binding remains the authorization boundary. No worker permissions modified.' })); return;
  }
  if (command === 'init' || command === 'hub-init') {
    if (existsSync(configFile) || existsSync(stateFile)) throw new Error('Already initialized; use pairing to issue a fresh invitation');
    const origin = o.origin || 'http://127.0.0.1:8791', dev = o['allow-loopback-http'] === 'true';
    validateHubUrl(origin, dev);
    const browserOrigin = o['browser-origin'] || origin;
    const netlifyProxy = o['netlify-secret-file'] ? { secret: readFileSync(resolve(o['netlify-secret-file']), 'utf8').trim() } : null;
    browserGateway({ origin, browserOrigin, netlifyProxy });
    const port = Number(o.port || (command === 'init' ? new URL(origin).port : '') || 8791);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid local listener port');
    const principalId = 'owner_' + token().slice(0, 20), deviceId = 'factory_' + token().slice(0, 20), credential = token(), adminSecret = token(), pairingCode = token();
    const workersDir = resolve(o.workers || '.pi/workers');
    if (command === 'init' && !existsSync(workersDir)) throw new Error('Factory workers directory must already exist');
    if (command === 'init' && !o.actor) throw new Error('Explicit --actor required: bind the remote human to an existing factory identity');
    const grant = { actor: o.actor, role: 'owner' };
    writeJson(stateFile, initialState({ principalId, deviceId, deviceName: o.name || hostname(), deviceSecret: credential, pairingCode, adminSecret }));
    writeJson(configFile, { origin, host: '127.0.0.1', port, allowInsecureLoopback: dev, ...(netlifyProxy ? { browserOrigin, netlifyProxy } : {}) });
    writeJson(join(dir, 'management.json'), { origin, adminSecret });
    if (command === 'init') writeJson(join(dir, 'connector-config.json'), { hub: origin, credential, workersDir, stateDir: join(dir, 'connector'), factoryUrl: o.factory || 'http://127.0.0.1:8787', allowInsecureLoopback: dev, grants: { [principalId]: grant } });
    else writeJson(join(dir, 'connector-bootstrap.json'), { version: 1, hub: origin, deviceId, principalId, credential });
    mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'first-pairing.txt'), `${browserOrigin}/#pair=${pairingCode}\nExpires in 10 minutes. Do not publish this file.\n`, { mode: 0o600 });
    console.log(JSON.stringify({ initialized: true, origin, configFile, ...(command === 'init' ? { connectorConfig: join(dir, 'connector-config.json') } : { connectorBootstrapFile: join(dir, 'connector-bootstrap.json') }), oneTimeInvitationFile: join(dir, 'first-pairing.txt'), note: 'Only new mobile configuration created; no factory permissions or services changed.' })); return;
  }
  if (command === 'pairing') {
    const c = readJson(join(dir, 'management.json'), null); if (!c) throw new Error('Management config missing');
    const local = readJson(configFile, null);
    if (!local || !['127.0.0.1', 'localhost', '::1'].includes(local.host)) throw new Error('Pairing management requires local Hub configuration');
    const result = await new Promise((resolveResult, reject) => {
      const payload = JSON.stringify({ role: o.role || 'owner' });
      const req = httpRequest({ hostname: local.host, port: local.port, path: '/management/pairing', method: 'POST', headers: { host: new URL(c.origin).host, authorization: `Bearer ${c.adminSecret}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, res => {
        let data = ''; res.setEncoding('utf8'); res.on('data', chunk => { data += chunk; if (data.length > 8192) req.destroy(new Error('Invalid management response')); });
        res.on('end', () => { if (res.statusCode !== 201) return reject(new Error(`Pairing failed: HTTP ${res.statusCode}`)); try { resolveResult(JSON.parse(data)); } catch { reject(new Error('Invalid management response')); } });
      });
      req.setTimeout(10000, () => req.destroy(new Error('Management request timed out'))); req.on('error', reject); req.end(payload);
    });
    if (o.output) { writeFileSync(resolve(o.output), JSON.stringify(result), { mode: 0o600 }); console.log('One-time pairing written to the requested private file.'); }
    else console.log(JSON.stringify(result));
    return;
  }
  if (command === 'hub') {
    const c = readJson(configFile, null); if (!c) throw new Error('Run init first');
    if (!['127.0.0.1', 'localhost', '::1'].includes(c.host)) throw new Error('Hub listener must remain loopback-only behind the HTTPS reverse proxy');
    const release = lockProcess(join(dir, 'hub.lock'));
    const pushDriver = await loadPushDriver(readJson(join(dir, 'push-private.json'), null));
    const { server } = createMobileHub({ ...c, stateFile, pushDriver });
    server.listen(c.port, c.host, () => console.log(`[mobile-hub] ${c.origin} (listener ${c.host}:${c.port})`));
    server.on('error', error => { console.error(error.code || 'SERVER_ERROR'); release(); process.exitCode = 1; });
    const stop = () => { server.close(() => { release(); }); server.closeAllConnections(); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop); process.once('exit', release); return;
  }
  if (command === 'connector') {
    const file = resolve(o.config || join(dir, 'connector-config.json')), stored = readJson(file, null); if (!stored) throw new Error('Connector config missing');
    const c = { ...stored, ...(o['runtime-state'] ? { stateDir: resolve(o['runtime-state']) } : {}) };
    const release = lockProcess(join(c.stateDir, 'connector.lock'));
    const { createFactoryAdapter } = await import('./factory-adapter.mjs');
    const adapter = createFactoryAdapter({ ...c, grants: () => readJson(file, {}).grants });
    const connector = createConnector({ ...c, adapter });
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort()); process.once('SIGTERM', () => controller.abort()); process.once('exit', release);
    let previous = '';
    const health = createConnectorHealthReporter(c);
    try {
      await connector.run(controller.signal, status => {
        health(status);
        if (status !== previous) { console.log(`[mobile-connector] ${status}`); previous = status; }
      });
    } finally { try { health('stopped'); } finally { release(); } }
    return;
  }
  console.log('Commands: init (local development), hub-init (server), connector-import, enroll, hub, connector, pairing, push-init, doctor. Use --state path. Loopback HTTP requires --allow-loopback-http true. See mobile/README.md.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTIONS, VERSION, Fault, at, fields, hash, id, roleAllows, string, token, validateAction, commandDigest, ROLES } from './protocol.mjs';
import { readJson, writeJson } from './store.mjs';
import { createPushCoordinator, validateSubscription } from './push.mjs';
import { browserGateway } from './netlify-proxy.mjs';
import { verifyPassword } from './password.mjs';

const DAY = 86400000;
const webDir = join(dirname(fileURLToPath(import.meta.url)), 'web');
const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/ui.js': ['ui.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/sw.js': ['sw.js', 'text/javascript'], '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'], '/icon.svg': ['icon.svg', 'image/svg+xml'] };
export function initialState({ principalId, deviceId, deviceName, deviceSecret, pairingCode, adminSecret, now = Date.now() }) {
  id(principalId); id(deviceId);
  return { version: VERSION, ownerPrincipalId: principalId, adminHash: adminSecret ? hash(adminSecret) : null, devices: { [deviceId]: { id: deviceId, ownerPrincipalId: principalId, name: deviceName, credentialHash: hash(deviceSecret), createdAt: at(), lastSeenAt: 0, snapshot: null, revokedAt: null } },
    invitations: { [hash(pairingCode)]: { principalId, role: 'owner', devices: ['*'], expiresAt: now + 600000 } }, enrollments: {}, sessions: {}, commands: {}, audit: [] };
}
function publicCommand(command) {
  return { id: command.id, deviceId: command.deviceId, action: command.action, state: command.state, createdAt: command.createdAt, finishedAt: command.finishedAt || null, result: command.result || null,
    label: command.action === 'image.upload' ? '图片上传' : String(command.body?.message || command.body?.title || command.action).slice(0, 100) };
}
async function body(req, max = 15 * 1024 * 1024) {
  if (Number(req.headers['content-length'] || 0) > max) throw new Fault('BODY_TOO_LARGE', 413);
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > max) throw new Fault('BODY_TOO_LARGE', 413); chunks.push(chunk); }
  try { return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; }
  catch { throw new Fault('INVALID_JSON'); }
}
export function createMobileHub({ stateFile, stateStore = null, origin, browserOrigin = origin, netlifyProxy = null, allowInsecureLoopback = false, now = Date.now, pushDriver = null, nextPollMs = 1000, maxLeasedCommands = 3 }) {
  const configured = new URL(origin);
  if (configured.origin !== origin || configured.username || configured.password || (configured.protocol !== 'https:' && !(allowInsecureLoopback && configured.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(configured.hostname)))) throw new Error('Use HTTPS, or explicitly allow loopback-only development');
  const secure = configured.protocol === 'https:';
  const gateway = browserGateway({ origin, browserOrigin, netlifyProxy, now });
  const cookieName = secure ? '__Host-oxmobile' : 'oxmobile-dev';
  const state = stateStore ? stateStore.read() : readJson(stateFile, null);
  if (!state || state.version !== VERSION) throw new Error('Initialize a separate mobile Hub state first');
  state.enrollments ||= {};
  const persist = () => stateStore ? stateStore.write(state) : writeJson(stateFile, state);
  const audit = (type, data = {}) => { state.audit.push({ time: at(), type, ...data }); state.audit = state.audit.slice(-1000); };
  const cookie = raw => `${cookieName}=${raw}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${raw ? 30 * 86400 : 0}${secure ? '; Secure' : ''}`;
  const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'", ...(secure ? { 'strict-transport-security': 'max-age=31536000' } : {}) };
  const send = (res, status, data, extra = {}) => { const buf = Buffer.from(JSON.stringify(data)); res.writeHead(status, { ...headers, 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length, ...extra }); res.end(buf); };
  function session(req) {
    const raw = String(req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(cookieName + '='))?.slice(cookieName.length + 1) || '';
    const s = state.sessions[hash(raw)];
    if (!s || s.revokedAt || s.expiresAt <= now()) throw new Fault('LOGIN_REQUIRED', 401);
    return s;
  }
  function device(req) {
    const raw = /^Bearer ([A-Za-z0-9_-]{32,120})$/.exec(String(req.headers.authorization || ''))?.[1];
    const d = raw && Object.values(state.devices).find(x => x.credentialHash === hash(raw) && !x.revokedAt);
    if (!d) throw new Fault('DEVICE_AUTH_FAILED', 401);
    return d;
  }
  function canSee(s, d) { return d && !d.revokedAt && (s.devices.includes('*') || s.devices.includes(d.id)) && ROLES.includes(d.snapshot?.grants?.[s.principalId]); }
  function canManageSession(s, target) { return target.principalId === s.principalId && (s.devices.includes('*') || target.devices.every(d => s.devices.includes(d))); }
  const push = createPushCoordinator({ state, driver: pushDriver, persist, now, canSee });
  function activeCommand(c, d) {
    if (!d || d.revokedAt) return false;
    const s = c && Object.values(state.sessions).find(x => x.id === c.sessionId);
    return c && c.deviceId === d.id && s && !s.revokedAt && s.expiresAt > now() && c.expiresAt > now() && canSee(s, d) && roleAllows(s.role, ACTIONS[c.action]?.role) && roleAllows(d.snapshot?.grants?.[s.principalId], ACTIONS[c.action]?.role);
  }
  function finishStale() {
    let dirty = false;
    for (const c of Object.values(state.commands)) {
      if (['done', 'failed'].includes(c.state) && c.finishedAt) {
        const age = now() - Date.parse(c.finishedAt);
        if ((ACTIONS[c.action].role === 'viewer' && age > 120000) || age > 30 * DAY) { delete state.commands[c.id]; dirty = true; continue; }
      }
      if (!['queued', 'delivering'].includes(c.state)) continue;
      if (!activeCommand(c, state.devices[c.deviceId])) {
        c.result = { ok: false, error: c.expiresAt <= now() ? 'COMMAND_EXPIRED' : 'CREDENTIAL_REVOKED', mayHaveExecuted: c.state === 'delivering' };
        c.state = 'failed'; c.finishedAt = at(); dirty = true;
      }
    }
    return dirty;
  }
  const attempts = new Map();
  const server = createServer(async (req, res) => {
    try {
      if (req.headers.host !== configured.host) throw new Fault('INVALID_HOST', 421);
      const url = new URL(req.url, origin), path = url.pathname;
      gateway.check(req, path);
      if (req.method === 'GET' && path === '/health') return send(res, 200, { ok: true, service: 'ox-factory-mobile-hub', version: VERSION });
      if (req.method === 'GET' && path === '/api/auth-info') return send(res, 200, { mode: state.sharedLogin ? 'password' : 'pairing' });
      if (req.method === 'GET' && Object.hasOwn(assets, path)) {
        const [file, type] = assets[path], bytes = readFileSync(join(webDir, file));
        res.writeHead(200, { ...headers, 'content-type': type + '; charset=utf-8', 'content-length': bytes.length, ...(path === '/sw.js' ? { 'service-worker-allowed': '/' } : {}) }); return res.end(bytes);
      }
      if (req.method === 'POST' && path === '/management/pairing') {
        const bearer = /^Bearer ([A-Za-z0-9_-]{32,120})$/.exec(String(req.headers.authorization || ''))?.[1];
        if (!bearer || !state.adminHash || hash(bearer) !== state.adminHash) throw new Fault('MANAGEMENT_AUTH_FAILED', 401);
        const b = await body(req, 4096); fields(b, ['role']);
        if (!ROLES.includes(b.role)) throw new Fault('INVALID_ROLE');
        const code = token(); state.invitations[hash(code)] = { principalId: state.ownerPrincipalId, role: b.role, devices: ['*'], expiresAt: now() + 600000 };
        audit('pairing.created.management', { role: b.role }); persist();
        return send(res, 201, { code, url: `${browserOrigin}/#pair=${code}`, expiresInSeconds: 600 });
      }
      if (req.method === 'POST' && path === '/connector/enroll') {
        const b = await body(req, 4096); fields(b, ['code', 'name']);
        const code = string(b.code, 120), enrollment = state.enrollments[hash(code)];
        if (!enrollment || enrollment.usedAt || enrollment.expiresAt <= now()) throw new Fault('ENROLLMENT_INVALID_OR_EXPIRED', 401);
        const issuer = Object.values(state.sessions).find(s => s.id === enrollment.issuer);
        if (!issuer || issuer.revokedAt || issuer.expiresAt <= now() || issuer.role !== 'owner') throw new Fault('ENROLLMENT_INVALID_OR_EXPIRED', 401);
        enrollment.usedAt = at();
        const credential = token(), deviceId = 'factory_' + token().slice(0, 20);
        state.devices[deviceId] = { id: deviceId, ownerPrincipalId: enrollment.principalId, name: string(b.name, 80), credentialHash: hash(credential), createdAt: at(), lastSeenAt: 0, snapshot: null, revokedAt: null };
        audit('device.enrolled', { deviceId, by: issuer.id }); persist();
        return send(res, 201, { deviceId, credential, principalId: enrollment.principalId, hub: origin });
      }
      if (path.startsWith('/connector/')) {
        if (req.method !== 'POST') throw new Fault('METHOD_NOT_ALLOWED', 405);
        const d = device(req), b = await body(req);
        if (path === '/connector/authorize') {
          fields(b, ['id', 'deliveryToken']); const c = state.commands[b.id];
          if (!activeCommand(c, d) || c.deliveryToken !== b.deliveryToken || c.state !== 'delivering') throw new Fault('COMMAND_NOT_AUTHORIZED', 403);
          return send(res, 200, { ok: true });
        }
        if (path !== '/connector/sync') throw new Fault('NOT_FOUND', 404);
        fields(b, ['version', 'snapshot', 'results', 'reachable']);
        if (b.reachable !== undefined && typeof b.reachable !== 'boolean') throw new Fault('INVALID_SNAPSHOT');
        if (b.version !== VERSION || !Array.isArray(b.results) || b.results.length > 20) throw new Fault('PROTOCOL_MISMATCH');
        let dirty = false;
        if (b.snapshot) {
          fields(b.snapshot, ['protocolVersion', 'observedAt', 'reachable', 'workers', 'jobs', 'tasks', 'requests', 'grants', 'usageDate', 'capabilities', 'projects', 'projectsAvailable', 'projectsTruncated']);
          if (b.snapshot.projects !== undefined && (!Array.isArray(b.snapshot.projects) || b.snapshot.projects.length > 200)) throw new Fault('INVALID_SNAPSHOT');
          for (const flag of ['projectsAvailable', 'projectsTruncated']) if (b.snapshot[flag] !== undefined && typeof b.snapshot[flag] !== 'boolean') throw new Fault('INVALID_SNAPSHOT');
          if (b.snapshot.usageDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(b.snapshot.usageDate)) throw new Fault('INVALID_SNAPSHOT');
          if (b.snapshot.capabilities !== undefined && (!Array.isArray(b.snapshot.capabilities) || b.snapshot.capabilities.length > 10 || b.snapshot.capabilities.some(v => typeof v !== 'string' || v.length > 80))) throw new Fault('INVALID_SNAPSHOT');
          if (b.snapshot.protocolVersion !== VERSION || !['workers', 'jobs', 'tasks', 'requests'].every(k => Array.isArray(b.snapshot[k]) && b.snapshot[k].length <= 500) || !b.snapshot.grants || typeof b.snapshot.grants !== 'object' || Object.values(b.snapshot.grants).some(v => !ROLES.includes(v))) throw new Fault('INVALID_SNAPSHOT');
          const previous = d.snapshot;
          d.snapshot = b.snapshot; push.enqueue(d, previous); dirty = true;
        }
        if (b.reachable === false && d.snapshot) { d.snapshot.reachable = false; dirty = true; }
        d.lastSeenAt = now();
        // A stateless invocation must commit its heartbeat, not keep it in RAM.
        if (stateStore) dirty = true;
        const acknowledgements = [];
        for (const r of b.results) {
          fields(r, ['id', 'deliveryToken', 'digest', 'ok', 'data', 'error']);
          const c = state.commands[r.id];
          if (!c || c.deviceId !== d.id || c.deliveryToken !== r.deliveryToken || c.digest !== r.digest || typeof r.ok !== 'boolean') continue;
          if (c.state === 'delivering') {
            c.state = r.ok ? 'done' : 'failed'; c.finishedAt = at();
            c.result = r.ok ? { ok: true, data: r.data } : { ok: false, error: /^[A-Z0-9_]{1,100}$/.test(r.error) ? r.error : 'FACTORY_OPERATION_FAILED' };
            if (c.action === 'image.upload') c.body.data = '';
            audit('command.finished', { id: c.id, deviceId: d.id, ok: r.ok }); dirty = true;
          }
          acknowledgements.push(c.id);
        }
        if (finishStale()) dirty = true;
        const commands = [];
        for (const c of Object.values(state.commands)) {
          if (commands.length >= maxLeasedCommands) break;
          if (d.snapshot?.reachable && activeCommand(c, d) && (c.state === 'queued' || (c.state === 'delivering' && now() - c.leasedAt > 10000))) {
            c.state = 'delivering'; c.leasedAt = now(); dirty = true;
            commands.push({ id: c.id, principalId: c.principalId, role: c.role, action: c.action, body: c.body, digest: c.digest, expiresAt: c.expiresAt, deliveryToken: c.deliveryToken });
          }
        }
        if (dirty) persist();
        void push.drain().catch(() => {});
        return send(res, 200, { version: VERSION, acknowledgements, commands, nextPollMs: commands.length ? 1000 : nextPollMs });
      }
      if (req.method === 'POST' && path === '/api/login') {
        if (req.headers.origin !== browserOrigin) throw new Fault('ORIGIN_REJECTED', 403);
        const ip = req.socket.remoteAddress, rate = attempts.get(ip) || { count: 0, until: now() + 600000 };
        if (rate.until <= now()) { rate.count = 0; rate.until = now() + 600000; }
        const b = await body(req, 4096); fields(b, ['code', 'name']);
        const code = string(b.code, 120); let invite = state.invitations[hash(code)];
        if (state.sharedLogin && !invite) {
          state.passwordAttempts ||= {};
          for (const [key, value] of Object.entries(state.passwordAttempts)) if (value.until <= now()) delete state.passwordAttempts[key];
          const key = hash(ip || 'unknown'), failure = state.passwordAttempts[key];
          if (failure?.count >= 8) throw new Fault('LOGIN_RATE_LIMIT', 429);
          if (!verifyPassword(code, state.sharedLogin)) {
            if (!failure && Object.keys(state.passwordAttempts).length >= 1024) throw new Fault('LOGIN_RATE_LIMIT', 429);
            state.passwordAttempts[key] = { count: (failure?.count || 0) + 1, until: failure?.until || now() + 600000 };
            persist(); throw new Fault('INVALID_PASSWORD', 401);
          }
          delete state.passwordAttempts[key];
          if (Object.values(state.sessions).filter(s => !s.revokedAt && s.expiresAt > now()).length >= 100) throw new Fault('SESSION_LIMIT', 429);
          invite = { principalId: state.ownerPrincipalId, role: 'owner', devices: ['*'], expiresAt: now() + 600000 };
        }
        if (!invite || invite.expiresAt <= now() || invite.usedAt) {
          rate.count++; attempts.set(ip, rate);
          throw new Fault(rate.count > 20 ? 'LOGIN_RATE_LIMIT' : 'PAIRING_INVALID_OR_EXPIRED', rate.count > 20 ? 429 : 401);
        }
        // High-entropy valid invitations must not be locked out by unrelated bad
        // attempts sharing a reverse proxy IP. This is not a password endpoint.
        if (invite.issuer) {
          const issuer = Object.values(state.sessions).find(s => s.id === invite.issuer);
          if (!issuer || issuer.revokedAt || issuer.expiresAt <= now()) throw new Fault('PAIRING_INVALID_OR_EXPIRED', 401);
        }
        invite.usedAt = at();
        const raw = token(), s = { id: token().slice(0, 22), principalId: invite.principalId, name: string(b.name || '手机', 80), role: invite.role, devices: invite.devices, createdAt: at(), expiresAt: now() + 30 * DAY, csrf: token(), revokedAt: null };
        state.sessions[hash(raw)] = s; audit('session.created', { id: s.id, role: s.role }); persist();
        return send(res, 200, { ok: true }, { 'set-cookie': cookie(raw) });
      }
      const s = session(req);
      if (req.method !== 'GET' && (req.headers.origin !== browserOrigin || req.headers['x-ox-csrf'] !== s.csrf)) throw new Fault('CSRF_REJECTED', 403);
      if (req.method === 'GET' && path === '/api/me') return send(res, 200, { id: s.id, name: s.name, principalId: s.principalId, role: s.role, devices: s.devices, csrf: s.csrf, expiresAt: s.expiresAt, secure });
      if (req.method === 'GET' && path === '/api/push') return send(res, 200, { available: !!pushDriver, publicKey: pushDriver?.publicKey || null, subscribed: !!state.pushSubscriptions[s.id] });
      if (req.method === 'POST' && path === '/api/push/subscribe') {
        if (!pushDriver) throw new Fault('PUSH_NOT_CONFIGURED', 503);
        const b = await body(req, 8192); fields(b, ['subscription']);
        const sub = validateSubscription(b.subscription);
        for (const [sid, previous] of Object.entries(state.pushSubscriptions)) if (previous.endpoint === sub.endpoint && sid !== s.id) push.remove(sid);
        state.pushSubscriptions[s.id] = sub; audit('push.subscribed', { sessionId: s.id }); persist();
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && path === '/api/push/unsubscribe') {
        fields(await body(req, 4096), []); push.remove(s.id); persist(); return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && path === '/api/logout') {
        s.revokedAt = at(); push.remove(s.id); finishStale(); audit('session.revoked', { id: s.id }); persist();
        return send(res, 200, { ok: true }, { 'set-cookie': cookie('') });
      }
      if (req.method === 'GET' && path === '/api/state') {
        if (finishStale()) persist();
        const devices = Object.values(state.devices).filter(d => canSee(s, d)).map(d => ({ id: d.id, name: d.name, online: now() - d.lastSeenAt < 20000 && d.snapshot?.reachable === true, lastSeenAt: d.lastSeenAt,
          snapshot: { ...d.snapshot, grants: undefined }, role: ROLES[Math.min(ROLES.indexOf(s.role), ROLES.indexOf(d.snapshot.grants[s.principalId]))] }));
        // Read results (especially images/history) are fetched only by command ID,
        // not retransmitted in every background snapshot poll.
        return send(res, 200, { generatedAt: at(), devices, commands: Object.values(state.commands).filter(c => c.sessionId === s.id && ACTIONS[c.action].role !== 'viewer' && canSee(s, state.devices[c.deviceId])).slice(-80).map(publicCommand) });
      }
      if (req.method === 'POST' && path === '/api/commands') {
        const b = await body(req); fields(b, ['id', 'deviceId', 'action', 'body', 'createdAt']);
        id(b.id); id(b.deviceId);
        const payload = validateAction(b.action, b.body), digest = commandDigest(b.action, payload);
        if (!roleAllows(s.role, ACTIONS[b.action].role)) throw new Fault('ROLE_DENIED', 403);
        const d = state.devices[b.deviceId];
        if (!canSee(s, d) || !roleAllows(d.snapshot.grants[s.principalId], ACTIONS[b.action].role)) throw new Fault('DEVICE_SCOPE_DENIED', 403);
        const existing = state.commands[b.id];
        if (existing) {
          if (existing.sessionId !== s.id || existing.digest !== digest || existing.deviceId !== d.id) throw new Fault('IDEMPOTENCY_CONFLICT', 409);
          return send(res, 200, { command: publicCommand(existing) });
        }
        if (now() - d.lastSeenAt >= 20000 || !d.snapshot?.reachable) throw new Fault('DEVICE_OFFLINE', 503);
        if (!Number.isFinite(b.createdAt) || Math.abs(now() - b.createdAt) > 600000) throw new Fault('REQUEST_CLOCK_OR_EXPIRY', 409);
        if (Object.values(state.commands).filter(c => c.sessionId === s.id && ['queued', 'delivering'].includes(c.state)).length >= 10) throw new Fault('TOO_MANY_PENDING', 429);
        if (Object.keys(state.commands).length >= 10000) throw new Fault('HUB_RETENTION_LIMIT', 503);
        const c = { id: b.id, deviceId: d.id, principalId: s.principalId, sessionId: s.id, role: s.role, action: b.action, body: payload, digest,
          createdAt: at(), expiresAt: now() + 120000, deliveryToken: token(), state: 'queued' };
        state.commands[c.id] = c; audit('command.accepted', { id: c.id, action: c.action, deviceId: d.id, sessionId: s.id }); persist();
        return send(res, 202, { command: publicCommand(c) });
      }
      if (req.method === 'GET' && path.startsWith('/api/commands/')) {
        const c = state.commands[path.slice('/api/commands/'.length)];
        if (!c || c.sessionId !== s.id || !canSee(s, state.devices[c.deviceId])) throw new Fault('NOT_FOUND', 404);
        if (finishStale()) persist();
        return send(res, 200, { command: publicCommand(c) });
      }
      if (['/api/pairings', '/api/access', '/api/revoke', '/api/enrollments'].includes(path)) {
        if (s.role !== 'owner') throw new Fault('OWNER_REQUIRED', 403);
        if (path === '/api/access' && req.method === 'GET') return send(res, 200, {
          sessions: Object.values(state.sessions).filter(x => canManageSession(s, x)).map(x => ({ id: x.id, name: x.name, role: x.role, createdAt: x.createdAt, expiresAt: x.expiresAt, revokedAt: x.revokedAt })),
          devices: Object.values(state.devices).filter(d => !d.revokedAt && (canSee(s, d) || (d.ownerPrincipalId === s.principalId && s.devices.includes('*')))).map(d => ({ id: d.id, name: d.name })), audit: s.devices.includes('*') ? state.audit.slice(-80) : [],
        });
        const b = await body(req, 4096);
        if (path === '/api/enrollments' && req.method === 'POST') {
          fields(b, []);
          if (!s.devices.includes('*')) throw new Fault('OWNER_FULL_SCOPE_REQUIRED', 403);
          if (Object.values(state.devices).filter(d => !d.revokedAt).length >= 100) throw new Fault('DEVICE_LIMIT', 429);
          const code = token(); state.enrollments[hash(code)] = { principalId: s.principalId, issuer: s.id, expiresAt: now() + 600000 };
          audit('device.enrollment.created', { by: s.id }); persist();
          return send(res, 201, { code, hub: origin, expiresInSeconds: 600 });
        }
        if (path === '/api/pairings' && req.method === 'POST') {
          fields(b, ['role', 'devices']);
          if (!ROLES.includes(b.role) || !Array.isArray(b.devices) || !b.devices.length || b.devices.some(x => x !== '*' && !canSee(s, state.devices[x])) || (b.devices.includes('*') && !s.devices.includes('*'))) throw new Fault('INVALID_SCOPE');
          const code = token(); state.invitations[hash(code)] = { principalId: s.principalId, role: b.role, devices: [...new Set(b.devices)], issuer: s.id, expiresAt: now() + 600000 };
          audit('pairing.created', { role: b.role, sessionId: s.id }); persist();
          return send(res, 201, { code, url: `${browserOrigin}/#pair=${code}`, expiresInSeconds: 600 });
        }
        if (path === '/api/revoke' && req.method === 'POST') {
          fields(b, ['kind', 'id']);
          if (b.kind === 'session') {
            const target = Object.values(state.sessions).find(x => x.id === b.id && canManageSession(s, x));
            if (!target) throw new Fault('NOT_FOUND', 404); target.revokedAt = at(); push.remove(target.id);
          } else if (b.kind === 'device') {
            const target = state.devices[b.id]; if (!target || !(canSee(s, target) || (target.ownerPrincipalId === s.principalId && s.devices.includes('*')))) throw new Fault('NOT_FOUND', 404); target.revokedAt = at();
          } else throw new Fault('INVALID_REVOKE_KIND');
          finishStale(); audit(`${b.kind}.revoked`, { id: b.id, by: s.id }); persist();
          return send(res, 200, { ok: true });
        }
      }
      throw new Fault('NOT_FOUND', 404);
    } catch (error) { if (!res.headersSent) send(res, error instanceof Fault ? error.status : 500, { error: error instanceof Fault ? error.code : 'INTERNAL_ERROR' }); else res.end(); }
  });
  server.requestTimeout = 30000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000;
  return { server, state, persist, push };
}

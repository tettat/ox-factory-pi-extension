// Short-lived channel tickets reuse Hub sessions and device credentials.
// Tickets are opaque, single-connection bearer secrets, never URL parameters.
import { Fault, hash, token, fields, ROLES } from './protocol.mjs';
export const BROWSER_LEASE_MS = 30000;
export function relayOrigin(value, allowLoopback = false) {
  if (!value) return '';
  const u = new URL(value);
  if (u.origin !== value || u.username || u.password || !(u.protocol === 'https:' || (allowLoopback && u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname)))) throw new Error('Browser relay must be an exact HTTPS origin');
  return u.origin;
}
export function createBrowserTickets({ state, persist, now = Date.now, relay = '' }) {
  function issue(claims) {
    if (!relay) throw new Fault('BROWSER_RELAY_UNAVAILABLE', 503);
    state.browserTickets ||= {};
    for (const [key, t] of Object.entries(state.browserTickets)) if (t.expiresAt <= now() || (!t.connectionId && t.connectBy <= now())) delete state.browserTickets[key];
    if (Object.keys(state.browserTickets).length >= 200) throw new Fault('BROWSER_TICKET_LIMIT', 429);
    const ticket = token();
    state.browserTickets[hash(ticket)] = { ...claims, connectBy: now() + 60000, expiresAt: now() + 15 * 60000 };
    persist(); return { ticket, relay, connectBy: now() + 60000 };
  }
  function authorize(body) {
    fields(body, ['ticket', 'connectionId']);
    if (!/^[A-Za-z0-9_-]{43}$/.test(body.ticket || '') || !/^[a-zA-Z0-9_-]{16,80}$/.test(body.connectionId || '')) throw new Fault('BROWSER_AUTH_FAILED', 401);
    const t = state.browserTickets?.[hash(body.ticket)], time = now();
    if (!relay || !t || t.expiresAt <= time || (!t.connectionId && t.connectBy <= time) || (t.connectionId && t.connectionId !== body.connectionId)) throw new Fault('BROWSER_AUTH_FAILED', 401);
    const d = state.devices[t.deviceId];
    if (!d || d.revokedAt) throw new Fault('BROWSER_AUTH_FAILED', 401);
    let role = 'agent';
    if (t.kind === 'phone') {
      const s = Object.values(state.sessions).find(s => s.id === t.sessionId);
      if (!s || s.revokedAt || s.expiresAt <= time || !(s.devices.includes('*') || s.devices.includes(d.id)) || !ROLES.includes(d.snapshot?.grants?.[s.principalId])) throw new Fault('BROWSER_AUTH_FAILED', 401);
      role = ROLES[Math.min(ROLES.indexOf(s.role), ROLES.indexOf(d.snapshot.grants[s.principalId]))];
    } else if (t.credentialHash !== d.credentialHash) throw new Fault('BROWSER_AUTH_FAILED', 401);
    if (!t.connectionId) { t.connectionId = body.connectionId; persist(); }
    return { kind: t.kind, deviceId: d.id, principalId: t.principalId || null, role, sessionId: t.sessionId || null,
      connectionId: t.connectionId, expiresAt: t.expiresAt, leaseUntil: Math.min(t.expiresAt, time + BROWSER_LEASE_MS) };
  }
  return { issue, authorize };
}

import { Fault, hash, token, fields, ROLES } from './protocol.mjs';
export function createDesktopTickets({ state, persist, now = Date.now, relay = '' }) {
  const denied = () => { throw new Fault('DESKTOP_AUTH_FAILED', 401); };
  function issue(claims) {
    if (!relay) throw new Fault('DESKTOP_RELAY_UNAVAILABLE', 503);
    state.desktopTickets ||= {};
    for (const [k,t] of Object.entries(state.desktopTickets)) if (t.expiresAt <= now() || (!t.connectionId && t.connectBy <= now())) delete state.desktopTickets[k];
    if (Object.keys(state.desktopTickets).length >= 200) throw new Fault('DESKTOP_TICKET_LIMIT', 429);
    const ticket = token();
    state.desktopTickets[hash(ticket)] = { ...claims, connectBy: now()+60000, expiresAt: now()+3600000 };
    persist(); return { ticket, relay, connectBy: now()+60000 };
  }
  function authorize(body) {
    fields(body, ['ticket','connectionId']);
    if (!/^[A-Za-z0-9_-]{43}$/.test(body.ticket || '') || !/^[a-f0-9-]{36}$/.test(body.connectionId || '')) denied();
    const t = state.desktopTickets?.[hash(body.ticket)], time = now();
    if (!relay || !t || t.expiresAt <= time || (!t.connectionId && t.connectBy <= time) || (t.connectionId && t.connectionId !== body.connectionId)) denied();
    const d = state.devices[t.deviceId]; if (!d || d.revokedAt) denied();
    let role = 'agent';
    if (t.kind === 'phone') {
      const s = Object.values(state.sessions).find(s=>s.id === t.sessionId), grant = d.snapshot?.grants?.[s?.principalId];
      if (!s || s.revokedAt || s.expiresAt <= time || s.principalId !== t.principalId || !(s.devices.includes('*') || s.devices.includes(d.id)) || !ROLES.includes(s.role) || !ROLES.includes(grant)) denied();
      role = ROLES[Math.min(ROLES.indexOf(s.role), ROLES.indexOf(grant))];
      if (!['view','control'].includes(t.mode) || (t.mode === 'control' && role === 'viewer')) denied();
    } else if (t.kind !== 'agent' || t.credentialHash !== d.credentialHash) denied();
    if (!t.connectionId) { t.connectionId = body.connectionId; persist(); }
    return { audience:'desktop', kind:t.kind, deviceId:d.id, principalId:t.principalId || null, sessionId:t.sessionId || null, mode:t.mode || null, role, connectionId:t.connectionId, expiresAt:t.expiresAt, leaseUntil:Math.min(t.expiresAt,time+30000) };
  }
  return { issue, authorize };
}

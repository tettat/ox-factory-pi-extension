import { peerAccess } from './device-trust.mjs';
// Device credentials may discover only the owner's explicitly granted directory.
// Never return conversations, jobs, grants, credentials or arbitrary snapshot fields.
export function buildDeviceDirectory(state, requester, now = Date.now()) {
  const text = (value, limit = 160) => typeof value === 'string' ? value.slice(0, limit) : '';
  const devices = Object.values(state.devices || {}).filter(d =>
    !d.revokedAt && d.ownerPrincipalId === requester.ownerPrincipalId &&
    (d.id === requester.id || (() => { try { peerAccess(state, requester.id, d.id, 'worker.detail'); return true; } catch { return false; } })()) &&
    ['viewer', 'operator', 'owner'].includes(d.snapshot?.grants?.[requester.ownerPrincipalId])
  ).slice(0, 100).map(d => ({
    id: text(d.id), name: text(d.name, 80),
    online: Boolean(d.snapshot?.reachable && d.lastSeenAt > 0 && now - d.lastSeenAt <= 30000),
    lastSeenAt: d.lastSeenAt ? new Date(d.lastSeenAt).toISOString() : null,
    workers: (Array.isArray(d.snapshot?.workers) ? d.snapshot.workers : []).slice(0, 500).map(w => ({
      id: text(w.id || w.name), displayName: text(w.displayName || w.name || w.id),
      role: text(w.role, 80), backend: text(w.backend, 40), status: text(w.status, 40),
      model: text(w.model, 120), thinking: text(w.thinking, 40),
    })).filter(w => w.id),
  }));
  return { version: 1, localDeviceId: requester.id, observedAt: now, devices };
}

import { Fault, fields, hash, string } from './protocol.mjs';

export function validateSubscription(value) {
  fields(value, ['endpoint', 'expirationTime', 'keys']);
  const endpoint = string(value.endpoint, 2048), url = new URL(endpoint);
  const trusted = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com'].includes(url.hostname) || url.hostname.endsWith('.push.apple.com');
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash || !trusted) throw new Fault('PUSH_ENDPOINT_REJECTED');
  fields(value.keys, ['p256dh', 'auth']);
  for (const [key, length] of [['p256dh', 65], ['auth', 16]]) {
    const input = value.keys[key];
    if (typeof input !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(input) || Buffer.from(input, 'base64url').length !== length) throw new Fault('PUSH_KEY_INVALID');
  }
  if (Buffer.from(value.keys.p256dh, 'base64url')[0] !== 4) throw new Fault('PUSH_KEY_INVALID');
  return { endpoint, keys: { p256dh: value.keys.p256dh, auth: value.keys.auth } };
}

export async function loadPushDriver(config) {
  if (!config) return null;
  const { default: webpush } = await import('web-push');
  // Validate configuration without issuing a network request.
  webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
  return { publicKey: config.publicKey, send: (subscription, payload, tag) => webpush.sendNotification(validateSubscription(subscription), JSON.stringify(payload), {
    vapidDetails: config, TTL: 3600, urgency: 'normal', topic: tag.slice(0, 32), timeout: 10000,
  }) };
}

// Notification delivery is best effort; the factory job remains the source of truth.
export function createPushCoordinator({ state, driver, persist, now, canSee }) {
  state.pushSubscriptions ||= {};
  state.pushDeliveries ||= {};
  let busy = false;
  const sessions = () => Object.values(state.sessions);
  function remove(sessionId) {
    delete state.pushSubscriptions[sessionId];
    for (const [key, d] of Object.entries(state.pushDeliveries)) if (d.sessionId === sessionId) delete state.pushDeliveries[key];
  }
  function enqueue(device, previous) {
    if (!driver || !previous) return; // No historical notification burst on first sync.
    const before = new Map((previous.jobs || []).map(j => [j.id, j.status]));
    for (const job of device.snapshot.jobs) {
      if (!['done', 'completed', 'succeeded', 'failed', 'cancelled'].includes(job.status) || before.get(job.id) === job.status) continue;
      for (const s of sessions()) {
        if (s.revokedAt || s.expiresAt <= now() || !canSee(s, device) || !state.pushSubscriptions[s.id]) continue;
        const key = hash([device.id, job.id, job.status, s.id].join(':'));
        if (state.pushDeliveries[key]) continue;
        state.pushDeliveries[key] = { deviceId: device.id, sessionId: s.id, createdAt: now(), nextAt: now(), attempts: 0, tag: 'ox-' + key.slice(0, 29),
          payload: { title: job.status === 'failed' ? '工厂任务未成功' : '工厂有新结果', body: '打开随身工作台查看最新状态和结果。', tag: 'ox-' + key.slice(0, 29) } };
      }
    }
  }
  async function drain() {
    if (!driver || busy) return;
    busy = true;
    try {
      let dirty = false;
      for (const [key, d] of Object.entries(state.pushDeliveries)) {
        if (now() - d.createdAt > 86400000) { delete state.pushDeliveries[key]; dirty = true; }
      }
      const entries = Object.entries(state.pushDeliveries);
      // Bound disk state even if a caller produces very many completed jobs.
      for (const [key, d] of entries.slice(0, Math.max(0, entries.length - 1000))) { delete state.pushDeliveries[key]; dirty = true; }
      if (dirty) persist();
      for (const d of Object.values(state.pushDeliveries).filter(d => !d.finishedAt && d.nextAt <= now()).slice(0, 20)) {
        const s = sessions().find(s => s.id === d.sessionId), device = state.devices[d.deviceId], sub = state.pushSubscriptions[d.sessionId];
        if (!s || s.revokedAt || s.expiresAt <= now() || !sub || !canSee(s, device) || now() - d.createdAt > 3600000 || d.attempts >= 5) { d.finishedAt = now(); persist(); continue; }
        d.attempts++; d.nextAt = now() + Math.min(300000, 10000 * 2 ** d.attempts); persist();
        try { await driver.send(sub, d.payload, d.tag); d.finishedAt = now(); }
        catch (e) {
          if ([404, 410].includes(e.statusCode)) { remove(s.id); }
          else if (e.statusCode && e.statusCode < 500 && e.statusCode !== 429) d.finishedAt = now();
        }
        persist();
      }
    } finally { busy = false; }
  }
  return { enqueue, drain, remove };
}

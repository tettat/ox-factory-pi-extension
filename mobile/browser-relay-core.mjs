import { BROWSER_PROTOCOL, MAX_WIRE, requestMessage, isInput, ticketFromProtocols } from './browser-protocol.mjs';
export { BROWSER_PROTOCOL, ticketFromProtocols };
export async function authorizeChannel(hub, ticket, connectionId, fetchImpl = fetch) {
  // Workers supports manual/follow (not Node's "error"). Reject all 3xx below;
  // never follow a redirect carrying a bearer ticket to another origin.
  const r = await fetchImpl(hub + '/connector/browser-authorize', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticket, connectionId }), redirect: 'manual', signal: AbortSignal.timeout(7000) });
  if (!r.ok) throw Error('BROWSER_AUTH_HTTP_' + r.status);
  const c = await r.json();
  if (!['phone', 'agent'].includes(c.kind) || !/^[A-Za-z0-9_-]{8,100}$/.test(c.deviceId) || c.connectionId !== connectionId || !Number.isFinite(c.leaseUntil) || c.leaseUntil <= Date.now()) throw Error('BROWSER_AUTH_FAILED');
  return c;
}
// No screenshots, input text, cookies, or URLs are persisted by a relay.
// A device has one live phone channel; a second phone cannot silently take over.
export class BrowserRoom {
  constructor({ peers, save, hub, authorize = authorizeChannel, now = Date.now }) { Object.assign(this, { peers, save, hub, authorize, now }); }
  send(p, value) { if (p.ws.readyState === 1 && p.meta.leaseUntil > this.now()) p.ws.send(JSON.stringify(value)); }
  close(p, code = 4401, reason = '授权已结束，请重新连接') { try { p.ws.close(code, reason); } catch {} }
  active(kind) { return this.peers().find(p => p.meta.kind === kind && p.ws.readyState === 1 && p.meta.leaseUntil > this.now()); }
  connect(p) {
    for (const old of this.peers()) if (old.ws !== p.ws && old.ws.readyState === 1 && old.meta.kind === p.meta.kind) {
      if (old.meta.leaseUntil > this.now()) { this.close(p, 4409, '这台电脑已有浏览器连接'); return false; }
      this.close(old);
    }
    this.send(p, { type: 'ready', kind: p.meta.kind, role: p.meta.role, agentOnline: Boolean(this.active('agent')), expiresAt: p.meta.expiresAt });
    const phone = this.active('phone'), agent = this.active('agent');
    if (phone && agent) {
      this.send(agent, { type: 'peer', peer: phone.meta.connectionId, principalId: phone.meta.principalId, role: phone.meta.role });
      this.send(phone, { type: 'agent', online: true });
    }
    return true;
  }
  receive(p, raw) {
    try {
      if (p.meta.leaseUntil <= this.now()) return this.close(p);
      if (typeof raw !== 'string' || raw.length > (p.meta.kind === 'agent' ? MAX_WIRE : 12000)) throw Error('BROWSER_MESSAGE_LIMIT');
      const m = JSON.parse(raw);
      const time = this.now();
      if (!p.meta.rate || p.meta.rate.at + 1000 <= time) p.meta.rate = { at: time, n: 0 };
      if (++p.meta.rate.n > 30) { this.save(p); return this.close(p, 4429, '浏览器请求过于频繁'); }
      this.save(p);
      if (m?.type === 'ping') { this.send(p, { type: 'pong' }); return; }
      if (p.meta.kind === 'agent') {
        const phone = this.active('phone');
        if (m?.type !== 'reply' || !phone || m.peer !== phone.meta.connectionId || typeof m.id !== 'string') return;
        const pending = phone.meta.pending || [];
        if (!pending.some(x => x.id === m.id)) return;
        phone.meta.pending = pending.filter(x => x.id !== m.id); this.save(phone);
        this.send(phone, { type: 'reply', id: m.id, ...(m.ok === true ? { ok: true, data: m.data } : { ok: false, error: String(m.error || 'BROWSER_OPERATION_FAILED').slice(0, 100) }) });
        return;
      }
      requestMessage(m);
      if (isInput(m) && p.meta.role === 'viewer') throw Error('BROWSER_READ_ONLY');
      p.meta.pending = (p.meta.pending || []).filter(x => x.at + 15000 > time);
      if (p.meta.pending.some(x => x.id === m.id)) throw Error('BROWSER_DUPLICATE');
      if (p.meta.pending.length >= 4) throw Error('BROWSER_BUSY');
      const agent = this.active('agent');
      if (!agent) { this.send(p, { type: 'reply', id: m.id, ok: false, error: 'BROWSER_AGENT_OFFLINE' }); return; }
      p.meta.pending.push({ id: m.id, at: time }); this.save(p);
      this.send(agent, { type: 'command', peer: p.meta.connectionId, principalId: p.meta.principalId, role: p.meta.role, request: m });
    } catch (e) {
      let id = ''; try { id = JSON.parse(raw)?.id; } catch {}
      if (typeof id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(id)) this.send(p, { type: 'reply', id, ok: false, error: e.message });
      else this.close(p, 4400, '无效的浏览器请求');
    }
  }
  disconnected(p) {
    if (p.meta.kind === 'phone') { const agent = this.active('agent'); if (agent) this.send(agent, { type: 'leave', peer: p.meta.connectionId }); }
    else { if (this.active('agent')) return; const phone = this.active('phone'); if (phone) { phone.meta.pending = []; this.save(phone); this.send(phone, { type: 'agent', online: false }); } }
  }
  async maintain() {
    await Promise.all(this.peers().map(async p => {
      if (p.ws.readyState !== 1) return;
      if (p.meta.expiresAt <= this.now()) return this.close(p);
      if (p.meta.leaseUntil - this.now() > 15000) return;
      try {
        const c = await this.authorize(this.hub, p.meta.ticket, p.meta.connectionId);
        if (c.kind !== p.meta.kind || c.deviceId !== p.meta.deviceId || c.role !== p.meta.role) return this.close(p);
        // A Durable Object can receive requests while awaiting the Hub. Merge
        // the renewed lease into the latest attachment, not the stale snapshot.
        const current = this.peers().find(x => x.meta.connectionId === p.meta.connectionId && x.ws.readyState === 1);
        if (current) { Object.assign(current.meta, c); this.save(current); }
      } catch { this.close(p); }
    }));
  }
}

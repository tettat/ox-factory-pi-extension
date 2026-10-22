import WebSocket from 'ws';
import { readJson, writeJson, lockProcess } from './store.mjs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { validateHubUrl } from './connector.mjs';
import { createBrowserDriver } from './browser-cdp.mjs';
import { BROWSER_PROTOCOL } from './browser-protocol.mjs';
export function readInstances(dir) {
  let files; try { files = readdirSync(join(dir, 'instances')); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  return files.filter(f => /^[A-Za-z0-9_-]{1,100}\.json$/.test(f)).slice(0, 20).map(f => readJson(join(dir, 'instances', f))).filter(i => i?.id && i?.endpoint && i?.name);
}
export async function runBrowserAgent({ configFile, stateDir, signal, onStatus = () => {} }) {
  const unlock = lockProcess(join(stateDir, 'agent.lock'));
  const status = value => { writeJson(join(stateDir, 'health.json'), { pid: process.pid, status: value, observedAt: Date.now() }); onStatus(value); };
  const config = () => readJson(configFile, null);
  let socket, driver, delay = 1000;
  try {
    while (!signal?.aborted) {
      try {
        const local = config(); if (!local?.enabled || !local.connectorConfig) throw Error('BROWSER_NOT_ENABLED');
        const c = readJson(local.connectorConfig, null); validateHubUrl(c.hub, c.allowInsecureLoopback);
        const response = await fetch(c.hub + '/connector/browser-ticket', { method: 'POST', headers: { authorization: 'Bearer ' + c.credential, 'content-type': 'application/json' }, body: '{}', redirect: 'error', signal: AbortSignal.timeout(12000) });
        if (!response.ok) throw Error('BROWSER_HUB_AUTH_FAILED');
        const ticket = await response.json(), relay = new URL(ticket.relay);
        validateHubUrl(relay.origin, c.allowInsecureLoopback);
        relay.protocol = relay.protocol === 'https:' ? 'wss:' : 'ws:'; relay.pathname = '/connect';
        driver = createBrowserDriver({ instances: () => readInstances(stateDir), grant: principal => {
          const l = config(), cc = readJson(l.connectorConfig, null);
          if (!l.enabled || !cc?.grants?.[principal]) return null;
          return cc.grants[principal].role === 'viewer' && l.grants?.[principal] === 'control' ? 'view' : l.grants?.[principal];
        } });
        const seen = new Set(), peers = new Set(); let queue = Promise.resolve(), count = 0, lastMessage = Date.now(), ready = false;
        socket = new WebSocket(relay, [BROWSER_PROTOCOL, 't.' + ticket.ticket], { maxPayload: 64000, handshakeTimeout: 15000 });
        const currentSocket = socket, currentDriver = driver;
        await new Promise(resolve => {
          const end = () => { clearInterval(heartbeat); signal?.removeEventListener('abort', abort); resolve(); };
          const abort = () => socket.close(1000, '本机已停用'); signal?.addEventListener('abort', abort, { once: true });
          const heartbeat = setInterval(() => {
            if (Date.now() - lastMessage > 30000) { status('reconnecting'); currentSocket.terminate(); return; }
            if (currentSocket.readyState === 1) { currentSocket.send('{"type":"ping"}'); if (ready) status('connected'); }
          }, 10000);
          socket.on('open', () => { delay = 1000; status('authorizing'); });
          socket.on('error', () => { status('reconnecting'); }); socket.once('close', end);
          socket.on('message', bytes => {
            let m; try { m = JSON.parse(bytes); } catch { return; }
            lastMessage = Date.now();
            if (m.type === 'ready') { ready = true; status('connected'); return; }
            if (m.type === 'peer') { peers.add(m.peer); return; }
            if (m.type === 'leave') { peers.delete(m.peer); void currentDriver.release(m.peer); return; }
            if (m.type !== 'command') return;
            const respond = result => { if (currentSocket.readyState === 1) currentSocket.send(JSON.stringify({ type: 'reply', peer: m.peer, id: m.request?.id, ...result })); };
            const id = m.peer + ':' + m.request?.id;
            if (seen.has(id) || count >= 4) { respond({ ok: false, error: 'BROWSER_BUSY' }); return; }
            seen.add(id); if (seen.size > 400) seen.delete(seen.values().next().value); count++;
            queue = queue.then(async () => {
              try { if (!peers.has(m.peer) || currentSocket.readyState !== 1) return; respond({ ok: true, data: await currentDriver.execute(m.peer, m.principalId, m.role, m.request) }); }
              catch (e) { respond({ ok: false, error: /^[A-Z_]+$/.test(e.message) ? e.message : 'BROWSER_OPERATION_FAILED' }); }
              finally { count--; }
            });
          });
        });
      } catch { status('reconnecting'); }
      finally { await driver?.close(); socket?.close(); }
      if (signal?.aborted) break;
      await new Promise(resolve => { const timer = setTimeout(done, delay); function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); } signal?.addEventListener('abort', done, { once: true }); });
      delay = Math.min(delay * 2, 30000);
    }
  } finally { status('stopped'); unlock(); }
}

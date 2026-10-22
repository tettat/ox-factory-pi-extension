// Optional self-hosted relay behind an HTTPS/WebSocket reverse proxy.
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { relayOrigin } from './browser-auth.mjs';
import { authorizeChannel, BrowserRoom, BROWSER_PROTOCOL, ticketFromProtocols } from './browser-relay-core.mjs';
export function createBrowserRelay({ hub, phoneOrigin, allowLoopback = false }) {
  relayOrigin(hub, allowLoopback); relayOrigin(phoneOrigin, allowLoopback);
  const rooms = new Map(), server = createServer((req, res) => {
    res.writeHead(req.url === '/health' ? 200 : 404, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(req.url === '/health' ? { ok: true, service: 'ox-browser-relay' } : { error: 'NOT_FOUND' }));
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 600000, perMessageDeflate: false, handleProtocols: () => BROWSER_PROTOCOL });
  server.on('upgrade', async (req, socket, head) => {
    try {
      if (req.url !== '/connect' || (req.headers.origin && req.headers.origin !== phoneOrigin)) throw Error();
      const ticket = ticketFromProtocols(req.headers['sec-websocket-protocol']), connectionId = randomUUID();
      const claims = await authorizeChannel(hub, ticket, connectionId);
      if (claims.kind === 'phone' && req.headers.origin !== phoneOrigin) throw Error();
      if (!rooms.has(claims.deviceId)) {
        const peers = new Set(), room = new BrowserRoom({ hub, peers: () => [...peers], save() {} });
        rooms.set(claims.deviceId, { peers, room });
      }
      const { room, peers } = rooms.get(claims.deviceId);
      wss.handleUpgrade(req, socket, head, ws => {
        const p = { ws, meta: { ...claims, ticket } }; peers.add(p); room.connect(p);
        ws.on('message', (b, binary) => room.receive(p, binary ? b : b.toString()));
        ws.on('close', () => { peers.delete(p); room.disconnected(p); if (!peers.size) rooms.delete(claims.deviceId); });
        ws.on('error', () => ws.close());
      });
    } catch { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); }
  });
  const timer = setInterval(() => { for (const { room } of rooms.values()) void room.maintain(); }, 10000); timer.unref();
  return { server, close: async () => { clearInterval(timer); for (const { peers } of rooms.values()) for (const p of peers) p.ws.terminate(); await new Promise(r => server.close(r)); } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const hub = process.env.OX_BROWSER_HUB, phoneOrigin = process.env.OX_BROWSER_PHONE_ORIGIN || hub;
  const port = Number(process.env.PORT || 8793), host = process.env.HOST || '127.0.0.1';
  const relay = createBrowserRelay({ hub, phoneOrigin });
  relay.server.listen(port, host, () => console.log('Browser relay listening (no CDP endpoint exposed)'));
}

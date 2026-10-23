import { DurableObject } from 'cloudflare:workers';
import { authorizeChannel, BrowserRoom, BROWSER_PROTOCOL, ticketFromProtocols } from '../browser-relay-core.mjs';
import { authorizeDesktop, DesktopRoom, DESKTOP_PROTOCOL, desktopTicket } from '../desktop-relay-core.mjs';
export default {
  async fetch(request, env) {
    const url = new URL(request.url), headers = { 'cache-control': 'no-store' };
    if (url.pathname === '/health' && !url.search) return Response.json({ ok: true, service: 'ox-browser-relay' }, { headers });
    const desktop = url.pathname === '/desktop';
    if (request.method !== 'GET' || !['/connect', '/desktop'].includes(url.pathname) || url.search || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return Response.json({ error: 'NOT_FOUND' }, { status: 404, headers });
    try {
      const origin = request.headers.get('Origin');
      if (origin && origin !== env.PHONE_ORIGIN) throw Error();
      const ticket = (desktop ? desktopTicket : ticketFromProtocols)(request.headers.get('Sec-WebSocket-Protocol') || ''), connectionId = crypto.randomUUID();
      const claims = await (desktop ? authorizeDesktop : authorizeChannel)(env.HUB_ORIGIN, ticket, connectionId);
      if (claims.kind === 'phone' && origin !== env.PHONE_ORIGIN) throw Error();
      const h = new Headers({ Upgrade: 'websocket', 'x-ox-channel': JSON.stringify({ ...claims, ticket }) });
      return await (desktop ? env.DESKTOP_ROOMS : env.BROWSER_ROOMS).getByName(claims.deviceId).fetch(new Request('https://room/connect', { headers: h }));
    } catch { return Response.json({ error: 'BROWSER_AUTH_FAILED' }, { status: 401, headers }); }
  }
};
export class BrowserRelay extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env); this.env = env; this.ctx = ctx;
    this.room = new BrowserRoom({ hub: env.HUB_ORIGIN,
      peers: () => ctx.getWebSockets().map(ws => ({ ws, meta: ws.deserializeAttachment() })),
      save: p => p.ws.serializeAttachment(p.meta) });
  }
  async fetch(request) {
    const meta = JSON.parse(request.headers.get('x-ox-channel'));
    const pair = new WebSocketPair(), [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server); server.serializeAttachment(meta);
    this.room.connect({ ws: server, meta });
    await this.ctx.storage.setAlarm(Date.now() + 10000);
    return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': BROWSER_PROTOCOL } });
  }
  webSocketMessage(ws, message) { this.room.receive({ ws, meta: ws.deserializeAttachment() }, message); }
  webSocketClose(ws, code, reason) { this.room.disconnected({ ws, meta: ws.deserializeAttachment() }); try { ws.close(code, reason); } catch {} }
  webSocketError(ws) { try { ws.close(1011, '连接中断'); } catch {} }
  async alarm() { await this.room.maintain(); if (this.ctx.getWebSockets().some(w => w.readyState === 1)) await this.ctx.storage.setAlarm(Date.now() + 10000); }
}
export class DesktopRelay extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env); this.ctx = ctx;
    this.room = new DesktopRoom({ hub:env.HUB_ORIGIN, peers:()=>ctx.getWebSockets().map(ws=>({ws,meta:ws.deserializeAttachment()})), save:p=>p.ws.serializeAttachment(p.meta) });
  }
  async fetch(request) {
    const meta=JSON.parse(request.headers.get('x-ox-channel')),pair=new WebSocketPair(),[client,server]=Object.values(pair);
    this.ctx.acceptWebSocket(server);server.serializeAttachment(meta);this.room.connect({ws:server,meta});
    await this.ctx.storage.setAlarm(Date.now()+10000);
    return new Response(null,{status:101,webSocket:client,headers:{'Sec-WebSocket-Protocol':DESKTOP_PROTOCOL}});
  }
  webSocketMessage(ws,message){this.room.receive({ws,meta:ws.deserializeAttachment()},message);}
  webSocketClose(ws,code,reason){this.room.disconnected({ws,meta:ws.deserializeAttachment()});try{ws.close(code,reason);}catch{}}
  webSocketError(ws){try{ws.close(1011,'桌面连接中断');}catch{}}
  async alarm(){await this.room.maintain();if(this.ctx.getWebSockets().some(w=>w.readyState===1))await this.ctx.storage.setAlarm(Date.now()+10000);}
}

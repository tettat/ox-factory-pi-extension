import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { initialState, createMobileHub } from './hub.mjs';
import { createBrowserTickets, relayOrigin } from './browser-auth.mjs';
import { BrowserRoom, ticketFromProtocols } from './browser-relay-core.mjs';
import { requestMessage, webPage } from './browser-protocol.mjs';
import { localEndpoint, createBrowserDriver } from './browser-cdp.mjs';
import { fitView, zoomView, remotePoint, clampView } from './web/browser-geometry.js';
import { browserUrl } from './web/browser.js';
const initial = () => initialState({ principalId: 'owner_browser', deviceId: 'device_browser', deviceName: 'fixture', deviceSecret: 'fixture-only', pairingCode: 'fixture-pairing' });
function tickets() {
  const state = initial(); let now = Date.now(), writes = 0;
  state.devices.device_browser.snapshot = { grants: { owner_browser: 'owner', operator_browser: 'operator', viewer_browser: 'viewer' } };
  state.sessions.cookie = { id: 'session_browser', principalId: 'owner_browser', role: 'owner', devices: ['device_browser'], expiresAt: now + 1e7 };
  const t = createBrowserTickets({ state, persist: () => writes++, now: () => now, relay: 'https://relay.example.com' });
  return { t, state, get writes() { return writes; }, advance(n) { now += n; }, issue: () => t.issue({ kind: 'phone', deviceId: 'device_browser', principalId: 'owner_browser', sessionId: 'session_browser' }) };
}
test('browser tickets are bound to one connection and revoked with the factory session/device', () => {
  const f = tickets(), issued = f.issue(), body = { ticket: issued.ticket, connectionId: randomUUID() };
  assert.equal(JSON.stringify(f.state).includes(issued.ticket), false);
  assert.equal(f.t.authorize(body).role, 'owner'); const writes = f.writes;
  f.t.authorize(body); assert.equal(f.writes, writes, 'renewal checks do not rewrite state');
  assert.throws(() => f.t.authorize({ ...body, connectionId: randomUUID() }), /AUTH_FAILED/);
  f.state.sessions.cookie.role = 'viewer'; assert.equal(f.t.authorize(body).role, 'viewer');
  f.state.sessions.cookie.devices = ['another_device']; assert.throws(() => f.t.authorize(body), /AUTH_FAILED/);
  f.state.sessions.cookie.devices = ['*']; f.state.sessions.cookie.revokedAt = 'now'; assert.throws(() => f.t.authorize(body), /AUTH_FAILED/);
  f.state.sessions.cookie.revokedAt = null; f.state.devices.device_browser.revokedAt = 'now'; assert.throws(() => f.t.authorize(body), /AUTH_FAILED/);
});
test('unused tickets expire quickly; live tickets and local device rotations cannot linger indefinitely', () => {
  const f = tickets(), body = { ticket: f.issue().ticket, connectionId: randomUUID() };
  f.advance(60001); assert.throws(() => f.t.authorize(body), /AUTH_FAILED/);
  body.ticket = f.issue().ticket; f.t.authorize(body); f.advance(15 * 60000 + 1); assert.throws(() => f.t.authorize(body), /AUTH_FAILED/);
  const a = f.t.issue({ kind: 'agent', deviceId: 'device_browser', credentialHash: f.state.devices.device_browser.credentialHash });
  assert.equal(f.t.authorize({ ticket: a.ticket, connectionId: body.connectionId }).kind, 'agent');
  f.state.devices.device_browser.credentialHash = 'rotated'; assert.throws(() => f.t.authorize({ ticket: a.ticket, connectionId: body.connectionId }), /AUTH_FAILED/);
});
test('browser transport and inputs reject raw CDP, non-loopback endpoints, URL credentials and scripts', () => {
  for (const value of ['http://remote.example:9222', 'http://localhost:9222', 'http://127.0.0.1:9222/x', 'http://127.0.0.1:80', 'http://a:b@127.0.0.1:9222']) assert.throws(() => localEndpoint(value));
  assert.equal(localEndpoint('http://127.0.0.1:9222'), 'http://127.0.0.1:9222');
  assert.throws(() => relayOrigin('http://example.com')); assert.throws(() => relayOrigin('https://user:pass@example.com'));
  assert.equal(ticketFromProtocols('ox-browser-v1, t.' + 'a'.repeat(43)), 'a'.repeat(43)); assert.throws(() => ticketFromProtocols('arbitrary'));
  for (const url of ['javascript:alert(1)', 'file:///secret', 'chrome://settings', 'https://user:password@example.com']) assert.equal(webPage(url), false);
  assert.equal(webPage('https://example.com'), true);
  const base = { type: 'request', id: 'one', action: 'click', instance: 'chrome_one', target: 'page_one', view: 'view_one', frame: 'frame_one', x: 10, y: 10 };
  assert.doesNotThrow(() => requestMessage(base));
  for (const patch of [{ method: 'Runtime.evaluate' }, { action: 'Runtime.evaluate' }, { principalId: 'owner' }, { x: -1 }, { x: Infinity }, { frame: '' }, { action: 'navigate', url: 'javascript:x' }, { action: 'key', key: 'F12' }]) assert.throws(() => requestMessage({ ...base, ...patch }));
});
test('relay enforces roles, response correlation, leases and does not silently preempt another phone', async () => {
  let now = 1000; const peers = [], make = (kind, role = 'owner') => { const p = { meta: { kind, role, deviceId: 'device_browser', connectionId: randomUUID(), leaseUntil: 31000, expiresAt: 100000, principalId: 'owner_browser' }, ws: { readyState: 1, output: [], send(s) { this.output.push(JSON.parse(s)); }, close(code) { this.readyState = 3; this.code = code; } } }; peers.push(p); return p; };
  const room = new BrowserRoom({ hub: 'https://hub.example.com', peers: () => peers, save() {}, now: () => now, authorize: async () => { throw Error('revoked'); } });
  const agent = make('agent'), phone = make('phone', 'viewer'); room.connect(agent); room.connect(phone);
  const second = make('phone'); assert.equal(room.connect(second), false); assert.equal(second.ws.code, 4409);
  const input = { type: 'request', id: 'input1', action: 'reload', instance: 'chrome_one', target: 'page_one', view: 'view_one', frame: 'frame_one' };
  room.receive(phone, JSON.stringify(input)); assert.equal(phone.ws.output.at(-1).error, 'BROWSER_READ_ONLY');
  room.receive(phone, JSON.stringify({ type: 'request', id: 'list1', action: 'list' })); assert.equal(agent.ws.output.at(-1).principalId, 'owner_browser');
  const before = phone.ws.output.length;
  room.receive(agent, JSON.stringify({ type: 'reply', peer: phone.meta.connectionId, id: 'unknown', ok: true, data: 'not-forwarded' })); assert.equal(phone.ws.output.length, before);
  room.receive(agent, JSON.stringify({ type: 'reply', peer: phone.meta.connectionId, id: 'list1', ok: true, data: { instances: [] } })); assert.deepEqual(phone.ws.output.at(-1).data.instances, []);
  now = 17000; await room.maintain(); assert.equal(phone.ws.readyState, 3); assert.equal(agent.ws.readyState, 3);
});
test('portrait uses height with bounded pan; landscape fits; pinch and hit mapping preserve remote CSS coordinates', () => {
  const p = fitView(390, 700, 1280, 800); assert.equal(p.scale, 700/800); assert.equal(p.x, 0);
  const moved = clampView({ ...p, x: -1e5 }, 390,700,1280,800); assert.equal(moved.x,390-1280*p.scale);
  const r = remotePoint(moved,100,200,1280,800); assert.ok(r.x > 800); assert.ok(r.y > 200);
  assert.equal(remotePoint(p,-1,100,1280,800),null);
  const l = fitView(844,300,1280,800); assert.equal(l.scale,300/800); assert.ok(l.x > 0);
  const z = zoomView(p,2,195,350,390,700,1280,800); assert.deepEqual(remotePoint(z,195,350,1280,800),remotePoint(p,195,350,1280,800));
});
test('CDP driver uses only registered targets and bounded actions; stale frames cannot be clicked', async t => {
  let origin, scroll = 0; const calls = [], server = createServer((req,res) => {res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ webSocketDebuggerUrl: origin.replace('http:','ws:')+'/devtools/browser/fixture' }));});
  const wss = new WebSocketServer({ server });
  wss.on('connection', ws => ws.on('message', raw => {
    const r=JSON.parse(raw);calls.push(r); let result={};
    if(r.method==='Target.getTargets')result={targetInfos:[{targetId:'page_one',type:'page',url:'https://example.com',title:'Demo'}]};
    if(r.method==='Browser.getWindowForTarget')result={windowId:1};
    if(r.method==='Target.attachToTarget')result={sessionId:'session_one'};
    if(r.method==='Page.getFrameTree')result={frameTree:{frame:{url:'https://example.com'}}};
    if(r.method==='Page.getLayoutMetrics')result={cssVisualViewport:{pageX:0,pageY:scroll,clientWidth:1280,clientHeight:800,scale:1}};
    if(r.method==='Page.captureScreenshot')result={data:'fixture-jpeg'};
    ws.send(JSON.stringify({id:r.id,result}));
  }));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port;
  let now=Date.now(); const driver=createBrowserDriver({instances:()=>[{id:'chrome_one',name:'Fixture',endpoint:origin,browserId:'fixture'}],grant:p=>p==='owner_browser'?'control':null,now:()=>now});
  t.after(async()=>{await driver.close();for(const ws of wss.clients)ws.terminate();await new Promise(r=>server.close(r));});
  const req=(action,extra={})=>({type:'request',id:randomUUID(),action,instance:'chrome_one',target:'page_one',view:'view_one',...extra});
  await assert.rejects(driver.execute('peer','stranger','owner',req('list')),/GRANT_DENIED/);
  assert.equal((await driver.execute('peer','owner_browser','owner',req('list'))).instances[0].tabs[0].windowId,1);
  await driver.execute('peer','owner_browser','owner',req('watch'));
  const f=await driver.execute('peer','owner_browser','owner',req('frame'));
  await assert.rejects(driver.execute('peer','owner_browser','viewer',req('click',{frame:f.frame,x:1,y:1})),/READ_ONLY/);
  await driver.execute('peer','owner_browser','owner',req('click',{frame:f.frame,x:120,y:180}));
  assert.deepEqual(calls.filter(c=>c.method==='Input.dispatchMouseEvent').map(c=>c.params.type),['mousePressed','mouseReleased']);
  await assert.rejects(driver.execute('peer','owner_browser','owner',req('click',{frame:f.frame,x:1,y:1})),/STALE/);
  now+=1000;const f2=await driver.execute('peer','owner_browser','owner',req('frame'));scroll=50;
  await assert.rejects(driver.execute('peer','owner_browser','owner',req('click',{frame:f2.frame,x:1,y:1})),/STALE/);
  now+=1000;const f3=await driver.execute('peer','owner_browser','owner',req('frame'));
  await driver.execute('peer','owner_browser','owner',req('key',{frame:f3.frame,key:'Enter'}));
  const enter=calls.find(c=>c.method==='Input.dispatchKeyEvent'&&c.params.type==='keyDown');
  assert.equal(enter.params.text,'\r','Enter must generate the text/keypress event, not only raw keydown');
  assert.ok(!calls.some(c=>/Runtime|Cookie|Network|Browser.close/.test(c.method)));
});

test('relay renewal preserves concurrent requests in hibernating socket attachments', async () => {
  let finish; const wait = new Promise(r=>finish=r), now=1000;
  const make=(kind)=>({meta:{kind,role:kind==='phone'?'owner':'agent',deviceId:'device_browser',principalId:'owner_browser',connectionId:randomUUID(),leaseUntil:12000,expiresAt:100000},ws:{readyState:1,output:[],send(s){this.output.push(JSON.parse(s));},close(){this.readyState=3;}}});
  const phone=make('phone'), agent=make('agent'); agent.meta.leaseUntil=31000; const storage=[phone,agent];
  const snapshots=()=>storage.map(p=>({ws:p.ws,meta:structuredClone(p.meta)}));
  const room=new BrowserRoom({hub:'https://hub.example.com',peers:snapshots,now:()=>now,save:p=>{storage.find(s=>s.ws===p.ws).meta=structuredClone(p.meta);},authorize:async()=>{await wait;return {...phone.meta,leaseUntil:31000};}});
  // The actual Hub returns claims only, not a pending-message list.
  room.authorize=async()=>{const claims={...phone.meta};await wait;return {...claims,leaseUntil:31000};};
  const renewal=room.maintain(); room.receive(snapshots()[0],JSON.stringify({type:'request',id:'during-renewal',action:'list'}));finish();await renewal;
  assert.equal(phone.meta.pending[0].id,'during-renewal');
  const duplicate=make('agent');storage.push(duplicate);room.connect({ws:duplicate.ws,meta:structuredClone(duplicate.meta)});assert.equal(duplicate.ws.readyState,3);
  const before=phone.ws.output.length;room.disconnected(duplicate);assert.equal(phone.ws.output.length,before,'rejected second agent must not mark the live agent offline');
});

test('shared authorizer never follows redirects, including on Cloudflare', async()=>{
  const {authorizeChannel}=await import('./browser-relay-core.mjs');
  await assert.rejects(authorizeChannel('https://hub.example.com','ticket',randomUUID(),async(url,init)=>{assert.equal(init.redirect,'manual');return new Response('',{status:302,headers:{location:'https://untrusted.example.com'}});}),/BROWSER_AUTH_HTTP_302/);
});

test('address entry accepts bare domains but never turns scripts, files or credentials into navigation', () => {
  assert.equal(browserUrl(' example.com/path?q=1 '), 'https://example.com/path?q=1');
  assert.equal(browserUrl('http://127.0.0.1:9222/test'), 'http://127.0.0.1:9222/test');
  assert.equal(browserUrl('example.com:8443/test'), 'https://example.com:8443/test');
  assert.equal(browserUrl('about:blank'), 'about:blank');
  for (const value of ['', 'javascript:alert(1)', 'data:text/html,test', 'file:///secret', 'chrome://settings', 'https://user:secret@example.com', 'foo bar', 'https://example.com\\@bad.test']) assert.equal(browserUrl(value), null, value);
});

test('explicit navigation does not need a frame; coordinate and focused input always do', () => {
  const req = action => ({ type: 'request', id: 'one', action, instance: 'chrome_one', target: 'page_one', view: 'view_one', url: 'https://example.com' });
  for (const action of ['navigate', 'newTab', 'back', 'forward', 'reload', 'activate']) assert.doesNotThrow(() => requestMessage(req(action)));
  for (const action of ['click', 'scroll', 'text', 'key']) assert.throws(() => requestMessage(req(action)), /STALE_BROWSER_FRAME/);
  for (const action of ['navigate', 'newTab']) {
    for (const url of ['javascript:alert(1)', 'file:///secret', 'chrome://settings', 'https://a:b@example.com']) assert.throws(() => requestMessage({ ...req(action), url }), /INVALID_BROWSER_URL/);
    assert.throws(() => requestMessage({ ...req(action), target: '' }), /INVALID_BROWSER_TARGET/);
  }
});

test('toolbar navigation recovers without screenshots and follows only newly opened related tabs', async t => {
  let origin, socket, now = Date.now(), failed = false;
  const calls = [], targets = [{ targetId: 'page_one', type: 'page', url: 'https://example.com', title: 'Demo' }];
  const server = createServer((req, res) => res.end(JSON.stringify({ webSocketDebuggerUrl: origin.replace('http:', 'ws:') + '/devtools/browser/fixture' })));
  const wss = new WebSocketServer({ server });
  wss.on('connection', ws => { socket = ws; ws.on('message', raw => {
    const r = JSON.parse(raw); calls.push(r); let result = {};
    if (r.method === 'Target.getTargets') result = { targetInfos: targets };
    if (r.method === 'Target.attachToTarget') result = { sessionId: 'session_one' };
    if (r.method === 'Page.getFrameTree') result = { frameTree: { frame: { url: targets[0].url } } };
    if (r.method === 'Page.getLayoutMetrics') result = { cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 1280, clientHeight: 800, scale: 1 } };
    if (r.method === 'Page.captureScreenshot') result = { data: 'fixture-jpeg' };
    if (r.method === 'Target.createTarget') result = { targetId: 'created_page' };
    if (r.method === 'Page.navigate' && failed) result = { errorText: 'net::ERR_NAME_NOT_RESOLVED' };
    ws.send(JSON.stringify({ id: r.id, result }));
  }); });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); origin = 'http://127.0.0.1:' + server.address().port;
  const driver = createBrowserDriver({ instances: () => [{ id: 'chrome_one', name: 'Fixture', endpoint: origin, browserId: 'fixture' }], grant: p => p === 'owner' ? 'control' : null, now: () => now });
  t.after(async () => { await driver.close(); for (const ws of wss.clients) ws.terminate(); await new Promise(r => server.close(r)); });
  const req = (action, extra = {}) => ({ type: 'request', id: randomUUID(), action, instance: 'chrome_one', target: 'page_one', view: 'view_one', ...extra });
  const run = (action, extra) => driver.execute('peer', 'owner', 'owner', req(action, extra));
  await assert.rejects(run('navigate', { url: 'https://example.org' }), /BROWSER_VIEW_CHANGED/);
  await run('watch');
  for (const action of ['navigate', 'newTab']) {
    await assert.rejects(driver.execute('peer', 'owner', 'viewer', req(action, { url: 'https://example.org' })), /READ_ONLY/);
    await assert.rejects(driver.execute('peer', 'stranger', 'owner', req(action, { url: 'https://example.org' })), /GRANT_DENIED/);
  }
  assert.equal((await run('navigate', { url: 'https://example.org' })).accepted, true);
  assert.equal(calls.some(c => c.method === 'Page.captureScreenshot'), false);
  assert.equal((await run('newTab', { url: 'https://example.org/new' })).openedTab.id, 'created_page');
  await assert.rejects(run('navigate', { view: 'old_view', url: 'https://example.org' }), /VIEW_CHANGED/);
  failed = true; await assert.rejects(run('navigate', { url: 'https://example.org' }), /NAVIGATION_FAILED/); failed = false;
  // Even a failed/interstitial screenshot cannot strand the address controls.
  targets[0].url = 'chrome-error://chromewebdata/';
  assert.equal((await run('navigate', { url: 'https://example.org' })).accepted, true);
  targets[0].url = 'https://example.com';
  targets.push({ targetId: 'old_popup', type: 'page', openerId: 'page_one', url: 'https://example.org/old' });
  const f = await run('frame'); await run('click', { frame: f.frame, x: 20, y: 30 }); now += 1000;
  targets.push({ targetId: 'unrelated', type: 'page', url: 'https://example.org/unrelated' });
  assert.ok((await run('frame')).jpeg, 'old popups and unrelated desktop tabs must not steal selection');
  targets.push({ targetId: 'new_popup', type: 'page', openerId: 'page_one', url: 'https://example.org/new' });
  assert.equal((await run('frame')).openedTab.id, 'new_popup');
  now += 1000; const f2 = await run('frame'); await run('click', { frame: f2.frame, x: 20, y: 30 });
  socket.send(JSON.stringify({ sessionId: 'session_one', method: 'Page.windowOpen', params: { url: 'https://example.org/noopener', userGesture: true } }));
  targets.push({ targetId: 'no_opener', type: 'page', url: 'https://example.org/noopener' });
  assert.equal((await run('frame')).openedTab.id, 'no_opener');
  now += 1000; const f3 = await run('frame'); await run('click', { frame: f3.frame, x: 20, y: 30 }); now += 6001;
  targets.push({ targetId: 'late_popup', type: 'page', openerId: 'page_one', url: 'https://example.org/late' });
  assert.ok((await run('frame')).jpeg, 'expired click intent must not follow new tabs');
  while (targets.length < 100) targets.push({ targetId: 'tab_' + targets.length, type: 'page', url: 'https://example.org' });
  await assert.rejects(run('newTab', { url: 'https://example.org' }), /TAB_LIMIT/);
});

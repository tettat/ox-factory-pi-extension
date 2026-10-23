import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { createDesktopTickets } from './desktop-auth.mjs';
import { createBrowserTickets } from './browser-auth.mjs';
import { DesktopRoom, desktopTicket, authorizeDesktop } from './desktop-relay-core.mjs';
import { ServerFilter, ClientFilter, openVnc, RFB_BANNER, vncEncrypt } from './desktop-rfb.mjs';
import { vncIni } from './desktop-cli.mjs';
import { desktopTextKeys, desktopViewport } from './web/desktop.js';
function auth(){
  let time=Date.now();const state={devices:{device_desktop:{id:'device_desktop',credentialHash:'original',snapshot:{grants:{owner_desktop:'owner'}}}},sessions:{cookie:{id:'session',principalId:'owner_desktop',role:'owner',devices:['*'],expiresAt:time+1e8}}};
  const config={state,persist(){},now:()=>time,relay:'https://relay.example.com'},tickets=createDesktopTickets(config);
  return {state,tickets,advance:n=>time+=n,browser:createBrowserTickets(config),issue:mode=>({ticket:tickets.issue({kind:'phone',deviceId:'device_desktop',sessionId:'session',principalId:'owner_desktop',mode}).ticket,connectionId:randomUUID()})};
}
test('desktop text entry uses Unicode keysyms even for spaces/ASCII rather than the PC IME',()=>{
  assert.deepEqual(desktopTextKeys('A 中\r\n\t'),[0x01000041,0x01000020,0x01004e2d,0xff0d,0xff09]);
});
test('desktop portrait fits height with horizontal pan, without scrollable empty padding',()=>{
  const fit=desktopViewport(390,724,3840,2160),portrait=desktopViewport(390,724,3840,2160,fit.fitZoom);
  assert.equal(portrait.height,724);assert.ok(portrait.width>1200);assert.ok(portrait.padY<.001);
  const landscape=desktopViewport(844,300,3840,2160);assert.equal(landscape.fitZoom,1);assert.equal(landscape.height,300);assert.equal(landscape.width,844);
  const zoom=desktopViewport(390,724,3840,2160,8);assert.equal(zoom.padX,0);assert.equal(zoom.padY,0);
});
test('desktop tickets require their own audience, single binding and current view/control authorization',()=>{
  const f=auth(),body=f.issue('control');assert.equal(f.tickets.authorize(body).audience,'desktop');assert.equal(JSON.stringify(f.state).includes(body.ticket),false);
  assert.throws(()=>f.browser.authorize(body),/AUTH_FAILED/);
  const browser=f.browser.issue({kind:'agent',deviceId:'device_desktop',credentialHash:'original'});assert.throws(()=>f.tickets.authorize({...body,ticket:browser.ticket}),/AUTH_FAILED/);
  assert.throws(()=>f.tickets.authorize({...body,connectionId:randomUUID()}),/AUTH_FAILED/);
  f.state.sessions.cookie.role='viewer';assert.throws(()=>f.tickets.authorize(body),/AUTH_FAILED/);
  const view=f.issue('view');assert.equal(f.tickets.authorize(view).role,'viewer');
  f.state.devices.device_desktop.snapshot.grants={};assert.throws(()=>f.tickets.authorize(view),/AUTH_FAILED/);
});
test('desktop tickets expire, and session/device/credential changes revoke live leases',()=>{
  const f=auth(),late=f.issue('view');f.advance(60001);assert.throws(()=>f.tickets.authorize(late),/AUTH_FAILED/);
  const view=f.issue('view');f.tickets.authorize(view);f.state.sessions.cookie.revokedAt='now';assert.throws(()=>f.tickets.authorize(view),/AUTH_FAILED/);f.state.sessions.cookie.revokedAt=null;
  f.state.sessions.cookie.devices=['different_device'];assert.throws(()=>f.tickets.authorize(view),/AUTH_FAILED/);f.state.sessions.cookie.devices=['*'];
  const a={ticket:f.tickets.issue({kind:'agent',deviceId:'device_desktop',credentialHash:'original'}).ticket,connectionId:randomUUID()};f.tickets.authorize(a);f.state.devices.device_desktop.credentialHash='rotated';assert.throws(()=>f.tickets.authorize(a),/AUTH_FAILED/);
  f.advance(3600001);assert.throws(()=>f.tickets.authorize(view),/AUTH_FAILED/);
});
test('desktop authorizer never follows ticket redirects and rejects browser claims',async()=>{
  assert.equal(desktopTicket('ox-desktop-v1, t.'+'a'.repeat(43)),'a'.repeat(43));assert.throws(()=>desktopTicket('ox-browser-v1, t.'+'a'.repeat(43)));assert.throws(()=>desktopTicket('ox-desktop-v1, t.'+'a'.repeat(43)+', extra'));
  await assert.rejects(authorizeDesktop('https://hub.example.com','ticket',randomUUID(),async(url,init)=>{assert.equal(init.redirect,'manual');return new Response('',{status:302});}),/AUTH_FAILED/);
  const id=randomUUID();await assert.rejects(authorizeDesktop('https://hub.example.com','ticket',id,async()=>Response.json({kind:'phone',deviceId:'device_desktop',connectionId:id,leaseUntil:Date.now()+30000})),/AUTH_FAILED/);
});
function roomFixture(){
  let time=1000;const peers=[],room=new DesktopRoom({hub:'https://hub.example.com',peers:()=>peers,save(){},now:()=>time,authorize:async()=>{throw Error('revoked');}});
  function make(kind){const p={meta:{audience:'desktop',kind,deviceId:'device_desktop',connectionId:randomUUID(),principalId:'owner_desktop',role:kind==='phone'?'owner':'agent',mode:kind==='phone'?'view':null,leaseUntil:31000,expiresAt:1e6},ws:{readyState:1,output:[],send(m){this.output.push(typeof m==='string'?JSON.parse(m):Buffer.from(m));},close(code){this.readyState=3;this.code=code;}}};peers.push(p);return p;}
  return {peers,room,make,advance:n=>time+=n};
}
test('desktop relay separates peers, drops late frames and refuses silent takeover',()=>{
  const {room,make}=roomFixture(),agent=make('agent'),phone=make('phone');room.connect(agent);room.connect(phone);
  const other=make('phone');assert.equal(room.connect(other),false);assert.equal(other.ws.code,4409);
  room.receive(agent,JSON.stringify({type:'open',peer:phone.meta.connectionId,width:1280,height:720}));assert.equal(phone.ws.output.at(-1).type,'stream-ready');
  const frame=Buffer.concat([Buffer.from(phone.meta.connectionId),Buffer.from('frame')]);room.receive(agent,frame);assert.equal(phone.ws.output.at(-1).toString(),'frame');
  const before=phone.ws.output.length;room.receive(agent,Buffer.concat([Buffer.from(randomUUID()),Buffer.from('private old frame')]));assert.equal(phone.ws.output.length,before);
  room.receive(phone,Buffer.from([5,0,0,0,0,0]));assert.equal(agent.ws.output.at(-1).subarray(0,36).toString(),phone.meta.connectionId);
  room.receive(phone,JSON.stringify({type:'ack',received:99}));assert.equal(agent.ws.output.at(-1).peer,phone.meta.connectionId);
  phone.ws.close();room.disconnected(phone);assert.equal(agent.ws.output.at(-1).type,'leave');
  const next=make('phone');room.connect(next);const n=next.ws.output.length;room.receive(agent,frame);assert.equal(next.ws.output.length,n);
});
test('desktop relay expires revoked leases and limits oversized frames',async()=>{
  const f=roomFixture(),agent=f.make('agent'),phone=f.make('phone');f.room.connect(agent);f.room.connect(phone);f.advance(17000);await f.room.maintain();assert.equal(phone.ws.code,4401);assert.equal(agent.ws.code,4401);
  const g=roomFixture(),p=g.make('phone');g.room.connect(p);g.room.receive(p,new Uint8Array(65573));assert.equal(p.ws.code,4400);
});
const key=(n,down=true)=>{const b=Buffer.alloc(8);b[0]=4;b[1]=Number(down);b.writeUInt32BE(n,4);return b;};
test('local RFB filter blocks view-only input independently of noVNC UI and releases held input',()=>{
  const output=[];let control=false;const f=new ClientFilter({write:b=>output.push(Buffer.from(b)),canControl:()=>control});
  f.push(key(0xffe3));f.push(Buffer.from([5,1,0,50,0,60]));assert.equal(output.length,0);
  control=true;const bytes=key(0xffe3);for(const b of bytes)f.push(Buffer.from([b]));f.push(Buffer.from([5,1,0,50,0,60]));assert.equal(output.length,2);
  control=false;f.release();assert.equal(output.length,4);assert.equal(output[2][1],0);assert.equal(output[3][1],0);
  for(const type of [6,7,150,248,251,255])assert.throws(()=>new ClientFilter({write(){}}).push(Buffer.from([type])),/INPUT_REJECTED/);
});
test('local RFB filter strips unsafe encoding extensions, validates pixel formats and bounds input',()=>{
  const output=[],f=new ClientFilter({write:b=>output.push(b)}),enc=[16,0,0x574d5664,-223,-239,-258,-308,7],b=Buffer.alloc(4+4*enc.length);b[0]=2;b.writeUInt16BE(enc.length,2);enc.forEach((n,i)=>b.writeInt32BE(n,i*4+4));f.push(b);
  const result=output[0],accepted=[];for(let p=4;p<result.length;p+=4)accepted.push(result.readInt32BE(p));assert.deepEqual(accepted,[16,0,-223,-239]);
  assert.throws(()=>f.push(Buffer.alloc(65537)),/INPUT_LIMIT/);
  assert.throws(()=>new ClientFilter({write(){}}).push(Buffer.alloc(20)),/PIXEL_FORMAT/);
});
test('local RFB output strips clipboard across every packet boundary without corrupting images',()=>{
  const clip=Buffer.alloc(8);clip[0]=3;clip.writeUInt32BE(6,4);
  const update=Buffer.alloc(16);update.writeUInt16BE(1,2);update.writeUInt16BE(2,8);update.writeUInt16BE(1,10);update.writeInt32BE(0,12);
  const pixels=Buffer.from([0,1,2,3,4,5,6,7]),wire=Buffer.concat([clip,Buffer.from('secret'),update,pixels,Buffer.from([2])]),expected=Buffer.concat([update,pixels,Buffer.from([2])]);
  for(let split=1;split<wire.length;split++){const chunks=[],f=new ServerFilter(b=>chunks.push(b));f.push(wire.subarray(0,split));f.push(wire.subarray(split));assert.deepEqual(Buffer.concat(chunks),expected);}
  const chunks=[],f=new ServerFilter(b=>chunks.push(b));for(const b of wire)f.push(Buffer.from([b]));assert.deepEqual(Buffer.concat(chunks),expected);
});
test('RFB ZRLE and cursor payloads stream incrementally; unknown server extensions fail closed',()=>{
  const h=Buffer.alloc(16);h.writeUInt16BE(1,2);h.writeUInt16BE(2,8);h.writeUInt16BE(2,10);h.writeInt32BE(16,12);const n=Buffer.from([0,0,0,5]),data=Buffer.from([1,2,3,4,5]),output=[],f=new ServerFilter(b=>output.push(b));
  for(const b of Buffer.concat([h,n,data]))f.push(Buffer.from([b]));assert.deepEqual(Buffer.concat(output),Buffer.concat([h,n,data]));
  h.writeInt32BE(999,12);assert.throws(()=>new ServerFilter(()=>{}).push(h),/ENCODING_REJECTED/);
  assert.throws(()=>new ServerFilter(()=>{}).push(Buffer.from([7])),/SERVER_MESSAGE_REJECTED/);
});
test('VNC ini binds only loopback, keeps local input and disables web, files and logging',()=>{
  const ini=vncIni('fixture8',5907);for(const line of ['LoopbackOnly=1','AllowLoopback=1','AuthRequired=1','HTTPConnect=0','FileTransferEnabled=0','LocalInputsDisabled=0','UseIpv6=0','DebugMode=0','PortNumber=5907'])assert.ok(ini.includes(line));
  const encoded=ini.match(/passwd=([a-f0-9]+)/)[1];assert.equal(encoded.length,18);assert.ok(!ini.includes('fixture8'));
  const b=Buffer.from(encoded,'hex');assert.equal(b[8],b.subarray(0,8).reduce((a,b)=>a+b,0)&255);
});
test('RFB gateway authenticates locally but never sends local credentials to the phone',async t=>{
  const password='fixture8',challenge=Buffer.alloc(16,17),received=[];let tcp;
  const server=createServer(s=>{tcp=s;let stage=0,buf=Buffer.alloc(0);s.write(RFB_BANNER);
    s.on('data',b=>{buf=Buffer.concat([buf,b]);while(buf.length){const need=[12,1,16,1][stage]||0;if(!need){received.push(buf);buf=Buffer.alloc(0);break;}if(buf.length<need)return;const part=buf.subarray(0,need);buf=buf.subarray(need);stage++;
      if(stage===1){assert.deepEqual(part,RFB_BANNER);s.write(Buffer.from([1,2]));}
      if(stage===2){assert.equal(part[0],2);s.write(challenge);}
      if(stage===3){assert.deepEqual(part,vncEncrypt(challenge,Buffer.from(password)));s.write(Buffer.alloc(4));}
      if(stage===4){const h=Buffer.alloc(24);h.writeUInt16BE(640);h.writeUInt16BE(480,2);h[4]=32;h[5]=24;h[7]=1;h.writeUInt32BE(5,20);const clip=Buffer.alloc(8);clip[0]=3;clip.writeUInt32BE(2*1024*1024,4);s.write(Buffer.concat([h,Buffer.from('local'),clip,Buffer.alloc(2*1024*1024,115),Buffer.from([2])]));}
    }});
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{tcp?.destroy();await new Promise(r=>server.close(r));});
  const output=[],v=await openVnc({port:server.address().port,password,onData:b=>output.push(Buffer.from(b)),canControl:()=>false});t.after(()=>v.close());
  v.start();v.resume();await new Promise(r=>setTimeout(r,40));assert.equal(v.socket.isPaused(),true,'credit acknowledgements cannot resume an unfinished handshake');
  v.feed(Buffer.concat([RFB_BANNER,Buffer.from([1,1])]));assert.equal(v.width,640);assert.equal(v.height,480);
  assert.deepEqual(output[1],Buffer.from([1,1]));assert.ok(Buffer.concat(output).includes(Buffer.from('Ox Factory Desktop')));assert.ok(!Buffer.concat(output).includes(challenge));
  v.feed(key(0x61));for(let i=0;i<100&&!output.some(b=>b.length===1&&b[0]===2);i++)await new Promise(r=>setTimeout(r,10));assert.equal(received.length,0);assert.ok(output.some(b=>b.length===1&&b[0]===2),'large eager clipboard is discarded while later messages still arrive');assert.ok(Buffer.concat(output).length<200,'no clipboard content reaches the phone');v.close();
});

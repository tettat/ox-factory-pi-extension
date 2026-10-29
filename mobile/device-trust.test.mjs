import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { createMobileHub, initialState } from './hub.mjs';
import { token, hash } from './protocol.mjs';
import { peerAccess, trustKey } from './device-trust.mjs';

test('peer access defaults denied and requires same owner, explicit action and destination grant', () => {
  const a = { id: 'device_aaa', ownerPrincipalId: 'owner_aaa' };
  const b = { id: 'device_bbb', ownerPrincipalId: 'owner_aaa', snapshot: { grants: { owner_aaa: 'operator' } } };
  const s = { devices: { device_aaa: a, device_bbb: b }, deviceTrusts: {} };
  assert.throws(() => peerAccess(s, a.id, b.id, 'talk.send'));
  s.deviceTrusts[trustKey(a.id,b.id)] = { actions: ['talk.send'] };
  assert.equal(peerAccess(s,a.id,b.id,'talk.send').target,b);
  assert.throws(() => peerAccess(s,b.id,a.id,'talk.send'));
  assert.throws(() => peerAccess(s,a.id,b.id,'worker.detail'));
  b.snapshot.grants.owner_aaa = 'viewer';
  assert.throws(() => peerAccess(s,a.id,b.id,'talk.send'));
  b.snapshot.grants.owner_aaa = 'operator'; b.ownerPrincipalId = 'owner_other';
  assert.throws(() => peerAccess(s,a.id,b.id,'talk.send'));
});

test('two device relay: owner consent, idempotence, receipts, isolation and revocation', async t => {
  const listener = createServer(); await new Promise(r=>listener.listen(0,'127.0.0.1',r));
  const port = listener.address().port; await new Promise(r=>listener.close(r));
  const origin = `http://127.0.0.1:${port}`, principalId='owner_test', a='factory_aaa', b='factory_bbb';
  const secretA=token(),secretB=token(),code=token();
  const state=initialState({principalId,deviceId:a,deviceName:'A',deviceSecret:secretA,pairingCode:code});
  state.devices[b]={id:b,name:'B',ownerPrincipalId:principalId,credentialHash:hash(secretB),revokedAt:null};
  const hub=createMobileHub({stateStore:{read:()=>state,write:()=>{}},origin,allowInsecureLoopback:true});
  await new Promise(r=>hub.server.listen(port,'127.0.0.1',r));
  t.after(()=>new Promise(r=>hub.server.close(r)));
  async function request(path,body,headers={}) {
    const r=await fetch(origin+path,{method:'POST',headers:{'content-type':'application/json',origin,...headers},body:JSON.stringify(body)});
    return {status:r.status,data:await r.json(),headers:r.headers};
  }
  const login=await request('/api/login',{code,name:'owner'}); assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const me=await fetch(origin+'/api/me',{headers:{cookie}}).then(r=>r.json());
  const owner={cookie,'x-ox-csrf':me.csrf}, authA={authorization:`Bearer ${secretA}`},authB={authorization:`Bearer ${secretB}`};
  const snapshot={protocolVersion:1,observedAt:Date.now(),reachable:true,workers:[{id:'employee',name:'employee'}],jobs:[],tasks:[],requests:[],grants:{[principalId]:'owner'}};
  for(const auth of [authA,authB]) assert.equal((await request('/connector/sync',{version:1,results:[],snapshot},auth)).status,200);
  const envelope={id:'command_001',deviceId:b,action:'talk.send',body:{worker:'employee',message:'hello'},createdAt:Date.now()};
  assert.equal((await request('/connector/peer-command',envelope,authA)).status,403);
  const trust={sourceDeviceId:a,targetDeviceId:b,actions:['worker.detail','talk.send']};
  assert.equal((await request('/api/device-trusts',trust,{cookie})).status,403); // missing CSRF
  assert.equal((await request('/api/device-trusts',trust,owner)).status,200);
  assert.equal((await request('/connector/peer-command',envelope,authA)).status,202);
  assert.equal((await request('/connector/peer-command',envelope,authA)).status,200);
  assert.equal((await request('/connector/peer-command',{...envelope,body:{worker:'employee',message:'changed'}},authA)).status,409);
  assert.equal((await request('/connector/peer-result',{id:envelope.id},authB)).status,404);
  assert.equal((await request('/connector/peer-command',{...envelope,id:'command_002',deviceId:a},authB)).status,403);
  assert.equal((await request('/connector/peer-command',{...envelope,id:'command_003',action:'task.create',body:{title:'x'}},authA)).status,403);
  const delivered=await request('/connector/sync',{version:1,results:[]},authB);
  assert.equal(delivered.data.commands.length,1);
  const command=delivered.data.commands[0];
  assert.equal((await request('/connector/authorize',{id:command.id,deliveryToken:command.deliveryToken},authB)).status,200);
  await request('/connector/sync',{version:1,results:[{id:command.id,deliveryToken:command.deliveryToken,digest:command.digest,ok:true,data:{accepted:true}}]},authB);
  const receipt=await request('/connector/peer-result',{id:command.id},authA);
  assert.equal(receipt.data.command.state,'done'); assert.equal(receipt.data.command.result.data.accepted,true);
  const queued={...envelope,id:'command_004'};
  await request('/connector/peer-command',queued,authA);
  await request('/api/device-trusts',{...trust,actions:[]},owner);
  assert.equal(state.commands[queued.id].state,'failed');
  assert.equal((await request('/connector/sync',{version:1,results:[]},authB)).data.commands.length,0);
  assert.equal((await request('/connector/peer-command',{...envelope,id:'command_005'},authA)).status,403);
});

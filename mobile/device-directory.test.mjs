import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDeviceDirectory } from './device-directory.mjs';
test('directory exposes only same-owner granted devices and sanitized worker metadata', () => {
  const make=(id,owner='alice',granted=true)=>({id,name:id,ownerPrincipalId:owner,lastSeenAt:10000,credentialHash:'SECRET',snapshot:{reachable:true,grants:granted?{alice:'owner'}:{},jobs:[{secret:'SECRET'}],workers:[{name:'worker',model:'test',thinking:'max',password:'SECRET'}]}});
  const requester=make('self');
  const state={deviceTrusts:{'self:other':{actions:['worker.detail']}},devices:{self:requester,other:make('other'),foreign:make('foreign','bob'),hidden:make('hidden','alice',false),revoked:{...make('revoked'),revokedAt:'yes'}}};
  const d=buildDeviceDirectory(state,requester,20000);
  assert.deepEqual(d.devices.map(x=>x.id),['self','other']);
  assert.equal(d.localDeviceId,'self');
  assert.equal(d.devices[1].online,true);
  assert.equal(d.devices[1].workers[0].thinking,'max');
  assert.ok(!JSON.stringify(d).includes('SECRET'));
  assert.equal(buildDeviceDirectory(state,requester,50000).devices[1].online,false);
});

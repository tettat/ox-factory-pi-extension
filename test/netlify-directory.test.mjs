import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readNetlifyDirectory,mergeHubWorkers } from '../device-hub-client.mjs';
test('Netlify directory hides this factory and expires without extending stale state', () => {
  const root=mkdtempSync(join(tmpdir(),'ox-netlify-dir-'));
  try {
    const dir=join(root,'.pi','service','mobile-netlify-connector');mkdirSync(dir,{recursive:true});
    const configDir=join(root,'.pi','mobile-netlify');mkdirSync(configDir,{recursive:true});
    writeFileSync(join(configDir,'connector-config.json'),JSON.stringify({hub:'https://example.netlify.app',credential:'n'.repeat(43),workersDir:join(root,'.pi','workers'),stateDir:dir}));
    writeFileSync(join(dir,'hub-directory.json'),JSON.stringify({version:1,localDeviceId:'self',receivedAt:10000,hub:'https://example.netlify.app',devices:[{id:'self',workers:[{id:'local'}]},{id:'other',online:true,name:'另一台',workers:[{id:'local',model:'model',thinking:'max'}]}]}));
    const h=readNetlifyDirectory(join(root,'.pi','workers'),{now:20000});
    const workers=mergeHubWorkers([{name:'local'}],h);
    assert.equal(workers.length,2);assert.equal(workers[1].deviceId,'other');assert.equal(workers[1].nameCollision,true);assert.equal(workers[1].thinking,'max');
    assert.equal(readNetlifyDirectory(join(root,'.pi','workers'),{now:41000}),null);
  }finally{rmSync(root,{recursive:true,force:true});}
});

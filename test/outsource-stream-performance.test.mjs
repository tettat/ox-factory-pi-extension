import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { appendOutsourceRunEvent, getOutsourceRun, outsourceRunsFile } from '../outsource-agents.mjs';

test('stream append does zero ledger reads; default callers still receive full derived runs', () => {
  const dir=fs.mkdtempSync(join(tmpdir(),'outsource-stream-performance-'));
  const original=fs.readFileSync;
  const file=resolve(outsourceRunsFile(dir));
  let ledgerReads=0;
  try {
    appendOutsourceRunEvent(dir,{type:'run_created',runId:'fixture',id:'fixture',status:'queued',task:'fixture'});
    fs.readFileSync=function(path,...args) {
      if (typeof path==='string' && resolve(path)===file) ledgerReads++;
      return original.call(this,path,...args);
    };
    syncBuiltinESMExports();
    for(let i=0;i<200;i++) {
      const entry=appendOutsourceRunEvent(dir,{type:'stream',runId:'fixture',streamType:'text',text:`delta${i}`},{readBack:false});
      assert.equal(entry.runId,'fixture');
    }
    assert.equal(ledgerReads,0,'no shared ledger replay on stream callback');
    const result=appendOutsourceRunEvent(dir,{type:'running',runId:'fixture'});
    assert.equal(result.status,'running');assert.equal(result.events.length,202);
    assert.equal(ledgerReads,1,'default return contract preserved');
    const run=getOutsourceRun(dir,'fixture');
    assert.equal(run.events.filter(e=>e.type==='stream').length,200);
    assert.equal(run.events.at(-2).text,'delta199');
    const dispatcher=original(new URL('../outsource-dispatcher.mjs',import.meta.url),'utf8');
    assert.match(dispatcher,/isError: Boolean\(event.isError\),\s*\}, \{ readBack: false \}\)/);
  } finally {
    fs.readFileSync=original;syncBuiltinESMExports();fs.rmSync(dir,{recursive:true,force:true});
  }
});

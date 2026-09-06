import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {findMainSessionFile} from '../worker-registry-snapshot.mjs';

test('dashboard reads an explicitly configured persistent main session',()=>{
  const dir=mkdtempSync(join(tmpdir(),'ox-session-'));
  const previous=process.env.OX_FACTORY_MAIN_SESSION_FILE;
  try {
    const session=join(dir,'main.jsonl');
    writeFileSync(session,'');
    process.env.OX_FACTORY_MAIN_SESSION_FILE=session;
    assert.equal(findMainSessionFile(join(dir,'.pi','workers')),resolve(session));
    process.env.OX_FACTORY_MAIN_SESSION_FILE=join(dir,'missing.jsonl');
    assert.equal(findMainSessionFile(join(dir,'.pi','workers')),null);
  } finally {
    if(previous===undefined) delete process.env.OX_FACTORY_MAIN_SESSION_FILE;
    else process.env.OX_FACTORY_MAIN_SESSION_FILE=previous;
    rmSync(dir,{recursive:true,force:true});
  }
});

test('dashboard CLI starts with native OS paths and workers paths containing spaces',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ox web startup '));
  const workers=join(dir,'workers');
  mkdirSync(workers);
  const script=fileURLToPath(new URL('../web-server.mjs',import.meta.url));
  const child=spawn(process.execPath,[script,'--workers-dir',workers,'--port','0'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  try {
    await new Promise((resolve,reject)=>{
      let text='';
      const timer=setTimeout(()=>reject(new Error('dashboard did not start')),10000);
      child.on('error',error=>{clearTimeout(timer);reject(error);});
      child.on('exit',code=>{clearTimeout(timer);reject(new Error(`dashboard exited before startup: ${code}`));});
      child.stdout.on('data',data=>{
        text+=data.toString();
        if(text.includes('listen:')){clearTimeout(timer);resolve();}
      });
    });
  } finally {
    const stopped=new Promise(resolve=>child.once('exit',resolve));
    child.kill();
    if(child.exitCode===null && child.signalCode===null) await stopped;
    rmSync(dir,{recursive:true,force:true});
  }
});

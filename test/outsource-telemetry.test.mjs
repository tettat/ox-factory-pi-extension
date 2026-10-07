import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {CodexAppServerClient} from '../codex-backend.mjs';
import {runOutsourceCodexStreaming} from '../outsource-runner.mjs';
import {createOutsourceRun, completeOutsourceRun, getOutsourceRun} from '../outsource-agents.mjs';

function fakeCodex(t, {failAfterUsage=false}={}) {
  let notify;
  t.mock.method(globalThis,'fetch',async()=>({ok:true})); // readyz only; no live API
  t.mock.method(CodexAppServerClient.prototype,'connect',async()=>{});
  t.mock.method(CodexAppServerClient.prototype,'initialize',async()=>({}));
  t.mock.method(CodexAppServerClient.prototype,'close',()=>{});
  t.mock.method(CodexAppServerClient.prototype,'onNotification',handler=>{notify=handler;});
  t.mock.method(CodexAppServerClient.prototype,'request',async(method)=>{
    if(method==='thread/start')return {thread:{id:'synthetic-thread'}};
    if(method==='turn/start'){
      notify({method:'turn/started',params:{threadId:'synthetic-thread',turn:{id:'synthetic-turn'}}});
      const total={inputTokens:1000,cachedInputTokens:800,outputTokens:100,reasoningOutputTokens:60,totalTokens:1100};
      notify({method:'thread/tokenUsage/updated',params:{threadId:'synthetic-thread',turnId:'synthetic-turn',tokenUsage:{total,last:total}}});
      notify({method:'item/started',params:{threadId:'synthetic-thread',item:{id:'web',type:'webSearch'}}});
      // A mismatched turn's usage must never leak into the benchmark.
      notify({method:'thread/tokenUsage/updated',params:{threadId:'synthetic-thread',turnId:'other',tokenUsage:{total:{inputTokens:999999}}}});
      if(failAfterUsage)throw new Error('synthetic transport failure');
      queueMicrotask(()=>notify({method:'turn/completed',params:{threadId:'synthetic-thread',turn:{id:'synthetic-turn',status:'completed'}}}));
      return {turn:{id:'synthetic-turn'}};
    }
    throw new Error(`Unexpected fake request: ${method}`);
  });
}

test('outsource Codex emits cumulative live usage, raw billing fields, active turn and native audit items',async t=>{
  fakeCodex(t);
  const events=[];
  const result=await runOutsourceCodexStreaming({profile:{name:'fixture',model:'gpt-5.5',thinking:'low',codexServerUrl:'ws://127.0.0.1:1'},task:'fixture'},e=>events.push(e));
  assert.equal(result.exitCode,0);
  assert.equal(result.inputTokens,1000);assert.equal(result.totalTokens,1100);
  const usage=events.filter(e=>e.type==='usage');
  assert.equal(usage.length,1);assert.equal(usage[0].cachedInputTokens,800);
  assert.equal(usage[0].rawTokenUsage.last.inputTokens,1000);
  assert.equal(usage[0].tokenUsageSchema,'codex-inclusive-v1');
  assert.ok(events.some(e=>e.type==='codex_turn'&&e.turnId==='synthetic-turn'));
  assert.ok(events.some(e=>e.type==='codex_item'&&e.kind==='webSearch'));
});

test('outsource failure preserves spent tokens instead of resetting usage to zero',async t=>{
  fakeCodex(t,{failAfterUsage:true});
  const events=[];
  const result=await runOutsourceCodexStreaming({profile:{name:'fixture',model:'gpt-5.5',codexServerUrl:'ws://127.0.0.1:1'},task:'fixture'},e=>events.push(e));
  assert.equal(result.exitCode,1);assert.equal(result.inputTokens,1000);
  assert.equal(events.find(e=>e.type==='done').totalTokens,1100);
});

test('interrupt CLI enforces original requester and never forges a terminal lifecycle event',()=>{
  const directory=mkdtempSync(join(tmpdir(),'ox-interrupt-fixture-'));
  const cli=fileURLToPath(new URL('../outsource-cli.mjs',import.meta.url));
  try{
    const run=createOutsourceRun(directory,{profileName:'fixture',profileSnapshot:{name:'fixture',backend:'codex'},requestedBy:'owner',task:'fixture'});
    const call=who=>spawnSync(process.execPath,[cli,'interrupt','--run-id',run.id,'--from',who,'--workers-dir',directory],{encoding:'utf8',windowsHide:true,timeout:15000});
    const denied=call('not-owner');
    assert.equal(denied.status,1);assert.match(denied.stderr,/只能中断自己/);
    const unstarted=call('owner');
    assert.equal(unstarted.status,1);assert.match(unstarted.stderr,/活动 turn ID/);
    assert.equal(getOutsourceRun(directory,run.id).status,'queued');
    completeOutsourceRun(directory,{runId:run.id,summary:'fixture complete'});
    const terminal=call('owner');
    assert.equal(terminal.status,0);assert.match(terminal.stdout,/already terminal/);
  }finally{rmSync(directory,{recursive:true,force:true});}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {estimateApiCost, summarizeApiCosts, readApiPrices} from '../api-cost.mjs';
const price={input:10,cachedInput:1,output:50,source:'test',basis:'standard-short-context'};
const job={model:'test',tokenUsageSchema:'codex-inclusive-v1',inputTokens:1000,cachedInputTokens:800,outputTokens:100,reasoningOutputTokens:60,status:'done'};
test('cost subtracts cached input and never double counts reasoning output',()=>{
 const cost=estimateApiCost({...job,apiPrice:price});
 assert.equal(cost.status,'estimated'); assert.equal(cost.usd,0.0078);
});
test('unknown price, unknown semantics, invalid usage are never free',()=>{
 assert.equal(estimateApiCost(job,{}).status,'price_missing');
 assert.equal(estimateApiCost({...job,apiPrice:price,tokenUsageSchema:undefined}).status,'usage_unknown');
 for(const patch of [{cachedInputTokens:1001},{inputTokens:null},{outputTokens:NaN},{outputTokens:-1}])
  assert.equal(estimateApiCost({...job,apiPrice:price,...patch}).usd,null);
});

test('legacy Codex jobs with persisted thread ids can be conservatively estimated',()=>{
 const legacy={...job,apiPrice:price,tokenUsageSchema:undefined,codexThreadId:'thread-1',codexTurnId:'turn-1'};
 const cost=estimateApiCost(legacy,{});
 assert.equal(cost.status,'estimated');
 assert.equal(cost.usd,0.0078);
 assert.equal(cost.legacyInferred,true);
});
test('snapshots override changed prices and running usage is provisional',()=>{
 const cost=estimateApiCost({...job,status:'running',apiPrice:price},{test:{...price,input:100}});
 assert.equal(cost.usd,0.0078); assert.equal(cost.provisional,true);
 const rows=summarizeApiCosts([{...job,apiPrice:price},{...job,model:'missing'}],{});
 assert.equal(rows.pricedJobs,1); assert.equal(rows.unpricedJobs,1); assert.equal(rows.usd,0.0078);
});

test('prices reload from isolated config and malformed config fails closed', async()=>{
 const {mkdtempSync,mkdirSync,writeFileSync,rmSync}=await import('node:fs');
 const {tmpdir}=await import('node:os'); const {join}=await import('node:path');
 const dir=mkdtempSync(join(tmpdir(),'ox-prices-'));
 try {
  assert.ok(readApiPrices(dir)['gpt-6-astra']);
  mkdirSync(join(dir,'config'));
  const file=join(dir,'config','api-prices.json');
  writeFileSync(file,JSON.stringify({models:{test:price}}));
  assert.deepEqual(readApiPrices(dir),{test:price});
  writeFileSync(file,'invalid'); assert.deepEqual(readApiPrices(dir),{});
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('job detail and model reports expose identical estimates without touching live factory', async()=>{
 const {mkdtempSync,rmSync}=await import('node:fs');
 const {tmpdir}=await import('node:os'); const {join}=await import('node:path');
 const {createServer}=await import('node:http');
 const {createJob,updateJob}=await import('../jobs.mjs');
 const {buildRouter}=await import('../web-server.mjs');
 const {buildFactoryQualityReport}=await import('../quality-metrics.mjs');
 const dir=mkdtempSync(join(tmpdir(),'ox-cost-api-'));
 const server=createServer(buildRouter({workersDir:dir}));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const record=createJob(dir,{worker:'test',task:'cost fixture'});
  updateJob(record,{...job,apiPrice:price});
  const detail=await (await fetch(`http://127.0.0.1:${server.address().port}/api/jobs/${record.id}?markRead=0`)).json();
  assert.equal(detail.apiCost.usd,0.0078);
  const report=buildFactoryQualityReport({workersDir:dir,date:'all'});
  assert.equal(report.apiCost.usd,0.0078);
  assert.equal(report.models[0].apiCost.usd,0.0078);
  assert.equal(report.costByWorker[0].usd,0.0078);
 }finally{await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});}
});

test('token report endpoint exposes same-day API cost estimates', async()=>{
 const {mkdtempSync,rmSync}=await import('node:fs');
 const {tmpdir}=await import('node:os'); const {join}=await import('node:path');
 const {createServer}=await import('node:http');
 const {createJob,updateJob}=await import('../jobs.mjs');
 const {buildRouter}=await import('../web-server.mjs');
 const dir=mkdtempSync(join(tmpdir(),'ox-token-cost-api-'));
 const server=createServer(buildRouter({workersDir:dir}));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const included=createJob(dir,{worker:'test',task:'cost fixture'});
  updateJob(included,{...job,apiPrice:price,createdAt:'2026-09-07T02:00:00.000Z'});
  const excluded=createJob(dir,{worker:'test',task:'old cost fixture'});
  updateJob(excluded,{...job,apiPrice:price,createdAt:'2026-09-06T02:00:00.000Z'});
  const report=await (await fetch(`http://127.0.0.1:${server.address().port}/api/tokens?date=2026-09-07`)).json();
  assert.equal(report.apiCost.usd,0.0078);
  assert.equal(report.apiCost.pricedJobs,1);
  assert.equal(report.costByWorker[0].worker,'test');
  assert.equal(report.costByWorker[0].usd,0.0078);
 }finally{await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});}
});

test('explicit zero usage is zero but invalid or absent rates remain unknown',()=>{
 const zero=estimateApiCost({...job,apiPrice:price,inputTokens:0,cachedInputTokens:0,outputTokens:0});
 assert.equal(zero.usd,0);
 for(const rate of [null,-1,Infinity,'10'])
  assert.equal(estimateApiCost({...job,apiPrice:{...price,input:rate}}).status,'price_missing');
 assert.equal(summarizeApiCosts([job],{}).usd,null);
});

test('Codex cumulative updates do not accumulate the same usage notification twice', async()=>{
 const {createCodexTokenUsageTracker}=await import('../codex-backend.mjs');
 const tracker=createCodexTokenUsageTracker();
 const event={turnId:'t',tokenUsage:{total:{inputTokens:1000,cachedInputTokens:800,outputTokens:100},last:{inputTokens:1000,cachedInputTokens:800,outputTokens:100}}};
 const first=tracker.remember(event,'t');
 const second=tracker.remember(event,'t');
 assert.deepEqual(first,second);
 assert.equal(estimateApiCost({...job,...second,apiPrice:price}).usd,0.0078);
});

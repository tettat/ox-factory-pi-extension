import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeModelExecution } from '../model-execution-stats.mjs';
test('models use execution timestamps, median, and independent token denominators', () => {
 const jobs = [10,30,80].map((seconds,i)=>({model:'a',status:'done',createdAt:'2026-09-01T00:00:00Z',startedAt:'2026-09-01T01:00:00Z',finishedAt:new Date(Date.parse('2026-09-01T01:00:00Z')+seconds*1000).toISOString(),inputTokens:i?undefined:100,outputTokens:20}));
 jobs.push({model:'a',status:'done'}, {model:'a',status:'running'}, {model:'b',status:'failed'});
 const [a,b]=summarizeModelExecution(jobs);
 assert.equal(a.completed,4); assert.equal(a.durationSamples,3); assert.equal(a.missingDuration,1);
 assert.equal(a.avgDurationMs,40000); assert.equal(a.medianDurationMs,30000);
 assert.equal(a.tokens.inputTokens.average,100); assert.equal(a.tokens.inputTokens.samples,1);
 assert.equal(b.avgDurationMs,null);
});
test('invalid timestamps, steer, missing model and token values are explicit', () => {
 const [row]=summarizeModelExecution([{status:'done',elapsedSeconds:5,inputTokens:null},{status:'done',deliveryMode:'steer',startedAt:'2026-01-01',finishedAt:'2026-01-02'},{status:'done',startedAt:'2026-01-02',finishedAt:'2026-01-01',inputTokens:-1}]);
 assert.equal(row.model,'未记录模型'); assert.equal(row.durationSamples,0); assert.equal(row.excludedSteer,1); assert.equal(row.tokens.inputTokens.average,null);
});

test('quality API report includes model aggregation independently of output quality', async () => {
 const {mkdtempSync,rmSync} = await import('node:fs');
 const {tmpdir} = await import('node:os');
 const {join} = await import('node:path');
 const {createJob,updateJob} = await import('../jobs.mjs');
 const {buildFactoryQualityReport} = await import('../quality-metrics.mjs');
 const dir=mkdtempSync(join(tmpdir(),'ox-model-stats-'));
 try {
  const job=createJob(dir,{worker:'test',task:'test'});
  updateJob(job,{status:'done',model:'test-model',startedAt:'2026-09-07T00:00:00Z',finishedAt:'2026-09-07T00:00:12Z',inputTokens:20});
  const report=buildFactoryQualityReport({workersDir:dir,date:'all'});
  assert.equal(report.models[0].model,'test-model');
  assert.equal(report.models[0].avgDurationMs,12000);
 } finally {rmSync(dir,{recursive:true,force:true});}
});

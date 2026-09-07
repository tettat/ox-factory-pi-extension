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

test('empty history produces no invented model rows', () => {
  assert.deepEqual(summarizeModelExecution(), []);
});

test('even median includes legitimate zero-duration tasks and ignores elapsedSeconds', () => {
  const start = '2026-09-07T01:00:00Z';
  const rows = [0, 10, 20, 90].map(seconds => ({
    model: 'model-a', status: 'done', startedAt: start,
    finishedAt: new Date(Date.parse(start) + seconds * 1000).toISOString(),
    elapsedSeconds: 99999,
  }));
  const snapshot = structuredClone(rows);
  const [stats] = summarizeModelExecution(rows);
  assert.equal(stats.avgDurationMs, 30000);
  assert.equal(stats.medianDurationMs, 15000);
  assert.equal(stats.durationSamples, 4);
  assert.deepEqual(rows, snapshot, 'aggregation must not mutate job metadata');
});

test('only completed non-steer jobs contribute tokens; each field has its own denominator', () => {
  const rows = [
    {status: 'done', inputTokens: 0, outputTokens: 20, cachedInputTokens: 100, totalWithCachedTokens: 120},
    {status: 'done', inputTokens: 100, outputTokens: null, cachedInputTokens: 0},
    {status: 'done', inputTokens: '500', outputTokens: NaN, cachedInputTokens: Infinity},
    {status: 'done', inputTokens: -1},
    ...['running', 'queued', 'failed', 'aborted', 'stale'].map(status => ({status, inputTokens: 999999})),
    {status: 'done', deliveryMode: 'steer', inputTokens: 999999},
  ];
  const [stats] = summarizeModelExecution(rows);
  assert.equal(stats.completed, 5);
  assert.equal(stats.excludedSteer, 1);
  assert.deepEqual(stats.tokens.inputTokens, {average: 50, samples: 2, missing: 2});
  assert.deepEqual(stats.tokens.outputTokens, {average: 20, samples: 1, missing: 3});
  assert.deepEqual(stats.tokens.cachedInputTokens, {average: 50, samples: 2, missing: 2});
  assert.deepEqual(stats.tokens.totalWithCachedTokens, {average: 120, samples: 1, missing: 3});
});

test('model groups cross workers without conflating different recorded model IDs', () => {
  const stats = summarizeModelExecution([
    {model: ' model-a ', worker: 'one', status: 'done'},
    {model: 'model-a', worker: 'two', status: 'done'},
    {model: 'model-b', worker: 'one', status: 'done'},
    {model: ' ', status: 'done'},
  ]);
  assert.equal(stats.length, 3);
  assert.equal(stats.find(row => row.model === 'model-a').completed, 2);
  assert.equal(stats.find(row => row.model === 'model-b').completed, 1);
  assert.equal(stats.find(row => row.model === '未记录模型').completed, 1);
});

test('invalid and missing timestamps never fall back to queue time or heartbeat', () => {
  const start = '2026-09-07T01:00:00Z';
  const [stats] = summarizeModelExecution([
    {status: 'done', startedAt: 'invalid', finishedAt: start},
    {status: 'done', startedAt: start, finishedAt: 'invalid'},
    {status: 'done', createdAt: start, finishedAt: start},
    {status: 'done', startedAt: start, updatedAt: start},
  ]);
  assert.equal(stats.missingDuration, 4);
  assert.equal(stats.durationSamples, 0);
  assert.equal(stats.medianDurationMs, null);
  assert.equal(stats.avgDurationMs, null);
});

test('quality model statistics honor date and worker filters', async () => {
  const {mkdtempSync, rmSync} = await import('node:fs');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const {createJob, updateJob} = await import('../jobs.mjs');
  const {buildFactoryQualityReport} = await import('../quality-metrics.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'ox-model-filter-'));
  try {
    for (const [worker, day, model] of [['one', 7, 'included'], ['two', 7, 'other-worker'], ['one', 6, 'other-day']]) {
      const job = createJob(dir, {worker, task: 'fixture'});
      // Local noon deliberately avoids timezone-boundary ambiguity.
      const start = new Date(2026, 8, day, 12).toISOString();
      updateJob(job, {status: 'done', model, createdAt: start, startedAt: start,
        finishedAt: new Date(Date.parse(start) + 1000).toISOString()});
    }
    const filtered = buildFactoryQualityReport({workersDir: dir, date: '2026-09-07', worker: 'one'});
    assert.deepEqual(filtered.models.map(row => row.model), ['included']);
    const all = buildFactoryQualityReport({workersDir: dir, date: 'all'});
    assert.equal(all.models.length, 3);
    const empty = buildFactoryQualityReport({workersDir: dir, date: '2026-09-08'});
    assert.deepEqual(empty.models, []);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

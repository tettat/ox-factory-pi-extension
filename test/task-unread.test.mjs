import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildWorkerJobUnreadSummary, markWebJobRead } from '../web-job-read.mjs';

test('employee badge counts ended tasks, not streaming events or running jobs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'task-unread-'));
  try {
    const eventFile = join(dir, 'events.jsonl');
    writeFileSync(eventFile, Array.from({length: 30}, () => JSON.stringify({type:'text', time:'2026-09-11'})).join('\n'));
    const active = {id:'active', worker:'A', status:'running', eventFile};
    const done = {id:'done', worker:'A', status:'done', eventFile};
    const summary = () => buildWorkerJobUnreadSummary(dir, [active, done]).byWorker.get('A');
    assert.equal(summary().finishedUnreadJobs, 1);
    assert.equal(summary().activeJobs, 1);
    markWebJobRead(dir, done);
    assert.equal(summary().finishedUnreadJobs, 0);
    markWebJobRead(dir, active);
    active.status = 'done';
    assert.equal(summary().finishedUnreadJobs, 1, 'completion after reading a stream is a new unread result');
    markWebJobRead(dir, active);
    assert.equal(summary().finishedUnreadJobs, 0);
  } finally { rmSync(dir, {recursive:true, force:true}); }
});

test('all terminal states notify even without events; queued is not typing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'task-unread-'));
  try {
    const jobs = ['done','failed','aborted','stale','queued','running','orphan-running'].map(status => ({id:status, worker:'A', status}));
    const state = buildWorkerJobUnreadSummary(dir, jobs).byWorker.get('A');
    assert.equal(state.finishedUnreadJobs, 4);
    assert.equal(state.activeJobs, 2);
    assert.equal(state.queuedJobs, 1);
    for (const job of jobs) markWebJobRead(dir, job);
    assert.equal(buildWorkerJobUnreadSummary(dir, jobs).byWorker.get('A').finishedUnreadJobs, 0);
  } finally { rmSync(dir, {recursive:true, force:true}); }
});

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { buildWorkersView } from '../web-server.mjs';
import { markWorkerJobsRead } from '../web-job-read.mjs';

test('worker API view exposes separate task counts; bulk reading clears eventless results', () => {
  const dir = mkdtempSync(join(tmpdir(), 'task-unread-api-'));
  try {
    const jobs = [{id:'1', worker:'A', status:'done'}, {id:'2', worker:'A', status:'running'}];
    const worker = buildWorkersView(dir, jobs, {workers:[]}, [], new Map([['A', {}]])).find(w => w.name === 'A');
    assert.equal(worker.finishedUnreadJobs, 1);
    assert.equal(worker.activeJobs, 1);
    assert.equal(worker.queuedJobs, 0);
    markWorkerJobsRead(dir, jobs);
    assert.equal(buildWorkersView(dir, jobs, {workers:[]}, [], new Map([['A', {}]])).find(w => w.name === 'A').finishedUnreadJobs, 0);
  } finally { rmSync(dir, {recursive:true, force:true}); }
});

test('worker preview distinguishes running, queued, completed unread, failures and idle', () => {
  const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  const fn = source.match(/  function workerCardTalkPreviewText\(worker\) \{[\s\S]*?\n  \}/)[0];
  const preview = vm.runInNewContext(`(${fn.trim()})`);
  assert.equal(preview({activeJobs:1, finishedUnreadJobs:5}), '正在输入…');
  assert.equal(preview({queuedJobs:1}), '等待执行…');
  assert.match(preview({finishedUnreadJobs:2}), /^已结束/);
  assert.match(preview({lastJob:{status:'failed'}}), /^任务失败/);
  assert.match(preview({lastJob:{status:'aborted'}}), /^已停止/);
  assert.equal(preview({lastTalkReply:{contentPreview:'old result'}}), 'old result');
  assert.equal(preview({lastTalkReply:{contentPreview:'   '}}), '');
  assert.equal(preview({status:'vacation'}), '休假中');
});


test('worker status dot renders without a hidden free worker variable', () => {
  const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  const fn = source.match(/  function workerStatusDot\(status, activeJobs = 0\) \{[\s\S]*?\n  \}/)[0];
  const workerStatusDot = vm.runInNewContext(`const el=(tag, props)=>({tag, props}); (${fn.trim()})`);
  const idle = workerStatusDot('idle');
  assert.equal(idle.tag, 'span');
  assert.equal(idle.props.class, 'dot dot--idle');
  assert.equal(idle.props.title, 'idle');
  const busy = workerStatusDot('idle', 1);
  assert.equal(busy.props.class, 'dot dot--busy');
});

test('API ranking prioritizes unread results then running workers over recent idle workers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'task-unread-rank-'));
  try {
    const jobs = [
      {id:'done',worker:'Done',status:'done',updatedAt:'2026-01-01'},
      {id:'run',worker:'Running',status:'running',updatedAt:'2026-01-02'},
      {id:'idle',worker:'Idle',status:'done',updatedAt:'2026-09-01'},
    ];
    markWebJobRead(dir, jobs[2]);
    const registry = new Map(jobs.map(j => [j.worker, {}]));
    assert.deepEqual(buildWorkersView(dir, jobs, {workers:[]}, [], registry).map(w => w.name), ['Done','Running','Idle']);
  } finally { rmSync(dir, {recursive:true, force:true}); }
});

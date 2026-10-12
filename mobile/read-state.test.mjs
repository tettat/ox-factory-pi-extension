import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createReadState } from './read-state.mjs';
import { createJob, appendJobEvent, updateJob } from '../jobs.mjs';
import { markWebJobRead, readWebJobReadState, buildWorkerJobUnreadSummary, webJobReadFile } from '../web-job-read.mjs';
import { listMessages, markMessageRead, sendAuthorizedMessage } from '../comm.mjs';
import { validateAction } from './protocol.mjs';

function fixture(t) {
  const workersDir = mkdtempSync(join(tmpdir(), 'ox-read-sync-'));
  t.after(() => rmSync(workersDir, { recursive: true, force: true }));
  let clock = Date.now();
  const state = createReadState({ workersDir, now: () => clock });
  const scope = { worker: '员工', principalId: 'phone_owner', canMark: true };
  let job = createJob(workersDir, { worker: scope.worker, task: 'read fixture', cwd: workersDir });
  appendJobEvent(job, { type: 'text', text: '第一条回复' });
  job = updateJob(job, { status: 'done', summary: '第一条回复' });
  const capture = (js = [job], ms = []) => state.capture(js, ms, scope);
  const mark = tokens => state.mark(tokens, { ...scope, jobs: [job] });
  const unread = () => buildWorkerJobUnreadSummary(workersDir, [job]).byJob.get(job.id).unread;
  return { state, workersDir, scope, job, capture, mark, unread, advance: n => { clock += n; } };
}
test('phone snapshot and desktop use one read ledger; desktop reads flow back without mobile writes', t => {
  const f = fixture(t), r = f.capture().jobStates.get(f.job.id);
  assert.equal(r.unread, true); assert.ok(r.token);
  assert.deepEqual(f.mark([r.token]), [r.revision]); assert.equal(f.unread(), false);
  assert.equal(f.capture().jobStates.get(f.job.id).unread, false);
  const first = readFileSync(webJobReadFile(f.workersDir), 'utf8'); f.mark([r.token]);
  assert.equal(readFileSync(webJobReadFile(f.workersDir), 'utf8'), first);
  appendJobEvent(f.job, { type: 'text', text: 'PC 读到的新消息' });
  markWebJobRead(f.workersDir, f.job);
  assert.equal(f.capture().jobStates.get(f.job.id).unread, false);
});
test('late phone acknowledgement leaves unseen newer events unread, even before job metadata updates', t => {
  const f = fixture(t), old = f.capture().jobStates.get(f.job.id);
  appendJobEvent(f.job, { type: 'text', text: '没有显示过的新消息' }); f.advance(5000);
  f.mark([old.token]); assert.equal(f.unread(), true);
  assert.equal(readWebJobReadState(f.workersDir).get(f.job.id).eventOffset, 1);
  const fresh = f.capture().jobStates.get(f.job.id); assert.notEqual(fresh.revision, old.revision);
  f.mark([fresh.token]); assert.equal(f.unread(), false);
});
test('old cached receipt cannot undo a more recent desktop read', t => {
  const f = fixture(t), old = f.capture().jobStates.get(f.job.id);
  appendJobEvent(f.job, { type: 'text', text: 'PC 已读的新回复' }); markWebJobRead(f.workersDir, f.job);
  const first = readFileSync(webJobReadFile(f.workersDir), 'utf8');
  f.mark([old.token]); assert.equal(readFileSync(webJobReadFile(f.workersDir), 'utf8'), first); assert.equal(f.unread(), false);
});
test('same-offset terminal transition can be read but an old running receipt cannot revert it', t => {
  const f = fixture(t), running = { ...f.job, status: 'running' };
  const old = f.capture([running]).jobStates.get(f.job.id); f.mark([old.token]);
  const done = f.capture().jobStates.get(f.job.id); f.mark([done.token]);
  assert.equal(readWebJobReadState(f.workersDir).get(f.job.id).status, 'done');
  f.mark([old.token]); assert.equal(readWebJobReadState(f.workersDir).get(f.job.id).status, 'done');
});
test('receipts reject forgery, cross-worker/principal, expired views and partial bad batches', t => {
  const f = fixture(t), r = f.capture().jobStates.get(f.job.id);
  for (const token of [r.token + '.extra', r.token.replace(/.$/, '!'), r.token.split('.')[0] + '.' + '你'.repeat(43)]) assert.throws(() => f.mark([token]), /READ_RECEIPT_INVALID/);
  assert.throws(() => f.state.mark([r.token], { ...f.scope, worker: '另一个员工', jobs: [f.job] }), /SCOPE/);
  assert.throws(() => f.state.mark([r.token], { ...f.scope, principalId: 'other_phone', jobs: [f.job] }), /SCOPE/);
  assert.throws(() => f.mark([r.token, 'bad.receipt']), /INVALID/); assert.equal(f.unread(), true);
  f.advance(600001); assert.throws(() => f.mark([r.token]), /EXPIRED/);
});
test('viewer gets status only, and only incoming visible message IDs receive read receipts', t => {
  const f = fixture(t);
  const message = sendAuthorizedMessage(f.workersDir, { from: '用户', to: '员工', content: '信件' });
  const ms = listMessages(f.workersDir, { worker: '员工', includeSent: true });
  const reads = f.capture([], [...ms, { id: 'sent', from: '员工', to: '其他员工' }]);
  assert.equal(reads.messageStates.has('sent'), false);
  const r = reads.messageStates.get(message.id); assert.equal(r.unread, true); f.mark([r.token]);
  assert.equal(listMessages(f.workersDir, { worker: '员工' })[0].read, true);
  markMessageRead(f.workersDir, { worker: '员工', messageId: message.id });
  assert.equal(f.capture([], listMessages(f.workersDir, { worker: '员工' })).messageStates.get(message.id).unread, false);
  const view = f.state.capture([f.job], ms, { ...f.scope, canMark: false });
  assert.equal(view.jobStates.get(f.job.id).token, undefined); assert.equal(view.messageStates.get(ms[0].id).token, undefined);
});
test('read protocol limits batches and never accepts a path or arbitrary cursor', () => {
  assert.throws(() => validateAction('read.mark', { worker: '../x', tokens: ['x'] }));
  for (const tokens of [[], ['x', 'x'], ['x'.repeat(2049)], Array.from({ length: 41 }, (_, i) => String(i))]) assert.throws(() => validateAction('read.mark', { worker: '员工', tokens }));
  assert.throws(() => validateAction('read.mark', { worker: '员工', tokens: ['x'], eventOffset: 999 }));
});

test('one history receipt covers rows outside the phone window without acknowledging later arrivals', t => {
  const f = fixture(t), jobs = [f.job];
  for (let i = 0; i < 34; i++) {
    const j = createJob(f.workersDir, { worker: f.scope.worker, task: 'history ' + i, cwd: f.workersDir });
    appendJobEvent(j, { type: 'text', text: '历史回复' }); jobs.push(updateJob(j, { status: 'done' }));
  }
  for (let i = 0; i < 105; i++) sendAuthorizedMessage(f.workersDir, { from: '用户', to: f.scope.worker, content: '历史信件 ' + i });
  const ms = listMessages(f.workersDir, { worker: f.scope.worker, limit: 100000 });
  const r = f.state.captureHistory(jobs, ms, f.scope);
  assert.equal(r.unread, true); assert.ok(r.token.length < 2048);
  assert.equal(buildWorkerJobUnreadSummary(f.workersDir, jobs).byWorker.get(f.scope.worker).unreadJobs, 35);
  const late = sendAuthorizedMessage(f.workersDir, { from: '用户', to: f.scope.worker, content: '打开之后才到达' });
  appendJobEvent(jobs[0], { type: 'text', text: '后来追加的回复' });
  assert.deepEqual(f.state.mark([r.token], { ...f.scope, jobs }), [r.revision]);
  assert.equal(buildWorkerJobUnreadSummary(f.workersDir, jobs).byWorker.get(f.scope.worker).unreadJobs, 1);
  assert.deepEqual(listMessages(f.workersDir, { worker: f.scope.worker, limit: 100000 }).filter(m => !m.read).map(m => m.id), [late.id]);
  const fresh = f.state.captureHistory(jobs, listMessages(f.workersDir, { worker: f.scope.worker, limit: 100000 }), f.scope);
  f.state.mark([fresh.token], { ...f.scope, jobs });
  assert.deepEqual(f.state.captureHistory(jobs, listMessages(f.workersDir, { worker: f.scope.worker, limit: 100000 }), f.scope), { unread: false });
});

test('history capture is read-only, scoped, bounded and expires after ten minutes', t => {
  const f = fixture(t), r = f.state.captureHistory([f.job], [], f.scope);
  assert.equal(f.unread(), true);
  assert.equal(f.state.captureHistory([f.job], [], { ...f.scope, canMark: false }), null);
  assert.throws(() => f.state.mark([r.token], { ...f.scope, principalId: 'different', jobs: [f.job] }), /SCOPE/);
  assert.throws(() => f.state.mark([r.token], { ...f.scope, worker: '别的员工', jobs: [f.job] }), /SCOPE/);
  for (let i = 0; i < 9; i++) { appendJobEvent(f.job, { type: 'text', text: 'revision ' + i }); f.state.captureHistory([f.job], [], f.scope); }
  assert.throws(() => f.mark([r.token]), /EXPIRED/);
  const latest = f.state.captureHistory([f.job], [], f.scope); f.advance(600001);
  assert.throws(() => f.mark([latest.token]), /EXPIRED/); assert.equal(f.unread(), true);
});

test('read-history is explicit and boolean; legacy read-only views remain compatible', () => {
  assert.deepEqual(validateAction('worker.detail', { worker: '员工' }), { worker: '员工' });
  assert.deepEqual(validateAction('worker.detail', { worker: '员工', readHistory: true }), { worker: '员工', readHistory: true });
  for (const value of ['true', 1, null, {}]) assert.throws(() => validateAction('job.detail', { jobId: 'a-job', readHistory: value }), /INVALID_READ_HISTORY/);
});

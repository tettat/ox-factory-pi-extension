import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { conversationRevision, conversationCandidates, prefetchDue, detailBehindSnapshot } from './web/prefetch.js';
const worker = { id: 'worker-a', status: 'idle', unreadCount: 1, lastInteractionAt: '2026-01-01' };
const device = () => ({ id: 'device-a', online: true, snapshot: { observedAt: 'old', workers: [{ ...worker }], jobs: [], requests: [] } });
test('conversation revision ignores device heartbeats and token counters, but detects replies and new requests', () => {
  const d = device(), w = d.snapshot.workers[0], before = conversationRevision(d, w);
  d.snapshot.observedAt = 'new'; w.tokenToday = { total: 123 }; assert.equal(conversationRevision(d, w), before);
  w.lastTalkReply = { updatedAt: '2026-01-02', contentPreview: 'new' }; assert.notEqual(conversationRevision(d, w), before);
  const after = conversationRevision(d, w); d.snapshot.requests.push({ id: 'r', to: w.id, createdAt: '2026-01-03' }); assert.notEqual(conversationRevision(d, w), after);
});
test('unrelated employees and snapshot ordering do not invalidate a conversation', () => {
  const d = device(); d.snapshot.jobs = [{ id: 'a', worker: worker.id, status: 'done' }, { id: 'b', worker: worker.id, status: 'done' }];
  const before = conversationRevision(d, worker); d.snapshot.jobs.reverse(); d.snapshot.jobs.push({ id: 'other', worker: 'someone-else', status: 'running' });
  assert.equal(conversationRevision(d, worker), before);
});
test('prefetch includes unread employees on other devices, ignores offline and empty never-used conversations', () => {
  const a = device(), b = device(), c = device(); b.id = 'device-b'; c.id = 'offline'; c.online = false;
  a.snapshot.workers.push({ id: 'unused', status: 'idle' });
  const found = conversationCandidates([a, b, c], { selected: a.id });
  assert.equal(found.length, 2); assert.deepEqual(found.map(c => c.deviceId), ['device-a', 'device-b']);
});
test('current and unread conversations are prioritized; old historical activity alone is not warmed', () => {
  const d = device(); d.snapshot.workers.push({ id: 'current', status: 'idle' }, { id: 'history', lastInteractionAt: '2026-12-12' });
  assert.deepEqual(conversationCandidates([d], { selected: d.id, openedWorker: 'current' }).map(c => c.worker), ['current', 'worker-a']);
});
test('completed revisions do not refetch; busy conversations refresh at a bounded cadence and failures back off', () => {
  const c = { revision: 'a', active: false }, r = { revision: 'a', at: 100000 };
  assert.equal(prefetchDue(r, c, 200000), false);
  assert.equal(prefetchDue(r, { ...c, revision: 'b' }, 200000), true);
  assert.equal(prefetchDue(r, { ...c, active: true }, 159999), false);
  assert.equal(prefetchDue(r, { ...c, active: true }, 160000), true);
  assert.equal(prefetchDue({ retryAt: 210000 }, c, 200000), false);
  assert.equal(prefetchDue({ attemptAt: 199999 }, c, 200000), false);
});

test('visible push notifications also hint open clients to refresh without forwarding private payloads', async () => {
  const events = {}, notifications = [], messages = [];
  const c = vm.createContext({ importScripts() {}, self: {
    OX_MARKUP_ASSETS: [], addEventListener: (name, callback) => { events[name] = callback; },
    registration: { showNotification: async (...args) => { notifications.push(args); } },
    clients: { matchAll: async () => [{ postMessage: message => messages.push(message) }] },
  } });
  vm.runInContext(readFileSync(new URL('./web/sw.js', import.meta.url), 'utf8'), c);
  let pending;
  events.push({ data: { json: () => ({ title: 'private-name', text: 'private-text' }) }, waitUntil: promise => { pending = promise; } });
  await pending;
  assert.equal(notifications.length, 1); assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'ox-content-changed');
  assert.doesNotMatch(JSON.stringify({ notifications, messages }), /private-name|private-text/);
});

test('reply freshness follows actual directory jobs, not the timestamp of a successful stale fetch', () => {
  const d = device(); d.snapshot.jobs = [{ id: 'j', worker: worker.id, status: 'done', createdAt: '2026-01-01', updatedAt: '2026-01-03' }];
  assert.equal(detailBehindSnapshot({ jobs: [{ id: 'j', status: 'running', updatedAt: '2026-01-02' }] }, d, worker.id), true);
  assert.equal(detailBehindSnapshot({ jobs: [] }, d, worker.id), true);
  assert.equal(detailBehindSnapshot({ jobs: d.snapshot.jobs }, d, worker.id), false);
});

test('busy heartbeats cannot bypass the minute budget, while terminal transitions can', () => {
  const record = { revision: 'before-heartbeat', at: 100000 };
  assert.equal(prefetchDue(record, { revision: 'after-heartbeat', active: true }, 100001), false);
  assert.equal(prefetchDue(record, { revision: 'after-heartbeat', active: true }, 160000), true);
  assert.equal(prefetchDue(record, { revision: 'completed', active: false }, 100001), true);
});

test('a previously tracked worker is still eligible after becoming idle and read on another device', () => {
  const d = device(); d.snapshot.workers[0].unreadCount = 0;
  assert.equal(conversationCandidates([d]).length, 0);
  const tracked = [JSON.stringify([d.id, worker.id])];
  assert.equal(conversationCandidates([d], { tracked })[0].worker, worker.id);
});

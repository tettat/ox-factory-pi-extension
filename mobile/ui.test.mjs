import test from 'node:test';
import assert from 'node:assert/strict';
import * as UI from './web/ui.js';

test('recent-message sort follows factory activity, not visits, stars or unread clearing', () => {
  const workers = [{ id: 'old', name: 'A', lastInteractionAt: '2026-09-23T00:00:00Z', unreadCount: 9 }, { id: 'new', name: 'B', lastInteractionAt: '2026-09-24T00:00:00Z', unreadCount: 0 }];
  const options = { sort: 'activity', deviceId: 'd', favorites: ['["d","old"]'], recent: { '["d","old"]': Date.now() } };
  assert.equal(UI.workerList(workers, options)[0].id, 'new');
  workers[0].unreadCount = 0; assert.equal(UI.workerList(workers, options)[0].id, 'new');
  assert.equal(UI.workerList(workers, { ...options, activity: { old: Date.parse('2026-09-25') } })[0].id, 'old');
});
test('worker sort supports token ranking and fallback activity without mutating source', () => {
  const ws = [{ id: 'a', name: 'A', tokenToday: { total: 5 } }, { id: 'b', name: 'B', tokenToday: { total: 50 } }];
  assert.equal(UI.workerList(ws, { sort: 'tokens' })[0].id, 'b'); assert.equal(ws[0].id, 'a');
  const activity = UI.workerActivity({ workers: ws, jobs: [{ worker: 'a', updatedAt: 1000 }], requests: [{ to: 'b', createdAt: 2000 }] }, [{ envelope: { body: { worker: 'a' }, createdAt: 3000 } }]);
  assert.equal(activity.a, 3000); assert.equal(activity.b, 2000);
});
test('token format rejects invalid counts and does not invent costs', () => {
  assert.equal(UI.compactNumber(1250000), '1.25M'); assert.equal(UI.tokenNumber(-2), 0); assert.equal(UI.tokenNumber(Infinity), 0); assert.equal(UI.tokenNumber('100'), 0);
});
test('restored outgoing entries require a valid identity, envelope and known phase', () => {
  const record = { envelope: { id: 'fixture_id_123', deviceId: 'device-a', action: 'talk.send', body: { worker: 'worker', message: 'hello' } }, phase: 'uncertain' };
  assert.equal(Object.keys(UI.outgoingState({ fixture_id_123: record, bad: record })).length, 1);
  assert.deepEqual(UI.outgoingState({ fixture_id_123: { ...record, phase: 'invented' } }), {});
});

test('message rendering supports headings, code, lists, links and never passes through HTML', () => {
  const html = UI.markdown('# 标题\n**粗体** 与 `code`\n- 甲\n- 乙\n[官网](https://example.com/test?q=1)\n```js\n<img src=x onerror=alert(1)>\n```\n<script>alert(1)</script>');
  assert.match(html, /<h4>标题<\/h4>/); assert.match(html, /<strong>粗体<\/strong>/); assert.match(html, /<ul><li>甲<\/li>/);
  assert.match(html, /rel="noopener noreferrer"/); assert.match(html, /&lt;img/); assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<img|<script/);
});
test('Markdown rejects script/data/file and credential-bearing links', () => {
  for (const value of ['javascript:alert(1)', 'data:text/html,x', 'file:///secret', 'https://user:secret@example.com']) {
    assert.equal(UI.safeLink(value), null); assert.doesNotMatch(UI.markdown(`[test](${value})`), /<a /);
  }
  assert.equal(UI.safeLink('https://example.com'), 'https://example.com/');
});
test('arbitrary task business status is preserved, filtered exactly and grouped only for display', () => {
  const tasks = [{ id: 'a', title: '找 Bug', status: '等待老板拍板', project: 'one', assignee: '', context: '手机测试' }, { id: 'b', title: '发布', status: '完成', project: 'two', assignee: '测试员' }];
  assert.equal(UI.taskGroup('等待老板拍板'), 'other'); assert.equal(UI.taskGroup('待验收'), 'review');
  assert.deepEqual(UI.filterTasks(tasks, { query: 'Bug 手机', assignee: '__unassigned__', project: 'one', status: '等待老板拍板' }).map(t => t.id), ['a']);
  assert.equal(tasks[0].status, '等待老板拍板'); assert.equal(UI.taskStats(tasks).other, 1);
});
test('favorite employee ordering and filters are device scoped and do not mutate snapshots', () => {
  const workers = [{ id: 'a', name: 'A', status: 'busy', backend: 'codex' }, { id: 'b', name: 'B', status: 'idle', backend: 'pi' }];
  const favorites = [JSON.stringify(['second', 'b'])];
  assert.equal(UI.workerList(workers, { deviceId: 'second', favorites })[0].id, 'b');
  assert.equal(UI.workerList(workers, { deviceId: 'first', favorites })[0].id, 'a');
  assert.deepEqual(UI.workerList(workers, { status: 'busy', backend: 'codex' }).map(w => w.id), ['a']);
  assert.deepEqual(workers.map(w => w.id), ['a', 'b']);
});
test('denied, corrupted or missing browser storage never prevents application initialization', () => {
  const denied = { getItem() { throw Error('denied'); }, setItem() { throw Error('quota'); }, removeItem() { throw Error('denied'); } };
  assert.equal(UI.read(denied, 'key', 'default'), 'default'); assert.equal(UI.write(denied, 'key', 'v'), false); assert.doesNotThrow(() => UI.remove(denied, 'key'));
  assert.deepEqual(UI.json({ getItem: () => '{broken' }, 'x', {}), {});
  assert.deepEqual(UI.pendingState({ broken: {}, also: { envelope: { action: 'shell.exec' } } }), {});
});
test('pending state retains valid uncertain request IDs and never invents an operation', () => {
  const id = 'request_fixture_1', envelope = { id, deviceId: 'device_a', action: 'task.assign', body: { worker: 'test', message: 'test' } };
  const raw = { [id]: { signature: 'original', envelope } };
  assert.deepEqual(UI.pendingState(raw), raw); assert.deepEqual(UI.pendingState([]), {});
});
test('display escaping, unknown status and relative timestamps have stable fallbacks', () => {
  assert.match(UI.status('<img onerror=x>'), /&lt;img/); assert.doesNotMatch(UI.status('<img onerror=x>'), /class="status <img/);
  assert.equal(UI.relative(0), '尚未同步'); assert.equal(UI.relative(100000, 105000), '刚刚'); assert.equal(UI.relative(100000, 220000), '2 分钟前');
  assert.equal(UI.relative('not-a-date'), '尚未同步');
});

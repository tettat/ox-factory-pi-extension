import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

test('live worker cards retain task unread counts, active dots, names and stable nodes', async t => {
  const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  const dom = new JSDOM('<main><aside class="workers__list"></aside><textarea id="draft"></textarea></main>');
  t.after(() => dom.window.close());
  const document = dom.window.document;
  let workers = [
    { name: 'Idle', status: 'idle', lastInteractionAt: '2026-09-01', unreadCount: 50 },
    { name: 'Running', status: 'idle', activeJobs: 1, unreadCount: 30, lastInteractionAt: '2026-02-01' },
    { name: 'Done', displayName: 'Finished worker', model: 'fixture', status: 'idle', finishedUnreadJobs: 2, lastInteractionAt: '2026-01-01' },
  ];
  const ctx = vm.createContext({
    document, Node: dom.window.Node, console,
    STATE: { currentPage: 'workers', workers: [] },
    $: (s, root = document) => root.querySelector(s),
    $$: (s, root = document) => [...root.querySelectorAll(s)],
    api: async () => ({ ok: true, data: { workers } }),
    selectedWorkerFromHash: () => 'Done',
    showWorkerProfile: () => {}, hideWorkerProfile: () => {}, navigateToWorker: () => {},
  });
  const section = (from, to) => {
    const start = source.indexOf(from), end = source.indexOf(to, start);
    assert.ok(start >= 0 && end > start);
    return source.slice(start, end);
  };
  vm.runInContext([
    section('  function el(', '  function loadingText('),
    section('  const recentListScroll =', '  async function refreshOverviewSilently('),
    section('  function workerDisplayName(', '  function workerAvatarNode('),
    section('  function unreadBadgeTitle(', '  function messageItem('),
    section('  function createWorkerCard(', '  function renderWorkers('),
    section('  async function refreshWorkerUnreadBadges(', '  // 路由调用计数器'),
    "function workerAvatarNode() { return el('span', {class:'avatar'}); }",
  ].join('\n'), ctx);
  const cards = () => [...document.querySelectorAll('.worker-card')];
  const card = name => cards().find(c => c.dataset.name === name);
  await vm.runInContext('refreshWorkerUnreadBadges()', ctx);
  assert.deepEqual(cards().map(c => c.dataset.name), ['Done', 'Running', 'Idle']);
  const done = card('Done'), running = card('Running');
  assert.equal(done.querySelector('.worker-card__badge--unread').textContent, '2');
  assert.equal(done.querySelector('.worker-card__name').textContent, 'Finished worker');
  assert.ok(running.querySelector('.dot--busy'));
  assert.equal(running.querySelector('.worker-card__badge--unread'), null);
  assert.equal(card('Idle').querySelector('.worker-card__badge--unread'), null);

  workers = [
    { ...workers[1], activeJobs: 0, finishedUnreadJobs: 1, displayName: 'New name', lastTalkReply: { contentPreview: 'Final reply' } },
    { ...workers[2], finishedUnreadJobs: 0 },
    { name: 'New', status: 'idle', activeJobs: 1 },
  ];
  await vm.runInContext('refreshWorkerUnreadBadges()', ctx);
  assert.deepEqual(cards().map(c => c.dataset.name), ['Running', 'New', 'Done']);
  assert.equal(card('Done'), done);
  assert.equal(card('Running'), running);
  assert.equal(done.querySelector('.worker-card__badge--unread'), null);
  assert.equal(running.querySelector('.worker-card__badge--unread').textContent, '1');
  assert.ok(running.querySelector('.dot--idle'));
  assert.match(running.querySelector('.worker-card__talk-preview').textContent, /Final reply/);
  assert.equal(running.querySelector('.worker-card__name').textContent, 'New name');
  assert.equal(card('Idle'), undefined);
});

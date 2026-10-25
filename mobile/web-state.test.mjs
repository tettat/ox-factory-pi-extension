// Pure browser-state regression tests; no browser server or real employee actions.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import * as UI from './web/ui.js';
import * as Cache from './web/cache.js';
import * as Prefetch from './web/prefetch.js';
const fullSource = readFileSync(new URL('./web/app.js', import.meta.url), 'utf8');
const source = fullSource.slice(0, fullSource.indexOf("\ndocument.addEventListener('click'")).replace("import * as UI from './ui.js';", '').replace("import * as Cache from './cache.js';", '').replace("import * as Prefetch from './prefetch.js';", '');
function context({ deploymentPending = false, storageDenied = false } = {}) {
  const nodes = new Map(), values = new Map();
  const storage = { getItem: k => values.get(k) || null, setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k) };
  const node = () => ({ innerHTML: '', value: '', dataset: {}, open: false, setAttribute() {}, contains: () => false, querySelectorAll: () => [], classList: { toggle() {}, add() {}, remove() {} }, showModal() { this.open = true; }, close() { this.open = false; } });
  const context = vm.createContext({ UI, Cache, Prefetch, URL, window: {}, navigator: { onLine: true }, document: { querySelectorAll: () => [], querySelector: s => { if (!nodes.has(s)) nodes.set(s, s === 'meta[name="ox-backend"]' && deploymentPending ? { content: 'pending' } : node()); return nodes.get(s); } }, sessionStorage: storage, localStorage: storage, crypto: { randomUUID }, AbortSignal, setTimeout, clearTimeout, fetch: async () => { throw Error('unexpected fetch'); } });
  if (storageDenied) vm.runInContext("Object.defineProperty(globalThis, 'sessionStorage', { get() { throw Error('denied'); } }); Object.defineProperty(globalThis, 'localStorage', { get() { throw Error('denied'); } });", context);
  vm.runInContext(source, context);
  vm.runInContext("state = { devices: [{ id: 'device-a', online: true }, { id: 'device-b', online: true }], commands: [] }; selected = 'device-b';", context);
  return context;
}

function readingContext() {
  const c = context();
  vm.runInContext("me = { id: 'session-read' }; selected = 'device-a'; openedWorker = 'worker-a'; renderTimeline = () => {};", c);
  return c;
}
const readPhase = c => vm.runInContext("$('#chat-read-status').dataset.state", c);

function historyContext() {
  const c = readingContext();
  vm.runInContext("me.principalId = 'owner'; state.devices[0].role = 'owner'; state.devices[0].snapshot = { observedAt: '2020', workers: [{ id: 'worker-a', unreadCount: 120 }], capabilities: ['read-history-v1'] }; historyReadItem = { worker: openedWorker, deviceId: selected, read: { unread: true, revision: 'history-1', token: 'one-proof-for-all-history' } };", c);
  return c;
}

test('opening a conversation acknowledges one history proof and settles an in-flight identical refresh', async () => {
  const c = historyContext(), calls = []; let finish;
  c.send = (action, body) => { calls.push({ action, body }); return new Promise(r => { finish = r; }); };
  vm.runInContext('runCommand = send; syncHistoryRead(); syncHistoryRead(); historyReadItem = { ...historyReadItem, read: { ...historyReadItem.read } };', c);
  assert.equal(calls.length, 1); assert.equal(calls[0].action, 'read.mark'); assert.equal(calls[0].body.tokens.length, 1);
  finish({ acknowledged: ['history-1'], observedAt: '2026', worker: { id: 'worker-a', unreadCount: 0 } });
  await new Promise(r => setImmediate(r));
  vm.runInContext('syncHistoryRead()', c);
  assert.equal(calls.length, 1); assert.equal(vm.runInContext('snap().workers[0].unreadCount', c), 0);
  assert.equal(vm.runInContext('historyReadItem.read.unread', c), false);
});

test('history acknowledgements do not target a hidden page, another device, or a viewer', () => {
  const c = historyContext();
  c.send = () => { throw Error('must not acknowledge'); }; vm.runInContext('runCommand = send;', c);
  vm.runInContext('document.hidden = true; syncHistoryRead(); document.hidden = false;', c);
  vm.runInContext("selected = 'device-b'; syncHistoryRead(); selected = 'device-a'; state.devices[0].role = 'viewer'; syncHistoryRead();", c);
  assert.equal(vm.runInContext('readFlights.size', c), 0);
});

test('an old history receipt cannot mark a newer snapshot read or overwrite newer desktop counters', async () => {
  const c = historyContext(); let finish;
  c.send = () => new Promise(r => { finish = r; }); vm.runInContext('runCommand = send; syncHistoryRead();', c);
  vm.runInContext("historyReadItem = { ...historyReadItem, read: { unread: true, revision: 'history-2', token: 'new-proof' } }; state.devices[0].snapshot.observedAt = '2028';", c);
  finish({ acknowledged: ['history-1'], observedAt: '2026', worker: { id: 'worker-a', unreadCount: 0 } }); await new Promise(r => setImmediate(r));
  assert.equal(vm.runInContext('historyReadItem.read.unread', c), true); assert.equal(vm.runInContext('snap().workers[0].unreadCount', c), 120);
});

test('read-sync errors are quiet and retry only after backoff', async () => {
  const c = historyContext(); let calls = 0;
  c.send = async () => { calls++; throw Error('offline'); }; vm.runInContext('runCommand = send; syncHistoryRead();', c); await new Promise(r => setImmediate(r));
  vm.runInContext('syncHistoryRead()', c); assert.equal(calls, 1);
  assert.equal(vm.runInContext('historyReadItem.read.unread', c), true);
  assert.equal(vm.runInContext("$('#toast').textContent", c), undefined);
});

test('a delayed local cache read merges older history without replacing fresher network content', async () => {
  const c = historyContext(); let finish;
  c.readCache = () => new Promise(r => { finish = r; }); vm.runInContext('conversationCache.load = readCache;', c);
  const loading = vm.runInContext('restoreConversation()', c);
  vm.runInContext("detailCache.set(JSON.stringify([me.id, selected, openedWorker]), { at: 500, detail: { messages: [{ id: 'same', content: 'newer network' }] } });", c);
  finish({ updatedAt: 1, data: { messages: [{ id: 'old', content: 'old retained' }, { id: 'same', content: 'stale disk' }] } }); await loading;
  assert.equal(vm.runInContext("detail.messages.find(m => m.id === 'same').content", c), 'newer network');
  assert.equal(vm.runInContext('detail.messages.length', c), 2); assert.equal(vm.runInContext('lastDetailAt', c), 500);
});

test('clearing or logging out while disk reads are pending prevents private cache resurrection', async () => {
  for (const action of ['cacheEpoch++; detailCache.clear();', 'clearPrivateBrowserState(); me = null;']) {
    const c = historyContext(); let finish;
    c.readCache = () => new Promise(r => { finish = r; }); vm.runInContext('conversationCache.load = readCache;', c);
    const loading = vm.runInContext('restoreConversation()', c); vm.runInContext(action, c);
    finish({ updatedAt: 1, data: { messages: [{ id: 'm', content: 'private' }] } }); await loading;
    assert.equal(vm.runInContext('detailCache.size', c), 0); assert.equal(vm.runInContext('detail', c), null);
  }
});
test('cached conversation keeps a real loading indicator until its full read completes', async () => {
  const c = readingContext(); let finish, calls = 0;
  c.read = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  vm.runInContext("detail = { marker: 'cached' }; lastDetailAt = Date.now() - 60000; runCommand = () => read();", c);
  const loading = vm.runInContext('refreshDetail()', c);
  assert.equal(readPhase(c), 'loading');
  assert.equal(vm.runInContext('detail.marker', c), 'cached');
  const alsoLoading = vm.runInContext('refreshDetail()', c);
  assert.equal(calls, 1); assert.equal(readPhase(c), 'loading');
  finish({ marker: 'fresh' }); await Promise.all([loading, alsoLoading]);
  assert.equal(readPhase(c), 'ready');
  assert.equal(vm.runInContext('detail.marker', c), 'fresh');
  assert.doesNotMatch(vm.runInContext("$('#chat-read-status').innerHTML", c), /read-spinner/);
});

test('failed background reads retain cache and show failure rather than a success check', async () => {
  const c = readingContext();
  vm.runInContext("detail = { marker: 'cached' }; lastDetailAt = 1; runCommand = async () => { throw Error('fixture failure'); };", c);
  await vm.runInContext('refreshDetail()', c);
  assert.equal(readPhase(c), 'error'); assert.equal(vm.runInContext('detail.marker', c), 'cached');
  assert.match(vm.runInContext("$('#chat-read-status').innerHTML", c), /保留上次内容/);
  vm.runInContext("runCommand = async () => ({ marker: 'retried' });", c);
  await vm.runInContext('refreshDetail()', c);
  assert.equal(readPhase(c), 'ready'); assert.equal(vm.runInContext('detailErrors.size', c), 0);
});

test('switching workers and returning during a read restores the matching spinner without duplicate reads', async () => {
  const c = readingContext(); let finish;
  c.read = new Promise(resolve => { finish = resolve; });
  vm.runInContext('runCommand = () => read;', c);
  const loading = vm.runInContext('refreshDetail()', c);
  vm.runInContext("openedWorker = 'worker-b'; syncDetailReadIndicator();", c);
  assert.equal(readPhase(c), 'idle');
  vm.runInContext("openedWorker = 'worker-a'; syncDetailReadIndicator();", c);
  assert.equal(readPhase(c), 'loading');
  finish({ worker: {} }); await loading;
  assert.equal(readPhase(c), 'ready');
});

test('completion from a different device cannot stop the current device spinner', async () => {
  const c = readingContext(); const finish = {};
  c.read = id => new Promise(resolve => { finish[id] = resolve; });
  vm.runInContext('runCommand = (_a, _b, options) => read(options.deviceId);', c);
  const a = vm.runInContext('refreshDetail()', c);
  vm.runInContext("selected = 'device-b';", c);
  const b = vm.runInContext('refreshDetail()', c);
  finish['device-a']({ marker: 'old-device' }); await a;
  assert.equal(readPhase(c), 'loading'); assert.equal(vm.runInContext('detail', c), null);
  finish['device-b']({ marker: 'current-device' }); await b;
  assert.equal(readPhase(c), 'ready'); assert.equal(vm.runInContext('detail.marker', c), 'current-device');
});

test('logout prevents a late read from restoring cached data or its success indicator', async () => {
  const c = readingContext(); let finish;
  c.read = new Promise(resolve => { finish = resolve; });
  vm.runInContext('runCommand = () => read;', c);
  const loading = vm.runInContext('refreshDetail()', c);
  vm.runInContext("clearPrivateBrowserState(); me = null; $('#chat-read-status').innerHTML = 'new-view';", c);
  finish({ marker: 'old-secret' }); await loading;
  assert.equal(vm.runInContext('detailCache.size', c), 0);
  assert.equal(vm.runInContext("$('#chat-read-status').innerHTML", c), 'new-view');
  assert.equal(vm.runInContext('detailReads.size', c), 0);
});

test('offline cached conversation does not pretend to be loading or newly synced', async () => {
  const c = readingContext();
  vm.runInContext("online = false; detail = { marker: 'cached' }; lastDetailAt = Date.now(); runCommand = () => { throw Error('must not send'); };", c);
  await vm.runInContext('refreshDetail()', c);
  assert.equal(readPhase(c), 'paused'); assert.equal(vm.runInContext('detail.marker', c), 'cached');
});

test('job result dialog shows a title spinner until success or failure, without loading prose', async () => {
  const c = readingContext(); let finish;
  c.read = new Promise(resolve => { finish = resolve; });
  vm.runInContext('runCommand = () => read;', c);
  const loading = vm.runInContext("openJob('fixture-job')", c);
  const initial = vm.runInContext("$('#dialog-body').innerHTML", c);
  assert.match(initial, /data-state="loading"/); assert.doesNotMatch(initial, /正在读取完整结果<|class="empty"/);
  finish({ job: { worker: 'Fixture', status: 'done' }, reply: 'Ready' }); await loading;
  assert.match(vm.runInContext("$('#dialog-body').innerHTML", c), /data-state="ready"/);
  vm.runInContext("runCommand = async () => { throw Error('fixture failure'); };", c);
  await vm.runInContext("openJob('fixture-job')", c);
  assert.match(vm.runInContext("$('#dialog-body').innerHTML", c), /data-state="error"/);
  assert.doesNotMatch(vm.runInContext("$('#dialog-body').innerHTML", c), /read-spinner/);
});
test('an explicitly pinned operation does not follow a changed device picker', async () => {
  const c = context(); let submitted;
  c.fetch = async (_url, options) => { submitted = JSON.parse(options.body); return { ok: true, json: async () => ({ command: { state: 'done', result: { ok: true, data: { accepted: true } } } }) }; };
  await vm.runInContext("runCommand('talk.send', { worker: 'same-name', message: 'fixture' }, { deviceId: 'device-a' })", c);
  assert.equal(submitted.deviceId, 'device-a');
});
test('late worker detail from another device cannot replace current employee history', async () => {
  const c = context(); let finish; c.deferred = new Promise(r => { finish = r; });
  vm.runInContext("selected = 'device-a'; openedWorker = 'same-name'; runCommand = () => deferred;", c);
  const pending = vm.runInContext('refreshDetail()', c);
  vm.runInContext("selected = 'device-b'; openedWorker = 'same-name';", c);
  finish({ worker: { name: 'old-device-worker' }, jobs: [] }); await pending;
  assert.equal(vm.runInContext('detail', c), null);
});
test('losing access to the selected device clears its open conversation', () => {
  const c = context();
  vm.runInContext("selected = 'revoked-device'; openedWorker = 'old-worker'; detail = { jobs: ['old-data'] }; renderDevicePicker();", c);
  assert.equal(vm.runInContext('openedWorker', c), ''); assert.equal(vm.runInContext('detail', c), null);
});
test('offline writes are rejected before transport or pending intent creation', async () => {
  const c = context(); let calls = 0; c.fetch = async () => { calls++; throw Error('must not send'); };
  vm.runInContext('online = false;', c);
  await assert.rejects(vm.runInContext("runCommand('task.assign', { worker: 'fixture', message: 'must not queue' })", c));
  assert.equal(calls, 0); assert.equal(vm.runInContext('Object.keys(pending).length', c), 0);
});

test('Netlify without a Hub explains the missing backend instead of accepting a login', async () => {
  const c = context(); c.fetch = async () => ({ ok: false, status: 503, json: async () => ({ error: 'HUB_NOT_CONFIGURED' }) });
  await assert.rejects(vm.runInContext("api('/api/me')", c), e => e.code === 'HUB_NOT_CONFIGURED');
  assert.match(vm.runInContext('backendIssue', c), /尚未接通/);
  assert.equal(vm.runInContext('writable()', c), false);
  c.fetch = async () => ({ ok: true, status: 200, json: async () => ({ role: 'owner' }) });
  await vm.runInContext("api('/api/me')", c);
  assert.equal(vm.runInContext('backendIssue', c), '');
});

test('HTML proxy failures retain an uncertain write ID rather than inviting duplicate dispatch', async () => {
  const c = context(); c.fetch = async () => ({ ok: false, status: 502, json: async () => { throw Error('HTML gateway error'); } });
  await assert.rejects(vm.runInContext("runCommand('task.assign', { worker: 'fixture', message: 'fixture' })", c), e => e.code === 'HUB_UNAVAILABLE');
  assert.equal(vm.runInContext('Object.keys(pending).length', c), 1);
});

test('unknown JSON gateway 5xx also retains the original request ID', async () => {
  const c = context(); c.fetch = async () => ({ ok: false, status: 504, json: async () => ({ error: 'UPSTREAM_TIMED_OUT' }) });
  await assert.rejects(vm.runInContext("runCommand('task.assign', { worker: 'fixture', message: 'fixture' })", c), e => e.code === 'HUB_UNAVAILABLE');
  assert.equal(vm.runInContext('Object.keys(pending).length', c), 1);
});

test('published frontend-only preview never sends even an entered code to any backend', async () => {
  const c = context({ deploymentPending: true }); let requests = 0;
  c.fetch = async () => { requests++; throw Error('must not transmit'); };
  await assert.rejects(vm.runInContext("api('/api/login', { code: 'TEST-ONLY' })", c), e => e.code === 'HUB_NOT_CONFIGURED');
  assert.equal(requests, 0);
});

test('stale snapshot disables every write even when a different API still responds', () => {
  const c = context();
  vm.runInContext('lastStateAt = Date.now() - 31000;', c);
  assert.equal(vm.runInContext('writable()', c), false);
});

test('a late job response cannot reopen or replace a closed/newer dialog', async () => {
  const c = context(); let resolve;
  c.deferred = new Promise(r => resolve = r);
  vm.runInContext('runCommand = () => deferred;', c);
  const loading = vm.runInContext("openJob('fixture-job')", c);
  vm.runInContext("closeModal(); modal('<h2>new-dialog</h2>');", c);
  resolve({ job: { worker: 'old-worker', task: 'old-task' }, reply: 'old-reply' });
  await loading;
  assert.equal(vm.runInContext("$('#dialog-body').innerHTML", c), '<h2>new-dialog</h2>');
});

test('drafts are isolated by factory, employee and operation type', () => {
  const c = context();
  const keys = ['talk.send', 'task.assign'].flatMap(action => ['device-a', 'device-b'].map(d => vm.runInContext(`draftKey('${action}', '${d}', 'same-worker')`, c)));
  assert.equal(new Set(keys).size, 4);
});

test('denied browser storage keeps drafts and display preferences in memory', () => {
  const c = context({ storageDenied: true });
  vm.runInContext("openedWorker = 'fixture-worker'; $('#message').value = 'unsent draft'; $('#project').value = 'fixture'; $('#send-mode').value = 'queue'; saveDraft(); $('#message').value = ''; loadDraft(); savePreference('ox-theme', 'dark');", c);
  assert.equal(vm.runInContext("$('#message').value", c), 'unsent draft');
  assert.equal(vm.runInContext("pref('ox-theme')", c), 'dark');
  assert.match(vm.runInContext("$('#draft-status').textContent", c), /存储受限/);
});

test('a state response arriving after logout cannot restore private directory data', async () => {
  const c = context(); let finish;
  c.deferred = new Promise(resolve => { finish = resolve; });
  vm.runInContext("me = { id: 'old-session' }; api = () => deferred;", c);
  const loading = vm.runInContext('refresh()', c);
  vm.runInContext('clearPrivateBrowserState(); me = null;', c);
  finish({ devices: [{ id: 'old-private-device' }], commands: [] });
  await loading;
  assert.equal(vm.runInContext('state.devices.length', c), 0);
  assert.equal(vm.runInContext('lastStateAt', c), 0);
});

test('slow first login sync does not reset a tab selected while loading', async () => {
  const c = context(); let finish;
  c.deferred = new Promise(resolve => { finish = resolve; });
  vm.runInContext("api = async () => ({ id: 'fixture-session' }); refresh = () => deferred; showWorkspace = () => {}; render = () => {}; history = { replaceState() {} };", c);
  const handler = fullSource.slice(fullSource.indexOf("$('#login-form').onsubmit ="), fullSource.indexOf("\n$('#show-password').onclick"));
  vm.runInContext(handler, c);
  const loading = vm.runInContext("$('#login-form').onsubmit({ preventDefault() {}, target: { querySelector() { return {}; } } })", c);
  await new Promise(resolve => setImmediate(resolve));
  vm.runInContext("tab = 'workers'; openedWorker = 'fixture-worker';", c);
  finish(); await loading;
  assert.equal(vm.runInContext('tab', c), 'workers');
  assert.equal(vm.runInContext('openedWorker', c), 'fixture-worker');
});

function deliveryContext() {
  const c = context();
  vm.runInContext("me = { id: 'session-a' }; selected = 'device-a'; openedWorker = 'worker-a'; deliveryViewChanged = () => {}; renderTimeline = () => {}; renderAttachments = () => {}; updateCompose = () => {}; refresh = async () => {}; $('#message').value = 'first message'; $('#project').value = ''; $('#send-mode').value = 'auto';", c);
  return c;
}

test('send returns before Hub acknowledgement and preserves the pinned destination after navigation', async () => {
  const c = deliveryContext(); let finish, envelope;
  c.api = undefined;
  c.response = new Promise(resolve => { finish = resolve; }); c.capture = body => { envelope = JSON.parse(JSON.stringify(body)); };
  vm.runInContext('api = async (path, body) => { capture(body); return response; };', c);
  await vm.runInContext('sendCompose({ preventDefault() {} })', c);
  assert.equal(vm.runInContext("$('#message').value", c), '');
  assert.equal(vm.runInContext('Object.values(outgoing)[0].phase', c), 'submitting');
  vm.runInContext("selected = 'device-b'; openedWorker = 'worker-b'; $('#message').value = 'new draft'; saveDraft();", c);
  assert.equal(envelope.deviceId, 'device-a'); assert.equal(envelope.body.worker, 'worker-a');
  const work = vm.runInContext('[...deliveryTasks.values()][0]', c);
  finish({ command: { id: envelope.id, state: 'queued' } }); await work;
  assert.equal(vm.runInContext('Object.values(outgoing)[0].phase', c), 'accepted');
  assert.equal(vm.runInContext("$('#message').value", c), 'new draft');
  assert.equal(vm.runInContext('Object.keys(pending).length', c), 1);
});

test('an uncertain background send retries the exact envelope, never a new request ID', async () => {
  const c = deliveryContext(), sent = [];
  c.capture = body => { sent.push(JSON.parse(JSON.stringify(body))); };
  vm.runInContext("api = async (path, body) => { capture(body); throw Object.assign(Error('gateway'), { code: 'HUB_UNAVAILABLE' }); };", c);
  await vm.runInContext('sendCompose({ preventDefault() {} })', c); await vm.runInContext('[...deliveryTasks.values()][0]', c);
  assert.equal(vm.runInContext('Object.values(outgoing)[0].phase', c), 'uncertain');
  vm.runInContext("api = async (path, body) => { capture(body); return { command: { id: body.id, state: 'done', result: { ok: true, data: { request: { id: 'req-fixture', jobId: 'job-fixture' } } } } }; };", c);
  await vm.runInContext('performDelivery(Object.values(outgoing)[0], me)', c);
  assert.equal(sent.length, 2); assert.deepEqual(sent[0], sent[1]);
  assert.equal(vm.runInContext('Object.values(outgoing)[0].phase', c), 'confirmed');
  assert.equal(vm.runInContext('Object.values(outgoing)[0].jobId', c), 'job-fixture');
  assert.equal(vm.runInContext('Object.keys(pending).length', c), 0);
});

test('confirmed background receipt cannot regress to queued and completion never clears a newer draft', () => {
  const c = deliveryContext();
  vm.runInContext("const r = { envelope: { id: 'record-fixture', deviceId: 'device-a', action: 'talk.send', body: { worker: 'worker-a', message: 'old' } }, phase: 'accepted' }; outgoing[r.envelope.id] = r; pending[r.envelope.id] = { envelope: r.envelope }; $('#message').value = 'new text'; reconcileOutgoing([{ id: r.envelope.id, state: 'done', result: { ok: true, data: { request: { id: 'req-old' } } } }]); reconcileOutgoing([{ id: r.envelope.id, state: 'queued' }]);", c);
  assert.equal(vm.runInContext('Object.values(outgoing)[0].phase', c), 'confirmed'); assert.equal(vm.runInContext("$('#message').value", c), 'new text');
});

test('logout during background send cannot restore old private receipts', async () => {
  const c = deliveryContext(); let finish;
  c.response = new Promise(resolve => { finish = resolve; });
  vm.runInContext('api = () => response;', c);
  await vm.runInContext('sendCompose({ preventDefault() {} })', c);
  const work = vm.runInContext('[...deliveryTasks.values()][0]', c), id = vm.runInContext('Object.keys(outgoing)[0]', c);
  vm.runInContext('clearPrivateBrowserState(); me = null;', c);
  finish({ command: { id, state: 'queued' } }); await work;
  assert.equal(vm.runInContext('Object.keys(outgoing).length', c), 0); assert.equal(vm.runInContext('Object.keys(pending).length', c), 0);
});

test('a late POST timeout cannot regress a factory receipt already received by polling', async () => {
  const c = deliveryContext(); let reject;
  c.response = new Promise((resolve, fail) => { reject = fail; });
  vm.runInContext('api = () => response;', c);
  await vm.runInContext('sendCompose({ preventDefault() {} })', c);
  const work = vm.runInContext('[...deliveryTasks.values()][0]', c);
  vm.runInContext("reconcileOutgoing([{ id: Object.keys(outgoing)[0], state: 'done', result: { ok: true, data: { request: { id: 'receipt-before-timeout' } } } }]);", c);
  reject(Error('POST timed out')); await work;
  assert.equal(vm.runInContext('Object.values(outgoing)[0].phase', c), 'confirmed');
  assert.equal(vm.runInContext('Object.keys(pending).length', c), 0);
});

test('new messages are not duplicated before first Hub acknowledgement but another worker is independent', async () => {
  const c = deliveryContext(); let finish; c.response = new Promise(resolve => { finish = resolve; });
  vm.runInContext('api = () => response;', c);
  await vm.runInContext('sendCompose({ preventDefault() {} })', c);
  vm.runInContext("$('#message').value = 'second click';", c); await vm.runInContext('sendCompose({ preventDefault() {} })', c);
  assert.equal(vm.runInContext('Object.keys(outgoing).length', c), 1);
  vm.runInContext("openedWorker = 'worker-b';", c); await vm.runInContext('sendCompose({ preventDefault() {} })', c);
  assert.equal(vm.runInContext('Object.keys(outgoing).length', c), 2);
  vm.runInContext('clearPrivateBrowserState(); me = null;', c); finish({}); await Promise.all(vm.runInContext('[...deliveryTasks.values()]', c));
});

test('late unauthorized response from an old login cannot revoke a newer login', async () => {
  const c = context(); let finish;
  c.fetch = () => new Promise(resolve => { finish = resolve; });
  vm.runInContext("me = { id: 'old' };", c); const response = vm.runInContext("api('/api/state')", c);
  vm.runInContext("me = { id: 'new' };", c);
  finish({ ok: false, status: 401, json: async () => ({ error: 'LOGIN_REQUIRED' }) });
  await assert.rejects(response, e => e.code === 'SESSION_CHANGED'); assert.equal(vm.runInContext('me.id', c), 'new');
});

test('late project response is cached under its original factory and cannot replace another project page', async () => {
  const c=context();let finish;c.deferred=new Promise(r=>{finish=r;});
  vm.runInContext("me={id:'project-session'};selected='device-a';openedProject='entity:one';tab='projects';state.devices[0].snapshot={projects:[{id:'one',name:'One'}],capabilities:['project.detail']};renderProjectDetail=()=>{};runCommand=()=>deferred;",c);
  const reading=vm.runInContext('loadProject()',c);vm.runInContext("selected='device-b';openedProject='entity:two';",c);
  finish({project:{id:'one'}});await reading;
  assert.equal(vm.runInContext('projectCache.has(projectCacheKey())',c),false);assert.equal(vm.runInContext('projectCache.size',c),1);
});
test('logout prevents an in-flight project detail from restoring private data',async()=>{
 const c=context();let finish;c.deferred=new Promise(r=>{finish=r;});
 vm.runInContext("me={id:'project-session'};selected='device-a';openedProject='entity:one';tab='projects';state.devices[0].snapshot={projects:[{id:'one',name:'One'}],capabilities:['project.detail']};renderProjectDetail=()=>{};runCommand=()=>deferred;",c);
 const reading=vm.runInContext('loadProject()',c);vm.runInContext('clearPrivateBrowserState();me=null;',c);finish({project:{id:'one'}});await reading;
 assert.equal(vm.runInContext('projectCache.size',c),0);assert.equal(vm.runInContext('openedProject',c),'');
});

function prefetchContext() {
  const c = context();
  c.disk = new Map(); c.calls = [];
  c.readConversation = async (action, body, options) => {
    c.calls.push({ action, worker: body.worker, deviceId: options.deviceId });
    return action === 'read.mark' ? { acknowledged: ['history-a'] } : {
      messages: [{ id: 'reply-' + body.worker, content: 'new content' }],
      historyRead: { unread: true, token: 'fixture-proof', revision: 'history-a' },
    };
  };
  vm.runInContext(`me = { id: 'prefetch-session', principalId: 'owner' }; selected = 'device-a'; openedWorker = '';
    state = { devices: [{ id: 'device-a', online: true, role: 'owner', snapshot: { capabilities: ['read-history-v1'], workers: [{ id: 'worker-a', status: 'idle', unreadCount: 1 }] } }], commands: [] };
    renderTimeline = () => {}; cacheUnavailable = () => {};
    conversationCache.load = async key => disk.get(key) || null;
    conversationCache.save = async (key, data, metadata) => { disk.set(key, { data: Cache.cleanConversation(data), ...metadata, updatedAt: Date.now() }); };
    runCommand = readConversation;`, c);
  return c;
}
const settlePrefetch = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r)); };

test('snapshot refresh prefetches unopened unread conversations and saves them without marking read', async () => {
  const c = prefetchContext();
  c.fetch = async () => ({ ok: true, json: async () => vm.runInContext('state', c) });
  vm.runInContext('renderDevicePicker = () => {}; render = () => {};', c);
  await vm.runInContext('refresh()', c); await settlePrefetch();
  assert.deepEqual(c.calls.map(x => x.action), ['worker.detail']);
  assert.equal(vm.runInContext('detail', c), null);
  assert.equal(vm.runInContext('state.devices[0].snapshot.workers[0].unreadCount', c), 1);
  assert.equal(c.disk.size, 1); assert.doesNotMatch(JSON.stringify([...c.disk.values()]), /fixture-proof/);
  vm.runInContext('prefetchConversations(); prefetchConversations();', c); await settlePrefetch();
  assert.equal(c.calls.length, 1);
});

test('opening a prefetched conversation displays cached content and only then acknowledges history', async () => {
  const c = prefetchContext(); vm.runInContext('prefetchConversations()', c); await settlePrefetch();
  assert.equal(c.calls.length, 1);
  await vm.runInContext("openedWorker = 'worker-a'; refreshDetail({ ifStale: true })", c); await settlePrefetch();
  assert.equal(vm.runInContext('detail.messages[0].content', c), 'new content');
  assert.deepEqual(c.calls.map(x => x.action), ['worker.detail', 'read.mark']);
});

test('backgrounded pages prefetch all devices without acknowledging even the open conversation', async () => {
  const c = prefetchContext();
  vm.runInContext("document.hidden = true; openedWorker = 'worker-a'; state.devices.push({ ...state.devices[0], id: 'device-b' }); prefetchConversations();", c);
  await settlePrefetch();
  assert.deepEqual(c.calls.map(x => x.action), ['worker.detail', 'worker.detail']);
  assert.deepEqual(c.calls.map(x => x.deviceId), ['device-a', 'device-b']);
  assert.equal(c.disk.size, 2);
});

test('background concurrency is bounded and opening an in-flight prefetch shares its request', async () => {
  const c = prefetchContext(), finish = [];
  c.readConversation = (action, body, options) => { c.calls.push({ action, ...body, deviceId: options.deviceId }); return new Promise(resolve => finish.push(resolve)); };
  vm.runInContext("runCommand = readConversation; state.devices[0].snapshot.workers = Array.from({ length: 5 }, (_, i) => ({ id: 'w' + i, unreadCount: 1 })); prefetchConversations();", c);
  await settlePrefetch(); assert.equal(c.calls.length, 2);
  vm.runInContext("openedWorker = 'w0';", c); const opened = vm.runInContext('refreshDetail()', c);
  assert.equal(c.calls.length, 2);
  vm.runInContext('state.devices[0].snapshot.workers = [];', c);
  finish[0]({ messages: [{ id: 'm', content: 'first prefetched result' }] }); finish[1]({});
  await opened; await settlePrefetch();
  assert.equal(vm.runInContext('detail.messages[0].content', c), 'first prefetched result');
  assert.equal(vm.runInContext('prefetchTasks.size', c), 0);
});

test('a new revision arriving during prefetch is fetched afterwards instead of being falsely marked current', async () => {
  const c = prefetchContext(); let finish;
  c.readConversation = async (...args) => { c.calls.push(args[0]); if (c.calls.length === 1) return new Promise(r => { finish = r; }); return { messages: [{ id: 'new', content: 'second revision' }] }; };
  vm.runInContext('runCommand = readConversation; prefetchConversations();', c); await settlePrefetch();
  vm.runInContext("state.devices[0].snapshot.workers[0].lastInteractionAt = '2026-10-25';", c);
  finish({ messages: [{ id: 'old', content: 'first revision' }] }); await settlePrefetch();
  assert.equal(c.calls.length, 2); assert.equal(c.disk.values().next().value.data.messages.length, 2);
});

test('disk revisions survive a page reload and unchanged snapshots do not download the same conversations', async () => {
  const first = prefetchContext(); vm.runInContext('prefetchConversations()', first); await settlePrefetch();
  const next = prefetchContext(); next.disk = first.disk;
  vm.runInContext('prefetchConversations()', next); await settlePrefetch();
  assert.equal(next.calls.length, 0); assert.equal(vm.runInContext('detailCache.size', next), 1);
  vm.runInContext('state.devices[0].snapshot.workers[0].unreadCount++; prefetchConversations();', next); await settlePrefetch();
  assert.equal(next.calls.length, 1);
});

test('background read failures are quiet, retain cache, and back off without blocking other conversations', async () => {
  const c = prefetchContext(); c.readConversation = async () => { c.calls.push('failed'); throw Error('offline fixture'); };
  vm.runInContext("runCommand = readConversation; $('#toast').textContent = 'unchanged'; prefetchConversations();", c); await settlePrefetch();
  vm.runInContext('prefetchConversations();', c); await settlePrefetch();
  assert.equal(c.calls.length, 1); assert.equal(vm.runInContext("$('#toast').textContent", c), 'unchanged');
  vm.runInContext('for (const value of prefetchRecords.values()) { value.retryAt = 0; value.attemptAt = 0; } prefetchConversations();', c); await settlePrefetch();
  assert.equal(c.calls.length, 2);
});

test('logout, clear-cache and removed device discard late prefetch results', async () => {
  for (const action of ['clearPrivateBrowserState(); me = null;', 'cacheEpoch++;', 'state.devices = [];']) {
    const c = prefetchContext(); let finish;
    c.readConversation = () => new Promise(r => { finish = r; });
    vm.runInContext('runCommand = readConversation; prefetchConversations();', c); await settlePrefetch();
    vm.runInContext(action + ' online = false;', c); finish({ messages: [{ id: 'old', content: 'must not return' }] }); await settlePrefetch();
    assert.equal(c.disk.size, 0); assert.equal(vm.runInContext('detailCache.size', c), 0);
  }
});

test('private command polling stops after session changes instead of using a new login', async () => {
  const c = context(); let requests = 0;
  vm.runInContext("me = { id: 'old' };", c);
  c.fetch = async () => { requests++; return { ok: true, json: async () => ({ command: { state: 'queued' } }) }; };
  c.setTimeout = callback => { vm.runInContext("me = { id: 'new' };", c); queueMicrotask(callback); };
  await assert.rejects(vm.runInContext("runCommand('worker.detail', { worker: 'w' })", c), /手机会话已切换/);
  assert.equal(requests, 1);
});

test('hidden-page polling is slower, not disabled, and foreground immediately resumes active reads', () => {
  const c = prefetchContext(); let clock = 100000, tick;
  c.Date = class extends Date { static now() { return clock; } };
  c.setInterval = callback => { tick = callback; };
  vm.runInContext("globalThis.polls = 0; globalThis.details = 0; refresh = () => { polls++; }; refreshDetail = () => { details++; }; document.hidden = true;", c);
  vm.runInContext(fullSource.slice(fullSource.indexOf('let lastPollAttempt = 0')), c);
  tick(); assert.equal(c.polls, 1); assert.equal(c.details, 0);
  clock += 3000; tick(); assert.equal(c.polls, 1);
  clock += 27000; tick(); assert.equal(c.polls, 2);
  vm.runInContext('document.hidden = false;', c); clock += 3000; tick();
  assert.equal(c.polls, 3); assert.equal(c.details, 1);
});

test('outgoing deliveries get priority over speculative conversation reads', async () => {
  const c = prefetchContext();
  vm.runInContext("deliveryTasks.set('sending', Promise.resolve()); prefetchConversations();", c); await settlePrefetch();
  assert.equal(c.calls.length, 0);
  vm.runInContext('deliveryTasks.clear(); prefetchConversations();', c); await settlePrefetch();
  assert.equal(c.calls.length, 1);
});

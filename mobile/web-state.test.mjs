// Pure browser-state regression tests; no browser server or real employee actions.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import * as UI from './web/ui.js';
const fullSource = readFileSync(new URL('./web/app.js', import.meta.url), 'utf8');
const source = fullSource.slice(0, fullSource.indexOf("\ndocument.addEventListener('click'")).replace("import * as UI from './ui.js';", '');
function context({ deploymentPending = false, storageDenied = false } = {}) {
  const nodes = new Map(), values = new Map();
  const storage = { getItem: k => values.get(k) || null, setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k) };
  const node = () => ({ innerHTML: '', value: '', dataset: {}, open: false, setAttribute() {}, contains: () => false, querySelectorAll: () => [], classList: { toggle() {}, add() {}, remove() {} }, showModal() { this.open = true; }, close() { this.open = false; } });
  const context = vm.createContext({ UI, URL, window: {}, navigator: { onLine: true }, document: { querySelectorAll: () => [], querySelector: s => { if (!nodes.has(s)) nodes.set(s, s === 'meta[name="ox-backend"]' && deploymentPending ? { content: 'pending' } : node()); return nodes.get(s); } }, sessionStorage: storage, localStorage: storage, crypto: { randomUUID }, AbortSignal, setTimeout, clearTimeout, fetch: async () => { throw Error('unexpected fetch'); } });
  if (storageDenied) vm.runInContext("Object.defineProperty(globalThis, 'sessionStorage', { get() { throw Error('denied'); } }); Object.defineProperty(globalThis, 'localStorage', { get() { throw Error('denied'); } });", context);
  vm.runInContext(source, context);
  vm.runInContext("state = { devices: [{ id: 'device-a', online: true }, { id: 'device-b', online: true }], commands: [] }; selected = 'device-b';", context);
  return context;
}
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

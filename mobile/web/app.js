import * as UI from './ui.js';
const $ = selector => document.querySelector(selector);
let sessionStore, localStore;
try { sessionStore = sessionStorage; } catch {}
try { localStore = localStorage; } catch {}
const draftMemory = new Map(), preferenceMemory = new Map(); let draftPersistenceOK = true;
const { esc, icon, status, time } = UI;
const get = (key, fallback = '') => UI.read(sessionStore, key, fallback);
const set = (key, value) => UI.write(sessionStore, key, value);
const pref = (key, fallback = '') => preferenceMemory.has(key) ? preferenceMemory.get(key) : UI.read(localStore, key, fallback);
function savePreference(key, value) { preferenceMemory.set(key, value); if (!UI.write(localStore, key, value)) toast('设置已在本页生效；存储受限，刷新后可能需要重新设置'); }
const errors = { HUB_NOT_CONFIGURED: '手机页面已部署，但工厂中转尚未接通；现在不能登录或派活', HUB_UNAVAILABLE: '中转暂时不可用；已提交操作的状态可能尚未确认，请勿重复派活', GATEWAY_AUTH_FAILED: '站点与中转配置不匹配，请联系管理员', TASK_REVISION_CONFLICT: '任务已被更新，请关闭后重新打开，保留你的修改再合并', PUSH_ENDPOINT_REJECTED: '暂不支持此浏览器的推送服务', LOGIN_REQUIRED: '请登录后继续操作', PAIRING_INVALID_OR_EXPIRED: '配对码已使用或过期，请生成新的配对码', INVALID_PASSWORD: '登录密码不正确', DEVICE_OFFLINE: '工厂电脑离线，没有提交操作', FACTORY_UNAVAILABLE: '原工厂暂时未响应', FACTORY_PERMISSION_DENIED: '原工厂权限不允许此操作', LOCAL_GRANT_DENIED: '这台工厂未授权此身份', ROLE_DENIED: '当前凭证是只读权限', DEVICE_SCOPE_DENIED: '没有这台设备的操作权限', COMMAND_EXPIRED: '请求已过期，请先确认原工厂是否已接收', CREDENTIAL_REVOKED: '凭证已撤销，操作未继续转发', DELIVERY_UNCERTAIN_REVIEW_REQUIRED: '送达状态不确定，请检查原工厂记录，不要重复提交', FACTORY_OPERATION_FAILED: '操作未成功，请检查权限、任务版本或附件', ATTACHMENT_NOT_OWNED: '图片不属于这次对话', LOGIN_RATE_LIMIT: '尝试次数较多，请稍后重试', CSRF_REJECTED: '会话已更新，请刷新重试', REQUEST_CLOCK_OR_EXPIRY: '请求已过期或手机时间不正确；不要直接重复派活', RESULT_TOO_LARGE: '结果超过传输上限，请在电脑查看，不要重复提交写操作', PAYLOAD_TOO_LARGE: '图片超过云端请求大小限制，请缩小后重试', TOO_MANY_PENDING: '待确认操作较多，请先到动态页查看', SESSION_LIMIT: '登录设备达到上限，请由所有者清理旧凭证' };
const deploymentPending = $('meta[name="ox-backend"]')?.content === 'pending';
const passwordLogin = $('meta[name="ox-login"]')?.content === 'password';
const maxImageMiB = Math.max(1, Math.min(10, Number($('meta[name="ox-max-image-mib"]')?.content) || 10));
let me = null, state = { devices: [], commands: [] }, tab = 'home', selected = get('ox-device'), openedWorker = '', detail = null;
let online = navigator.onLine, polling = false, installPrompt = null, backendIssue = '', pushSubscribed = false;
let pending = UI.pendingState(UI.json(sessionStore, 'ox-pending', {}));
let outgoing = UI.outgoingState(UI.json(sessionStore, 'ox-outgoing', {}));
const deliveryTasks = new Map(), deliveryFiles = new Map(), detailCache = new Map(), detailReads = new Set(), usageCache = new Map(), usageReads = new Set();
const projectCache = new Map(), projectReads = new Set(), projectErrors = new Map();
let openedProject = '', projectQuery = '', projectFilter = '', projectSort = 'activity', projectPane = 'overview', taskScope = null;
let favorites = UI.json(localStore, 'ox-favorites', []); if (!Array.isArray(favorites)) favorites = [];
let recent = UI.json(sessionStore, 'ox-recent', {}); if (!recent || typeof recent !== 'object' || Array.isArray(recent)) recent = {};
let workerFilter = '', workerStatus = '', workerBackend = '', workerSort = pref('ox-worker-sort', 'activity'), taskFilter = '', taskProject = '', taskStatus = '', taskAssignee = '', taskLayout = pref('ox-task-layout', 'list');
let usageDate = '', usageDays = 7, usageError = '', chatLimit = 20, readingOnly = false;
let activityFilter = 'all', activityQuery = '', chatFilter = '', chatQuery = '', viewSignature = '', viewDirty = false, timelineSignature = '';
let lastStateAt = 0, lastDetailAt = 0, settingsEpoch = 0, modalEpoch = 0, attachmentItems = [], composeKind = 'talk.send';
const copiedText = new Map(), notified = new Set(); let notificationBaseline = false;
const ACTION_WRITE = action => !['worker.detail', 'job.detail', 'tasks.list', 'image.read', 'usage.read', 'project.detail'].includes(action);
const device = () => state.devices.find(d => d.id === selected);
const writable = () => online && !backendIssue && (!lastStateAt || Date.now() - lastStateAt < 30000) && device()?.online && device()?.role !== 'viewer';
const snap = () => device()?.snapshot || {};
const keyFor = worker => JSON.stringify([selected, worker]);
const favorite = worker => favorites.includes(keyFor(worker));
const option = (value, label, current) => `<option value="${esc(value)}" ${value === current ? 'selected' : ''}>${esc(label)}</option>`;
const distinct = (items, key) => [...new Set((items || []).map(x => x[key]).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b), 'zh-CN'));
function empty(title, description = '', glyph = 'activity') { return `<div class="empty">${icon(glyph)}<b>${esc(title)}</b>${description ? `<p>${esc(description)}</p>` : ''}</div>`; }
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => { $('#toast').hidden = true; }, 6500); }
function savePending() { if (!set('ox-pending', JSON.stringify(pending)) && Object.keys(pending).length) toast('浏览器无法保存待确认记录，请不要关闭本页'); }
const outgoingForDevice = () => Object.values(outgoing).filter(r => r.envelope.deviceId === selected);
const unconfirmed = () => [...new Set([...Object.keys(pending), ...Object.values(outgoing).filter(r => !['confirmed', 'failed'].includes(r.phase)).map(r => r.envelope.id)])].length;
function saveOutgoing() {
  const done = UI.newest(Object.values(outgoing).filter(r => ['confirmed', 'failed'].includes(r.phase)));
  for (const r of done.slice(40)) delete outgoing[r.envelope.id];
  if (!set('ox-outgoing', JSON.stringify(outgoing))) toast('浏览器无法保存发送状态，请在确认送达前保持本页打开');
}
function clearPrivateBrowserState() {
  try { sessionStore.clear(); } catch {}
  UI.remove(localStore, 'ox-directory-cache'); pending = {}; state = { devices: [], commands: [] }; detail = null; openedWorker = ''; selected = ''; lastStateAt = 0;
  outgoing = {}; for (const items of deliveryFiles.values()) for (const item of items) URL.revokeObjectURL(item.url);
  deliveryFiles.clear(); detailCache.clear(); usageCache.clear();
  projectCache.clear(); projectErrors.clear(); openedProject = ''; taskScope = null;
  settingsEpoch++; copiedText.clear(); draftMemory.clear(); notified.clear(); notificationBaseline = false; cleanupAttachments(); closeModal();
}
async function api(path, body) {
  if (deploymentPending) { backendIssue = errors.HUB_NOT_CONFIGURED; connection(); throw Object.assign(Error(backendIssue), { code: 'HUB_NOT_CONFIGURED' }); }
  const session = me, changed = () => Object.assign(Error('手机会话已切换，原操作不再继续'), { code: 'SESSION_CHANGED' });
  let response;
  try { response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', headers: body === undefined ? {} : { 'content-type': 'application/json', 'x-ox-csrf': me?.csrf || '' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) }); }
  catch { if (me !== session) throw changed(); online = false; connection(); throw Error('网络未连接；已提交操作可能尚待确认，请勿重复派活'); }
  if (me !== session) throw changed();
  let result;
  try { result = await response.json(); if (!result || typeof result !== 'object' || Array.isArray(result)) throw Error(); }
  catch { if (me !== session) throw changed(); backendIssue = errors.HUB_UNAVAILABLE; connection(); throw Object.assign(Error(backendIssue), { code: 'HUB_UNAVAILABLE' }); }
  if (me !== session) throw changed();
  if (!response.ok) {
    backendIssue = (response.status >= 500 && result.error !== 'DEVICE_OFFLINE') || result.error === 'GATEWAY_AUTH_FAILED' ? errors[result.error] || errors.HUB_UNAVAILABLE : '';
    if (response.status === 401 && me) { me = null; clearPrivateBrowserState(); showLogin(); }
    connection();
    const code = response.status >= 500 && !['HUB_NOT_CONFIGURED', 'DEVICE_OFFLINE'].includes(result.error) ? 'HUB_UNAVAILABLE' : result.error || 'HTTP_ERROR';
    throw Object.assign(Error(errors[code] || result.error || `HTTP ${response.status}`), { code });
  }
  backendIssue = ''; online = true; return result;
}
function connection() {
  const d = device(), stale = lastStateAt && Date.now() - lastStateAt >= 30000;
  if ($('#login-status')) $('#login-status').textContent = backendIssue || (!online ? '网络未连接，请恢复网络后重试。' : passwordLogin ? '输入固定登录密码。登录后保留此手机凭证，不用每次输入。' : '使用一次性配对码连接，配对码 10 分钟有效。');
  const text = !online ? '网络离线' : backendIssue ? '中转未就绪' : !me ? '等待登录' : !d ? '等待工厂接入' : !d.online || stale ? '工厂离线' : me.role === 'viewer' ? '只读 · 已连接' : '工厂在线';
  $('#connection').textContent = text;
  if ($('#connection').dataset) $('#connection').dataset.tone = !online || backendIssue || (me && (!d?.online || stale)) ? 'bad' : !me ? 'neutral' : 'good';
  const banner = $('#banner');
  banner.hidden = Boolean(online && !backendIssue && !stale && (!me || d?.online));
  banner.textContent = backendIssue || (!online ? '网络已断开。保留上次读取的内容；不会离线自动发送消息或任务。' : stale ? '同步状态已过期，请刷新确认。当前禁止提交，防止误操作。' : !d ? '等待工厂电脑的 Connector 接入。网页登录成功不代表工厂已经在线。' : '工厂电脑暂时离线，当前是最近快照。请保持电脑和 Connector 运行，恢复后再操作。');
  if ($('#sync-status')) $('#sync-status').textContent = polling ? '正在同步…' : lastStateAt ? `工厂上报 ${UI.relative(d?.snapshot?.observedAt || d?.lastSeenAt)} · ${UI.relative(lastStateAt)}检查` : '尚未取得实时状态';
  if ($('#scope-status')) $('#scope-status').textContent = UI.roles[d?.role || me?.role] || '';
  document.querySelectorAll?.('[data-write]').forEach(n => { n.disabled = !writable() || n.dataset.busy === 'true'; });
  const submit = $('#send'); if (submit) submit.disabled = !writable();
  const badge = $('#pending-badge'); if (badge) { const n = unconfirmed(); badge.hidden = !n; badge.textContent = n > 9 ? '9+' : String(n); }
  if ($('#chat-connection')) $('#chat-connection').textContent = !online ? '网络离线' : backendIssue ? '中转未就绪' : !d?.online || stale ? '工厂离线' : '在线';
}
function showLogin() { if (document.body) document.body.dataset.view = 'login'; $('#login').hidden = false; $('#workspace').hidden = true; $('#nav').hidden = true; connection(); }
function showWorkspace() {
  if (me) for (const [id, r] of Object.entries(outgoing)) {
    if (r.sessionId !== me.id) { delete outgoing[id]; delete pending[id]; }
    else if (r.phase === 'preparing' && !deliveryTasks.has(id)) { r.phase = 'failed'; r.error = '图片上传因页面关闭而中断，消息未提交。请重新选择图片后发送。'; }
    else if (r.phase === 'submitting' && !deliveryTasks.has(id)) { r.phase = 'uncertain'; r.error = '上次提交结果未确认，请查询原请求。'; }
  }
  $('#login').hidden = true; $('#workspace').hidden = false; $('#nav').hidden = false; connection(); if (me) api('/api/push').then(r => { pushSubscribed = r.subscribed; }).catch(() => {});
}
function renderDevicePicker() {
  if (!state.devices.some(d => d.id === selected)) { selected = state.devices[0]?.id || ''; openedWorker = ''; openedProject = ''; taskScope = null; detail = null; cleanupAttachments(); closeModal(); }
  const html = state.devices.length ? state.devices.map(d => option(d.id, `${d.name} · ${d.online ? '在线' : '离线'}`, selected)).join('') : '<option value="">等待工厂设备连接</option>';
  if ($('#device').innerHTML !== html) $('#device').innerHTML = html;
  set('ox-device', selected); connection();
}
async function refresh({ force = false } = {}) {
  if (!me || polling) return; const session = me; polling = true; connection();
  try {
    const next = await api('/api/state'); if (me !== session) return;
    if (!Array.isArray(next.devices) || !Array.isArray(next.commands)) throw Error('工厂目录格式异常');
    for (const d of next.devices) for (const job of d.snapshot?.jobs || []) {
      const key = `${d.id}:${job.id}:${job.status}`;
      if (UI.terminal(job.status) && !notified.has(key)) { if (notificationBaseline) notify(job); notified.add(key); }
    }
    const signature = JSON.stringify([next.devices.map(d => [d.id, d.online, d.role, d.snapshot?.workers, d.snapshot?.jobs, d.snapshot?.tasks, d.snapshot?.requests, d.snapshot?.projects, d.snapshot?.projectsAvailable]), next.commands]);
    viewDirty ||= signature !== viewSignature; viewSignature = signature; notificationBaseline = true; state = next; lastStateAt = Date.now();
    reconcileOutgoing(state.commands);
    for (const c of state.commands) if (['done', 'failed'].includes(c.state) && pending[c.id]) { delete pending[c.id]; savePending(); }
    if (pref('ox-cache-enabled') === 'yes') UI.write(localStore, 'ox-directory-cache', JSON.stringify({ devices: state.devices.map(d => ({ id: d.id, name: d.name, online: false, lastSeenAt: d.lastSeenAt, role: 'viewer', snapshot: { workers: d.snapshot?.workers || [] } })), commands: [] }));
    renderDevicePicker();
    const editing = document.activeElement?.matches?.('input,textarea,select') && $('#content').contains?.(document.activeElement);
    if ((viewDirty || force) && !openedWorker && tab !== 'settings' && !$('#dialog').open && !editing) { render(); viewDirty = false; }
    return next;
  } catch (error) { connection(); if (force) toast(error.message); }
  finally { polling = false; connection(); }
}
async function runCommand(action, body, { retry = null, deviceId = selected, onProgress = () => {} } = {}) {
  const targetId = retry?.deviceId || deviceId;
  if (!online || backendIssue || !state.devices.find(d => d.id === targetId)?.online) throw Error('设备或网络离线，没有提交操作');
  const signature = JSON.stringify([targetId, action, body]);
  let envelope = retry || Object.values(pending).find(p => p.signature === signature)?.envelope;
  if (!envelope) {
    const inFlight = Object.values(pending).find(p => p.envelope.deviceId === targetId && p.envelope.action === action && p.envelope.body.worker === body.worker);
    if (inFlight && ACTION_WRITE(action)) throw Error('上一条同类操作尚待确认，请先到动态页查看原请求');
    envelope = { id: crypto.randomUUID(), deviceId: targetId, action, body, createdAt: Date.now() };
  }
  if (ACTION_WRITE(action) && action !== 'image.upload') { pending[envelope.id] = { signature, envelope }; savePending(); }
  onProgress('正在发送到中转…'); let response;
  try { response = await api('/api/commands', envelope); }
  catch (error) { if (error.code && !['INTERNAL_ERROR', 'HUB_UNAVAILABLE'].includes(error.code)) { delete pending[envelope.id]; savePending(); } throw error; }
  let command = response.command; onProgress('中转已接收，等待工厂确认…');
  for (let i = 0; !['done', 'failed'].includes(command.state) && i < 25; i++) {
    await new Promise(resolve => setTimeout(resolve, 800));
    command = (await api(`/api/commands/${encodeURIComponent(envelope.id)}`)).command;
    if (command.state === 'delivering') onProgress('正在送达工厂，保留同一请求编号…');
  }
  if (!['done', 'failed'].includes(command.state)) throw Error('中转已接收，工厂尚未确认。请到动态页查询原请求，不要重复提交');
  delete pending[envelope.id]; savePending(); connection();
  if (!command.result?.ok) throw Error((errors[command.result?.error] || command.result?.error || '操作失败') + (command.result?.mayHaveExecuted ? '；可能已被接收，请先检查原工厂记录' : ''));
  onProgress('工厂已确认接收'); return command.result.data;
}
function route(nextTab, worker = '', assign = false, push = true, persistDraft = true, project = '') {
  if (persistDraft) saveDraft(); cleanupAttachments(); closeModal(); settingsEpoch++; tab = nextTab; openedWorker = worker; detail = null; timelineSignature = ''; chatQuery = ''; chatFilter = ''; chatLimit = 20; readingOnly = false;
  const cached = worker && detailCache.get(JSON.stringify([me?.id, selected, worker]));
  if (cached) { detail = cached.detail; lastDetailAt = cached.at; } else lastDetailAt = 0;
  openedProject = nextTab === 'projects' ? project : ''; projectPane = 'overview';
  if (push) history.pushState({ ox: true, tab, worker, assign, deviceId: selected, project: openedProject }, '', location.pathname);
  if (worker) { recent[keyFor(worker)] = Date.now(); set('ox-recent', JSON.stringify(recent)); composeKind = assign ? 'task.assign' : 'talk.send'; }
  render(); if (worker) void refreshDetail();
  window.scrollTo?.({ top: 0, behavior: 'instant' });
}
function render() {
  if (document.body) document.body.dataset.view = openedWorker ? 'chat' : tab;
  $('#nav').querySelectorAll('button[data-tab]').forEach(b => { const active = b.dataset.tab === (openedWorker ? 'workers' : tab); b.classList.toggle('active', active); b.setAttribute('aria-current', active ? 'page' : 'false'); });
  if (openedWorker) renderWorker();
  else if (tab === 'home') renderHome(); else if (tab === 'projects') openedProject ? renderProjectDetail() : renderProjects(); else if (tab === 'workers') renderWorkers(); else if (tab === 'tasks') renderTasks(); else if (tab === 'activity') renderActivity(); else if (tab === 'usage') renderUsage(); else void settings();
  connection();
}
function renderHome() {
  const s = snap(), ws = s.workers || [], counts = UI.taskStats(s.tasks), working = (s.jobs || []).filter(j => UI.busy(j.status)).length;
  const nPending = new Set([...Object.values(pending).filter(p => p.envelope.deviceId === selected).map(p => p.envelope.id), ...outgoingForDevice().filter(r => !['confirmed', 'failed'].includes(r.phase)).map(r => r.envelope.id)]).size;
  const recentWorkers = UI.workerList(ws, { favorites, recent, deviceId: selected }).slice(0, 4), jobs = UI.newest(s.jobs).slice(0, 4);
  const hour = new Date().getHours(), greeting = hour < 6 ? '夜深了，辛苦了。' : hour < 12 ? '早上好，开个好头。' : hour < 18 ? '下午好，继续向前。' : '晚上好，看看进展。';
  $('#content').innerHTML = `<section class="hero"><span class="eyebrow">FACTORY AT A GLANCE · ${esc(new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }))}</span><h2>${greeting}</h2><p>${device()?.online ? `${ws.length} 位员工在这里，下一件事交给工厂。` : '工厂暂时离线。先查看最近状态，恢复后再安排任务。'}</p><span class="hero-deco" aria-hidden="true">牛</span></section><div class="stats"><button class="stat" data-tab="workers"><b>${ws.length}</b><span>工厂员工</span></button><button class="stat highlight" data-tab="activity" data-activity-filter="running"><b>${working}</b><span>正在执行</span></button><button class="stat" data-tab="tasks"><b>${counts.todo + counts.doing + counts.review + counts.other}</b><span>未完成任务</span></button><button class="stat" data-tab="activity" data-activity-filter="failed"><b>${(s.jobs || []).filter(j => j.status === 'failed').length}</b><span>失败待关注</span></button></div><div class="quick-actions"><button data-tab="workers">${icon('send')}找员工派活 ${icon('arrow')}</button><button data-new-task data-write>${icon('plus')}新建看板任务 ${icon('arrow')}</button></div>${nPending ? `<div class="notice-card"><div><b>${nPending} 个操作待确认</b><p>不要重复发送，先查看原请求。</p></div><button data-tab="activity" data-activity-filter="receipts">去查看</button></div>` : ''}<div class="overview-grid"><section><div class="section-head"><h3>常用与最近员工</h3><button class="text-button" data-tab="workers">全部员工 ${icon('arrow')}</button></div><div class="mini-list">${recentWorkers.map(w => `<button class="mini-row" data-worker="${esc(w.id)}"><span class="avatar small">${esc(w.name?.slice(0, 1))}</span><span class="grow"><span>${esc(w.name)} ${favorite(w.id) ? '★' : ''}</span><span class="muted">${esc(w.role || '员工')} · ${esc(w.backend)}</span></span>${status(device()?.online ? w.status : 'offline')}${icon('arrow')}</button>`).join('') || empty('还没有员工目录', '工厂电脑接入后，员工会自动出现。', 'workers')}</div></section><section><div class="section-head"><h3>最近进展</h3><button class="text-button" data-tab="activity">全部动态 ${icon('arrow')}</button></div><div class="mini-list">${jobs.map(j => `<button class="mini-row" data-job="${esc(j.id)}"><span class="grow"><span class="clamp">${esc(j.task || '员工对话')}</span><span class="muted">${esc(j.worker)} · ${UI.relative(j.updatedAt || j.createdAt)}</span></span>${status(j.status)}</button>`).join('') || empty('进展会出现在这里', '任务接管、执行和回传都以原工厂为准。')}</div></section></div>`;
}
function workerCard(w) {
  const latest = UI.newest(snap().jobs).find(j => j.worker === w.id);
  const activeAt = w.lastInteractionAt || latest?.updatedAt || latest?.createdAt;
  return `<article class="card worker-card"><div class="card-top"><div class="avatar">${esc(w.name?.slice(0, 1) || '牛')}</div><div class="grow"><h3>${esc(w.name)}</h3><div class="muted">${esc(w.role || '员工')} · ${esc(w.backend)}</div></div><button class="favorite-button" data-favorite="${esc(w.id)}" aria-label="${favorite(w.id) ? '取消常用' : '设为常用'}：${esc(w.name)}" aria-pressed="${favorite(w.id)}">${icon('star')}</button></div><div class="worker-status">${status(device()?.online ? w.status : 'offline')}<span class="muted">${activeAt ? UI.relative(activeAt) + '有消息或进展' : '尚无运行记录'}</span></div><div class="actions"><button data-worker="${esc(w.id)}">查看对话</button><button class="primary" data-assign="${esc(w.id)}" data-write ${!writable() ? 'disabled' : ''}>${icon('plus')}派活</button></div></article>`;
}
const currentProject = (key = openedProject) => UI.projectList(snap()).find(p => p.key === key);
const projectCacheKey = () => JSON.stringify([me?.id, selected, openedProject]);
function projectBadge(p) { return status(p.status === 'paused' ? 'offline' : p.status === 'active' ? 'running' : p.status === 'activity' ? 'pending' : 'done', UI.projectStatuses[p.status] || p.status); }
function renderProjects() {
  const all = UI.projectList(snap()), registered = all.filter(p => p.source === 'entity').length;
  $('#content').innerHTML = `<div class="section-head"><div><span class="eyebrow">PROJECTS & PROGRESS</span><h2>项目空间</h2></div><span class="badge">与电脑同源</span></div><section class="project-intro"><div class="project-intro-icon">${icon('projects')}</div><div><h3>把一件事，从头看到尾。</h3><p>${registered} 个登记项目 · ${all.length - registered} 个活动分组</p></div></section><label class="search-wrap">${icon('search')}<input id="project-search" type="search" aria-label="搜索项目" placeholder="搜索项目、简介或成员" value="${esc(projectQuery)}"></label><div class="chips">${[['', '全部'], ['registered', '登记项目'], ['active', '进行中'], ['paused', '已暂停'], ['done', '已完成'], ['activity', '活动分组']].map(([v, label]) => `<button data-project-filter="${v}" class="${projectFilter === v ? 'active' : ''}" aria-pressed="${projectFilter === v}">${label}</button>`).join('')}</div><div class="filter-bar"><span id="project-count" class="muted"></span><select id="project-sort" aria-label="项目排序">${option('activity', '最近进展', projectSort)}${option('name', '按名称', projectSort)}</select></div>${!snap().capabilities?.includes('project.detail') || snap().projectsAvailable === false ? '<p class="banner">正式项目目录暂未同步，当前只能查看已有任务/执行的活动分组；需要连接组件同步，并非项目被删除。</p>' : ''}${snap().projectsTruncated ? '<p class="banner">仅同步最近 200 个登记项目，更多请在电脑查看。</p>' : ''}<div id="project-cards" class="project-grid"></div><p class="receipt-note">登记项目来自电脑端项目目录。活动分组来自已有记录上的项目名，不会自动创建正式项目；计数仅覆盖当前同步的任务与运行。</p>`;
  $('#project-search').oninput = e => { projectQuery = e.target.value; renderProjectCards(); };
  $('#project-sort').onchange = e => { projectSort = e.target.value; renderProjectCards(); }; renderProjectCards();
}
function renderProjectCards() {
  const list = UI.projectList(snap(), { query: projectQuery, status: projectFilter, sort: projectSort });
  $('#project-count').textContent = `${list.length} 个匹配`;
  $('#project-cards').innerHTML = list.map(p => `<button class="card project-card" data-project="${esc(p.key)}"><div class="card-footer"><span class="project-symbol">${icon('projects')}</span>${projectBadge(p)}</div><h3>${esc(p.name)}</h3><p class="clamp project-summary">${esc(p.summary || '暂未填写项目简介')}</p><div class="project-card-stats"><span><b>${p.tasks.length}</b> 快照任务</span><span><b>${p.runningCount}</b> 执行中</span><span><b>${p.participants.length}</b> 相关员工</span></div><div class="project-card-footer"><span>${p.source === 'entity' ? '登记项目' + (p.priority ? ' · ' + esc(p.priority) : '') : '未登记 · 活动分组'}</span><span>${UI.relative(p.lastActivity)} ${icon('arrow')}</span></div></button>`).join('') || empty('暂无匹配项目', projectQuery || projectFilter ? '清除搜索或切换筛选看看。' : '电脑端登记的项目将在这里同步；手机不创建另一套项目库。', 'projects');
}
function projectResource(ref, label, note = '') {
  if (!ref) return ''; const href = UI.safeLink(ref);
  return `<div class="project-resource"><b>${esc(label || '参考资料')}</b>${href ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(ref)} ↗</a>` : `<code>${esc(ref)}</code><small>本机路径或非网页引用，请在电脑查看</small>`}${note ? `<p>${esc(note)}</p>` : ''}</div>`;
}
function projectJob(j) { return `<button class="card list-card" data-job="${esc(j.id)}"><div class="job-title clamp">${esc(j.task || '员工执行')}</div><div class="job-meta">${esc(j.worker)} · ${time(j.updatedAt || j.createdAt)}</div>${status(j.status)}${j.summary ? `<p class="receipt-note clamp">${esc(j.summary)}</p>` : ''}</button>`; }
function renderProjectDetail() {
  const p = currentProject(); if (!p) { $('#content').innerHTML = `<button data-tab="projects">${icon('back')}返回项目</button>${empty('项目暂不可见', '它可能已归档，或不在这次同步的目录内。', 'projects')}`; return; }
  const key = projectCacheKey(), cache = projectCache.get(key), data = cache?.value, full = data?.project, loading = projectReads.has(key), error = projectErrors.get(key), supported = snap().capabilities?.includes('project.detail');
  const info = full || p, members = (info.members || []).filter(m => m.status !== 'inactive'), jobs = data?.relatedJobs?.recent || p.jobs.slice(0, 20);
  const memberCards = members.map(m => { const w = (snap().workers || []).find(w => w.id === m.worker || w.name === m.worker); return `<div class="project-member"><span class="avatar small">${esc(m.worker.slice(0, 1))}</span><div class="grow"><b>${esc(w?.name || m.worker)}</b><small>${esc(({ owner: '负责人', lead: '牵头', developer: '开发', contributor: '参与' })[m.relation] || m.relation || '成员')}</small></div>${w ? `<button data-worker="${esc(w.id)}">对话</button>` : '<span class="muted">目录外</span>'}</div>`; }).join('');
  let body = '';
  if (projectPane === 'overview') {
    const progress = full?.progress || [];
    body = `<section class="project-section"><div class="section-head"><h3>相关员工</h3><span class="badge">${members.length || p.participants.length}</span></div>${memberCards || p.participants.map(worker => { const w = (snap().workers || []).find(w => w.id === worker); return w ? `<button class="project-worker-chip" data-worker="${esc(w.id)}">${esc(w.name)} ${icon('arrow')}</button>` : `<span class="badge">${esc(worker)}</span>`; }).join('') || empty('暂无成员记录', '关联任务后也会显示相关员工。', 'workers')}</section><section class="project-section"><div class="section-head"><h3>项目进展</h3><span class="badge">登记记录</span></div>${progress.length ? progress.slice(0, 5).map(t => `<article class="project-progress"><div class="job-meta">${time(t.updatedAt)} · ${esc(t.owner || '项目记录')}</div><p>${esc(t.text)}</p>${t.status ? `<span class="badge">${esc(t.status)}</span>` : ''}${t.evidence ? projectResource(t.evidence, '进展证据') : ''}</article>`).join('') : empty(p.source === 'activity' ? '尚未登记项目进展' : full ? '暂无登记进展' : '项目详情同步中', '可先在“动态”查看关联运行。')}${progress.length > 5 ? '<p class="receipt-note">显示最近 5 条登记进展，更多请在电脑查看。</p>' : ''}</section>${data?.responsibilities?.length ? `<section class="project-section"><h3>项目职责</h3>${data.responsibilities.map(r => `<p class="receipt-note"><b>${esc(r.worker)}</b> · ${esc(r.scope || r.relation)}${r.note ? '<br>' + esc(r.note) : ''}</p>`).join('')}</section>` : ''}`;
  } else if (projectPane === 'tasks') {
    body = `<section class="project-section"><div class="section-head"><h3>全局看板任务</h3><button data-project-tasks="${esc(p.key)}">筛选查看 ${icon('arrow')}</button></div><p class="section-help">当前快照 ${p.tasks.length} 条；与项目登记待办分开，不重复计为同一种任务。</p>${p.tasks.map(taskCard).join('') || empty('暂无关联看板任务', '可用“新建任务”创建带项目归属的任务。', 'tasks')}</section><section class="project-section"><div class="section-head"><h3>项目登记待办</h3><span class="badge">只读</span></div>${full?.todos?.length ? full.todos.map(t => `<article class="project-todo"><div class="card-footer"><b>${esc(t.title)}</b>${status(t.status === 'blocked' ? 'failed' : t.status === 'doing' ? 'running' : t.status === 'done' ? 'done' : 'pending', UI.projectTodoStatuses[t.status] || t.status)}</div><p class="job-meta">${esc(t.owner || '未指定负责人')} · ${time(t.updatedAt)}</p>${t.note ? `<p>${esc(t.note)}</p>` : ''}${t.evidence ? projectResource(t.evidence, '证据') : ''}</article>`).join('') : empty(full || p.source === 'activity' ? '暂无登记待办' : '详情尚未读到', '项目登记待办由电脑端管理。', 'tasks')}</section>`;
  } else if (projectPane === 'activity') {
    body = `<section class="project-section"><div class="section-head"><h3>最近运行</h3><span class="badge">${jobs.length} 条</span></div><p class="section-help">${data ? `电脑统计关联 ${data.relatedJobs.total} 次运行，最多展示最近 20 条。` : '先显示当前同步快照中的关联运行。'}接收回执不等于执行完成。</p>${jobs.map(projectJob).join('') || empty('暂无关联运行', '从本项目准备派活后，执行进展会归入这个项目。')}</section>`;
  } else {
    body = `<section class="project-section"><h3>项目资料</h3>${projectResource(full?.truth?.ref, '主要文档', full?.truth?.note)}${(full?.links || []).map(l => projectResource(l.ref, l.label || l.type, l.note)).join('') || (!full?.truth ? empty(full || p.source === 'activity' ? '暂无资料引用' : '详情尚未读到', '网页引用可打开；本机文件不会被直接暴露到公网。', 'projects') : '')}<p class="receipt-note">资料引用来自原项目，手机不会自动读取任意文件或下载链接。</p></section><section class="project-section"><h3>项目标识与别名</h3><code class="project-id">${esc(p.id)}</code><p>${(p.aliases || []).map(a => `<span class="badge">${esc(a)}</span>`).join('') || '暂无别名'}</p></section>`;
  }
  $('#content').innerHTML = `<div class="section-head project-detail-head"><button class="icon-button" data-tab="projects" aria-label="返回项目列表">${icon('back')}</button><span class="grow muted">${p.source === 'entity' ? '登记项目 · 与电脑同源' : '未登记 · 活动分组'}</span>${p.source === 'entity' ? `<button class="icon-button" data-project-refresh aria-label="刷新项目详情" ${loading || !device()?.online || !supported ? 'disabled' : ''}>${icon('refresh')}</button>` : ''}</div><section class="project-detail-hero"><div class="card-footer">${projectBadge(info)}<span class="badge">${esc(info.priority || 'PROJECT')}</span></div><h2>${esc(info.name)}</h2><p>${esc(info.summary || '暂无项目简介')}</p><div class="project-card-stats"><span><b>${p.tasks.length}</b> 快照任务</span><span><b>${p.runningCount}</b> 快照执行中</span><span><b>${info.todoCounts?.open ?? '—'}</b> 登记待办</span></div></section><div class="project-actions"><button class="primary" data-project-new-task="${esc(p.key)}" data-write ${!writable() ? 'disabled' : ''}>${icon('plus')}新建任务</button><button data-project-assign="${esc(p.key)}" data-write ${!writable() ? 'disabled' : ''}>${icon('send')}准备派活</button></div>${p.source === 'activity' ? '<p class="receipt-note">这是已有记录的项目名分组，不是正式登记项目；可按此名称创建任务，不会自动登记项目。</p>' : `<p class="project-read-status" role="status">${loading ? '详细信息同步中，可以先看快照或切页…' : error ? esc(error) + '；保留已读快照，可重试。' : cache ? '详情 ' + UI.relative(cache.at) + '读取 · 快照数据可能更新得更快' : '等待读取项目详情'}</p>`}${full?.truncated ? '<p class="banner">部分登记内容较长，手机仅展示限量记录，完整内容请在电脑查看。</p>' : ''}<div class="chips project-tabs">${[['overview', '概况'], ['tasks', '任务'], ['activity', '动态'], ['resources', '资料']].map(([id, label]) => `<button data-project-pane="${id}" class="${projectPane === id ? 'active' : ''}" aria-pressed="${projectPane === id}">${label}</button>`).join('')}</div><div id="project-panel">${body}</div>`;
  if (p.source === 'entity' && supported && device()?.online && !cache && !loading && !error) void loadProject();
}
async function loadProject() {
  const p = currentProject(), key = projectCacheKey(), target = selected, session = me;
  if (!p || p.source !== 'entity' || projectReads.has(key) || !device()?.online || !snap().capabilities?.includes('project.detail')) return;
  projectReads.add(key); projectErrors.delete(key); renderProjectDetail();
  try {
    const value = await runCommand('project.detail', { projectId: p.id }, { deviceId: target });
    if (me !== session || !state.devices.some(d => d.id === target)) return;
    if (value.project?.id !== p.id) throw Error('项目详情不匹配');
    if (projectCache.size >= 8) projectCache.delete(projectCache.keys().next().value);
    projectCache.set(key, { value, at: Date.now() });
  } catch (e) { if (me === session) projectErrors.set(key, e.message); }
  finally { projectReads.delete(key); if (me === session && tab === 'projects' && key === projectCacheKey()) renderProjectDetail(); }
}
function openProjectTasks(key) {
  const p = currentProject(key); if (!p) return;
  const aliases = p.source === 'entity' ? [p.name, ...(p.aliases || [])].filter(label => UI.projectForLabel(snap().projects || [], label)?.id === p.id) : [];
  taskScope = { deviceId: selected, key: p.key, name: p.name, id: p.id, labels: [...new Set([p.id, ...aliases, ...p.tasks.map(t => t.project)])] };
  taskProject = p.id; taskStatus = taskAssignee = taskFilter = ''; route('tasks');
}
function prepareProjectAssignment(key) {
  const p = currentProject(key), d = device(), session = me; if (!p || !writable()) return;
  const ws = [...(snap().workers || [])].sort((a, b) => Number(p.participants.includes(b.id)) - Number(p.participants.includes(a.id)));
  modal(`<h2>为项目准备派活</h2><p class="dialog-context">${esc(d.name)} · ${esc(p.name)}</p><p class="muted">选择员工后进入派活草稿，项目会自动填好；不会立即执行。</p><form id="project-assignment"><label>负责员工<select name="worker" required>${option('', '请选择员工', '')}${ws.map(w => option(w.id, w.name + (p.participants.includes(w.id) ? ' · 项目相关' : ''), '')).join('')}</select></label><button class="primary" data-write>进入派活草稿</button></form>`);
  $('#project-assignment').onsubmit = event => {
    event.preventDefault(); if (me !== session || selected !== d.id || !writable()) return;
    const worker = new FormData(event.target).get('worker'); if (!ws.some(w => w.id === worker)) return;
    openWorker(worker, true); $('#project').value = p.id; saveDraft(); updateCompose();
    $('#compose-panel').hidden = false; $('#compose-toggle').setAttribute('aria-expanded', 'true'); toast('已填入项目，仍需填写任务并确认派活');
  };
}
function renderWorkers() {
  $('#content').innerHTML = `<div class="section-head"><div><span class="eyebrow">YOUR PEOPLE</span><h2>员工工作台</h2></div><span class="badge">${snap().workers?.length || 0} 位员工</span></div><label class="search-wrap">${icon('search')}<input id="search" type="search" aria-label="查找员工" placeholder="搜索姓名、角色、后端" value="${esc(workerFilter)}"></label><div class="chips" id="worker-chips">${[['', '全部员工'], ['favorites', '★ 常用'], ['busy', '忙碌中'], ['idle', '空闲'], ['vacation', '休假']].map(([value, name]) => `<button data-worker-filter="${value}" class="${workerStatus === value ? 'active' : ''}" aria-pressed="${workerStatus === value}">${name}</button>`).join('')}</div><div class="filter-bar"><span id="worker-count" class="muted"></span><select id="worker-sort" aria-label="员工排序">${[['activity', '最近消息'], ['favorites', '常用优先'], ['tokens', '今日 Token'], ['name', '姓名']].map(([v, label]) => option(v, label, workerSort)).join('')}</select><select id="worker-backend" aria-label="后端筛选">${option('', '全部后端', workerBackend)}${distinct(snap().workers, 'backend').map(b => option(b, b, workerBackend)).join('')}</select></div><div id="worker-cards" class="cards"></div>`;
  $('#search').oninput = event => { workerFilter = event.target.value; renderWorkerCards(); };
  $('#worker-backend').onchange = event => { workerBackend = event.target.value; renderWorkerCards(); }; $('#worker-sort').onchange = e => { workerSort = e.target.value; savePreference('ox-worker-sort', workerSort); renderWorkerCards(); }; renderWorkerCards();
}
function renderWorkerCards() {
  const list = UI.workerList(snap().workers, { query: workerFilter, status: workerStatus, backend: workerBackend, favorites, recent, deviceId: selected, activity: UI.workerActivity(snap(), outgoingForDevice()), sort: workerSort });
  $('#worker-count').textContent = `${list.length} 位匹配 · ${workerSort === 'activity' ? '与电脑同口径：最近交互优先' : workerSort === 'name' ? '按姓名' : workerSort === 'tokens' ? '今日 Token 优先' : '常用优先'}`;
  $('#worker-cards').innerHTML = list.map(workerCard).join('') || empty('没有匹配的员工', workerStatus === 'favorites' ? '点击员工右上角的星标，加入常用列表。' : '试试其他关键词，或清除筛选条件。', 'workers');
}
function taskCard(t) { return `<button class="card list-card" data-task="${esc(t.id)}"><div class="job-title">${esc(t.title)}</div><div class="job-meta">${esc(t.project || '未分类')} · ${esc(t.assignee || '未指派')}</div><div class="card-footer">${status(t.status)}<span class="muted">${UI.relative(t.updatedAt || t.createdAt)}</span></div><p class="receipt-note">执行：${esc(t.execution?.state === 'idle' ? '未运行' : UI.labels[t.execution?.state] || t.execution?.state || '未运行')}</p></button>`; }
function renderTasks() {
  const tasks = snap().tasks || [];
  if (taskScope && taskScope.deviceId !== selected) { taskScope = null; taskProject = ''; }
  $('#content').innerHTML = `<div class="section-head"><div><span class="eyebrow">MAKE THINGS HAPPEN</span><h2>任务看板</h2></div><button class="primary" data-new-task data-write>${icon('plus')}新建</button></div><label class="search-wrap">${icon('search')}<input id="task-search" type="search" aria-label="搜索看板任务" placeholder="搜索任务、上下文或负责人" value="${esc(taskFilter)}"></label><div class="filter-grid"><label>项目<select id="task-project">${option('', '全部项目', taskProject)}${[...new Set([...(taskScope ? [taskScope.id] : []), ...distinct(tasks, 'project')])].map(v => option(v, taskScope?.id === v ? taskScope.name : v, taskProject)).join('')}</select></label><label>业务状态<select id="task-status">${option('', '全部状态', taskStatus)}${distinct(tasks, 'status').map(v => option(v, UI.labels[v] || v, taskStatus)).join('')}</select></label><label>负责员工<select id="task-assignee">${option('', '全部员工', taskAssignee)}${option('__unassigned__', '未指派', taskAssignee)}${distinct(tasks, 'assignee').map(v => option(v, v, taskAssignee)).join('')}</select></label></div><div class="filter-summary"><span id="task-count"></span><div class="actions"><button id="reset-task-filter" class="text-button">重置</button><button id="task-layout" aria-pressed="${taskLayout === 'board'}">${taskLayout === 'board' ? '切换列表' : '切换分栏'}</button></div></div><p id="task-scope-note" class="receipt-note"></p><div id="task-list"></div><p class="receipt-note">看板状态与执行状态独立；创建任务不会自动派活。业务状态支持自由填写。</p>`;
  $('#task-search').oninput = e => { taskFilter = e.target.value; renderTaskList(); };
  for (const [id, setter] of [['#task-project', v => { taskProject = v; taskScope = null; }], ['#task-status', v => taskStatus = v], ['#task-assignee', v => taskAssignee = v]]) $(id).onchange = e => { setter(e.target.value); renderTaskList(); };
  $('#reset-task-filter').onclick = () => { taskScope = null; taskFilter = taskProject = taskStatus = taskAssignee = ''; renderTasks(); };
  $('#task-layout').onclick = () => { taskLayout = taskLayout === 'board' ? 'list' : 'board'; UI.write(localStore, 'ox-task-layout', taskLayout); renderTasks(); }; renderTaskList();
}
function renderTaskList() {
  const list = UI.filterTasks(snap().tasks, { query: taskFilter, project: taskProject, projects: taskScope?.deviceId === selected ? taskScope.labels : null, status: taskStatus, assignee: taskAssignee });
  if ($('#task-scope-note')) $('#task-scope-note').textContent = taskScope ? `项目：${taskScope.name}（含匹配的名称/别名）· 只显示当前快照，点“重置”查看全部` : '';
  $('#task-count').textContent = `${list.length} / ${snap().tasks?.length || 0} 个任务${taskLayout === 'board' ? ' · 左右滑动' : ''}`;
  $('#task-list').className = taskLayout === 'board' ? 'task-board' : '';
  $('#task-list').innerHTML = taskLayout === 'board' ? Object.entries(UI.taskGroups).map(([group, label]) => { const items = list.filter(t => UI.taskGroup(t.status) === group); return `<section class="board-lane"><h3>${label}<span>${items.length}</span></h3>${items.map(taskCard).join('') || empty('暂无任务')}</section>`; }).join('') : list.map(taskCard).join('') || empty('这里还没有匹配的任务', '清除筛选，或新建一条看板任务。', 'tasks');
}
function renderActivity() {
  $('#content').innerHTML = `<div class="section-head"><div><span class="eyebrow">EVERY STEP COUNTS</span><h2>执行动态</h2></div><span class="badge">自动同步</span></div><label class="search-wrap">${icon('search')}<input id="activity-search" type="search" aria-label="搜索执行动态" placeholder="搜索员工、项目或任务内容" value="${esc(activityQuery)}"></label><div class="chips">${[['all', '全部'], ['running', '执行中'], ['done', '已完成'], ['failed', '失败'], ['receipts', '送达回执']].map(([id, name]) => `<button data-activity-filter="${id}" class="${id === activityFilter ? 'active' : ''}" aria-pressed="${id === activityFilter}">${name}</button>`).join('')}</div><div id="activity-list"></div>`;
  $('#activity-search').oninput = e => { activityQuery = e.target.value; renderActivityList(); }; renderActivityList();
}
function renderActivityList() {
  const activePending = Object.values(pending).filter(p => p.envelope.deviceId === selected && !outgoing[p.envelope.id]);
  let html = activePending.map(p => `<article class="card pending-card"><h3>送达待确认</h3><p class="muted">${esc(UI.actions[p.envelope.action] || p.envelope.action)} · ${esc(p.envelope.body.worker || '当前工厂')}</p><p class="clamp">${esc(p.envelope.body.message || p.envelope.body.title || '保留原操作编号，避免重复提交')}</p><button data-retry="${esc(p.envelope.id)}" ${!device()?.online ? 'disabled' : ''}>查询 / 重试原请求</button></article>`).join('');
  const deliveries = UI.newest(outgoingForDevice()).filter(r => UI.match(activityQuery, [r.envelope.body.message, r.envelope.body.worker, r.envelope.body.project]) && (['all', 'receipts'].includes(activityFilter) || !['confirmed', 'failed'].includes(r.phase)));
  if (deliveries.length) html += `<div class="section-head"><h3>本手机发送记录</h3><span class="badge">切页仍会继续</span></div><p class="section-help">发送 → 中转接收 → 工厂接收 → 员工执行；各阶段分别确认。</p>` + deliveries.map(r => `<article class="card delivery-card ${['uncertain', 'failed'].includes(r.phase) ? 'pending-card' : ''}" data-delivery="${esc(r.envelope.id)}"><div class="card-footer"><strong>${esc(r.envelope.body.worker)}</strong>${deliveryBadge(r)}</div><p class="job-title clamp">${esc(r.envelope.body.message || '图片消息')}</p><p class="job-meta">${esc(UI.actions[r.envelope.action])} · ${time(r.createdAt)} · 请求 ${esc(r.envelope.id.slice(0, 8))}</p>${r.error ? `<p class="receipt-note">${esc(r.error)}</p>` : ''}<div class="actions">${deliveryRetry(r)}<button data-worker="${esc(r.envelope.body.worker)}">返回对话</button>${r.jobId ? `<button data-job="${esc(r.jobId)}">查看执行结果</button>` : ''}</div></article>`).join('');
  if (['all', 'receipts'].includes(activityFilter)) {
    const commands = UI.newest(state.commands.filter(c => c.deviceId === selected && ACTION_WRITE(c.action) && !outgoing[c.id])).filter(c => UI.match(activityQuery, [c.label, UI.actions[c.action]])).slice(0, 30);
    if (commands.length) html += '<div class="section-head"><h3>操作回执</h3></div><p class="section-help">“已接收”只表示工厂确认，不等于员工执行完成。</p>' + commands.map(c => `<article class="card"><div class="job-title clamp">${esc(c.label || UI.actions[c.action])}</div><div class="job-meta">${esc(UI.actions[c.action] || c.action)} · ${time(c.createdAt)}</div>${status(c.state, c.state === 'done' ? '工厂已确认接收' : c.state === 'failed' ? '操作未成功' : '等待送达确认')}${c.result?.error ? `<p class="receipt-note">${esc(errors[c.result.error] || c.result.error)}</p>` : ''}${c.result?.data?.request?.jobId ? `<div class="actions"><button data-job="${esc(c.result.data.request.jobId)}">查看执行结果</button></div>` : ''}</article>`).join('');
  }
  if (activityFilter !== 'receipts') {
    const jobs = UI.newest(snap().jobs).filter(j => UI.match(activityQuery, [j.task, j.project, j.worker, j.summary]) && (activityFilter === 'all' || activityFilter === 'running' && (UI.busy(j.status) || j.status === 'queued') || activityFilter === 'done' && ['done', 'completed', 'succeeded'].includes(j.status) || activityFilter === 'failed' && j.status === 'failed'));
    html += '<div class="section-head"><h3>员工运行记录</h3><span class="badge">' + jobs.length + ' 条</span></div>';
    html += jobs.map(j => `<button class="card list-card" data-job="${esc(j.id)}"><div class="job-title clamp">${esc(j.task || '员工对话')}</div><div class="job-meta">${esc(j.worker)} · ${esc(j.project || '未分类')} · ${time(j.updatedAt || j.createdAt)}</div>${status(j.status)}${j.error || j.summary ? `<p class="receipt-note clamp">${esc(j.error || j.summary)}</p>` : ''}</button>`).join('') || empty('暂无匹配的运行记录', '状态更新后会自动出现在这里。');
  }
  $('#activity-list').innerHTML = html || empty('暂无操作回执', '从这台手机提交的操作会保留可追踪的回执。');
}
function deliveryBadge(record) { return status(record.phase === 'failed' ? 'failed' : record.phase === 'confirmed' ? 'done' : 'pending', UI.deliveryLabels[record.phase]); }
function deliveryRetry(record) {
  const possible = ['accepted', 'uncertain'].includes(record.phase) || record.phase === 'failed' && record.needsFiles && deliveryFiles.has(record.envelope.id);
  return possible ? `<button data-outgoing-retry="${esc(record.envelope.id)}" ${!writable() || deliveryTasks.has(record.envelope.id) ? 'disabled' : ''}>查询 / 重试原请求</button>` : '';
}
function usageKey() { return JSON.stringify([me?.id, selected, usageDate, usageDays]); }
function snapshotUsage() {
  if (usageDate && usageDate !== snap().usageDate) return null;
  const workers = (snap().workers || []).filter(w => w.tokenToday).map(w => ({ worker: w.name, source: w.tokenToday.source, reported: { inputTokens: UI.tokenNumber(w.tokenToday.input), cachedInputTokens: UI.tokenNumber(w.tokenToday.cachedInput), outputTokens: UI.tokenNumber(w.tokenToday.output), totalTokens: UI.tokenNumber(w.tokenToday.total) } }));
  if (!workers.length) return null;
  const totals = {}; for (const key of ['inputTokens', 'cachedInputTokens', 'outputTokens', 'totalTokens']) totals[key] = workers.reduce((n, w) => n + w.reported[key], 0);
  return { preview: true, report: { date: snap().usageDate, generatedAt: snap().observedAt, workers, totals }, trend: { days: [] } };
}
function renderUsage() {
  const key = usageKey(), data = usageCache.get(key) || snapshotUsage(), supported = snap().capabilities?.includes('usage.read'), loading = usageReads.has(key);
  const r = data?.report, total = UI.tokenNumber(r?.totals?.totalTokens), input = UI.tokenNumber(r?.totals?.inputTokens), output = UI.tokenNumber(r?.totals?.outputTokens), cached = UI.tokenNumber(r?.totals?.cachedInputTokens);
  const workers = [...(r?.workers || [])].sort((a, b) => UI.tokenNumber(b.reported?.totalTokens) - UI.tokenNumber(a.reported?.totalTokens));
  const days = data?.trend?.days || [], maximum = Math.max(1, ...days.map(d => UI.tokenNumber(d.totalTokens))), cell = 360 / Math.max(1, days.length);
  const chart = days.map((d, i) => { const height = Math.round(105 * UI.tokenNumber(d.totalTokens) / maximum); return `<rect class="${d.date === r?.date ? 'selected-day' : ''}" x="${(i * cell + 2).toFixed(1)}" y="${116 - height}" width="${Math.max(1, cell - 4).toFixed(1)}" height="${Math.max(2, height)}" rx="3"><title>${esc(d.date)}：${UI.tokenNumber(d.totalTokens).toLocaleString('zh-CN')} Tokens</title></rect>`; }).join('');
  $('#content').innerHTML = `<div class="section-head"><div><span class="eyebrow">TOKEN OBSERVATORY</span><h2>用量观察</h2></div><button id="usage-refresh" class="icon-button" aria-label="刷新 Token 用量" ${loading || !supported || !device()?.online ? 'disabled' : ''}>${icon('refresh')}</button></div><section class="usage-hero"><div class="usage-hero-top"><span>${esc(r?.date || usageDate || '今日')} · ${data?.preview ? '目录快照' : '工厂统计'}</span>${icon('usage')}</div><p class="usage-total">${r ? UI.compactNumber(total) : '—'}<small>Tokens</small></p><p class="usage-caption">${r ? total.toLocaleString('zh-CN') + ' tokens · 输入含缓存，只计一次，再加输出' : '等待工厂上报，不把缺失记录算成零消耗'}</p><div class="usage-hero-footer"><span>${r?.generatedAt ? '截至 ' + time(r.generatedAt) : '读取原工厂已有统计'}</span><span>${loading ? '正在同步…' : data?.preview ? '完整报表同步中' : '只读'}</span></div></section><div class="usage-controls"><label>统计日期<input id="usage-date" type="date" value="${esc(usageDate || r?.date || snap().usageDate || '')}"></label><button id="usage-today">回到今天</button></div><div id="usage-state" role="status">${!supported ? '<p class="banner">此手机连接组件尚未提供统计能力；更新 Connector 即可，无需改动工厂核心。</p>' : usageError ? `<p class="banner">${esc(usageError)}；保留上次已读取的数据，可手动重试。</p>` : loading && !r ? '<p class="muted">正在读取用量，可以先去其他页面…</p>' : ''}</div><div class="usage-breakdown">${[['输入', input, '含缓存输入'], ['输出', output, '含已上报推理'], ['缓存输入', cached, input ? '占输入 ' + Math.min(100, cached / input * 100).toFixed(1) + '%' : '暂无命中率']].map(([name, n, note]) => `<article><span>${name}</span><strong>${r ? UI.compactNumber(n) : '—'}</strong><small>${note}</small></article>`).join('')}</div><section class="card usage-trend"><div class="section-head"><h3>最近 ${usageDays} 天</h3><div class="chips">${[7, 30].map(n => `<button data-usage-days="${n}" aria-pressed="${usageDays === n}" class="${usageDays === n ? 'active' : ''}">${n} 天</button>`).join('')}</div></div>${days.length ? `<svg viewBox="0 0 360 122" role="img" aria-label="最近 ${usageDays} 天 Token 消耗趋势"><path d="M0 118h360"></path>${chart}</svg><div class="trend-dates"><span>${esc(days[0].date)}</span><span>${esc(days.at(-1).date)}</span></div><p class="muted">合计 ${UI.compactNumber(days.reduce((n, d) => n + UI.tokenNumber(d.totalTokens), 0))} Tokens · 趋势截至工厂当前日期，非所选日期</p>` : empty('趋势待同步', '不使用模拟用量或价格。', 'usage')}</section><section class="usage-ranking"><div class="section-head"><h3>员工消耗排行</h3><span class="badge">${workers.filter(w => w.source !== 'none').length} 位有上报</span></div>${workers.slice(0, 100).map((w, i) => `<article class="usage-worker"><div class="usage-rank">${String(i + 1).padStart(2, '0')}</div><div class="grow"><div class="card-footer"><strong>${esc(w.worker)}</strong><b>${w.source === 'none' ? '未上报' : UI.compactNumber(w.reported?.totalTokens)}</b></div><progress value="${UI.tokenNumber(w.reported?.totalTokens)}" max="${Math.max(1, total)}" aria-label="${esc(w.worker)} 占所选日期用量"></progress><p>${w.source === 'session' ? '会话上报' : w.source === 'job' ? '任务上报' : '暂无上报'} · 输入 ${UI.compactNumber(w.reported?.inputTokens)} / 输出 ${UI.compactNumber(w.reported?.outputTokens)}</p></div></article>`).join('') || empty('暂无用量记录', '未上报不代表没有产生消耗。', 'usage')}</section><p class="receipt-note">沿用电脑端统计口径与工厂日期；缓存不重复累加，来源以原统计为准。${r?.warningCount ? '原统计有 ' + r.warningCount + ' 条数据警告，请在电脑查看详情。' : ''} Token 是用量记录，不是账单或余额。${data?.preview ? '当前先展示可见员工快照，完整报表返回后替换。' : ''}</p>`;
  $('#usage-date').onchange = e => { usageDate = e.target.value; usageError = ''; renderUsage(); };
  $('#usage-today').onclick = () => { usageDate = ''; usageError = ''; renderUsage(); };
  $('#usage-refresh').onclick = () => void loadUsage(true);
  if (supported && device()?.online && !usageCache.has(key) && !loading && !usageError) void loadUsage();
}
async function loadUsage(force = false) {
  const key = usageKey(), target = selected, session = me, body = { days: usageDays, ...(usageDate ? { date: usageDate } : {}) };
  if (usageReads.has(key) || !snap().capabilities?.includes('usage.read') || !device()?.online) return;
  if (!force && usageCache.has(key)) return;
  usageReads.add(key); usageError = ''; if (tab === 'usage') renderUsage();
  try {
    const result = await runCommand('usage.read', body, { deviceId: target }); if (session !== me) return;
    if (!result.report?.totals || !Array.isArray(result.report.workers) || !Array.isArray(result.trend?.days)) throw Error('用量报表格式异常');
    if (usageCache.size >= 12) usageCache.delete(usageCache.keys().next().value);
    usageCache.set(key, result);
  } catch (e) { if (session === me && usageKey() === key) usageError = e.message; }
  finally { usageReads.delete(key); if (session === me && tab === 'usage' && usageKey() === key) renderUsage(); }
}
function cleanupAttachments() { for (const item of attachmentItems) URL.revokeObjectURL(item.url); attachmentItems = []; }
function draftKey(kind = composeKind, target = selected, worker = openedWorker) { return `ox-draft-v2:${JSON.stringify([target, worker, kind])}`; }
function saveDraft() {
  if (!$('#message') || !openedWorker) return;
  const value = { message: $('#message').value, project: $('#project').value, mode: $('#send-mode').value };
  draftMemory.set(draftKey(), value);
  if (value.message || value.project) draftPersistenceOK = set(draftKey(), JSON.stringify(value)); else UI.remove(sessionStore, draftKey());
  if ($('#draft-status')) $('#draft-status').textContent = value.message ? (draftPersistenceOK ? '草稿保留在当前标签页' : '存储受限，刷新会丢失草稿') : 'Enter 换行 · Ctrl/⌘ + Enter 发送';
}
function loadDraft() {
  let value = draftMemory.get(draftKey()) || UI.json(sessionStore, draftKey(), {}); if (!value || typeof value !== 'object') value = {};
  $('#message').value = typeof value.message === 'string' ? value.message : get(`ox-draft:${selected}:${openedWorker}`);
  $('#project').value = typeof value.project === 'string' ? value.project : '';
  $('#send-mode').value = ['auto', 'queue', 'steer'].includes(value.mode) ? value.mode : 'auto';
  updateCompose();
}
function updateCompose() {
  const assign = composeKind === 'task.assign'; $('#project-label').hidden = !assign; $('#image-label').hidden = assign;
  $('#send').textContent = assign ? '派活' : '发送'; $('#send').setAttribute('aria-label', assign ? '派发任务' : '发送对话');
  $('#message').placeholder = assign ? '任务内容…' : '发消息…';
  if ($('#message').style) { $('#message').style.height = '42px'; $('#message').style.height = Math.min(160, Math.max(42, $('#message').scrollHeight || 42)) + 'px'; }
  $('#char-count').textContent = `${$('#message').value.length.toLocaleString()} / 16,000`;
  $('#draft-status').textContent = $('#message').value ? (draftPersistenceOK ? '草稿保留在当前标签页' : '存储受限，刷新会丢失草稿') : 'Enter 换行 · Ctrl/⌘ + Enter 发送';
  $('#send-hint').textContent = assign ? '派活会唤起目标员工；工厂接收不等于完成。' : '发送后可离开此页，进度在动态页查看。离线不自动提交。';
  connection();
}
async function openWorker(worker, assign = false) { route('workers', worker, assign); }
function renderWorker() {
  const w = snap().workers?.find(x => x.id === openedWorker);
  $('#content').innerHTML = `<section class="chat"><header class="chat-head"><button id="back" class="icon-button" aria-label="返回员工列表">${icon('back')}</button><div class="grow"><h2>${esc(w?.name || openedWorker)}</h2><div class="chat-subtitle"><span title="${esc(device()?.name)}">${esc(device()?.name || '当前工厂')}</span><span id="chat-connection"></span><span id="chat-read-status">${lastDetailAt ? UI.relative(lastDetailAt) + '更新 · 同步中' : '读取中'}</span></div></div><button id="reading-mode" class="icon-button" aria-label="专注阅读" aria-pressed="false">${icon('expand')}</button><button id="chat-tools-toggle" class="icon-button" aria-label="搜索与筛选对话" aria-expanded="false">${icon('search')}</button><button class="icon-button" data-tab="activity" aria-label="查看发送状态">${icon('activity')}</button></header><div id="chat-tools-panel" hidden><div class="chat-tools"><div class="chips">${[['', '全部'], ['request', '我发出的'], ['reply', '员工结果'], ['message', '站内信']].map(([id, label]) => `<button data-chat-filter="${id}" class="${chatFilter === id ? 'active' : ''}" aria-pressed="${chatFilter === id}">${label}</button>`).join('')}</div><button id="chat-refresh" class="icon-button" aria-label="刷新对话">${icon('refresh')}</button></div><label class="chat-search"><input type="search" id="chat-search" aria-label="搜索当前对话" placeholder="搜索已读取内容" value="${esc(chatQuery)}"></label></div><div id="timeline" class="timeline" role="log" aria-label="对话与执行时间线" aria-live="off"></div><div class="latest-row"><button id="jump-latest" hidden>有新内容 · 跳到最新 ↓</button></div><button id="resume-compose" class="resume-compose" hidden>${icon('send')}写消息</button><form id="compose" class="compose compact-compose"><div id="attachment-list" class="attachment-list" hidden></div><div id="compose-panel" hidden><div class="compose-options"><label>操作类型<select id="send-kind"><option value="talk.send" ${composeKind === 'talk.send' ? 'selected' : ''}>对话</option><option value="task.assign" ${composeKind === 'task.assign' ? 'selected' : ''}>派活</option></select></label><label>员工忙碌时<select id="send-mode"><option value="auto">自动排队</option><option value="queue">保持排队</option><option value="steer">优先插话</option></select></label><label id="project-label" hidden>项目<input id="project" list="known-projects" maxlength="160" placeholder="例如 mobile-pwa"><datalist id="known-projects">${[...new Set([...(snap().projects || []).map(p => p.id), ...distinct([...(snap().tasks || []), ...(snap().jobs || [])], 'project')])].map(v => `<option value="${esc(v)}"></option>`).join('')}</datalist></label></div><div class="compose-actions"><label id="image-label" class="attachment-picker" title="最多 6 张，每张 ${maxImageMiB} MiB">${icon('image')}添加图片<input id="images" class="file-input" type="file" aria-label="添加图片附件" accept="image/png,image/jpeg,image/webp,image/gif" multiple></label><span id="char-count" class="muted"></span></div><p id="draft-status" class="compose-note"></p><p id="send-hint" class="compose-note"></p><p class="compose-note">切换本应用页面不影响发送；关闭网页或系统挂起可能中断尚未到达中转的内容。</p></div><div class="compose-line"><button id="compose-toggle" class="icon-button" type="button" aria-label="附件与发送选项" aria-expanded="false">${icon('plus')}</button><textarea id="message" aria-label="内容" maxlength="16000" rows="1" placeholder="发消息…"></textarea><button id="send" class="primary" type="submit" data-write aria-label="发送对话">发送</button></div></form></section>`;
  $('#back').onclick = () => route('workers');
  $('#chat-tools-toggle').onclick = () => { const panel = $('#chat-tools-panel'); panel.hidden = !panel.hidden; $('#chat-tools-toggle').setAttribute('aria-expanded', String(!panel.hidden)); if (!panel.hidden) $('#chat-search').focus(); };
  const setReading = value => { readingOnly = value; $('#compose').hidden = value; $('#resume-compose').hidden = !value; $('#reading-mode').setAttribute('aria-pressed', String(value)); $('#reading-mode').setAttribute('aria-label', value ? '退出专注阅读' : '专注阅读'); if (value) $('#message').blur(); };
  $('#reading-mode').onclick = () => setReading(!readingOnly);
  $('#resume-compose').onclick = () => { setReading(false); $('#message').focus(); };
  $('#compose-toggle').onclick = () => { const panel = $('#compose-panel'); panel.hidden = !panel.hidden; $('#compose-toggle').setAttribute('aria-expanded', String(!panel.hidden)); };
  $('#message').oninput = () => { saveDraft(); updateCompose(); };
  $('#message').onkeydown = e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault(); if (!$('#send').disabled) $('#compose').requestSubmit(); } };
  $('#send-mode').onchange = saveDraft; $('#project').oninput = saveDraft;
  $('#send-kind').onchange = e => { saveDraft(); composeKind = e.target.value; loadDraft(); };
  $('#chat-search').oninput = e => { chatQuery = e.target.value; timelineSignature = ''; renderTimeline(); };
  $('#chat-refresh').onclick = async () => { const b = $('#chat-refresh'); b.disabled = true; try { await refreshDetail(); } finally { if (b.isConnected) b.disabled = false; } };
  $('#jump-latest').onclick = () => { $('#timeline').scrollTop = $('#timeline').scrollHeight; $('#jump-latest').hidden = true; };
  $('#images').onchange = e => {
    const files = [...e.target.files]; e.target.value = '';
    if (files.length + attachmentItems.length > 6) return toast('最多选择 6 张图片，可先移除已有附件');
    if (files.some(f => !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(f.type))) return toast('只支持 PNG、JPEG、WebP 和 GIF 图片');
    if (files.some(f => f.size > maxImageMiB * 1024 * 1024)) return toast(`单张图片不能超过 ${maxImageMiB} MiB，请先压缩`);
    for (const file of files) attachmentItems.push({ id: crypto.randomUUID(), file, url: URL.createObjectURL(file) });
    renderAttachments();
  };
  $('#compose').onsubmit = sendCompose;
  loadDraft(); renderAttachments(); renderTimeline(); connection();
}
function renderAttachments() {
  const node = $('#attachment-list'); if (!node) return; node.hidden = !attachmentItems.length;
  node.innerHTML = attachmentItems.map(item => `<div class="attachment-thumb"><img src="${esc(item.url)}" alt="${esc(item.file.name)}"><button type="button" data-remove-image="${esc(item.id)}" aria-label="移除 ${esc(item.file.name)}">×</button><small>${esc(item.file.name)} · ${(item.file.size / 1024).toFixed(0)} KB</small></div>`).join('');
}
async function sendCompose(event) {
  event.preventDefault(); if (!writable() || !me) return;
  const targetId = selected, worker = openedWorker, action = composeKind, message = $('#message').value.trim(), mode = $('#send-mode').value, project = $('#project').value.trim();
  const items = action === 'talk.send' ? [...attachmentItems] : [], draft = draftKey(action, targetId, worker);
  if (!message && !items.length) return toast('请填写内容或添加图片');
  if (Object.values(outgoing).some(r => r.envelope.deviceId === targetId && r.envelope.body.worker === worker && r.envelope.action === action && ['preparing', 'submitting', 'uncertain'].includes(r.phase))) return toast('这位员工上一条消息尚未确认到达中转，请先到动态页查看；可以切换页面或继续写草稿');
  if (unconfirmed() >= 10) return toast('待确认操作已达 10 条，请先到动态页查看');
  const body = { worker, message, mode, ...(action === 'talk.send' ? { attachmentIds: [] } : { project: project || 'mobile' }) };
  const envelope = { id: crypto.randomUUID(), deviceId: targetId, action, body, createdAt: Date.now() };
  const record = { envelope, sessionId: me.id, createdAt: envelope.createdAt, updatedAt: envelope.createdAt, phase: items.length ? 'preparing' : 'submitting', needsFiles: !!items.length, attachments: items.map(item => ({ name: item.file.name })), error: '' };
  outgoing[envelope.id] = record; if (items.length) { deliveryFiles.set(envelope.id, items); attachmentItems = []; }
  saveOutgoing(); draftMemory.delete(draft); UI.remove(sessionStore, draft); UI.remove(sessionStore, `ox-draft:${targetId}:${worker}`);
  $('#message').value = ''; saveDraft(); renderAttachments(); updateCompose();
  timelineSignature = ''; renderTimeline(); connection();
  startDelivery(record);
  toast('正在发送，可以切换页面；进度在动态页查看');
}
function deliveryViewChanged() {
  connection();
  if (openedWorker) renderTimeline();
  else if (tab === 'activity' && $('#activity-list')) renderActivityList();
}
function applyDeliveryCommand(record, command) {
  if (['confirmed', 'failed'].includes(record.phase) && !['done', 'failed'].includes(command.state)) return false;
  const phase = ['done', 'failed'].includes(command.state) ? command.result?.ok ? 'confirmed' : 'failed' : 'accepted';
  const error = phase === 'failed' ? (errors[command.result?.error] || command.result?.error || '工厂未确认成功') + (command.result?.mayHaveExecuted ? '；可能已接收，请核对原记录，勿另建重复任务' : '') : '';
  const request = command.result?.data?.request;
  if (record.phase === phase && record.error === error && record.requestId === request?.id && record.jobId === request?.jobId) return false;
  Object.assign(record, { phase, error, requestId: request?.id, jobId: request?.jobId, updatedAt: Date.now() });
  if (['confirmed', 'failed'].includes(phase)) { delete pending[record.envelope.id]; savePending(); }
  return true;
}
function reconcileOutgoing(commands) {
  let changed = false;
  for (const command of commands || []) if (outgoing[command.id]) changed = applyDeliveryCommand(outgoing[command.id], command) || changed;
  if (changed) { saveOutgoing(); deliveryViewChanged(); }
}
function startDelivery(record) {
  const id = record.envelope.id;
  if (deliveryTasks.has(id) || record.sessionId !== me?.id) return;
  if (record.needsFiles && !deliveryFiles.has(id)) return toast('本页已没有待上传图片，请重新选择图片；原消息尚未提交');
  const work = performDelivery(record, me);
  deliveryTasks.set(id, work);
  void work.finally(() => { if (deliveryTasks.get(id) === work) deliveryTasks.delete(id); if (outgoing[id] === record) deliveryViewChanged(); }).catch(() => {});
}
async function performDelivery(record, session) {
  const envelope = record.envelope, id = envelope.id;
  const current = () => me === session && outgoing[id] === record;
  const check = () => { if (!current()) throw Object.assign(Error('手机会话已切换'), { code: 'SESSION_CHANGED' }); };
  let submitted = false;
  try {
    check(); record.error = ''; record.phase = record.needsFiles ? 'preparing' : 'submitting'; saveOutgoing(); deliveryViewChanged();
    const items = deliveryFiles.get(id) || [];
    for (const item of items) {
      check();
      if (!item.attachmentId) {
        const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(Error('无法读取图片')); reader.readAsDataURL(item.file); });
        check(); const body = { worker: envelope.body.worker, name: item.file.name, mimeType: item.file.type, data };
        item.envelope ||= { id: crypto.randomUUID(), deviceId: envelope.deviceId, action: 'image.upload', body, createdAt: Date.now() };
        const result = await runCommand('image.upload', body, { deviceId: envelope.deviceId, retry: item.envelope }); check(); item.attachmentId = result.attachment.id;
      }
    }
    check(); if (record.needsFiles) envelope.body.attachmentIds = items.map(item => item.attachmentId);
    record.needsFiles = false; record.phase = 'submitting';
    pending[id] = { signature: JSON.stringify([envelope.deviceId, envelope.action, envelope.body]), envelope }; savePending(); saveOutgoing(); deliveryViewChanged();
    // This acknowledges only the Hub. Waiting for the computer is handled by the shared state poll, not the chat form.
    submitted = true; const result = await api('/api/commands', envelope); check();
    if (!result.command || result.command.id !== id) throw Error('中转回执格式异常，请查询原请求');
    applyDeliveryCommand(record, result.command); saveOutgoing(); deliveryViewChanged();
    void refresh();
  } catch (error) {
    if (!current()) return;
    // State polling may have received the final receipt while this POST timed out.
    // A late network failure must not replace a known factory result with uncertainty.
    if (submitted && ['confirmed', 'failed'].includes(record.phase)) return;
    const rejected = ['DEVICE_OFFLINE', 'ROLE_DENIED', 'DEVICE_SCOPE_DENIED', 'LOCAL_GRANT_DENIED', 'TOO_MANY_PENDING', 'REQUEST_CLOCK_OR_EXPIRY', 'PAYLOAD_TOO_LARGE', 'MESSAGE_REQUIRED', 'CREDENTIAL_REVOKED', 'LOGIN_REQUIRED'].includes(error.code);
    record.phase = submitted && !rejected ? 'uncertain' : 'failed'; record.error = error.message; record.updatedAt = Date.now();
    if (record.phase === 'failed') { delete pending[id]; savePending(); }
    saveOutgoing(); deliveryViewChanged();
  } finally {
    if (!record.needsFiles || !current()) { for (const item of deliveryFiles.get(id) || []) URL.revokeObjectURL(item.url); deliveryFiles.delete(id); }
  }
}
async function refreshDetail() {
  if (!openedWorker || !online || !device()?.online) return;
  const current = openedWorker, currentDevice = selected, session = me, key = JSON.stringify([session?.id, currentDevice, current]);
  if (detailReads.has(key)) return; detailReads.add(key);
  try {
    const result = await runCommand('worker.detail', { worker: current }, { deviceId: currentDevice });
    if (session !== me) return;
    if (detailCache.size >= 6) detailCache.delete(detailCache.keys().next().value);
    detailCache.set(key, { detail: result, at: Date.now() });
    if (openedWorker === current && selected === currentDevice) { detail = result; lastDetailAt = Date.now(); renderTimeline(); }
  }
  catch (error) {
    if (session === me && openedWorker === current && selected === currentDevice && !detail && $('#timeline')) {
      const hasOutgoing = outgoingForDevice().some(r => r.envelope.body.worker === current);
      if (hasOutgoing) { renderTimeline(); toast(`最近消息暂未读到：${error.message}；发送记录仍在动态页`); }
      else $('#timeline').innerHTML = empty('暂时无法读取', error.message);
    }
  }
  finally { detailReads.delete(key); if ($('#chat-read-status') && openedWorker === current && selected === currentDevice) $('#chat-read-status').textContent = lastDetailAt ? `${UI.relative(lastDetailAt)}更新` : '尚未读取'; }
}
function remember(key, value) { copiedText.set(key, String(value || '')); if (copiedText.size > 250) copiedText.delete(copiedText.keys().next().value); return esc(key); }
function renderTimeline({ prepend = false } = {}) {
  const node = $('#timeline'); if (!node || !openedWorker) return;
  const entries = [], seen = new Set();
  for (const r of [...(detail?.talkRequests || []), ...(detail?.requests || [])]) {
    if (seen.has(r.id)) continue; seen.add(r.id);
    entries.push({ id: 'request:' + r.id, kind: 'request', human: true, name: r.to ? '我发出的任务' : '我发出的对话', time: r.createdAt, state: r.status, text: r.message || '', attachments: r.attachments, error: r.error, jobId: r.jobId });
  }
  for (const j of detail?.jobs || []) {
    if (j.status === 'running' && j.publicConversation?.length) {
      for (const b of j.publicConversation) entries.push({ id: 'live:' + b.id, live: true, kind: b.type === 'steer' ? 'request' : 'reply', human: b.type === 'steer', name: b.type === 'steer' ? '你 · steer 已记录' : (detail.worker?.name || openedWorker) + ' · 实时交流', time: b.time || j.createdAt, text: b.text, jobId: j.id });
    } else if (j.reply || j.error || UI.busy(j.status)) entries.push({ id: 'job:' + j.id, kind: 'reply', name: detail.worker?.name || openedWorker, time: j.updatedAt || j.createdAt, state: j.status, text: j.reply || j.error || '员工正在处理，稍后自动更新…', jobId: j.id });
  }
  for (const m of (detail?.messages || []).slice(-50)) entries.push({ id: 'message:' + m.id, kind: 'message', name: `站内信 · ${m.from} → ${m.to}`, time: m.createdAt, text: m.content || '' });
  for (const r of outgoingForDevice().filter(r => r.envelope.body.worker === openedWorker && (!r.requestId || !seen.has(r.requestId)))) entries.push({ id: 'outgoing:' + r.envelope.id, kind: 'request', human: true, name: r.envelope.action === 'talk.send' ? '我发出的对话' : '我发出的任务', time: r.createdAt, text: r.envelope.body.message, attachments: r.attachments?.map((a, i) => ({ ...a, id: r.envelope.body.attachmentIds?.[i] })), error: r.error, delivery: r, jobId: r.jobId });
  const matched = entries.filter(e => (!chatFilter || e.kind === chatFilter) && UI.match(chatQuery, [e.text, e.name])).sort((a, b) => UI.stamp(a.time) - UI.stamp(b.time));
  const recent = new Set(matched.slice(-(chatQuery ? 100 : chatLimit)).map(e => e.id));
  const filtered = matched.filter(e => e.live || recent.has(e.id));
  const signature = JSON.stringify(filtered); if (signature === timelineSignature) return;
  const selection = window.getSelection?.(); if (selection?.toString() && node.contains(selection.anchorNode)) { $('#jump-latest').hidden = false; return; }
  const atBottom = !prepend && (!timelineSignature || node.scrollHeight - node.scrollTop - node.clientHeight < 70);
  const oldTop = node.scrollTop, oldHeight = node.scrollHeight, expanded = new Set([...node.querySelectorAll('details[open]')].map(n => n.closest('[data-entry]')?.dataset.entry));
  timelineSignature = signature;
  const html = filtered.map(e => {
    const key = remember(e.id, e.text), long = !e.live && (e.text.length > 700 || e.text.split('\n').length > 12);
    const content = long ? `<div class="rich-text message-preview">${UI.markdown(e.text.slice(0, 500))}</div><details class="long-message" data-rich="${key}" ${expanded.has(e.id) ? 'open' : ''}><summary>展开完整内容 · ${e.text.length.toLocaleString()} 字</summary><div class="rich-text full-text">${expanded.has(e.id) ? UI.markdown(e.text) : ''}</div></details>` : `<div class="rich-text">${UI.markdown(e.text)}</div>`;
    return `<article class="bubble ${e.human ? 'human' : e.kind === 'message' ? 'system' : ''}" data-entry="${esc(e.id)}"><div class="meta"><span>${esc(e.name)} · ${time(e.time)}</span>${e.delivery ? deliveryBadge(e.delivery) : e.state ? status(e.state) : ''}</div>${content}${e.error ? `<p class="receipt-note">${esc(e.error)}</p>` : ''}${e.attachments?.length ? `<div class="attachments">${e.attachments.map(a => a.id ? `<button data-image="${esc(a.id)}">${icon('image')}${esc(a.name)}</button>` : `<span class="attachment-name">${esc(a.name)}</span>`).join('')}</div>` : ''}<div class="message-actions">${e.delivery ? deliveryRetry(e.delivery) : ''}<button data-copy="${key}" aria-label="复制这条内容">${icon('copy')}复制</button>${e.jobId ? `<button data-job="${esc(e.jobId)}">完整结果 ${icon('arrow')}</button>` : ''}</div></article>`;
  }).join('');
  const nextHtml = (matched.length > filtered.length ? `<button class="load-earlier" data-earlier>查看更早消息 · 已显示 ${filtered.length} / ${matched.length}</button>` : '') + (html || empty(detail ? '没有匹配的对话' : '正在读取最近消息', chatQuery || chatFilter ? '试试其他关键词或切回“全部”。' : detail ? '可以从下方发送第一条消息。' : '返回已看过的会话会先显示本页缓存。'));
  const template = document.createElement('template'); template.innerHTML = nextHtml;
  const oldNodes = new Map([...node.children].map(n => [n.dataset.entry || 'controls', n]));
  const kept = new Set();
  [...template.content.children].forEach((candidate, index) => {
    const old = oldNodes.get(candidate.dataset.entry || 'controls');
    const chosen = old?.outerHTML === candidate.outerHTML ? old : candidate;
    kept.add(chosen);
    if (node.children[index] !== chosen) node.insertBefore(chosen, node.children[index] || null);
  });
  for (const child of [...node.children]) if (!kept.has(child)) child.remove();
  if (atBottom) { node.scrollTop = node.scrollHeight; $('#jump-latest').hidden = true; } else { node.scrollTop = prepend ? oldTop + node.scrollHeight - oldHeight : oldTop; $('#jump-latest').hidden = prepend; }
}
function modal(html) { const token = ++modalEpoch; $('#dialog-body').innerHTML = html; if (!$('#dialog').open) $('#dialog').showModal(); return token; }
function updateModal(token, html) { if (token !== modalEpoch || !$('#dialog').open) return false; $('#dialog-body').innerHTML = html; return true; }
function closeModal() { modalEpoch++; if ($('#dialog')?.open) $('#dialog').close(); }
async function openJob(jobId) {
  const target = selected, token = modal(`<h2>执行结果</h2>${empty('正在读取完整结果', '从目标工厂获取，不使用页面中的过期快照。')}`);
  try {
    const r = await runCommand('job.detail', { jobId }, { deviceId: target });
    if (selected !== target) return;
    const text = `${r.job.worker} · ${r.job.project || '未分类'}\n${time(r.job.updatedAt)}\n\n任务\n${r.job.task || ''}\n\n回复\n${r.reply || r.job.error || '暂无结果'}`;
    const key = remember(`export:${jobId}:${token}`, text);
    updateModal(token, `<h2>${esc(r.job.worker)} · 执行结果</h2>${status(r.job.status)}<p class="job-meta">${esc(r.job.project || '未分类')} · ${time(r.job.updatedAt)}</p><div class="actions"><button data-copy="${key}">${icon('copy')}复制结果</button><button data-export="${key}">${icon('download')}保存为文本</button><button data-reload-job="${esc(jobId)}">${icon('refresh')}刷新</button></div><hr><h3>任务</h3><pre class="prose">${esc(r.job.task)}</pre><hr><h3>回复</h3><div class="rich-text">${UI.markdown(r.reply || r.job.error || '尚无结果，员工可能仍在执行。')}</div>`);
  } catch (e) { updateModal(token, `<h2>结果暂不可用</h2><p>${esc(e.message)}</p>`); }
}
function newTask(project = '') {
  if (!writable()) return toast('当前工厂离线或凭证只读，不能创建任务');
  const target = selected, d = device();
  const token = modal(`<h2>新建看板任务</h2><p class="dialog-context">目标工厂：${esc(d.name)}</p><p class="muted">只创建看板记录，不会自动唤起员工。</p><form id="task-create"><label>标题<input name="title" required maxlength="300" placeholder="希望完成什么？"></label><label>项目<input name="project" maxlength="160" placeholder="用于筛选和归类" value="${esc(project)}" list="new-task-projects"><datalist id="new-task-projects">${(d.snapshot?.projects || []).map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</datalist></label><label>说明<textarea name="description" maxlength="16000" placeholder="目标、约束、验收标准…"></textarea></label><label>负责员工<select name="worker" ${d.role !== 'owner' ? 'required' : ''}>${option('', d.role === 'owner' ? '暂不指定' : '请选择员工', '')}${(d.snapshot?.workers || []).map(w => option(w.id, w.name, '')).join('')}</select></label><p id="form-progress" class="muted" role="status"></p><button class="primary" data-write>创建任务</button></form>`);
  $('#task-create').onsubmit = async event => {
    event.preventDefault(); const button = event.target.querySelector('button'); if (button.dataset.busy === 'true') return;
    const body = Object.fromEntries(new FormData(event.target)); body.title = body.title.trim(); if (!body.title) return toast('请填写任务标题'); if (!body.worker) delete body.worker;
    button.dataset.busy = 'true'; button.disabled = true;
    try { await runCommand('task.create', body, { deviceId: target, onProgress: text => { if (token === modalEpoch) $('#form-progress').textContent = text; } }); if (token === modalEpoch) closeModal(); toast('看板任务已创建，尚未派活'); await refresh({ force: true }); }
    catch (e) { toast(e.message); if (token === modalEpoch) $('#form-progress').textContent = e.message; }
    finally { button.dataset.busy = 'false'; button.disabled = !writable(); }
  };
}
function openTask(id) {
  const task = snap().tasks?.find(t => t.id === id); if (!task) return;
  const target = selected, d = device(), assigned = d.snapshot?.workers?.find(w => w.id === task.assignee);
  const token = modal(`<h2>${esc(task.title)}</h2><p class="dialog-context">${esc(d.name)} · ${esc(task.project || '未分类')} · ${esc(task.assignee || '未指派')} · 版本 ${task.revision}</p><pre class="prose">${esc(task.description || '暂无详细说明')}</pre><form id="task-edit"><label>业务状态<input name="status" id="edit-task-status" value="${esc(task.status)}" maxlength="160" required ${!writable() ? 'disabled' : ''}></label><div class="chips">${['TODO', '进行中', '待验收', '完成'].map(s => `<button type="button" data-set-task-status="${s}" ${!writable() ? 'disabled' : ''}>${UI.labels[s] || s}</button>`).join('')}</div><label>上下文<textarea name="context" maxlength="16000" ${!writable() ? 'readonly' : ''}>${esc(task.context)}</textarea></label><p id="form-progress" class="muted" role="status"></p><button class="primary" data-write ${!writable() ? 'disabled' : ''}>保存状态与上下文</button></form>${assigned ? `<hr><button id="prepare-task" data-write ${!writable() ? 'disabled' : ''}>${icon('send')}准备派给 ${esc(assigned.name)}</button><p class="receipt-note">仅填入派活草稿，由你确认发送；另建派活请求，不会自动运行此看板项。</p>` : ''}`);
  $('#task-edit').onsubmit = async event => {
    event.preventDefault(); const button = event.target.querySelector('button.primary'); if (button.dataset.busy === 'true') return;
    const body = { taskId: id, revision: task.revision, ...Object.fromEntries(new FormData(event.target)) }; if (!body.status.trim()) return toast('请填写业务状态');
    button.dataset.busy = 'true'; button.disabled = true;
    try { await runCommand('task.update', body, { deviceId: target, onProgress: text => { if (token === modalEpoch) $('#form-progress').textContent = text; } }); if (token === modalEpoch) closeModal(); toast('任务已更新'); await refresh({ force: true }); }
    catch (e) { toast(e.message); if (token === modalEpoch) $('#form-progress').textContent = e.message; }
    finally { button.dataset.busy = 'false'; button.disabled = !writable(); }
  };
  if ($('#prepare-task')) $('#prepare-task').onclick = () => {
    if (selected !== target || !writable()) return;
    route('workers', assigned.id, true);
    const text = `${task.title}\n\n${task.description || ''}${task.context ? '\n\n上下文：\n' + task.context : ''}`.trim();
    $('#message').value = [$('#message').value, text].filter(Boolean).join('\n\n').slice(0, 16000); $('#project').value = task.project || ''; saveDraft(); updateCompose(); toast('已准备派活草稿，尚未发送');
  };
}
async function copyText(key) {
  const text = copiedText.get(key); if (!text) return toast('暂无可复制内容');
  try { await navigator.clipboard.writeText(text); toast('已复制'); }
  catch { const token = modal('<h2>手动复制</h2><p class="muted">浏览器未允许自动复制，请长按选中以下内容。</p><textarea id="copy-fallback" readonly rows="12"></textarea>'); if (token === modalEpoch) { $('#copy-fallback').value = text; $('#copy-fallback').select(); } }
}
function exportText(key) {
  const text = copiedText.get(key); if (!text) return;
  const url = URL.createObjectURL(new Blob(['\uFEFF', text], { type: 'text/plain;charset=utf-8' })), a = document.createElement('a');
  a.href = url; a.download = `工厂结果-${new Date().toISOString().slice(0, 10)}.txt`; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 20000); toast('已请求保存文本；请查看浏览器下载或分享菜单');
}
function applyPreferences() { document.documentElement.dataset.theme = pref('ox-theme', 'system'); document.documentElement.dataset.text = pref('ox-text', 'normal'); }
async function diagnose() {
  const token = modal('<h2>连接诊断</h2><p class="muted">只检查当前会话和设备状态，不启动、停止或派发任务。</p><div id="diagnostics">正在检查…</div>');
  const checks = [{ label: '浏览器网络', ok: navigator.onLine, note: navigator.onLine ? '可联网' : '离线' }];
  try { const health = await api('/health'); checks.push({ label: '公网 Hub', ok: health.service === 'ox-factory-mobile-hub', note: health.service === 'ox-factory-mobile-hub' ? '已响应' : '服务不匹配' }); } catch (e) { checks.push({ label: '公网 Hub', ok: false, note: e.message }); }
  try { await api('/api/me'); checks.push({ label: '手机凭证', ok: true, note: '有效' }); await refresh(); } catch (e) { checks.push({ label: '手机凭证', ok: false, note: e.message }); }
  const d = device(); checks.push({ label: '工厂 Connector', ok: d?.online === true, note: d?.online ? '最近上报正常' : '未在线，需检查电脑端' }); checks.push({ label: '本机原工厂', ok: d?.online === true && d?.snapshot?.reachable === true, note: d?.online && d?.snapshot?.reachable ? '连接器确认可达' : '未确认实时可达' });
  updateModal(token, `<h2>连接诊断</h2><p class="dialog-context">${esc(d?.name || '未选择设备')} · ${time(Date.now())}</p>${checks.map(c => `<div class="diagnostic-row"><strong>${esc(c.label)}</strong><span>${status(c.ok ? 'done' : 'offline', c.note)}</span></div>`).join('')}<p class="receipt-note">此检查不等于员工任务已完成，也不能证明 Connector 已正式常驻。不会显示任何凭据。</p>`);
}
async function settings() {
  if (tab !== 'settings' || openedWorker) return;
  const epoch = ++settingsEpoch;
  $('#content').innerHTML = `<div class="section-head"><div><span class="eyebrow">YOUR SPACE</span><h2>连接与偏好</h2></div><span class="badge">v${UI.VERSION}</span></div><div class="settings-grid"><div><section class="setting-group"><div class="profile-row"><div class="avatar">${icon('shield')}</div><div class="grow"><h3>${esc(me?.name || '离线浏览')}</h3><p class="muted">${esc(UI.roles[me?.role] || '仅查看本机目录')} · ${me?.secure ? 'HTTPS 加密连接' : '本机测试 / 离线'}</p></div></div><div class="setting-row"><p class="muted">凭证到期：${time(me?.expiresAt)}</p><div class="actions"><button id="diagnose">${icon('activity')}连接诊断</button><button id="logout" class="danger">退出登录</button></div></div></section><section class="setting-group"><h3>显示与体验</h3><div class="setting-row setting-pair"><label>主题<select id="theme">${[['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']].map(([v, n]) => option(v, n, pref('ox-theme', 'system'))).join('')}</select></label><label>字号<select id="text-size">${option('normal', '标准', pref('ox-text', 'normal'))}${option('large', '大字号', pref('ox-text', 'normal'))}</select></label></div><div class="setting-row"><label>自动同步<select id="refresh-mode">${option('balanced', '标准：目录约 3 秒 / 对话约 4 秒', pref('ox-refresh', 'balanced'))}${option('saving', '省流量：目录约 15 秒 / 对话约 30 秒', pref('ox-refresh', 'balanced'))}</select></label><p class="muted">切到后台会暂停页面轮询，返回时同步；发送时仍即时查询回执。</p></div><div class="setting-row"><div class="actions"><button id="install" ${installPrompt ? '' : 'hidden'}>安装到主屏幕</button><button id="check-update">检查界面更新</button></div><p class="muted">iPhone：Safari 分享 → 添加到主屏幕。Android：浏览器菜单 → 安装应用。</p></div></section><section class="setting-group"><h3>通知</h3><div class="setting-row"><div class="actions"><button id="notifications">启用通知</button><button id="disable-notifications">关闭后台通知</button></div><p id="push-status" class="muted">正在检查推送配置…</p><p class="muted">是否支持后台通知取决于浏览器与 Hub 配置。通知可能延迟，执行结果以原工厂为准。</p></div></section><section class="setting-group"><h3>本机数据</h3><div class="setting-row"><label><input id="cache" type="checkbox" ${pref('ox-cache-enabled') === 'yes' ? 'checked' : ''}>离线保留设备和员工目录</label><p class="muted">默认关闭，不把对话或任务正文放入持久目录缓存。</p></div><div class="setting-row"><p class="muted">输入草稿、待确认操作仅保留在当前标签页。图片不保存为草稿，离线不会自动提交。</p><div class="actions"><button id="clear-drafts">清除本页草稿</button><button id="clear-directory">清除离线目录</button></div></div></section></div><div id="access"><div class="setting-group">${empty(me?.role === 'owner' ? '正在读取安全设置' : '当前凭证无需管理其他设备', '手机与工厂授权由原有权限控制。', 'shield')}</div></div></div><p class="version-note">牛马工厂 · 随身工作台 ${UI.VERSION}<br>页面更新不会重启原工厂服务</p>`;
  $('#theme').onchange = e => { savePreference('ox-theme', e.target.value); applyPreferences(); };
  $('#text-size').onchange = e => { savePreference('ox-text', e.target.value); applyPreferences(); };
  $('#refresh-mode').onchange = e => { savePreference('ox-refresh', e.target.value); toast('同步频率已更新'); };
  $('#diagnose').onclick = diagnose;
  $('#install').onclick = () => installPrompt?.prompt();
  $('#check-update').onclick = async () => { if ([...deliveryTasks.keys()].some(id => outgoing[id] && ['preparing', 'submitting'].includes(outgoing[id].phase))) return toast('尚有内容未送达中转，请稍后更新界面'); try { await (await navigator.serviceWorker?.getRegistration())?.update(); if (confirm('刷新页面以加载最新界面？当前标签页的文字草稿会保留，已选择的图片需要重新选择。')) location.reload(); } catch { toast('无法检查更新，请恢复网络后刷新页面'); } };
  $('#notifications').onclick = enableNotifications;
  $('#disable-notifications').onclick = async () => { try { await api('/api/push/unsubscribe', {}); const registration = await navigator.serviceWorker?.getRegistration(); await (await registration?.pushManager?.getSubscription())?.unsubscribe(); pushSubscribed = false; toast('后台通知已关闭'); settings(); } catch (e) { toast(e.message); } };
  api('/api/push').then(p => { pushSubscribed = p.subscribed; if (epoch === settingsEpoch && $('#push-status')) $('#push-status').textContent = p.subscribed ? '此手机已订阅后台完成通知' : p.available ? 'Hub 已配置推送，点击启用并允许通知' : 'Hub 未配置后台推送；目前仅页面打开时提醒'; }).catch(() => { if (epoch === settingsEpoch && $('#push-status')) $('#push-status').textContent = '通知状态暂不可用'; });
  $('#cache').onchange = e => { UI.write(localStore, 'ox-cache-enabled', e.target.checked ? 'yes' : 'no'); if (!e.target.checked) UI.remove(localStore, 'ox-directory-cache'); else refresh(); };
  $('#clear-directory').onclick = () => { UI.remove(localStore, 'ox-directory-cache'); UI.write(localStore, 'ox-cache-enabled', 'no'); $('#cache').checked = false; toast('离线目录已清除，实时工厂数据未改变'); };
  $('#clear-drafts').onclick = () => { if (!confirm('清除当前标签页保存的文字草稿？不会清除待确认请求，也不会取消已派发任务。')) return; draftMemory.clear(); try { for (let i = sessionStore.length - 1; i >= 0; i--) { const key = sessionStore.key(i); if (key.startsWith('ox-draft:') || key.startsWith('ox-draft-v2:')) sessionStore.removeItem(key); } toast('文字草稿已清除'); } catch { toast('浏览器不允许访问本机存储'); } };
  $('#logout').onclick = async () => { if (!confirm('退出会撤销此手机凭证，并清除本页草稿和目录缓存。已被工厂接收的任务不会停止。确定退出？')) return; try { await api('/api/logout', {}); clearPrivateBrowserState(); me = null; showLogin(); } catch (e) { toast(e.message); } };
  if (me?.role !== 'owner' || !online) return;
  try {
    const access = await api('/api/access'); if (epoch !== settingsEpoch || tab !== 'settings' || openedWorker || !$('#access')) return;
    $('#access').innerHTML = `<div class="setting-row"><h3>添加另一台手机</h3><label>权限<select id="pair-role"><option value="viewer">只读</option><option value="operator">操作员：对话和派活</option><option value="owner">所有者：管理凭证</option></select></label><label>设备范围<select id="pair-scope">${me?.devices?.includes('*') ? '<option value="*">所有已授权设备</option>' : ''}${state.devices.map(d => `<option value="${esc(d.id)}">仅 ${esc(d.name)}</option>`).join('')}</select></label><button id="pair">生成一次性配对链接</button><div id="pair-result"></div></div><div class="setting-row"><h3>手机凭证</h3>${access.sessions.map(s => `<p>${esc(s.name)} · ${esc(UI.roles[s.role] || s.role)} ${s.revokedAt ? '（已撤销）' : s.id === me.id ? '（当前手机）' : `<button data-revoke-session="${esc(s.id)}" class="danger">撤销</button>`}</p>`).join('')}</div><div class="setting-row"><h3>工厂设备</h3>${access.devices.map(d => `<p>${esc(d.name)} <button data-revoke-device="${esc(d.id)}" class="danger">撤销设备连接</button></p>`).join('')}<p class="muted">撤销会阻止后续访问和未送达操作；已经被工厂接收的任务不会因此停止。</p></div>`;
    if (access.audit?.length) $('#access').insertAdjacentHTML('beforeend', `<details class="setting-row"><summary>最近安全记录</summary><div class="audit-list">${access.audit.slice(-20).reverse().map(a => `<div class="audit-item">${time(a.time)} · ${esc(a.type)}</div>`).join('')}</div></details>`);
    $('#access').insertAdjacentHTML('beforeend', '<div class="setting-row"><h3>连接另一台工厂电脑</h3><button id="enroll-device">生成设备接入码</button><p class="muted">接入码 10 分钟有效。必须在目标电脑本地明确绑定工厂身份，手机不能直接授予员工权限。</p><div id="enroll-result"></div></div>');
    $('#enroll-device').onclick = async () => { try { const r = await api('/api/enrollments', {}); $('#enroll-result').innerHTML = `<label>设备接入码<textarea readonly>${esc(r.code)}</textarea></label><p class="muted">在目标电脑将接入码保存到私有文本文件，使用 mobile/cli.mjs enroll，并通过 --code-file 指定文件。不要把接入码放进命令行参数或日志。</p>`; } catch (e) { toast(e.message); } };
    $('#pair').onclick = async () => { try { const r = await api('/api/pairings', { role: $('#pair-role').value, devices: [$('#pair-scope').value] }); $('#pair-result').innerHTML = `<label>链接（10 分钟内有效，仅能使用一次）<textarea readonly id="pair-link">${esc(r.url)}</textarea></label><button id="copy-pair">复制链接</button>`; $('#copy-pair').onclick = async () => { try { await navigator.clipboard.writeText(r.url); toast('已复制，请只发给可信的人'); } catch { $('#pair-link').select(); toast('请手动复制已选中的链接'); } }; } catch (e) { toast(e.message); } };
  } catch (e) { toast(e.message); }
}
async function enableNotifications() {
  if (!('Notification' in window)) return toast('此浏览器不支持通知；iPhone 请先添加到主屏幕再打开');
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return toast('未开启通知，仍可在动态页查看');
    const config = await api('/api/push');
    if (!config.available || !('PushManager' in window)) return toast('目前仅启用页面运行期间的完成提醒');
    const registration = await Promise.race([navigator.serviceWorker.ready, new Promise((_, reject) => setTimeout(() => reject(Error('离线组件未就绪，请刷新后重试')), 8000))]);
    const encoded = config.publicKey.replace(/-/g, '+').replace(/_/g, '/');
    const key = Uint8Array.from(atob(encoded + '='.repeat((4 - encoded.length % 4) % 4)), c => c.charCodeAt(0));
    const subscription = await registration.pushManager.getSubscription() || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await api('/api/push/subscribe', { subscription: subscription.toJSON() }); pushSubscribed = true;
    toast('后台通知已开启；系统可能延迟送达'); settings();
  } catch (e) { toast(e.message || '无法启用后台通知'); }
}
async function notify(job) {
  if (pushSubscribed || !('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const registration = await navigator.serviceWorker?.getRegistration();
    const options = { body: '打开随身工作台查看最新状态和结果。', tag: job.id };
    const title = job.status === 'failed' ? '工厂任务未成功' : '工厂有新结果';
    if (registration?.active) await registration.showNotification(title, options); else new Notification(title, options);
  } catch {}
}

document.addEventListener('click', async event => {
  const node = event.target.closest('button,[data-job],[data-task]'); if (!node || node.disabled) return;
  try {
    if (Object.hasOwn(node.dataset, 'projectFilter')) { projectFilter = node.dataset.projectFilter; return renderProjects(); }
    if (node.dataset.projectPane) { projectPane = node.dataset.projectPane; return renderProjectDetail(); }
    if (Object.hasOwn(node.dataset, 'projectRefresh')) return loadProject();
    if (node.dataset.projectTasks) return openProjectTasks(node.dataset.projectTasks);
    if (node.dataset.projectAssign) return prepareProjectAssignment(node.dataset.projectAssign);
    if (node.dataset.projectNewTask) { const p = currentProject(node.dataset.projectNewTask); if (p) return newTask(p.id); return; }
    if (node.dataset.project) return route('projects', '', false, true, true, node.dataset.project);
    if (node.dataset.usageDays) { usageDays = Number(node.dataset.usageDays) === 30 ? 30 : 7; usageError = ''; return renderUsage(); }
    if (Object.hasOwn(node.dataset, 'earlier')) { chatLimit = Math.min(100, chatLimit + 20); return renderTimeline({ prepend: true }); }
    if (node.dataset.outgoingRetry) { const record = outgoing[node.dataset.outgoingRetry]; if (record) startDelivery(record); return; }
    if (node.dataset.worker) return openWorker(node.dataset.worker);
    if (node.dataset.assign) return openWorker(node.dataset.assign, true);
    if (node.dataset.favorite) { const key = keyFor(node.dataset.favorite); favorites = favorites.includes(key) ? favorites.filter(k => k !== key) : [...favorites.slice(-99), key]; UI.write(localStore, 'ox-favorites', JSON.stringify(favorites)); return renderWorkerCards(); }
    if (Object.hasOwn(node.dataset, 'workerFilter')) { workerStatus = node.dataset.workerFilter; return renderWorkers(); }
    if (Object.hasOwn(node.dataset, 'chatFilter')) { chatFilter = node.dataset.chatFilter; timelineSignature = ''; document.querySelectorAll('[data-chat-filter]').forEach(b => { b.classList.toggle('active', b.dataset.chatFilter === chatFilter); b.setAttribute('aria-pressed', String(b.dataset.chatFilter === chatFilter)); }); return renderTimeline(); }
    if (node.dataset.activityFilter) { activityFilter = node.dataset.activityFilter; if (!node.dataset.tab) return renderActivity(); }
    if (node.dataset.tab) return route(node.dataset.tab);
    if (node.dataset.job || node.dataset.reloadJob) return openJob(node.dataset.job || node.dataset.reloadJob);
    if (node.dataset.task) return openTask(node.dataset.task);
    if (Object.hasOwn(node.dataset, 'newTask')) return newTask(tab === 'tasks' ? taskScope?.id || taskProject : '');
    if (node.dataset.setTaskStatus && $('#edit-task-status')) { $('#edit-task-status').value = node.dataset.setTaskStatus; return; }
    if (node.dataset.copy) return copyText(node.dataset.copy);
    if (node.dataset.export) return exportText(node.dataset.export);
    if (node.dataset.removeImage) { const i = attachmentItems.findIndex(x => x.id === node.dataset.removeImage); if (i >= 0) { URL.revokeObjectURL(attachmentItems[i].url); attachmentItems.splice(i, 1); renderAttachments(); } return; }
    if (node.dataset.image) {
      const target = selected, worker = openedWorker, token = modal('<h2>对话图片</h2><p class="muted">正在从原工厂读取…</p>');
      try { const r = await runCommand('image.read', { worker, attachmentId: node.dataset.image }, { deviceId: target }); if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(r.attachment?.mimeType) || typeof r.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(r.data)) throw Error('图片格式不受支持'); updateModal(token, `<h2>${esc(r.attachment.name)}</h2><img class="image-preview" alt="${esc(r.attachment.name || '对话图片')}" src="data:${r.attachment.mimeType};base64,${r.data}">`); }
      catch (e) { updateModal(token, `<h2>图片暂不可用</h2><p>${esc(e.message)}</p>`); } return;
    }
    if (node.dataset.retry) {
      const item = pending[node.dataset.retry]; if (!item) return;
      node.disabled = true;
      try { await runCommand(item.envelope.action, item.envelope.body, { retry: item.envelope, deviceId: item.envelope.deviceId }); toast('已确认原请求，未另建重复操作'); await refresh({ force: true }); }
      catch (e) { toast(e.message); } finally { if (node.isConnected) node.disabled = false; } return;
    }
    if (node.dataset.revokeSession || node.dataset.revokeDevice) {
      if (!confirm(node.dataset.revokeDevice ? '撤销后这台工厂会断开，需要在电脑重新接入。已经接收的任务不会停止。确认撤销？' : '立即撤销这个手机凭证？固定密码的持有者仍可重新登录，彻底移除访问需另外轮换密码。')) return;
      await api('/api/revoke', { kind: node.dataset.revokeSession ? 'session' : 'device', id: node.dataset.revokeSession || node.dataset.revokeDevice }); await refresh(); await settings();
    }
  } catch (e) { toast(e.message || '操作未完成'); }
});
document.addEventListener('toggle', event => {
  const node = event.target;
  if (node.matches?.('details[data-rich]') && node.open && !node.querySelector('.full-text').innerHTML) node.querySelector('.full-text').innerHTML = UI.markdown(copiedText.get(node.dataset.rich) || '本页内容已释放，请刷新对话再查看。');
}, true);
$('#close-dialog').onclick = closeModal;
$('#dialog').addEventListener('cancel', () => { modalEpoch++; });
$('.brand').onclick = event => { if (me || !$('#workspace').hidden) { event.preventDefault(); route('home'); } };
$('#refresh').innerHTML = icon('refresh');
$('#refresh').onclick = async () => { const b = $('#refresh'); b.disabled = true; b.classList.add('spin'); try { await refresh({ force: true }); if (openedWorker) await refreshDetail(); } finally { b.disabled = false; b.classList.remove('spin'); } };
$('#device').onchange = event => {

  saveDraft(); cleanupAttachments(); closeModal(); selected = event.target.value; set('ox-device', selected); taskScope = null; taskFilter = taskProject = taskStatus = taskAssignee = ''; workerFilter = workerStatus = workerBackend = ''; route(tab, '', false, true, false); connection();
};
$('#login-form').onsubmit = async event => {
  event.preventDefault(); const button = event.target.querySelector('button[type=submit]'); button.disabled = true; button.textContent = '安全连接中…';
  try { await api('/api/login', { code: $('#pair-code').value.trim(), name: $('#phone-name').value.trim() || '我的手机' }); $('#pair-code').value = ''; me = await api('/api/me'); tab = 'home'; openedWorker = ''; showWorkspace(); await refresh(); render(); history.replaceState({ ox: true, tab, worker: openedWorker, deviceId: selected }, '', location.pathname); }
  catch (e) { toast(e.message); } finally { button.disabled = false; button.textContent = '安全连接 ↗'; }
};
$('#show-password').onclick = () => { const input = $('#pair-code'), visible = input.type === 'password'; input.type = visible ? 'text' : 'password'; $('#show-password').textContent = visible ? '隐藏' : '显示'; $('#show-password').setAttribute('aria-pressed', String(visible)); $('#show-password').setAttribute('aria-label', visible ? '隐藏登录密码' : '显示登录密码'); };
window.addEventListener('offline', () => { online = false; connection(); });
window.addEventListener('online', async () => { online = true; if (!me) { try { me = await api('/api/me'); showWorkspace(); } catch { showLogin(); return; } } await refresh({ force: true }); if (openedWorker) await refreshDetail(); });
window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event; if ($('#install')) $('#install').hidden = false; });
window.addEventListener('popstate', event => { if (!me) return; const target = event.state; if (!target?.ox) return route('home', '', false, false); saveDraft(); if (state.devices.some(d => d.id === target.deviceId)) selected = target.deviceId; route(['home', 'projects', 'workers', 'tasks', 'activity', 'usage', 'settings'].includes(target.tab) ? target.tab : 'home', target.worker || '', !!target.assign, false, false, target.project || ''); renderDevicePicker(); });
window.addEventListener('beforeunload', event => { if (Object.values(outgoing).some(r => ['preparing', 'submitting'].includes(r.phase))) { event.preventDefault(); event.returnValue = ''; } });
document.addEventListener('visibilitychange', () => { if (!document.hidden) { refresh(); refreshDetail(); } });
for (const node of document.querySelectorAll('[data-icon]')) node.innerHTML = icon(node.dataset.icon);
applyPreferences();
if ('ResizeObserver' in window) new ResizeObserver(() => document.documentElement.style.setProperty('--header-offset', $('.app-header').getBoundingClientRect().height + 'px')).observe($('.app-header'));
function syncChatViewport() {
  const v = window.visualViewport, normal = !v || Math.abs(v.scale - 1) < .05;
  document.documentElement.style.setProperty('--chat-height', Math.round(normal && v ? v.height : window.innerHeight) + 'px');
  document.documentElement.style.setProperty('--chat-top', Math.round(normal && v ? v.offsetTop : 0) + 'px');
}
syncChatViewport(); window.addEventListener('resize', syncChatViewport); window.visualViewport?.addEventListener('resize', syncChatViewport); window.visualViewport?.addEventListener('scroll', syncChatViewport);
const invite = new URLSearchParams(location.hash.slice(1)).get('pair');
if (passwordLogin) { const input = $('#pair-code'); input.type = 'password'; input.autocomplete = 'current-password'; input.placeholder = '输入固定登录密码'; $('#login-code-label').textContent = '登录密码'; $('#show-password').hidden = false; }
if (invite) { $('#pair-code').value = invite; history.replaceState(null, '', location.pathname); }
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
try { me = await api('/api/me'); showWorkspace(); await refresh(); render(); }
catch {
  const cached = UI.json(localStore, 'ox-directory-cache', null);
  if (!online && pref('ox-cache-enabled') === 'yes' && Array.isArray(cached?.devices)) { state = { devices: cached.devices.map(d => ({ ...d, role: 'viewer', online: false })), commands: [] }; showWorkspace(); renderDevicePicker(); render(); }
  else showLogin();
}
history.replaceState({ ox: true, tab, deviceId: selected }, '', location.pathname);
let lastPollAttempt = 0, lastDetailAttempt = 0;
setInterval(() => {
  if (document.hidden) return;
  const now = Date.now(), saving = pref('ox-refresh') === 'saving';
  if (now - lastPollAttempt >= (saving ? 15000 : 3000)) { lastPollAttempt = now; void refresh(); }
  if (now - lastDetailAttempt >= (saving ? 30000 : 4000)) { lastDetailAttempt = now; void refreshDetail(); }
  connection();
}, 1000);

import { renderMarkdown } from './markdown.js';
// Pure presentation helpers. No network, credentials, DOM writes or raw HTML input.
export const VERSION = '0.6.1';
export const labels = { idle: '空闲', busy: '忙碌', running: '执行中', queued: '排队中', pending: '等待接管', processing: '接管中', accepted: '已接管', reported: '已回传', done: '完成', completed: '完成', succeeded: '完成', failed: '失败', cancelled: '已取消', offline: '离线', vacation: '休假', TODO: '待开始' };
export const roles = { owner: '所有者', operator: '操作员', viewer: '只读' };
export const actions = { 'talk.send': '员工对话', 'task.assign': '派发任务', 'task.create': '创建看板任务', 'task.update': '更新看板任务', 'image.upload': '上传图片' };
export const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const terminal = value => ['done', 'completed', 'succeeded', 'failed', 'cancelled', 'reported'].includes(value);
export const busy = value => ['busy', 'running', 'processing', 'accepted'].includes(value);
export const stamp = value => Number.isFinite(Number(value)) && value !== null ? Number(value) : Date.parse(value) || 0;
export const newest = list => [...(list || [])].sort((a, b) => stamp(b.updatedAt || b.createdAt) - stamp(a.updatedAt || a.createdAt));
export const match = (query, values) => String(query || '').trim().toLocaleLowerCase().split(/\s+/).every(word => values.some(v => String(v || '').toLocaleLowerCase().includes(word)));
export function time(value) { const n = stamp(value); return n ? new Date(n).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '暂无记录'; }
export function relative(value, now = Date.now()) {
  const n = stamp(value); if (!n) return '尚未同步'; const seconds = Math.max(0, Math.floor((now - n) / 1000));
  return seconds < 10 ? '刚刚' : seconds < 60 ? `${seconds} 秒前` : seconds < 3600 ? `${Math.floor(seconds / 60)} 分钟前` : seconds < 86400 ? `${Math.floor(seconds / 3600)} 小时前` : time(n);
}
export function status(value, override = '') {
  const tone = ['failed', 'error'].includes(value) ? 'bad' : busy(value) || ['queued', 'pending', 'delivering'].includes(value) ? 'warm' : ['offline', 'cancelled', 'vacation'].includes(value) ? 'neutral' : 'good';
  return `<span class="status ${tone}"><i aria-hidden="true"></i>${esc(override || labels[value] || value || '未知')}</span>`;
}
export function read(storage, key, fallback = '') { try { return storage.getItem(key) ?? fallback; } catch { return fallback; } }
export function write(storage, key, value) { try { storage.setItem(key, String(value)); return true; } catch { return false; } }
export function remove(storage, key) { try { storage.removeItem(key); } catch {} }
export function json(storage, key, fallback) { try { const value = JSON.parse(read(storage, key, 'null')); return value ?? fallback; } catch { return fallback; } }
export function pendingState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key, item]) => /^[a-zA-Z0-9_-]{8,100}$/.test(key) && item?.envelope?.id === key && typeof item.signature === 'string' && typeof item.envelope.deviceId === 'string' && Object.hasOwn(actions, item.envelope.action) && item.envelope.body && typeof item.envelope.body === 'object'));
}
export function taskGroup(value) {
  const s = String(value || '').trim().toLowerCase();
  if (['todo', '待办', '待开始', '待处理', 'pending'].includes(s)) return 'todo';
  if (['进行中', '处理中', '设计中', '开发中', 'running', 'doing', 'in progress'].includes(s)) return 'doing';
  if (['待验收', '待审核', '验收中', 'review'].includes(s)) return 'review';
  if (['完成', '已完成', 'done', 'completed', 'succeeded'].includes(s)) return 'done';
  return 'other';
}
export const taskGroups = { todo: '待开始', doing: '进行中', review: '待验收', done: '已完成', other: '其他状态' };
export function filterTasks(tasks, { query = '', project = '', projects = null, status = '', assignee = '' } = {}) {
  const scope = Array.isArray(projects) ? new Set(projects.map(projectLabel)) : null;
  return newest(tasks).filter(t => match(query, [t.title, t.description, t.context, t.project, t.status, t.assignee]) && (scope ? scope.has(projectLabel(t.project)) : !project || t.project === project) && (!status || t.status === status) && (!assignee || (assignee === '__unassigned__' ? !t.assignee : t.assignee === assignee)));
}
const projectLabel = value => String(value || '').trim().toLocaleLowerCase();
export const projectStatuses = { active: '进行中', paused: '已暂停', done: '已完成', archived: '已归档', activity: '活动分组' };
export const projectTodoStatuses = { todo: '待办', doing: '进行中', done: '完成', blocked: '受阻', dropped: '已放弃' };
export function projectForLabel(catalog, label) {
  const name = projectLabel(label); if (!name) return null;
  for (const keys of [p => [p.id], p => [p.name], p => p.aliases || []]) {
    const found = catalog.filter(p => keys(p).some(k => projectLabel(k) === name));
    if (found.length) return found.length === 1 ? found[0] : null;
  }
  return null;
}
// One project index per factory snapshot. Legacy labels remain explicitly unregistered groups.
export function projectList(snapshot = {}, { query = '', status = '', sort = 'activity' } = {}) {
  const catalog = (snapshot.projects || []).filter(p => p?.id), groups = new Map();
  for (const p of catalog) groups.set('entity:' + p.id, { ...p, key: 'entity:' + p.id, source: 'entity', tasks: [], jobs: [], requests: [], participants: (p.members || []).filter(m => m.status !== 'inactive').map(m => m.worker).filter(Boolean), lastActivity: stamp(p.updatedAt) });
  for (const kind of ['tasks', 'jobs', 'requests']) for (const item of snapshot[kind] || []) {
    const label = String(item.project || '').trim(); if (!label) continue;
    const p = projectForLabel(catalog, label), key = p ? 'entity:' + p.id : 'group:' + projectLabel(label);
    if (!groups.has(key)) groups.set(key, { id: label, name: label, key, source: 'activity', status: 'activity', summary: '来自任务或执行记录的项目名；尚未登记为正式项目。', aliases: [], tasks: [], jobs: [], requests: [], participants: [], lastActivity: 0 });
    const group = groups.get(key); group[kind].push(item); group.lastActivity = Math.max(group.lastActivity, stamp(item.updatedAt || item.createdAt));
    const worker = item.assignee || item.worker || item.to; if (worker && !group.participants.includes(worker)) group.participants.push(worker);
  }
  const result = [...groups.values()].map(p => ({ ...p, tasks: newest(p.tasks), jobs: newest(p.jobs), requests: newest(p.requests), participants: [...new Set(p.participants)], runningCount: p.jobs.filter(j => busy(j.status) || j.status === 'queued').length }));
  return result.filter(p => (!status || (status === 'registered' ? p.source === 'entity' : status === 'activity' ? p.source === 'activity' : p.status === status)) && match(query, [p.name, p.id, p.summary, ...(p.aliases || []), ...p.participants]))
    .sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name, 'zh-CN') : b.lastActivity - a.lastActivity || a.name.localeCompare(b.name, 'zh-CN'));
}
export function workerList(workers, { query = '', status = '', backend = '', favorites = [], deviceId = '', recent = {}, activity = {}, sort = 'favorites' } = {}) {
  const favorite = w => favorites.includes(JSON.stringify([deviceId, w.id]));
  const byName = (a, b) => String(a.name).localeCompare(String(b.name), 'zh-CN');
  const byActivity = (a, b) => Math.max(stamp(b.lastInteractionAt), activity[b.id] || 0) - Math.max(stamp(a.lastInteractionAt), activity[a.id] || 0);
  return [...(workers || [])].filter(w => match(query, [w.name, w.id, w.role, w.backend]) && (!backend || w.backend === backend) && (!status || (status === 'favorites' ? favorite(w) : status === 'busy' ? busy(w.status) : w.status === status)))
    .sort((a, b) => sort === 'name' ? byName(a, b) : sort === 'activity' ? byActivity(a, b) || byName(a, b) : sort === 'tokens' ? (b.tokenToday?.total || 0) - (a.tokenToday?.total || 0) || byActivity(a, b) || byName(a, b) : Number(favorite(b)) - Number(favorite(a)) || (recent[JSON.stringify([deviceId, b.id])] || 0) - (recent[JSON.stringify([deviceId, a.id])] || 0) || byName(a, b));
}
export const tokenNumber = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
export function compactNumber(value) { const n = tokenNumber(value); return n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : n.toLocaleString('zh-CN'); }
export function workerActivity(snapshot, outgoing = []) {
  const result = {};
  const add = (worker, at) => { if (worker) result[worker] = Math.max(result[worker] || 0, stamp(at)); };
  for (const w of snapshot.workers || []) add(w.id, w.lastInteractionAt);
  for (const j of snapshot.jobs || []) add(j.worker, j.updatedAt || j.createdAt);
  for (const r of snapshot.requests || []) add(r.to || r.worker, r.createdAt);
  for (const r of outgoing) add(r.envelope?.body?.worker, r.envelope?.createdAt);
  return result;
}
export function outgoingState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([id, r]) => /^[a-zA-Z0-9_-]{8,100}$/.test(id) && r?.envelope?.id === id && ['talk.send', 'task.assign'].includes(r.envelope.action) && typeof r.envelope.deviceId === 'string' && typeof r.envelope.body?.worker === 'string' && typeof r.envelope.body?.message === 'string' && ['preparing', 'submitting', 'accepted', 'confirmed', 'uncertain', 'failed'].includes(r.phase)));
}
export const deliveryLabels = { preparing: '图片上传中', submitting: '发送中', accepted: '已到中转，等待工厂', confirmed: '工厂已接收', uncertain: '送达待确认', failed: '发送未成功' };
export function taskStats(tasks) { const counts = { todo: 0, doing: 0, review: 0, done: 0, other: 0 }; for (const task of tasks || []) counts[taskGroup(task.status)]++; return counts; }
export function safeLink(value) {
  try { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password ? u.href : null; } catch { return null; }
}
export const markdown = input => renderMarkdown(input);
export const markdownPreview = input => renderMarkdown(input, true);
const paths = {
  home: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-6v-7h-4v7H4a1 1 0 0 1-1-1z"/>',
  workers: '<circle cx="9" cy="7" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 4a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 4v3"/>',
  tasks: '<rect x="4" y="4" width="16" height="17" rx="3"/><path d="M9 3h6v4H9zM8 12h8m-8 4h5"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5M5 7a8 8 0 0 1 13-2l2 2M4 17l2 2a8 8 0 0 0 13-2"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  warning: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 4h.01"/>',
  star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9z"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  back: '<path d="M19 12H5m5-5-5 5 5 5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  send: '<path d="m3 3 18 9-18 9 3-9zM6 12h15"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1"/><path d="m3 17 5-5 4 4 4-6 5 7"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6zM8 12l3 3 5-6"/>',
  download: '<path d="M12 3v12m-4-4 4 4 4-4M4 15v6h16v-6"/>',
  moon: '<path d="M20 14A8 8 0 0 1 10 4a9 9 0 1 0 10 10z"/>',
  usage: '<path d="M4 20V10h4v10m3 0V4h4v16m3 0v-7h4v7M2 21h21"/>',
  projects: '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/><path d="M3 9h18M8 14h8m-8 3h5"/>',
  expand: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
  browser: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4M2 7h20"/>',
};
export function icon(name) { return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.activity}</svg>`; }
export function readIndicator(phase, label) {
  const state = ['loading', 'ready', 'error', 'paused'].includes(phase) ? phase : 'idle';
  const glyph = state === 'loading' ? '<i class="read-spinner" aria-hidden="true"></i>' : state === 'ready' ? icon('check') : state === 'idle' ? '' : icon('warning');
  return `<span class="read-indicator" data-state="${state}" role="img" aria-label="${esc(label)}" title="${esc(label)}">${glyph}</span>`;
}
export function unreadBadge(worker) {
  const count = Math.max(0, Math.trunc(Number(worker.finishedUnreadJobs ?? worker.unreadCount) || 0));
  return count ? `<span class="unread-badge" aria-label="${count} 条未读" title="与电脑同步的未读状态">${count > 99 ? '99+' : count}</span>` : '';
}
export function messageReadBadge(read, phase = '') {
  if (!read) return '';
  const label = !read.unread ? '已读' : phase === 'sending' ? '同步中' : phase === 'failed' ? '未读 · 重试同步' : '未读';
  const content = `${!read.unread ? icon('check') : '<i aria-hidden="true"></i>'}${label}`;
  return read.unread && read.token ? `<button class="message-read unread" data-read-revision="${esc(read.revision)}" title="标为已读并同步到电脑" ${phase === 'sending' ? 'disabled' : ''}>${content}</button>` : `<span class="message-read ${read.unread ? 'unread' : ''}" title="与电脑共用已读状态">${content}</span>`;
}
export function visiblyInside(rect, root) {
  const height = Math.max(0, Math.min(rect.bottom, root.bottom) - Math.max(rect.top, root.top));
  const width = Math.max(0, Math.min(rect.right, root.right) - Math.max(rect.left, root.left));
  return rect.height > 0 && root.height > 0 && width > 0 && height >= Math.min(rect.height, root.height) * .6;
}

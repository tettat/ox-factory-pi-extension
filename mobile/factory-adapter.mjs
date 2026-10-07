import { readPublicConversation } from '../public-conversation.mjs';
// Local-only factory boundary. No arbitrary paths, URLs, shell commands or app-server RPC.
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { listJobs, tailJobEvents, latestReplyFromEvents } from '../jobs.mjs';
import { hasPermission, listMessages } from '../comm.mjs';
import { createWebTalkRequest, listWebTalkRequests } from '../web-talk.mjs';
import { createWorkerTaskRequest, listWorkerTaskRequests } from '../task-requests.mjs';
import { createFactoryTask, getFactoryTask, listFactoryTasks, updateFactoryTask } from '../task-board.mjs';
import { listProjects as listStoredProjects } from '../projects.mjs';
import { createTalkAttachment, resolveTalkAttachmentIds, assertTalkImageBackendSupported, bindTalkAttachments, talkAttachmentContentPath } from '../talk-attachments.mjs';
import { ACTIONS, Fault, at, hash, id, roleAllows, validateAction, commandDigest } from './protocol.mjs';
import { readJson, writeJson } from './store.mjs';

const text = (value, max = 16000) => String(value || '').slice(0, max);
const pick = (value, keys) => Object.fromEntries(keys.map(key => [key, value[key] ?? null]));
const jobView = job => ({ ...pick(job, ['id', 'worker', 'status', 'kind', 'project', 'createdAt', 'updatedAt', 'finishedAt']), task: text(job.task), summary: text(job.summary), error: text(job.error, 500) });
const taskView = task => ({ ...pick(task, ['id', 'title', 'description', 'project', 'status', 'assignee', 'revision', 'createdAt', 'updatedAt']), context: text(task.context), execution: pick(task.execution || {}, ['state', 'jobId', 'requestId']) });
const requestView = req => ({ ...pick(req, ['id', 'worker', 'to', 'from', 'status', 'jobId', 'createdAt', 'mode', 'deliveryMode', 'project']), message: text(req.message || req.task), error: text(req.error, 500), attachments: (req.attachments || []).map(a => pick(a, ['id', 'name', 'mimeType', 'size'])) });
const count = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(Number.MAX_SAFE_INTEGER, value) : 0;
const tokenKeys = ['inputTokens', 'uncachedInputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens', 'totalWithCachedTokens'];
const tokenView = value => Object.fromEntries(tokenKeys.map(k => [k, count(value?.[k])]));
const tokenSource = source => ['session', 'job', 'none'].includes(source) ? source : 'none';
const localDate = value => { const d = new Date(value); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const rows = value => Array.isArray(value) ? value.filter(v => v && typeof v === 'object' && !Array.isArray(v)) : [];
const projectStrings = (value, limit = 40) => Array.isArray(value) ? value.filter(v => typeof v === 'string').slice(0, limit).map(v => text(v, 160)) : [];
function projectView(p, full = false) {
  const todos = rows(p.todos), members = rows(p.members);
  const value = { id: text(p.id, 160), name: text(p.name, 200), summary: text(p.summary, full ? 4000 : 600), status: text(p.status, 40), priority: text(p.priority, 40),
    aliases: projectStrings(p.aliases), createdAt: text(p.createdAt, 80), updatedAt: text(p.updatedAt, 80),
    members: members.slice(0, full ? 100 : 30).map(m => ({ worker: text(m.worker, 160), relation: text(m.relation, 80), status: text(m.status, 40), ...(full ? { note: text(m.note, 1000) } : {}) })),
    todoCounts: { total: todos.length, done: todos.filter(t => t.status === 'done').length, blocked: todos.filter(t => t.status === 'blocked').length, open: todos.filter(t => !['done', 'dropped'].includes(t.status)).length } };
  if (!full) return value;
  const link = l => ({ type: text(l.type, 80), label: text(l.label, 160), ref: text(l.ref, 2048), note: text(l.note, 1000) });
  return { ...value, truth: p.truth && typeof p.truth === 'object' ? link(p.truth) : null, links: rows(p.links).slice(0, 30).map(link),
    todos: todos.slice(0, 100).map(t => ({ id: text(t.id, 160), title: text(t.title, 300), status: text(t.status, 40), owner: text(t.owner, 160), note: text(t.note, 2000), evidence: text(t.evidence, 2048), updatedAt: text(t.updatedAt, 80) })),
    progress: rows(p.progress).slice(0, 30).map(t => ({ id: text(t.id, 160), text: text(t.text, 4000), status: text(t.status, 40), owner: text(t.owner, 160), evidence: text(t.evidence, 2048), updatedAt: text(t.updatedAt, 80) })),
    truncated: todos.length > 100 || members.length > 100 || rows(p.progress).length > 30 || rows(p.links).length > 30 };
}

export function createFactoryAdapter({ workersDir, stateDir, factoryUrl = 'http://127.0.0.1:8787', grants, registry, now = Date.now, factoryFetch = fetch }) {
  const base = new URL(factoryUrl);
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.username || base.password || base.pathname !== '/' || base.search) throw new Error('Factory URL must be a loopback HTTP origin');
  const file = join(stateDir, 'factory-ledger.json');
  const ledger = readJson(file, { version: 1, receipts: {}, uploads: {} });
  const save = () => writeJson(file, ledger);
  const currentGrants = () => typeof grants === 'function' ? grants() : grants;
  const usageCache = new Map();
  async function factoryRead(path) {
    const response = await factoryFetch(new URL(path, base), { signal: AbortSignal.timeout(15000), redirect: 'error' });
    if (!response.ok) throw new Fault('FACTORY_UNAVAILABLE', 503);
    return response.json();
  }
  async function usage(body) {
    const date = body.date || localDate(now()), key = `${date}:${body.days}`;
    const cached = usageCache.get(key); if (cached && now() - cached.at < 15000) return cached.value;
    const [report, trend] = await Promise.all([factoryRead(`/api/tokens?date=${encodeURIComponent(date)}`), factoryRead(`/api/tokens/trend?days=${body.days}`)]);
    if (!Array.isArray(report?.workers) || !report.totals || !Array.isArray(trend?.days)) throw new Fault('FACTORY_UNAVAILABLE', 503);
    // Forward aggregates only. No arbitrary URLs, billing configuration, log paths or raw warnings.
    const value = { report: { date, generatedAt: text(report.generatedAt, 80), totals: tokenView(report.totals), warningCount: Array.isArray(report.warnings) ? report.warnings.length : 0,
      workers: report.workers.slice(0, 1000).map(w => ({ worker: text(w.worker, 160), source: tokenSource(w.source), reported: tokenView(w.reported) })) },
      trend: { generatedAt: text(trend.generatedAt, 80), days: trend.days.slice(-body.days).map(d => ({ date: text(d.date, 10), ...tokenView(d) })) } };
    if (usageCache.size >= 8) usageCache.delete(usageCache.keys().next().value);
    usageCache.set(key, { at: now(), value }); return value;
  }
  async function workers() {
    const entries = registry ? await registry() : (await factoryRead('/api/workers')).workers;
    if (!Array.isArray(entries)) throw new Fault('FACTORY_UNAVAILABLE', 503);
    return entries.filter(w => !w.remote && !(w.name || w.id || '').startsWith('remote:') && w.status !== 'fired').map(w => ({
      id: String(w.name || w.id), name: text(w.displayName || w.name || w.id, 160), role: text(w.role, 80), backend: text(w.backend, 40), status: text(w.status, 40),
      lastInteractionAt: text(w.lastInteractionAt || w.lastJob?.updatedAt, 80),
      lastTalkReply: w.lastTalkReply ? { contentPreview: text(w.lastTalkReply.contentPreview, 180), updatedAt: text(w.lastTalkReply.updatedAt, 80) } : null,
      unreadCount: count(w.unreadCount), model: text(w.model, 120),
      tokenToday: w.tokenToday ? { input: count(w.tokenToday.input), cachedInput: count(w.tokenToday.cachedInput), uncachedInput: count(w.tokenToday.uncachedInput), output: count(w.tokenToday.output), total: count(w.tokenToday.total), source: tokenSource(w.tokenToday.source) } : null,
    }));
  }
  function authorize(command) {
    const grant = currentGrants()?.[command.principalId];
    if (!grant || grant.revoked || !roleAllows(grant.role, ACTIONS[command.action].role) || !roleAllows(command.role, ACTIONS[command.action].role)) throw new Fault('LOCAL_GRANT_DENIED', 403);
    return grant;
  }
  function permission(grant, action, worker) {
    if (!hasPermission(workersDir, { subject: grant.actor, action, target: worker })) throw new Fault('FACTORY_PERMISSION_DENIED', 403);
  }
  async function snapshot() {
    const ws = await workers();
    const allowed = new Set(ws.map(w => w.id));
    let projects = [], projectsAvailable = true, projectsTruncated = false;
    try { const all = listStoredProjects(workersDir); projects = all.slice(0, 200).map(p => projectView(p)); projectsTruncated = all.length > 200; }
    catch { projectsAvailable = false; } // A broken project index must not take employee messaging offline.
    return { protocolVersion: 1, observedAt: at(), reachable: true, workers: ws, usageDate: localDate(now()), capabilities: ['usage.read', 'worker-activity-v1', 'project.detail'], projects, projectsAvailable, projectsTruncated,
      jobs: listJobs(workersDir, { limit: 100 }).filter(j => allowed.has(j.worker)).map(jobView),
      tasks: listFactoryTasks(workersDir, { limit: 200 }).map(taskView),
      requests: listWorkerTaskRequests(workersDir, { limit: 100 }).map(requestView),
      grants: Object.fromEntries(Object.entries(currentGrants() || {}).filter(([, g]) => !g.revoked).map(([p, g]) => [p, g.role])),
    };
  }
  async function execute(command) {
    id(command.id);
    const body = validateAction(command.action, command.body);
    const digest = commandDigest(command.action, body);
    if (digest !== command.digest) throw new Fault('COMMAND_DIGEST_MISMATCH', 409);
    const grant = authorize(command); // Re-evaluate local authorization even for replay.
    const key = `${command.principalId}:${command.id}`;
    const previous = ledger.receipts[key];
    if (previous && previous.digest !== digest) throw new Fault('IDEMPOTENCY_CONFLICT', 409);
    if (previous?.complete) return previous.result;
    if (!Number.isFinite(command.expiresAt) || command.expiresAt <= now()) throw new Fault('COMMAND_EXPIRED', 409);
    if (command.action === 'usage.read') return usage(body);
    if (command.action === 'project.detail') {
      // Resolve only registered, visible IDs; never accept a path, URL or document ref.
      const p = listStoredProjects(workersDir).find(p => p.id === body.projectId);
      if (!p) throw new Fault('PROJECT_NOT_FOUND', 404);
      const result = await factoryRead(`/api/projects/${encodeURIComponent(p.id)}`);
      if (result.project?.id !== p.id) throw new Fault('FACTORY_UNAVAILABLE', 503);
      return { generatedAt: text(result.generatedAt, 80), project: projectView(result.project, true),
        relatedJobs: { total: count(result.relatedJobs?.total), recent: rows(result.relatedJobs?.recent).slice(0, 20).map(j => ({ ...jobView(j), project: p.id })) },
        responsibilities: rows(result.relatedResponsibilities).slice(0, 100).map(r => ({ worker: text(r.worker, 160), scope: text(r.scope, 200), relation: text(r.relation, 80), note: text(r.note, 1000) })) };
    }
    const ws = await workers();
    const worker = body.worker ? ws.find(w => w.id === body.worker) : null;
    if (body.worker && !worker) throw new Fault('WORKER_NOT_FOUND', 404);
    const jobs = () => listJobs(workersDir, { limit: 10000 });
    const reply = job => {
      if (job.fullOutput) return text(job.fullOutput, 64000);
      if (job.status === 'running') return text(readPublicConversation(job).filter(b => b.type === 'text').map(b => b.text).join('\n\n'), 64000);
      const events = tailJobEvents(job, 1000);
      return text(latestReplyFromEvents(events) || job.summary || events.filter(e => e.type === 'text').map(e => e.text || '').join(''), 64000);
    };
    if (command.action === 'worker.detail') return {
      worker, jobs: jobs().filter(j => j.worker === worker.id).slice(-30).map((j, i, all) => ({ ...jobView(j), ...(['running', 'queued'].includes(j.status) ? { publicConversation: readPublicConversation(j) } : {}), reply: i >= all.length - 10 ? reply(j) : text(j.summary) })),
      talkRequests: listWebTalkRequests(workersDir, { worker: worker.id, limit: 100 }).map(requestView),
      requests: listWorkerTaskRequests(workersDir, { to: worker.id, limit: 100 }).map(requestView),
      messages: listMessages(workersDir, { worker: worker.id, includeSent: true, limit: 100 }).map(m => ({ ...pick(m, ['id', 'from', 'to', 'createdAt', 'read']), content: text(m.content) })),
    };
    if (command.action === 'job.detail') {
      const job = jobs().find(j => j.id === body.jobId);
      if (!job || !ws.some(w => w.id === job.worker)) throw new Fault('JOB_NOT_FOUND', 404);
      return { job: jobView(job), reply: reply(job), publicConversation: readPublicConversation(job) };
    }
    if (command.action === 'tasks.list') return { tasks: listFactoryTasks(workersDir, { limit: 500 }).map(taskView) };
    if (command.action === 'image.read') {
      const owned = ledger.uploads[body.attachmentId];
      const inTalk = listWebTalkRequests(workersDir, { worker: worker.id, limit: 1000 }).some(r => r.attachments?.some(a => a.id === body.attachmentId));
      const inJob = listJobs(workersDir, { worker: worker.id, limit: 1000 }).some(j => j.attachments?.some(a => a.id === body.attachmentId));
      if (!(owned?.worker === worker.id && owned?.principalId === command.principalId) && !inTalk && !inJob) throw new Fault('ATTACHMENT_NOT_FOUND', 404);
      const attachment = resolveTalkAttachmentIds(workersDir, [body.attachmentId])[0];
      const bytes = readFileSync(talkAttachmentContentPath(workersDir, attachment.id));
      if (bytes.length > 10 * 1024 * 1024) throw new Fault('IMAGE_TOO_LARGE');
      return { attachment: pick(attachment, ['id', 'name', 'mimeType', 'size']), data: bytes.toString('base64') };
    }

    if (['talk.send', 'image.upload'].includes(command.action)) permission(grant, 'message:send', worker.id);
    if (command.action === 'task.assign') permission(grant, 'work:assign', worker.id);
    if (command.action === 'task.create') {
      if (body.worker) permission(grant, 'work:assign', body.worker);
      else if (!roleAllows(grant.role, 'owner') || !roleAllows(command.role, 'owner')) throw new Fault('OWNER_REQUIRED', 403);
    }
    if (command.action === 'task.update') {
      const task = getFactoryTask(workersDir, body.taskId);
      if (!task) throw new Fault('TASK_NOT_FOUND', 404);
      if (task.assignee) permission(grant, 'work:assign', task.assignee);
      else if (!roleAllows(grant.role, 'owner') || !roleAllows(command.role, 'owner')) throw new Fault('OWNER_REQUIRED', 403);
    }
    // Non-idempotent library operations never silently replay after an uncertain crash.
    if (previous && ['task.update', 'image.upload'].includes(command.action)) throw new Fault('DELIVERY_UNCERTAIN_REVIEW_REQUIRED', 409);
    ledger.receipts[key] = { digest, startedAt: at(), complete: false }; save();
    let result;
    const executionKey = `mobile:${hash(key)}`;
    if (command.action === 'image.upload') {
      const attachment = createTalkAttachment(workersDir, { data: Buffer.from(body.data, 'base64'), declaredMimeType: body.mimeType, originalName: body.name });
      assertTalkImageBackendSupported(worker.backend || 'pi', [attachment]);
      ledger.uploads[attachment.id] = { principalId: command.principalId, worker: worker.id, createdAt: at() };
      result = { attachment: pick(attachment, ['id', 'name', 'mimeType', 'size']) };
    }
    if (command.action === 'talk.send') {
      for (const attachmentId of body.attachmentIds) {
        const owned = ledger.uploads[attachmentId];
        if (!owned || owned.principalId !== command.principalId || owned.worker !== worker.id || (owned.commandId && owned.commandId !== command.id)) throw new Fault('ATTACHMENT_NOT_OWNED', 403);
      }
      const attachments = resolveTalkAttachmentIds(workersDir, body.attachmentIds);
      assertTalkImageBackendSupported(worker.backend || 'pi', attachments);
      const existing = listWebTalkRequests(workersDir, { worker: worker.id, limit: 100000 }).find(r => r.idempotencyKey === executionKey);
      if (attachments.some(a => a.requestId && a.requestId !== existing?.id)) throw new Fault('ATTACHMENT_ALREADY_BOUND', 409);
      const request = createWebTalkRequest(workersDir, { worker: worker.id, from: grant.actor, message: body.message, mode: body.mode, attachments, idempotencyKey: executionKey });
      bindTalkAttachments(workersDir, attachments, { requestId: request.id });
      for (const attachmentId of body.attachmentIds) ledger.uploads[attachmentId].commandId = command.id;
      result = { request: requestView(request) };
    }
    if (command.action === 'task.assign') result = { request: requestView(createWorkerTaskRequest(workersDir, {
      from: grant.actor, to: worker.id, task: body.message, project: body.project || 'mobile', source: 'mobile', mode: body.mode, executionKey,
    })) };
    if (command.action === 'task.create') {
      const taskId = `ftask_mobile_${hash(key).slice(0, 32)}`;
      const task = getFactoryTask(workersDir, taskId) || createFactoryTask(workersDir, { id: taskId, title: body.title, description: body.description || '', project: body.project || 'mobile', assignee: body.worker || '', creator: grant.actor, status: 'TODO' });
      result = { task: taskView(task) };
    }
    if (command.action === 'task.update') result = { task: taskView(updateFactoryTask(workersDir, body.taskId, {
      ...(body.status ? { status: body.status } : {}), ...(Object.hasOwn(body, 'context') ? { context: body.context } : {}), expectedRevision: body.revision, updatedBy: grant.actor,
    })) };
    if (!result) throw new Fault('UNKNOWN_ACTION');
    ledger.receipts[key] = { digest, complete: true, finishedAt: at(), result }; save();
    return result;
  }
  return { snapshot, execute };
}

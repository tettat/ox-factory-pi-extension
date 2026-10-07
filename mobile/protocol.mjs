import { createHash, randomBytes } from 'node:crypto';

export const VERSION = 1;
export const ROLES = ['viewer', 'operator', 'owner'];
export const ACTIONS = {
  'worker.detail': { fields: ['worker'], role: 'viewer' },
  'job.detail': { fields: ['jobId'], role: 'viewer' },
  'image.read': { fields: ['worker', 'attachmentId'], role: 'viewer' },
  'tasks.list': { fields: [], role: 'viewer' },
  'usage.read': { fields: ['date', 'days'], role: 'viewer' },
  'project.detail': { fields: ['projectId'], role: 'viewer' },
  'talk.send': { fields: ['worker', 'message', 'mode', 'attachmentIds'], role: 'operator' },
  'task.assign': { fields: ['worker', 'message', 'project', 'mode'], role: 'operator' },
  'task.create': { fields: ['title', 'description', 'project', 'worker'], role: 'operator' },
  'task.update': { fields: ['taskId', 'status', 'context', 'revision'], role: 'operator' },
  'image.upload': { fields: ['worker', 'name', 'mimeType', 'data'], role: 'operator' },
};
export class Fault extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
export const token = () => randomBytes(32).toString('base64url');
export const hash = value => createHash('sha256').update(String(value)).digest('hex');
export const at = () => new Date().toISOString();
export const roleAllows = (role, required) => ROLES.includes(role) && ROLES.indexOf(role) >= ROLES.indexOf(required);
export function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Fault('OBJECT_REQUIRED');
  return value;
}
export function fields(value, allowed) {
  object(value);
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Fault('UNKNOWN_FIELD');
}
export function string(value, max = 120, optional = false) {
  if (optional && value == null) return '';
  if (typeof value !== 'string' || value.length > max || (!optional && !value.trim()) || /\u0000/.test(value)) throw new Fault('INVALID_STRING');
  return value.trim();
}
export function id(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(value) || ['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty'].includes(value)) throw new Fault('INVALID_ID');
  return value;
}
export function validateAction(action, body) {
  if (!Object.hasOwn(ACTIONS, action)) throw new Fault('UNKNOWN_ACTION');
  fields(body, ACTIONS[action].fields);
  const out = {};
  for (const key of ['worker', 'jobId', 'taskId', 'attachmentId']) if (Object.hasOwn(body, key)) out[key] = string(body[key], 160);
  for (const key of ['message', 'description', 'context']) if (Object.hasOwn(body, key)) out[key] = string(body[key], 16000, true);
  for (const key of ['project', 'title', 'status', 'name']) if (Object.hasOwn(body, key)) out[key] = string(body[key], key === 'title' ? 300 : 160, true);
  if (out.worker?.startsWith('remote:') || out.worker === '*' || /[/\\]/.test(out.worker || '')) throw new Fault('INVALID_WORKER');
  if (['worker.detail', 'talk.send', 'task.assign', 'image.upload', 'image.read'].includes(action) && !out.worker) throw new Fault('WORKER_REQUIRED');
  if (action === 'image.read' && !out.attachmentId) throw new Fault('ATTACHMENT_REQUIRED');
  if (action === 'job.detail' && !out.jobId) throw new Fault('JOB_REQUIRED');
  if (action === 'project.detail') {
    out.projectId = string(body.projectId, 160);
    if (!/^[\p{L}\p{N}_-]+$/u.test(out.projectId) || ['__proto__', 'constructor', 'prototype'].includes(out.projectId)) throw new Fault('INVALID_PROJECT');
  }
  if (action === 'usage.read') {
    out.days = body.days ?? 7;
    if (![7, 30].includes(out.days)) throw new Fault('INVALID_USAGE_RANGE');
    if (body.date != null && body.date !== '') {
      if (typeof body.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.date) || !Number.isFinite(Date.parse(body.date)) || new Date(body.date).toISOString().slice(0, 10) !== body.date) throw new Fault('INVALID_USAGE_DATE');
      out.date = body.date;
    }
  }
  if (action === 'task.update') {
    if (!out.taskId || !Number.isInteger(body.revision) || body.revision < 1 || (!out.status && !Object.hasOwn(out, 'context'))) throw new Fault('INVALID_TASK_UPDATE');
    out.revision = body.revision;
  }
  if (['talk.send', 'task.assign'].includes(action)) {
    out.mode = body.mode || 'auto';
    if (!['auto', 'queue', 'steer'].includes(out.mode)) throw new Fault('INVALID_MODE');
    if (action === 'talk.send') {
      out.attachmentIds = body.attachmentIds || [];
      if (!Array.isArray(out.attachmentIds) || out.attachmentIds.length > 6 || new Set(out.attachmentIds).size !== out.attachmentIds.length) throw new Fault('INVALID_ATTACHMENTS');
      out.attachmentIds.forEach(x => string(x, 160));
    }
    if (!out.message && !out.attachmentIds?.length) throw new Fault('MESSAGE_REQUIRED');
  }
  if (action === 'task.create' && !out.title) throw new Fault('TITLE_REQUIRED');
  if (action === 'image.upload') {
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(body.mimeType)) throw new Fault('INVALID_IMAGE_TYPE');
    if (typeof body.data !== 'string' || body.data.length > 14_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.data)) throw new Fault('INVALID_IMAGE');
    const bytes = Buffer.from(body.data, 'base64');
    if (!bytes.length || bytes.length > 10 * 1024 * 1024 || bytes.toString('base64') !== body.data) throw new Fault('IMAGE_TOO_LARGE_OR_INVALID');
    out.data = body.data; out.mimeType = body.mimeType;
  }
  return out;
}
export function commandDigest(action, body) { return hash(JSON.stringify([action, body])); }
export function safeError(error) {
  if (error?.code === 'FACTORY_TASK_REVISION_CONFLICT') return 'TASK_REVISION_CONFLICT';
  return error instanceof Fault ? error.code : 'FACTORY_OPERATION_FAILED';
}

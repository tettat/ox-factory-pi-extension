// Shared with the desktop Web UI. A receipt acknowledges a displayed snapshot,
// never the job's current cursor (which may already contain an unseen reply).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { webJobReadFile, readWebJobReadState, jobEventCursor, buildWorkerJobUnreadSummary } from '../web-job-read.mjs';
import { listMessages, markMessageRead } from '../comm.mjs';
import { Fault, hash } from './protocol.mjs';

export function createReadState({ workersDir, now = Date.now }) {
  // Deliberately process-local: after a Connector restart, fetch a fresh view.
  const secret = randomBytes(32);
  const histories = new Map();
  const sign = payload => createHmac('sha256', secret).update(payload).digest('base64url');
  function receipt(data, canMark) {
    const revision = hash(JSON.stringify([data.kind, data.id, data.offset, data.status, data.lastEventAt]));
    const payload = Buffer.from(JSON.stringify({ ...data, revision, expiresAt: now() + 600000 })).toString('base64url');
    return { revision, ...(canMark ? { token: `${payload}.${sign(payload)}` } : {}) };
  }
  function capture(jobs, messages, { worker, principalId, canMark }) {
    const entries = [];
    const summary = buildWorkerJobUnreadSummary(workersDir, jobs).byJob;
    const jobStates = new Map(jobs.map(job => {
      const cursor = jobEventCursor(job), item = summary.get(job.id);
      // <= job.updatedAt disables the legacy desktop timestamp shortcut: even
      // an event appended before its job metadata update must remain unread.
      const readAt = new Date(Math.min(now(), Date.parse(job.updatedAt || job.createdAt) || 0)).toISOString();
      const data = { kind: 'job', id: job.id, worker, principalId, offset: cursor.eventOffset, lastEventAt: cursor.lastEventAt, status: job.status, readAt };
      const state = { unread: Boolean(item?.finishedUnread || item?.unread), ...receipt(data, canMark) };
      if (state.unread) entries.push({ ...data, revision: state.revision });
      return [job.id, state];
    }));
    const messageStates = new Map(messages.filter(m => m.from !== worker && (m.to === worker || m.to === '*')).map(m => {
      const data = { kind: 'message', id: m.id, worker, principalId }, state = { unread: !m.read, ...receipt(data, canMark) };
      if (state.unread) entries.push({ ...data, revision: state.revision });
      return [m.id, state];
    }));
    return { jobStates, messageStates, entries };
  }
  function captureHistory(jobs, messages, scope) {
    if (!scope.canMark) return null;
    const { entries } = capture(jobs, messages, { ...scope, canMark: false });
    if (!entries.length) return { unread: false };
    for (const [id, value] of histories) if (value.expiresAt <= now()) histories.delete(id);
    const id = hash(JSON.stringify(entries));
    if (!histories.has(id)) {
      while (histories.size >= 8) histories.delete(histories.keys().next().value);
      histories.set(id, { entries, expiresAt: now() + 600000 });
    }
    // One small capability covers the entire captured history, including rows
    // outside the phone's display window. Later events are never included.
    return { unread: true, ...receipt({ kind: 'history', id, worker: scope.worker, principalId: scope.principalId }, true) };
  }
  function mark(tokens, { worker, principalId, jobs }) {
    const messages = new Map(listMessages(workersDir, { worker, limit: 100000 }).filter(m => m.from !== worker).map(m => [m.id, m]));
    const jobMap = new Map(jobs.filter(j => j.worker === worker).map(j => [j.id, j]));
    // Check the whole batch before writing, including scope and expiration.
    const receipts = tokens.map(token => {
      const [payload, signature, extra] = token.split('.');
      const expected = sign(payload || '');
      if (extra !== undefined || !/^[A-Za-z0-9_-]{43}$/.test(signature || '') || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new Fault('READ_RECEIPT_INVALID', 409);
      let r; try { r = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { throw new Fault('READ_RECEIPT_INVALID', 409); }
      if (r.worker !== worker || r.principalId !== principalId || r.expiresAt <= now()) throw new Fault('READ_RECEIPT_EXPIRED_OR_SCOPE', 409);
      if (r.kind === 'history') {
        if (!histories.has(r.id) || histories.get(r.id).expiresAt <= now()) throw new Fault('READ_RECEIPT_EXPIRED_OR_SCOPE', 409);
      } else if (r.kind === 'job' ? !jobMap.has(r.id) : r.kind !== 'message' || !messages.has(r.id)) throw new Fault('READ_TARGET_NOT_FOUND', 404);
      return r;
    });
    const reads = readWebJobReadState(workersDir);
    const entries = receipts.flatMap(r => r.kind === 'history' ? histories.get(r.id).entries.filter(e => e.kind === 'job' ? jobMap.has(e.id) : messages.has(e.id)) : [r]);
    for (const r of entries) {
      if (r.kind === 'message') { markMessageRead(workersDir, { worker, messageId: r.id }); continue; }
      const previous = reads.get(r.id);
      const ended = status => ['done', 'failed', 'aborted', 'stale'].includes(status);
      const terminalUpgrade = previous?.readAt === r.readAt && !ended(previous.status) && ended(r.status);
      if (previous && (Number(previous.eventOffset) > r.offset || (Number(previous.eventOffset) === r.offset && String(previous.readAt) >= r.readAt && !terminalUpgrade))) continue;
      const event = { type: 'read', jobId: r.id, worker, eventOffset: r.offset, lastEventAt: r.lastEventAt, status: r.status, readAt: r.readAt, readBy: 'mobile' };
      mkdirSync(workersDir, { recursive: true });
      appendFileSync(webJobReadFile(workersDir), JSON.stringify(event) + '\n', 'utf8');
      reads.set(r.id, event);
    }
    return receipts.map(r => r.revision);
  }
  return { capture, captureHistory, mark };
}

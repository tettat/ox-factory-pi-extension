// Snapshot-driven, read-only warming. Heartbeats and token counters are not
// conversation changes; including them would repeatedly download every employee.
const stamp = value => Number.isFinite(Number(value)) ? Number(value) : Date.parse(value) || 0;
const busy = value => ['running', 'busy', 'working', 'queued'].includes(value);
export function conversationRevision(device, worker = {}) {
  const snapshot = device?.snapshot || {}, id = worker.id;
  const rows = (items, fields) => items.map(item => fields.map(k => item[k] ?? null)).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return JSON.stringify([
    worker.lastInteractionAt, worker.lastTalkReply?.updatedAt, worker.lastTalkReply?.contentPreview,
    worker.status, worker.unreadCount, worker.finishedUnreadJobs,
    rows((snapshot.jobs || []).filter(j => j.worker === id), ['id', 'status', 'updatedAt']),
    rows((snapshot.requests || []).filter(r => (r.to || r.worker) === id), ['id', 'status', 'createdAt', 'updatedAt', 'jobId']),
  ]);
}
export function conversationCandidates(devices, { selected = '', openedWorker = '', favorites = [], recent = {} } = {}) {
  const result = [];
  for (const device of devices) {
    if (!device.online) continue;
    for (const worker of device.snapshot?.workers || []) {
      if (!worker.id || worker.status === 'fired') continue;
      const key = JSON.stringify([device.id, worker.id]);
      const jobs = (device.snapshot.jobs || []).filter(j => j.worker === worker.id);
      const requests = (device.snapshot.requests || []).filter(r => (r.to || r.worker) === worker.id);
      const activity = Math.max(stamp(worker.lastInteractionAt), stamp(worker.lastTalkReply?.updatedAt), ...jobs.map(j => stamp(j.updatedAt || j.createdAt)), ...requests.map(r => stamp(r.updatedAt || r.createdAt)), 0);
      const unread = Math.max(Number(worker.unreadCount) || 0, Number(worker.finishedUnreadJobs) || 0) > 0;
      const active = busy(worker.status) || jobs.some(j => busy(j.status));
      const current = device.id === selected && worker.id === openedWorker;
      if (!current && !unread && !active && !activity && !recent[key] && !favorites.includes(key)) continue;
      result.push({ deviceId: device.id, worker: worker.id, revision: conversationRevision(device, worker), activity, active,
        priority: current ? 0 : unread ? 1 : recent[key] || favorites.includes(key) ? 2 : active ? 3 : 4 });
    }
  }
  return result.sort((a, b) => a.priority - b.priority || b.activity - a.activity || a.worker.localeCompare(b.worker));
}
export function prefetchDue(record, candidate, now = Date.now()) {
  if (record?.retryAt > now || record?.attemptAt > now - 5000) return false;
  return record?.revision !== candidate.revision || (candidate.active && now - (record?.at || 0) >= 30000);
}

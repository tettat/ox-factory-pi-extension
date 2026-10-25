// Private, origin-local conversation cache. No credentials, read capabilities,
// tool logs or automatic expiry; the user can explicitly clear this database.
const collections = ['jobs', 'messages', 'talkRequests', 'requests'];
export function cleanConversation(value = {}) {
  const { historyRead, ...out } = value;
  for (const key of collections) out[key] = (value[key] || []).map(entry => { const { readState, ...item } = entry; return item; });
  return out;
}
export function mergeConversation(old = {}, next = {}) {
  const out = { ...old, ...next };
  for (const key of collections) {
    const entries = new Map((old[key] || []).filter(x => x?.id).map(x => [x.id, x]));
    for (const entry of next[key] || []) if (entry?.id) {
      const previous = entries.get(entry.id);
      // A delayed disk/network snapshot must never resurrect a finished run.
      const ended = value => ['done', 'failed', 'aborted', 'stale', 'cancelled', 'completed'].includes(value);
      if (key === 'jobs' && previous && (ended(previous.status) && !ended(entry.status) || previous.updatedAt && entry.updatedAt && Date.parse(previous.updatedAt) > Date.parse(entry.updatedAt))) continue;
      const merged = { ...previous, ...entry };
      // Summary-only historical rows must not replace a full reply already read.
      if (previous?.reply && entry.reply === entry.summary && previous.updatedAt === entry.updatedAt) merged.reply = previous.reply;
      entries.set(entry.id, merged);
    }
    out[key] = [...entries.values()].sort((a, b) => String(a.createdAt || a.updatedAt || '').localeCompare(String(b.createdAt || b.updatedAt || '')));
  }
  return out;
}
export function conversationKey(principal, device, worker) { return JSON.stringify([principal, device, worker]); }
export function createConversationCache(indexedDB = globalThis.indexedDB) {
  let opening, generation = 0;
  function open() {
    if (!indexedDB) return Promise.reject(Error('LOCAL_CACHE_UNAVAILABLE'));
    if (!opening) opening = new Promise((resolve, reject) => {
      const request = indexedDB.open('ox-conversations-v1', 1); let failed = false;
      const fail = () => { failed = true; clearTimeout(timer); opening = null; reject(Error('LOCAL_CACHE_UNAVAILABLE')); };
      const timer = setTimeout(fail, 5000);
      request.onupgradeneeded = () => request.result.createObjectStore('conversations', { keyPath: 'key' });
      request.onerror = request.onblocked = fail;
      request.onsuccess = () => { clearTimeout(timer); const db = request.result; if (failed) { db.close(); return; } db.onversionchange = () => { db.close(); opening = null; }; resolve(db); };
    });
    return opening;
  }
  async function transact(mode, action, valid = () => true) {
    const db = await open();
    if (!valid()) return;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('conversations', mode); let result;
      tx.oncomplete = () => resolve(result);
      tx.onerror = tx.onabort = () => reject(Error('LOCAL_CACHE_UNAVAILABLE'));
      action(tx.objectStore('conversations'), value => { result = value; });
    });
  }
  return {
    load: key => transact('readonly', (store, done) => { const r = store.get(key); r.onsuccess = () => done(r.result || null); }),
    save: (key, data, metadata = {}) => {
      const epoch = generation;
      return transact('readwrite', (store, done) => {
        const r = store.get(key);
        r.onsuccess = () => {
          if (epoch !== generation) return;
          const value = cleanConversation(mergeConversation(r.result?.data, data));
          const record = { key, data: value, updatedAt: Date.now(), bytes: new TextEncoder().encode(JSON.stringify(value)).length,
            ...(typeof metadata.revision === 'string' ? { revision: metadata.revision, fetchedAt: metadata.fetchedAt || Date.now() } : {}) };
          store.put(record); done(record);
        };
      }, () => epoch === generation);
    },
    clear: () => { generation++; return transact('readwrite', store => { store.clear(); }); },
    stats: () => transact('readonly', (store, done) => {
      let conversations = 0, messages = 0, bytes = 0; const r = store.openCursor();
      r.onsuccess = () => { const c = r.result; if (!c) { done({ conversations, messages, bytes }); return; }
        conversations++; bytes += c.value.bytes || 0;
        for (const key of collections) messages += c.value.data[key]?.length || 0;
        c.continue();
      };
    }),
  };
}

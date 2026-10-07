// Public assistant speech and steer only. Incrementally read append-only events;
// tool/thinking traffic cannot evict earlier speech or leak into this view.
import { existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
const cache = new Map();
export function readPublicConversation(job) {
  const file = job.eventFile;
  if (!file || !existsSync(file)) return [];
  const stat = statSync(file);
  let state = cache.get(file);
  if (!state || stat.size < state.offset || state.ino !== stat.ino || (stat.size === state.offset && stat.mtimeMs !== state.mtimeMs)) {
    state = { offset: 0, ino: stat.ino, blocks: [], adjacent: false };
    cache.set(file, state);
  }
  if (stat.size > state.offset) {
    const fd = openSync(file, 'r');
    try {
      const bytes = Buffer.alloc(stat.size - state.offset);
      const count = readSync(fd, bytes, 0, bytes.length, state.offset);
      const end = bytes.subarray(0, count).lastIndexOf(10);
      if (end >= 0) {
        for (const line of bytes.subarray(0, end).toString('utf8').split('\n')) {
          let ev; try { ev = JSON.parse(line); } catch { continue; }
          if (!['text', 'steer'].includes(ev.type)) { state.adjacent = false; continue; }
          let text = String(ev.text || ev.message || '');
          if (!text) continue;
          while (text) {
            let last = state.blocks.at(-1);
            if (!state.adjacent || ev.type !== 'text' || last?.type !== 'text' || last.text.length >= 12000) {
              last = { id: `${job.id}:${state.blocks.length}`, type: ev.type, time: ev.time, text: '', queuedJobId: ev.queuedJobId || null };
              state.blocks.push(last);
            }
            const take = ev.type === 'text' ? Math.min(text.length, 12000 - last.text.length) : text.length;
            last.text += text.slice(0, take); text = text.slice(take);
            state.adjacent = ev.type === 'text';
          }
        }
        state.offset += end + 1;
      }
    } finally { closeSync(fd); }
  }
  state.mtimeMs = stat.mtimeMs;
  // Bound file count, not speech history. Evicted files can be reconstructed.
  if (cache.size > 64) cache.delete(cache.keys().next().value);
  return state.blocks.map(block => ({ ...block }));
}

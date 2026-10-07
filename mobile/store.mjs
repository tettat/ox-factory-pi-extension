import { mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return structuredClone(fallback); throw new Error(`Cannot read state: ${file}`, { cause: error }); }
}
export function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try { writeFileSync(tmp, JSON.stringify(value) + '\n', { mode: 0o600 }); renameSync(tmp, file); }
  finally { try { unlinkSync(tmp); } catch {} }
}
export function lockProcess(file) {
  mkdirSync(dirname(file), { recursive: true });
  const acquire = () => { const fd = openSync(file, 'wx', 0o600); writeFileSync(fd, String(process.pid)); closeSync(fd); };
  try { acquire(); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(readFileSync(file, 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('Lock requires manual inspection');
    let alive = true;
    try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
    if (alive) throw new Error('Service already running; refusing a second writer');
    unlinkSync(file); acquire();
  }
  return () => { try { if (Number(readFileSync(file, 'utf8')) === process.pid) unlinkSync(file); } catch {} };
}

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Explicitly load only the requested local provider. Do not trust all project
// resources or change global Pi defaults/credentials for unrelated employees.
export function piProviderArgs(worker, workersDir) {
  if (!String(worker?.model || '').startsWith('internlab/')) return [];
  const extension = resolve(workersDir, '../extensions/internlab-provider.ts');
  if (!existsSync(extension)) throw new Error('Shanghai AI Lab provider extension is missing');
  return ['--extension', extension];
}

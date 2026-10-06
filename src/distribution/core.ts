import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { acquireLock } from './lock.js';
const root = process.env.SEUDAILY_PROJECT_ROOT!;
await mkdir(resolve(root, '.seudaily'), { recursive: true, mode: 0o700 });
const release = await acquireLock(resolve(root, '.seudaily', 'core.lock'));
// Remove our own lock synchronously on process exit; the returned async release is for startup failure.
const { rmSync, readFileSync } = await import('node:fs');
const lockPath = resolve(root, '.seudaily', 'core.lock');
const ownerToken = JSON.parse(readFileSync(resolve(lockPath, 'owner.json'), 'utf8')).token;
process.once('exit', () => {
  // Startup failure may already have released the lock; never remove a new owner.
  try {
    if (JSON.parse(readFileSync(resolve(lockPath, 'owner.json'), 'utf8')).token === ownerToken)
      rmSync(lockPath, { recursive: true, force: true });
  } catch { /* released or absent */ }
});
try { await import('../server/main.js'); }
catch (error) { await release(); throw error; }

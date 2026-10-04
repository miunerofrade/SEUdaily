import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { acquireLock } from './lock.js';
const root = process.env.SEUDAILY_PROJECT_ROOT!;
await mkdir(resolve(root, '.seudaily'), { recursive: true, mode: 0o700 });
const release = await acquireLock(resolve(root, '.seudaily', 'core.lock'));
// Remove our own lock synchronously on process exit; the returned async release is for startup failure.
const { rmSync } = await import('node:fs');
process.once('exit', () => rmSync(resolve(root, '.seudaily', 'core.lock'), { recursive: true, force: true }));
try { await import('../server/main.js'); }
catch (error) { await release(); throw error; }

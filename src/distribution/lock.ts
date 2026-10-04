import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { dirname } from 'node:path';
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; } };
/** Publish the owner atomically before contending for the directory name. */
export async function acquireLock(path: string, waitMs = 0): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true });
  const token = randomUUID(), candidate = `${path}.${token}`;
  await mkdir(candidate);
  await writeFile(`${candidate}/owner.json`, JSON.stringify({ pid: process.pid, token }), { mode: 0o600 });
  const deadline = Date.now() + waitMs;
  try {
    while (true) {
      try { await rename(candidate, path); break; }
      catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        const owner = JSON.parse(await readFile(`${path}/owner.json`, 'utf8').catch(() => '{}'));
        if (owner.pid && !alive(owner.pid)) { await rm(path, { recursive: true, force: true }); continue; }
        if (Date.now() >= deadline) throw new Error(`已有进程使用该目录：${path}`);
        await delay(100);
      }
    }
  } finally { await rm(candidate, { recursive: true, force: true }); }
  return async () => {
    const owner = JSON.parse(await readFile(`${path}/owner.json`, 'utf8').catch(() => '{}'));
    if (owner.token === token) await rm(path, { recursive: true, force: true });
  };
}

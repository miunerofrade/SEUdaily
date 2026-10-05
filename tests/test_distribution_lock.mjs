import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock } from '../src/distribution/lock.ts';

test('lock release retries Windows sharing violations without releasing ownership early', async t => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'seudaily-lock-'));
  t.after(async () => { mock.restoreAll(); syncBuiltinESMExports(); await fs.rm(directory, { recursive: true, force: true }); });
  const path = join(directory, 'init.lock');
  const release = await acquireLock(path);
  const originalRename = fs.rename;
  let attempts = 0;
  mock.method(fs, 'rename', async (from, to) => {
    if (from === path && ++attempts <= 2) {
      assert.ok(JSON.parse(await fs.readFile(join(path, 'owner.json'), 'utf8')).token);
      throw Object.assign(new Error('Windows sharing violation'), { code: 'EPERM' });
    }
    return originalRename(from, to);
  });
  syncBuiltinESMExports();
  await release();
  assert.equal(attempts, 3);
  assert.deepEqual(await fs.readdir(directory), []);
  const releaseNext = await acquireLock(path);
  await releaseNext();
  assert.deepEqual(await fs.readdir(directory), []);
});

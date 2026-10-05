import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPlaywrightBrowserTools } from '../src/runtime/tools/browser-tools.ts';
import { searchCapabilitiesTool } from '../src/runtime/tools/tool-broker.ts';

test('browser tool discovery needs no optional installation or running browser', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'seudaily-browser-discovery-'));
  const previous = process.env.SEUDAILY_CACHE_DIR;
  process.env.SEUDAILY_CACHE_DIR = directory;
  t.after(async () => {
    if (previous === undefined) delete process.env.SEUDAILY_CACHE_DIR;
    else process.env.SEUDAILY_CACHE_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  });
  const tools = await getPlaywrightBrowserTools('fixture');
  assert.equal(Object.keys(tools).length, 8);
  assert.equal(tools.playwright_browser_navigate.inputSchema.parse({ url: 'https://example.com' }).url, 'https://example.com');
  const result = await searchCapabilitiesTool.execute({ query: '浏览器', namespace: 'browser' }, {
    requestContext: { get: key => key === 'seudailyRunToken' ? 'fixture-run' : key === 'seudailyThreadId' ? 'fixture' : undefined },
  });
  assert.equal(result.count, 5);
  assert.deepEqual(await readdir(directory), []);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { moduleFixture } from './helpers/module-fixture.mjs';

test('persistent Focus recovers interrupted runs once and retries a failed dependency through its public lifecycle', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'seudaily-focus-lifecycle-'));
  const key = 'focusFixture' + randomUUID(), calls = [];
  const before = process.env.SEUDAILY_PERSISTENT;
  let runtime, failed = false;
  t.after(async () => {
    runtime?.stopFocusRuntime();
    delete globalThis[key];
    if (before === undefined) delete process.env.SEUDAILY_PERSISTENT;
    else process.env.SEUDAILY_PERSISTENT = before;
    await rm(directory, { recursive: true, force: true });
  });
  globalThis[key] = async (action, payload) => {
    calls.push({ action, payload });
    if (action === 'list-focus') return { data: { items: [{
      id: 'notice', kind: 'notice', enabled: false, activeAgentRunId: 'old-lease',
    }] } };
    if (action === 'run-course-focus-queue' && !failed) {
      failed = true;
      throw Error('network unavailable');
    }
    return { data: {} };
  };
  process.env.SEUDAILY_PERSISTENT = '1';
  runtime = await moduleFixture(directory,
    "export {startFocusRuntime,stopFocusRuntime} from './src/runtime/focus-runtime.ts'", {
      '/application.js': "export const agentRuntime={runTurn(){throw Error('Disabled focus must not run')}};",
      '/tools/python-bridge.js': `export const runPythonTool=(...args)=>globalThis[${JSON.stringify(key)}](...args);`,
    });
  t.mock.method(console, 'error', () => {});
  t.mock.timers.enable({ apis: ['setTimeout'] });
  runtime.startFocusRuntime();
  t.mock.timers.runAll();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.filter(x => x.action === 'record-focus-agent-run').length, 1);
  const recovered = calls.find(x => x.action === 'record-focus-agent-run');
  assert.equal(recovered.payload.runId, 'old-lease');
  assert.equal(recovered.payload.runStatus, 'failed');
  assert.ok(!calls.some(x => x.action === 'claim-focus-agent-run'));

  t.mock.timers.runAll();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.filter(x => x.action === 'record-focus-agent-run').length, 1);
  assert.equal(calls.filter(x => x.action === 'run-course-focus-queue').length, 2);

  runtime.stopFocusRuntime();
  t.mock.timers.runAll();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.filter(x => x.action === 'run-course-focus-queue').length, 2);
});

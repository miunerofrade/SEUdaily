import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('experimental backup discovery is opt-in and writes require approval', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anyshare-tool-'));
  const previous = {...process.env};
  process.env.SEUDAILY_PROJECT_ROOT = root;
  process.env.SEUDAILY_INSTALL_ROOT = root;
  delete process.env.SEUDAILY_EXPERIMENTAL_ANYSHARE;
  delete process.env.CVSTREAM_EXPERIMENTAL_ANYSHARE;
  let store;
  try {
    const {createAnyShareBackupTool} = await import('../src/runtime/tools/anyshare-backup.ts');
    const {namespaceTools, searchCapabilitiesTool, invokeCapabilityTool} = await import('../src/runtime/tools/tool-broker.ts');
    await (await import('../src/runtime/knowledge/index.ts')).knowledge.ready;
    store = (await import('../src/runtime/storage.ts')).agentStore;
    await store.ready;
    assert.deepEqual(namespaceTools(['cloud-backup']), {});
    process.env.SEUDAILY_EXPERIMENTAL_ANYSHARE = 'true';
    assert.ok(namespaceTools(['cloud-backup'])['experimental-cloud-backup']);
    const calls = [];
    const tool = createAnyShareBackupTool(async (action, payload) => {calls.push([action,payload]);return {status:'completed'};});
    const backup = tool.inputSchema.parse({mode:'backup',paths:['exports'],parentDocid:'gns://root'});
    assert.equal(tool.requireApproval(backup, {}), true);
    assert.equal(tool.requireApproval({mode:'browse'}, {}), false);
    assert.equal(tool.requireApproval({mode:'plan',paths:['exports']}, {}), false);
    assert.equal(tool.requireApproval({mode:'download',parentDocid:'gns://root',docid:'gns://root/backups/file'}, {}), true);
    assert.throws(() => tool.inputSchema.parse({mode:'backup',paths:['exports']}));
    assert.throws(() => tool.inputSchema.parse({mode:'download',docid:'gns://root/../file',parentDocid:'gns://root'}));
    await tool.execute(backup, {});
    assert.deepEqual(calls, [['anyshare-backup',backup]]);
    const context = {requestContext:{get:key => key === 'seudailyRunToken' ? 'test-run' : undefined}};
    const found = await searchCapabilitiesTool.execute({query:'云盘备份',namespace:'cloud-backup'},context);
    assert.equal(found.count, 1);
    assert.equal(found.results[0].name, tool.id);
    assert.equal(await invokeCapabilityTool.requireApproval({ticket:found.results[0].ticket,arguments:backup},context),true);
  } finally {
    await store?.close();
    process.env = previous;
    await rm(root,{recursive:true,force:true});
  }
});

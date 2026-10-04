import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,mkdir,symlink,rm,readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const root=await mkdtemp(join(tmpdir(),'seudaily-workspace-'));
await writeFile(join(root,'package.json'),'{}');await writeFile(join(root,'pyproject.toml'),'[project]\nname="fixture"\n');
process.env.SEUDAILY_PROJECT_ROOT=root;
const {getWorkspaceTools,workspaceTarget,closeWorkspace}=await import('../src/runtime/workspace.ts');
const permissions=await import('../src/runtime/permission-state.ts');permissions.setFullAccessExtraEnabled(true);
const tools=await getWorkspaceTools();
const options={requestContext:new Map([['seudailyThreadId','fixture']])};
const tool=name=>tools['mastra_workspace_'+name];
process.on('exit',()=>closeWorkspace());
test('workspace rejects symlink escapes and stale writes, preserves replacement literals',async()=>{
 await writeFile(join(root,'example.txt'),'original');
 await assert.rejects(tool('write_file').execute({path:'example.txt',content:'unread'},options));
 await tool('read_file').execute({path:'example.txt'},options);
 await writeFile(join(root,'example.txt'),'changed');
 await assert.rejects(tool('edit_file').execute({path:'example.txt',oldText:'changed',newText:'replacement'},options));
 await tool('read_file').execute({path:'example.txt'},options);
 await tool('edit_file').execute({path:'example.txt',oldText:'changed',newText:'$& literal'},options);
 assert.equal(await readFile(join(root,'example.txt'),'utf8'),'$& literal');
 await symlink(tmpdir(),join(root,'escape'),'dir');
 await assert.rejects(workspaceTarget('escape/elsewhere',true));
 await assert.rejects(workspaceTarget('../outside',true));
});
test('native command execution succeeds in staging, rejects project writes and omits secrets',async()=>{
 const output=await tool('execute_command').execute({command:'printf sandbox-ok',background:false,timeout:5000},options);
 assert.equal(output.data.output,'sandbox-ok');assert.equal(output.data.exitCode,0);
 if(process.platform==='darwin'){
  assert.equal(output.data.sandboxMode,'native');
  const blocked=await tool('execute_command').execute({command:`printf denied > '${join(root,'outside.txt')}'`,background:false,timeout:5000},options);
  assert.notEqual(blocked.data.exitCode,0);
 }
 const env=await tool('execute_command').execute({command:'env',background:false,timeout:5000},options);
 assert.ok(!env.data.output.includes('DEEPSEEK_API_KEY='));
});
test('background command output and process tree cancellation are retained',async()=>{
 const launched=await tool('execute_command').execute({command:'printf background-ok; sleep 30',background:true,timeout:5000},options);
 await new Promise(resolve=>setTimeout(resolve,100));
 const output=await tool('get_process_output').execute({processId:launched.data.processId},options);assert.ok(output.data.output.includes('background-ok'));
 await tool('kill_process').execute({processId:launched.data.processId},options);
 const stopped=await tool('get_process_output').execute({processId:launched.data.processId},options);assert.notEqual(stopped.data.exitCode,null);
 closeWorkspace();await rm(root,{recursive:true,force:true});
});

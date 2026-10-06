import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
const source = await readFile(new URL('../src/runtime/focus-runtime.ts',import.meta.url),'utf8');
const ast = ts.createSourceFile('focus.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
const declarations = ast.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(ast)).join('\n');
const compiled = ts.transpileModule(declarations,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;

test('persistent Focus releases interrupted leases once and keeps retrying after dependency failure',async () => {
  const calls=[],delays=[];
  let dependencyFailed=false;
  const context=vm.createContext({exports:{},process:{env:{SEUDAILY_PERSISTENT:'1'}},console:{error:()=>{}},
    setTimeout:(_fn,delay)=>{delays.push(delay);return {unref(){}}},clearTimeout(){},
    runPythonTool:async (action,payload)=>{
      calls.push({action,payload});
      if(action==='list-focus') return {data:{items:[{id:'notice',kind:'notice',enabled:false,activeAgentRunId:'old-lease'}]}};
      if(action==='run-course-focus-queue' && !dependencyFailed){dependencyFailed=true;throw new Error('network unavailable');}
      return {data:{}};
    }});
  vm.runInContext(compiled+'\nglobalThis.runCycleForTest=runCycle;',context);
  const state={running:false,version:4};
  await context.runCycleForTest(state);
  assert.equal(state.recovered,true);
  assert.equal(state.running,false);
  assert.equal(delays.at(-1),5*60*1000);
  assert.equal(calls.filter(c=>c.action==='record-focus-agent-run').length,1);
  const recovery=calls.find(c=>c.action==='record-focus-agent-run');
  assert.equal(recovery.payload.runId,'old-lease'); assert.equal(recovery.payload.runStatus,'failed');
  assert.ok(!calls.some(c=>c.action==='claim-focus-agent-run'));
  await context.runCycleForTest(state);
  assert.equal(calls.filter(c=>c.action==='record-focus-agent-run').length,1);
  assert.equal(delays.at(-1),2*60*60*1000);
});

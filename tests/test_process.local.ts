import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Session} from '../src/terminal/session.js';
import {processLines} from '../src/terminal/process.js';
const plain=(message:any,expanded=false)=>processLines(message,100,expanded).map(row=>row.map(s=>s.text).join('')).join('\n');
test('alternating stream preserves order, pairs tools, automatically collapses after completion',async()=>{
 const root=await mkdtemp(join(tmpdir(),'seudaily-process-'));const s=new Session({command:'chat'},root);
 s.client.json=async()=>({});
 s.client.stream=async function*(){
  yield {type:'reasoning-start',payload:{}};
  yield {type:'reasoning-delta',payload:{text:'第一段思考\n详细推理'}};
  yield {type:'text-delta',payload:{text:'第一段正文'}};
  yield {type:'tool-call',payload:{toolCallId:'a',toolName:'查询'}};
  yield {type:'tool-result',payload:{toolCallId:'a',toolName:'查询',result:{summary:'查询结果'}}};
  yield {type:'reasoning-start',payload:{}};
  yield {type:'reasoning-delta',payload:{text:'第二段思考'}};
  s.reasoningExpanded=true;
  const m=s.messages.at(-1)!;const view=plain(m,true);
  assert.ok(view.indexOf('＋ 思考')<view.indexOf('第一段正文'));
  assert.ok(view.indexOf('查询结果')<view.lastIndexOf('＋ 思考'));
  yield {type:'text-delta',payload:{text:'最终正文'}};
  yield {type:'finish',payload:{}};
 };
 try{
 await mkdir(join(root,'.seudaily'));await s.submit('问题');const m=s.messages.at(-1)!;
 assert.deepEqual(m.process?.map(p=>p.type),['reasoning','text','tool','reasoning','text']);
 assert.equal(m.streaming,false);assert.equal(s.reasoningExpanded,false);
 const view=plain(m);assert.match(view,/第一段正文/);assert.match(view,/最终正文/);assert.doesNotMatch(view,/第一段思考/);
 assert.equal(m.text,'第一段正文最终正文');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('history restores reasoning/text/tool sequence and legacy final text',async()=>{
 const root=await mkdtemp(join(tmpdir(),'seudaily-process-'));const s=new Session({command:'chat'},root);
 s.client.json=async()=>({messages:[{role:'assistant',content:{parts:[{type:'reasoning',text:'旧思考'},{type:'text',text:'旧正文'},{type:'tool-invocation',toolInvocation:{toolCallId:'a',toolName:'查询',result:{summary:'旧结果'}}},{type:'reasoning',text:'新思考'},{type:'text',text:'结尾'}]}}]});
 try{await s.history();const m=s.messages[0];assert.deepEqual(m.process?.map(p=>p.type),['reasoning','text','tool','reasoning','text']);assert.match(plain(m,true),/＋ 思考/);assert.match(plain(m),/结尾/);
 assert.match(plain({role:'SEUdaily',text:'旧版正文',process:[{type:'reasoning',text:'旧思考'}]}),/旧版正文/);
 }finally{await rm(root,{recursive:true,force:true});}
});

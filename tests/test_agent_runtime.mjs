import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AgentRuntime } from '../src/agent/runtime.ts';
import { AgentStore } from '../src/agent/storage.ts';
import { ContextMemory } from '../src/agent/memory.ts';
import { DeepSeekProvider, parseSse } from '../src/agent/provider.ts';
const ctx = (threadId='test') => ({threadId,resourceId:'resource',runToken:randomUUID()});
const user = text => [{role:'user',content:text}];
const call = (id='call',name='probe',args='{}') => ({role:'assistant',content:null,tool_calls:[{id,type:'function',function:{name,arguments:args}}]});
const result = summary => ({status:'completed',taskId:'test',summary,artifacts:[],citations:[],warnings:[],metrics:{}});
class FakeProvider {
 requests=[]; summaries=[];
 constructor(responses){this.responses=responses;}
 async *stream(messages,tools,signal){this.requests.push(structuredClone(messages));signal?.throwIfAborted();const message=this.responses.shift();if(message instanceof Error)throw message;if(!message)throw new Error('missing fake response');if(message.content)yield {type:'text',text:message.content};yield {type:'complete',message,finishReason:message.tool_calls?'tool_calls':'stop'};}
 async summarize(messages){this.summaries.push(messages);if(this.failSummary)throw new Error('fixture');return JSON.stringify({goals:['keep goal'],constraints:['latest correction'],confirmedFacts:[],completedActions:[],pendingTasks:['next task'],references:[]});}
}
async function events(stream){const out=[];for await(const event of await stream)out.push(event);return out;}
function setup(t,responses,tools={},options={}){const store=new AgentStore(':memory:');t.after(()=>store.close());const provider=new FakeProvider(responses);const runtime=new AgentRuntime({store,provider,tools:async()=>tools,instructions:async()=>'system',...options});return {store,provider,runtime};}
test('chat persists raw history and supplies previous user/assistant once',async t=>{const f=setup(t,[{role:'assistant',content:'one'},{role:'assistant',content:'two'}]);await events(f.runtime.runTurn(user('first'),ctx()));await events(f.runtime.runTurn(user('second'),ctx()));const text=f.provider.requests[1].map(m=>m.content).filter(x=>typeof x==='string');assert.deepEqual(text,['system','first','one','second']);assert.equal((await f.store.allMessages('test','resource')).length,4);});
test('tools execute sequentially, validate defaults, and return compact model output',async t=>{const seen=[];const tool={id:'probe',description:'test',inputSchema:z.object({value:z.number().default(2)}),execute:async args=>{seen.push(args.value);return result('ok');},toModelOutput:()=>({type:'text',value:'compact'})};const message=call('first');message.tool_calls.push(call('second','probe','{"value":3}').tool_calls[0]);const f=setup(t,[message,{role:'assistant',content:'done'}],{probe:tool});const out=await events(f.runtime.runTurn(user('run'),ctx()));assert.deepEqual(seen,[2,3]);assert.equal(out.filter(e=>e.type==='tool-result').length,2);assert.deepEqual(f.provider.requests[1].filter(m=>m.role==='tool').map(m=>m.content),['compact','compact']);});
test('invalid arguments do not execute tool and feed a failed result back',async t=>{let executed=false;const f=setup(t,[call('bad','probe','{"value":"bad"}'),{role:'assistant',content:'invalid'}],{probe:{id:'probe',description:'test',inputSchema:z.object({value:z.number()}),execute:()=>{executed=true;}}});const out=await events(f.runtime.runTurn(user('run'),ctx()));assert.equal(executed,false);assert.equal(out.find(e=>e.type==='tool-result').payload.result.status,'failed');});
test('approval is bound to run/resource, consumed once, and rejection does not execute',async t=>{let count=0;const f=setup(t,[call(),{role:'assistant',content:'denied'}],{probe:{id:'probe',description:'test',inputSchema:z.object({}),requireApproval:true,execute:()=>{count++;return result('write');}}});const context=ctx();const out=await events(f.runtime.runTurn(user('run'),context));const approvalId=out.find(e=>e.type==='tool-approval-request').payload.approvalId;await assert.rejects(f.runtime.resumeApproval({approvalId,approved:true},{...context,resourceId:'wrong'}));await assert.rejects(f.runtime.runTurn(user('another'),ctx()));await events(f.runtime.resumeApproval({approvalId,approved:false},context));assert.equal(count,0);await assert.rejects(f.runtime.resumeApproval({approvalId,approved:true},context));});
test('waiting approval survives restart while executing runs become interrupted',async t=>{const directory=await mkdtemp(join(tmpdir(),'seudaily-agent-'));t.after(()=>rm(directory,{recursive:true,force:true}));const path=join(directory,'agent.db');let store=new AgentStore(path);let count=0;const tool={id:'probe',description:'test',inputSchema:z.object({}),requireApproval:true,execute:()=>{count++;return result('ok');}};let runtime=new AgentRuntime({store,provider:new FakeProvider([call()]),tools:async()=>({probe:tool}),instructions:async()=>''});const context=ctx();const out=await events(runtime.runTurn(user('run'),context));const approvalId=out.find(e=>e.type==='tool-approval-request').payload.approvalId;await store.close();store=new AgentStore(path);runtime=new AgentRuntime({store,provider:new FakeProvider([{role:'assistant',content:'done'}]),tools:async()=>({probe:tool}),instructions:async()=>''});await events(runtime.resumeApproval({approvalId,approved:true},context));assert.equal(count,1);const run=await store.getRun(context.runToken);run.status='running';run.executing='probe';await store.saveRun(run);await store.close();store=new AgentStore(path);await store.ready;assert.equal((await store.getRun(context.runToken)).status,'interrupted');await store.close();});
test('campus network error stops remaining calls without execution',async t=>{let count=0;const message=call('one');message.tool_calls.push(call('two').tool_calls[0]);const f=setup(t,[message],{probe:{id:'probe',description:'test',inputSchema:z.object({}),execute:()=>{count++;return {...result('需要校园网环境'),status:'failed',data:{errorCode:'campus_network_required'}};}}});const out=await events(f.runtime.runTurn(user('run'),ctx()));assert.equal(count,1);assert.equal(out.find(e=>e.type==='text-delta').payload.text,'需要校园网环境');assert.equal(f.provider.requests.length,1);});
test('step limit and model interruption retain visible error history',async t=>{const f=setup(t,[call()],{probe:{id:'probe',description:'test',inputSchema:z.object({}),execute:()=>result('ok')}},{maxSteps:1});const out=await events(f.runtime.runTurn(user('run'),ctx()));assert.ok(out.some(e=>e.type==='error'));const history=await f.store.allMessages('test','resource');assert.ok(history.at(-1).content.parts.some(p=>p.type==='error'));});
test('abort is propagated and same-thread concurrency is rejected',async t=>{const f=setup(t,[{role:'assistant',content:'done'}]);const context=ctx();const controller=new AbortController();const stream=await f.runtime.runTurn(user('run'),context,controller.signal);await assert.rejects(f.runtime.runTurn(user('overlap'),ctx()));controller.abort();const out=await events(stream);assert.ok(out.some(e=>e.type==='error'));assert.equal((await f.store.getRun(context.runToken)).status,'cancelled');assert.equal(f.runtime.isActive(context.threadId),false);});
test('summary preserves raw history, advances checkpoint and keeps recent turns',async t=>{const f=setup(t,[]);await f.store.ensureThread({threadId:'test',resourceId:'resource'});for(let i=0;i<12;i++){await f.store.saveMessage({id:'u'+i,threadId:'test',resourceId:'resource',role:'user',createdAt:new Date().toISOString(),content:{parts:[{type:'text',text:'goal '+i}]}});await f.store.saveMessage({id:'a'+i,threadId:'test',resourceId:'resource',role:'assistant',createdAt:new Date().toISOString(),content:{parts:[{type:'text',text:'answer '+i}]}});}const memory=new ContextMemory(f.store,f.provider,{lastMessages:5});const messages=await memory.build('test','resource',[{role:'system',content:'system'}],[],[]);assert.equal((await f.store.allMessages('test','resource')).length,24);assert.ok(await f.store.summary('test'));assert.ok(messages.some(m=>JSON.stringify(m.content).includes('goal 11')));assert.ok(!messages.some(m=>JSON.stringify(m.content).includes('goal 0')));const checkpoint=await f.store.summary('test');f.provider.failSummary=true;await assert.rejects(memory.build('test','resource',[],[],[],undefined,true));assert.deepEqual(await f.store.summary('test'),checkpoint);});
test('SSE parser handles split unicode, CRLF, multiple data lines and DONE',async()=>{const bytes=new TextEncoder().encode('data: {"text":"中文"}\r\n\r\ndata: [DONE]\n\n');const body=new ReadableStream({start(c){for(let i=0;i<bytes.length;i+=3)c.enqueue(bytes.slice(i,i+3));c.close();}});const out=[];for await(const event of parseSse(body))out.push(event);assert.deepEqual(out,[{text:'中文'}]);});

test('cancel after tool-call event cannot begin the tool side effect',async t=>{let executed=0;const f=setup(t,[call()],{probe:{id:'probe',description:'test',inputSchema:z.object({}),execute:()=>{executed++;return result('ok');}}});const controller=new AbortController();const context=ctx();const stream=await f.runtime.runTurn(user('run'),context,controller.signal);for await(const event of stream)if(event.type==='tool-call')controller.abort();assert.equal(executed,0);const run=await f.store.getRun(context.runToken);assert.equal(run.status,'cancelled');assert.ok(run.messages.some(m=>m.role==='tool'&&m.tool_call_id==='call'));});
test('prepared but unconsumed turn is cancelled and releases the session lock',async t=>{const f=setup(t,[{role:'assistant',content:'next'}]);const context=ctx();await f.runtime.runTurn(user('never consumed'),context);await f.runtime.discardUnstartedTurn(context);assert.equal(f.runtime.isActive('test'),false);assert.equal((await f.store.getRun(context.runToken)).status,'cancelled');await events(f.runtime.runTurn(user('next'),ctx()));});
test('history repair pairs interrupted calls and preserves nonstandard MCP/string results',async()=>{const {repairToolPairs,modelMessages}=await import('../src/agent/memory.ts');const first=call();const repaired=repairToolPairs([first,{role:'user',content:'next'}]);assert.deepEqual(repaired.map(m=>m.role),['assistant','tool','user']);for(const value of ['string-result',{content:[{type:'text',text:'mcp-result'}]},false,0]){const messages=modelMessages({role:'assistant',content:{parts:[{type:'tool-invocation',toolInvocation:{toolCallId:'id',toolName:'probe',args:{},result:value}}]}});assert.ok(messages.at(-1).content.includes(typeof value==='object'?'mcp-result':String(value)));}});
test('current user turn is protected from summary and failed force does not change history',async t=>{const f=setup(t,[]);await f.store.ensureThread({threadId:'test',resourceId:'resource'});await f.store.saveMessage({id:'current',threadId:'test',resourceId:'resource',role:'user',createdAt:new Date().toISOString(),content:{parts:[{type:'text',text:'X'.repeat(15000)}]}});const memory=new ContextMemory(f.store,f.provider,{windowTokens:32000});await memory.build('test','resource',[{role:'system',content:'Y'.repeat(5000)}],[],[],undefined,false,undefined,['current']);assert.equal(f.provider.summaries.length,0);assert.equal(await f.store.summary('test'),undefined);await assert.rejects(memory.build('test','resource',[],[],[],undefined,true,undefined,['current']));assert.equal((await f.store.allMessages('test','resource')).length,1);});
test('provider accumulates fragmented tool arguments and rejects incomplete streams',async()=>{const originalFetch=globalThis.fetch;try{const chunks=[{choices:[{delta:{tool_calls:[{index:0,id:'tool-1',function:{name:'probe',arguments:'{"v'}}]}}]},{choices:[{delta:{tool_calls:[{index:0,function:{arguments:'alue":2}'}}]},finish_reason:'tool_calls'}]}];globalThis.fetch=async()=>new Response(chunks.map(chunk=>'data: '+JSON.stringify(chunk)+'\n\n').join('')+'data: [DONE]\n\n');const provider=new DeepSeekProvider({apiKey:'fixture'});const out=[];for await(const event of provider.stream(user('test'),[]))out.push(event);assert.equal(out.at(-1).message.tool_calls[0].function.arguments,'{"value":2}');globalThis.fetch=async()=>new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');await assert.rejects(async()=>{for await(const event of provider.stream(user('test'),[])){}},/意外中断/);}finally{globalThis.fetch=originalFetch;}});
test('legacy SQLite import is read-only, validates IDs and is idempotent',async t=>{const {execFileSync}=await import('node:child_process');const directory=await mkdtemp(join(tmpdir(),'seudaily-import-'));t.after(()=>rm(directory,{recursive:true,force:true}));const old=join(directory,'old.db');const fresh=join(directory,'new.db');execFileSync(process.platform==='win32'?'python':'python3',['-c',`import sqlite3,sys,json\nc=sqlite3.connect(sys.argv[1])\nc.executescript("CREATE TABLE mastra_threads(id TEXT,resourceId TEXT,title TEXT,metadata TEXT,createdAt TEXT,updatedAt TEXT); CREATE TABLE mastra_messages(id TEXT,thread_id TEXT,resourceId TEXT,role TEXT,content TEXT,createdAt TEXT);")\nc.execute("INSERT INTO mastra_threads VALUES(?,?,?,?,?,?)",('old-thread','resource','title','{}','2026-01-01','2026-01-01'))\nc.execute("INSERT INTO mastra_messages VALUES(?,?,?,?,?,?)",('old-message','old-thread',None,'user',json.dumps({'content':'fixture','parts':[{'type':'text','text':'fixture'}]}),'2026-01-01'))\nc.commit();c.close()`,old]);const {readFile}=await import('node:fs/promises');const before=await readFile(old);let store=new AgentStore(fresh,old);await store.ready;assert.equal((await store.allMessages('old-thread','resource')).length,1);await store.close();assert.deepEqual(await readFile(old),before);store=new AgentStore(fresh,old);await store.ready;assert.equal((await store.allMessages('old-thread','resource')).length,1);await store.close();});
test('cancel token cannot stop a different run and nested usage is not summed as text',async t=>{
 const store=new AgentStore(':memory:');t.after(()=>store.close());let started;const ready=new Promise(resolve=>started=resolve);
 const provider={async *stream(messages,tools,signal){started();await new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});},async summarize(){throw new Error('unexpected');}};
 const runtime=new AgentRuntime({store,provider,tools:async()=>({}),instructions:async()=>''});const context=ctx();
 const pending=events(runtime.runTurn(user('wait'),context));await ready;
 assert.equal(runtime.cancelTurn(context.threadId,'wrong-token'),false);
 assert.equal(runtime.isActive(context.threadId),true);
 assert.equal(runtime.cancelTurn(context.threadId,context.runToken),true);
 await pending;
 const f=setup(t,[{role:'assistant',content:'ok'}]);f.provider.stream=async function*(){yield {type:'complete',message:{role:'assistant',content:'ok'},usage:{prompt_tokens:3,prompt_tokens_details:{cached_tokens:2}}};};
 const out=await events(f.runtime.runTurn(user('usage'),ctx()));assert.deepEqual(out.find(e=>e.type==='finish').payload.usage,{prompt_tokens:3});
});
test('reported usage persists in original history for CLI resume',async t=>{
 const store=new AgentStore(':memory:');t.after(()=>store.close());
 const usage={prompt_tokens:1000,completion_tokens:200,total_tokens:1200,prompt_cache_hit_tokens:750};
 const runtime=new AgentRuntime({store,instructions:async()=>'',tools:async()=>({}),provider:{async *stream(){yield {type:'complete',message:{role:'assistant',content:'ok'},finishReason:'stop',usage};}}});
 const out=await events(runtime.runTurn(user('usage'),ctx('usage-test')));
 assert.deepEqual(out.find(e=>e.type==='finish').payload.usage,usage);
 assert.deepEqual((await store.allMessages('usage-test','resource')).find(m=>m.role==='assistant').content.usage,usage);
});

test('default answer ID collision rejects without changing the conversation', async t => {
 const f=setup(t,[]);const context={...ctx(),runToken:'collision',userMessageId:'collision-assistant'};
 await assert.rejects(f.runtime.runTurn(user('original'),context),/不同 ID/);
 assert.deepEqual(await f.store.allMessages('test','resource'),[]);
 assert.equal(await f.store.getRun('collision'),undefined);
 await events(f.runtime.runTurn(user('next'),ctx()).then(async stream=>{f.provider.responses.push({role:'assistant',content:'ok'});return stream;}));
});
test('existing default answer ID is never overwritten and inserted input rolls back', async t => {
 const f=setup(t,[]);await f.store.ensureThread({threadId:'test',resourceId:'resource'});
 await f.store.saveMessage({id:'collision-assistant',threadId:'test',resourceId:'resource',role:'user',createdAt:new Date().toISOString(),content:{parentId:null,parts:[{type:'text',text:'keep'}]}});
 await assert.rejects(f.runtime.runTurn(user('new'),{...ctx(),runToken:'collision'}));
 const messages=await f.store.allMessages('test','resource');assert.equal(messages.length,1);assert.equal(messages[0].content.parts[0].text,'keep');assert.equal(await f.store.getRun('collision'),undefined);
});
test('concurrent cross-thread run token reuse reserves exactly one intact turn', async t => {
 const f=setup(t,[]);const token=randomUUID();const contexts=[{...ctx('one'),runToken:token},{...ctx('two'),runToken:token}];
 const results=await Promise.allSettled(contexts.map(context=>f.runtime.runTurn(user(context.threadId),context)));
 assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
 const run=await f.store.getRun(token);assert.ok(run);
 const loser=contexts.find(context=>context.threadId!==run.context.threadId);
 assert.deepEqual(await f.store.allMessages(loser.threadId,'resource'),[]);
 const winner=await f.store.allMessages(run.context.threadId,'resource');assert.equal(winner.length,2);assert.equal(winner[1].content.parentId,winner[0].id);
 await f.runtime.discardUnstartedTurn(run.context);
});
test('store updates cannot change message role, resource or thread ownership', async t => {
 const f=setup(t,[]);await f.store.ensureThread(ctx());const message={id:'owned',threadId:'test',resourceId:'resource',role:'user',createdAt:new Date().toISOString(),content:{parentId:null,parts:[{type:'text',text:'original'}]}};
 await f.store.saveMessage(message);
 for(const override of [{role:'assistant'},{threadId:'another'},{resourceId:'another'}])await assert.rejects(f.store.saveMessage({...message,...override,content:{parts:[{type:'text',text:'changed'}]}}));
 assert.equal((await f.store.allMessages('test','resource'))[0].content.parts[0].text,'original');
 await events(f.runtime.runTurn(user('owned run'),ctx()).then(async stream=>{f.provider.responses.push({role:'assistant',content:'ok'});return stream;}));
 const run=await f.store.getRun((await f.store.allMessages('test','resource')).at(-1).content.runToken);
 await assert.rejects(f.store.saveRun({...run,context:{...run.context,threadId:'another'}}));
});

test('resolved attachment text is persisted as user content, never system instructions',async t=>{
 const f=setup(t,[{role:'assistant',content:'ok'},{role:'assistant',content:'next'}],{}, {resolveDocuments: refs=>refs?.length?[{name:'report.pdf',markdown:'attachment body'}]:[]});
 const context={...ctx(),documentRefs:['ref']};
 await events(f.runtime.runTurn([{role:'user',content:[{type:'text',text:'question'},{type:'image_url',image_url:{url:'https://example.org/image.png'}}]}],context));
 const request=f.provider.requests[0];assert.equal(request[0].content,'system');
 const parts=request.find(m=>m.role==='user').content;assert.ok(parts.some(p=>p.type==='image_url'));assert.ok(parts.some(p=>p.text?.includes('attachment body')));
 await events(f.runtime.runTurn(user('followup'),ctx()));
 assert.ok(JSON.stringify(f.provider.requests[1].filter(m=>m.role==='user')).includes('attachment body'));
 assert.ok(!JSON.stringify(f.provider.requests[1].filter(m=>m.role==='system')).includes('attachment body'));
});

test('tool images survive approval and follow all tool replies as visual input', async t => {
  const store = new AgentStore(':memory:'); t.after(() => store.close());
  const messagesSeen = [];
  const image = {type:'image_url',image_url:{url:'seudaily-image-ref:calendar.png'},mediaType:'image/png'};
  const provider = {
    async *stream(messages) {
      messagesSeen.push(messages);
      const message = messagesSeen.length === 1 ? {
        role:'assistant',content:null,tool_calls:[call('image','page').tool_calls[0],call('approval','write').tool_calls[0]],
      } : {role:'assistant',content:'已读到校历'};
      yield {type:'complete',message};
    },
  };
  const runtime = new AgentRuntime({store,provider,instructions:async()=>'',tools:async()=>({
    page:{id:'page',description:'read',inputSchema:z.object({}),execute:async()=>result('校历'),toModelOutput:()=>({type:'content',value:[{type:'text',text:'学校通知 PDF 正文'},image]})},
    write:{id:'write',description:'write',inputSchema:z.object({}),requireApproval:true,execute:async()=>result('已确认')},
  })});
  const context = ctx('visual');
  const first = await events(runtime.runTurn(user('读校历'),context));
  const approval = first.find(item=>item.type === 'tool-approval-request');
  assert.ok(approval);
  assert.equal((await store.getRun(context.runToken)).pendingToolImages.at(-1).image_url.url,image.image_url.url);
  await events(runtime.resumeApproval({approvalId:approval.payload.approvalId,approved:true},context));
  const messages = messagesSeen.at(-1);
  const start = messages.findIndex(item=>item.tool_calls?.[0]?.id === 'image');
  assert.deepEqual(messages.slice(start+1,start+3).map(item=>[item.role,item.tool_call_id]), [['tool','image'],['tool','approval']]);
  assert.equal(messages[start+1].content,'学校通知 PDF 正文');
  assert.equal(messages[start+3].role,'user');
  assert.deepEqual(messages[start+3].content.at(-1),image);
  const saved = await store.getRun(context.runToken);
  assert.equal(saved.pendingToolImages,undefined);
  assert.equal(saved.messages.some(item=>Array.isArray(item.content) && item.content.some(part=>part.type === 'image_url')),true);
});

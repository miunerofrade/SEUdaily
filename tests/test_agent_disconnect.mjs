import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {getRequestListener} from '@hono/node-server';
import {agentEventStream} from '../src/server/agent-stream.ts';

const root=await mkdtemp(join(tmpdir(),'seudaily-disconnect-'));
await writeFile(join(root,'package.json'),'{}');await writeFile(join(root,'pyproject.toml'),'');
await mkdir(join(root,'.agent/skills'),{recursive:true});
process.env.SEUDAILY_PROJECT_ROOT=root;process.env.SEUDAILY_MANAGED='1';delete process.env.SEUDAILY_PERSISTENT;
const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
process.env.SEUDAILY_PORT=String(server.address().port);
const {app}=await import('../src/server/app.ts');
const {agentRuntime}=await import('../src/runtime/application.ts');
const {agentStore}=await import('../src/runtime/storage.ts');
const {stopMessageQueue}=await import('../src/server/message-queue.ts');
const {startClientReaper}=await import('../src/server/lifecycle.ts');
agentRuntime.config.instructions=async()=>'';agentRuntime.config.initialContext=async()=>[];agentRuntime.config.tools=async()=>({});agentRuntime.config.onCompleted=undefined;
server.on('request',getRequestListener(app.fetch));
const base='http://127.0.0.1:'+server.address().port;
const request=(path,body,signal)=>fetch(base+path,{method:body?'POST':'GET',headers:{'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal});
const input=thread=>({messages:'test',memory:{thread,resource:'fixture'},requestContext:{seudailyRunToken:thread,seudailyInterface:'web'}});
const history=thread=>request(`/api/memory/threads/${thread}/messages?resourceId=fixture`).then(response=>response.json());
const until=async(operation)=>{const deadline=Date.now()+5000;while(Date.now()<deadline){const value=await operation();if(value)return value;await new Promise(resolve=>setTimeout(resolve,20));}throw Error('condition timed out');};
after(async()=>{const queueStopped=stopMessageQueue();await agentRuntime.shutdown();await queueStopped;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));agentStore.close();await rm(root,{recursive:true,force:true});});

test('disconnect preserves a live task and partial snapshot; managed idle cleanup waits for completion',{timeout:15000},async t=>{
  let release,modelSignal,requests=0;
  agentRuntime.config.provider={async *stream(_messages,_tools,signal){requests++;modelSignal=signal;yield {type:'reasoning',text:'partial reasoning'};
    await new Promise((resolve,reject)=>{release=resolve;signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
    yield {type:'text',text:'finished after reload'};yield {type:'complete',message:{role:'assistant',content:'finished after reload'},finishReason:'stop'};},async summarize(){return '{}';}};
  const abort=new AbortController();const response=await request('/api/agents/seudaily-agent/stream',input('reload'),abort.signal);
  if(!response.ok)throw Error(`HTTP ${response.status}: ${await response.text()}`);
  await response.body.getReader().read();await until(()=>release);
  abort.abort();
  const snapshot=await history('reload');assert.equal(snapshot.activeRunToken,'reload');assert.match(JSON.stringify(snapshot),/partial reasoning/);
  let terminations=0;const onTerminate=()=>{terminations++;};process.on('SIGTERM',onTerminate);
  const stopReaper=startClientReaper();t.after(()=>{stopReaper();process.removeListener('SIGTERM',onTerminate);});
  await new Promise(resolve=>setTimeout(resolve,6200));
  assert.equal(modelSignal.aborted,false);assert.equal(agentRuntime.isActive('reload'),true);assert.equal(terminations,0);
  release();await until(()=>!agentRuntime.isActive('reload'));
  const finished=await history('reload');assert.equal(finished.activeRunToken,undefined);assert.match(JSON.stringify(finished),/finished after reload/);
  assert.doesNotMatch(JSON.stringify(finished),/已停止本次回答/);assert.equal(finished.messages.length,2);assert.equal(requests,1);
  await until(()=>terminations>0);
});

test('explicit stop still cancels a detached task and persists cancellation',async()=>{
  let modelSignal;
  agentRuntime.config.provider={async *stream(_messages,_tools,signal){modelSignal=signal;yield {type:'text',text:'waiting'};await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));},async summarize(){return '{}';}};
  const abort=new AbortController();const response=await request('/api/agents/seudaily-agent/stream',input('stop'),abort.signal);
  if(!response.ok)throw Error(`HTTP ${response.status}: ${await response.text()}`);
  await response.body.getReader().read();abort.abort();
  const wrong=await(await request('/api/memory/threads/stop/cancel?resourceId=fixture',{runToken:'wrong'})).json();
  assert.equal(wrong.cancelled,false);assert.equal(modelSignal.aborted,false);
  const stopped=await(await request('/api/memory/threads/stop/cancel?resourceId=fixture',{runToken:'stop'})).json();
  assert.equal(stopped.cancelled,true);assert.equal(stopped.active,false);assert.equal(modelSignal.aborted,true);
  assert.match(JSON.stringify(await history('stop')),/已停止本次回答/);
});

test('an unread HTTP observer cannot stall execution or retain an unlimited output buffer',async()=>{
  let count=0,done;const completed=new Promise(resolve=>{done=resolve;});
  const events={async *[Symbol.asyncIterator](){for(let i=0;i<3000;i++){count++;yield {type:'text-delta',payload:{text:'x'.repeat(1024)}};}done();}};
  const stream=agentEventStream(events,new AbortController().signal);
  await completed;assert.equal(count,3000);
  assert.ok((await new Response(stream).arrayBuffer()).byteLength<=1024*1024);
});

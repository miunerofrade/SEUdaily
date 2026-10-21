import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const root=await mkdtemp(join(tmpdir(),'seudaily-queue-'));
process.env.SEUDAILY_PROJECT_ROOT=root;
await writeFile(join(root,'package.json'),'{}');
await writeFile(join(root,'pyproject.toml'),'');
const {app}=await import('../src/server/app.ts');
const {agentRuntime}=await import('../src/runtime/application.ts');
const {agentStore}=await import('../src/runtime/storage.ts');
const {stopMessageQueue}=await import('../src/server/message-queue.ts');
const request=(path,method='GET',body)=>app.request('http://127.0.0.1:4111'+path,{method,headers:{host:'127.0.0.1:4111','Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
const queue=thread=>`/api/memory/threads/${thread}/queue?resourceId=fixture`;
const drain=async stream=>{for await(const _ of await stream){};};
async function until(check){const end=Date.now()+5000;while(Date.now()<end){const value=await check();if(value)return value;await new Promise(resolve=>setTimeout(resolve,30));}throw new Error('fixture timeout');}

test('shared queue preserves drafts, sends FIFO, pauses on cancel/error, and resumes explicitly',async t=>{
 t.after(async()=>{stopMessageQueue();agentRuntime.shutdown();await until(()=>!agentRuntime.isActive('hold')&&!agentRuntime.isActive('error'));await agentStore.close();await rm(root,{recursive:true,force:true});});
 const seen=[];let started;
 const ready=new Promise(resolve=>started=resolve);
 agentRuntime.config.tools=async()=>({});agentRuntime.config.instructions=async()=>'';
 agentRuntime.config.provider={async *stream(messages,_tools,signal){const text=messages.filter(m=>m.role==='user').at(-1)?.content;seen.push(text);if(text==='hold'){started();await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}if(text==='fail')throw new Error('fixture failure');yield {type:'text',text:'answer '+text};yield {type:'complete',message:{role:'assistant',content:'answer '+text},finishReason:'stop'};}};
 const running=drain(agentRuntime.runTurn([{role:'user',content:'hold'}],{threadId:'hold',resourceId:'fixture',runToken:'hold-run'}));await ready;
 const draft={text:'editable',images:[{ref:'fixture.png',name:'image.png',mediaType:'image/png',id:'image-id'}],documents:[{contextRef:'document-ref',name:'file.pdf',id:'document-id',charCount:12}],skills:[],interface:'cli'};
 const editable=await (await request(queue('hold'),'POST',draft)).json();
 const taken=await request(queue('hold').replace('?','/'+editable.id+'?'),'DELETE');assert.deepEqual(await taken.json(),draft);
 await request(queue('hold'),'POST',{text:'one'});await request(queue('hold'),'POST',{text:'two'});
 const cancelled=await request('/api/memory/threads/hold/cancel?resourceId=fixture','POST',{});assert.deepEqual(await cancelled.json(),{cancelled:true,active:false});await running;
 const paused=await (await request(queue('hold'))).json();assert.equal(paused.items.length,2);assert.ok(paused.items.every(item=>item.state==='paused'));assert.deepEqual(seen,['hold']);
 await request(queue('hold').replace('?','/resume?'),'POST',{});
 await until(async()=>!(await (await request(queue('hold'))).json()).items.length);
 assert.deepEqual(seen,['hold','one','two']);
 await request(queue('error'),'POST',{text:'fail',interface:'cli'});assert.equal((await agentStore.getThreadById({threadId:'error'})).metadata.channel,'cli');await request(queue('error'),'POST',{text:'after-error'});
 const failed=await until(async()=>{const value=await (await request(queue('error'))).json();return value.items[0]?.state==='failed'&&value;});
 assert.equal(failed.items.length,2);assert.equal(seen.includes('after-error'),false);
 await request(queue('error').replace('?','/'+failed.items[0].id+'?'),'DELETE');
 await request(queue('error').replace('?','/resume?'),'POST',{});
 await until(async()=>!(await (await request(queue('error'))).json()).items.length);assert.equal(seen.at(-1),'after-error');
 const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
 const uploaded=await (await request('/app/images','POST',{name:'image.png',dataUrl:png})).json();
 assert.ok(uploaded.ref);
 await request(queue('ten-images'),'POST',{text:'ten images',images:Array.from({length:10},()=>({ref:uploaded.ref,name:'image.png',mediaType:'image/png'}))});
 await until(async()=>!(await (await request(queue('ten-images'))).json()).items.length);
 assert.equal((await agentStore.allMessages('ten-images','fixture'))[0].content.parts.filter(part=>part.type==='file').length,10);
 const history=await agentStore.allMessages('hold','fixture');assert.deepEqual(history.filter(m=>m.role==='user').map(m=>m.content.content),['hold','one','two']);
 // A text correction is consumed by the current loop; an ordinary draft still
 // waits for its own turn, and stale tokens cannot target another execution.
 {
 let release,started;const gate=new Promise(resolve=>{release=resolve;});const ready=new Promise(resolve=>{started=resolve;});const requests=[];
 agentRuntime.config.provider={async *stream(messages){requests.push(structuredClone(messages));if(requests.length===1){yield {type:'text',text:'working'};started();await gate;}yield {type:'text',text:'finished'};yield {type:'complete',message:{role:'assistant',content:'finished'}};}};
 const steeringRun=drain(agentRuntime.runTurn([{role:'user',content:'start'}],{threadId:'steering',resourceId:'fixture',runToken:'steering-run'}));await ready;
 const stale=await request(queue('steering'),'POST',{text:'wrong run',delivery:'steer',runToken:'stale'});assert.equal(stale.status,409);
 const unsupported=await request(queue('steering'),'POST',{text:'with file',delivery:'steer',runToken:'steering-run',images:draft.images});assert.equal(unsupported.status,400);
 const accepted=await request(queue('steering'),'POST',{text:'correction',delivery:'steer',runToken:'steering-run'});assert.equal(accepted.status,200);
 const visible=await (await request(queue('steering'))).json();assert.equal(visible.items[0].delivery,'steer');
 release();await steeringRun;assert.equal(requests.length,2);assert.equal(requests[1].at(-1).content,'correction');
 assert.equal((await (await request(queue('steering'))).json()).items.length,0);
 assert.equal((await agentStore.allMessages('steering','fixture')).at(-1).content.parts.find(p=>p.type==='user-input').text,'correction');
 }
});

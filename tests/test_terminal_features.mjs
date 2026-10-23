import stringWidth from 'string-width';
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {getRequestListener} from '@hono/node-server';
import {z} from 'zod';
const root=await mkdtemp(join(tmpdir(),'seudaily-terminal-features-'));
await writeFile(join(root,'package.json'),'{}');await writeFile(join(root,'pyproject.toml'),'');await mkdir(join(root,'.agent/skills'),{recursive:true});
const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
process.env.SEUDAILY_PROJECT_ROOT=root;process.env.SEUDAILY_PORT=String(server.address().port);process.env.SEUDAILY_API_URL=`http://127.0.0.1:${server.address().port}`;
const {app}=await import('../src/server/app.ts');server.on('request',getRequestListener(app.fetch));
const {agentRuntime}=await import('../src/runtime/application.ts');const {agentStore}=await import('../src/runtime/storage.ts');
const {stopMessageQueue}=await import('../src/server/message-queue.ts');
const {Session}=await import('../src/terminal/session.ts');
const {processLines}=await import('../src/terminal/process.ts');const {statsText}=await import('../src/terminal/chat-features.ts');
agentRuntime.config.instructions=async()=>'';agentRuntime.config.initialContext=async()=>[];agentRuntime.config.onCompleted=undefined;
const complete=text=>({type:'complete',message:{role:'assistant',content:text},finishReason:'stop',usage:{prompt_tokens:1000,completion_tokens:20,prompt_cache_hit_tokens:800},metrics:{ttftMs:20,generationMs:100,generatedTokens:19}});
const echo={async *stream(messages){const text=messages.filter(m=>m.role==='user').at(-1)?.content;yield {type:'text',text:'reply:'+text};yield complete('reply:'+text);},async summarize(){return '{}';}};
agentRuntime.config.tools=async()=>({});
const make=async()=>{const s=new Session({command:'chat'},root);await s.initialize();return s;};
const until=async fn=>{for(let i=0;i<250;i++){if(await fn())return;await new Promise(r=>setTimeout(r,20));}throw Error('timed out');};
const text=m=>m.content?.parts?.filter(p=>p.type==='text').map(p=>p.text).join('') ?? '';
after(async()=>{const stopped=stopMessageQueue();await agentRuntime.shutdown();await stopped;server.closeAllConnections();await new Promise(r=>server.close(r));agentStore.close();await rm(root,{recursive:true,force:true});});

test('CLI keeps complete feedback collapsed and clears descendants when the group closes',async()=>{
 let calls=0;agentRuntime.config.tools=async()=>({probe:{id:'probe',description:'fixture',inputSchema:z.object({}),execute:async()=>{calls++;return {status:'completed',summary:'tool done',data:{full:'actual result'}};}}});
 agentRuntime.config.provider={...echo,async *stream(messages){if(!messages.some(m=>m.role==='tool'))yield {type:'complete',finishReason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[{id:'probe-call',type:'function',function:{name:'probe',arguments:'{}'}}]}};else{yield {type:'text',text:'done'};yield complete('done');}}};
 const s=await make();await s.submit('probe');const message=s.messages.find(m=>m.role==='SEUdaily'&&m.process?.some(p=>p.type==='tool'));
 const render=()=>processLines(message,100,false).flat().map(span=>span.text).join('');
 assert.equal(calls,1);assert.doesNotMatch(render(),/actual result/);
 await s.submit('/tools open');await s.submit('/tools 1');assert.match(render(),/actual result/);
 await s.submit('/tools close');await s.submit('/tools open');assert.doesNotMatch(render(),/actual result/);
 for(const row of processLines(message,24,false))assert.ok(stringWidth(row.map(span=>span.text).join(''))<=24);
 assert.match(statsText(s),/in 1,000 \/ out 20/);assert.match(statsText(s),/190 tok\/s/);
 await s.submit('/effort low');assert.equal((await s.client.json('/app/agent-info')).effort,'low');
 await s.submit('/effort');assert.ok(s.form.fields[0].choices.some(item=>item.value==='max'));s.form=null;
 agentRuntime.config.tools=async()=>({});
});

test('CLI graph operations create/select branches without overwriting original messages',async()=>{
 agentRuntime.config.provider=echo;const s=await make();await s.submit('one');await s.submit('two');
 const original=(await s.client.json(s.path('messages')+'&perPage=1000')).messages;
 const leaf=original.find(m=>m.role==='assistant'&&text(m)==='reply:two').id;
 await s.submit('/retry 1');assert.equal(s.messages.filter(m=>m.role==='你').length,1);
 await s.submit('/edit 1 edited');assert.equal(s.messages.find(m=>m.role==='你').text,'edited');
 const all=(await s.client.json(s.path('messages')+'&perPage=1000')).messages;assert.ok(all.some(m=>text(m)==='one'));assert.ok(all.some(m=>text(m)==='edited'));
 await s.submit('/version '+leaf);assert.ok(s.messages.some(m=>m.text==='reply:two'));
 const thread=s.threadId;await s.submit('/branch 1');assert.notEqual(s.threadId,thread);assert.ok(s.messages.some(m=>m.text==='one'));
});

test('CLI steering preserves literal text and a second client follows the same live run to completion',async()=>{
 let release,requests=0;agentRuntime.config.provider={...echo,async *stream(messages,_tools,signal){requests++;const text=messages.filter(m=>m.role==='user').at(-1).content;if(text==='hold'){yield {type:'reasoning',text:'live snapshot'};await new Promise((resolve,reject)=>{release=resolve;signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});yield complete('initial');}else{yield {type:'text',text:'reply:'+text};yield complete('reply:'+text);}}};
 const s=await make();const running=s.submit('hold');await until(()=>release);
 const observer=await make();await observer.resume(s.threadId);await observer.pollQueue();assert.equal(observer.queueActive,true);assert.ok(observer.messages.some(m=>m.reasoning==='live snapshot'));
 const requirement='quote " and \'\nsecond line';await s.submit('/steer '+requirement);
 const rows=(await s.client.json(s.path('queue'))).items;assert.equal(rows[0].text,requirement);assert.equal(rows[0].delivery,'steer');
 release();await running;await observer.pollQueue();assert.equal(observer.queueActive,false);assert.ok(observer.messages.some(m=>m.text==='reply:'+requirement));assert.equal(requests,2);
});

test('a resumed CLI cancels the existing run with its server token',async()=>{
 let started,signal;agentRuntime.config.provider={...echo,async *stream(_messages,_tools,abort){signal=abort;yield {type:'text',text:'working'};await new Promise((_,reject)=>{started=true;abort.addEventListener('abort',()=>reject(abort.reason),{once:true});});}};
 const original=await make();const running=original.submit('cancel');await until(()=>started);
 const observer=await make();await observer.resume(original.threadId);await observer.pollQueue();await observer.cancel();await running;
 assert.equal(signal.aborted,true);assert.equal(agentRuntime.isActive(original.threadId),false);
});

test('editing a user turn carries its original image into the new branch',async()=>{
 agentRuntime.config.provider=echo;const s=await make();
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0AAAAABJRU5ErkJggg==','base64');
 await s.attachClipboardImage(png,'image/png');await s.submit('image');
 const before=(await s.client.json(s.path('messages')+'&selectedPath=true')).messages.find(m=>m.role==='user');
 await s.submit('/edit 1 describe');
 const after=(await s.client.json(s.path('messages')+'&selectedPath=true')).messages.find(m=>m.role==='user');
 assert.notEqual(before.id,after.id);assert.deepEqual(after.content.parts.filter(p=>p.type==='file'),before.content.parts.filter(p=>p.type==='file'));
 assert.ok(after.content.parts.some(p=>p.type==='file'));assert.match(text(after),/describe/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
const root=await mkdtemp(join(tmpdir(),'seudaily-title-'));
await writeFile(join(root,'package.json'),'{}');await writeFile(join(root,'pyproject.toml'),'');
process.env.SEUDAILY_PROJECT_ROOT=root;
const {AgentStore}=await import('../src/agent/storage.ts');
const {agentStore}=await import('../src/runtime/storage.ts');
const {generateFirstTurnTitle,titleGenerationTasks}=await import('../src/runtime/conversation-title.ts');
test.after(async()=>{await Promise.allSettled([...titleGenerationTasks.values()]);await agentStore.client.close();await rm(root,{recursive:true,force:true});});
async function fixture(t,resource='fixture',channel='web'){
 const store=new AgentStore(':memory:');await store.ready;t.after(()=>store.client.close());
 const threadId=randomUUID();await store.ensureThread({threadId,resourceId:resource,interface:channel});
 const input={threadId,resourceId:resource,titleInput:''};
 const add=text=>store.saveMessage({id:randomUUID(),threadId,resourceId:resource,role:'user',createdAt:new Date().toISOString(),content:{parts:[{type:'text',text}]}});
 return {store,input,add,thread:()=>store.getThreadById(input)};
}
test('web, CLI and WeChat wait through greetings, name on the first topic and keep that name',async t=>{
 for(const channel of ['web','cli','wechat']){
  const f=await fixture(t,channel==='wechat'?'seudaily-wechat-local':'fixture',channel);let calls=0;
  if(channel==='wechat')await f.store.patchThread({id:f.input.threadId,title:'微信 · 你好'});
  const dependencies={store:f.store,request:async text=>{calls++;assert.equal(text,'帮我查数据结构课程字幕');return '数据结构课程字幕';}};
  await f.add('你好！');assert.equal((await generateFirstTurnTitle(f.input,dependencies)).reason,'waiting-for-topic');assert.equal(calls,0);
  await f.add('帮我查数据结构课程字幕');assert.equal((await generateFirstTurnTitle(f.input,dependencies)).generated,true);
  await f.add('再查其他课程');assert.equal((await generateFirstTurnTitle(f.input,dependencies)).reason,'already-generated');assert.equal(calls,1);
 }
});
test('manual titles and existing named histories are preserved',async t=>{
 const f=await fixture(t);await f.add('请求');await f.store.patchThread({id:f.input.threadId,title:'我指定的名字',metadata:{titleManual:true}});
 const dependencies={store:f.store,request:async()=>{throw new Error('must not call');}};
 assert.equal((await generateFirstTurnTitle(f.input,dependencies)).reason,'manual-title');
 await f.store.patchThread({id:f.input.threadId,title:'历史标题',metadata:{}});await f.add('后续问题');
 assert.equal((await generateFirstTurnTitle(f.input,dependencies)).reason,'not-first-turn');
});
test('concurrent title requests deduplicate and preserve a manual edit while the model is running',async t=>{
 const f=await fixture(t);await f.add('具体主题');let release,started;const began=new Promise(resolve=>started=resolve);let calls=0;
 const dependencies={store:f.store,request:async()=>{calls++;started();return await new Promise(resolve=>release=resolve);}};
 const first=generateFirstTurnTitle(f.input,dependencies),second=generateFirstTurnTitle(f.input,dependencies);
 assert.equal(first,second);await began;
 await f.store.patchThread({id:f.input.threadId,title:'手动新标题',metadata:{titleManual:true,activeLeaf:'latest-message'}});
 release('模型标题');assert.equal((await first).reason,'title-changed');assert.equal(calls,1);
 assert.equal((await f.thread()).title,'手动新标题');assert.equal((await f.thread()).metadata.activeLeaf,'latest-message');
});
test('old WeChat temporary names recover from the earliest real topic and failures can retry',async t=>{
 const f=await fixture(t,'seudaily-wechat-local','wechat');await f.store.patchThread({id:f.input.threadId,title:'微信 · 你好'});
 await f.add('你好');await f.add('转专业政策');await f.add('现在查字幕');
 await assert.rejects(generateFirstTurnTitle(f.input,{store:f.store,request:async()=>{throw new Error('fixture unavailable');}}));
 assert.equal((await f.thread()).metadata.titleGenerationError,'fixture unavailable');
 await generateFirstTurnTitle(f.input,{store:f.store,request:async text=>{assert.equal(text,'转专业政策');return '转专业政策';}});
 assert.equal((await f.thread()).title,'转专业政策');assert.equal((await f.thread()).metadata.titleGenerationError,undefined);
});

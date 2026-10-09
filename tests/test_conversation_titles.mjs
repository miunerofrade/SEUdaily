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
const {ensureConversationTitle,titleGenerationTasks}=await import('../src/runtime/conversation-title.ts');
test.after(async()=>{await Promise.allSettled([...titleGenerationTasks.values()]);await agentStore.client.close();await rm(root,{recursive:true,force:true});});
async function fixture(t,resource='fixture',channel='web'){
 const store=new AgentStore(':memory:');await store.ready;t.after(()=>store.client.close());
 const threadId=randomUUID();await store.ensureThread({threadId,resourceId:resource,interface:channel});
 const input={threadId,resourceId:resource};
 const add=text=>store.saveMessage({id:randomUUID(),threadId,resourceId:resource,role:'user',createdAt:new Date().toISOString(),content:{parts:[{type:'text',text}]}});
 return {store,input,add,thread:()=>store.getThreadById(input)};
}
test('web, CLI and WeChat wait through greetings, name on the first topic and keep that name',async t=>{
 for(const channel of ['web','cli','wechat','future-mobile']){
  const f=await fixture(t,channel==='wechat'?'seudaily-wechat-local':'fixture',channel);let calls=0;
  const dependencies={store:f.store,request:async text=>{calls++;assert.equal(text,'帮我查数据结构课程字幕');return '数据结构课程字幕';}};
  await f.add('你好！');assert.equal((await ensureConversationTitle(f.input,dependencies)).reason,'waiting-for-topic');assert.equal(calls,0);
  await f.add('帮我查数据结构课程字幕');assert.equal((await ensureConversationTitle(f.input,dependencies)).generated,true);
  await f.add('再查其他课程');assert.equal((await ensureConversationTitle(f.input,dependencies)).reason,'already-generated');assert.equal(calls,1);
 }
});
test('manual titles and existing named histories are preserved',async t=>{
 const f=await fixture(t);await f.add('请求');await f.store.patchThread({id:f.input.threadId,title:'我指定的名字',metadata:{titleManual:true}});
 const dependencies={store:f.store,request:async()=>{throw new Error('must not call');}};
 assert.equal((await ensureConversationTitle(f.input,dependencies)).reason,'manual-title');
 await f.store.patchThread({id:f.input.threadId,title:'历史标题',metadata:{}});await f.add('后续问题');
 assert.equal((await ensureConversationTitle(f.input,dependencies)).reason,'existing-title');
});
test('concurrent title requests deduplicate and preserve a manual edit while the model is running',async t=>{
 const f=await fixture(t);await f.add('具体主题');let release,started;const began=new Promise(resolve=>started=resolve);let calls=0;
 const dependencies={store:f.store,request:async()=>{calls++;started();return await new Promise(resolve=>release=resolve);}};
 const first=ensureConversationTitle(f.input,dependencies),second=ensureConversationTitle(f.input,dependencies);
 assert.equal(first,second);await began;
 await f.store.patchThread({id:f.input.threadId,title:'手动新标题',metadata:{titleManual:true,activeLeaf:'latest-message'}});
 release('模型标题');assert.equal((await first).reason,'title-changed');assert.equal(calls,1);
 assert.equal((await f.thread()).title,'手动新标题');assert.equal((await f.thread()).metadata.activeLeaf,'latest-message');
});
test('failed background naming retries the original topic without any client naming request',async t=>{
 const f=await fixture(t,'future-resource','future-client');
 await f.add('你好');await f.add('转专业政策');await f.add('现在查字幕');
 await assert.rejects(ensureConversationTitle(f.input,{store:f.store,request:async()=>{throw new Error('fixture unavailable');}}));
 assert.equal((await f.thread()).metadata.titleGenerationError,'fixture unavailable');
 await ensureConversationTitle(f.input,{store:f.store,request:async text=>{assert.equal(text,'转专业政策');return '转专业政策';}});
 assert.equal((await f.thread()).title,'转专业政策');assert.equal((await f.thread()).metadata.titleGenerationError,undefined);
});

test('new unknown clients share attachment naming and do not use supplied naming prompts',async t=>{
 const f=await fixture(t,'new-mobile-resource','mobile');
 await f.add('你好\n\n<!-- seudaily:documents -->\n【附件：大学生手册.pdf】\n附件正文不应影响标题');
 await ensureConversationTitle({...f.input,titleInput:'客户端自定义方案'}, {store:f.store,request:async text=>{
   assert.equal(text,'大学生手册.pdf');return '大学生手册';
 }});
 assert.equal((await f.thread()).title,'大学生手册');
 const [summary]=await f.store.listConversations();
 assert.equal(summary.source,'mobile');assert.equal(summary.title,'大学生手册');
});

test('conversation listing discovers new clients and excludes program threads before pagination',async t=>{
 const f=await fixture(t,'new-client-resource','new-client');await f.add('新的主题');
 await f.store.ensureThread({threadId:'program',resourceId:'another-program',interface:'program'});
 await f.store.ensureThread({threadId:'focus',resourceId:'focus-fixture'});
 const page=await f.store.listConversations(1,0);
 assert.equal(page.length,1);assert.equal(page[0].id,f.input.threadId);assert.equal(page[0].source,'new-client');
 assert.equal(page[0].title,'新对话');assert.deepEqual(await f.store.listConversations(1,1),[]);
 assert.equal((await ensureConversationTitle({threadId:'program',resourceId:'another-program'},{store:f.store,request:async()=>{throw Error('must not name');}})).reason,'program-title');
});

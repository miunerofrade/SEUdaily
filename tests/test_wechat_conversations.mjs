import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentStore } from '../src/agent/storage.ts';
import { AgentRuntime } from '../src/agent/runtime.ts';
import { WeChatConversations, WECHAT_RESOURCE } from '../src/wechat/conversations.ts';
import { WeChatRuntime } from '../src/wechat/runtime.ts';
import { WeChatError } from '../src/wechat/protocol.ts';
import { z } from 'zod';

const account = {token:'fixture-token',botId:'fixture-bot',userId:'fixture-owner',base:'https://ilinkai.weixin.qq.com',cursor:'',needsLogin:false};
async function eventually(check) {
  const until = Date.now()+4000; let last;
  do {try {return await check();} catch (error) {last=error;await delay(5);}} while(Date.now()<until);
  throw last;
}
async function fixture(t, options={}) {
  const store = new AgentStore(':memory:'); await store.ready;
  const seed = new WeChatRuntime(store.client); await seed.initialize(); await seed.close();
  await store.client.execute({sql:'INSERT INTO wechat_account VALUES(1,?)',args:[JSON.stringify(account)]});
  const requests=[], batches=[], replies=[];let counter=0;
  const provider={async *stream(messages,tools,signal) {
    requests.push(structuredClone(messages));
    if(options.stream) {yield* options.stream(messages,tools,signal);return;}
    const text='答：'+messages.filter(message=>message.role==='user').at(-1).content;
    yield {type:'text',text};yield {type:'complete',message:{role:'assistant',content:text},finishReason:'stop'};
  },async summarize(){throw new Error('unexpected summary call');}};
  const agent=new AgentRuntime({store,provider,tools:async()=>options.tools??{},instructions:async()=>'fixture'});
  const conversations=new WeChatConversations(store,agent);
  const protocol={updates:async(a,signal)=>{
    while(!batches.length) await delay(5,undefined,{signal});
    return {msgs:batches.shift(),get_updates_buf:String(counter)};
  },send:async(a,payload)=>{if(options.failSend?.()) throw new Error('offline');replies.push(structuredClone(payload));return {};}};
  let runtime=new WeChatRuntime(store.client,protocol,5,conversations);await runtime.start();
  t.after(async()=>{await runtime.close();await agent.shutdown();await store.close();});
  return {store,agent,conversations,requests,replies,
    status:()=>runtime.status(),
    async restart(){await runtime.close();runtime=new WeChatRuntime(store.client,protocol,5,conversations);await runtime.start();},
    send(...texts){const ids=texts.map(text=>{const id=String(++counter);batches.push([{message_id:id,from_user_id:account.userId,to_user_id:account.botId,context_token:'route-'+id,item_list:[{type:1,text_item:{text}}]}]);return id;});return ids;},
    async reply(id){return eventually(()=>{const reply=replies.find(item=>item.context_token==='route-'+id);assert.ok(reply,'reply '+id);return reply.item_list[0].text_item.text;});},
  };
}

test('help, stable numbered sessions and invalid commands work without invoking a model',async t=>{
  const f=await fixture(t);
  assert.match(await f.reply(f.send('/help')[0]),/\/context.*\n\/history/);
  assert.equal((await f.status()).currentSession,undefined);
  const id=f.send('/new 复习电磁学')[0];assert.match(await f.reply(id),/已新建 #1/);
  assert.match(await f.reply(f.send('/new 周末安排')[0]),/#2/);
  const listing=await f.reply(f.send('/sessions')[0]);assert.match(listing,/★ #2 周末安排/);assert.match(listing,/#1 复习电磁学/);
  assert.match(await f.reply(f.send('/use 1')[0]),/已切换到 #1「复习电磁学」/);
  const current=(await f.status()).currentSession;
  assert.equal(current.number,1);
  assert.match(await f.reply(f.send('/use 999')[0]),/没有找到/);
  assert.equal((await f.status()).currentSession.threadId,current.threadId);
  assert.match(await f.reply(f.send('/history nope')[0]),/用法/);
  assert.match(await f.reply(f.send('/sessions 0')[0]),/用法/);
  assert.match(await f.reply(f.send('/anything')[0]),/\/help/);
  assert.equal(f.requests.length,0);
  const rows=(await f.store.client.execute('SELECT * FROM wechat_sessions')).rows;assert.equal(rows.length,2);
  await f.restart();assert.equal((await f.status()).currentSession.number,1);
  // Re-routing a duplicate committed command cannot create an extra session.
  const row=(await f.store.client.execute({sql:'SELECT * FROM wechat_messages WHERE id=?',args:[id]})).rows[0];
  await assert.rejects(f.conversations.route(row,{...account,userId:'other-owner'}),/不属于当前绑定/);
  await f.conversations.route(row,account);assert.equal((await f.store.client.execute('SELECT * FROM wechat_sessions')).rows.length,2);
});

test('ordinary messages share Agent history, context and selected branches with Web/TUI',async t=>{
  const f=await fixture(t);
  assert.equal(await f.reply(f.send('记住我要复习电磁学')[0]),'答：记住我要复习电磁学');
  const first=(await f.status()).currentSession;
  assert.equal(await f.reply(f.send('刚才说什么')[0]),'答：刚才说什么');
  assert.ok(f.requests[1].some(message=>message.content==='记住我要复习电磁学'));
  assert.ok(f.requests[1].some(message=>message.content==='答：记住我要复习电磁学'));
  assert.equal((await f.store.allMessages(first.threadId,WECHAT_RESOURCE)).length,4);
  assert.equal((await f.store.listThreads(WECHAT_RESOURCE)).length,1);
  const selected=await f.store.contextMessages(first.threadId,WECHAT_RESOURCE);
  await f.store.saveSummary(selected.summaryKey,{throughSequence:1,value:{goals:['复习电磁学'],pendingTasks:['整理例题']},updatedAt:new Date().toISOString()});
  const context=await f.reply(f.send('/context')[0]);assert.match(context,/目标：复习电磁学/);assert.match(context,/待办：整理例题/);assert.match(context,/最近讨论/);
  assert.match(await f.reply(f.send('/history')[0]),/你：记住我要复习电磁学/);
  await f.reply(f.send('/new 周末')[0]);
  assert.equal(await f.reply(f.send('准备郊游')[0]),'答：准备郊游');
  assert.ok(!f.requests.at(-1).some(message=>String(message.content).includes('电磁学')));
  assert.match(await f.reply(f.send('/use 1')[0]),/最近回复：答：刚才说什么/);
  assert.equal((await f.status()).currentSession.threadId,first.threadId);
  // A title change in another interface changes the label but never the channel selection.
  await f.store.patchThread({id:first.threadId,title:'微信 · 边界条件'});
  assert.match(await f.reply(f.send('/context')[0]),/边界条件/);
});

test('new sessions and help stay responsive during a slow answer, which retains its original route',async t=>{
  let release;const gate=new Promise(resolve=>release=resolve);let turns=0;
  t.after(()=>release());
  const f=await fixture(t,{stream:async function*(messages,tools,signal){
    if(++turns===1) await Promise.race([gate,delay(60000,undefined,{signal})]);
    const text='完成：'+messages.filter(message=>message.role==='user').at(-1).content;
    yield {type:'text',text};yield {type:'complete',message:{role:'assistant',content:text},finishReason:'stop'};
  }});
  const old=f.send('慢慢整理课程')[0];await eventually(()=>assert.equal(f.requests.length,1));
  assert.match(await f.reply(f.send('/new 周末')[0]),/#2/);
  assert.match(await f.reply(f.send('/help')[0]),/微信聊天/);
  assert.equal(await f.reply(f.send('安排周末')[0]),'完成：安排周末');
  release();assert.match(await f.reply(old),/来自「慢慢整理课程」\n\n完成：慢慢整理课程/);
  assert.equal((await f.status()).currentSession.number,2);
  assert.equal(f.replies.find(reply=>reply.context_token==='route-'+old).to_user_id,account.userId);
});

test('same-session messages run in order; sending retries never execute the Agent twice',async t=>{
  let offline=false;const f=await fixture(t,{failSend:()=>offline});
  const ids=f.send('第一条','第二条');await f.reply(ids[0]);await f.reply(ids[1]);
  assert.equal(f.requests.length,2);assert.ok(f.requests[1].some(message=>message.content==='答：第一条'));
  offline=true;const third=f.send('回复后断网')[0];
  await eventually(async()=>{const row=(await f.store.client.execute({sql:'SELECT * FROM wechat_messages WHERE id=?',args:[third]})).rows[0];assert.equal(row?.state,'pending');assert.equal(row.reply,'答：回复后断网');});
  // Simulate a crash after Agent committed the answer but before the channel stored its reply.
  await f.store.client.execute({sql:"UPDATE wechat_messages SET state='queued',reply='' WHERE id=?",args:[third]});
  assert.equal(f.requests.length,3);offline=false;await f.restart();
  assert.equal(await f.reply(third),'答：回复后断网');assert.equal(f.requests.length,3);
  const row=(await f.store.client.execute({sql:'SELECT payload FROM wechat_messages WHERE id=?',args:[third]})).rows[0];assert.equal(f.replies.at(-1).client_id,JSON.parse(row.payload).client_id);
});

test('missing model configuration is actionable and commands remain available',async t=>{
  const f=await fixture(t,{stream:async function*(){throw new Error('未配置 DEEPSEEK_API_KEY');}});
  assert.match(await f.reply(f.send('你好')[0]),/设置中配置模型/);
  assert.match(await f.reply(f.send('/help')[0]),/\/new/);
  assert.equal(f.requests.length,1);
  const current=(await f.status()).currentSession;
  assert.equal((await f.store.allMessages(current.threadId,WECHAT_RESOURCE)).filter(message=>message.role==='user').length,1);
});

test('shutdown cancels an in-flight turn and recovery does not replay it',async t=>{
  const f=await fixture(t,{stream:async function*(messages,tools,signal){await delay(60000,undefined,{signal});}});
  const id=f.send('不应自动重新执行')[0];await eventually(()=>assert.equal(f.requests.length,1));
  await f.restart();assert.match(await f.reply(id),/已中断/);assert.equal(f.requests.length,1);
  const current=(await f.status()).currentSession;
  assert.equal((await f.store.allMessages(current.threadId,WECHAT_RESOURCE)).filter(message=>message.role==='user').length,1);
});

test('session creation rolls back on a routing failure and cross-account session numbers are isolated',async t=>{
  const f=await fixture(t);await f.reply(f.send('/new 本人')[0]);
  const id=f.send('/new 不应重复')[0];await f.reply(id);
  const row=(await f.store.client.execute({sql:'SELECT * FROM wechat_messages WHERE id=?',args:[id]})).rows[0];
  await f.store.client.execute({sql:"UPDATE wechat_messages SET state='received' WHERE id=?",args:[id]});
  await f.store.client.execute("CREATE TRIGGER fail_route BEFORE UPDATE ON wechat_messages WHEN NEW.state='command' BEGIN SELECT RAISE(ABORT,'fixture'); END");
  await assert.rejects(f.conversations.route({...row,text:'/new rollback'},account),/fixture/);
  assert.equal((await f.store.client.execute('SELECT * FROM wechat_sessions')).rows.length,2);
  await f.store.client.execute('DROP TRIGGER fail_route');
  await f.store.client.execute({sql:"UPDATE wechat_messages SET state='sent' WHERE id=?",args:[id]});
  assert.equal(await f.conversations.current({...account,botId:'other'}),undefined);
});

test('tool approval is not automatically granted through WeChat',async t=>{
  let executed=0;
  const f=await fixture(t,{tools:{probe:{id:'probe',description:'write',requireApproval:true,inputSchema:z.object({}),execute:async()=>{executed++;return {};}}},stream:async function*(){yield {type:'complete',message:{role:'assistant',content:null,tool_calls:[{id:'call',type:'function',function:{name:'probe',arguments:'{}'}}]},finishReason:'tool_calls'};}});
  assert.match(await f.reply(f.send('试一下需要确认的操作')[0]),/微信不会自动批准/);
  assert.equal(executed,0);
  assert.match(await f.reply(f.send('继续')[0]),/待确认的操作/);
  assert.equal(f.requests.length,1);
});

test('outbound credential expiry pauses the pump durably without losing its cursor',async t=>{
  let attempts=0;
  const f=await fixture(t,{failSend:()=>{attempts++;throw new WeChatError('微信凭证失效，请重新扫码',-14);}});
  f.send('生成回复后凭证失效');
  await eventually(async()=>assert.equal((await f.status()).state,'needs_login'));
  const saved=JSON.parse((await f.store.client.execute('SELECT data FROM wechat_account')).rows[0].data);
  assert.equal(saved.needsLogin,true);assert.equal(saved.cursor,'1');
  await delay(30);assert.equal(attempts,1);
  assert.equal((await f.store.client.execute('SELECT state FROM wechat_messages')).rows[0].state,'pending');
});

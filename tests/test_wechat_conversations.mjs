import { test } from 'node:test';
import { createHash } from 'node:crypto';
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
  const agent=new AgentRuntime({store,provider,tools:async()=>options.tools??{},instructions:async()=>'fixture',resolveDocuments:options.resolveDocuments});
  let permission = 'normal';
  const permissionChanges = [];
  const conversations=new WeChatConversations(store,agent,{get:()=>permission,set:async mode=>{permission=mode;permissionChanges.push(mode);}});
  const protocol={downloadFile:options.downloadFile,updates:async(a,signal)=>{
    while(!batches.length) await delay(5,undefined,{signal});
    return {msgs:batches.shift(),get_updates_buf:String(counter)};
  },send:async(a,payload)=>{if(options.failSend?.()) throw new Error('offline');replies.push(structuredClone(payload));return {};}};
  let runtime=new WeChatRuntime(store.client,protocol,5,conversations,options.receiveFile,options.prepareFiles);await runtime.start();
  t.after(async()=>{await runtime.close();await agent.shutdown();await store.close();});
  return {store,agent,conversations,requests,replies,permissionChanges,
    status:()=>runtime.status(),
    async stop(){await runtime.close();},
    async restart(){await runtime.close();runtime=new WeChatRuntime(store.client,protocol,5,conversations,options.receiveFile,options.prepareFiles);await runtime.start();},
    sendFile(file){const id=String(++counter);batches.push([{message_id:id,create_time_ms:Date.now()-50,from_user_id:account.userId,to_user_id:account.botId,context_token:'route-'+id,item_list:[{type:4,file_item:file}]}]);return id;},
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
  assert.match(await f.reply(f.send('试一下需要确认的操作')[0]),/确认 [A-F0-9]{4}/);
  assert.equal(executed,0);
  assert.match(await f.reply(f.send('继续')[0]),/待确认：/);
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

test('delete confirms one session, clears its history atomically and never reuses its number',async t=>{
  const f=await fixture(t);
  await f.reply(f.send('要删除的内容')[0]);const first=(await f.status()).currentSession;
  const selected=await f.store.contextMessages(first.threadId,WECHAT_RESOURCE);
  await f.store.saveSummary(selected.summaryKey,{throughSequence:1,value:{goals:['待删除摘要']},updatedAt:new Date().toISOString()});
  await f.reply(f.send('/new 保留的会话')[0]);const second=(await f.status()).currentSession;
  assert.match(await f.reply(f.send('/delete 1 确认')[0]),/没有有效的删除确认/);
  assert.ok(await f.store.getThreadById({threadId:first.threadId}));
  assert.match(await f.reply(f.send('/delete 1')[0]),/5 分钟内发送 \/delete 1 确认/);
  await f.restart();
  const confirmationId=f.send('/delete 1 确认')[0];assert.match(await f.reply(confirmationId),/已删除 #1.*当前会话不变/s);
  assert.equal(await f.store.getThreadById({threadId:first.threadId}),undefined);
  assert.equal((await f.store.allMessages(first.threadId,WECHAT_RESOURCE)).length,0);
  assert.equal(await f.store.summary(selected.summaryKey),undefined);
  assert.equal((await f.status()).currentSession.threadId,second.threadId);
  assert.match(await f.reply(f.send('/sessions')[0]),/#2 保留的会话/);
  assert.doesNotMatch(await f.reply(f.send('/sessions')[0]),/#1/);
  const deletedRows=(await f.store.client.execute("SELECT text,reply,payload FROM wechat_messages WHERE id='1'")).rows;
  assert.equal(deletedRows[0].text,'');assert.equal(deletedRows[0].reply,'');assert.equal(deletedRows[0].payload,'{}');
  // Replay of the confirmation ID must not delete any other session.
  const row=(await f.store.client.execute({sql:'SELECT * FROM wechat_messages WHERE id=?',args:[confirmationId]})).rows[0];
  await f.conversations.route(row,account);
  assert.ok(await f.store.getThreadById({threadId:second.threadId}));
  assert.match(await f.reply(f.send('/delete')[0]),/准备删除 #2/);
  assert.match(await f.reply(f.send('/delete 2 确认')[0]),/下一条普通消息会新建会话/);
  assert.equal((await f.status()).currentSession,undefined);
  assert.equal(await f.reply(f.send('新的内容')[0]),'答：新的内容');
  assert.equal((await f.status()).currentSession.number,3);
  assert.equal(f.requests.length,2);
});

test('delete cancellation, expiry and foreign/missing IDs cannot remove conversations',async t=>{
  const f=await fixture(t);await f.reply(f.send('/new 保留')[0]);const first=(await f.status()).currentSession;
  assert.match(await f.reply(f.send('/help')[0]),/\/delete/);
  await f.reply(f.send('/delete')[0]);assert.match(await f.reply(f.send('/delete 1 取消')[0]),/已取消/);
  assert.match(await f.reply(f.send('/delete 1 确认')[0]),/没有有效/);
  await f.reply(f.send('/delete 1')[0]);await f.store.client.execute('UPDATE wechat_delete_confirmations SET expiresAt=0');
  assert.match(await f.reply(f.send('/delete 1 确认')[0]),/没有有效/);
  for(const text of ['/delete 999','/delete 0','/delete 9007199254740992','/delete nope'])assert.match(await f.reply(f.send(text)[0]),/没有找到/);
  assert.ok(await f.store.getThreadById({threadId:first.threadId}));assert.equal(f.requests.length,0);
});

test('delete refuses running or approval-blocked sessions instead of losing pending work',async t=>{
  let release;const gate=new Promise(resolve=>release=resolve);t.after(()=>release());
  const f=await fixture(t,{stream:async function*(messages,tools,signal){await Promise.race([gate,delay(60000,undefined,{signal})]);yield {type:'complete',message:{role:'assistant',content:'完成'},finishReason:'stop'};}});
  const id=f.send('运行中')[0];await eventually(()=>assert.equal(f.requests.length,1));const first=(await f.status()).currentSession;
  assert.match(await f.reply(f.send('/delete')[0]),/暂时不能删除/);
  assert.ok(await f.store.getThreadById({threadId:first.threadId}));release();await f.reply(id);
  const approval=await fixture(t,{tools:{probe:{id:'probe',description:'write',requireApproval:true,inputSchema:z.object({}),execute:async()=>({})}},stream:async function*(){yield {type:'complete',message:{role:'assistant',content:null,tool_calls:[{id:'call',type:'function',function:{name:'probe',arguments:'{}'}}]},finishReason:'tool_calls'};}});
  await approval.reply(approval.send('等待审批')[0]);assert.match(await approval.reply(approval.send('/delete')[0]),/暂时不能删除/);
});

test('delete rollback restores the thread, history, cursor and confirmation when inbox commit fails',async t=>{
  const f=await fixture(t);await f.reply(f.send('不能丢的内容')[0]);const first=(await f.status()).currentSession;
  await f.reply(f.send('/delete 1')[0]);await f.stop();
  await f.store.client.execute({sql:"INSERT INTO wechat_messages(account,id,peer,session,text,reply,threadId,resourceId,payload,state,createdAt) VALUES(?,?,?,?,?,'','','','{}','received',?)",args:[account.botId,'delete-failure',account.userId,'external','/delete 1 确认',Date.now()]});
  const row=(await f.store.client.execute("SELECT * FROM wechat_messages WHERE id='delete-failure'")).rows[0];
  await f.store.client.execute("CREATE TRIGGER rollback_delete BEFORE UPDATE ON wechat_messages WHEN NEW.id='delete-failure' AND NEW.state='command' BEGIN SELECT RAISE(ABORT,'rollback deletion'); END");
  await assert.rejects(f.conversations.route(row,account),/rollback deletion/);
  assert.ok(await f.store.getThreadById({threadId:first.threadId}));
  assert.equal((await f.store.allMessages(first.threadId,WECHAT_RESOURCE)).length,2);
  assert.equal((await f.conversations.current(account)).threadId,first.threadId);
  assert.equal((await f.store.client.execute('SELECT * FROM wechat_delete_confirmations')).rows.length,1);
  assert.equal((await f.store.client.execute("SELECT state FROM wechat_messages WHERE id='delete-failure'")).rows[0].state,'received');
  await f.store.client.execute('DROP TRIGGER rollback_delete');await f.conversations.route(row,account);
  assert.equal(await f.store.getThreadById({threadId:first.threadId}),undefined);
});

test('permission lists and switches all modes without creating a conversation or calling the model',async t=>{
  const f=await fixture(t);
  assert.match(await f.reply(f.send('/permission')[0]),/当前权限：normal[\s\S]*normal[\s\S]*full[\s\S]*extra/);
  for (const mode of ['full','extra','normal']) assert.match(await f.reply(f.send('/permission '+mode)[0]),new RegExp('已切换为 '+mode));
  assert.deepEqual(f.permissionChanges,['full','extra','normal']);
  assert.match(await f.reply(f.send('/permission invalid')[0]),/用法/);
  assert.deepEqual(f.permissionChanges,['full','extra','normal']);
  assert.equal((await f.status()).currentSession,undefined);
  assert.equal(f.requests.length,0);
});

async function approvalFixture(t) {
  let executed=0;
  const f=await fixture(t,{tools:{probe:{id:'probe',description:'write',requireApproval:true,inputSchema:z.object({}),execute:async()=>{executed++;return {status:'completed'};}}},stream:async function*(messages){
    if (messages.at(-1).role === 'tool') {
      const result=JSON.parse(messages.at(-1).content),text=result.status === 'failed' ? '操作已拒绝' : '操作完成';
      yield {type:'text',text};yield {type:'complete',message:{role:'assistant',content:text}};
    } else yield {type:'complete',message:{role:'assistant',content:null,tool_calls:[{id:'call',type:'function',function:{name:'probe',arguments:'{}'}}]}};
  }});
  return {...f,executed:()=>executed};
}

test('text approval survives reconnect, is bound to the current session and never executes twice',async t=>{
  const f=await approvalFixture(t);
  const prompt=await f.reply(f.send('做个操作')[0]);
  const code=/确认 ([A-F0-9]{4})/.exec(prompt)[1];
  assert.equal(f.executed(),0);
  await f.restart();
  assert.match(await f.reply(f.send('/approve')[0]),new RegExp(code));
  assert.match(await f.reply(f.send('确认 00000000')[0]),/编号已失效/);
  await f.reply(f.send('/new 其他会话')[0]);
  assert.match(await f.reply(f.send('确认 '+code)[0]),/没有待审批/);
  assert.equal(f.executed(),0);
  await f.reply(f.send('/use 1')[0]);
  const id=f.send('确认 '+code)[0];assert.equal(await f.reply(id),'操作完成');
  assert.equal(f.executed(),1);
  const row=(await f.store.client.execute({sql:'SELECT * FROM wechat_messages WHERE id=?',args:[id]})).rows[0];
  await f.conversations.route(row,account);
  assert.match(await f.reply(f.send('/approve '+code)[0]),/没有待审批/);
  assert.equal(f.executed(),1);
  // Recovery after answer persistence but before channel reply persistence never replays the write.
  await f.store.client.execute({sql:"UPDATE wechat_messages SET state='queued' WHERE id=?",args:[id]});
  assert.match(await f.conversations.answer(row,new AbortController().signal),/未重复执行/);
  assert.equal(f.executed(),1);
});

test('text refusal resumes the conversation without performing the operation',async t=>{
  const f=await approvalFixture(t);
  const prompt=await f.reply(f.send('需要审批')[0]);const code=/确认 ([A-F0-9]{4})/.exec(prompt)[1];
  assert.equal(await f.reply(f.send('/deny '+code)[0]),'操作已拒绝');
  assert.equal(f.executed(),0);
  assert.equal(await f.store.waitingRun((await f.status()).currentSession.threadId),undefined);
  const again=await f.reply(f.send('再问一次')[0]);const another=/确认 ([A-F0-9]{4})/.exec(again)[1];
  assert.notEqual(another,code);
  assert.match(await f.reply(f.send('/approve '+code)[0]),/编号已失效/);
  assert.equal(await f.reply(f.send('取消 '+another)[0]),'操作已拒绝');
  assert.equal(f.executed(),0);
});


const fullApprovalCode = id => createHash('sha256').update(id).digest('hex').slice(0,8).toUpperCase();
test('approval accepts a lowercase suffix and legacy full code but rejects fewer than four digits',async t=>{
  const f=await approvalFixture(t);
  await f.reply(f.send('需要批准')[0]);
  const run=await f.store.waitingRun((await f.status()).currentSession.threadId);
  const code=fullApprovalCode(run.approval.id);
  assert.match(await f.reply(f.send('确认 '+code.slice(0,3))[0]),/少于四位/);
  assert.equal(f.executed(),0);
  assert.equal(await f.reply(f.send('确认 '+code.slice(-4).toLowerCase())[0]),'操作完成');
  assert.equal(f.executed(),1);
  await f.reply(f.send('需要拒绝')[0]);
  const next=await f.store.waitingRun((await f.status()).currentSession.threadId);
  assert.equal(await f.reply(f.send('/deny '+fullApprovalCode(next.approval.id))[0]),'操作已拒绝');
  assert.equal(f.executed(),1);
});

test('ambiguous short codes cannot approve another pending or previously handled operation',async t=>{
  const f=await approvalFixture(t);
  await f.reply(f.send('第一个操作')[0]);
  const first=await f.store.waitingRun((await f.status()).currentSession.threadId);
  const code=fullApprovalCode(first.approval.id);
  await f.reply(f.send('/new 第二个会话')[0]);
  await f.reply(f.send('第二个操作')[0]);
  const second=await f.store.waitingRun((await f.status()).currentSession.threadId);
  let colliding;
  for(let i=0;i<2000000;i++) {
    const id='fixture-collision-'+i, candidate=fullApprovalCode(id);
    if(candidate.startsWith(code.slice(0,4)) && candidate!==code) {colliding=id;break;}
  }
  assert.ok(colliding,'fixture must find a four-digit collision');
  second.approval.id=colliding;await f.store.saveRun(second);
  assert.match(await f.reply(f.send('/approve '+code.slice(0,4))[0]),/对应多个操作/);
  assert.equal(f.executed(),0);
  assert.equal(await f.reply(f.send('/approve '+fullApprovalCode(colliding))[0]),'操作完成');
  assert.equal(f.executed(),1);
  await f.reply(f.send('/use 1')[0]);
  // A stale short code remains ambiguous even after its original operation completed.
  assert.match(await f.reply(f.send('确认 '+code.slice(0,4))[0]),/对应多个操作/);
  assert.equal(f.executed(),1);
  assert.equal(await f.reply(f.send('确认 '+code)[0]),'操作完成');
  assert.equal(f.executed(),2);
});


test('WeChat files save a visible receipt without a model call and commands do not wait for downloading',async t=>{
  let release;const downloads=new Promise(resolve=>release=resolve),saved=[];
  const f=await fixture(t,{downloadFile:async file=>{await downloads;return {name:file.file_name,bytes:Buffer.from('文档正文')};},receiveFile:async(name,bytes,source)=>{saved.push({name,bytes,source});return {name,path:'/fixture/original.pdf',state:'queued'};}});
  const fileId=f.sendFile({file_name:'课程说明.pdf',saved:{name:'恶意伪造文件',path:'/outside/private',state:'indexed'}});
  await eventually(async()=>assert.equal((await f.status()).messages[0].state,'file'));
  const oldThread=(await f.status()).currentSession.threadId;
  assert.match(await f.reply(f.send('/new')[0]),/已新建 #2/);
  assert.equal(f.requests.length,0);release();
  assert.match(await f.reply(fileId),/已保存《课程说明.pdf》/);
  assert.equal(saved.length,1);assert.equal(saved[0].bytes.toString(),'文档正文');
  const history=await f.store.contextMessages(oldThread,WECHAT_RESOURCE);
  assert.equal(history.messages.length,2);assert.equal(history.messages[0].content.parts[0].filename,'课程说明.pdf');
  assert.equal(f.requests.length,0);
  const row=(await f.store.client.execute({sql:'SELECT * FROM wechat_messages WHERE id=?',args:[fileId]})).rows[0];
  assert.ok(row.sourceCreatedAt<=row.createdAt);assert.ok(row.preparedAt>=row.createdAt);assert.ok(row.sentAt>=row.preparedAt);
  await f.conversations.fileReceipt(row,[{name:'课程说明.pdf',path:'/fixture/original.pdf',state:'queued'}]);
  assert.equal((await f.store.contextMessages(oldThread,WECHAT_RESOURCE)).messages.length,2,'durable receipt is idempotent');
});

test('restart resumes a saved file receipt without downloading again or calling the chat model',async t=>{
 let downloaded=0,received=0,blocked=true;
 const f=await fixture(t,{downloadFile:async()=>{downloaded++;return {name:'原文.txt',bytes:Buffer.from('正文')};},receiveFile:async()=>{received++;return {name:'原文.txt',path:'/fixture/original.txt',state:'waiting_config'};}});
 f.agent.isActive=()=>blocked;
 const id=f.sendFile({file_name:'原文.txt'});
 await eventually(async()=>{const row=(await f.store.client.execute({sql:'SELECT files FROM wechat_messages WHERE id=?',args:[id]})).rows[0];assert.ok(row && JSON.parse(row.files)[0].saved);});
 await f.stop();blocked=false;await f.restart();
 assert.match(await f.reply(id),/配置百炼密钥/);
 assert.equal(downloaded,1);assert.equal(received,1);assert.equal(f.requests.length,0);
});


test('attachment tags collect documents and a question, then call the model exactly once with references',async t=>{
  let parsed=0;
  const f=await fixture(t,{downloadFile:async file=>({name:file.file_name,bytes:Buffer.from('附件正文')}),receiveFile:async name=>({name,path:'/fixture/'+name,state:'queued'}),prepareFiles:async files=>{parsed++;assert.equal(files[0].name,'课程说明.txt');return ['fixture-context'];},resolveDocuments:refs=>refs?.includes('fixture-context') ? [{name:'课程说明.txt',markdown:'期末考试占百分之六十。'}] : []});
  assert.match(await f.reply(f.send('<attachment>')[0]),/开始收集/);
  assert.match(await f.reply(f.sendFile({file_name:'课程说明.txt'})),/附件已收集/);
  assert.match(await f.reply(f.send('请总结考试要求')[0]),/已记下问题/);
  assert.equal(f.requests.length,0);
  await f.restart();
  const reply=await f.reply(f.send('</attachment>')[0]);assert.match(reply,/请总结考试要求/);
  assert.equal(f.requests.length,1);assert.equal(parsed,1);
  assert.match(f.requests[0].filter(message=>message.role==='user').at(-1).content,/期末考试占百分之六十/);
  assert.equal((await f.store.client.execute('SELECT * FROM wechat_attachment_batches')).rows.length,0);
  assert.match(await f.reply(f.send('/attachment')[0]),/没有找到/);
  assert.match(await f.reply(f.send('<attachment>')[0]),/开始收集/);
  assert.match(await f.reply(f.send('/attachment cancel')[0]),/已取消/);
  assert.equal(f.requests.length,1);
});

for(const order of ['text-first','files-first'])test('retroactive attachment '+order+' selects recent files once, excluding earlier batches',async t=>{
  const f=await fixture(t,{downloadFile:async file=>({name:file.file_name,bytes:Buffer.from('附件正文')}),receiveFile:async name=>({name,path:'/fixture/'+name,state:'queued'}),prepareFiles:async files=>{assert.deepEqual(files.map(file=>file.name),['课件.txt','作业.txt']);return ['retro-context'];},resolveDocuments:refs=>refs?.includes('retro-context') ? [{name:'课件.txt',markdown:'作业截止周五。'}] : []});
  await f.reply(f.send('/new')[0]);
  if(order==='text-first')await f.reply(f.send('请总结这些材料')[0]);
  await f.reply(f.sendFile({file_name:'课件.txt'}));
  await f.reply(f.sendFile({file_name:'作业.txt'}));
  if(order==='files-first')await f.reply(f.send('请总结这些材料')[0]);
  const initial=f.requests.length;
  assert.match(await f.reply(f.send('/attachment')[0]),/作业截止周五/);
  assert.equal(f.requests.length,initial+1);
  assert.match(await f.reply(f.send('/attachment')[0]),/没有找到/);
  assert.equal(f.requests.length,initial+1);
  const thread=(await f.status()).currentSession;
  assert.match(thread.title,/请总结这些材料|课件/);
});

test('new WeChat sessions rename on the first message and explicit names survive restart',async t=>{
  const f=await fixture(t);
  await f.reply(f.send('/new')[0]);await f.reply(f.send('整理我的复习安排')[0]);
  assert.equal((await f.status()).currentSession.title,'微信 · 整理我的复习安排');
  const thread=(await f.status()).currentSession.threadId;
  await f.store.client.execute({sql:"UPDATE threads SET title='微信 · 新对话' WHERE id=?",args:[thread]});
  await f.restart();assert.equal((await f.status()).currentSession.title,'微信 · 整理我的复习安排');
  await f.reply(f.send('/new 新对话')[0]);await f.reply(f.send('不要覆盖我的名字')[0]);await f.restart();
  assert.equal((await f.status()).currentSession.title,'微信 · 新对话');
});

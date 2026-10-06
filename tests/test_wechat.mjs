import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { LocalClient } from '../src/agent/sqlite.ts';
import { WeChatProtocol, WeChatError, trustedWeChatBase } from '../src/wechat/protocol.ts';
import { WeChatRuntime } from '../src/wechat/runtime.ts';
import { terminalWeChatQR } from '../src/shared/wechat.ts';
import { parseCommand } from '../src/distribution/arguments.ts';
const account = {token:'private-bot-token',botId:'bot@im.bot',userId:'owner@im.wechat',base:'https://ilinkai.weixin.qq.com',cursor:'',needsLogin:false};
const message = {message_id:'18446744073709551615',from_user_id:account.userId,to_user_id:account.botId,session_id:'external-session',message_type:1,message_state:2,context_token:'private-reply-route',item_list:[{type:1,text_item:{text:'你好 SEUdaily'}}]};
async function eventually(check, timeout=3000) {
  const end = Date.now()+timeout; let last;
  do {try {return await check();} catch(error) {last=error;await delay(5);}} while (Date.now()<end);
  throw last;
}
async function seed(db, value=account) {
  const runtime = new WeChatRuntime(db,undefined,5); await runtime.initialize(); await runtime.close();
  await db.execute({sql:'INSERT INTO wechat_account VALUES(1,?)',args:[JSON.stringify(value)]});
}
function waiting(signal) {return new Promise((resolve,reject) => {
  if (signal.aborted) return reject(signal.reason);
  signal.addEventListener('abort',() => reject(signal.reason),{once:true});
});}
test('WeChat spelling, trusted redirects and QR quiet zone', () => {
  assert.equal(parseCommand(['WeChat']).command,'WeChat');assert.equal(parseCommand(['wechat']).command,'WeChat');
  assert.equal(trustedWeChatBase('new.weixin.qq.com'),'https://new.weixin.qq.com');
  for (const url of ['http://ilinkai.weixin.qq.com','https://evil.test','https://weixin.qq.com.evil.test','https://user:secret@new.weixin.qq.com','https://new.weixin.qq.com:444','https://new.weixin.qq.com/path']) assert.throws(() => trustedWeChatBase(url));
  const rows = terminalWeChatQR({size:1,modules:'1'}).split('\n');
  assert.equal(rows[0],' '.repeat(9));assert.equal(rows[2],'    ▀    ');assert.equal(rows.at(-1),' '.repeat(9));
});
test('official HTTP wire format, auth separation, uint64 IDs and business errors', async () => {
  const calls=[]; let result='{}';
  const protocol = new WeChatProtocol(async (url,init) => {calls.push({url,init});return new Response(result,{status:200});});
  const signal=AbortSignal.timeout(1000);
  await protocol.qr(signal,[]);
  assert.match(calls[0].url,/get_bot_qrcode\?bot_type=3$/);
  assert.deepEqual(JSON.parse(calls[0].init.body),{local_token_list:[]});
  assert.equal(calls[0].init.headers.AuthorizationType,'ilink_bot_token');assert.equal(calls[0].init.headers.Authorization,undefined);
  assert.match(Buffer.from(calls[0].init.headers['X-WECHAT-UIN'],'base64').toString(),/^\d+$/);
  await protocol.qrStatus(account.base,'a&b',signal,'123456');
  assert.match(calls[1].url,/qrcode=a%26b&verify_code=123456$/);assert.equal(calls[1].init.method,'GET');
  assert.equal(calls[1].init.headers.AuthorizationType,undefined);assert.equal(calls[1].init.headers.Authorization,undefined);assert.equal(calls[1].init.headers['X-WECHAT-UIN'],undefined);
  result='{"ret":0,"msgs":[{"message_id":18446744073709551615}],"get_updates_buf":"opaque"}';
  const updates=await protocol.updates(account,signal);assert.equal(updates.msgs[0].message_id,'18446744073709551615');
  const call=calls[2];assert.equal(call.init.headers.Authorization,'Bearer '+account.token);assert.equal(call.init.redirect,'error');
  const body=JSON.parse(call.init.body);assert.equal(body.get_updates_buf,'');assert.match(body.base_info.bot_agent,/^SEUdaily\//);assert.equal(body.sync_buf,undefined);
  result='{"errcode":-14}';await assert.rejects(protocol.updates(account,signal),error => error instanceof WeChatError && error.code===-14);
  result='{"ret":5,"errmsg":"private-bot-token"}';await assert.rejects(protocol.send(account,{},signal),error => error.message==='微信接口返回错误码 5');
});
test('QR redirects, phone verification and confirmed credentials shared by clients', async t => {
  const db=new LocalClient(':memory:');let step=0;const polls=[];
  const protocol={
    qr:async () => ({qrcode:'opaque-qr',qrcode_img_content:'https://weixin.qq.com/scan/demo'}),
    qrStatus:async (base,qr,signal,code) => {
      polls.push({base,qr,code});
      if (step++===0) return {status:'scaned_but_redirect',redirect_host:'secondary.weixin.qq.com'};
      if (!code) return {status:'need_verifycode'};
      assert.equal(code,'123456');return {status:'confirmed',bot_token:account.token,ilink_bot_id:account.botId,ilink_user_id:account.userId,baseurl:account.base};
    },updates:async (a,signal) => waiting(signal),send:async () => ({}),
  };
  const runtime=new WeChatRuntime(db,protocol,5);t.after(async () => {await runtime.close();await db.close();});
  const first=await runtime.connect(),second=await runtime.connect();assert.equal(second.loginId,first.loginId);assert.ok(first.qr.modules.length===first.qr.size**2);
  await eventually(async () => assert.equal((await runtime.status()).state,'need_verifycode'));
  assert.equal(polls[1].base,'https://secondary.weixin.qq.com');
  await assert.rejects(runtime.verify('wrong-id','123456'),/失效/);
  await runtime.verify(first.loginId,'123456');
  await eventually(async () => assert.equal((await runtime.status()).state,'connected'));
  const status=await runtime.status();assert.equal(status.botId,account.botId);assert.equal(status.loginId,undefined);
  assert.ok(!JSON.stringify(status).includes(account.token));
  assert.equal(JSON.parse((await db.execute('SELECT data FROM wechat_account')).rows[0].data).token,account.token);
});
test('cursor and outbox commit together, failed sends survive restart and duplicates are ignored', async t => {
  const db=new LocalClient(':memory:');await seed(db);let firstPoll=true,sendAttempts=0;
  const first = new WeChatRuntime(db,{
    updates:async (a,signal) => firstPoll ? (firstPoll=false,{ret:0,msgs:[message],get_updates_buf:'cursor-1'}) : waiting(signal),
    send:async () => {sendAttempts++;throw new Error('network down');},
  },5);
  await first.start();await eventually(async () => assert.equal(sendAttempts,1));await first.close();
  let row=(await db.execute('SELECT * FROM wechat_messages')).rows[0];assert.equal(row.state,'pending');assert.equal(row.threadId,'wechat-demo');assert.equal(row.resourceId,'seudaily-wechat-demo');
  assert.equal(row.session,'external-session');assert.equal(JSON.parse((await db.execute('SELECT data FROM wechat_account')).rows[0].data).cursor,'cursor-1');
  const sent=[],cursors=[];let duplicate=true;
  const second = new WeChatRuntime(db,{
    send:async (a,payload) => {sent.push(payload);return {};},
    updates:async (a,signal) => {cursors.push(a.cursor);return duplicate ? (duplicate=false,{ret:0,msgs:[message],get_updates_buf:'cursor-2'}) : waiting(signal);},
  },5);
  t.after(async () => {await second.close();await db.close();});await second.start();
  await eventually(async () => assert.equal(cursors.at(-1),'cursor-2'));
  row=(await db.execute('SELECT * FROM wechat_messages')).rows[0];assert.equal(row.state,'sent');assert.equal(sent.length,1);
  assert.equal(sent[0].client_id,JSON.parse(row.payload).client_id);assert.equal(sent[0].context_token,message.context_token);assert.equal(sent[0].to_user_id,account.userId);
  assert.equal(sent[0].message_type,2);assert.equal(sent[0].message_state,2);assert.match(sent[0].item_list[0].text_item.text,/wechat-demo/);
  assert.equal((await db.execute('SELECT COUNT(*) AS n FROM wechat_messages')).rows[0].n,1);
  assert.ok(!JSON.stringify(await second.status()).includes(message.context_token));
});
test('failed inbound transaction cannot advance cursor; foreign users and groups are ignored', async t => {
  const db=new LocalClient(':memory:');await seed(db);
  await db.execute("CREATE TRIGGER fail_inbox BEFORE INSERT ON wechat_messages BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
  let updates=0;
  const runtime=new WeChatRuntime(db,{updates:async () => {updates++;return {msgs:[message],get_updates_buf:'must-not-commit'};},send:async () => {}},5);
  await runtime.start();await eventually(async () => assert.equal(updates,1));await runtime.close();
  assert.equal(JSON.parse((await db.execute('SELECT data FROM wechat_account')).rows[0].data).cursor,'');assert.equal((await db.execute('SELECT COUNT(*) AS n FROM wechat_messages')).rows[0].n,0);
  await db.execute('DROP TRIGGER fail_inbox');let done=false;
  const second=new WeChatRuntime(db,{updates:async (a,signal) => done ? waiting(signal) : (done=true,{msgs:[{...message,from_user_id:'stranger'},{...message,group_id:'group'}, {...message,to_user_id:'different-bot'}],get_updates_buf:'filtered'}),send:async () => assert.fail('foreign message must not receive a reply')},5);
  t.after(async () => {await second.close();await db.close();});await second.start();
  await eventually(async () => assert.equal(JSON.parse((await db.execute('SELECT data FROM wechat_account')).rows[0].data).cursor,'filtered'));
  assert.equal((await db.execute('SELECT COUNT(*) AS n FROM wechat_messages')).rows[0].n,0);
});
test('expired credentials pause requests durably and can be replaced by scanning again', async t => {
  const db=new LocalClient(':memory:');await seed(db);let calls=0;
  const runtime=new WeChatRuntime(db,{updates:async () => {calls++;throw new WeChatError('微信凭证失效，请重新扫码',-14);}},5);
  await runtime.start();await eventually(async () => assert.equal((await runtime.status()).state,'needs_login'));await runtime.close();assert.equal(calls,1);
  const next=new WeChatRuntime(db,{qr:async () => ({qrcode:'next',qrcode_img_content:'https://weixin.qq.com/scan/next'}),qrStatus:async () => ({status:'expired'}),updates:async () => assert.fail('expired token must not be used')},5);
  t.after(async () => {await next.close();await db.close();});await next.start();assert.equal((await next.status()).state,'needs_login');
  await next.connect();await eventually(async () => assert.equal((await next.status()).state,'expired'));
  await next.cancelLogin();assert.equal((await next.status()).state,'needs_login');
  assert.equal(JSON.parse((await db.execute('SELECT data FROM wechat_account')).rows[0].data).token,account.token);
});

test('reopening the SQLite file restores credentials, cursor and an unsent reply', async t => {
  const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const directory=await mkdtemp(join(tmpdir(),'seudaily-wechat-'));let db=new LocalClient(join(directory,'agent.db'));await seed(db);
  let read=false;
  const first=new WeChatRuntime(db,{updates:async(a,signal)=>read?waiting(signal):(read=true,{msgs:[message],get_updates_buf:'disk-cursor'}),send:async()=>{throw new Error('offline');}},5);
  await first.start();await eventually(async()=>assert.equal((await first.status()).messages[0]?.state,'pending'));await first.close();await db.close();
  db=new LocalClient(join(directory,'agent.db'));const replies=[];
  const second=new WeChatRuntime(db,{send:async(a,payload)=>{assert.equal(a.token,account.token);replies.push(payload);},updates:async(a,signal)=>{assert.equal(a.cursor,'disk-cursor');return waiting(signal);}},5);
  t.after(async()=>{await second.close();await db.close();await rm(directory,{recursive:true,force:true});});await second.start();
  await eventually(async()=>assert.equal((await second.status()).messages[0]?.state,'sent'));assert.equal(replies.length,1);
});
test('shutdown cancels QR acquisition and lifecycle notification failures do not block message polling',async t=>{
  const db=new LocalClient(':memory:');let acquiring=false;
  const login=new WeChatRuntime(db,{qr:async(signal)=>{acquiring=true;return waiting(signal);}},5);
  const connecting=login.connect();await eventually(async()=>assert.equal(acquiring,true));
  const closed=login.close();await assert.rejects(connecting);await closed;
  await seed(db);const events=[];
  const second=new WeChatRuntime(db,{notify:async(a,event)=>{events.push(event);throw new Error('notification failed');},updates:async(a,signal)=>{events.push('updates');return waiting(signal);}},5);
  t.after(()=>db.close());await second.start();await eventually(async()=>assert.ok(events.includes('updates')));await second.close();assert.deepEqual(events,['start','updates','stop']);
});

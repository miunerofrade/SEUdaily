import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {createHmac} from 'node:crypto';
import {DeadlineStore} from '../src/runtime/deadlines/store.ts';
import {sendFeishu,validFeishuWebhook} from '../src/runtime/deadlines/feishu.ts';
import {SkillCatalog} from '../src/runtime/skills.ts';
const now=Date.parse('2026-11-04T00:00:00Z'),day=86400000;
const input=(due=now+5*day)=>({title:'实验报告',dueAt:new Date(due).toISOString(),requirements:'提交 PDF',reminders:[4320,1440,360].map(beforeMinutes=>({beforeMinutes,message:`节点 ${beforeMinutes}：检查实验数据和 PDF`}))});
async function setup(t){const root=await mkdtemp(join(tmpdir(),'seudaily-ddl-test-'));const path=join(root,'deadlines.db');const store=new DeadlineStore(path);t.after(async()=>{await store.close();await rm(root,{recursive:true,force:true});});return {root,path,store};}

test('durable countdown, owner isolation, idempotence and restart delivery',async t=>{
 const {store,path}=await setup(t);const created=await store.save('alice','request-1',input(),undefined,now);
 assert.equal((await store.save('alice','request-1',input(),undefined,now)).created,false);
 await assert.rejects(store.save('alice','request-1',{...input(),title:'另一任务'},undefined,now),/requestKey/);
 assert.equal((await store.list('alice',now))[0].remainingSeconds,5*86400);assert.deepEqual(await store.list('bob',now),[]);
 await store.close();const restarted=new DeadlineStore(path);t.after(()=>restarted.close());const sent=[];
 await restarted.tick(async text=>sent.push(text),now+2*day);await restarted.tick(async text=>sent.push(text),now+2*day);
 assert.equal(sent.length,1);assert.match(sent[0],/实验报告/);assert.match(sent[0],/4320/);
 assert.equal((await restarted.list('alice',now))[0].id,created.id);await restarted.close();
});
test('offline recovery coalesces reminders, expiration and retries survive restart',async t=>{
 const {store}=await setup(t);await store.save('a','one',input(),undefined,now);
 const sent=[];await store.tick(async text=>sent.push(text),now+4.5*day);
 assert.equal(sent.length,1);assert.match(sent[0],/补发/);assert.match(sent[0],/1440/);
 let rows=(await store.list('a',now))[0].deliveries;assert.equal(rows.filter(x=>x.state==='superseded').length,1);
 await store.tick(async()=>{throw Error('secret-webhook-must-not-persist');},now+4.8*day);
 rows=(await store.list('a',now))[0].deliveries;assert.match(rows.at(-1).error,/飞书发送失败/);assert.doesNotMatch(JSON.stringify(rows),/secret-webhook/);
 await store.tick(async text=>sent.push(text),now+4.81*day);assert.equal(sent.length,2);
 await store.tick(async()=>assert.fail('expired event should not send'),now+6*day);
});
test('updates cancel old nodes; complete and cancel stop future messages',async t=>{
 const {store}=await setup(t);const a=await store.save('a','r',input(),undefined,now);
 await assert.rejects(store.finish('b',a.id,'cancelled'),/不存在/);
 await store.save('a','',{...input(),title:'更新报告'},a.id,now);
 const sent=[];await store.tick(async text=>sent.push(text),now+2*day);assert.equal(sent.length,1);assert.match(sent[0],/更新报告/);
 await store.finish('a',a.id,'completed');await store.tick(async()=>assert.fail(),now+4*day);
 const b=await store.save('a','r2',input(),undefined,now);await store.finish('a',b.id,'cancelled');await store.tick(async()=>assert.fail(),now+4*day);
 await assert.rejects(store.save('a','past',input(now-1),undefined,now),/晚于/);
 await assert.rejects(store.save('a','soon',input(now+3600000),undefined,now),/节点均已过去/);
});
test('two schedulers cannot send different missed nodes of the same deadline concurrently',async t=>{
 const {store,path}=await setup(t);await store.save('a','r',input(),undefined,now);
 const other=new DeadlineStore(path);t.after(()=>other.close());let sends=0,release;const barrier=new Promise(r=>release=r);
 const first=store.tick(async()=>{sends++;await barrier;},now+4.8*day);
 while(!sends)await new Promise(r=>setTimeout(r,5));
 await other.tick(async()=>sends++,now+4.8*day);release();await first;assert.equal(sends,1);await other.close();
});
test('Feishu group sender signs the actual HTTP JSON and handles business errors',async t=>{
 let body,code=0;const server=createServer(async(req,res)=>{let text='';for await(const chunk of req)text+=chunk;body=JSON.parse(text);res.setHeader('content-type','application/json');res.end(JSON.stringify({code}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const address=server.address();const options={webhook:'https://open.feishu.cn/open-apis/bot/v2/hook/test',secret:'signing-secret',fetchImpl:(_url,init)=>fetch(`http://127.0.0.1:${address.port}`,init)};
 await sendFeishu('实验报告提醒',options);assert.equal(body.msg_type,'text');assert.equal(body.content.text,'实验报告提醒');
 assert.equal(body.sign,createHmac('sha256',`${body.timestamp}\nsigning-secret`).update('').digest('base64'));
 code=19021;await assert.rejects(sendFeishu('test',options),/拒绝/);
 for(const url of ['http://open.feishu.cn/open-apis/bot/v2/hook/test','https://evil.invalid/hook','https://open.feishu.cn/open-apis/bot/v2/hook/test?secret=x'])assert.throws(()=>validFeishuWebhook(url));
});
test('existing installations discover bundled DDL skill while user copies win',async t=>{
 const root=await mkdtemp(join(tmpdir(),'seudaily-ddl-skills-'));t.after(()=>rm(root,{recursive:true,force:true}));const user=join(root,'user'),bundle=join(root,'bundle');await mkdir(user);await mkdir(bundle);
 await mkdir(join(bundle,'deadline-reminders'));await writeFile(join(bundle,'deadline-reminders','SKILL.md'),'---\nname: deadline-reminders\ndescription: DDL 提醒\nnamespaces: [deadlines]\n---\n内置规则');
 const catalog=new SkillCatalog(user,bundle);assert.equal((await catalog.list())[0].name,'deadline-reminders');assert.match(await catalog.read('deadline-reminders'),/内置规则/);
 await mkdir(join(user,'deadline-reminders'));await writeFile(join(user,'deadline-reminders','SKILL.md'),'---\nname: deadline-reminders\ndescription: 用户 DDL\n---\n用户规则');assert.match(await catalog.read('deadline-reminders'),/用户规则/);
 await assert.rejects(catalog.read('deadline-reminders','../secret'));
});

test('model can discover the reminder capability and read the project Skill',async()=>{
 const {searchCapabilitiesTool}=await import('../src/runtime/tools/tool-broker.ts');
 const {readSkillTool}=await import('../src/runtime/skills.ts');
 const found=await searchCapabilitiesTool.execute({query:'DDL 飞书提醒',namespace:'deadlines'},{});
 assert.ok(found.results.some(item=>item.name==='manage-deadlines'));
 const selected=[];const result=await readSkillTool.execute({name:'deadline-reminders'},{requestContext:{get:key=>key==='seudailySkills'?selected:undefined}});
 assert.match(result.content,/4320、1440、360/);assert.deepEqual(selected,['deadline-reminders']);
});

test('expired delivery leases recover and overdue reminders expire without sending',async t=>{
 const {store}=await setup(t);const task=await store.save('a','lease',input(),undefined,now);
 const event=(await store.db.execute("SELECT id FROM deadline_events ORDER BY scheduled LIMIT 1")).rows[0];
 await store.db.execute({sql:"UPDATE deadline_events SET state='sending',lease=? WHERE id=?",args:[now,event.id]});
 let sends=0;await store.tick(async()=>sends++,now+2*day);assert.equal(sends,1);
 await store.tick(async()=>assert.fail('overdue reminders must expire'),now+6*day);
 const item=(await store.list('a',now+6*day))[0];assert.equal(item.state,'overdue');assert.equal(item.deliveries.filter(x=>x.state==='expired').length,2);
 assert.equal(await store.hasPending(),false);assert.equal(item.id,task.id);
});

test('missing bot configuration leaves retries untouched and still expires overdue nodes',async t=>{
 const {store}=await setup(t);await store.save('a','unconfigured',input(),undefined,now);
 await store.tick(undefined,now+2*day);let item=(await store.list('a',now))[0];assert.equal(item.deliveries[0].attempts,0);assert.equal(item.deliveries[0].state,'pending');
 await store.tick(undefined,now+6*day);item=(await store.list('a',now+6*day))[0];assert.ok(item.deliveries.every(e=>e.state==='expired'&&e.attempts===0));
});

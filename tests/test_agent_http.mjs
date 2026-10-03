import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,cp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
const root=await mkdtemp(join(tmpdir(),'seudaily-http-'));
await writeFile(join(root,'package.json'),'{}');await writeFile(join(root,'pyproject.toml'),'');
await mkdir(join(root,'.agent','skills'),{recursive:true});
await cp(new URL('../.agent/skills/training-plan-audit',import.meta.url),join(root,'.agent','skills','training-plan-audit'),{recursive:true});
process.env.SEUDAILY_PROJECT_ROOT=root;
const {app}=await import('../src/server/app.ts');
const {agentRuntime}=await import('../src/runtime/application.ts');
const {agentStore}=await import('../src/runtime/storage.ts');
const {agentInstructions}=await import('../src/runtime/instructions.ts');
const request=(path,body)=>app.request('http://127.0.0.1:4111'+path,{method:body?'POST':'GET',headers:{host:'127.0.0.1:4111','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
function input(thread,token,messages,resource='fixture'){return {messages,memory:{thread,resource},requestContext:{seudailyRunToken:token,seudailySkills:['training-plan-audit'],seudailyInterface:'cli'}};}
function events(text){return text.split('\n\n').filter(block=>block.startsWith('data: ')&&!block.includes('[DONE]')).map(block=>JSON.parse(block.slice(6)));}

test('HTTP skill discovery, AGENT.md settings and bound approval recovery',async t=>{
 t.after(async()=>{await agentRuntime.shutdown();agentStore.close();await rm(root,{recursive:true,force:true});});
 assert.equal((await (await request('/app/skills')).json()).skills[0].name,'training-plan-audit');
 const saved=await request('/app/settings',{agentInstructions:'FIXTURE_AGENT_RULE'});
 assert.equal(saved.status,200);
 assert.equal(await readFile(join(root,'AGENT.md'),'utf8'),'FIXTURE_AGENT_RULE');
 assert.equal((await (await request('/app/settings')).json()).agentInstructions,'FIXTURE_AGENT_RULE');
 assert.match(await agentInstructions({threadId:'x',resourceId:'x',runToken:'x'}),/FIXTURE_AGENT_RULE/);
 let executed=0,step=0;
 agentRuntime.config.tools=async()=>({probe:{id:'probe',description:'fixture',inputSchema:z.object({password:z.string()}),requireApproval:true,execute:async()=>{executed++;return {status:'completed'};}}});
 agentRuntime.config.provider={async *stream(){step++;yield {type:'complete',message:step%2?{role:'assistant',content:null,tool_calls:[{id:randomUUID(),type:'function',function:{name:'probe',arguments:'{"password":"fixture-private"}'}}]}:{role:'assistant',content:'done'}};}};
 const thread=randomUUID(),token=randomUUID();
 const first=await request('/api/agents/seudaily-agent/stream',input(thread,token,'test'));
 const approval=events(await first.text()).find(event=>event.type==='tool-approval-request').payload;
 const pending=(await (await request(`/api/memory/threads/${thread}/run?resourceId=fixture`)).json()).pending;
 assert.equal(pending.runToken,token);assert.equal(pending.args.password,'[已脱敏]');
 assert.equal((await request(`/api/memory/threads/${thread}/run?resourceId=wrong`)).status,404);
 const answer=[{role:'tool',content:[{type:'tool-approval-response',approvalId:approval.approvalId,approved:true}]}];
 assert.equal((await request('/api/agents/seudaily-agent/stream',input(thread,'wrong',answer))).status,400);
 const approved=await request('/api/agents/seudaily-agent/stream',input(thread,token,answer));
 assert.ok(events(await approved.text()).some(event=>event.type==='finish'));assert.equal(executed,1);
 assert.equal((await request('/api/agents/seudaily-agent/stream',input(thread,token,answer))).status,400);
 assert.equal((await request('/api/agents/seudaily-agent/stream',{...input('other','new','text'),requestContext:{seudailyRunToken:'new',seudailySkills:['unknown']}})).status,400);
});

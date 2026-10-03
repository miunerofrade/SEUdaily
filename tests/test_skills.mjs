import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SkillCatalog, readSkillTool, skillCatalog} from '../src/runtime/skills.ts';
import {AgentRuntime} from '../src/agent/runtime.ts';
import {AgentStore} from '../src/agent/storage.ts';
import {randomUUID} from 'node:crypto';

test('skill discovery, namespace activation, explicit selection and reference boundaries',async t=>{
 const root=await mkdtemp(join(tmpdir(),'seudaily-skills-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(join(root,'audit','references'),{recursive:true});
 await writeFile(join(root,'audit','SKILL.md'),'---\nname: audit\ndescription: fixture\nnamespaces: [training-plan]\n---\nCHECKED_RULE');
 await writeFile(join(root,'audit','references','note.md'),'reference fact');
 const catalog=new SkillCatalog(root);
 assert.equal((await catalog.list())[0].name,'audit');
 assert.match((await catalog.instructions([],['training-plan'])).content,/CHECKED_RULE/);
 assert.match((await catalog.instructions(['audit'],[])).content,/CHECKED_RULE/);
 assert.equal(await catalog.read('audit','references/note.md'),'reference fact');
 await assert.rejects(catalog.read('../audit'));
 await assert.rejects(catalog.read('audit','../../outside.md'));
 await assert.rejects(catalog.instructions(['missing'],[]));
 await writeFile(join(root,'private.md'),'private');
 await symlink(join(root,'private.md'),join(root,'audit','references','escape.md'));
 await assert.rejects(catalog.read('audit','references/escape.md'));
});
test('model read-skill activates instructions on its next step and persists selection',async t=>{
 const store=new AgentStore(':memory:');t.after(()=>store.close());let calls=0;const requests=[];
 const provider={async *stream(messages){requests.push(messages);calls++;if(calls===1)yield {type:'complete',message:{role:'assistant',content:null,tool_calls:[{id:'load',type:'function',function:{name:'read-skill',arguments:'{"name":"training-plan-audit"}'}}]}};else yield {type:'complete',message:{role:'assistant',content:'loaded'}};}};
 const context={threadId:'skill-test',resourceId:'test',runToken:randomUUID()};
 const runtime=new AgentRuntime({store,provider,tools:async()=>({'read-skill':readSkillTool}),instructions:async c=>(await skillCatalog.instructions(c.skills??[],[])).content});
 for await(const event of await runtime.runTurn([{role:'user',content:'fixture'}],context))assert.notEqual(event.type,'error');
 assert.equal(requests[0][0].content,'');assert.match(requests[1][0].content,/培养方案与毕业要求/);
 assert.deepEqual((await store.getRun(context.runToken)).context.skills,['training-plan-audit']);
});

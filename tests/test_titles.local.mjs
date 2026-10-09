import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AgentStore} from '../src/agent/storage.ts';
import {ensureConversationTitle} from '../src/runtime/conversation-title.ts';
test('old unnamed multi-turn title uses original topic; generated and named histories are protected',async(t)=>{
 const store=new AgentStore(':memory:');t.after(()=>store.close());
 await store.ensureThread({threadId:'old',resourceId:'local'});
 for(let i=0;i<25;i++)await store.saveMessage({id:'m'+i,threadId:'old',resourceId:'local',role:'user',createdAt:new Date().toISOString(),content:{parts:[{type:'text',text:i?'后续问题':'最初的学习规划问题'}]}});
 const updatedAt=(await store.getThreadById({threadId:'old'})).updatedAt;
 let calls=0;
 const generate=input=>ensureConversationTitle(input,{store,request:async text=>{
   calls++;assert.equal(text,'最初的学习规划问题');return '学习规划';
 }});
 const result=await generate({threadId:'old',resourceId:'local',titleInput:'后续问题'});assert.equal(result.title,'学习规划');assert.equal((await store.getThreadById({threadId:'old'})).title,'学习规划');assert.equal((await store.getThreadById({threadId:'old'})).updatedAt,updatedAt);
 await generate({threadId:'old',resourceId:'local',titleInput:'新主题'});assert.equal(calls,1);
 await store.patchThread({id:'old',title:'用户自定标题',metadata:{}});const preserved=await generate({threadId:'old',resourceId:'local',titleInput:'新主题'});assert.equal(preserved.reason,'existing-title');assert.equal(calls,1);
 const invalid=await generate({threadId:'old',resourceId:'other',titleInput:'新主题'});assert.equal(invalid.reason,'thread-not-found');assert.equal(calls,1);
});

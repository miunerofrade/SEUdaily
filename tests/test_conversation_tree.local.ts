import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {AgentStore} from '../src/agent/storage.js';import {AgentRuntime} from '../src/agent/runtime.js';import {conversationPath,latestDescendant,branchKey} from '../src/shared/conversation-tree.js';
const context=(extra:any={})=>({threadId:'tree',resourceId:'resource',runToken:randomUUID(),...extra});
async function consume(stream:any){for await(const event of await stream)if(event.type==='error')throw new Error(event.payload.error.message);}
test('versions stay within one thread, branch context excludes sibling replies, history survives switching',async()=>{
 const store=new AgentStore(':memory:');const requests:any[]=[];let answer='原回答';
 const provider:any={stream:async function*(messages:any[]){requests.push(messages);yield {type:'text',text:answer};yield {type:'complete',message:{role:'assistant',content:answer}};},complete:async()=>{throw new Error('unexpected summary');}};
 const runtime=new AgentRuntime({store,provider,instructions:async()=>'',tools:async()=>({})});
 try{
 await consume(runtime.runTurn([{role:'user',content:'问题'}],context({userMessageId:'u1',assistantMessageId:'a1',parentMessageId:null})));
 // A stale linear summary must never inject the old answer into its regenerated sibling.
 await store.saveSummary('tree',{throughSequence:2,value:{goals:['旧回答不应该进入新版']},updatedAt:new Date().toISOString()});
 answer='新回答';await consume(runtime.runTurn([],context({regenerateFrom:'u1',assistantMessageId:'a2'})));
 const request=JSON.stringify(requests.at(-1));assert.match(request,/问题/);assert.doesNotMatch(request,/原回答|旧回答不应该/);
 assert.equal((await store.listThreads('resource')).length,1);
 let all=await store.allMessages('tree','resource');assert.equal(all.length,3);assert.equal(all.find(m=>m.id==='a2')?.content.parentId,'u1');
 await store.selectLeaf('tree','resource','a1');answer='旧版后续';await consume(runtime.runTurn([{role:'user',content:'跟着旧版问'}],context({userMessageId:'u2',assistantMessageId:'a3'})));
 assert.match(JSON.stringify(requests.at(-1)),/原回答/);assert.doesNotMatch(JSON.stringify(requests.at(-1)),/新回答/);
 answer='编辑后的回答';await consume(runtime.runTurn([{role:'user',content:'修改后的问题'}],context({userMessageId:'u1-edit',assistantMessageId:'a4',parentMessageId:null})));
 assert.doesNotMatch(JSON.stringify(requests.at(-1)),/原回答|跟着旧版问|新回答/);
 await store.selectLeaf('tree','resource','a3');assert.deepEqual((await store.contextMessages('tree','resource')).messages.map(m=>m.id),['u1','a1','u2','a3']);
 await store.forkThread('tree','resource','a1','separate');assert.equal((await store.listThreads('resource')).length,2);const copied=await store.allMessages('separate','resource');assert.equal(copied.length,2);assert.notEqual(copied[0].id,'u1');assert.equal(copied[1].content.parentId,copied[0].id);
 await assert.rejects(runtime.runTurn([{role:'user',content:'bad'}],context({parentMessageId:copied[1].id})),/父消息/);
 await assert.rejects(runtime.runTurn([{role:'user',content:'bad'}],context({userMessageId:'new',assistantMessageId:'a1'})),/回复 ID/);
 assert.ok(!(await store.allMessages('tree','resource')).some(m=>m.id==='new'));
 const selected=await store.listMessages({threadId:'tree',resourceId:'resource',selectedPath:true});assert.equal(selected.messages.length,4);
 }finally{store.close();}
});
test('legacy linear history and nested edits resolve into independent paths',()=>{
 const nodes=[{id:'u'},{id:'a'},{id:'u2'},{id:'a2'},{id:'v',parentId:'u'},{id:'u3',parentId:'v'},{id:'a3',parentId:'u3'}];
 assert.deepEqual(conversationPath(nodes,'a2').map(n=>n.id),['u','a','u2','a2']);assert.equal(latestDescendant(nodes,'a'),'a2');assert.equal(latestDescendant(nodes,'v'),'a3');assert.notEqual(branchKey(nodes,'a2'),branchKey(nodes,'a3'));
 assert.throws(()=>conversationPath([{id:'loop',parentId:'loop'}]));
});

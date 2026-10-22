import {test} from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {conversationStatistics,modelDisplayName} from '../src/shared/session-statistics.ts';
import {tsImport} from 'tsx/esm/api';
import {fileURLToPath} from 'node:url';
import {AgentStore} from '../src/agent/storage.ts';
import {AgentRuntime} from '../src/agent/runtime.ts';
import {DeepSeekProvider} from '../src/agent/provider.ts';
const {SessionStatistics}=await tsImport('../apps/web/src/chat/session-statistics.tsx',{parentURL:import.meta.url,tsconfig:fileURLToPath(new URL('../apps/web/tsconfig.json',import.meta.url))});

test('model labels preserve the actual API model identifier',()=>{
  assert.equal(modelDisplayName('deepseek-flash'),'DeepSeek-Flash');
  assert.equal(modelDisplayName('custom-model'),'custom-model');
});

test('session aggregation deduplicates approvals, weights speed, and uses last prompt rather than summed usage',()=>{
  const messages=[
    {id:'a',role:'assistant',brokerRunToken:'run',statistics:{modelSteps:1,modelMs:100,ttftTotalMs:20,ttftSamples:1,generationMs:80,generatedTokens:8,lastPromptTokens:1000}},
    {id:'b',role:'assistant',brokerRunToken:'run',statistics:{modelSteps:2,modelMs:500,ttftTotalMs:100,ttftSamples:2,generationMs:400,generatedTokens:80,lastPromptTokens:2000},tools:[{id:'tool',startedAt:100,finishedAt:400}]},
    {id:'c',role:'assistant',statistics:{modelSteps:1,modelMs:1000,ttftTotalMs:200,ttftSamples:1,generationMs:800,generatedTokens:80,lastPromptTokens:3000}},
  ];
  const stats=conversationStatistics(messages);
  assert.equal(stats.rounds,2);assert.equal(stats.steps,3);assert.equal(stats.modelMs,1500);assert.equal(stats.toolMs,300);
  assert.equal(stats.ttftMs,100);assert.equal(stats.tps,160000/1200);assert.equal(stats.lastPromptTokens,3000);
  const old=conversationStatistics([...messages,{id:'old',role:'assistant'}]);
  assert.equal(old.lastPromptTokens,undefined);assert.equal(old.partial,true);
  assert.equal(conversationStatistics([{id:'old',role:'assistant'}]).modelMs,undefined);
  assert.equal(conversationStatistics([{id:'old',role:'assistant'}]).tps,undefined);
});

test('runtime persists model statistics across approval while excluding tool and approval waits',async t=>{
  let clock=0,requests=0;
  t.mock.method(performance,'now',()=>clock);
  t.mock.method(Date,'now',()=>100000+clock);
  const store=new AgentStore(':memory:');t.after(()=>store.close());
  const runtime=new AgentRuntime({store,instructions:async()=>'',tools:async()=>({probe:{id:'probe',description:'test',inputSchema:z.object({}),requireApproval:true,execute:async()=>{clock+=1000;return {status:'completed',summary:'ok'};}}}),provider:{
    async *stream(){requests++;clock+=10;yield {type:'complete',finishReason:requests===1?'tool_calls':'stop',
      message:requests===1 ? {role:'assistant',content:null,tool_calls:[{id:'tool',type:'function',function:{name:'probe',arguments:'{}'}}]} : {role:'assistant',content:'done'},
      usage:{prompt_tokens:requests*1000,completion_tokens:requests*10},metrics:{ttftMs:requests*2,generationMs:requests===1?8:6,generatedTokens:requests*10-1}};},async summarize(){return '{}';}}});
  const context={threadId:'stats',resourceId:'test',runToken:'run'};
  const events=[];for await(const event of await runtime.runTurn([{role:'user',content:'test'}],context))events.push(event);
  const approval=events.find(event=>event.type==='tool-approval-request');assert.equal(approval.statistics.modelMs,10);
  clock+=5000;
  for await(const event of await runtime.resumeApproval({approvalId:approval.payload.approvalId,approved:true},context))events.push(event);
  const stats=events.findLast(event=>event.type==='finish').statistics;
  assert.equal(stats.modelSteps,2);assert.equal(stats.modelMs,20);assert.equal(stats.ttftSamples,2);assert.equal(stats.ttftTotalMs,6);
  assert.equal(stats.generatedTokens,28);assert.equal(stats.generationMs,14);assert.equal(stats.lastPromptTokens,2000);
  const saved=(await store.allMessages('stats','test')).find(message=>message.role==='assistant');
  assert.deepEqual(saved.content.statistics,stats);
  const invocation=saved.content.parts.find(part=>part.type==='tool-invocation').toolInvocation;
  assert.equal(invocation.finishedAt-invocation.startedAt,1000);
});

test('provider observes TTFT and generation for tool-only streams without changing request model',async t=>{
  let body;
  const chunk=delta=>'data: '+JSON.stringify({choices:[{delta}]})+'\n\n';
  t.mock.method(globalThis,'fetch',async(_url,options)=>{
    body=JSON.parse(options.body);
    return new Response(new ReadableStream({start(controller){
      const encoder=new TextEncoder();
      controller.enqueue(encoder.encode(chunk({role:'assistant'})));
      setTimeout(()=>controller.enqueue(encoder.encode(chunk({tool_calls:[{index:0,id:'call',function:{name:'probe',arguments:'{'}}]}))),10);
      setTimeout(()=>{controller.enqueue(encoder.encode('data: '+JSON.stringify({choices:[{delta:{tool_calls:[{index:0,function:{arguments:'}'}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:100,completion_tokens:20}})+'\n\n'));controller.close();},30);
    }}));
  });
  const events=[];for await(const event of new DeepSeekProvider({apiKey:'fixture'}).stream([{role:'user',content:'test'}],[]))events.push(event);
  assert.equal(body.model,'deepseek-flash');assert.ok(events.at(-1).metrics.ttftMs>=0);
  assert.ok(events.at(-1).metrics.generationMs>0);assert.equal(events.at(-1).metrics.generatedTokens,19);
});

test('single-chunk output cannot claim a measured generation speed',async t=>{
  t.mock.method(globalThis,'fetch',async()=>new Response('data: '+JSON.stringify({choices:[{delta:{content:'done'},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:20}})+'\n\n'));
  const events=[];for await(const event of new DeepSeekProvider({apiKey:'fixture'}).stream([{role:'user',content:'test'}],[]))events.push(event);
  assert.equal(events.at(-1).metrics.generationMs,undefined);assert.equal(events.at(-1).metrics.generatedTokens,undefined);
});

test('footer panels start closed and historical missing counters never become made-up rates',()=>{
  const html=renderToStaticMarkup(React.createElement(SessionStatistics,{messages:[{id:'old',role:'assistant',content:'answer',createdAt:1}],usage:{},contextWindowTokens:512000}));
  assert.match(html,/aria-label="会话统计" aria-expanded="false"/);assert.match(html,/aria-label="上下文占用" aria-expanded="false"/);
  assert.doesNotMatch(html,/class="usage-panel"|tok\/s|50%/);
});

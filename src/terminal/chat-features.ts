import type {Session,TerminalMessage} from './session.js';
import {conversationStatistics,modelDisplayName} from '../shared/session-statistics.js';
import {durationLabel,elapsedTime} from '../shared/timing.js';
import {reasoningEfforts,effortLabels,type ReasoningEffort} from '../shared/reasoning-effort.js';
import {normalizedUsage,cacheHitLabel} from '../shared/telemetry.js';

export const metrics = (messages:TerminalMessage[])=>conversationStatistics(messages.filter(m=>m.role==='SEUdaily').map((m,i)=>({...m,id:m.id ?? String(i),role:'assistant',tools:m.process?.filter(p=>p.type==='tool').map((p,i)=>({id:p.id ?? String(i),startedAt:p.startedAt,finishedAt:p.finishedAt}))})));
const time=(ms:number|undefined)=>ms===undefined?'—':ms>0&&ms<1000?`${Math.round(ms)} ms`:durationLabel(ms);
const totalTokens=(usage:Session['usage'])=>usage.total_tokens ?? (usage.prompt_tokens!==undefined && usage.completion_tokens!==undefined?usage.prompt_tokens+usage.completion_tokens:undefined);
export function compactMetrics(s:Session) {
  const stats=metrics(s.messages);
  const context=stats.lastPromptTokens===undefined?'—':`${(stats.lastPromptTokens/s.contextWindowTokens*100).toFixed(1)}%`;
  const total=totalTokens(s.usage);
  const totalLabel=total===undefined?'—':Intl.NumberFormat('en-US',{notation:'compact',maximumFractionDigits:1}).format(total);
  return `${modelDisplayName(s.model)} · ${effortLabels[s.effort as ReasoningEffort] ?? s.effort} · ${stats.rounds}轮/${stats.steps}步 · ${stats.tps===undefined?'—':Math.round(stats.tps)} tok/s · Σ ${totalLabel} · hit ${cacheHitLabel(s.usage)} · ctx ${context}`;
}
export function statsText(s:Session) {
  const stats=metrics(s.messages),n=(v:number|undefined)=>v===undefined?'—':v.toLocaleString('en-US');
  const lines=[compactMetrics(s),`模型 ${time(stats.modelMs)} · 工具 ${time(stats.toolMs)} · TTFT ${time(stats.ttftMs)}`,
    `累计 token ${n(totalTokens(s.usage))} · 缓存命中 ${cacheHitLabel(s.usage)}`,
    `最近已统计输入 ${n(stats.lastPromptTokens)} / 上下文预算 ${n(s.contextWindowTokens)}`];
  const rounds=new Map<string,TerminalMessage>();
  for(const [index,message] of s.messages.entries())if(message.role==='SEUdaily')rounds.set(message.brokerRunToken || message.id || String(index),message);
  for(const [index,m] of [...rounds.values()].entries()) {
    const usage=normalizedUsage(m.usage);
    lines.push(`${index+1}. ◷ ${m.timing?time(elapsedTime(m.timing)):'—'} · in ${n(usage.prompt_tokens)} / out ${n(usage.completion_tokens)} · 缓存 ${cacheHitLabel(usage)}`);
  }
  if(stats.partial)lines.push('部分历史缺少计时：只统计已有数据；上下文为最近一次已返回的输入 token。');
  return lines.join('\n');
}
export function collapseToolChildren(s:Session,part:{type?:string;expanded?:boolean}) {
  if(part.type!=='tool-group' || part.expanded)return;
  for(const message of s.messages)if(message.process?.includes(part as any))
    for(const child of message.process)if(child.type==='tool')child.expanded=false;
}

export const chatFeatureNames=new Set(['stats','effort','steer','tools','messages','edit','retry','branch','versions','version']);

/** Terminal commands are adapters over the same graph/queue APIs used by Web. */
export async function chatFeatureCommand(s:Session,name:string,args:string[]):Promise<boolean> {
  if(name==='stats'){s.show(statsText(s),'统计');return true;}
  if(name==='effort') {
    if(s.busy || s.queueActive)throw Error('请等待当前任务结束后切换思考强度');
    const effort=args[0];
    if(!effort){s.openForm({title:'思考强度',fields:[{key:'effort',label:'强度',value:s.effort,choices:reasoningEfforts.map(value=>({value,label:effortLabels[value]}))}],save:async values=>{await chatFeatureCommand(s,'effort',[values.effort]);}});return true;}
    if(!reasoningEfforts.includes(effort as ReasoningEffort))throw Error('/effort none|low|high|max');
    await s.client.json('/app/agent-info','POST',{effort});s.effort=effort;s.changed();return true;
  }
  if(name==='steer') {
    if(!args.length)throw Error('/steer 补充要求（终端支持时也可 Ctrl+Enter）');
    if(s.images.length || s.documents.length || s.skills.length)throw Error('补充当前任务仅接受文字；附件和 Skill 请用 Enter 排队');
    await s.enqueue(args.join(' '),true);return true;
  }
  if(name==='tools') {
    const message=[...s.messages].reverse().find(m=>m.process?.some(p=>p.type==='tool'));
    if(!message){s.show('当前没有工具调用');return true;}
    const group=message.process!.find(p=>p.type==='tool-group');
    const tools=message.process!.filter(p=>p.type==='tool');
    if(args[0] && !['open','close'].includes(args[0])) {
      const index=Number(args[0])-1;if(!Number.isInteger(index)||!tools[index])throw Error('/tools open|close|工具序号');
      if(group)group.expanded=true;tools[index].expanded=!tools[index].expanded;
    }else if(group){group.expanded=args[0]==='open'?true:args[0]==='close'?false:!group.expanded;collapseToolChildren(s,group);}
    s.changed();return true;
  }
  if(!['messages','retry','edit','branch','versions','version'].includes(name))return false;
  if(s.queueActive || s.pending)throw Error('请先结束当前运行或处理审批');
  const {messages=[]}=await s.client.json(s.path('messages')+'&perPage=1000&selectedPath=true');
  const userMessages=messages.filter((m:any)=>m.role==='user');
  if(name==='messages'){s.show(userMessages.map((m:any,i:number)=>`${i+1}. ${m.content?.parts?.filter((p:any)=>p.type==='text').map((p:any)=>p.text).join(' ') || m.content?.content || m.id}`).join('\n')||'没有用户消息');return true;}
  if(name==='versions') {
    const all=await s.client.json(s.path('messages')+'&perPage=1000');
    s.show(all.messages.map((m:any)=>`${m.id} · ${m.role} · ${String(m.content?.parts?.filter((p:any)=>p.type==='text').map((p:any)=>p.text).join(' ')||'').slice(0,120)}`).join('\n'));return true;
  }
  if(name==='version') {
    if(!args[0])throw Error('/version 消息ID（/versions 查看）');
    await s.client.json(`/api/memory/threads/${encodeURIComponent(s.threadId)}/version`,'PATCH',{resourceId:s.resource,leafId:args[0]});
  }else if(name==='branch') {
    const target=args[0]?userMessages[Number(args[0])-1]:messages.at(-1);
    if(!target)throw Error('消息不存在，/messages 查看用户消息序号');
    const result=await s.client.json(`/api/memory/threads/${encodeURIComponent(s.threadId)}/fork`,'POST',{resourceId:s.resource,messageId:target.id});
    await s.resume(result.threadId);return true;
  }else {
    const indexed=/^\d+$/.test(args[0] ?? '');
    const user=indexed?userMessages[Number(args.shift())-1]:userMessages.at(-1);
    if(!user)throw Error('没有可操作的用户消息，/messages 查看序号');
    if(name==='edit' && !args.length){s.openForm({title:'编辑消息并重新回答',fields:[{key:'text',label:'内容',value:user.content?.content || user.content?.parts?.filter((p:any)=>p.type==='text').map((p:any)=>p.text).join('\n') || ''}],save:async values=>{if(s.busy || s.queueActive)throw Error('当前任务正在运行');s.busy=true;s.changed();try{await editedTurn(s,user,values.text);s.messages=[];s.usageByRun.clear();await s.history(1000);}finally{s.busy=false;s.changed();}}});return true;}
    if(s.images.length || s.documents.length || s.skills.length)throw Error('请先发送或移除输入框中的附件与 Skill');
    if(name==='retry')await s.turn([],{seudailyRegenerateFrom:user.id});
    else await editedTurn(s,user,args.join(' '));
  }
  s.messages=[];s.usageByRun.clear();await s.history(1000);s.changed();return true;
}

async function editedTurn(s:Session,user:any,text:string) {
  if(!text.trim())throw Error('编辑内容不能为空');
  if(s.images.length || s.documents.length || s.skills.length)throw Error('请先发送或移除输入框中的附件与 Skill');
  const files=(user.content?.parts ?? []).filter((p:any)=>p.type==='file');
  const original=user.content?.parts?.filter((p:any)=>p.type==='text').map((p:any)=>p.text).join('\n') || user.content?.content || '';
  const marker=original.indexOf('\n\n<!-- seudaily:documents -->');
  const content=text+(marker>=0?original.slice(marker):'');
  await s.turn(files.length?[{role:'user',content:[{type:'text',text:content},...files]}]:content,{seudailyParentMessageId:user.content?.parentId ?? null});
}

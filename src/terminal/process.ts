import {durationLabel,elapsedTime} from '../shared/timing.js';
import {normalizedUsage,cacheHitLabel} from '../shared/telemetry.js';
import type { TerminalMessage } from "./session.js";
import { messageLines, type Span } from "./markdown.js";

const cache = new WeakMap<TerminalMessage, { key: string; lines: Span[][] }>();

/** Keep reasoning, narration and tools in the same order as the Web transcript. */
export function processLines(message: TerminalMessage, width: number, expanded: boolean): Span[][] {
  if (!message.process?.length) return messageLines(message, width);
  const key = JSON.stringify([width, expanded, message.streaming, message.text, message.process,message.timing,message.usage,message.streaming?Math.floor(Date.now()/1000):0]);
  const hit = cache.get(message);
  if (hit?.key === key) return hit.lines;
  const parts = message.process.some(part => part.type === "text") || !message.text
    ? message.process : [...message.process, { type: "text" as const, text: message.text }];
  const lines = parts.flatMap((part): Span[][] => {
    if (part.type === "text") return part.text ? messageLines({ role: "SEUdaily", text: part.text }, width) : [];
    if(part.type==='tool-group')return messageLines({role:'SEUdaily',text:`${part.expanded?'－':'＋'} 工具调用 · 点击或 /tools`},width).map(line=>line.map(span=>({...span,muted:true,reasoningPart:part})));
    if (part.type === "tool") {
      const parent=message.process!.find(p=>p.type==='tool-group');
      if(parent && !parent.expanded)return [];
      const ordinal=message.process!.filter(p=>p.type==='tool').indexOf(part)+1;
      const elapsed=part.startedAt===undefined?'':` · ◷ ${durationLabel(Math.max(0,(part.finishedAt ?? Date.now())-part.startedAt))}`;
      const header=messageLines({role:'SEUdaily',text:`${part.expanded?'－':'＋'} ${ordinal}. ${part.text}${elapsed}`},width).map(line=>line.map(span=>({...span,muted:true,reasoningPart:part})));
      if(!part.expanded)return header;
      const result=part.result===undefined?'等待工具返回':JSON.stringify(part.result,null,2);
      return [...header,...messageLines({role:'SEUdaily',text:'```json\n'+result+'\n```'},width)];
    }
    const open = !!part.expanded;
    const header: Span[] = [{ text: `${open ? "－" : "＋"} 思考 · 点击或 Ctrl+T ${open ? "收起" : "展开"}`, muted: true, reasoningPart: part }];
    const body = open ? messageLines({ role: "SEUdaily", text: part.text }, Math.max(1, width - 2))
      .map(line => [{ text: "  ", muted: true }, ...line.map(span => ({ ...span, muted: true }))]) : [];
    return [header, ...body, [{ text: " " }]];
  });
  if(!message.streaming && (message.timing || message.usage)) {
    const usage=normalizedUsage(message.usage);
    lines.push(...messageLines({role:'SEUdaily',text:`◷ ${message.timing?durationLabel(elapsedTime(message.timing)):'—'} · in ${usage.prompt_tokens?.toLocaleString('en-US') ?? '—'} / out ${usage.completion_tokens?.toLocaleString('en-US') ?? '—'} · 缓存 ${cacheHitLabel(usage)} · /stats`},width).map(line=>line.map(span=>({...span,color:'#80cbc4'}))));
  }
  cache.set(message, { key, lines });
  return lines;
}

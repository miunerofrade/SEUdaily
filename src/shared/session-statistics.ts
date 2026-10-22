export type RunStatistics = {
  modelSteps?: number;
  modelMs?: number;
  ttftTotalMs?: number;
  ttftSamples?: number;
  generationMs?: number;
  generatedTokens?: number;
  lastPromptTokens?: number;
};

export function modelDisplayName(id: string) {
  return /^deepseek-/i.test(id) ? id.split('-').map((part,index)=>index===0 ? 'DeepSeek' : part.charAt(0).toUpperCase()+part.slice(1)).join('-') : id;
}

type StatisticsTool={id:string;startedAt?:number;finishedAt?:number};
type StatisticsMessage = {id:string;role:string;brokerRunToken?:string;statistics?:RunStatistics;tools?:StatisticsTool[]};
const valid=(value:unknown):value is number=>typeof value==='number' && Number.isFinite(value) && value>=0;

/** Continuations repeat cumulative counters; count each selected run and tool once. */
export function conversationStatistics(messages:ReadonlyArray<StatisticsMessage>) {
  const runs=new Map<string,StatisticsMessage>();
  for(const message of messages) if(message.role==='assistant') runs.set(message.brokerRunToken || message.id,message);
  let steps=0,modelMs=0,modelSamples=0,ttftTotalMs=0,ttftSamples=0,generationMs=0,generatedTokens=0;
  let lastPromptTokens:number|undefined;
  const tools=new Map<string,StatisticsTool>();
  for(const [token,message] of runs) {
    const stats=message.statistics;
    if(valid(stats?.modelSteps))steps+=stats.modelSteps;
    if(valid(stats?.modelMs)){modelMs+=stats.modelMs;modelSamples++;}
    if(valid(stats?.ttftTotalMs)&&valid(stats?.ttftSamples)){ttftTotalMs+=stats.ttftTotalMs;ttftSamples+=stats.ttftSamples;}
    if(valid(stats?.generationMs)&&stats.generationMs>0&&valid(stats?.generatedTokens)){generationMs+=stats.generationMs;generatedTokens+=stats.generatedTokens;}
    // Usage arrives at request completion; keep the latest measured value while a new run streams.
    if(valid(stats?.lastPromptTokens))lastPromptTokens=stats.lastPromptTokens;
    for(const tool of message.tools ?? [])tools.set(`${token}:${tool.id}`,tool);
  }
  let toolMs=0,toolSamples=0;
  for(const tool of tools.values()) if(valid(tool.startedAt)&&valid(tool.finishedAt)&&tool.finishedAt>=tool.startedAt){toolMs+=tool.finishedAt-tool.startedAt;toolSamples++;}
  return {rounds:runs.size,steps,modelMs:modelSamples ? modelMs : undefined,modelSamples,
    toolMs:tools.size===0 || toolSamples>0 ? toolMs : undefined,toolCount:tools.size,toolSamples,
    ttftMs:ttftSamples>0 ? ttftTotalMs/ttftSamples : undefined,
    tps:generationMs>0 ? generatedTokens*1000/generationMs : undefined,lastPromptTokens,
    partial:modelSamples<runs.size || toolSamples<tools.size};
}

import {Database} from 'lucide-react';
import {MetricPopover} from './metric-popover';
import {cacheHitLabel,normalizedUsage} from '../../../../src/shared/telemetry';

function compactTokens(value:number|undefined) {
  if(value===undefined)return '—';
  if(value>=1_000_000)return `${(value/1_000_000).toFixed(1)}M`;
  if(value>=1_000)return `${(value/1_000).toFixed(1)}k`;
  return String(value);
}
const fullTokens=(value:number|undefined)=>value===undefined ? '—' : `${value.toLocaleString('en-US')} tok`;

export function UsagePopover({usage:raw,cumulative=false}:{usage:unknown;cumulative?:boolean}) {
  const usage=normalizedUsage(raw);
  const total=usage.total_tokens ?? (usage.prompt_tokens!==undefined && usage.completion_tokens!==undefined ? usage.prompt_tokens+usage.completion_tokens : undefined);
  const missed=usage.prompt_cache_miss_tokens ?? (usage.prompt_tokens!==undefined && usage.prompt_cache_hit_tokens!==undefined ? Math.max(0,usage.prompt_tokens-usage.prompt_cache_hit_tokens) : undefined);
  const title=cumulative ? '会话累计用量' : '本轮用量';
  return <MetricPopover title={title} icon={<Database size={15} aria-hidden="true" />} total={fullTokens(total)} label={cumulative ? `${compactTokens(total)} tok · 缓存命中 ${cacheHitLabel(usage)}` : `用量 ${compactTokens(total)} tok`}>
      <dl><dt>缓存命中</dt><dd>{cacheHitLabel(usage)}</dd><dt>未缓存输入</dt><dd>{fullTokens(missed)}</dd><dt>缓存读取</dt><dd>{fullTokens(usage.prompt_cache_hit_tokens)}</dd>{usage.prompt_cache_write_tokens!==undefined&&<><dt>缓存写入</dt><dd>{fullTokens(usage.prompt_cache_write_tokens)}</dd></>}<dt>输出</dt><dd>{fullTokens(usage.completion_tokens)}</dd></dl>
  </MetricPopover>;
}

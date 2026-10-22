import {Gauge} from 'lucide-react';
import {conversationStatistics} from '../../../../src/shared/session-statistics';
import {durationLabel} from '../../../../src/shared/timing';
import type {ChatMessage} from '../types';
import {MetricPopover} from './metric-popover';
import {UsagePopover} from './usage-popover';

const duration=(ms:number|undefined)=>ms===undefined ? '—' : ms>0 && ms<1000 ? '<1 秒' : durationLabel(ms);
const tokens=(value:number|undefined)=>value===undefined ? '—' : `${value.toLocaleString('en-US')} tok`;

export function SessionStatistics({messages,contextWindowTokens,usage}:{messages:ChatMessage[];contextWindowTokens?:number;usage:unknown}) {
  const stats=conversationStatistics(messages);
  const speed=stats.tps===undefined ? undefined : `${Math.round(stats.tps).toLocaleString('en-US')} tok/s`;
  const ratio=stats.lastPromptTokens!==undefined && contextWindowTokens!==undefined && contextWindowTokens>0 ? stats.lastPromptTokens/contextWindowTokens : undefined;
  return <>
    <MetricPopover title="会话统计" icon={<Gauge size={15} aria-hidden="true" />} label={`${stats.rounds} 轮${stats.steps ? ` ${stats.steps} 步` : ''}${speed ? ` · ${speed}` : ''}`}>
      <dl><dt>模型用时</dt><dd>{duration(stats.modelMs)}</dd><dt>工具调用用时</dt><dd>{duration(stats.toolMs)}</dd><dt>首 token 平均（TTFT）</dt><dd>{duration(stats.ttftMs)}</dd><dt>输出速度（TPS）</dt><dd>{speed ?? '—'}</dd></dl>
      <p className="metric-note">每步为一次模型请求（含重试）。模型用时含网络与首响应等待；工具用时不含审批等待。TTFT 包含思考或工具参数的首次输出；TPS 按有完整计时的请求加权，包含思考 token。{stats.partial ? '部分旧记录缺少计时，时长与速度仅统计已记录部分。' : ''}</p>
    </MetricPopover>
    <UsagePopover usage={usage} cumulative />
    <ContextUsage ratio={ratio} used={stats.lastPromptTokens} limit={contextWindowTokens} />
  </>;
}

function ContextUsage({ratio,used,limit}:{ratio?:number;used?:number;limit?:number}) {
  const percent=ratio===undefined ? '—' : ratio>0 && ratio<.001 ? '<0.1%' : `${Number((ratio*100).toFixed(1))}%`;
  const icon=<svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="10" r="7.5" stroke="currentColor" opacity=".25" strokeWidth="3" />{ratio!==undefined&&<circle cx="10" cy="10" r="7.5" pathLength="100" stroke="currentColor" strokeWidth="3" strokeDasharray={`${Math.min(100,Math.max(0,ratio*100))} 100`} transform="rotate(-90 10 10)" />}</svg>;
  return <MetricPopover title="上下文占用" icon={icon} label={percent}>
    <dl><dt>最近一次请求输入</dt><dd>{tokens(used)}</dd><dt>应用上下文预算</dt><dd>{tokens(limit)}</dd><dt>占用</dt><dd>{percent}</dd></dl>
    <p className="metric-note">使用 API 返回的最近一次请求输入 token，包含消息与工具定义；预算取应用配置，不代表模型官方最大窗口。旧记录未保存此数据时显示 —。</p>
  </MetricPopover>;
}

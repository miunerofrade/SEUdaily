import {Database,X} from 'lucide-react';
import {useEffect,useId,useRef,useState,type CSSProperties} from 'react';
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
  const [open,setOpen]=useState(false);
  const [position,setPosition]=useState<CSSProperties>({});
  const root=useRef<HTMLDivElement>(null);
  const button=useRef<HTMLButtonElement>(null);
  const id=useId();
  const title=cumulative ? '会话累计用量' : '本轮用量';
  useEffect(()=>{
    if(!open)return;
    const outside=(event:PointerEvent)=>{if(!root.current?.contains(event.target as Node))setOpen(false);};
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){setOpen(false);button.current?.focus();}};
    const scroll=(event:Event)=>{if(!root.current?.contains(event.target as Node))setOpen(false);};
    const close=()=>setOpen(false);
    document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape);document.addEventListener('scroll',scroll,true);window.addEventListener('resize',close);
    return ()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape);document.removeEventListener('scroll',scroll,true);window.removeEventListener('resize',close);};
  },[open]);
  return <div className="usage-popover" ref={root}>
    <button ref={button} type="button" className="usage-trigger" aria-label={title} aria-expanded={open} aria-controls={id} onClick={()=>{
      const rect=button.current!.getBoundingClientRect(),width=Math.min(360,window.innerWidth-24),above=rect.top>window.innerHeight/2;
      setPosition({width,left:Math.max(12,Math.min(rect.left,window.innerWidth-width-12)),maxHeight:Math.max(80,(above ? rect.top : window.innerHeight-rect.bottom)-20),...(above ? {bottom:window.innerHeight-rect.top+8} : {top:rect.bottom+8})});
      setOpen(value=>!value);
    }}><Database size={15} aria-hidden="true" />{cumulative ? `${compactTokens(total)} tok · 缓存命中 ${cacheHitLabel(usage)}` : `用量 ${compactTokens(total)} tok`}</button>
    {open&&<section id={id} className="usage-panel" style={position} role="region" aria-labelledby={`${id}-title`}>
      <header><Database size={17} /><strong id={`${id}-title`}>{title}</strong><b>{fullTokens(total)}</b><button type="button" className="icon-button" aria-label={`关闭${title}`} onClick={()=>{setOpen(false);button.current?.focus();}}><X size={15} /></button></header>
      <dl><dt>缓存命中</dt><dd>{cacheHitLabel(usage)}</dd><dt>未缓存输入</dt><dd>{fullTokens(missed)}</dd><dt>缓存读取</dt><dd>{fullTokens(usage.prompt_cache_hit_tokens)}</dd>{usage.prompt_cache_write_tokens!==undefined&&<><dt>缓存写入</dt><dd>{fullTokens(usage.prompt_cache_write_tokens)}</dd></>}<dt>输出</dt><dd>{fullTokens(usage.completion_tokens)}</dd></dl>
    </section>}
  </div>;
}

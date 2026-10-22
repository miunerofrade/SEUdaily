import {Check,ChevronDown} from 'lucide-react';
import {useEffect,useRef,useState} from 'react';
import {reasoningEfforts,effortLabels,type ReasoningEffort} from '../../../src/shared/reasoning-effort';
import {saveReasoningEffort} from './api';

export function EffortSelect({effort,busy,onChange}:{effort:string;busy:boolean;onChange:(effort:ReasoningEffort)=>void}) {
  const [open,setOpen]=useState(false);
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState('');
  const root=useRef<HTMLDivElement>(null);
  const button=useRef<HTMLButtonElement>(null);
  const selected=reasoningEfforts.includes(effort as ReasoningEffort) ? effort as ReasoningEffort : 'high';
  useEffect(()=>{
    if(!open)return;
    root.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    const outside=(event:PointerEvent)=>{if(!root.current?.contains(event.target as Node))setOpen(false);};
    document.addEventListener('pointerdown',outside);
    return ()=>document.removeEventListener('pointerdown',outside);
  },[open]);
  async function select(value:ReasoningEffort) {
    setSaving(true);setError('');
    try {const saved=await saveReasoningEffort(value);onChange(saved.effort);setOpen(false);requestAnimationFrame(()=>button.current?.focus());}
    catch(reason){setError(reason instanceof Error ? reason.message : '保存失败，请重试');}
    finally {setSaving(false);}
  }
  return <div className="composer-effort" ref={root} onBlur={event=>{if(event.relatedTarget && !event.currentTarget.contains(event.relatedTarget))setOpen(false);}} onKeyDown={event=>{
    if(event.key==='Escape'){event.stopPropagation();setOpen(false);button.current?.focus();}
    if(open && ['ArrowDown','ArrowUp'].includes(event.key)) {
      event.preventDefault();const items=Array.from(root.current!.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'));
      const index=items.indexOf(document.activeElement as HTMLButtonElement);
      items[(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length]?.focus();
    }
  }}>
    <button ref={button} type="button" className="effort-toggle" disabled={busy||saving} aria-label={`思考强度：${effortLabels[selected]}`} aria-haspopup="menu" aria-expanded={open} onClick={()=>setOpen(value=>!value)}>{effortLabels[selected]}<ChevronDown size={13} /></button>
    {open && <div className="effort-menu" role="menu" aria-label="选择思考强度">{reasoningEfforts.map(value=><button type="button" role="menuitemradio" aria-checked={value===selected} key={value} disabled={saving||busy} onClick={()=>void select(value)}><span>{effortLabels[value]}</span>{value===selected&&<Check size={15} />}</button>)}{error&&<p role="alert">{error}</p>}</div>}
  </div>;
}

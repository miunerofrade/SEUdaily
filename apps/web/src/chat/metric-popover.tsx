import {X} from 'lucide-react';
import {useEffect,useId,useRef,useState,type CSSProperties,type ReactNode} from 'react';

export function MetricPopover({title,icon,label,total,children}:{title:string;icon:ReactNode;label:ReactNode;total?:ReactNode;children:ReactNode}) {
  const [open,setOpen]=useState(false);
  const [position,setPosition]=useState<CSSProperties>({});
  const root=useRef<HTMLDivElement>(null),button=useRef<HTMLButtonElement>(null);
  const id=useId();
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
    }}>{icon}{label}</button>
    {open&&<section id={id} className="usage-panel" style={position} role="region" aria-labelledby={`${id}-title`}>
      <header>{icon}<strong id={`${id}-title`}>{title}</strong><b>{total}</b><button type="button" className="icon-button" aria-label={`关闭${title}`} onClick={()=>{setOpen(false);button.current?.focus();}}><X size={15} /></button></header>
      {children}
    </section>}
  </div>;
}

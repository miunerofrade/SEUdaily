import {Info,X} from 'lucide-react';
import {useEffect,useId,useRef,useState,type CSSProperties} from 'react';
import type {ToolRun} from '../types';
import {brokerCapabilityName,toolLabel} from './tool-presentation';

/** Individual tool errors are diagnostics, independent of the answer's outcome. */
export function ToolInformation({tools}:{tools:ToolRun[]}) {
  const [open,setOpen]=useState(false);
  const root=useRef<HTMLDivElement>(null);
  const button=useRef<HTMLButtonElement>(null);
  const id=useId();
  const [position,setPosition]=useState<CSSProperties>({});
  const incomplete=tools.filter(tool=>tool.state==='failed' || tool.result?.status==='failed' || tool.result?.status==='cancelled');
  useEffect(()=>{
    if(!open) return;
    const outside=(event:PointerEvent)=>{if(!root.current?.contains(event.target as Node))setOpen(false);};
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){setOpen(false);button.current?.focus();}};
    const scroll=(event:Event)=>{if(!root.current?.contains(event.target as Node))setOpen(false);};
    const resize=()=>setOpen(false);
    document.addEventListener('pointerdown',outside);
    document.addEventListener('keydown',escape);
    document.addEventListener('scroll',scroll,true);
    window.addEventListener('resize',resize);
    return ()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape);document.removeEventListener('scroll',scroll,true);window.removeEventListener('resize',resize);};
  },[open]);
  if(!incomplete.length) return null;
  return <div className="tool-information" ref={root}>
    <button ref={button} type="button" className="message-action" aria-label="工具调用信息" title="工具调用信息" aria-expanded={open} aria-controls={id} onClick={()=>{
      const rect=button.current!.getBoundingClientRect();
      const width=Math.min(420,window.innerWidth-24);
      setPosition({left:Math.max(12,Math.min(rect.left,window.innerWidth-width-12)),...(rect.top>window.innerHeight/2 ? {bottom:window.innerHeight-rect.top+8} : {top:rect.bottom+8})});
      setOpen(value=>!value);
    }}><Info size={17} /></button>
    {open && <section id={id} style={position} className="tool-information-panel" role="region" aria-labelledby={`${id}-title`}>
      <header><strong id={`${id}-title`}>工具调用信息</strong><button type="button" className="icon-button" aria-label="关闭工具调用信息" onClick={()=>{setOpen(false);button.current?.focus();}}><X size={16} /></button></header>
      <p>过程中未完成的调用及其返回信息。</p>
      <ul>{incomplete.map(tool=><li key={tool.id}>
        <strong>{toolLabel(brokerCapabilityName(tool.result) || tool.name)}</strong>
        <p>{tool.result?.summary || '此调用未完成，未提供更多错误详情。'}</p>
        {!!tool.result?.warnings?.length && <ul>{tool.result.warnings.map((warning,index)=><li key={index}>{warning}</li>)}</ul>}
      </li>)}</ul>
    </section>}
  </div>;
}

import {useEffect,useState,type CSSProperties} from 'react';

const key='seudaily.web.sidebar-width';
export function sidebarWidth(value:number, viewport:number) {
  return Math.min(Math.max(220,value),Math.max(220,Math.min(480,viewport-360)));
}
export function useSidebarResize() {
  const [width,setWidth]=useState(()=>{
    let saved=0;
    try {saved=Number(localStorage.getItem(key));} catch { /* Storage may be disabled. */ }
    return sidebarWidth(Number.isFinite(saved) && saved>0 ? saved : 260,window.innerWidth);
  });
  const [dragging,setDragging]=useState(false);
  useEffect(()=>{try {localStorage.setItem(key,String(width));} catch { /* Resizing still works without persistence. */ }},[width]);
  useEffect(()=>{
    const resize=()=>setWidth(value=>sidebarWidth(value,window.innerWidth));
    window.addEventListener('resize',resize);
    return ()=>window.removeEventListener('resize',resize);
  },[]);
  const separator=<div className="sidebar-resizer" role="separator" aria-label="调整导航栏宽度" aria-orientation="vertical" tabIndex={0}
    aria-valuemin={220} aria-valuemax={Math.max(220,Math.min(480,window.innerWidth-360))} aria-valuenow={width}
    onPointerDown={event=>{
      if (event.button!==0) return;
      event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);setDragging(true);
    }}
    onPointerMove={event=>{if(event.currentTarget.hasPointerCapture(event.pointerId))setWidth(sidebarWidth(event.clientX,window.innerWidth));}}
    onPointerUp={event=>{if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);setDragging(false);}}
    onLostPointerCapture={()=>setDragging(false)}
    onDoubleClick={()=>setWidth(260)}
    onKeyDown={event=>{
      if(event.key==='ArrowLeft'||event.key==='ArrowRight') {event.preventDefault();setWidth(value=>sidebarWidth(value+(event.key==='ArrowRight'?10:-10),window.innerWidth));}
      if(event.key==='Home') {event.preventDefault();setWidth(220);}
    }} />;
  return {style:{'--sidebar-width':`${width}px`} as CSSProperties,separator,dragging};
}

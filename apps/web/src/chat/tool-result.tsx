import {ChevronRight} from 'lucide-react';
import {useId,useState,type ReactNode} from 'react';
import type {ToolRun} from '../types';
import {toolLabel,toolNarration} from './tool-presentation';
import {Elapsed} from './elapsed';

/** Unmounting with the parent process also resets the result's expanded state. */
export function ToolResultDetails({tool,children}:{tool:ToolRun;children?:ReactNode}) {
  const [open,setOpen]=useState(false);
  const id=useId();
  const summary=tool.state==='approval-requested' ? `等待批准：${toolLabel(tool.name)}` : tool.result?.summary ?? toolNarration(tool,tool.state==='running' ? 'running' : 'completed');
  const feedback=tool.result===undefined
    ? tool.state==='running' ? '等待工具返回…' : tool.state==='approval-requested' ? '等待批准，工具尚未执行。' : '此调用未提供返回结果。'
    : typeof tool.result==='string' ? tool.result : JSON.stringify(tool.result,null,2);
  return <div className="tool-result-details">
    <button type="button" className="tool-activity-heading" aria-expanded={open} aria-controls={id} onClick={()=>setOpen(value=>!value)}>
      <strong>{summary}</strong>
      {tool.startedAt!==undefined && <Elapsed timing={tool.finishedAt!==undefined ? {elapsedMs:Math.max(0,tool.finishedAt-tool.startedAt)} : tool.state==='running' ? {elapsedMs:0,startedAt:tool.startedAt} : undefined} />}
      <ChevronRight className="tool-result-chevron" size={14} aria-hidden="true" />
    </button>
    {open && <section id={id} className="tool-result-feedback" aria-label="工具返回结果"><pre>{feedback}</pre></section>}
    {children}
  </div>;
}

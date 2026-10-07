import { useEffect, useRef, useState } from 'react';
import { FileText, RefreshCw, Upload } from 'lucide-react';
type Document = {id:string;name:string;state:string;error:string;chunkCount:number};
type Match = {id:string;name:string;page:number;ordinal:number;text:string};
const labels:Record<string,string>={queued:'等待索引',waiting_config:'等待 API Key',processing:'正在处理',indexed:'可检索',failed:'处理失败',needs_ocr:'待 OCR',outdated:'需重建索引',deleting:'移除未完成'};
async function request(path:string,init?:RequestInit) {
  const response=await fetch('/app/knowledge'+path,init),body=await response.json();
  if(!response.ok) throw new Error(body.error || '知识库请求失败');return body;
}
const json=(body:unknown)=>({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
export function KnowledgePanel({selectedPath,onFilesChanged}:{selectedPath?:string;onFilesChanged?:()=>void}) {
  const [documents,setDocuments]=useState<Document[]>([]),[configured,setConfigured]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[query,setQuery]=useState(''),[matches,setMatches]=useState<Match[]>([]);
  const input=useRef<HTMLInputElement>(null),knownFiles=useRef('');
  async function load() {const result=await request('');setDocuments(result.documents);setConfigured(result.configured);}
  useEffect(()=>{let active=true;async function refresh(){try{const result=await request('');if(active){setError('');setDocuments(result.documents);setConfigured(result.configured);const ids=result.documents.map((item:Document)=>item.id).join(',');if(ids!==knownFiles.current){knownFiles.current=ids;onFilesChanged?.();}}}catch(reason){if(active)setError((reason as Error).message);}}void refresh();const timer=setInterval(()=>void refresh(),3000);return()=>{active=false;clearInterval(timer);};},[onFilesChanged]);
  async function run(action:()=>Promise<void>) {setBusy(true);setError('');setMessage('');try{await action();await load();}catch(reason){setError((reason as Error).message);}finally{setBusy(false);}}
  async function upload(files:FileList|null) {
    if(!files)return;const selected=Array.from(files);if(input.current)input.current.value='';
    await run(async()=>{let duplicates=0;for(const file of selected){const body=new FormData();body.append('file',file);const result=await request('/documents',{method:'POST',body});if(result.duplicate)duplicates++;}setMessage(`已收到 ${selected.length} 个文件${duplicates ? `，${duplicates} 个已有记录` : ''}`);});
  }
  return <section className="knowledge-panel">
    <div className="knowledge-heading"><div><h2>知识库</h2><p>加入的资料可在任意会话中检索。聊天中上传的文档也会自动加入。</p></div><div className="schedule-actions"><input ref={input} hidden type="file" multiple accept=".pdf,.docx,.xlsx,.pptx,.txt,.md" onChange={event=>void upload(event.target.files)}/><button className="page-action" disabled={busy} onClick={()=>input.current?.click()}><Upload size={15}/>加入文件</button>{selectedPath && <button className="page-action" disabled={busy} onClick={()=>void run(async()=>{const result=await request('/import',json({path:selectedPath}));setMessage(result.duplicate ? '该文件已在知识库中' : '已加入知识库');})}>加入所选资料</button>}<button className="page-action" aria-label="刷新知识库" disabled={busy} onClick={()=>void run(load)}><RefreshCw size={15}/></button></div></div>
    {!configured && <p className="knowledge-hint">请在左侧“设置”中填写“阿里云百炼 API Key”。文件可以先上传，配置保存后自动开始索引。</p>}
    {error && <p role="alert" className="error-text">{error}</p>}{message && <p className="success-text" role="status">{message}</p>}
    <div className="knowledge-documents">{documents.length ? documents.map(document=><div className="knowledge-document" key={document.id}><FileText size={17}/><div><strong>{document.name}</strong><small>{labels[document.state] ?? document.state}{document.chunkCount>0 ? ` · ${document.chunkCount} 个片段` : ''}{document.error ? ` · ${document.error}` : ''}</small></div>{['failed','outdated','needs_ocr'].includes(document.state) && <button disabled={busy} onClick={()=>void run(async()=>{await request(`/documents/${document.id}/retry`,json({}));})}>重试</button>}<button disabled={busy || document.state==='processing'} onClick={()=>{if(window.confirm(`从知识库移除《${document.name}》？知识库中的文件副本和索引会被删除，原聊天附件保留。`))void run(async()=>{await request(`/documents/${document.id}`,{method:'DELETE'});});}}>移除</button></div>) : <p className="knowledge-empty">还没有资料，先加入一份有文字的 PDF 或 Office 文档。</p>}</div>
    <form className="knowledge-search" onSubmit={event=>{event.preventDefault();void run(async()=>{const result=await request('/search',json({query}));setMatches(result.matches);setMessage(result.summary);});}}><input aria-label="检索知识库" placeholder="输入问题，查看相关原文" value={query} onChange={event=>setQuery(event.target.value)}/><button className="page-action" disabled={busy || !configured || !query.trim()}>检索</button></form>
    {matches.map(match=><details className="knowledge-match" key={match.id} open><summary>{match.name} · {match.page ? `第 ${match.page} 页` : `片段 ${match.ordinal+1}`}</summary><p>{match.text}</p></details>)}
  </section>;
}

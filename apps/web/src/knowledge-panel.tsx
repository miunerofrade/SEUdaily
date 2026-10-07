import { useState, type FormEvent } from 'react';

type Match = {id:string;name:string;page:number;ordinal:number;text:string};

export function KnowledgePanel() {
  const [query,setQuery]=useState('');
  const [matches,setMatches]=useState<Match[]>([]);
  const [message,setMessage]=useState('');
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);

  async function search(event:FormEvent) {
    event.preventDefault();
    if(busy || !query.trim())return;
    setBusy(true);setError('');setMessage('');setMatches([]);
    try {
      const response=await fetch('/app/knowledge/search',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:query.trim()})});
      const result=await response.json();
      if(!response.ok)throw new Error(result.error || '资料搜索失败');
      setMatches(result.matches);setMessage(result.summary);
    } catch(reason) {setError((reason as Error).message);}
    finally {setBusy(false);}
  }

  return <section className="knowledge-panel" aria-label="搜索资料">
    <form className="knowledge-search" onSubmit={event=>void search(event)}>
      <input aria-label="搜索资料" placeholder="输入问题，搜索已上传的资料" value={query} onChange={event=>setQuery(event.target.value)}/>
      <button className="page-action" disabled={busy || !query.trim()}>{busy ? '搜索中…' : '搜索'}</button>
    </form>
    {error && <p role="alert" className="error-text">{error}</p>}
    {message && <p role="status">{message}</p>}
    {matches.map(match=><details className="knowledge-match" key={match.id} open><summary>{match.name} · {match.page ? `第 ${match.page} 页` : `片段 ${match.ordinal+1}`}</summary><p>{match.text}</p></details>)}
  </section>;
}

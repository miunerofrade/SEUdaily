import {useEffect,useRef,useState,type Dispatch,type SetStateAction} from 'react';
import type {Conversation,DocumentAttachment,ImageAttachment} from './types';

type Draft = {text:string;images:ImageAttachment[];documents:DocumentAttachment[];skill:string|null};
type SavedDraft = Draft & {id:string;conversation:Conversation};
const empty = ():Draft=>({text:'',images:[],documents:[],skill:null});
const hasContent = (draft:Draft)=>Boolean(draft.text || draft.images.length || draft.documents.length || draft.skill);
export const ACTIVE_CONVERSATION_KEY='seudaily.web.active-conversation.v1';

/** Keep unfinished input separate from the bounded, replaceable conversation cache. */
export function useComposerDrafts(conversations:Conversation[],activeId:string,restore:(items:Conversation[])=>void) {
  const [records,setRecords]=useState<Record<string,SavedDraft>>({});
  const recordsRef=useRef(records);
  const conversationsRef=useRef(conversations);conversationsRef.current=conversations;
  const [ready,setReady]=useState(false);
  const [error,setError]=useState('');
  const database=useRef<IDBDatabase|null>(null);
  const deleted=useRef(new Set<string>());
  const restoreRef=useRef(restore);restoreRef.current=restore;
  useEffect(()=>{
    let disposed=false;
    let request:IDBOpenDBRequest;
    try { request=indexedDB.open('seudaily.web.drafts',1); }
    catch { setError('无法保存草稿：浏览器本地存储不可用。');setReady(true);return; }
    request.onupgradeneeded=()=>request.result.createObjectStore('drafts',{keyPath:'id'});
    request.onerror=()=>{if(!disposed){setError('无法保存草稿：浏览器本地存储不可用。');setReady(true);}};
    request.onsuccess=()=>{
      const db=request.result;
      if(disposed){db.close();return;}
      database.current=db;
      const read=db.transaction('drafts').objectStore('drafts').getAll();
      read.onsuccess=()=>{
        if(disposed)return;
        const saved=(read.result as SavedDraft[]).filter(item=>item.id && item.conversation?.id===item.id && typeof item.text==='string' && Array.isArray(item.images) && Array.isArray(item.documents) && hasContent(item));
        const loaded=Object.fromEntries(saved.map(item=>[item.id,item]));
        recordsRef.current=loaded;setRecords(loaded);
        restoreRef.current(saved.map(item=>item.conversation));setReady(true);
      };
      read.onerror=()=>{if(!disposed){setError('读取草稿失败，请检查浏览器本地存储。');setReady(true);}};
    };
    return()=>{disposed=true;database.current?.close();database.current=null;};
  },[]);
  function save(id:string,record?:SavedDraft) {
    const db=database.current;
    if(!db)return;
    try {
      const tx=db.transaction('drafts','readwrite');
      const store=tx.objectStore('drafts');
      if(record && hasContent(record))store.put({...record,
        // Uploaded images already have durable backend paths; avoid duplicating base64 data.
        images:record.images.map(image=>image.path ? {...image,dataUrl:undefined} : image),
      });else store.delete(id);
      tx.oncomplete=()=>setError('');
      tx.onabort=()=>setError('草稿保存失败：浏览器存储空间不足或不可用。');
      tx.onerror=()=>setError('草稿保存失败：浏览器存储空间不足或不可用。');
    }catch{setError('草稿保存失败：浏览器本地存储不可用。');}
  }
  function update<K extends keyof Draft>(id:string,key:K,value:SetStateAction<Draft[K]>) {
    if(deleted.current.has(id))return;
    const conversation=conversationsRef.current.find(item=>item.id===id);
    if(!conversation)return;
    const old=recordsRef.current[id] ?? {...empty(),id,conversation:{...conversation,messages:[]}};
    const next={...old,[key]:typeof value==='function' ? (value as (previous:Draft[K])=>Draft[K])(old[key]) : value,
      conversation:{...conversation,messages:[]}};
    const all={...recordsRef.current,[id]:next};
    recordsRef.current=all;setRecords(all);save(id,next);
  }
  function remove(id:string) {
    deleted.current.add(id);
    const all={...recordsRef.current};delete all[id];recordsRef.current=all;setRecords(all);save(id);
  }
  const current=records[activeId] ?? empty();
  // Setters capture their conversation: a late upload/queue response cannot alter another draft.
  const setter=<K extends keyof Draft>(key:K):Dispatch<SetStateAction<Draft[K]>>=>value=>update(activeId,key,value);
  return {draft:current.text,setDraft:setter('text'),pendingImages:current.images,setPendingImages:setter('images'),pendingDocuments:current.documents,setPendingDocuments:setter('documents'),selectedSkill:current.skill,setSelectedSkill:setter('skill'),ready,error,remove,hasDraft:(id:string)=>Boolean(records[id] && hasContent(records[id]))};
}

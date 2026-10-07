import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,unlink} from 'node:fs/promises';
import {extname,join} from 'node:path';
import {runtimeRoot} from '../runtime/runtime-paths.js';
import {knowledge} from '../runtime/knowledge/index.js';
import {knowledgeExtensions} from '../runtime/knowledge/service.js';
import {storeDocumentContext,resolveDocumentContexts} from '../runtime/document-context.js';
import type {WeChatFileReceiver} from './runtime.js';
export const receiveWeChatFile:WeChatFileReceiver=async(name,bytes,source)=>{
  const h=createHash('sha256').update(source).digest('hex');
  const ref=`${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;
  const rawExtension=extname(name).toLowerCase();
  const extension=/^\.[a-z0-9]{1,12}$/.test(rawExtension) ? rawExtension : '.bin';
  const root=join(runtimeRoot,'uploads','documents');await mkdir(root,{recursive:true,mode:0o700});
  const path=join(root,ref+extension);
  const existing=await readFile(path).catch(error=>{if(error.code!=='ENOENT')throw error;return null;});
  if(existing){if(!existing.equals(bytes))throw new Error('已有上传记录内容不符');}
  else {const temporary=path+'.'+randomUUID()+'.tmp';try{await writeFile(temporary,bytes,{flag:'wx',mode:0o600});await rename(temporary,path);}finally{await unlink(temporary).catch(()=>{});}}
  if(!resolveDocumentContexts([ref]).length)storeDocumentContext(ref,name,'');
  let state='unsupported';
  if(knowledgeExtensions.has(extension)) {
    try {state=(await knowledge.enqueue(name,bytes,undefined,path)).state;}
    catch {state='failed';}
  }
  return {name,path,state};
};

/** Explicit attachment mode also supplies parsed text to this one chat turn. */
export async function prepareWeChatFiles(files:import('./runtime.js').ReceivedWeChatFile[],signal:AbortSignal) {
  const {realpath}=await import('node:fs/promises');
  const {basename,relative,isAbsolute}=await import('node:path');
  const {updateDocumentContext}=await import('../runtime/document-context.js');
  const {runPythonTool,releasePythonTask}=await import('../runtime/tools/python-bridge.js');
  if(files.length>10)throw new Error('本轮聊天附件最多 10 个');
  const root=await realpath(join(runtimeRoot,'uploads','documents'));
  const refs:string[]=[];
  for(const file of files) {
    signal.throwIfAborted();
    const path=await realpath(file.path),child=relative(root,path);
    if(!child || child.startsWith('..') || isAbsolute(child))throw new Error('附件路径不在上传目录');
    const extension=extname(path).toLowerCase();
    if(!knowledgeExtensions.has(extension))throw new Error(`《${file.name}》已保存，但该格式无法作为聊天附件解析`);
    const bytes=await readFile(path),hash=createHash('sha256').update(bytes).digest('hex');
    const cached=await readFile(join(runtimeRoot,'knowledge',hash+'.text.json'),'utf8').then(value=>JSON.parse(value)).catch(()=>null);
    let markdown:string;
    if(cached?.hash===hash && typeof cached.text==='string')markdown=cached.text;
    else if(['.txt','.md'].includes(extension))markdown=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    else {
      const parseSignal=AbortSignal.any([signal,AbortSignal.timeout(120000)]);
      try {
        const result=await runPythonTool<any>('parse-document',{path,filename:file.name},parseSignal);
        const data=result.resultRef ? JSON.parse(await readFile(result.resultRef,'utf8')).data : result.data;
        if(result.status!=='completed' || typeof data?.markdown!=='string')throw new Error(`《${file.name}》解析未完成`);
        markdown=data.markdown;
      }finally {await releasePythonTask(parseSignal);}
    }
    if(!markdown.trim())throw new Error(`《${file.name}》没有可读取的正文，目前不支持 OCR`);
    const ref=basename(path,extension);updateDocumentContext(ref,file.name,markdown);refs.push(ref);
  }
  signal.throwIfAborted();return refs;
}

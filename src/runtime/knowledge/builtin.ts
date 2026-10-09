import {createHash} from 'node:crypto';
import {readFile,realpath} from 'node:fs/promises';
import {resolve,relative,isAbsolute,basename,extname} from 'node:path';
import type {KnowledgeService} from './service.js';

/** Register package originals; indexing remains the ordinary recoverable background job. */
export async function registerBundledKnowledge(service:KnowledgeService,directory:string) {
  const root=await realpath(directory);
  const manifest=JSON.parse(await readFile(resolve(root,'manifest.json'),'utf8'));
  if(!Array.isArray(manifest.documents))throw new Error('内置参考资料清单无效');
  const ids=new Set<string>();
  const documents=[];
  // Validate the whole package before registering anything. Never trust paths from a document.
  for(const item of manifest.documents) {
    if(typeof item.id!=='string' || !/^[a-z0-9][a-z0-9-]*$/.test(item.id) || ids.has(item.id)
       || typeof item.file!=='string' || (isAbsolute(item.file) || item.file.split(/[\\/]/).some((part:string)=>!part || part==='.' || part==='..')) || extname(item.file)!=='.md'
       || typeof item.sha256!=='string' || !/^[a-f0-9]{64}$/.test(item.sha256))throw new Error('内置参考资料条目无效');
    ids.add(item.id);
    const path=await realpath(resolve(root,item.file)),child=relative(root,path);
    if(!child || child==='..' || child.startsWith('../') || child.startsWith('..\\') || isAbsolute(child))throw new Error('内置参考资料路径越界');
    const bytes=await readFile(path);
    if(createHash('sha256').update(bytes).digest('hex')!==item.sha256)throw new Error('内置参考资料内容校验失败');
    documents.push({id:item.id,name:basename(item.file),group:relative(root,resolve(root,item.file)).split(/[\\/]/).slice(0,-1).join(" / ") || basename(item.file,".md"),bytes});
  }
  for(const document of documents)await service.enqueueBuiltin(document.id,document.name,document.bytes,document.group);
  await service.retireBuiltinSources(ids);
  return documents.length;
}

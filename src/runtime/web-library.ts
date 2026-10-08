import {randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {readFile, readdir, realpath, mkdir, writeFile, rename, unlink, lstat, copyFile} from 'node:fs/promises';
import {resolve, basename, dirname} from 'node:path';
import noticeSources from '../seudaily/notice_categories.json' with {type:'json'};

import {within,sha256,webFilesLayout,webMetadataPath,validSourceId,validNoticeId,validSectionId,webFilesProtocol} from './web-file-store.js';

type Source = {id:string; name:string};
type Notice = {id:string;title:string;url:string};
type Entry = {legacyPaths:string[];notice:Notice;name:string; sources:string[]; sections:{source:string;label:string}[]};
function sourceIdentity(item: any): Source {
  if(item.source && typeof item.source.id==='string' && validSourceId(item.source.id)
      && typeof item.source.name==='string' && item.source.name.trim())return {
        id:item.source.id,name:Object.values(noticeSources).find(source=>source.host===item.source.id)?.name || item.source.name,
      };
  for(const value of [item.sourceUrl,item.url]) {
    try {
      const url=new URL(value);
      if(!['http:','https:'].includes(url.protocol) || !url.hostname)continue;
      const host=url.hostname;
      return {id:validSourceId(host)?host:sha256(host),
        name:Object.values(noticeSources).find(source=>source.host===host)?.name || host};
    } catch { /* Older records may have no URL. */ }
  }
  return {...webFilesProtocol.fallbackSource};
}

async function atomicMetadata(path:string,item:unknown) {
  const temporary=path+'.'+randomUUID();
  try {
    await writeFile(temporary,JSON.stringify(item),{flag:'wx',mode:0o600});
    await rename(temporary,path);
  } finally {await unlink(temporary).catch(()=>undefined);}
}

/** Keep the flat layout readable while migrating local originals, without network requests. */
async function loadEntries(project:string): Promise<Map<string,Entry>> {
  const canonical=await realpath(project);
  const {root,files,metadata}=webFilesLayout(resolve(project,'.seudaily'));
  for(const directory of [root,files,metadata]) {
    await mkdir(directory,{recursive:true,mode:0o700});
    if(!within(canonical,await realpath(directory)))throw new Error('网页资料目录越界');
  }
  async function sourceDirectory(source:Source,sectionId?:string,noticeId?:string) {
    const directory=resolve(files,source.id,...(sectionId && noticeId ? [sectionId,noticeId] : []));
    await mkdir(directory,{recursive:true,mode:0o700});
    if(!within(await realpath(files),await realpath(directory)))throw new Error('网页来源目录越界');
    return directory;
  }
  const obsoleteBodies=new Map<string,string>();
  const articleNotices=new Map<string,{notice:Notice;sectionId:string}>();
  const articleSections=new Map<string,{source:string;label:string}>();
  for(const site of ['jwc','cse']) {
    const directory=resolve(project,'.seudaily',site,'articles');
    const canonicalDirectory=await realpath(directory).catch(()=>null);
    if(!canonicalDirectory || !within(canonical,canonicalDirectory))continue;
    for(const entry of await readdir(directory,{withFileTypes:true})) {
      if(!entry.isFile() || !entry.name.endsWith('.json'))continue;
      try {
        const article=JSON.parse(await readFile(resolve(directory,entry.name),'utf8'));
        if(typeof article.url!=='string')continue;
        const section={source:sourceIdentity({url:article.url}).name,label:String(article.categoryLabel || (noticeSources as any)[site]?.categories?.[article.category]?.[0] || '其他资料')};
        const notice={id:validNoticeId(article.id) ? article.id : sha256(article.url),title:String(article.title || '网页资料'),url:article.url};
        const sectionId=validSectionId(article.category) ? article.category : webFilesProtocol.fallbackSection;
        articleNotices.set(article.url,{notice,sectionId});
        for(const attachment of article.attachments || [])if(typeof attachment.url==='string')articleNotices.set(attachment.url,{notice,sectionId});
        articleSections.set(article.url,section);
        for(const attachment of article.attachments || [])if(typeof attachment.url==='string')articleSections.set(attachment.url,section);
        if(!String(article.content || '').trim() && !article.attachments?.length)continue;
        const title=String(article.title || '通知正文');
        const links=(article.attachments || []).filter((item:any)=>/\.pdf(?:$|[?#])/i.test(item.url || '')).map((item:any)=>`- [${item.name}](${item.url})`).join('\n');
        const bytes=Buffer.from('# '+title+'\n\n来源：'+article.url+'\n\n'+String(article.content || '')+(links?'\n\n## 附件\n\n'+links:''));
        const digest=sha256(bytes);
        const record=webMetadataPath(resolve(project,'.seudaily'),article.url);
        // Preserve deletion intent: a record with a missing original is not recreated.
        const old=await readFile(record,'utf8').then(JSON.parse).catch(()=>null);
        if(old && !(await lstat(old.path).catch(()=>null)))continue;
        if(old?.sha256===digest)continue;
        const source=sourceIdentity({url:article.url});
        const path=resolve(await sourceDirectory(source,sectionId,notice.id),digest+'.md');
        try {await writeFile(path,bytes,{flag:'wx',mode:0o600});} catch(error:any){if(error.code!=='EEXIST')throw error;}
        await atomicMetadata(record,{url:article.url,name:title+'.md',path,sha256:digest,sizeBytes:bytes.length,sourceUrl:article.url,source,notice,sectionId});
        if(old && old.path!==path && typeof old.path==='string' && within(files,resolve(old.path)))obsoleteBodies.set(old.path,old.sha256);
      } catch { /* A damaged older cache must not hide the other library files. */ }
    }
  }
  const entries=new Map<string,Entry>();
  const originals=new Map<string,string>(),remaining=new Set<string>();
  let brokenMetadata=false;
  for(const entry of (await readdir(metadata,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
    if(!entry.isFile() || !entry.name.endsWith('.json'))continue;
    const record=resolve(metadata,entry.name);
    let oldPath:string|undefined;
    try {
      const item=JSON.parse(await readFile(record,'utf8'));
      if(typeof item.path!=='string' || typeof item.name!=='string' || !within(files,resolve(item.path))) {
        brokenMetadata=true;continue;
      }
      oldPath=resolve(item.path);
      const source=sourceIdentity(item);
      const section=articleSections.get(item.url) || articleSections.get(item.sourceUrl) || item.noticeSection || {source:source.name,label:'其他资料'};
      const context=articleNotices.get(item.url) || articleNotices.get(item.sourceUrl);
      const notice=context?.notice || item.notice || {id:sha256(item.sourceUrl || item.url || oldPath),title:item.name.replace(/\.[^.]+$/,''),url:item.sourceUrl || item.url || ''};
      if(!validNoticeId(notice.id))throw new Error('通知目录标识无效');
      const sectionId=context?.sectionId || (validSectionId(item.sectionId) ? item.sectionId : webFilesProtocol.fallbackSection);
      let path=oldPath;
      const details=await lstat(oldPath).catch(()=>null);
      const destination=resolve(await sourceDirectory(source,sectionId,notice.id),basename(oldPath));
      if(details?.isFile() && destination!==oldPath) {
        const bytes=await readFile(oldPath),digest=sha256(bytes);
        if(typeof item.sha256==='string' && digest!==item.sha256)throw new Error('网页原文件校验失败');
        if(destination!==oldPath) {
          originals.set(oldPath,digest);
          try {await copyFile(oldPath,destination,constants.COPYFILE_EXCL);}catch(error:any){if(error.code!=='EEXIST')throw error;}
          if(!(await lstat(destination)).isFile() || sha256(await readFile(destination))!==digest)throw new Error('网页迁移目标文件冲突');
          path=destination;
        }
      }
      const legacyPaths=[...new Set([...(Array.isArray(item.legacyPaths)?item.legacyPaths:[]),...(path!==oldPath?[oldPath]:[])])].filter(value=>typeof value==='string' && within(files,resolve(value)));
      const updated={...item,path,source,noticeSection:section,notice,sectionId,legacyPaths};
      if(JSON.stringify(updated)!==JSON.stringify(item))await atomicMetadata(record,updated);
      if(path===oldPath)remaining.add(path);
      const previous=entries.get(path);
      entries.set(path,{legacyPaths:[...new Set([...(previous?.legacyPaths || []),...legacyPaths])],notice,name:previous?.name || item.name,sources:[...new Set([...(previous?.sources || []),source.name])].sort(),sections:[...(previous?.sections || []).filter(value=>value.source!==section.source || value.label!==section.label),section]});
    } catch {
      if(oldPath)remaining.add(oldPath);
      brokenMetadata=true;
    }
  }
  if(!brokenMetadata)for(const [path,digest] of originals)if(!entries.has(path) && !remaining.has(path) && sha256(await readFile(path))===digest)await unlink(path);
  // Keep flat originals if damaged records prevent us from proving all references moved.
  if(!brokenMetadata)for(const entry of await readdir(files,{withFileTypes:true})) {
    if(!entry.isFile() || remaining.has(resolve(files,entry.name)))continue;
    const oldPath=resolve(files,entry.name);
    if(originals.has(oldPath)) {
      if(sha256(await readFile(oldPath))===originals.get(oldPath))await unlink(oldPath);
      continue;
    }
    const path=resolve(await sourceDirectory({id:'unclassified',name:'未分类'}),entry.name);
    try {await copyFile(oldPath,path,constants.COPYFILE_EXCL);} catch(error:any){if(error.code!=='EEXIST')throw error;}
    if(!(await lstat(path)).isFile())continue;
    if(!Buffer.from(await readFile(oldPath)).equals(await readFile(path)))continue;
    await unlink(oldPath);
  }
  if(!brokenMetadata)for(const [path,digest] of obsoleteBodies)if(!entries.has(path) && sha256(await readFile(path))===digest)await unlink(path);
  return entries;
}

const loading=new Map<string,Promise<Map<string,Entry>>>();
export async function webLibraryEntries(project: string): Promise<Map<string,Entry>> {
  const key=resolve(project);
  const existing=loading.get(key);
  if(existing)return existing;
  const promise=loadEntries(key);
  loading.set(key,promise);
  try {return await promise;} finally {loading.delete(key);}
}

export async function webLibraryNames(project: string): Promise<Map<string,string>> {
  return new Map([...await webLibraryEntries(project)].map(([path,item])=>[path,item.name]));
}

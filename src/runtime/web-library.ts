import {createHash, randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {readFile, readdir, realpath, mkdir, writeFile, rename, unlink, lstat, copyFile} from 'node:fs/promises';
import {resolve, relative, isAbsolute, basename, dirname} from 'node:path';
import noticeSources from '../seudaily/notice_categories.json' with {type:'json'};

function within(root: string, path: string) {
  const child=relative(root,path);
  return Boolean(child) && child!=='..' && !child.startsWith('../') && !child.startsWith('..\\') && !isAbsolute(child);
}

type Source = {id:string; name:string};
type Entry = {name:string; sources:string[]; sections:{source:string;label:string}[]};
function sourceIdentity(item: any): Source {
  if(item.source && typeof item.source.id==='string' && /^[a-z0-9][a-z0-9.-]*$/.test(item.source.id)
      && typeof item.source.name==='string' && item.source.name.trim())return {
        id:item.source.id,name:Object.values(noticeSources).find(source=>source.host===item.source.id)?.name || item.source.name,
      };
  for(const value of [item.sourceUrl,item.url]) {
    try {
      const url=new URL(value);
      if(!['http:','https:'].includes(url.protocol) || !url.hostname)continue;
      const host=url.hostname;
      return {id:/^[a-z0-9][a-z0-9.-]*$/.test(host)?host:createHash('sha256').update(host).digest('hex'),
        name:Object.values(noticeSources).find(source=>source.host===host)?.name || host};
    } catch { /* Older records may have no URL. */ }
  }
  return {id:'unclassified',name:'未分类'};
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
  const root=resolve(project,'.seudaily','web-files');
  const files=resolve(root,'files'),metadata=resolve(root,'metadata');
  for(const directory of [root,files,metadata]) {
    await mkdir(directory,{recursive:true,mode:0o700});
    if(!within(canonical,await realpath(directory)))throw new Error('网页资料目录越界');
  }
  async function sourceDirectory(source:Source) {
    const directory=resolve(files,source.id);
    await mkdir(directory,{recursive:true,mode:0o700});
    if(!within(await realpath(files),await realpath(directory)))throw new Error('网页来源目录越界');
    return directory;
  }
  const obsoleteBodies=new Map<string,string>();
  const articleSections=new Map<string,{source:string;label:string}>();
  for(const site of ['jwc','cse']) {
    const directory=resolve(project,'.seudaily',site,'articles');
    const canonicalDirectory=await realpath(directory).catch(()=>null);
    if(!canonicalDirectory || !within(canonical,canonicalDirectory))continue;
    for(const entry of await readdir(directory,{withFileTypes:true})) {
      if(!entry.isFile() || !entry.name.endsWith('.json'))continue;
      try {
        const article=JSON.parse(await readFile(resolve(directory,entry.name),'utf8'));
        if(typeof article.url!=='string' || (!String(article.content || '').trim() && !article.attachments?.length))continue;
        const section={source:sourceIdentity({url:article.url}).name,label:String(article.categoryLabel || (noticeSources as any)[site]?.categories?.[article.category]?.[0] || '其他资料')};
        articleSections.set(article.url,section);
        for(const attachment of article.attachments || [])if(typeof attachment.url==='string')articleSections.set(attachment.url,section);
        const title=String(article.title || '通知正文');
        const links=(article.attachments || []).filter((item:any)=>/\.pdf(?:$|[?#])/i.test(item.url || '')).map((item:any)=>`- [${item.name}](${item.url})`).join('\n');
        const bytes=Buffer.from('# '+title+'\n\n来源：'+article.url+'\n\n'+String(article.content || '')+(links?'\n\n## 附件\n\n'+links:''));
        const digest=createHash('sha256').update(bytes).digest('hex');
        const record=resolve(metadata,createHash('sha256').update(article.url).digest('hex')+'.json');
        // Preserve deletion intent: a record with a missing original is not recreated.
        const old=await readFile(record,'utf8').then(JSON.parse).catch(()=>null);
        if(old && !(await lstat(old.path).catch(()=>null)))continue;
        if(old?.sha256===digest)continue;
        const source=sourceIdentity({url:article.url});
        const path=resolve(await sourceDirectory(source),digest+'.md');
        try {await writeFile(path,bytes,{flag:'wx',mode:0o600});} catch(error:any){if(error.code!=='EEXIST')throw error;}
        await atomicMetadata(record,{url:article.url,name:title+'.md',path,sha256:digest,sizeBytes:bytes.length,sourceUrl:article.url,source});
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
      let path=oldPath;
      if(dirname(oldPath)===files) {
        const details=await lstat(oldPath).catch(()=>null);
        if(details?.isFile()) {
          const bytes=await readFile(oldPath);
          const digest=createHash('sha256').update(bytes).digest('hex');
          originals.set(oldPath,digest);
          if(typeof item.sha256==='string' && digest!==item.sha256)throw new Error('网页原文件校验失败');
          path=resolve(await sourceDirectory(source),basename(oldPath));
          try {await copyFile(oldPath,path,constants.COPYFILE_EXCL);} catch(error:any){if(error.code!=='EEXIST')throw error;}
          if(!(await lstat(path)).isFile())throw new Error('网页迁移目标不是普通文件');
          if(createHash('sha256').update(await readFile(path)).digest('hex')!==digest)throw new Error('网页迁移目标文件冲突');
          // Publish the new pointer before removing any original; retry is safe after interruption.
          await atomicMetadata(record,{...item,path,source});
        }
      } else if(item.source?.id!==source.id || item.source?.name!==source.name)await atomicMetadata(record,{...item,source});
      if(path===oldPath && dirname(path)===files)remaining.add(path);
      const previous=entries.get(path);
      const section=articleSections.get(item.url) || articleSections.get(item.sourceUrl) || item.noticeSection || {source:source.name,label:'其他资料'};
      if(JSON.stringify(item.noticeSection)!==JSON.stringify(section))await atomicMetadata(record,{...item,path,source,noticeSection:section});
      entries.set(path,{name:previous?.name || item.name,sources:[...new Set([...(previous?.sources || []),source.name])].sort(),sections:[...(previous?.sections || []).filter(value=>value.source!==section.source || value.label!==section.label),section]});
    } catch {
      if(oldPath)remaining.add(oldPath);
      brokenMetadata=true;
    }
  }
  // Keep flat originals if damaged records prevent us from proving all references moved.
  if(!brokenMetadata)for(const entry of await readdir(files,{withFileTypes:true})) {
    if(!entry.isFile() || remaining.has(resolve(files,entry.name)))continue;
    const oldPath=resolve(files,entry.name);
    if(originals.has(oldPath)) {
      if(createHash('sha256').update(await readFile(oldPath)).digest('hex')===originals.get(oldPath))await unlink(oldPath);
      continue;
    }
    const path=resolve(await sourceDirectory({id:'unclassified',name:'未分类'}),entry.name);
    try {await copyFile(oldPath,path,constants.COPYFILE_EXCL);} catch(error:any){if(error.code!=='EEXIST')throw error;}
    if(!(await lstat(path)).isFile())continue;
    if(!Buffer.from(await readFile(oldPath)).equals(await readFile(path)))continue;
    await unlink(oldPath);
  }
  if(!brokenMetadata)for(const [path,digest] of obsoleteBodies)if(!entries.has(path) && createHash('sha256').update(await readFile(path)).digest('hex')===digest)await unlink(path);
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

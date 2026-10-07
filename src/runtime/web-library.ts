import {createHash, randomUUID} from 'node:crypto';
import {readFile, readdir, realpath, mkdir, writeFile, rename, unlink, lstat} from 'node:fs/promises';
import {resolve, relative, isAbsolute} from 'node:path';

function within(root: string, path: string) {
  const child=relative(root,path);
  return Boolean(child) && child!=='..' && !child.startsWith('../') && !child.startsWith('..\\') && !isAbsolute(child);
}

/** Expose old cached notice bodies without fetching the campus website again. */
export async function webLibraryNames(project: string): Promise<Map<string,string>> {
  const canonical=await realpath(project);
  const root=resolve(project,'.seudaily','web-files');
  await mkdir(resolve(root,'files'),{recursive:true,mode:0o700});
  await mkdir(resolve(root,'metadata'),{recursive:true,mode:0o700});
  for(const directory of [root,resolve(root,'files'),resolve(root,'metadata')]) {
    if(!within(canonical,await realpath(directory)))throw new Error('网页资料目录越界');
  }
  for(const site of ['jwc','cse']) {
    const directory=resolve(project,'.seudaily',site,'articles');
    const canonicalDirectory=await realpath(directory).catch(()=>null);
    if(!canonicalDirectory || !within(canonical,canonicalDirectory))continue;
    for(const entry of await readdir(directory,{withFileTypes:true})) {
      if(!entry.isFile() || !entry.name.endsWith('.json'))continue;
      try {
        const article=JSON.parse(await readFile(resolve(directory,entry.name),'utf8'));
        if(typeof article.content!=='string' || !article.content.trim() || typeof article.url!=='string')continue;
        const title=String(article.title || '通知正文');
        const bytes=Buffer.from('# '+title+'\n\n来源：'+article.url+'\n\n'+article.content);
        const digest=createHash('sha256').update(bytes).digest('hex');
        const path=resolve(root,'files',digest+'.md');
        const metadata=resolve(root,'metadata',createHash('sha256').update(article.url).digest('hex')+'.json');
        // Do not continually recreate documents that the user deleted in the library.
        if(await lstat(metadata).catch(()=>null))continue;
        try {await writeFile(path,bytes,{flag:'wx',mode:0o600});} catch(error:any){if(error.code!=='EEXIST')throw error;}
        const temporary=metadata+'.'+randomUUID();
        try {
          await writeFile(temporary,JSON.stringify({url:article.url,name:title+'.md',path,sha256:digest,sizeBytes:bytes.length,sourceUrl:article.url}),{flag:'wx',mode:0o600});
          await rename(temporary,metadata);
        } finally {await unlink(temporary).catch(()=>undefined);}
      } catch { /* A damaged older cache must not hide the other library files. */ }
    }
  }
  const names=new Map<string,string>();
  for(const entry of await readdir(resolve(root,'metadata'),{withFileTypes:true})) {
    if(!entry.isFile() || !entry.name.endsWith('.json'))continue;
    try {
      const item=JSON.parse(await readFile(resolve(root,'metadata',entry.name),'utf8'));
      if(typeof item.path==='string' && typeof item.name==='string' && within(resolve(root,'files'),resolve(item.path)))names.set(resolve(item.path),item.name);
    } catch { /* Ignore incomplete metadata. */ }
  }
  return names;
}

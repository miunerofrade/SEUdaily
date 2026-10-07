import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {webLibraryNames} from '../src/runtime/web-library.ts';

test('old notice bodies appear as readable originals without recreating deleted files',async t=>{
 const root=await mkdtemp(join(tmpdir(),'seudaily-web-library-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const articles=join(root,'.seudaily/jwc/articles');await mkdir(articles,{recursive:true});
 await writeFile(join(articles,'notice.json'),JSON.stringify({title:'实践教学通知',url:'https://jwc.seu.edu.cn/notice',content:'报名截止星期五。'}));
 await writeFile(join(articles,'broken.json'),'{');
 const names=await webLibraryNames(root);
 assert.equal(names.size,1);
 const [path,name]=[...names][0];assert.equal(name,'实践教学通知.md');
 assert.match(await readFile(path,'utf8'),/来源：https:\/\/jwc.seu.edu.cn\/notice\n\n报名截止星期五/);
 await unlink(path);await webLibraryNames(root);
 await assert.rejects(readFile(path),{code:'ENOENT'});
});

import {createHash} from 'node:crypto';
import {webLibraryEntries} from '../src/runtime/web-library.ts';

async function legacyFile(root, urls, content='原文件正文') {
 const files=join(root,'.seudaily/web-files/files'),meta=join(root,'.seudaily/web-files/metadata');
 await mkdir(files,{recursive:true});await mkdir(meta,{recursive:true});
 const digest=createHash('sha256').update(content).digest('hex'),path=join(files,digest+'.md');
 await writeFile(path,content);
 const records=[];
 for(const [index,url,sourceUrl] of urls.map((item,index)=>[index,...item])) {
  const record=join(meta,index+'.json');
  await writeFile(record,JSON.stringify({path,name:'通知.md',url,sourceUrl,sha256:digest,markdown:'已解析正文',parsed:true}));records.push(record);
 }
 return {path,records,digest};
}

test('legacy shared originals migrate by source with intact metadata and repeat safely',async t=>{
 const root=await mkdtemp(join(tmpdir(),'seudaily-source-migration-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const {path,records,digest}=await legacyFile(root,[['https://cdn.example/a','https://jwc.seu.edu.cn/notice'],['https://cse.seu.edu.cn/b']]);
 const entries=await webLibraryEntries(root);assert.equal(entries.size,2);
 for(const [index,host,label] of [[0,'jwc.seu.edu.cn','教务处'],[1,'cse.seu.edu.cn','计软智学院']]) {
  const record=JSON.parse(await readFile(records[index],'utf8'));
  assert.equal(record.path,join(root,'.seudaily/web-files/files',host,digest+'.md'));
  assert.deepEqual(record.source,{id:host,name:label});assert.equal(record.markdown,'已解析正文');
  assert.equal(await readFile(record.path,'utf8'),'原文件正文');assert.deepEqual(entries.get(record.path).sources,[label]);
 }
 await assert.rejects(readFile(path),{code:'ENOENT'});
 assert.deepEqual(await webLibraryEntries(root),entries);
});

test('migration preserves conflicting destination and original for recovery',async t=>{
 const root=await mkdtemp(join(tmpdir(),'seudaily-source-conflict-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const {path,records,digest}=await legacyFile(root,[['https://jwc.seu.edu.cn/notice']]);
 const directory=join(root,'.seudaily/web-files/files/jwc.seu.edu.cn');await mkdir(directory);
 const target=join(directory,digest+'.md');await writeFile(target,'不同内容');
 await webLibraryEntries(root);
 assert.equal(await readFile(path,'utf8'),'原文件正文');assert.equal(await readFile(target,'utf8'),'不同内容');
 assert.equal(JSON.parse(await readFile(records[0],'utf8')).path,path);
});

test('orphan originals move to unclassified without requiring a database',async t=>{
 const root=await mkdtemp(join(tmpdir(),'seudaily-source-orphan-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const files=join(root,'.seudaily/web-files/files');await mkdir(files,{recursive:true});
 await writeFile(join(files,'orphan.txt'),'原文件');await webLibraryEntries(root);
 assert.equal(await readFile(join(files,'unclassified/orphan.txt'),'utf8'),'原文件');
 await assert.rejects(readFile(join(files,'orphan.txt')),{code:'ENOENT'});
});

test('configured Chinese source name replaces a stored raw hostname without moving again',async t=>{
 const root=await mkdtemp(join(tmpdir(),'seudaily-source-name-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const directory=join(root,'.seudaily/web-files/files/news.seu.edu.cn'),metadata=join(root,'.seudaily/web-files/metadata');
 await mkdir(directory,{recursive:true});await mkdir(metadata,{recursive:true});
 const path=join(directory,'news.md'),record=join(metadata,'news.json');await writeFile(path,'新闻网正文');
 await writeFile(record,JSON.stringify({path,name:'学校新闻.md',url:'https://news.seu.edu.cn/notice',source:{id:'news.seu.edu.cn',name:'news.seu.edu.cn'}}));
 const entries=await webLibraryEntries(root);
 assert.deepEqual(entries.get(path).sources,['东大新闻网']);
 const saved=JSON.parse(await readFile(record,'utf8'));assert.equal(saved.path,path);assert.equal(saved.source.name,'东大新闻网');
});


test('PDF-only cached notices keep their known column even when the text body is empty',async t=>{
 const root=await mkdtemp(join(tmpdir(),'seudaily-pdf-column-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const articles=join(root,'.seudaily/jwc/articles');await mkdir(articles,{recursive:true});
 const url='https://jwc.seu.edu.cn/2026/0928/c21681a584569/page.htm';
 await writeFile(join(articles,'notice.json'),JSON.stringify({title:'竞赛通知',url,content:'',category:'practice'}));
 const {records}=await legacyFile(root,[['https://jwc.seu.edu.cn/attachment.pdf',url]],'%PDF-fixture');
 const entries=await webLibraryEntries(root);assert.equal(entries.size,1);
 assert.deepEqual([...entries.values()][0].sections,[{source:'教务处',label:'实践教学'}]);
 assert.deepEqual(JSON.parse(await readFile(records[0],'utf8')).noticeSection,{source:'教务处',label:'实践教学'});
});

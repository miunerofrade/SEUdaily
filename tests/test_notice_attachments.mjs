import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {NoticeAttachments} from '../src/runtime/notice-attachments.ts';
import {webLibraryEntries} from '../src/runtime/web-library.ts';

test('all notice PDFs download, register by original path, retain categories and reuse restart caches',async t=>{
 const project=await mkdtemp(join(tmpdir(),'notice-pdf-'));t.after(()=>rm(project,{recursive:true,force:true}));
 const root=join(project,'.seudaily'),articles=join(root,'jwc','articles'),meta=join(root,'web-files','metadata'),files=join(root,'web-files','files','jwc.seu.edu.cn');
 await Promise.all([articles,meta,files].map(path=>mkdir(path,{recursive:true})));
 const attachments=[{name:'指南.pdf',url:'https://jwc.seu.edu.cn/a.pdf'},{name:'正文.pdf',url:'https://jwc.seu.edu.cn/b.pdf'},{name:'icon.gif',url:'https://jwc.seu.edu.cn/icon.gif'}];
 const article={id:'seu-jwc-1',url:'https://jwc.seu.edu.cn/notice',title:'讲座',content:'指南.pdf',category:'practice',attachments};
 await writeFile(join(articles,'1.json'),JSON.stringify(article));
 let calls=0;const queued=[];
 const python=async(action,payload)=>{calls++;assert.equal(action,'sync-notice-pdf');const attachment=attachments[payload.attachmentNumber-1],bytes=Buffer.from('%PDF-fixture'),digest=createHash('sha256').update(bytes).digest('hex'),path=join(files,digest+'.pdf');await writeFile(path,bytes);await writeFile(join(meta,createHash('sha256').update(attachment.url).digest('hex')+'.json'),JSON.stringify({url:attachment.url,name:attachment.name,path,sha256:digest,sourceUrl:article.url}));return {status:'completed'};};
 const knowledge={enqueue:async(name,bytes,thread,path)=>{assert.equal(bytes.toString(),'%PDF-fixture');queued.push(path);}};
 const worker=new NoticeAttachments(root,python,knowledge);await Promise.all([worker.tick(),worker.tick()]);assert.equal(calls,2);assert.equal(queued.length,2);assert.equal(new Set(queued).size,1,'same hash original deduplicates');await worker.tick();assert.equal(calls,2);await worker.stop();
 const restarted=new NoticeAttachments(root,python,knowledge);await restarted.tick();assert.equal(calls,2,'URL cache survives restart');await restarted.stop();
 const entries=await webLibraryEntries(project);assert.equal(entries.size,2);for(const entry of entries.values())assert.deepEqual(entry.sections,[{source:'教务处',label:'实践教学'}]);
 const body=[...entries].find(([path])=>path.endsWith('.md'))[0];assert.match(await readFile(body,'utf8'),/\[正文.pdf\]\(https:\/\/jwc.seu.edu.cn\/b.pdf\)/);
 article.attachments.push({name:'新.pdf',url:'https://jwc.seu.edu.cn/c.pdf'});await writeFile(join(articles,'1.json'),JSON.stringify(article));const updated=await webLibraryEntries(project);assert.equal(updated.size,2);await assert.rejects(readFile(body),{code:'ENOENT'});
});

test('failed downloads back off, do not register missing originals and do not block the second PDF',async t=>{
 const root=await mkdtemp(join(tmpdir(),'notice-pdf-failure-'));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(join(root,'jwc','articles'),{recursive:true});
 await writeFile(join(root,'jwc','articles','1.json'),JSON.stringify({id:'1',attachments:[{url:'https://jwc.seu.edu.cn/a.pdf'},{url:'https://jwc.seu.edu.cn/b.pdf'}]}));let calls=0;
 const worker=new NoticeAttachments(root,async()=>{calls++;throw Error('offline');},{enqueue:async()=>assert.fail('must not register missing original')});await worker.tick();assert.equal(calls,2);await worker.tick();assert.equal(calls,2);await worker.stop();
});

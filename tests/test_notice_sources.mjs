import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadNoticeSources, noticeSources, noticeSourceIds} from '../src/shared/notice-sources.ts';
import {createNoticeTools} from '../src/runtime/tools/notices.ts';
import {NoticeAttachments} from '../src/runtime/notice-attachments.ts';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const additional={name:'土木工程学院',host:'civil.seu.edu.cn',adapter:'webplus',categories:{announcements:['学院通知','/notice/list.htm']}};

test('all notice tools derive sources and categories from the shared registry',async()=>{
 const registry=loadNoticeSources({...noticeSources,civil:additional});
 const calls=[],runner=async(action,payload)=>{calls.push([action,payload]);return {status:'completed',data:{results:[]}};};
 const {queryCampusNoticesTool:query,readCampusNoticeTool:read}=createNoticeTools(registry,runner);
 const invoke=async value=>query.execute(query.inputSchema.parse(value),{});
 await invoke({source:'civil',mode:'latest'});
 assert.equal(calls[0][0],'list-notices');assert.deepEqual(calls[0][1].categories,['announcements']);
 await invoke({source:'civil',mode:'search',query:'奖学金'});
 assert.equal(calls[1][0],'search-notices');assert.equal(calls[1][1].categories,undefined,'omitted scope still means site-wide search');
 await invoke({source:'civil',mode:'search',query:'奖学金',paths:['/notice/list.htm']});
 assert.deepEqual(calls[2][1].paths,['/notice/list.htm']);
 assert.throws(()=>query.inputSchema.parse({source:'jwc',mode:'latest',categories:['announcements']}));
 assert.throws(()=>read.inputSchema.parse({source:'civil',articleId:'seu-jwc-123'}));
 await read.execute(read.inputSchema.parse({source:'civil',articleId:'seu-civil-123'}),{});
 assert.equal(calls[3][0],'get-notice');
 assert.match(query.description,/土木工程学院/);
 assert.deepEqual(noticeSourceIds,['jwc','cse']);
});

test('invalid paths, duplicate prefixes and unsupported adapters are rejected',()=>{
 assert.throws(()=>loadNoticeSources({civil:{...additional,categories:{news:['通知','https://evil.invalid/list.htm']}}}));
 assert.throws(()=>loadNoticeSources({civil:{...additional,adapter:'rss'}}));
 assert.throws(()=>loadNoticeSources({...noticeSources,civil:{...additional,idPrefix:'seu-jwc'}}));
});

test('a configured third source participates in durable PDF discovery',async t=>{
 const root=await mkdtemp(join(tmpdir(),'notice-third-source-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(join(root,'civil','articles'),{recursive:true});
 await writeFile(join(root,'civil','articles','9.json'),JSON.stringify({id:'seu-civil-9',attachments:[{name:'通知.pdf',url:'https://civil.seu.edu.cn/a.pdf'}]}));
 const calls=[],python=async(action,payload)=>{calls.push([action,payload]);throw new Error('offline fixture');};
 const worker=new NoticeAttachments(root,python,{enqueue:async()=>assert.fail()},['civil']);await worker.tick();await worker.stop();
 assert.equal(calls[0][1].site,'civil');
 const restarted=new NoticeAttachments(root,python,{enqueue:async()=>assert.fail()},['civil']);await restarted.tick();await restarted.stop();
 assert.equal(calls.length,1,'third-source retry deadline survives restart');
 assert.equal(JSON.parse(await readFile(join(root,'notice-attachment-jobs.json'),'utf8')).jobs[0].site,'civil');
});


test('third-source notices and attachments appear under the configured institution and column',async t=>{
 const {webLibraryEntries}=await import('../src/runtime/web-library.ts');
 const {webFilesLayout,webMetadataPath,sha256}=await import('../src/runtime/web-file-store.ts');
 const project=await mkdtemp(join(tmpdir(),'notice-third-library-')),root=join(project,'.seudaily');t.after(()=>rm(project,{recursive:true,force:true}));
 const directory=join(root,'civil','articles');await mkdir(directory,{recursive:true});
 const article={id:'seu-civil-9',title:'学院通知',url:'https://civil.seu.edu.cn/2026/1007/c1a9/page.htm',category:'announcements',content:'通知正文',attachments:[{name:'规则.pdf',url:'https://civil.seu.edu.cn/a.pdf'}]};
 await writeFile(join(directory,'9.json'),JSON.stringify(article));
 const layout=webFilesLayout(root),bytes=Buffer.from('%PDF-fixture');
 await Promise.all([layout.files,layout.metadata].map(path=>mkdir(path,{recursive:true})));
 const original=join(layout.files,sha256(bytes)+'.pdf');await writeFile(original,bytes);
 await writeFile(webMetadataPath(root,article.attachments[0].url),JSON.stringify({name:'规则.pdf',url:article.attachments[0].url,path:original,sha256:sha256(bytes),sourceUrl:article.url}));
 const entries=await webLibraryEntries(project,loadNoticeSources({...noticeSources,civil:additional}));
 assert.equal(entries.size,2);
 for(const [path,entry] of entries){assert.deepEqual(entry.sections,[{source:'土木工程学院',label:'学院通知'}]);assert.match(path,/civil.seu.edu.cn\/announcements\/seu-civil-9\//);}
});

test('source identifiers remain discoverable without matching arbitrary words',async()=>{
 const {inferToolNamespaces}=await import('../src/agent/namespaces.ts');
 assert.ok(inferToolNamespaces('search CSE notices').includes('notices'));
 assert.ok(inferToolNamespaces('jwc').includes('notices'));
 assert.ok(!inferToolNamespaces('abcjwcdef').includes('notices'));
});

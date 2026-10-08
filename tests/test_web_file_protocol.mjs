import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readSavedWebFile,webMetadataPath,webFilesLayout,sha256} from '../src/runtime/web-file-store.ts';
import {webLibraryEntries} from '../src/runtime/web-library.ts';
import {NoticeAttachments} from '../src/runtime/notice-attachments.ts';
const exec=promisify(execFile);
const sourceRoot=resolve('src');
async function python(project,code){return JSON.parse((await exec('uv',['run','--no-project','python','-c',code],{cwd:project,env:{...process.env,PYTHONPATH:sourceRoot}})).stdout);}

test('Python originals and Node generated bodies share the disk protocol and survive migration',async t=>{
 const project=await mkdtemp(join(tmpdir(),'web-protocol-'));t.after(()=>rm(project,{recursive:true,force:true}));
 const runtime=join(project,'.seudaily'),url='https://jwc.seu.edu.cn/guide.pdf',articleUrl='https://jwc.seu.edu.cn/notice';
 const saved=await python(project,`import json\nfrom seudaily.saved_web_files import save\nprint(json.dumps(save('${url}','指南.pdf',b'%PDF-fixture','.pdf',source_url='${articleUrl}',notice={'id':'seu-jwc-42','title':'讲座','category':'practice'})))`);
 assert.match(saved.path.replaceAll('\\','/'),/jwc\.seu\.edu\.cn\/practice\/seu-jwc-42\//);
 const original=await readSavedWebFile(runtime,url);assert.equal(original.bytes.toString(),'%PDF-fixture');assert.equal(original.item.path,saved.path);
 const articles=join(runtime,'jwc','articles');await mkdir(articles,{recursive:true});
 await writeFile(join(articles,'42.json'),JSON.stringify({id:'seu-jwc-42',url:articleUrl,title:'讲座',content:'正文',category:'practice',attachments:[{url,name:'指南.pdf'}]}));
 await webLibraryEntries(project);
 const body=await python(project,`import json\nfrom seudaily.saved_web_files import cached\nprint(json.dumps(cached('${articleUrl}')))`);
 assert.equal(body.sectionId,'practice');assert.equal(body.source.name,'教务处');assert.match(body.name,/\.md$/);
 assert.ok(await readSavedWebFile(runtime,articleUrl));
 // Both readers reject malformed metadata and path escapes.
 await writeFile(webMetadataPath(runtime,url),JSON.stringify({...saved,path:join(project,'outside.pdf')}));await writeFile(join(project,'outside.pdf'),'%PDF-fixture');
 assert.equal(await readSavedWebFile(runtime,url),null);
 assert.equal(await python(project,`import json\nfrom seudaily.saved_web_files import cached\nprint(json.dumps(cached('${url}')))`),null);
 if(process.platform!=='win32'){
  const linked=join(webFilesLayout(runtime).files,'link.pdf');await symlink(join(project,'outside.pdf'),linked);
  await writeFile(webMetadataPath(runtime,url),JSON.stringify({...saved,path:linked}));assert.equal(await readSavedWebFile(runtime,url),null);
 }
 await writeFile(webMetadataPath(runtime,url),'[]');assert.equal(await readSavedWebFile(runtime,url),null);
 assert.equal(await python(project,`import json\nfrom seudaily.saved_web_files import cached\nprint(json.dumps(cached('${url}')))`),null);
});

test('PDF downloader validates newly downloaded metadata before registering it in RAG',async t=>{
 const project=await mkdtemp(join(tmpdir(),'web-download-check-'));t.after(()=>rm(project,{recursive:true,force:true}));
 const root=join(project,'.seudaily'),layout=webFilesLayout(root),url='https://jwc.seu.edu.cn/file.pdf';
 await Promise.all([join(root,'jwc','articles'),layout.files,layout.metadata].map(path=>mkdir(path,{recursive:true})));
 await writeFile(join(root,'jwc','articles','1.json'),JSON.stringify({id:'1',attachments:[{url,name:'附件.pdf'}]}));
 let calls=0;
 const worker=new NoticeAttachments(root,async()=>{
  calls++;const path=join(project,'outside.pdf'),bytes=Buffer.from('%PDF-fixture');await writeFile(path,bytes);
  await writeFile(webMetadataPath(root,url),JSON.stringify({url,name:'附件.pdf',path,sha256:sha256(bytes)}));return {status:'completed'};
 },{enqueue:async()=>assert.fail('escaped originals must not enter RAG')});
 await worker.tick();await worker.tick();assert.equal(calls,1);await worker.stop();
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {LocalClient} from '../src/agent/sqlite.ts';
import {KnowledgeService,cloudEmbedding} from '../src/runtime/knowledge/service.ts';
async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'seudaily-knowledge-')),db=new LocalClient(join(root,'agent.db'));
  const config={key:'fixture-key',model:'fixture-model',baseUrl:'https://example.invalid/v1'},calls=[],rows=new Map();let fail=false;
  const python=async(action,payload)=>{
    if(action==='parse-document')return {status:'completed',data:{markdown:'## 第 2 页\n课程说明：考试占比百分之六十。'}};
    if(payload.operation==='split')return {data:{chunks:[{text:payload.text,page:2,ordinal:0}]}};
    if(payload.operation==='index') {for(const row of payload.rows)rows.set(row.id,row);return {data:{count:payload.rows.length}};}
    if(payload.operation==='search')return {data:{matches:[...rows.values()].filter(row=>payload.documentIds.includes(row.documentId))}};
    if(payload.operation==='delete') {for(const [id,row] of rows)if(row.documentId===payload.documentId)rows.delete(id);return {data:{deleted:true}};}
  };
  const embed=async texts=>{calls.push(texts);if(fail)throw new Error('fixture interrupted network');return texts.map(()=>[1,0]);};
  const service=new KnowledgeService(db,join(root,'knowledge'),python,()=>config,embed);await service.ready;
  t.after(async()=>{await service.stop();await db.close();await rm(root,{recursive:true,force:true});});
  return {root,db,service,config,calls,rows,python,embed,setFail:value=>fail=value};
}

test('documents deduplicate before embedding, persist and remain searchable outside the upload session',async t=>{
  const f=await fixture(t),bytes=Buffer.from('课程期末考试占比六成。');
  const first=await f.service.enqueue('课程.txt',bytes,undefined,join(f.root,'first.txt'));
  assert.equal((await f.service.enqueue('改名.txt',bytes,undefined,join(f.root,'second.txt'))).duplicate,true);
  assert.deepEqual(await f.service.sources(first.id),[join(f.root,'first.txt'),join(f.root,'second.txt')]);
  await Promise.all([f.service.tick(),f.service.tick()]);
  assert.equal((await f.service.list())[0].state,'indexed');assert.equal(f.calls.length,1);
  const result=await f.service.search('考试占比');assert.equal(result.matches[0].name,'课程.txt');
  assert.match(result.matches[0].text,/六成/);
  await f.service.retry(first.id);await f.service.tick();
  assert.equal(f.calls.length,2,'index retry reuses vectors; only the preceding query needed another call');
  assert.equal(f.rows.size,1);
  await f.service.remove(first.id);assert.equal((await f.service.list()).length,0);assert.equal(f.rows.size,0);assert.deepEqual(await f.service.sources(first.id),[]);
  assert.equal((await f.service.search('考试')).matches.length,0);
});

test('uploads can wait for a key and failures are retryable without losing the source file',async t=>{
  const f=await fixture(t);f.config.key='';const doc=await f.service.enqueue('说明.txt',Buffer.from('这是课程文件'));
  await f.service.tick();assert.equal((await f.service.list())[0].state,'waiting_config');assert.equal(f.calls.length,0);
  f.config.key='fixture-key';f.setFail(true);await f.service.tick();
  assert.equal((await f.service.list())[0].state,'failed');
  f.setFail(false);await f.service.retry(doc.id);await f.service.tick();assert.equal((await f.service.list())[0].state,'indexed');
  f.config.model='another-model';assert.equal((await f.service.list())[0].state,'outdated');
  assert.equal((await f.service.search('课程')).matches.length,0);
  await f.service.retry(doc.id);await f.service.tick();assert.equal((await f.service.list())[0].state,'indexed');
});

test('interrupted jobs recover and changed original files are not silently indexed',async t=>{
  const f=await fixture(t),doc=await f.service.enqueue('资料.txt',Buffer.from('原文'));
  await f.db.execute({sql:"UPDATE knowledge_documents SET state='processing' WHERE id=?",args:[doc.id]});
  const recovered=new KnowledgeService(f.db,f.service.root,f.python,()=>f.config,f.embed);await recovered.ready;
  assert.equal((await recovered.list())[0].state,'queued');
  const [stored]=await recovered.list();await writeFile(stored.path,'被更改');await recovered.tick();
  assert.equal((await recovered.list())[0].state,'failed');assert.equal(f.calls.length,0);await recovered.stop();
  await assert.rejects(f.service.enqueue('image.jpg',Buffer.from('image')),/OCR/);
});

test('embedding validates result ordering and rejects malformed output without revealing upstream errors',async t=>{
  const original=globalThis.fetch;t.after(()=>globalThis.fetch=original);
  const config={key:'secret-fixture',model:'qwen3.7-text-embedding',baseUrl:'https://example.invalid/v1'};
  globalThis.fetch=async(url,options)=>{
    assert.equal(url,'https://example.invalid/v1/embeddings');
    assert.equal(options.headers.Authorization,'Bearer secret-fixture');
    assert.deepEqual(JSON.parse(options.body),{model:'qwen3.7-text-embedding',input:['a','b'],encoding_format:'float'});
    return new Response(JSON.stringify({data:[{index:1,embedding:[0,1]},{index:0,embedding:[1,0]}]}));
  };
  assert.deepEqual(await cloudEmbedding(['a','b'],config),[[1,0],[0,1]]);
  globalThis.fetch=async()=>new Response(JSON.stringify({data:[{index:0,embedding:[1,0]},{index:0,embedding:[0,1]}]}));
  await assert.rejects(cloudEmbedding(['a','b'],config),/格式无效/);
  globalThis.fetch=async()=>new Response('secret-fixture',{status:429});
  await assert.rejects(cloudEmbedding(['a'],config),error=>error.message.includes('429') && !error.message.includes('secret-fixture'));
});


test('first-use knowledge dependency progress is tracked without crashing on unknown components', async()=>{
  const {setPreparation,preparationStatus}=await import('../src/distribution/components.ts');
  setPreparation('knowledge','preparing','正在准备知识库');
  assert.equal(preparationStatus().knowledge.state,'preparing');
  setPreparation('unknown-future-component','preparing','未知组件');
  assert.equal(preparationStatus().knowledge.state,'preparing');
  setPreparation('knowledge','ready','知识库就绪');
  assert.equal(preparationStatus().knowledge.state,'ready');
});

test('bundled references auto-register without a key, deduplicate restarts and replace obsolete versions',async t=>{
 const f=await fixture(t);f.config.key='';
 const first=await f.service.enqueueBuiltin('handbook','学生手册.md',Buffer.from('学校规章原文'));
 assert.equal((await f.service.list())[0].state,'waiting_config');
 assert.deepEqual([...await f.service.builtinIds()],[first.id]);
 assert.equal((await f.service.enqueueBuiltin('handbook','学生手册.md',Buffer.from('学校规章原文'))).duplicate,true);
 assert.equal((await f.service.list()).length,1);assert.equal(f.calls.length,0);
 f.config.key='fixture-key';await f.service.tick();assert.equal((await f.service.list())[0].state,'indexed');
 const calls=f.calls.length;await f.service.enqueueBuiltin('handbook','学生手册.md',Buffer.from('学校规章原文'));await f.service.tick();assert.equal(f.calls.length,calls);
 const replacement=await f.service.enqueueBuiltin('handbook','学生手册.md',Buffer.from('修正后的学校规章'));
 assert.equal((await f.service.list()).length,1);assert.deepEqual([...await f.service.builtinIds()],[replacement.id]);
 assert.notEqual(replacement.id,first.id);await f.service.tick();
 f.config.model='changed-model';await f.service.enqueueBuiltin('handbook','学生手册.md',Buffer.from('修正后的学校规章'));
 assert.equal((await f.service.list())[0].state,'queued');await f.service.tick();assert.equal((await f.service.list())[0].state,'indexed');
});

import {createHash} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {registerBundledKnowledge} from '../src/runtime/knowledge/builtin.ts';

test('package manifest discovers originals and verifies every file before registering',async t=>{
 const f=await fixture(t),directory=join(f.root,'references');await mkdir(directory);
 const bytes=Buffer.from('体育考核分值参考');await writeFile(join(directory,'体育手册.md'),bytes);
 const item={id:'sports-guide',file:'体育手册.md',sha256:createHash('sha256').update(bytes).digest('hex')};
 await writeFile(join(directory,'manifest.json'),JSON.stringify({documents:[item]}));
 assert.equal(await registerBundledKnowledge(f.service,directory),1);
 assert.equal((await f.service.list())[0].name,'体育手册.md');
 await writeFile(join(directory,'manifest.json'),JSON.stringify({documents:[item,{...item,id:'another',file:'../outside.md'}]}));
 await assert.rejects(registerBundledKnowledge(f.service,directory),/条目无效/);
 await writeFile(join(directory,'体育手册.md'),'意外变更');
 await writeFile(join(directory,'manifest.json'),JSON.stringify({documents:[item]}));
 await assert.rejects(registerBundledKnowledge(f.service,directory),/校验失败/);
 assert.equal((await f.service.list()).length,1);
});


test('indexing uses the full split result rather than the twelve-chunk tool preview',async t=>{
 const f=await fixture(t),chunks=Array.from({length:25},(_,ordinal)=>({text:`参考资料第${ordinal}段`,page:0,ordinal}));
 const resultRef=join(f.root,'full-split.json');await writeFile(resultRef,JSON.stringify({data:{chunks}}));
 const python=async(action,payload,...args)=>payload.operation==='split' ? {status:'completed',data:{chunks:chunks.slice(0,12)},resultRef} : f.python(action,payload,...args);
 const service=new KnowledgeService(f.db,f.service.root,python,()=>f.config,f.embed);await service.ready;
 t.after(()=>service.stop());await service.enqueue('长手册.md',Buffer.from('长文档'));await service.tick();
 assert.equal((await service.list())[0].chunkCount,25);assert.equal(f.rows.size,25);
 assert.equal(f.calls.flat().length,25);assert.equal([...f.rows.values()].at(-1).text,'参考资料第24段');
});


test('source relocation retains an indexed document and all destinations without re-embedding',async t=>{
 const f=await fixture(t),oldPath=join(f.root,'old.pdf');
 const document=await f.service.enqueue('通知.pdf',Buffer.from('%PDF-fixture'),undefined,oldPath);await f.service.tick();const calls=f.calls.length;
 const paths=[join(f.root,'notice-a','file.pdf'),join(f.root,'notice-b','file.pdf')];
 await f.service.relocateSources(paths.map(path=>({oldPath,path})));
 assert.deepEqual((await f.service.sources(document.id)).sort(),paths.sort());
 await f.service.relocateSources(paths.map(path=>({oldPath,path})));assert.equal(f.calls.length,calls);assert.equal((await f.service.list())[0].state,'indexed');
});

test('rerank uses the shared key, correct endpoint, validates indices and hides upstream bodies',async t=>{
 const {cloudRerank}=await import('../src/runtime/knowledge/service.ts');
 const original=globalThis.fetch;t.after(()=>globalThis.fetch=original);
 const config={key:'secret-fixture',model:'embedding',rerankModel:'qwen3.7-text-rerank',baseUrl:'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'};
 globalThis.fetch=async(url,options)=>{
  assert.equal(url,'https://workspace.cn-beijing.maas.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank');
  assert.equal(options.headers.Authorization,'Bearer secret-fixture');
  assert.deepEqual(JSON.parse(options.body),{model:config.rerankModel,input:{query:'问题',documents:['甲','乙']},parameters:{top_n:2}});
  return Response.json({output:{results:[{index:0,relevance_score:0.1},{index:1,relevance_score:0.9}]}});
 };
 assert.deepEqual((await cloudRerank('问题',['甲','乙'],config,2)).map(item=>item.index),[1,0]);
 globalThis.fetch=async()=>Response.json({output:{results:[{index:0,relevance_score:0.8},{index:0,relevance_score:0.7}]}});
 await assert.rejects(cloudRerank('问题',['甲','乙'],config,2),/格式无效/);
 globalThis.fetch=async()=>new Response('secret-fixture',{status:429});
 await assert.rejects(cloudRerank('问题',['甲','乙'],config,2),error=>error.message.includes('429')&&!error.message.includes('secret-fixture'));
 config.rerankModel='qwen3-rerank';
 globalThis.fetch=async(url,options)=>{assert.match(url,/compatible-api\/v1\/reranks$/);assert.equal(JSON.parse(options.body).query,'问题');return Response.json({results:[{index:0,relevance_score:0.8}]});};
 assert.equal((await cloudRerank('问题',['甲'],config,1))[0].index,0);
});

test('search retrieves 32 full candidates, reranks before limiting and falls back on failure',async t=>{
 const f=await fixture(t);f.config.rerankModel='qwen3.7-text-rerank';
 const doc=await f.service.enqueue('长文.txt',Buffer.from('测试正文'));await f.service.tick();
 const candidates=Array.from({length:32},(_,ordinal)=>({documentId:doc.id,id:`${doc.id}:${ordinal}`,ordinal,text:`第${ordinal}段`,page:0}));
 const resultRef=join(f.root,'full-search.json');await writeFile(resultRef,JSON.stringify({data:{matches:candidates}}));
 let fail=false;
 const python=async(action,payload,...args)=>{if(payload.operation==='search'){assert.equal(payload.limit,32);return {status:'completed',resultRef,data:{matches:candidates.slice(0,12)}};}return f.python(action,payload,...args);};
 const rank=async(query,texts,config,limit)=>{assert.equal(texts.length,32);assert.equal(config.key,f.config.key);if(fail)throw new Error('network');return candidates.slice().reverse().slice(0,limit).map((item,i)=>({index:item.ordinal,relevance_score:1-i/32}));};
 const service=new KnowledgeService(f.db,f.service.root,python,()=>f.config,f.embed,rank);t.after(()=>service.stop());
 const first=await service.search('问题');assert.equal(first.matches.length,5);assert.equal(first.matches[0].ordinal,31);
 assert.equal((await service.search('问题',32)).matches.length,32);
 fail=true;const fallback=await service.search('问题');assert.equal(fallback.matches[0].ordinal,0);assert.match(fallback.warning,/重排暂时不可用/);
 await assert.rejects(service.search('问题',33),/1–32/);
 const abort=new AbortController();abort.abort();await assert.rejects(service.search('问题',5,abort.signal),{name:'AbortError'});
});

test('failed index results cannot mark a document indexed', async t=>{
 const f=await fixture(t);
 const python=async(action,payload,...args)=>payload.operation==='index' ? {status:'failed',summary:'索引写入失败'} : f.python(action,payload,...args);
 const service=new KnowledgeService(f.db,f.service.root,python,()=>f.config,f.embed);t.after(()=>service.stop());
 await service.enqueue('文档.md',Buffer.from('正文'));await service.tick();
 const [document]=await service.list();assert.equal(document.state,'failed');assert.match(document.error,/索引写入失败/);
 assert.equal((await service.search('正文')).matches.length,0);
});

test('transient embedding failures have bounded durable retries and reuse successful vectors', async t=>{
 const {RetryableKnowledgeError}=await import('../src/runtime/knowledge/service.ts');
 const f=await fixture(t);let calls=0,fail=true;
 const embed=async texts=>{calls++;if(fail)throw new RetryableKnowledgeError('HTTP 429');return texts.map(()=>[1,0]);};
 const service=new KnowledgeService(f.db,f.service.root,f.python,()=>f.config,embed);t.after(()=>service.stop());
 const doc=await service.enqueue('通知.md',Buffer.from('原文'));await service.tick();
 assert.equal((await service.list())[0].state,'queued');await service.tick();assert.equal(calls,1);
 const restarted=new KnowledgeService(f.db,f.service.root,f.python,()=>f.config,embed);await restarted.ready;t.after(()=>restarted.stop());
 await restarted.tick();assert.equal(calls,1);
 for(let attempt=2;attempt<=5;attempt++){
  await f.db.execute({sql:'UPDATE knowledge_retries SET nextAttemptAt=0 WHERE documentId=?',args:[doc.id]});await restarted.tick();
 }
 assert.equal(calls,5);assert.equal((await restarted.list())[0].state,'failed');
 fail=false;await restarted.retry(doc.id);await restarted.tick();assert.equal((await restarted.list())[0].state,'indexed');
 assert.equal((await f.db.execute('SELECT * FROM knowledge_retries')).rows.length,0);
});

test('failed vector deletion preserves the original for retry instead of reporting success', async t=>{
 const f=await fixture(t),doc=await f.service.enqueue('保留.md',Buffer.from('不可丢失的原文'));
 await f.service.tick();let fail=true;
 const python=async(action,payload,...args)=>payload.operation==='delete'&&fail ? {status:'failed',summary:'删除失败'} : f.python(action,payload,...args);
 const service=new KnowledgeService(f.db,f.service.root,python,()=>f.config,f.embed);t.after(()=>service.stop());
 await assert.rejects(service.remove(doc.id),/索引删除失败/);
 const [stored]=await service.list();assert.equal(stored.state,'deleting');assert.equal(await readFile(stored.path,'utf8'),'不可丢失的原文');
 fail=false;await service.remove(doc.id);assert.equal((await service.list()).length,0);
});

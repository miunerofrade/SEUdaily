import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
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

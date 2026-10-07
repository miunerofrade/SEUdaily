import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { LocalClient } from '../../agent/sqlite.js';
import { redactText } from '../../agent/redaction.js';

export const KNOWLEDGE_VERSION = 'recursive-1000-150-v1';
export const knowledgeExtensions = new Set(['.pdf', '.docx', '.xlsx', '.pptx', '.txt', '.md']);
export type EmbeddingConfig = { key: string; model: string; baseUrl: string };
export type KnowledgeDocument = { id: string; name: string; path: string; state: string; error: string; chunkCount: number; createdAt: number; space: string };
type Python = (action: string, payload: Record<string, unknown>, signal?: AbortSignal) => Promise<any>;
type Embed = (texts: string[], config: EmbeddingConfig, signal?: AbortSignal) => Promise<number[][]>;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const indexSpace = (config: EmbeddingConfig) => hash(JSON.stringify([config.baseUrl, config.model, KNOWLEDGE_VERSION]));
function vectorValid(value: unknown): value is number[] { return Array.isArray(value) && value.length > 0 && value.length <= 8192 && value.every(n=>typeof n === 'number' && Number.isFinite(n)) && value.some(n=>n!==0); }

export async function cloudEmbedding(texts: string[], config: EmbeddingConfig, signal?: AbortSignal): Promise<number[][]> {
  if (!config.key) throw new Error('请在设置中填写阿里云百炼 API Key');
  const url = new URL(config.baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('向量服务地址必须是 HTTPS 地址');
  const response = await fetch(config.baseUrl.replace(/\/$/,'') + '/embeddings', {
    method:'POST', redirect:'error', signal:AbortSignal.any([AbortSignal.timeout(60_000), ...(signal ? [signal] : [])]),
    headers:{Authorization:`Bearer ${config.key}`,'Content-Type':'application/json'},
    body:JSON.stringify({model:config.model,input:texts,encoding_format:'float'}),
  });
  // Do not include upstream bodies: they can echo API keys or uploaded content.
  if (!response.ok) throw new Error(`向量服务请求失败（HTTP ${response.status}）${response.status === 429 ? '，请稍后重试' : ''}`);
  const body = await response.json() as any;
  if (!Array.isArray(body.data) || body.data.length !== texts.length) throw new Error('向量服务返回数量不匹配');
  const vectors: number[][] = new Array(texts.length);
  for (const item of body.data) {
    if (!Number.isInteger(item.index) || item.index < 0 || item.index >= texts.length || vectors[item.index] || !vectorValid(item.embedding)) throw new Error('向量服务返回格式无效');
    vectors[item.index] = item.embedding;
  }
  if (new Set(vectors.map(v=>v.length)).size !== 1) throw new Error('向量维度不一致');
  return vectors;
}

export class KnowledgeService {
  readonly ready: Promise<void>;
  private timer?: NodeJS.Timeout;
  private processing?: Promise<void>;
  private stopped = false;
  private abort = new AbortController();
  private mutations: Promise<unknown> = Promise.resolve();
  constructor(private db: LocalClient, readonly root: string, private python: Python, readonly config: ()=>EmbeddingConfig, private embed: Embed = cloudEmbedding) {
    this.ready = this.initialize();
  }
  private async initialize() {
    await mkdir(join(this.root,'files'),{recursive:true,mode:0o700});
    await this.db.execute(`CREATE TABLE IF NOT EXISTS knowledge_documents (id TEXT PRIMARY KEY,name TEXT NOT NULL,path TEXT NOT NULL,extension TEXT NOT NULL,state TEXT NOT NULL,error TEXT NOT NULL,space TEXT NOT NULL,chunkCount INTEGER NOT NULL,createdAt INTEGER NOT NULL)`);
    await this.db.execute("UPDATE knowledge_documents SET state='queued',error='' WHERE state='processing'");
  }
  private serialize<T>(operation:()=>Promise<T>): Promise<T> {
    const result = this.mutations.then(operation);this.mutations=result.catch(()=>{});return result;
  }
  private async atomic(path: string, bytes: string | Buffer) {
    const temporary = path + '.' + randomUUID() + '.tmp';
    try { await writeFile(temporary,bytes,{mode:0o600,flag:'wx'});await rename(temporary,path); }
    finally { await unlink(temporary).catch(()=>{}); }
  }
  start() {
    if (this.timer || this.stopped) return;
    this.timer=setInterval(()=>void this.tick().catch(()=>{}),2000);this.timer.unref();
    void this.tick().catch(()=>{});
  }
  async stop() { this.stopped=true;clearInterval(this.timer);this.abort.abort();await this.processing;await this.mutations; }
  get busy() { return Boolean(this.processing); }
  async list(): Promise<KnowledgeDocument[]> {
    await this.ready;const space=indexSpace(this.config());
    const result=await this.db.execute('SELECT * FROM knowledge_documents ORDER BY createdAt DESC');
    return result.rows.map(row=>({...row,state:row.state === 'indexed' && row.space !== space ? 'outdated' : row.state})) as unknown as KnowledgeDocument[];
  }
  async enqueue(name: string, bytes: Buffer, markdown?: string) {
    await this.ready;
    if (!bytes.length || bytes.length > 50*1024*1024) throw new Error('文件大小必须在 50 MB 以内');
    const extension=extname(name).toLowerCase();
    if (!knowledgeExtensions.has(extension)) throw new Error('知识库支持 PDF、DOCX、XLSX、PPTX、TXT、MD；图片待后续 OCR 接入');
    if (extension === '.pdf' && bytes.subarray(0,5).toString() !== '%PDF-') throw new Error('PDF 文件内容无效');
    if (['.docx','.xlsx','.pptx'].includes(extension) && (bytes[0] !== 0x50 || bytes[1] !== 0x4b)) throw new Error('Office 文件内容无效');
    return this.serialize(async()=>{
      const id=hash(bytes), existing=(await this.db.execute({sql:'SELECT id,state FROM knowledge_documents WHERE id=?',args:[id]})).rows[0];
      if (existing) return {id,state:String(existing.state),duplicate:true};
      const path=join(this.root,'files',id+extension);await this.atomic(path,bytes);
      if (markdown) await this.atomic(join(this.root,id+'.text.json'),JSON.stringify({hash:id,text:markdown}));
      const state=this.config().key ? 'queued' : 'waiting_config';
      await this.db.execute({sql:'INSERT INTO knowledge_documents VALUES(?,?,?,?,?,?,?,0,?)',args:[id,name,path,extension,state,'','',Date.now()]});
      return {id,state,duplicate:false};
    });
  }
  async retry(id: string) {
    await this.ready;
    const result=await this.db.execute({sql:"UPDATE knowledge_documents SET state='queued',error='' WHERE id=? AND state NOT IN ('processing','deleting')",args:[id]});
    if (!result.rowsAffected) throw new Error('文档不存在或正在处理中');
  }
  async remove(id: string) {
    await this.ready;
    return this.serialize(async()=>{
      const row=(await this.db.execute({sql:'SELECT * FROM knowledge_documents WHERE id=?',args:[id]})).rows[0];
      if (!row) return;
      if (row.state === 'processing') throw new Error('文档正在处理中，请完成后再移除');
      await this.db.execute({sql:"UPDATE knowledge_documents SET state='deleting' WHERE id=?",args:[id]});
      // Hide from searches before deleting vectors. A retry completes a partial deletion.
      if (row.space) await this.python('knowledge-index',{operation:'delete',root:join(this.root,'index'),space:String(row.space),documentId:id});
      for (const path of [String(row.path),join(this.root,id+'.text.json')]) await unlink(path).catch(error=>{if(error.code !== 'ENOENT') throw error;});
      await this.db.execute({sql:'DELETE FROM knowledge_documents WHERE id=?',args:[id]});
    });
  }
  async tick() {
    if (this.stopped || this.processing) return this.processing;
    const task=this.work();this.processing=task;
    try {await task;} finally {this.processing=undefined;}
  }
  private async work() {
    await this.ready;if(this.stopped) return;
    if (!this.config().key) {
      await this.db.execute("UPDATE knowledge_documents SET state='waiting_config' WHERE state='queued'");return;
    }
    const row=(await this.db.execute("SELECT * FROM knowledge_documents WHERE state IN ('queued','waiting_config') ORDER BY createdAt LIMIT 1")).rows[0];
    if (!row || this.stopped) return;
    const claimed=await this.db.execute({sql:"UPDATE knowledge_documents SET state='processing',error='' WHERE id=? AND state IN ('queued','waiting_config')",args:[row.id]});
    if (claimed.rowsAffected) await this.process(row);
  }
  private async process(row: any) {
    const id=String(row.id), signal=this.abort.signal, config={...this.config()}, space=indexSpace(config);
    try {
      const bytes=await readFile(String(row.path));if(hash(bytes)!==id) throw new Error('原文件校验失败，请重新上传');
      let text='';
      try {const cached=JSON.parse(await readFile(join(this.root,id+'.text.json'),'utf8'));if(cached.hash===id && typeof cached.text==='string') text=cached.text;} catch {}
      if (!text) {
        if (['.txt','.md'].includes(String(row.extension))) text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
        else {
          const result=await this.python('parse-document',{path:String(row.path),filename:String(row.name)},signal);
          const full=result.resultRef ? JSON.parse(await readFile(result.resultRef,'utf8')) : result;
          if (result.status !== 'completed') throw new Error(result.summary || '文件解析失败');
          text=String(full.data?.markdown ?? result.data?.markdown ?? '');
        }
        if (text.trim()) await this.atomic(join(this.root,id+'.text.json'),JSON.stringify({hash:id,text}));
      }
      if (!text.trim()) {await this.db.execute({sql:"UPDATE knowledge_documents SET state='needs_ocr',error='未提取到文字，扫描文件需等待 OCR' WHERE id=?",args:[id]});return;}
      if (text.length>2_000_000) throw new Error('解析文本超过 200 万字符，请拆分文件后上传');
      const split=await this.python('knowledge-index',{operation:'split',text},signal);
      const chunks=split.data?.chunks as {text:string;page:number;ordinal:number}[];
      if (!Array.isArray(chunks) || !chunks.length || chunks.length>5000) throw new Error('分块结果无效或超过 5000 块');
      const cache=join(this.root,'vectors',space);await mkdir(cache,{recursive:true,mode:0o700});
      const vectors: number[][]=[];
      for (let start=0;start<chunks.length;start+=8) {
        signal.throwIfAborted();
        const batch=chunks.slice(start,start+8), missing:number[]=[];
        for (let offset=0;offset<batch.length;offset++) {
          const item=batch[offset], path=join(cache,hash(item.text)+'.json');
          try {const vector=JSON.parse(await readFile(path,'utf8'));if(!vectorValid(vector)) throw new Error();vectors[start+offset]=vector;} catch {missing.push(offset);}
        }
        if (missing.length) {
          const computed=await this.embed(missing.map(offset=>batch[offset].text),config,signal);
          for (let i=0;i<missing.length;i++) {
            const offset=missing[i];vectors[start+offset]=computed[i];
            await this.atomic(join(cache,hash(batch[offset].text)+'.json'),JSON.stringify(computed[i]));
          }
        }
      }
      await this.python('knowledge-index',{operation:'index',root:join(this.root,'index'),space,rows:chunks.map((chunk,i)=>({...chunk,id:`${id}:${i}`,documentId:id,vector:vectors[i]}))},signal);
      await this.db.execute({sql:"UPDATE knowledge_documents SET state='indexed',error='',space=?,chunkCount=? WHERE id=?",args:[space,chunks.length,id]});
    } catch(error) {
      await this.db.execute({sql:'UPDATE knowledge_documents SET state=?,error=? WHERE id=?',args:[signal.aborted ? 'queued' : 'failed',signal.aborted ? '' : redactText((error as Error).message).slice(0,500),id]});
    }
  }
  async search(query: string, limit=5, signal?: AbortSignal) {
    await this.ready;const config={...this.config()},space=indexSpace(config);
    const rows=(await this.db.execute({sql:"SELECT id,name,path FROM knowledge_documents WHERE state='indexed' AND space=?",args:[space]})).rows;
    if (!rows.length) return {matches:[],summary:'当前配置下没有已完成索引的文档。请先入库，或重建旧模型的索引。'};
    const [vector]=await this.embed([query],config,signal);
    const result=await this.python('knowledge-index',{operation:'search',root:join(this.root,'index'),space,vector,documentIds:rows.map(row=>String(row.id)),limit},signal);
    const documents=new Map(rows.map(row=>[String(row.id),row]));
    const matches=(result.data?.matches ?? []).flatMap((match:any)=>{
      const document=documents.get(match.documentId);return document ? [{...match,name:String(document.name),path:String(document.path)}] : [];
    });
    return {matches,summary:matches.length ? `找到 ${matches.length} 个相关片段；请核对内容是否回答问题，不相关时说明没有找到。` : '未找到相关片段。'};
  }
}

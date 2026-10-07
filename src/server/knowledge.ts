import type { Hono } from 'hono';
import { z } from 'zod';
import { basename } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { knowledge } from '../runtime/knowledge/index.js';
import { safeLibraryTarget } from '../runtime/app-routes.js';
const documentId=z.string().regex(/^[0-9a-f]{64}$/);
export function installKnowledgeRoutes(app: Hono) {
  app.get('/app/knowledge',async c=>c.json({configured:Boolean(knowledge.config().key),model:knowledge.config().model,documents:await knowledge.list()}));
  app.post('/app/knowledge/documents',async c=>{
    const body=await c.req.parseBody(),file=body.file;
    if (!(file instanceof File)) return c.json({error:'请选择文件'},400);
    return c.json(await knowledge.enqueue(file.name,Buffer.from(await file.arrayBuffer())),202);
  });
  app.post('/app/knowledge/text',async c=>{
    const body=z.object({name:z.string().trim().min(1).max(200),text:z.string().trim().min(1).max(2_000_000)}).parse(await c.req.json());
    return c.json(await knowledge.enqueue(body.name+'.txt',Buffer.from(body.text)),202);
  });
  app.post('/app/knowledge/import',async c=>{
    const body=z.object({path:z.string().min(1)}).parse(await c.req.json());
    const path=await safeLibraryTarget(body.path);
    if (!path) return c.json({error:'只能导入资料库中的文件'},403);
    const info=await stat(path);if (!info.isFile() || info.size>50*1024*1024) return c.json({error:'文件必须在 50 MB 以内'},400);
    return c.json(await knowledge.enqueue(basename(path),await readFile(path)),202);
  });
  app.post('/app/knowledge/documents/:id/retry',async c=>{
    await knowledge.retry(documentId.parse(c.req.param('id')));return c.json({ok:true});
  });
  app.delete('/app/knowledge/documents/:id',async c=>{
    await knowledge.remove(documentId.parse(c.req.param('id')));return c.json({ok:true});
  });
  app.post('/app/knowledge/search',async c=>{
    const body=z.object({query:z.string().trim().min(1).max(1000),limit:z.number().int().min(1).max(32).default(5)}).parse(await c.req.json());
    return c.json(await knowledge.search(body.query,body.limit,c.req.raw.signal));
  });
}

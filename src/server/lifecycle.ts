import type { Hono } from 'hono';
import { queueHasWork } from './message-queue.js';
import { randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { extname, resolve, relative, isAbsolute } from 'node:path';
import { projectRoot } from '../runtime/runtime-paths.js';
import { ensureComponent } from '../distribution/components.js';
import { startFocusRuntime } from '../runtime/focus-runtime.js';
import { VERSION, PROTOCOL } from '../distribution/config.js';
const clients = new Map<string, { interface: string; expires: number }>();
let webRoot: string | undefined = process.env.SEUDAILY_WEB_ROOT;
let startupAt = Date.now();
let persistent = process.env.SEUDAILY_PERSISTENT === '1';
const managed = process.env.SEUDAILY_MANAGED === '1';
export function ensurePersistentRuntime() {
  if (!persistent) { persistent = true; startFocusRuntime(); }
}
export function identity() {
  return { name: 'SEUdaily', runtime: 'agent', processId: process.pid, version: VERSION, protocol: PROTOCOL,
    dataRoot: projectRoot, managed, persistent, web: !!webRoot, clients: clients.size };
}
export function installLifecycle(app: Hono) {
  app.post('/app/runtime/clients', async c => {
    const body = await c.req.json();
    if (!['cli', 'web'].includes(body.interface)) return c.json({ error: '无效界面' }, 400);
    const id = randomUUID(); clients.set(id, { interface: body.interface, expires: Date.now() + 30_000 });
    return c.json({ id });
  });
  app.post('/app/runtime/clients/:id', c => {
    const client = clients.get(c.req.param('id'));
    if (!client) return c.json({ error: '界面连接已失效' }, 404);
    client.expires = Date.now() + 30_000; return c.json({ active: true });
  });
  app.delete('/app/runtime/clients/:id', c => {
    clients.delete(c.req.param('id')); return c.json({ released: true });
  });
  app.post('/app/runtime/persist', c => { ensurePersistentRuntime(); return c.json(identity()); });
  app.post('/app/runtime/stop', async c => {
    const body = await c.req.json().catch(() => ({}));
    if (body.processId !== undefined && body.processId !== process.pid) return c.json({error:'端口所属 PID 已变化，未停止服务'},409);
    setTimeout(() => process.emit('SIGTERM'), 50).unref(); return c.json({ stopping: true });
  });
  app.post('/app/runtime/web', async c => {
    webRoot = await realpath(resolve(await ensureComponent('web'), 'assets'));
    return c.json({ web: true });
  });
  // Static page handling is registered last, after all application/API routes.
  return () => app.get('*', async (c, next) => {
    if (!webRoot || c.req.path.startsWith('/app/') || c.req.path.startsWith('/api')) return next();
    const name = c.req.path === '/' ? 'index.html' : decodeURIComponent(c.req.path.slice(1));
    const path = await realpath(resolve(webRoot, name)).catch(() => undefined);
    if (!path) return c.notFound();
    const rel = relative(webRoot, path);
    if (isAbsolute(rel) || rel.startsWith('..') || rel.split(/[\\/]/).some(part => part.startsWith('.'))) return c.notFound();
    const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.png': 'image/png', '.ico': 'image/x-icon' };
    const bytes = await readFile(path).catch(() => undefined);
    if (!bytes) return c.notFound();
    c.header('Content-Type', types[extname(path)] ?? 'application/octet-stream');
    c.header('Cache-Control', name === 'index.html' ? 'no-store' : 'public, max-age=31536000, immutable');
    return c.body(new Uint8Array(bytes));
  });
}
export function startClientReaper() {
  startupAt = Date.now();
  const timer = setInterval(() => {
    for (const [id, client] of clients) if (client.expires <= Date.now()) clients.delete(id);
    if (managed && !persistent && !clients.size && !queueHasWork() && Date.now() - startupAt > 5000) process.emit('SIGTERM');
  }, 1000);
  timer.unref(); return () => clearInterval(timer);
}

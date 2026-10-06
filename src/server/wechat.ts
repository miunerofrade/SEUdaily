import type { Hono } from 'hono';
import { chmod } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { agentStore } from '../runtime/storage.js';
import { runtimeRoot } from '../runtime/runtime-paths.js';
import { WeChatRuntime } from '../wechat/runtime.js';
import { WeChatConversations } from '../wechat/conversations.js';
import { agentRuntime } from '../runtime/application.js';
import { ensurePersistentRuntime } from './lifecycle.js';
export const wechatRuntime = new WeChatRuntime(agentStore.client,undefined,1000,new WeChatConversations(agentStore,agentRuntime));
let prepared: Promise<void> | undefined;
function prepare() { return prepared ??= prepareOnce(); }
async function prepareOnce() {
  await agentStore.ready;
  // Bot credentials and reply context tokens live in this local database.
  await chmod(runtimeRoot,0o700);
  for (const suffix of ['', '-wal', '-shm']) await chmod(resolve(runtimeRoot,'agent.db' + suffix),0o600).catch(error => { if (error.code !== 'ENOENT') throw error; });
  await wechatRuntime.initialize();
}
export async function startWeChatRuntime() {
  await prepare();
  if ((await wechatRuntime.status()).state !== 'disconnected') {
    // Restoring a saved channel is a service boot; recover old Focus leases too.
    process.env.SEUDAILY_PERSISTENT = '1';
    ensurePersistentRuntime(); await wechatRuntime.start();
  }
}
export function installWeChatRoutes(app: Hono) {
  app.get('/app/wechat', async c => { await prepare(); return c.json(await wechatRuntime.status()); });
  app.post('/app/wechat/connect', async c => {
    const body = z.object({ refresh:z.boolean().default(false) }).parse(await c.req.json());
    await prepare(); ensurePersistentRuntime();
    return c.json(await wechatRuntime.connect(body.refresh));
  });
  app.post('/app/wechat/verify', async c => {
    const body = z.object({loginId:z.string().uuid(),code:z.string().min(4).max(12)}).parse(await c.req.json());
    return c.json(await wechatRuntime.verify(body.loginId,body.code));
  });
  app.post('/app/wechat/cancel-login', async c => c.json(await wechatRuntime.cancelLogin()));
}

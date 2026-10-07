import { knowledge, loadBuiltinKnowledge } from '../runtime/knowledge/index.js';
import { startWeChatRuntime, wechatRuntime } from './wechat.js';
import { cancelComponentPreparation } from '../distribution/components.js';
import { stopMessageQueue } from './message-queue.js';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runtimeRoot } from '../runtime/runtime-paths.js';
import { startClientReaper } from './lifecycle.js';
import { serve } from '@hono/node-server';
import { app } from './app.js';
import { agentRuntime, closeApplicationWorkspace } from '../runtime/application.js';
import { agentStore } from '../runtime/storage.js';
import { startFocusRuntime, stopFocusRuntime } from '../runtime/focus-runtime.js';
import {NoticeAttachments} from '../runtime/notice-attachments.js';
import {runPythonTool} from '../runtime/tools/python-bridge.js';
import { closePythonWorker } from '../runtime/tools/python-bridge.js';
import { closeBrowserTools } from '../runtime/tools/browser-tools.js';
function hasEnabledFocus(): boolean {
    const path = resolve(runtimeRoot, 'focus.json');
    if (!existsSync(path)) return false;
    const state = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(state.items) && state.items.some((item: { enabled?: boolean }) => item.enabled !== false);
}
const noticeAttachments=new NoticeAttachments(runtimeRoot,runPythonTool,knowledge);
let stopping = false;
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: Number(process.env.SEUDAILY_PORT ?? 4111) }, () => {
    console.log(`SEUdaily API ready at http://127.0.0.1:${process.env.SEUDAILY_PORT ?? 4111}`);
    void agentStore.ready.then(async () => {
      try {await loadBuiltinKnowledge();} catch(error) {console.error('内置参考资料登记失败，下次启动可重试',error);}
      knowledge.start(); noticeAttachments.start(); await startWeChatRuntime(); if (process.env.SEUDAILY_PERSISTENT === '1' || !process.env.SEUDAILY_INSTALL_ROOT || hasEnabledFocus()) startFocusRuntime();
    }).catch(error => { console.error('后端初始化失败，数据库已保留', error); void shutdown(1); });
});
const stopClientReaper = startClientReaper();
async function shutdown(code = 0) {
    if (stopping)
        return;
    stopping = true;
    const queueStopped = stopMessageQueue();
    const noticeStopped = noticeAttachments.stop();
    const knowledgeStopped = knowledge.stop();
    stopClientReaper();
    cancelComponentPreparation();
    stopFocusRuntime();
    server.close();
    const deadline = setTimeout(() => process.exit(code), 15_000);
    deadline.unref();
    closeApplicationWorkspace();
    await Promise.allSettled([wechatRuntime.close(), agentRuntime.shutdown(), closePythonWorker(), closeBrowserTools(), queueStopped, knowledgeStopped, noticeStopped]);
    await agentStore.close();
    clearTimeout(deadline);
    process.exit(code);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

import { cancelComponentPreparation } from '../distribution/components.js';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runtimeRoot } from '../runtime/runtime-paths.js';
import { startClientReaper } from './lifecycle.js';
import { serve } from '@hono/node-server';
import { app } from './app.js';
import { agentRuntime, closeApplicationWorkspace } from '../runtime/application.js';
import { agentStore } from '../runtime/storage.js';
import { startFocusRuntime, stopFocusRuntime } from '../runtime/focus-runtime.js';
import { closePythonWorker } from '../runtime/tools/python-bridge.js';
import { closeBrowserTools } from '../runtime/tools/browser-tools.js';
function hasEnabledFocus(): boolean {
    const path = resolve(runtimeRoot, 'focus.json');
    if (!existsSync(path)) return false;
    const state = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(state.items) && state.items.some((item: { enabled?: boolean }) => item.enabled !== false);
}
let stopping = false;
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: Number(process.env.SEUDAILY_PORT ?? 4111) }, () => {
    console.log(`SEUdaily API ready at http://127.0.0.1:${process.env.SEUDAILY_PORT ?? 4111}`);
    void agentStore.ready.then(() => { if (!process.env.SEUDAILY_INSTALL_ROOT || hasEnabledFocus()) startFocusRuntime(); }).catch(() => { console.error('会话迁移失败，旧数据库已保留'); void shutdown(1); });
});
const stopClientReaper = startClientReaper();
async function shutdown(code = 0) {
    if (stopping)
        return;
    stopping = true;
    stopClientReaper();
    cancelComponentPreparation();
    stopFocusRuntime();
    await agentRuntime.shutdown();
    server.close();
    const deadline = setTimeout(() => process.exit(code), 15_000);
    deadline.unref();
    closeApplicationWorkspace();
    await Promise.allSettled([closePythonWorker(), closeBrowserTools()]);
    agentStore.close();
    clearTimeout(deadline);
    process.exit(code);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

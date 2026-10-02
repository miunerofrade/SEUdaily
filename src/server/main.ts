import { serve } from '@hono/node-server';
import { app } from './app.js';
import { agentRuntime } from '../runtime/application.js';
import { agentStore } from '../runtime/storage.js';
import { startFocusRuntime, stopFocusRuntime } from '../runtime/focus-runtime.js';
import { closePythonWorker } from '../runtime/tools/python-bridge.js';
import { closeBrowserTools } from '../runtime/tools/browser-tools.js';
let stopping=false;
const server=serve({fetch:app.fetch,hostname:'127.0.0.1',port:4111},()=>{
  console.log('SEUdaily API ready at http://127.0.0.1:4111');
  void agentStore.ready.then(()=>startFocusRuntime()).catch(()=>{console.error('会话迁移失败，旧数据库已保留');void shutdown(1);});
});
async function shutdown(code=0){
  if(stopping)return;stopping=true;
  stopFocusRuntime();agentRuntime.shutdown();
  server.close();
  const deadline=setTimeout(()=>process.exit(code),5000);deadline.unref();
  const workspace=await import('../runtime/workspace.js');workspace.closeWorkspace();
  await Promise.allSettled([closePythonWorker(),closeBrowserTools()]);
  agentStore.close();clearTimeout(deadline);process.exit(code);
}
process.on('SIGINT',()=>void shutdown());process.on('SIGTERM',()=>void shutdown());

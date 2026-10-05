/** Real browser UI with a local mock model; build first, then run node --import tsx scripts/validate-web-queue.mjs. */
import {createServer} from 'node:http';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {getRequestListener} from '@hono/node-server';
import {webkit,firefox,chromium} from 'playwright';
import {fileURLToPath} from 'node:url';
const source=fileURLToPath(new URL('..',import.meta.url));
const port=Number(process.env.SEUDAILY_WEB_TEST_PORT || 42498);
const root=await mkdtemp(join(tmpdir(),'seudaily-web-queue-'));
await writeFile(join(root,'package.json'),'{}');await writeFile(join(root,'pyproject.toml'),'');
process.env.SEUDAILY_PROJECT_ROOT=root;process.env.SEUDAILY_PORT=String(port);
const {app}=await import(source+'/src/server/app.ts');
const {agentRuntime}=await import(source+'/src/runtime/application.ts');
const {agentStore}=await import(source+'/src/runtime/storage.ts');
const {stopMessageQueue}=await import(source+'/src/server/message-queue.ts');
agentRuntime.config.tools=async()=>({});agentRuntime.config.instructions=async()=>'';
agentRuntime.config.provider={async *stream(messages,_tools,signal){const text=messages.filter(m=>m.role==='user').at(-1).content;if(text==='hold'){yield {type:'text',text:'正在等待取消'};await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}yield {type:'text',text:'队列回答完成'};yield {type:'complete',message:{role:'assistant',content:'队列回答完成'},finishReason:'stop'};}};
const api=getRequestListener(app.fetch);
const server=createServer(async(req,res)=>{if(req.url==='/app/conversations/title'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({title:'fixture'}));return;}if(['/app/focus','/app/ramdisk','/app/vpn','/app/library'].some(path=>req.url.split('?')[0]===path)){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({status:'completed',data:{items:[],state:'disconnected',mounted:false}}));return;}if(req.url.startsWith('/api/')||req.url.startsWith('/app/'))return api(req,res);try{const name=req.url.split('?')[0];const file=resolve(source,'dist/components/web/assets',name==='/'?'index.html':name.slice(1));const bytes=await readFile(file);res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':'application/octet-stream');res.end(bytes);}catch{res.statusCode=404;res.end();}});
await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
let browser;
try{
 browser=await (process.platform === 'darwin' ? webkit : process.platform === 'linux' ? firefox : chromium).launch({headless:true,...(process.platform === 'win32' ? {channel:'msedge'} : {})});const page=await browser.newPage();
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1' ? route.continue() : route.abort());
 await page.goto('http://127.0.0.1:'+server.address().port);
 
 const input=page.getByPlaceholder('问问 SEUdaily，或粘贴图片');await input.fill('hold');await input.press('Enter');
 await page.getByRole('button',{name:'停止回答',exact:true}).waitFor();
 await input.fill('queued edit');await input.press('Enter');await page.locator('.composer-queue-row').waitFor();
 await page.getByRole('button',{name:'编辑',exact:true}).click();await page.waitForFunction(()=>document.querySelector('textarea').value==='queued edit');
 assert.equal(await page.locator('.composer-queue-row').count(),0);
 await input.fill('queued delete');await input.press('Enter');await page.locator('.composer-queue-row').waitFor();
 await page.getByRole('button',{name:'删除',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.composer-queue-row'));
 await input.fill('queued final');await input.press('Enter');await page.locator('.composer-queue-row').waitFor();
 await page.getByRole('button',{name:'停止回答',exact:true}).click();await page.getByRole('button',{name:'继续队列',exact:true}).waitFor();
 await page.getByRole('button',{name:'继续队列',exact:true}).click();
 await page.getByText('队列回答完成',{exact:true}).waitFor({timeout:10000});
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({webQueue:true,edit:true,delete:true,cancel:true,resume:true,pageErrors:errors}));
}finally{
 await browser?.close();const stopped=stopMessageQueue();await agentRuntime.shutdown();await stopped;await new Promise(resolve=>server.close(resolve));agentStore.close();await rm(root,{recursive:true,force:true});
}

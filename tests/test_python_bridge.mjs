import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PythonWorkerClient} from '../src/runtime/tools/python-bridge.ts';

async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'seudaily-bridge-protocol-')),log=join(root,'protocol.jsonl'),script=join(root,'worker.mjs');
 await writeFile(script,`import {createInterface} from 'node:readline';import {appendFileSync} from 'node:fs';
 const pending=new Map();const reply=(id,result)=>process.stdout.write(JSON.stringify({requestId:id,type:'result',result})+'\\n');
 createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);appendFileSync(process.argv[2],line+'\\n');
 if(m.action==='crash')process.exit(9);
 else if(m.type==='cancel'){pending.delete(m.requestId);reply(m.requestId,{status:'cancelled'});}
 else if(m.action==='capture')pending.set(m.requestId,m);
 else reply(m.requestId,{status:'completed',marker:m.action});});`);
 const bridge=new PythonWorkerClient({command:process.execPath,args:[script,log],cwd:root});
 t.after(async()=>{await bridge.close();await rm(root,{recursive:true,force:true});});
 return {bridge,records:async()=> (await readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)};
}
test('cancelling a request leaves the real worker available to unrelated work',async t=>{
 const f=await fixture(t),controller=new AbortController();const pending=f.bridge.call('capture',{},controller.signal);const rejected=assert.rejects(pending,{name:'AbortError'});
 assert.equal((await f.bridge.call('health',{})).status,'completed');controller.abort();await rejected;
 assert.equal((await f.bridge.call('after-cancel',{})).marker,'after-cancel');
 assert.equal((await f.records()).filter(x=>x.type==='cancel').length,1);
});
test('tool timeout sends cancellation over the worker protocol without killing shared work',async t=>{
 const f=await fixture(t);t.mock.timers.enable({apis:['setTimeout']});
 const pending=f.bridge.call('capture',{});const rejected=assert.rejects(pending,/timed out/);
 await f.bridge.call('health',{});t.mock.timers.runAll();await rejected;
 assert.equal((await f.bridge.call('after-timeout',{})).marker,'after-timeout');
 assert.equal((await f.records()).filter(x=>x.type==='cancel').length,1);
});
test('shutdown cancels outstanding protocol requests and waits for worker EOF',async t=>{
 const f=await fixture(t);const a=assert.rejects(f.bridge.call('capture',{}),/shutting down/);const b=assert.rejects(f.bridge.call('capture',{}),/shutting down/);
 await f.bridge.call('health',{});await f.bridge.close();await Promise.all([a,b]);
 assert.equal((await f.records()).filter(x=>x.type==='cancel').length,2);
});
test('unexpected worker exit rejects pending calls and subsequent requests start a replacement',async t=>{
 const f=await fixture(t);const pending=assert.rejects(f.bridge.call('capture',{}),/exited|no longer running/);
 await f.bridge.call('health',{});await assert.rejects(f.bridge.call('crash',{}),/exited|no longer running/);await pending;
 assert.equal((await f.bridge.call('replacement',{})).marker,'replacement');
});

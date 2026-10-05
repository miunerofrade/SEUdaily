import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {enterKey,committedInput} from '../src/terminal/keyboard.ts';
import {Session} from '../src/terminal/session.ts';
import {PythonWorkerClient} from '../src/runtime/tools/python-bridge.ts';
import {permissionForm} from '../src/terminal/management.ts';

test('TUI permission picker restores shared mode and saves full plus extra together',async()=>{
 let saved;
 const session={client:{json:async(path,method,body)=>method==='POST'?(saved=body):{fields:[{name:'SEUDAILY_FULL_ACCESS_EXTRA',value:'true'}]}},show:()=>{}};
 const form=await permissionForm(session);
 assert.equal(form.fields[0].value,'extra');
 assert.deepEqual(form.fields[0].choices.map(item=>item.value),['normal','full','extra']);
 await form.save({mode:'extra'});
 assert.deepEqual(saved.values,{SEUDAILY_FULL_ACCESS:'true',SEUDAILY_FULL_ACCESS_EXTRA:'true'});
 await form.save({mode:'normal'});
 assert.deepEqual(saved.values,{SEUDAILY_FULL_ACCESS:'false',SEUDAILY_FULL_ACCESS_EXTRA:'false'});
});

test('Enter accepts CR batches, LF, CRLF and keypad without submitting an IME commit',()=>{
 for(const value of ['\r','\r\r','\n','\r\n','[57414u'])assert.equal(enterKey(value,{return:false}).return,true);
 assert.equal(enterKey('中文\r',{return:false}).return,false);assert.equal(committedInput('中文\r'),'中文');
});
test('busy TUI queues attachments; Up take restores the draft; VPN reports connected case-insensitively',async()=>{
 const session=new Session({command:'chat'},'/tmp');let payload;let deleted=false;
 session.recordInput=async()=>{};
 session.client.json=async(path,method,body)=>{
  if(path==='/app/vpn')return {state:'connected',message:'ready'};
  if(method==='DELETE'){deleted=true;return payload;}
  if(method==='POST'){payload=structuredClone(body);return {id:'queued'};}
  return {active:true,items:deleted?[]:[{id:'queued',state:'pending',...payload}]};
 };
 session.busy=true;session.images=[{ref:'image',name:'image.png',mediaType:'image/png'}];session.documents=[{contextRef:'doc',name:'file.pdf'}];session.skills=['skill'];
 await session.submit('hello');assert.equal(payload.text,'hello');assert.equal(session.images.length,0);
 assert.equal(await session.takeQueued(),'hello');assert.equal(deleted,true);assert.equal(session.images[0].ref,'image');assert.equal(session.documents[0].contextRef,'doc');assert.deepEqual(session.skills,['skill']);
 session.busy=false;await session.command('/VPN');assert.equal(session.messages.at(-1).text,'VPN 已连接');
});
test('isolated worker cancellation waits for worker and child process termination',async t=>{
 if(process.platform==='win32')return t.skip('POSIX process-group probe');
 const root=await mkdtemp(join(tmpdir(),'seudaily-worker-cancel-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const file=join(root,'pid');
 const script=`import os,sys,json,subprocess,time\np=subprocess.Popen([sys.executable,'-c','import time;time.sleep(120)'],start_new_session=True)\nopen(sys.argv[1],'w').write(str(os.getpid())+' '+str(p.pid))\nfor line in sys.stdin:\n m=json.loads(line)\n time.sleep(120)\n`;
 const worker=new PythonWorkerClient({command:'python3',args:['-u','-c',script,file],cwd:root});t.after(()=>worker.terminate());
 const controller=new AbortController();const pending=worker.call('probe',{},controller.signal,true);const rejection=assert.rejects(pending,/cancelled/);
 let pids;const deadline=Date.now()+4000;while(Date.now()<deadline){try{pids=(await readFile(file,'utf8')).split(' ').map(Number);break;}catch{}await new Promise(r=>setTimeout(r,20));}assert.ok(pids);
 controller.abort();await rejection;
 assert.throws(()=>process.kill(pids[0],0));
 // A killed child can briefly remain a zombie until the OS reaps it; it cannot execute.
 const {execFileSync}=await import('node:child_process');
 let state='';try{state=execFileSync('ps',['-p',String(pids[1]),'-o','stat='],{encoding:'utf8'}).trim();}catch{}assert.ok(!state||state.startsWith('Z'),state);
});

test('conversation deletion requires confirmation and removes the selected thread',async()=>{
 const session=new Session({command:'chat'},'/tmp');session.threads=[{id:'other',resourceId:'fixture',title:'fixture'}];const calls=[];
 session.client.json=async(path,method)=>{calls.push({path,method});return {};};
 session.requestDeleteThread('other');assert.equal(calls.length,0);await session.decide(false);assert.equal(calls.length,0);
 session.requestDeleteThread('other');await session.decide(true);assert.equal(calls[0].method,'DELETE');assert.equal(session.threads.length,0);
});
test('invalid model error points to settings without exposing provider details',async()=>{
 const {DeepSeekProvider}=await import('../src/agent/provider.ts');const original=globalThis.fetch;
 globalThis.fetch=async()=>new Response('Invalid model fixture-private-key',{status:400});
 try{const provider=new DeepSeekProvider({apiKey:'fixture-private-key',model:'wrong'});await assert.rejects(async()=>{for await(const _ of provider.stream([{role:'user',content:'hi'}],[])){};},error=>{assert.match(error.message,/模型名称.*settings/);assert.doesNotMatch(error.message,/fixture-private/);return true;});}finally{globalThis.fetch=original;}
});

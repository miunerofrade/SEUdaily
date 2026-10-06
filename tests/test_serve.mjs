import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { parseCommand } from '../src/distribution/arguments.ts';
const root = resolve(import.meta.dirname, '..');
const cli = join(root, 'bin/seudaily.mjs');
const exec = promisify(execFile);
const clientExpiryTimeout = process.platform === 'win32' ? 45000 : 10000;
async function eventually(fn, timeout = 10000) {
  const end = Date.now()+timeout; let last;
  do { try { return await fn(); } catch(error) { last = error; await delay(100); } } while(Date.now()<end);
  throw last;
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(),'seudaily-serve-'));
  const socket = createServer(); await new Promise(r => socket.listen(0,'127.0.0.1',r));
  const port = socket.address().port; await new Promise(r => socket.close(r));
  const api = 'http://127.0.0.1:'+port;
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(SEUDAILY_|CVSTREAM_|DEEPSEEK_)/.test(key))),
    SEUDAILY_NO_OPEN:'1', SEUDAILY_CACHE_DIR:join(directory,'cache'), SEUDAILY_UV_BINARY:join(directory,'missing-uv') };
  const args = ['--data-dir',directory,'--port',String(port)];
  const children = [], exits = [], backendPids = new Set();
  let output = '';
  const start = command => {
    const child = spawn(process.execPath,[cli,...command,...args],{cwd:root,env,stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',chunk => { output += chunk; }); child.stderr.on('data',chunk => { output += chunk; });
    exits.push(new Promise(resolve => child.once('close',resolve)));
    children.push(child); return child;
  };
  const request = async (path, options) => {
    const response = await fetch(api+path,{...options,signal:AbortSignal.timeout(1000)});
    assert.equal(response.status,200,await response.clone().text());
    const value = await response.json();
    if (value.name === 'SEUdaily' && value.processId) backendPids.add(value.processId);
    return value;
  };
  t.after(async () => {
    for (const child of children) if (child.exitCode===null) child.kill('SIGTERM');
    await request('/app/runtime/stop',{method:'POST'}).catch(() => {});
    await eventually(async () => { try { await fetch(api+'/api'); } catch { return; } throw new Error('backend still running'); }).catch(() => {});
    await Promise.all(exits);
    // server.close() stops HTTP before SQLite/log handles and the process cwd
    // have been released. Windows cannot remove a live process's cwd.
    await eventually(async () => {
      for (const pid of backendPids) {
        try { process.kill(pid,0); }
        catch (error) { if (error.code === 'ESRCH') continue; throw error; }
        throw new Error('backend process still stopping');
      }
    },20000);
    await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  });
  return {directory,env,args,start,request,output:()=>output};
}
test('serve arguments are separate from ordinary interfaces', () => {
  assert.equal(parseCommand(['serve']).command,'serve');
  assert.equal(parseCommand(['serve','--with-web']).values['with-web'],true);
  assert.throws(() => parseCommand(['web','--with-web']));
  assert.throws(() => parseCommand(['web','--serve']));
});
test('serve is shared by ordinary commands, survives disconnected clients and restarts after a crash', {timeout:70000}, async t => {
  const f = await fixture(t);
  const service = f.start(['serve']);
  const initial = await eventually(() => f.request('/api'));
  assert.equal(initial.persistent,true);
  const web = f.start(['web']);
  await eventually(async () => assert.equal((await f.request('/api')).clients,1));
  await exec(process.execPath,[cli,'sessions',...f.args],{env:f.env});
  assert.equal((await f.request('/api')).processId,initial.processId);
  web.kill('SIGTERM');
  await eventually(async () => assert.equal((await f.request('/api')).clients,0),clientExpiryTimeout);
  await delay(6500);
  assert.equal((await f.request('/api')).processId,initial.processId);
  assert.match(f.output(),/Focus.*failed/,'dependency failure is logged while API remains available');
  await f.request('/app/health');
  // A committed upload and persisted DB state must survive abrupt backend death.
  await f.request('/app/images',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({dataUrl:'data:image/png;base64,aW1hZ2U=',name:'fixture.png'})});
  const db = new DatabaseSync(join(f.directory,'.seudaily','agent.db'));
  db.prepare("INSERT INTO metadata VALUES('restart-fixture','retained')").run();
  db.prepare("INSERT INTO runs VALUES('run-fixture','thread','resource','running','{}')").run();
  db.close();
  process.kill(initial.processId,'SIGKILL');
  await eventually(async () => assert.notEqual(service.exitCode,null));
  const restarted = f.start(['serve']);
  const identity = await eventually(() => f.request('/api'));
  assert.notEqual(identity.processId,initial.processId);
  await f.request('/app/health');
  const reopened = new DatabaseSync(join(f.directory,'.seudaily','agent.db'));
  assert.equal(reopened.prepare("SELECT value FROM metadata WHERE key='restart-fixture'").get().value,'retained');
  assert.equal(reopened.prepare("SELECT status FROM runs WHERE id='run-fixture'").get().status,'interrupted');
  reopened.close();
  const duplicate = await exec(process.execPath,[cli,'serve',...f.args],{env:f.env}).then(() => null,e => e);
  assert.match(duplicate.stderr,/已运行/);
  assert.equal((await f.request('/api')).processId,identity.processId);
  await f.request('/app/runtime/stop',{method:'POST'});
  await eventually(async () => assert.equal(restarted.exitCode,0));
});
test('ordinary Web without an existing backend keeps its automatic shutdown behavior', {timeout:55000}, async t => {
  const f = await fixture(t);
  const web = f.start(['web']);
  const identity = await eventually(() => f.request('/api'));
  assert.equal(identity.persistent,false); assert.equal(identity.managed,true);
  // /api is ready before the Web launcher has registered its signal cleanup.
  // Wait for the interface itself, otherwise killing during startup leaves a
  // client lease to expire normally after 30 seconds.
  await eventually(async () => {
    assert.match(f.output(), /SEUdaily Web/);
    assert.equal((await f.request('/api')).clients,1);
  });
  web.kill('SIGTERM');
  await eventually(async () => {
    try { await f.request('/api'); } catch(error) { if (error.cause?.code==='ECONNREFUSED') return; throw error; }
    throw new Error('temporary backend still running');
  },clientExpiryTimeout);
});

test('WeChat creates a persistent backend without a TTY and ordinary Web reuses it', {timeout:60000}, async t => {
  const f = await fixture(t);
  const result = await exec(process.execPath,[cli,'WeChat',...f.args],{env:f.env});
  assert.match(result.stdout,/WeChat/);
  const initial=await f.request('/api');assert.equal(initial.persistent,true);assert.equal(initial.clients,0);
  const web=f.start(['web']);
  await eventually(async () => assert.match(f.output(),/SEUdaily Web/));
  assert.equal((await f.request('/api')).processId,initial.processId);
  web.kill('SIGTERM');await eventually(async () => assert.equal((await f.request('/api')).clients,0),clientExpiryTimeout);
  await delay(6500);assert.equal((await f.request('/api')).processId,initial.processId);
  assert.equal((await f.request('/app/wechat')).state,'disconnected');
});
test('WeChat promotes a temporary backend without replacing its process or clients', {timeout:60000}, async t => {
  const f=await fixture(t);const web=f.start(['web']);
  await eventually(async () => assert.match(f.output(),/SEUdaily Web/));
  const initial=await f.request('/api');assert.equal(initial.persistent,false);
  await exec(process.execPath,[cli,'wechat',...f.args],{env:f.env});
  const current=await f.request('/api');assert.equal(current.processId,initial.processId);assert.equal(current.persistent,true);assert.equal(current.clients,1);
  web.kill('SIGTERM');await eventually(async () => assert.equal((await f.request('/api')).clients,0),clientExpiryTimeout);
  await delay(6500);assert.equal((await f.request('/api')).processId,initial.processId);
});

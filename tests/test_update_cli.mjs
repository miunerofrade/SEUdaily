import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,writeFile,cp,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:net';
import {existsSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {VERSION} from '../src/distribution/config.ts';
const exec=promisify(execFile);

for(const failInstall of [false,true]) test(failInstall ? 'real failed update restores the host, restarts old backend and removes rollback scratch' : 'real update CLI replaces the backend and reclaims previous environment after health', {timeout:30_000}, async t=>{
 const root=await mkdtemp(join(tmpdir(),'seudaily-update-cli-'));
 t.after(()=>rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
 const install=join(root,'node_modules','seudaily'),data=join(root,'data'),cache=join(root,'cache');
 await mkdir(join(install,'dist'),{recursive:true});await mkdir(join(install,'bin'));await mkdir(data);
 await cp(resolve('dist/launcher.mjs'),join(install,'dist/launcher.mjs'));
 await writeFile(join(install,'package.json'),JSON.stringify({name:'seudaily',version:'0.0.1'}));
 const listener=createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
 const api='http://127.0.0.1:'+port;
 const previousVersion='0.0.1';
 const backend=version=>`import http from 'node:http';import fs from 'node:fs';import path from 'node:path';
const leases=path.join(process.env.SEUDAILY_CACHE_DIR,'leases');fs.mkdirSync(leases,{recursive:true});const lease=path.join(leases,process.pid+'.json');fs.writeFileSync(lease,JSON.stringify({pid:process.pid,version:${JSON.stringify(version)}}));process.once('exit',()=>{try{fs.unlinkSync(lease);}catch{}});
const args=process.argv.slice(2),port=Number(args[args.indexOf('--port')+1]),dataRoot=args[args.indexOf('--data-dir')+1];
const server=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');
if(req.url==='/api')return res.end(JSON.stringify({name:'SEUdaily',runtime:'agent',protocol:1,version:${JSON.stringify(version)},dataRoot,processId:process.pid,persistent:true,managed:false,web:false}));
if(req.url==='/app/health')return res.end(JSON.stringify({status:'ok'}));
if(req.url==='/app/runtime/stop'){res.end('{}');setTimeout(()=>process.exit(0),50);return;}
res.statusCode=404;res.end('{}');});server.listen(port,'127.0.0.1');`;
 await writeFile(join(install,'bin/seudaily.mjs'),backend(previousVersion));
 const npm=join(root,'npm-cli.js');
 await writeFile(npm,`const fs=require('fs');if(process.argv[2]==='root')console.log(${JSON.stringify(join(root,'node_modules'))});else{fs.writeFileSync(${JSON.stringify(join(install,'package.json'))},JSON.stringify({name:'seudaily',version:'99.0.0'}));fs.writeFileSync(${JSON.stringify(join(install,'bin/seudaily.mjs'))},${JSON.stringify(backend('99.0.0'))});if(${failInstall})process.exit(1);}`);
 const loader=join(root,'registry.mjs');await writeFile(loader,`const real=globalThis.fetch;globalThis.fetch=(url,options)=>String(url).startsWith('https://registry.npmjs.org/')?Promise.resolve(new Response(JSON.stringify({version:'99.0.0'}),{status:200})):real(url,options);`);
 await mkdir(join(cache,'python',previousVersion),{recursive:true});await writeFile(join(cache,'python',previousVersion,'ready.json'),'{}');
 const old=spawn(process.execPath,[join(install,'bin/seudaily.mjs'),'serve','--data-dir',data,'--port',String(port)],{stdio:'ignore',env:{...process.env,SEUDAILY_CACHE_DIR:cache}});
 try {
  for(let n=0;n<100;n++){if(await fetch(api+'/api').then(r=>r.ok).catch(()=>false))break;await delay(30);}
  const before=await fetch(api+'/api').then(r=>r.json());assert.equal(before.version,previousVersion);
  let result;
  try { result=await exec(process.execPath,[join(install,'dist/launcher.mjs'),'update','--data-dir',data,'--port',String(port)],{
   env:{...process.env,SEUDAILY_CACHE_DIR:cache,npm_execpath:npm,NODE_OPTIONS:'--import='+loader},timeout:20_000,
  }); } catch(error) { if(!failInstall) throw error;assert.equal(error.code,1); }
  if(!failInstall)assert.match(result.stdout,/新后端已就绪/);
  const after=await fetch(api+'/api').then(r=>r.json());assert.equal(after.version,failInstall?previousVersion:'99.0.0');assert.notEqual(after.processId,before.processId);
  assert.equal(existsSync(join(cache,'python',previousVersion)),failInstall);
  assert.deepEqual(await readdir(join(cache,'updates')),[]);
  assert.ok(!existsSync(join(root,'node_modules','.seudaily-update.lock')));
 } finally {
  await fetch(api+'/app/runtime/stop',{method:'POST'}).catch(()=>{});old.kill();await delay(150);
  await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
 }
});

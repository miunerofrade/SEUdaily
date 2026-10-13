import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readdir,rm,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {existsSync} from 'node:fs';
import {cleanVersionCache,registerCacheUse} from '../src/distribution/cache-maintenance.ts';
const inactive=async()=>[];
const options={currentVersion:'2.0.0',activeVersions:inactive,pruneUv:false};
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'seudaily-cleanup-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
async function dir(root,name){await mkdir(join(root,name),{recursive:true});return join(root,name);}

test('old inactive components and environments are removed, current version and data kept',async t=>{
 const root=await fixture(t);
 for(const path of ['python/1.0.0','python/2.0.0','components/1.0.0/web','components/2.0.0/python','python-runtime/cpython-3.13','browsers/chromium','uv-cache','exports'])await dir(root,path);
 const r=await cleanVersionCache(root,options);
 assert.equal(r.removed.length,2);
 assert.ok(!existsSync(join(root,'python/1.0.0')));
 for(const path of ['python/2.0.0','components/2.0.0/python','python-runtime/cpython-3.13','browsers/chromium','uv-cache','exports'])assert.ok(existsSync(join(root,path)));
 assert.ok(!existsSync(join(root,'maintenance.lock')));
});
test('live leases, legacy services and active installer locks retain old versions',async t=>{
 const root=await fixture(t);
 const close=await registerCacheUse(root,'1.0.0');t.after(close);
 await dir(root,'python/1.0.0');await dir(root,'python/1.1.0');await dir(root,'components/1.2.0/web');
 const lock=await dir(root,'components/1.2.0/web.lock');await writeFile(join(lock,'owner.json'),JSON.stringify({pid:process.pid}));
 await cleanVersionCache(root,{...options,activeVersions:async()=>['1.1.0']});
 assert.ok(existsSync(join(root,'python/1.0.0')));assert.ok(existsSync(join(root,'python/1.1.0')));assert.ok(existsSync(join(root,'components/1.2.0')));
 close();await cleanVersionCache(root,options);
 assert.ok(!existsSync(join(root,'python/1.0.0')));assert.ok(!existsSync(join(root,'python/1.1.0')));
});
test('crashed install residues and stale leases are removed but live installs stay',async t=>{
 const root=await fixture(t);const dead=2147483647;
 await dir(root,'leases');await writeFile(join(root,'leases/dead.json'),JSON.stringify({pid:dead,version:'1.0.0'}));
 await dir(root,`components/2.0.0/web.install-${dead}`);await dir(root,`components/2.0.0/python.install-${process.pid}`);
 const lock=await dir(root,'python/1.0.0.lock');await writeFile(join(lock,'owner.json'),JSON.stringify({pid:dead}));
 await cleanVersionCache(root,options);
 assert.deepEqual(await readdir(join(root,'leases')),[]);
 assert.ok(!existsSync(join(root,`components/2.0.0/web.install-${dead}`)));
 assert.ok(existsSync(join(root,`components/2.0.0/python.install-${process.pid}`)));
 assert.ok(!existsSync(lock));
});
test('unknown service state skips deletion and directory symlinks cannot escape cleanup',async t=>{
 const root=await fixture(t),outside=await fixture(t);
 await dir(root,'python/1.0.0');await writeFile(join(outside,'original'),'keep');await dir(root,'components');
 await symlink(outside,join(root,'components/1.0.0'),process.platform==='win32'?'junction':'dir');
 const skipped=await cleanVersionCache(root,{...options,activeVersions:async()=>{throw Error('unavailable');}});
 assert.equal(skipped.removed.length,0);assert.equal(skipped.warnings.length,1);
 const report=await cleanVersionCache(root,options);assert.equal(report.removed.length,1);
 assert.ok(existsSync(join(outside,'original')));
});
test('cleanup and new version registration serialize to protect a live lease',async t=>{
 const root=await fixture(t);await dir(root,'python/1.0.0');
 const close=await registerCacheUse(root,'1.0.0');t.after(close);
 const reports=await Promise.all([cleanVersionCache(root,options),cleanVersionCache(root,options)]);
 assert.ok(reports.every(r=>r.removed.length===0));assert.ok(existsSync(join(root,'python/1.0.0')));
});

test('uv cache links are retained rather than breaking an installed environment',async t=>{
 const root=await fixture(t);
 await dir(root,'uv-cache/archive');await dir(root,'python/2.0.0/venv');
 await symlink(join(root,'uv-cache/archive'),join(root,'python/2.0.0/venv/package'),process.platform==='win32'?'junction':'dir');
 const report=await cleanVersionCache(root,{...options,pruneUv:true,uvCommand:join(root,'must-not-run')});
 assert.equal(report.uvPruned,false);assert.ok(report.warnings.some(w=>w.includes('符号链接')));
 assert.ok(existsSync(join(root,'uv-cache/archive')));
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {completeUpdate} from '../src/distribution/update-lifecycle.ts';
const old={name:'SEUdaily',protocol:1,dataRoot:'/data',version:'1.0.0',processId:7,persistent:true,web:true};
function setup(failure){
 let running={...old};const calls=[];
 const update={version:{current:'1.0.0',latest:'2.0.0',available:true},install:async()=>{calls.push('install');if(failure==='install')throw Error('install failed');},rollback:async()=>calls.push('rollback'),finalize:async()=>calls.push('finalize')};
 const hooks={probe:async()=>running,stop:async identity=>{assert.equal(identity.dataRoot,'/data');calls.push('stop:'+identity.version);running=undefined;},start:async(identity,version)=>{calls.push('start:'+version);assert.equal(identity.persistent,true);assert.equal(identity.web,true);if(failure==='start'&&version==='2.0.0')throw Error('start failed');running={...identity,version};},healthy:async()=>{calls.push('health:'+running.version);if(failure==='health'&&running.version==='2.0.0')throw Error('health failed');},cleanup:async version=>calls.push('cleanup:'+version)};
 return {calls,update,hooks,identity:()=>running};
}
test('update automatically stops, installs, restarts, checks readiness, then cleans',async()=>{
 const f=setup();await completeUpdate(f.update,'/data',1,f.hooks);
 assert.deepEqual(f.calls,['stop:1.0.0','install','start:2.0.0','health:2.0.0','finalize','cleanup:2.0.0']);
 assert.equal(f.identity().version,'2.0.0');
});
for(const failure of ['install','start','health'])test(`${failure} failure restores original backend without deleting caches`,async()=>{
 const f=setup(failure);await assert.rejects(completeUpdate(f.update,'/data',1,f.hooks),/failed/);
 assert.equal(f.identity().version,'1.0.0');assert.ok(f.calls.includes('rollback'));
 assert.ok(!f.calls.includes('finalize'));assert.ok(!f.calls.some(c=>c.startsWith('cleanup')));
});
test('foreign backend and no available update leave running services intact',async()=>{
 const f=setup();f.hooks.probe=async()=>({...old,dataRoot:'/other'});
 await assert.rejects(completeUpdate(f.update,'/data',1,f.hooks),/未执行更新/);assert.deepEqual(f.calls,[]);
 assert.equal(await completeUpdate({version:f.update.version},'/data',1,f.hooks),false);
});
test('update without running backend installs and cleans without starting one',async()=>{
 const f=setup();f.hooks.probe=async()=>undefined;await completeUpdate(f.update,'/data',1,f.hooks);
 assert.deepEqual(f.calls,['install','finalize','cleanup:2.0.0']);
});

test('old and new systemd user services are verified before control operations',async()=>{
 const {systemdUnit}=await import('../src/distribution/systemd-update.ts');
 const membership=async()=> '0::/user.slice/app.slice/seudaily-custom.service\n';
 const group=async unit=>{assert.equal(unit,'seudaily-custom.service');return '/user.slice/app.slice/seudaily-custom.service';};
 assert.equal(await systemdUnit(old,'linux',membership,group),'seudaily-custom.service');
 assert.equal(await systemdUnit({...old,serviceManager:'systemd-user',serviceUnit:'seudaily-custom.service'},'linux',membership,group),'seudaily-custom.service');
 await assert.rejects(systemdUnit(old,'linux',membership,async()=>'/other.service'),/未停止后端/);
 assert.equal(await systemdUnit(old,'darwin',()=>assert.fail()),undefined);
});

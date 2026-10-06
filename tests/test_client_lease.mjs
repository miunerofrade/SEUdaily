import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientLease } from '../src/distribution/client-lease.ts';

test('expired leases are re-registered after validating a compatible restarted backend',async()=>{
  const calls=[];let expired=false,next=0,verified=0;
  const request=async(path,method,body)=>{
    calls.push({path,method,body});
    if(path==='/app/runtime/clients')return {id:'id-'+ ++next};
    if(path==='/api')return {version:'compatible'};
    if(expired&&method==='POST'&&path.endsWith('/id-1'))throw Object.assign(new Error('expired'),{status:404});
    return {};
  };
  const lease=await clientLease(request,value=>{assert.equal(value.version,'compatible');verified++;},'cli');
  await lease.renew();assert.equal(next,1);expired=true;
  await Promise.all([lease.renew(),lease.renew()]);assert.equal(next,2);assert.equal(verified,1);
  await lease.renew();await lease.close();await lease.renew();
  assert.equal(calls.at(-1).path,'/app/runtime/clients/id-2');assert.equal(calls.at(-1).method,'DELETE');
  assert.equal(calls.filter(call=>call.path==='/app/runtime/clients').length,2);
});

test('replacement version or data directory must be compatible before registering again',async()=>{
  let registrations=0;
  const request=async(path,method)=>{
    if(path==='/app/runtime/clients'){registrations++;return {id:'old'};}
    if(path==='/api')return {version:'different',dataRoot:'other'};
    if(method==='DELETE')return {};
    throw Object.assign(new Error('expired'),{status:404});
  };
  const lease=await clientLease(request,()=>{throw new Error('incompatible');},'cli');
  await assert.rejects(lease.renew(),/incompatible/);assert.equal(registrations,1);await lease.close();
});

test('network failures retry the original lease instead of registering duplicates',async()=>{
  let registrations=0,offline=true;
  const request=async(path)=>{
    if(path==='/app/runtime/clients'){registrations++;return {id:'original'};}
    if(offline)throw new Error('offline');return {};
  };
  const lease=await clientLease(request,()=>assert.fail('no restart detected'),'cli');
  await assert.rejects(lease.renew(),/offline/);offline=false;await lease.renew();await lease.close();assert.equal(registrations,1);
});

test('Web assets are restored after restart and failed preparation can retry without another registration',async()=>{
  let registrations=0,assets=0;
  const request=async(path)=>{
    if(path==='/app/runtime/clients')return {id:'id-'+ ++registrations};
    if(path==='/api')return {};
    if(path==='/app/runtime/clients/id-1')throw Object.assign(new Error('expired'),{status:404});
    if(path==='/app/runtime/web'){assets++;if(assets===1)throw new Error('download failed');}
    return {};
  };
  const lease=await clientLease(request,()=>{},'web');
  await assert.rejects(lease.renew(),/download failed/);await lease.renew();await lease.close();
  assert.equal(registrations,2);assert.equal(assets,2);
});

test('closing during registration releases the new lease and never leaves an orphan client',async()=>{
  let registrations=0,release;const gate=new Promise(resolve=>release=resolve),deleted=[];
  const request=async(path,method)=>{
    if(path==='/app/runtime/clients'){if(++registrations===2)await gate;return {id:'id-'+registrations};}
    if(method==='DELETE'){deleted.push(path);return {};}
    if(path==='/api')return {};
    throw Object.assign(new Error('expired'),{status:404});
  };
  const lease=await clientLease(request,()=>{},'cli');const renewing=lease.renew();
  while(registrations<2)await new Promise(resolve=>setImmediate(resolve));
  const closing=lease.close();release();await renewing;await closing;
  assert.deepEqual(deleted,['/app/runtime/clients/id-2']);
});

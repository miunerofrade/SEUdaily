import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseLsofListeners,parseSsListeners,parseWindowsListeners,discoverServices,isServiceCommand} from '../src/distribution/services.ts';
import {parseCommand} from '../src/distribution/arguments.ts';
test('ps and targeted stop arguments',()=>{
  assert.equal(parseCommand(['ps']).command,'ps');assert.equal(parseCommand(['stop','123']).pid,123);
  assert.equal(parseCommand(['stop','--port','4112']).port,4112);assert.equal(parseCommand(['stop']).pid,undefined);
  for(const args of [['stop','0'],['stop','-1'],['stop','abc'],['stop','1','2']])assert.throws(()=>parseCommand(args));
});
test('listener parsers select Node TCP ports, including IPv6',()=>{
  assert.deepEqual(parseLsofListeners('p123\ncnode\nf9\nn127.0.0.1:4111\nf10\nn[::1]:4111\np789\ncother\nn*:9999\np456\ncnode\nn*:4112\n'),[{pid:123,port:4111},{pid:123,port:4111},{pid:456,port:4112}]);
  assert.deepEqual(parseSsListeners('State Recv-Q Send-Q Local Address:Port Peer Address:Port Process\nLISTEN 0 511 127.0.0.1:4111 0.0.0.0:* users:(("node",pid=123,fd=9))\nLISTEN 0 511 [::1]:4112 [::]:* users:(("node",pid=456,fd=8))'),[{pid:123,port:4111},{pid:456,port:4112}]);
});
test('discovery lists multiple SEUdaily backends, old versions and removes duplicate listeners',async()=>{
  const calls=[];
  const services=await discoverServices(async()=>[{pid:123,port:4111},{pid:123,port:4111},{pid:456,port:4112},{pid:789,port:8000},{pid:789,port:8001}],async pid=>pid===123?'node --import tsx src/server/main.ts':pid===456?'node /installed/seudaily/dist/core.mjs':'node unrelated.mjs',async port=>{calls.push(port);return port===4111?{name:'SEUdaily',runtime:'agent'}:{name:'SEUdaily',runtime:'agent',processId:456,dataRoot:'/data',version:'1.0.0',persistent:true};});
  assert.equal(services.length,2);assert.equal(services[0].legacy,true);assert.equal(services[1].persistent,true);assert.deepEqual(calls.sort(),[4111,4112]);
  assert.ok(isServiceCommand('node "C:\\SEUdaily\\dist\\core.mjs"'));
});
test('foreign identities and mismatched process IDs are rejected',async()=>{
  for(const identity of [{name:'Other',runtime:'agent'},{name:'SEUdaily',runtime:'agent',processId:999}])assert.deepEqual(await discoverServices(async()=>[{pid:123,port:4111}],async()=> 'node dist/core.mjs',async()=>identity),[]);
});

test('Windows discovery handles a single listener, multiple listeners and an empty result',()=>{
  assert.deepEqual(parseWindowsListeners('{"pid":123,"port":4111}'),[{pid:123,port:4111}]);
  assert.deepEqual(parseWindowsListeners('[{"pid":123,"port":4111},{"pid":456,"port":4112}]'),[{pid:123,port:4111},{pid:456,port:4112}]);
  assert.deepEqual(parseWindowsListeners(''),[]);assert.deepEqual(parseWindowsListeners('null'),[]);
});

test('batch process metadata avoids a shell invocation per listener on Windows',async()=>{
  const listeners=parseWindowsListeners('[{"pid":123,"port":4111,"command":"node dist/core.mjs"}]');
  const services=await discoverServices(async()=>listeners,async()=>assert.fail('command is already in the OS snapshot'),async()=>({name:'SEUdaily',runtime:'agent',processId:123}));
  assert.equal(services.length,1);assert.equal(services[0].pid,123);
});

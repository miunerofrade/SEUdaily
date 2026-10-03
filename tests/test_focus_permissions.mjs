import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {resolveFocusPermission} from '../src/runtime/focus-permission.ts';
import {setFullAccessEnabled,setFullAccessExtraEnabled,isFullAccessEnabled,isFullAccessExtraEnabled,isUnapprovedAccessEnabled} from '../src/runtime/permission-state.ts';
import {promptVersionGroups} from '../apps/web/src/prompt-versions.tsx';

test('only a persisted Focus thread gets the scoped grant, never resource or client flags alone',async t=>{
 const root=await mkdtemp(join(tmpdir(),'seudaily-focus-permissions-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const file=join(root,'focus.json');await writeFile(file,JSON.stringify({items:[{id:'focus-a',threadId:'focus-a',resourceId:'seudaily-focus-local'}]}));
 assert.equal(await resolveFocusPermission({threadId:'focus-a',resourceId:'seudaily-focus-local'},file),true);
 assert.equal(await resolveFocusPermission({threadId:'ordinary',resourceId:'seudaily-focus-local',focus:true},file),false);
 assert.equal(await resolveFocusPermission({threadId:'focus-a',resourceId:'seudaily-web-local'},file),false);
 await writeFile(file,JSON.stringify({items:[]}));
 assert.equal(await resolveFocusPermission({threadId:'focus-a',resourceId:'seudaily-focus-local'},file),false);
});

test('Focus receives full without extra and cannot mutate ordinary session permissions',()=>{
 const focus={requestContext:new Map([['seudailyFocus',true]])};
 const oldFull=isFullAccessEnabled(),oldExtra=isFullAccessExtraEnabled();
 try {
  for(const full of [false,true])for(const extra of [false,true]){
   setFullAccessEnabled(full);setFullAccessExtraEnabled(extra);
   assert.equal(isFullAccessEnabled(focus),true);assert.equal(isUnapprovedAccessEnabled(focus),true);assert.equal(isFullAccessExtraEnabled(focus),false);
   assert.equal(isFullAccessEnabled(),full);assert.equal(isFullAccessExtraEnabled(),extra);
  }
 }finally{setFullAccessEnabled(oldFull);setFullAccessExtraEnabled(oldExtra);}
});

test('both prompt edits and regenerated replies expose controls on the user prompt',()=>{
 const nodes=[{id:'u1',parentId:null,role:'user'},{id:'a1',parentId:'u1',role:'assistant'},{id:'a2',parentId:'u1',role:'assistant'},{id:'u2',parentId:null,role:'user'},{id:'a3',parentId:'u2',role:'assistant'}];
 const groups=promptVersionGroups(nodes,nodes[0],'a2');
 assert.deepEqual(groups.map(group=>[group.label,group.current,group.nodes.length]),[['提示词','u1',2],['回答','a2',2]]);
 assert.deepEqual(promptVersionGroups(nodes,nodes[2],'a2'),[]);
 assert.equal(promptVersionGroups(nodes,nodes[3],'a3')[0].current,'u2');
});

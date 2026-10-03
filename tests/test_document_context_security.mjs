import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, symlinkSync, unlinkSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { storeDocumentContext, resolveDocumentContexts } from '../src/runtime/document-context.ts';
const directory=join(tmpdir(),`seudaily-document-context-${process.getuid?.()??'user'}`);
test('documents resolve normally while references cannot escape their private directory', t=>{
 const outside=mkdtempSync(join(tmpdir(),'seudaily-document-test-'));t.after(()=>rmSync(outside,{recursive:true,force:true}));
 const target=join(outside,'outside.json'), original=JSON.stringify({name:'secret',markdown:'private',expiresAt:Date.now()+100000});writeFileSync(target,original);
 const ref=randomUUID();storeDocumentContext(ref,'doc','markdown');t.after(()=>{try{unlinkSync(join(directory,ref+'.json'));}catch{}});
 assert.deepEqual(resolveDocumentContexts([ref]),[{name:'doc',markdown:'markdown'}]);
 assert.deepEqual(resolveDocumentContexts([target.slice(0,-5),'../outside','../'+outside.split('/').at(-1)+'/outside']),[]);assert.equal(readFileSync(target,'utf8'),original);
 assert.throws(()=>storeDocumentContext('../outside','bad','bad'),/格式/);
 const link=randomUUID();symlinkSync(target,join(directory,link+'.json'));t.after(()=>unlinkSync(join(directory,link+'.json')));
 assert.deepEqual(resolveDocumentContexts([link]),[]);assert.throws(()=>storeDocumentContext(link,'bad','bad'));assert.equal(readFileSync(target,'utf8'),original);
});
test('invalid and expired context files are not rewritten or deleted', t=>{
 mkdirSync(directory,{recursive:true,mode:0o700});
 for(const contents of ['{"name":"bad"}',JSON.stringify({name:'old',markdown:'old',expiresAt:1})]){
  const ref=randomUUID(),path=join(directory,ref+'.json');writeFileSync(path,contents,{mode:0o600});t.after(()=>unlinkSync(path));
  assert.deepEqual(resolveDocumentContexts([ref]),[]);assert.equal(readFileSync(path,'utf8'),contents);
 }
});

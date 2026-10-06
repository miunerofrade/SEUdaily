import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, symlinkSync, unlinkSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { storeDocumentContext, resolveDocumentContexts, contextDirectory } from '../src/runtime/document-context.ts';
const directory=contextDirectory;
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

test('all ten document contexts reach the prompt resolver', t => {
 const refs = Array.from({length:10}, () => randomUUID());
 refs.forEach((ref,index) => {
  storeDocumentContext(ref, `document-${index}`, `content-${index}`);
  t.after(() => unlinkSync(join(directory, ref+'.json')));
 });
 const resolved = resolveDocumentContexts(refs);
 assert.equal(resolved.length, 10);
 assert.equal(resolved.at(-1).markdown, 'content-9');
});

test('document contexts survive an independent process restart with the same data root', async t => {
 const {execFile} = await import('node:child_process');
 const {promisify} = await import('node:util');
 const {pathToFileURL} = await import('node:url');
 const root = mkdtempSync(join(tmpdir(),'seudaily-doc-restart-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const moduleUrl = pathToFileURL(join(import.meta.dirname,'../src/runtime/document-context.ts')).href;
 const env = {...process.env,SEUDAILY_PROJECT_ROOT:root,SEUDAILY_INSTALL_ROOT:join(import.meta.dirname,'..')};
 const ref=randomUUID();
 const exec=promisify(execFile);
 await exec(process.execPath,['--import','tsx','--input-type=module','-e',`import {storeDocumentContext} from ${JSON.stringify(moduleUrl)}; storeDocumentContext(${JSON.stringify(ref)},'课程.pdf','parsed markdown');`],{env});
 const result=await exec(process.execPath,['--import','tsx','--input-type=module','-e',`import {resolveDocumentContexts} from ${JSON.stringify(moduleUrl)}; process.stdout.write(JSON.stringify(resolveDocumentContexts([${JSON.stringify(ref)}])));`],{env});
 assert.deepEqual(JSON.parse(result.stdout),[{name:'课程.pdf',markdown:'parsed markdown'}]);
});

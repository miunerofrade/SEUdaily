/** Disk protocol shared with Python saved_web_files; does not trigger migrations or downloads. */
import {createHash} from 'node:crypto';
import {readFile,realpath,lstat} from 'node:fs/promises';
import {resolve,relative,isAbsolute} from 'node:path';
import protocol from '../seudaily/web_files_protocol.json' with {type:'json'};

export {protocol as webFilesProtocol};
export const sha256=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
export function within(root:string,path:string) {
  const child=relative(root,path);
  return Boolean(child) && child!=='..' && !child.startsWith('../') && !child.startsWith('..\\') && !isAbsolute(child);
}
export function webFilesLayout(runtimeRoot:string) {
  const root=resolve(runtimeRoot,protocol.directory);
  return {root,files:resolve(root,protocol.filesDirectory),metadata:resolve(root,protocol.metadataDirectory)};
}
export function webMetadataPath(runtimeRoot:string,url:string) {
  return resolve(webFilesLayout(runtimeRoot).metadata,sha256(url)+'.json');
}
export function validSourceId(value:unknown):value is string {return typeof value==='string' && new RegExp(protocol.sourceIdPattern).test(value);}
export function validNoticeId(value:unknown):value is string {return typeof value==='string' && new RegExp(protocol.noticeIdPattern).test(value);}
export function validSectionId(value:unknown):value is string {return typeof value==='string' && new RegExp(protocol.sectionIdPattern).test(value);}
export type SavedWebFile={url?:string;name:string;path:string;sha256:string;[key:string]:unknown};
export async function readSavedWebFile(runtimeRoot:string,url:string):Promise<{item:SavedWebFile;bytes:Buffer}|null> {
  try {
    const layout=webFilesLayout(runtimeRoot),canonicalRuntime=await realpath(runtimeRoot),root=await realpath(layout.root);
    if(!within(canonicalRuntime,root))return null;
    const files=await realpath(layout.files),metadata=await realpath(layout.metadata);
    if(!within(root,files) || !within(root,metadata))return null;
    const record=webMetadataPath(runtimeRoot,url);
    if((await lstat(record)).isSymbolicLink())return null;
    const item=JSON.parse(await readFile(record,'utf8')) as SavedWebFile;
    if(typeof item.name!=='string' || typeof item.path!=='string' || typeof item.sha256!=='string' || !new RegExp(protocol.sha256Pattern).test(item.sha256) || item.url && item.url!==url)return null;
    if(!(await lstat(item.path)).isFile())return null;
    const path=await realpath(item.path);
    if(!within(files,path))return null;
    const bytes=await readFile(path);
    return sha256(bytes)===item.sha256 ? {item,bytes} : null;
  }catch{return null;}
}

import {createDecipheriv} from 'node:crypto';
import {basename} from 'node:path';
export type WeChatFile = {file_name?:string;len?:string;media?:{full_url?:string;encrypt_query_param?:string;aes_key?:string;encrypt_type?:number}};
const limit=50*1024*1024;
export function mediaKey(value:string) {
  let key:Buffer;
  if (/^[a-f0-9]{32}$/i.test(value)) key=Buffer.from(value,'hex');
  else {
    key=Buffer.from(value,'base64');
    if (/^[a-f0-9]{32}$/i.test(key.toString())) key=Buffer.from(key.toString(),'hex');
  }
  if (key.length!==16) throw new Error('微信附件加密密钥无效');
  return key;
}
export async function downloadWeChatFile(file:WeChatFile,signal:AbortSignal,transport:typeof fetch=fetch) {
  const name=basename((file.file_name || '未命名文件').replace(/\\/g,'/')).replace(/[\0\r\n]/g,' ').slice(0,240);
  if (file.len !== undefined && (!/^\d+$/.test(file.len) || Number(file.len)>limit)) throw new Error('微信附件超过 50 MB 或大小无效');
  const media=file.media;
  if (!media?.aes_key || (!media.full_url && !media.encrypt_query_param)) throw new Error('微信未提供可下载的文件内容，请重新发送原文件');
  if (media.encrypt_type !== undefined && media.encrypt_type!==1) throw new Error('不支持该微信附件加密方式');
  const key=mediaKey(media.aes_key);
  const url=new URL(media.full_url || 'https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param='+encodeURIComponent(media.encrypt_query_param!));
  if (url.protocol!=='https:' || !url.hostname.endsWith('.cdn.weixin.qq.com') || url.username || url.password || url.port) throw new Error('微信附件下载地址不可信');
  const response=await transport(url,{signal,redirect:'error'});
  if (!response.ok) throw new Error('微信附件下载失败（HTTP '+response.status+'）');
  if (!response.body || Number(response.headers.get('content-length'))>limit+16) throw new Error('微信附件超过 50 MB 或内容为空');
  const chunks:Buffer[]=[];let size=0;const reader=response.body.getReader();
  try {for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>limit+16)throw new Error('微信附件超过 50 MB');chunks.push(Buffer.from(value));}}
  finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
  let bytes:Buffer;
  try {const decipher=createDecipheriv('aes-128-ecb',key,null);bytes=Buffer.concat([decipher.update(Buffer.concat(chunks)),decipher.final()]);}
  catch {throw new Error('微信附件解密失败，请重新发送原文件');}
  if (!bytes.length || bytes.length>limit || file.len !== undefined && Number(file.len)!==bytes.length) throw new Error('微信附件大小与内容不符');
  return {name,bytes};
}

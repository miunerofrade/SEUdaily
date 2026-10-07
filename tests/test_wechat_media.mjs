import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createCipheriv} from 'node:crypto';
import {mediaKey,downloadWeChatFile} from '../src/wechat/media.ts';
const key=Buffer.from('00112233445566778899aabbccddeeff','hex');
const bytes=Buffer.from('你好，课程文件');
function encrypted(){const cipher=createCipheriv('aes-128-ecb',key,null);return Buffer.concat([cipher.update(bytes),cipher.final()]);}
function file(){return {file_name:'../课程说明.txt',len:String(bytes.length),media:{aes_key:key.toString('hex'),encrypt_query_param:'private-param&x=1',encrypt_type:1}};}
test('official CDN media AES formats decrypt the original bytes without forwarding bot credentials',async()=>{
 for(const encoded of [key.toString('hex'),key.toString('base64'),Buffer.from(key.toString('hex')).toString('base64')]) {
  assert.deepEqual(mediaKey(encoded),key);const input=file();input.media.aes_key=encoded;
  const result=await downloadWeChatFile(input,new AbortController().signal,async(url,options)=>{
   assert.equal(url.hostname,'novac2c.cdn.weixin.qq.com');assert.equal(url.searchParams.get('encrypted_query_param'),'private-param&x=1');assert.equal(options.headers,undefined);assert.equal(options.redirect,'error');return new Response(encrypted());
  });assert.equal(result.name,'课程说明.txt');assert.deepEqual(result.bytes,bytes);
 }
});
test('invalid media hosts, keys, lengths and ciphertext cannot reach storage',async()=>{
 let calls=0;const transport=async()=>{calls++;return new Response(encrypted());},signal=new AbortController().signal;
 for(const url of ['http://novac2c.cdn.weixin.qq.com/c2c/download','https://localhost/file','https://cdn.weixin.qq.com.evil.test/file','https://user:secret@novac2c.cdn.weixin.qq.com/file']) {
  const input=file();input.media.full_url=url;await assert.rejects(downloadWeChatFile(input,signal,transport),/不可信/);
 }assert.equal(calls,0);
 const tooLarge=file();tooLarge.len=String(51*1024*1024);await assert.rejects(downloadWeChatFile(tooLarge,signal,transport),/50 MB/);assert.equal(calls,0);
 const noKey=file();delete noKey.media.aes_key;await assert.rejects(downloadWeChatFile(noKey,signal,transport),/重新发送/);
 assert.throws(()=>mediaKey('bad'),/密钥无效/);
 const wrongSize=file();wrongSize.len='1';await assert.rejects(downloadWeChatFile(wrongSize,signal,transport),/大小与内容/);
 await assert.rejects(downloadWeChatFile(file(),signal,async()=>new Response('invalid ciphertext')),/解密失败/);
 await assert.rejects(downloadWeChatFile(file(),signal,async()=>new Response('x',{headers:{'content-length':String(51*1024*1024)}})),/50 MB/);
});

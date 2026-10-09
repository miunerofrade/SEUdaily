import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { register } from 'tsx/esm/api';
register();
const { loadServerConversations, loadConversationMessages } = await import('../apps/web/src/api.ts');
const { messageContent, editedDocumentContent, writeConversationCache } = await import('../apps/web/src/conversation-cache.ts');

const stamp = '2026-10-03T00:00:00.000Z';
const thread = id => ({ id, resourceId: 'seudaily-web-local', title: id, createdAt: stamp, updatedAt: stamp, metadata: { activeLeaf: 'a2' } });

test('history list loads every page without fetching every conversation body', async () => {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async input => {
    const url = new URL(input, 'http://localhost'); requests.push(url);
    assert.equal(url.pathname, '/app/conversations');
    assert.equal(url.searchParams.get('resourceId'),null,'clients do not enumerate resource IDs');
    const records = url.searchParams.get('page') === '0' ? Array.from({ length: 100 }, (_, i) => thread(`t${i}`))
      : [thread('t100'),{...thread('wechat-session'),resourceId:'seudaily-wechat-local',title:'复习',source:'微信'},
        {...thread('future-session'),resourceId:'future-mobile',title:'未来客户端',source:'mobile'}];
    return Response.json({ threads: records });
  };
  try {
    const conversations = await loadServerConversations();
    assert.equal(conversations.length, 103);
    assert.equal(requests.length, 2);
    assert.equal(conversations.find(item=>item.id==='wechat-session').resourceId,'seudaily-wechat-local');
    assert.equal(conversations.find(item=>item.id==='future-session').source,'mobile');
    assert.ok(conversations.every(item => item.messagesLoaded === false && item.messages.length === 0));
  } finally { globalThis.fetch = original; }
});

test('any HTTP failure rejects history synchronization instead of authorizing cache deletion', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('unavailable', { status: 503 });
  try {
    await assert.rejects(loadServerConversations(), /503/);
    await assert.rejects(loadConversationMessages({ ...thread('t'), createdAt: 0, updatedAt: 0, messages: [] }), /503/);
  } finally { globalThis.fetch = original; }
});

test('selected history restores all pages, branch parents and document text', async () => {
  const original = globalThis.fetch;
  const section = '\n\n<!-- seudaily:documents -->\n【附件：notes.pdf】\n【字符数：6】\nsecret';
  globalThis.fetch = async input => {
    const page = new URL(input, 'http://localhost').searchParams.get('page');
    return Response.json(page === '0' ? { messages: [{ id: 'a2', role: 'assistant', createdAt: stamp, content: { parentId: 'u', content: 'branch 2' } }], hasMore: true }
      : { messages: [{ id: 'u', role: 'user', createdAt: stamp, content: { parentId: null, content: 'old' + section } }, { id: 'a1', role: 'assistant', createdAt: stamp, content: { parentId: 'u', content: 'branch 1' } }], hasMore: false });
  };
  try {
    const restored = await loadConversationMessages({ ...thread('t'), activeLeaf: 'a2', createdAt: 0, updatedAt: 0, messages: [] });
    assert.deepEqual(restored.messages.map(item => item.id), ['u', 'a1', 'a2']);
    assert.equal(restored.messages[2].parentId, 'u');
    assert.equal(restored.activeLeaf, 'a2');
    assert.equal(editedDocumentContent('new', restored.messages[0], 'new'), 'new' + section);
  } finally { globalThis.fetch = original; }
});

test('history prompt edits send persistent image references without requiring data URLs', () => {
  const content = messageContent({ id: 'u', role: 'user', content: 'new prompt', attachments: [{ id: 'image', name: 'image', path: '/uploads/hash.png', mediaType: 'image/png' }] });
  assert.equal(content[1].data, 'seudaily-image-ref:hash.png');
  const byRef = messageContent({ id: 'u', role: 'user', content: 'new', attachments: [{ id: 'i', name: 'i', ref: 'seudaily-image-ref:old.png', mediaType: 'image/png' }] });
  assert.equal(byRef[1].data, 'seudaily-image-ref:old.png');
});

test('bounded cache preserves complete branch trees and catches unavailable storage', () => {
  let value;
  const storage = { setItem(_key, data) { value = data; } };
  const messages = [{ id: 'u', role: 'user', content: 'prompt', parentId: null }, { id: 'a1', role: 'assistant', content: 'one', parentId: 'u' }, { id: 'a2', role: 'assistant', content: 'two', parentId: 'u' }];
  writeConversationCache(storage, 'test', [{ id: 't', updatedAt: 1, messages, activeLeaf: 'a2' }]);
  const restored = JSON.parse(value)[0];
  assert.deepEqual(restored.messages, messages);
  assert.equal(restored.activeLeaf, 'a2');
  writeConversationCache(storage, 'test', [{ id: 'large', updatedAt: 2, messages: [{ id: 'big', content: 'x'.repeat(600000) }] }]);
  assert.ok(value.length < 500000);
  assert.equal(JSON.parse(value)[0].messagesLoaded, false);
  assert.equal(writeConversationCache({ setItem() { throw new Error('QuotaExceeded'); } }, 'test', []), false);
});

test('images accept and hydrate 6MB, reject over 10MB and unsafe refs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'seudaily-images-regression-'));
  const previous = process.env.SEUDAILY_PROJECT_ROOT;
  process.env.SEUDAILY_PROJECT_ROOT = directory;
  await writeFile(join(directory, 'package.json'), '{}');
  await writeFile(join(directory, 'pyproject.toml'), '');
  try {
    const { persistImage, hydrateImages } = await import('../src/runtime/images.ts');
    const bytes = Buffer.alloc(6 * 1024 * 1024, 1);
    const part = await persistImage({ type: 'file', data: `data:image/png;base64,${bytes.toString('base64')}`, mediaType: 'image/png' });
    assert.ok(part.image_url.url.startsWith('seudaily-image-ref:'));
    const reference = await persistImage({ type: 'file', data: part.image_url.url, mediaType: 'image/png' });
    assert.equal(reference.image_url.url, part.image_url.url);
    const hydrated = await hydrateImages([{ role: 'user', content: [reference] }]);
    assert.equal(Buffer.from(hydrated[0].content[0].image_url.url.split(',')[1], 'base64').length, bytes.length);
    await assert.rejects(persistImage({ type: 'file', data: `data:image/png;base64,${Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64')}` }), /10MB/);
    await assert.rejects(persistImage({ type: 'file', data: 'seudaily-image-ref:../secret' }), /无效/);
    await assert.rejects(persistImage({ type: 'file', data: 'seudaily-image-ref:missing.png' }), /不存在/);
    await symlink(join(directory, 'package.json'), join(directory, '.seudaily/uploads/images/escape.png'));
    await assert.rejects(persistImage({ type: 'file', data: 'seudaily-image-ref:escape.png' }), /不存在/);
  } finally {
    if (previous === undefined) delete process.env.SEUDAILY_PROJECT_ROOT; else process.env.SEUDAILY_PROJECT_ROOT = previous;
    await rm(directory, { recursive: true, force: true });
  }
});


test('selected history recovers after a brief backend restart without losing saved messages',async()=>{
 const original=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>++calls===1 ? new Response('restarting',{status:500}) : Response.json({messages:[{id:'answer',role:'assistant',createdAt:stamp,content:{content:'已恢复的历史'}}],hasMore:false});
 try {
  const restored=await loadConversationMessages({...thread('t'),createdAt:0,updatedAt:0,messages:[]});
  assert.equal(calls,2);assert.equal(restored.messages[0].content,'已恢复的历史');
 } finally {globalThis.fetch=original;}
});

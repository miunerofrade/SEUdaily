import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeServerConversation } from '../apps/web/src/conversation-sync.ts';

const remote = {id:'wechat', title:'数据结构课程字幕', updatedAt:100, messages:[], messagesLoaded:false};

test('background title updates survive newer local timestamps and keep loaded messages', () => {
  const local = {...remote, title:'微信 · 你好', updatedAt:200, messages:[{id:'answer', content:'回答'}], messagesLoaded:true};
  const merged = mergeServerConversation(remote,local);
  assert.equal(merged.title,remote.title);
  assert.equal(merged.messages,local.messages);
  assert.equal(merged.updatedAt,200);
  assert.equal(local.title,'微信 · 你好');
});

test('title refresh preserves streaming IDs and equal-timestamp hydrated trees', () => {
  for (const streaming of [true,false]) {
    const local = {...remote, title:'旧标题', messages:[{id:'local-answer',streaming}], messagesLoaded:true};
    const merged = mergeServerConversation({...remote, activeLeaf:'leaf'},local);
    assert.equal(merged.title,remote.title);
    assert.equal(merged.messages,local.messages);
    if (!streaming) assert.equal(merged.activeLeaf,'leaf');
  }
  assert.equal(mergeServerConversation(remote),remote);
  const newer = {...remote,updatedAt:300};
  assert.equal(mergeServerConversation(newer,{...remote,updatedAt:100}),newer);
});

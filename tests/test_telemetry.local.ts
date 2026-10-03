import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conversationUsage, telemetryLabel } from '../src/shared/telemetry.js';
test('conversation statistics deduplicate cumulative approval runs and ignore invalid usage', () => {
 const messages = [
  {id:'u',role:'user',usage:{total_tokens:999}},
  {id:'a',role:'assistant',brokerRunToken:'r1',usage:{prompt_tokens:100,completion_tokens:10,total_tokens:110,prompt_cache_hit_tokens:80}},
  {id:'b',role:'assistant',brokerRunToken:'r1',usage:{prompt_tokens:200,completion_tokens:20,total_tokens:220,prompt_cache_hit_tokens:180}},
  {id:'c',role:'assistant',brokerRunToken:'r2',usage:{prompt_tokens:100,completion_tokens:10,total_tokens:110,prompt_cache_hit_tokens:60}},
  {id:'d',role:'assistant',brokerRunToken:'r1'},
  {id:'e',role:'assistant',usage:{total_tokens:-1,completion_tokens:NaN}},
 ];
 const usage = conversationUsage(messages);
 assert.equal(usage.total_tokens,330);
 assert.match(telemetryLabel('deepseek-flash','high',usage),/tokens 330 \(in 300 \/ out 30\) · 缓存 80.0%/);
 assert.deepEqual(conversationUsage([]),{});
 assert.match(telemetryLabel('model','high',{}),/tokens —.*缓存 —/);
});

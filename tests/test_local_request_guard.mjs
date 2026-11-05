import assert from 'node:assert/strict';
import { test } from 'node:test';
import {isLocalRequest,guardLocalRequests} from '../src/runtime/local-request-guard.ts';

test('local API accepts its UI and rejects cross-site requests and DNS rebinding hosts', async () => {
  assert(isLocalRequest('127.0.0.1:4111', undefined));
  assert(isLocalRequest('localhost:4111', 'http://127.0.0.1:4173'));
  for (const [host, origin] of [['attacker.example:4111', undefined], ['127.0.0.1:4111', 'https://attacker.example'], ['127.0.0.1:4111', 'null'], [undefined, undefined]]) {
    assert.equal(isLocalRequest(host, origin), false);
    let invoked = false;
    const result = await guardLocalRequests({ req: { header: (name) => name === 'host' ? host : origin }, json: (body, status) => ({ body, status }) }, async () => { invoked = true; });
    assert.equal(result.status, 403);
    assert.equal(invoked, false);
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../src/terminal/session.ts';

test('terminal SMS preserves the login request and resumes without clearing verified cookies', async () => {
  const calls = [];
  let verified = false;
  let completed = 0;
  const session = Object.create(Session.prototype);
  session.client = { json: async (path, method, payload) => {
    calls.push({ path, payload });
    if (path === '/app/auth/sms') {
      if (payload.operation === 'verify') {
        if (payload.code !== '123456') return { status: 'failed', summary: '验证码错误' };
        verified = true;
      }
      return { status: 'completed' };
    }
    assert.equal(path, '/app/auth-resumes/original/execute');
    return verified ? { status: 'completed', resumeId: 'original' } : { status: 'pending', challengeId: 'challenge' };
  } };
  session.changed = () => {};
  await session.authorizeCampus('/app/auth-resumes/original/execute', async result => { assert.equal(result.resumeId, 'original'); completed++; });
  assert.equal(completed, 0);
  const form = session.form;
  await assert.rejects(form.save({ code: '999999' }), /验证码错误/);
  assert.equal(completed, 0);
  await form.save({ code: '123456' });
  assert.equal(completed, 1);
  assert.deepEqual(calls.filter(call => call.path.endsWith('/execute')).map(call => call.payload.resetSession), [true, false]);
});

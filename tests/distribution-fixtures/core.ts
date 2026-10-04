/** Fixed integration fixture; never contacts an LLM or campus service. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { request as httpRequest } from 'node:http';
import { AgentStore } from '../../src/agent/storage.js';
import { AgentRuntime } from '../../src/agent/runtime.js';
import { z } from 'zod';
import { serve } from '@hono/node-server';
import { app } from '../../src/server/app.js';
import { agentRuntime } from '../../src/runtime/application.js';
import { agentStore } from '../../src/runtime/storage.js';
import { runPythonTool, closePythonWorker } from '../../src/runtime/tools/python-bridge.js';

const mode = process.argv[2] ?? 'core';
const root = process.env.SEUDAILY_PROJECT_ROOT!;
if (mode === 'cli' || mode === 'mcp-child' || mode === 'browser') {
  // A compiled host must load a downloaded JS component, not another runtime.
  const component = mode === 'browser' ? process.env.PROBE_CLIENT! : process.env.PROBE_COMPONENT!;
  await (await import(pathToFileURL(component).href)).run();
  agentStore.close();
} else if (mode === 'python') {
  try {
    const result: any = await runPythonTool('health', { text: '中文' });
    assert.equal(result.status, 'completed');
    await assert.rejects(runPythonTool('unsupported-fixture中文', {}), /未知工具动作.*中文/);
    assert.equal((await runPythonTool<any>('health', {})).status, 'completed');
    const controller = new AbortController(); controller.abort();
    await assert.rejects(runPythonTool('health', {}, controller.signal), { name: 'AbortError' });
    console.log(JSON.stringify({ pythonHealth: true, unicodeError: true, recovery: true, cancelled: true }));
  } finally { await closePythonWorker(); agentStore.close(); }
} else {
  const store = new AgentStore(join(root, 'fixture.db'));
  await store.ready;
  await store.client.execute('CREATE TABLE probe (value TEXT)');
  const tx = await store.client.transaction('write');
  await tx.execute({ sql: 'INSERT INTO probe VALUES (?)', args: ['rollback'] });
  await tx.rollback(); tx.close();
  assert.equal((await store.client.execute('SELECT * FROM probe')).rows.length, 0);
  const context = { threadId: 'fixture', resourceId: 'fixture', runToken: 'first' };
  let sideEffects = 0, step = 0;
  const provider = {
    async *stream() {
      if (step++ === 0) yield { type: 'complete' as const, message: { role: 'assistant' as const, content: null,
        tool_calls: [{ id: 'tool-fixture', type: 'function' as const, function: { name: 'probe', arguments: '{"value":2}' } }] }, finishReason: 'tool_calls' };
      else {
        yield { type: 'text' as const, text: '中文回答' };
        yield { type: 'complete' as const, message: { role: 'assistant' as const, content: '中文回答' }, finishReason: 'stop' };
      }
    },
    async summarize() { return '{}'; },
  };
  const runtime = new AgentRuntime({ store, provider, instructions: async () => 'fixture', tools: async () => ({ probe: {
    id: 'probe', description: 'fixture', inputSchema: z.object({ value: z.number() }), requireApproval: true,
    execute: async ({ value }: { value: number }) => { sideEffects += value; return { status: 'completed', data: { value } }; },
  } }) });
  const collect = async (pending: Promise<AsyncIterable<any>>) => {
    const events = []; for await (const event of await pending) events.push(event); return events;
  };
  const first = await collect(runtime.runTurn([{ role: 'user', content: '请测试中文' }], context));
  const approvalId = first.find(event => event.type === 'tool-approval-request').payload.approvalId;
  assert.equal(sideEffects, 0);
  const approved = await collect(runtime.resumeApproval({ approvalId, approved: true }, context));
  assert.equal(sideEffects, 2);
  assert.ok(approved.some(event => event.type === 'finish'));
  await assert.rejects(runtime.resumeApproval({ approvalId, approved: true }, context));
  assert.deepEqual((await store.allMessages('fixture', 'fixture')).map(message => message.role), ['user', 'assistant']);
  await runtime.shutdown(); store.close();
  const reopened = new AgentStore(join(root, 'fixture.db')); await reopened.ready;
  assert.equal((await reopened.allMessages('fixture', 'fixture')).length, 2); reopened.close();

  // Exercise the actual HTTP adapter and stream route over a loopback socket.
  let notifyStarted!: () => void;
  const started = new Promise<void>(resolve => { notifyStarted = resolve; });
  (agentRuntime as any).config.tools = async () => ({});
  (agentRuntime as any).config.provider = {
    async *stream(messages: any[], _tools: any, signal: AbortSignal) {
      if (messages.at(-1)?.content === 'cancel-fixture') {
        notifyStarted();
        await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      } else {
        yield { type: 'text', text: 'HTTP 中文回答' };
        yield { type: 'complete', message: { role: 'assistant', content: 'HTTP 中文回答' } };
      }
    },
  };
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
  const port = (server.address() as any).port;
  const request = (path: string, body?: any) => new Promise<Response>((resolve, reject) => {
    // The application currently pins Host to 4111. Do not change its security policy for a probe.
    const req = httpRequest(`http://127.0.0.1:${port}${path}`, {
      method: body ? 'POST' : 'GET', headers: { host: '127.0.0.1:4111', 'content-type': 'application/json' },
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve(new Response(Buffer.concat(chunks), {
        status: response.statusCode, headers: response.headers as Record<string, string>,
      })));
      response.on('error', reject);
    });
    req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
  const input = (thread: string, message: string) => ({ messages: message, memory: { thread, resource: 'fixture' }, requestContext: { seudailyRunToken: thread, seudailyInterface: 'cli' } });
  try {
    assert.equal((await request('/app/health')).status, 200);
    const response = await request('/api/agents/seudaily-agent/stream', input('http-fixture', '中文提示词'));
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type')!, /text\/event-stream/);
    const output = await response.text();
    assert.match(output, /HTTP 中文回答/); assert.match(output, /"type":"finish"/);
    const pending = request('/api/agents/seudaily-agent/stream', input('cancel-fixture', 'cancel-fixture'));
    await started;
    const cancelPath = '/api/memory/threads/cancel-fixture/cancel?resourceId=fixture';
    assert.equal((await (await request(cancelPath, { runToken: 'wrong' })).json()).cancelled, false);
    assert.equal((await (await request(cancelPath, { runToken: 'cancel-fixture' })).json()).cancelled, true);
    await (await pending).text();
    assert.equal(agentRuntime.isActive('cancel-fixture'), false);
    const history = await (await request('/api/memory/threads/http-fixture/messages?resourceId=fixture')).json();
    assert.ok(JSON.stringify(history).includes('HTTP 中文回答'));
    console.log(JSON.stringify({ databaseRollback: true, historyRestart: true, approvalOnce: true, http: true, sseChinese: true, cancel: true }));
  } finally {
    await agentRuntime.shutdown(); agentStore.close();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

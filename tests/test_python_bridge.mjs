import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';

const source = await readFile(new URL('../src/runtime/tools/python-bridge.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('python-bridge.ts', source, ts.ScriptTarget.Latest, true);
const declarations = ast.statements.filter(statement => !ts.isImportDeclaration(statement)).map(statement => statement.getText(ast)).join('\n');
const compiled = ts.transpileModule(declarations, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;

function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent = [];
  let killed = 0;
  const children = [], requestChildren = new Map();
  const spawnWorker = () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 123 + children.length, exitCode: null, killed: false,
      stdout: new PassThrough(), stderr: new PassThrough(),
      stdin: Object.assign(new EventEmitter(), { destroyed: false, writable: true, write(line, callback) {
        const request = JSON.parse(line); sent.push(request); requestChildren.set(request.requestId, child); callback?.();
      }, end() { queueMicrotask(() => child.emit('close', 0)); } }),
      kill() { killed++; },
    });
    children.push(child);
    return child;
  };
  const context = vm.createContext({
    exports: {}, spawn: spawnWorker, randomUUID, createInterface, projectRoot: '/fixture',
    process: { env: {}, platform: 'linux', kill: () => { killed++; } },
    setTimeout, clearTimeout, Error,
  });
  vm.runInContext(compiled + '\nglobalThis.bridge = workerClient;', context);
  t.after(() => { for (const child of children) { child.stdout.destroy(); child.stderr.destroy(); } });
  return { bridge: context.bridge, sent, killed: () => killed,
    reply(request, result) { requestChildren.get(request.requestId).stdout.write(JSON.stringify({ requestId: request.requestId, type: 'result', result }) + '\n'); },
    exitWithoutClose(code) { const child = children.at(-1); child.exitCode = code; child.emit('exit', code); return child; },
    spawnCount: () => children.length,
    breakInput() { children.at(-1).stdin.emit('error', new Error('worker input closed')); } };
}

test('cancelling one request preserves queued work past the old five-second kill deadline', async t => {
  const f = fixture(t), controller = new AbortController();
  const first = f.bridge.call('capture', {}, controller.signal);
  const rejected = assert.rejects(first, { name: 'AbortError' });
  const second = f.bridge.call('get-schedule', {});
  controller.abort();
  await rejected;
  t.mock.timers.tick(6000);
  assert.equal(f.killed(), 0);
  assert.equal(f.sent.filter(message => message.type === 'cancel').length, 1);
  f.reply(f.sent[0], { status: 'cancelled' });
  f.reply(f.sent[1], { status: 'completed', marker: 'unrelated request' });
  assert.equal((await second).marker, 'unrelated request');
});

test('a tool timeout cancels only its own request and releases its listeners', async t => {
  const f = fixture(t);
  const first = f.bridge.call('capture', {});
  const rejected = assert.rejects(first, /timed out/);
  t.mock.timers.tick(29 * 60 * 1000);
  const second = f.bridge.call('health', {});
  t.mock.timers.tick(60 * 1000 + 6000);
  await rejected;
  assert.equal(f.killed(), 0);
  assert.equal(f.sent.filter(message => message.type === 'cancel').length, 1);
  f.reply(f.sent[1], { status: 'completed' });
  assert.equal((await second).status, 'completed');
});

test('application shutdown cancels all outstanding requests before closing worker input', async t => {
  const f = fixture(t);
  const first = assert.rejects(f.bridge.call('capture', {}), /shutting down/);
  const second = assert.rejects(f.bridge.call('save-schedule-customizations', {}), /shutting down/);
  await f.bridge.close();
  await Promise.all([first, second]);
  assert.equal(f.sent.filter(message => message.type === 'cancel').length, 2);
  t.mock.timers.tick(15_000);
  assert.equal(f.killed(), 0);
});

test('a broken worker input rejects pending requests instead of crashing the service', async t => {
  const f = fixture(t);
  const first = assert.rejects(f.bridge.call('capture', {}), /worker input closed/);
  const second = assert.rejects(f.bridge.call('health', {}), /worker input closed/);
  f.breakInput();
  await Promise.all([first, second]);
  t.mock.timers.tick(31 * 60 * 1000);
  assert.equal(f.sent.filter(message => message.type === 'cancel').length, 0);
});


test('restarting after exit rejects old requests before delayed close and preserves new work', async t => {
  const f = fixture(t);
  let firstError;
  const first = f.bridge.call('capture', {}).catch(error => { firstError = error; });
  const oldChild = f.exitWithoutClose(1);
  const second = f.bridge.call('health', {});
  await Promise.resolve();
  assert.match(firstError?.message ?? '', /no longer running.*exit code 1/);
  await first;
  assert.equal(f.spawnCount(), 2);
  oldChild.emit('close', 1);
  f.reply(f.sent[1], { status: 'completed', marker: 'replacement worker' });
  assert.equal((await second).marker, 'replacement worker');
  const third = f.bridge.call('get-schedule', {});
  assert.equal(f.spawnCount(), 2);
  f.reply(f.sent[2], { status: 'completed' });
  assert.equal((await third).status, 'completed');
  t.mock.timers.tick(31 * 60 * 1000);
  assert.equal(f.sent.filter(message => message.type === 'cancel').length, 0);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import ts from 'typescript';
import { z } from 'zod';
const diskSource = await fs.readFile(new URL('../src/shared/disk-size.ts', import.meta.url), 'utf8');
const diskCompiled = ts.transpileModule(diskSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { diskSize } = await import(`data:text/javascript;base64,${Buffer.from(diskCompiled).toString('base64')}`);

// Exercise the actual route helpers without initializing agents or API clients.
const source = await fs.readFile(new URL('../src/runtime/app-routes.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('app-routes.ts', source, ts.ScriptTarget.Latest, true);
const functions = new Set(['isWithinDirectory', 'safeLibraryTarget', 'libraryIdentity', 'walkFiles', 'readEnvFile', 'encodeEnvValue', 'persistEnvFile', 'updateEnvFile']);
const declarations = ast.statements.filter((statement) =>
  ts.isFunctionDeclaration(statement) && functions.has(statement.name?.text) ||
  ts.isVariableStatement(statement) && statement.declarationList.declarations.some((declaration) => ['libraryRoots', 'envWriteQueue', 'appRoutes'].includes(declaration.name.getText(ast)))
).map((statement) => statement.getText(ast)).join('\n');
const compiled = ts.transpileModule(declarations, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;

async function fixture(t) {
  const projectRoot = await fs.mkdtemp(path.join(tmpdir(), 'seudaily-routes-'));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  const calls = [];
  const context = vm.createContext({ ...fs, ...path, randomUUID, z, diskSize,
    runPythonTool: async (action, payload) => { calls.push({ action, payload }); return { status: 'completed', data: { state: 'connected' } }; },
    resultResponse: result => result, fullResultData: async result => result.data, process: { platform: process.platform, env: {} }, projectRoot, exports: {}, registerApiRoute: (route, options) => ({ route, ...options }) });
  vm.runInContext(`${compiled}\nglobalThis.helpers = { safeLibraryTarget, walkFiles, updateEnvFile, routes: exports.appRoutes };`, context);
  await fs.mkdir(path.join(projectRoot, 'exports'));
  return { projectRoot, context, calls, ...context.helpers };
}

test('library preview and listing reject file and directory symlink escapes', async (t) => {
  const f = await fixture(t);
  const library = path.join(f.projectRoot, 'exports');
  const outside = path.join(f.projectRoot, 'private');
  await fs.mkdir(outside);
  const hidden = path.join(outside, 'hidden.txt');
  await fs.writeFile(hidden, 'fixture text');
  await fs.writeFile(path.join(library, 'visible.txt'), 'visible');
  await fs.symlink(hidden, path.join(library, 'file-link.txt'));
  await fs.symlink(outside, path.join(library, 'directory-link'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await f.safeLibraryTarget(path.join(library, 'file-link.txt')), null);
  assert.equal(await f.safeLibraryTarget(path.join(library, 'directory-link', 'hidden.txt')), null);
  assert.equal(await f.safeLibraryTarget(hidden), null);
  const escapedPath = path.join(library, 'directory-link', 'hidden.txt');
  const response = (body, status = 200) => ({ body, status });
  const previewRoute = f.routes.find((route) => route.route === '/app/library/preview');
  assert.equal((await previewRoute.handler({ req: { query: () => escapedPath }, json: response })).status, 403);
  const deleteRoute = f.routes.find((route) => route.route === '/app/library' && route.method === 'DELETE');
  assert.equal((await deleteRoute.handler({ req: { json: async () => ({ path: escapedPath }) }, json: response })).status, 403);

  assert.equal(await f.safeLibraryTarget(library), null);
  assert.equal(await f.safeLibraryTarget(path.join(library, 'visible.txt')), await fs.realpath(path.join(library, 'visible.txt')));
  assert.deepEqual(Array.from(await f.walkFiles(library), (entry) => entry.name), ['visible.txt']);
  assert.equal(await fs.readFile(hidden, 'utf8'), 'fixture text');
});

test('library roots that point outside the project are rejected', async (t) => {
  const f = await fixture(t);
  const outside = await fs.mkdtemp(path.join(tmpdir(), 'seudaily-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.rmdir(path.join(f.projectRoot, 'exports'));
  await fs.writeFile(path.join(outside, 'hidden.txt'), 'fixture');
  await fs.symlink(outside, path.join(f.projectRoot, 'exports'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await f.safeLibraryTarget(path.join(f.projectRoot, 'exports', 'hidden.txt')), null);
  assert.equal((await f.walkFiles(path.join(f.projectRoot, 'exports'))).length, 0);
});

test('env updates preserve replacement syntax, merge concurrent writes and use private permissions', async (t) => {
  const f = await fixture(t);
  const env = path.join(f.projectRoot, '.env');
  await fs.writeFile(env, 'SEUDAILY_TEST_FIRST=old\n# keep comment\n');
  const value = "fixture$&$`$'";
  await Promise.all([
    f.updateEnvFile({ SEUDAILY_TEST_FIRST: value }),
    f.updateEnvFile({ SEUDAILY_TEST_SECOND: 'second' }),
    f.updateEnvFile({ SEUDAILY_TEST_THIRD: 'third' }),
  ]);
  const content = await fs.readFile(env, 'utf8');
  assert.ok(content.includes(`SEUDAILY_TEST_FIRST=${JSON.stringify(value)}`));
  assert.ok(content.includes('SEUDAILY_TEST_SECOND=second'));
  assert.ok(content.includes('SEUDAILY_TEST_THIRD=third'));
  assert.ok(content.includes('# keep comment'));
  if (process.platform !== 'win32') assert.equal((await fs.stat(env)).mode & 0o777, 0o600);
  assert.equal(f.context.process.env.SEUDAILY_TEST_FIRST, value);
  assert.deepEqual((await fs.readdir(f.projectRoot)).filter((name) => name.endsWith('.tmp')), []);
});

test('failed env persistence does not change process config or poison subsequent writes', async (t) => {
  const f = await fixture(t);
  const env = path.join(f.projectRoot, '.env');
  await fs.mkdir(env);
  await assert.rejects(f.updateEnvFile({ SEUDAILY_TEST_FAILED: 'fixture' }));
  assert.equal(f.context.process.env.SEUDAILY_TEST_FAILED, undefined);
  assert.deepEqual((await fs.readdir(f.projectRoot)).filter((name) => name.endsWith('.tmp')), []);
  await fs.rmdir(env);
  await f.updateEnvFile({ SEUDAILY_TEST_RECOVERED: 'fixture' });
  assert.equal(await fs.readFile(env, 'utf8'), 'SEUDAILY_TEST_RECOVERED=fixture\n');
});

test('VPN controls use the worker and RAMdisk accepts custom capacity', async (t) => {
  const f = await fixture(t);
  const json = (body) => body;
  const vpn = f.routes.find(route => route.route === '/app/vpn' && route.method === 'POST');
  const response = await vpn.handler({ req: { json: async () => ({ action: 'connect', port: 12081 }) }, json });
  assert.equal(response.data.state, 'connected');
  assert.equal(f.calls[0].action, 'vpn-connect');
  assert.equal(f.calls[0].payload.port, 12081);
  const ramdisk = f.routes.find(route => route.route === '/app/ramdisk' && route.method === 'POST');
  await ramdisk.handler({ req: { json: async () => ({ action: 'mount', size: '1.5 GB' }) }, json });
  assert.equal(f.calls[1].payload.size, '1536M');
});

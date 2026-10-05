import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseCommand } from '../src/distribution/arguments.ts';
import { ensureUv } from '../src/distribution/components.ts';
import { VERSION } from '../src/distribution/config.ts';
const exec = promisify(execFile), root = resolve(import.meta.dirname, '..');
const node = process.execPath;
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const npm = (args, options) => process.platform === 'win32' ? exec(node, [process.env.npm_execpath ?? join(dirname(node), 'node_modules/npm/bin/npm-cli.js'), ...args], options) : exec('npm', args, options);
const freshEnv = extra => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(SEUDAILY_|CVSTREAM_|DEEPSEEK_|NODE_OPTIONS)/.test(key))), ...extra });
async function freePort() { const server = netServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); const port = server.address().port; await new Promise(r => server.close(r)); return port; }
async function eventually(operation, timeout = 10_000) { let error; const end = Date.now() + timeout; do { try { return await operation(); } catch (e) { error = e; await delay(100); } } while (Date.now() < end); throw error; }
// TerminateProcess on Windows cannot execute a signal handler: test expiry of the crashed client's lease.
const exitTimeout = process.platform === 'win32' ? 45_000 : 10_000;

test('existing uv is reused without downloading; explicit invalid uv reports an error', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'seudaily-uv-reuse-'));
  const previous = { cache: process.env.SEUDAILY_CACHE_DIR, uv: process.env.SEUDAILY_UV_BINARY };
  t.after(async () => {
    for (const [key, value] of [['SEUDAILY_CACHE_DIR', previous.cache], ['SEUDAILY_UV_BINARY', previous.uv]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(temporary, { recursive: true, force: true });
  });
  process.env.SEUDAILY_CACHE_DIR = temporary;
  delete process.env.SEUDAILY_UV_BINARY;
  const uv = await ensureUv();
  assert.ok(existsSync(uv));
  assert.ok(!existsSync(join(temporary, 'uv')));
  process.env.SEUDAILY_UV_BINARY = uv;
  assert.equal(await ensureUv(), uv);
  process.env.SEUDAILY_UV_BINARY = join(temporary, 'missing-uv');
  await assert.rejects(ensureUv(), /指定的 uv/);
});

test('unified commands and aliases reject removed/conflicting arguments', () => {
  assert.equal(VERSION, version);
  for (const alias of [[], ['chat'], ['--chat'], ['-c']]) assert.equal(parseCommand(alias).command, 'chat');
  for (const alias of [['web'], ['--web'], ['-w']]) assert.equal(parseCommand(alias).command, 'web');
  assert.equal(parseCommand(['vpn', '12081']).vpn, 12081);
  assert.equal(parseCommand(['--vpn', '12081']).vpn, 12081);
  assert.equal(parseCommand(['chat', '--resume']).values.resume, 'choose');
  for (const args of [['start'], ['exec', 'x'], ['--prompt', 'x'], ['--cwd', '.'], ['--no-start'], ['-c', '-w'], ['web', '--json'], ['vpn', '80']]) assert.throws(() => parseCommand(args));
});

test('packed installation runs without source/node_modules, installs only selected components and shares core', { timeout: 240_000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'seudaily-package-'));
  const launchers = [];
  let registry, api;
  t.after(async () => {
    for (const child of launchers) child.kill('SIGTERM');
    if (api) await fetch(api + '/app/runtime/stop', { method: 'POST', signal: AbortSignal.timeout(3000) }).catch(() => {});
    await delay(500);
    if (registry) { registry.closeAllConnections(); await new Promise(resolve => registry.close(resolve)); }
    await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  const install = join(temporary, 'install'), data = join(temporary, 'data'), cache = join(temporary, 'cache');
  const packages = new Map(), counts = new Map();
  for (const name of ['host', 'web', 'python']) {
    const directory = name === 'host' ? root : join(root, 'dist', 'components', name);
    const packed = JSON.parse((await npm(['pack', '--json', '--pack-destination', temporary], { cwd: directory })).stdout)[0];
    const bytes = await readFile(join(temporary, packed.filename));
    if (name === 'host') {
      assert.ok(packed.files.every(file => !/node_modules|\.env|agent\.db|components\/|src\//.test(file.path)));
      assert.ok(packed.files.some(file => file.path === 'dist/cli/index.mjs'));
      await npm(['install', '--prefix', install, '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', join(temporary, packed.filename)]);
    } else packages.set(packed.name, { bytes, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` });
  }
  let registryPort;
  let rejectWeb = true;
  registry = createServer((request, response) => {
    const name = decodeURIComponent(request.url.split('/')[1]);
    if (name === '@miunerofrade/seudaily-web' && rejectWeb) { response.writeHead(404); response.end('{}'); return; }
    const record = packages.get(name);
    if (!record) { response.writeHead(404); response.end('{}'); return; }
    counts.set(name, (counts.get(name) ?? 0) + 1);
    if (request.url.endsWith('.tgz')) { response.end(record.bytes); return; }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ name, 'dist-tags': { latest: version }, versions: { [version]: { name, version, dist: { tarball: `http://127.0.0.1:${registryPort}/${encodeURIComponent(name)}/-/package.tgz`, integrity: record.integrity } } } }));
  });
  await new Promise(r => registry.listen(0, '127.0.0.1', r)); registryPort = registry.address().port;
  const port = await freePort(); api = `http://127.0.0.1:${port}`;
  const host = join(install, 'node_modules', 'seudaily', 'bin', 'seudaily.mjs');
  assert.ok(!existsSync(join(install, 'node_modules', 'seudaily', 'node_modules')));
  assert.ok(!existsSync(join(install, 'node_modules', 'seudaily', 'src')));
  const env = freshEnv({ SEUDAILY_CACHE_DIR: cache, SEUDAILY_NO_OPEN: '1', NPM_CONFIG_REGISTRY: `http://127.0.0.1:${registryPort}`, NPM_CONFIG_CACHE: join(temporary, 'npm-cache') });
  const command = args => exec(node, [host, ...args, '--data-dir', data, '--port', String(port)], { cwd: temporary, env, timeout: 20_000 });
  assert.match((await command(['--help'])).stdout, /--web \/ -w/);
  assert.ok(!existsSync(data)); assert.ok(!existsSync(cache));
  assert.match((await command(['status'])).stdout, /未运行/);
  // Built-in CLI works with an unavailable registry and an empty component cache.
  assert.match((await command(['sessions'])).stdout, /暂无会话/);
  assert.equal(counts.size, 0);
  await eventually(async () => { await assert.rejects(fetch(api + '/api')); });
  await eventually(async () => { assert.ok(!existsSync(join(data, '.seudaily', 'core.lock'))); });
  // Pre-release caches used an unscoped component name at this same version.
  const legacyWeb = join(cache, 'components', version, 'web');
  await mkdir(join(legacyWeb, 'node_modules', 'seudaily-web'), { recursive: true });
  await writeFile(join(legacyWeb, 'ready.json'), JSON.stringify({ version }));
  await writeFile(join(legacyWeb, 'node_modules', 'seudaily-web', 'package.json'), JSON.stringify({ name: 'seudaily-web', version }));
  await assert.rejects(command(['web']));
  rejectWeb = false;
  assert.ok(!existsSync(join(cache, 'components', version, 'cli', 'ready.json')));
  assert.ok(!existsSync(join(cache, 'components', version, 'cli.lock')));
  const launchWeb = () => {
    const child = spawn(node, [host, 'web', '--data-dir', data, '--port', String(port)], { cwd: temporary, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.logs = ''; child.stdout.on('data', b => child.logs += b); child.stderr.on('data', b => child.logs += b); launchers.push(child); return child;
  };
  const first = launchWeb(), second = launchWeb();
  const identity = await eventually(async () => {
    for (const child of [first, second]) if (child.exitCode !== null) throw new Error(`Web launcher exited: ${child.logs}`);
    const value = await (await fetch(api + '/api')).json(); assert.equal(value.clients, 2); assert.equal(value.web, true); assert.match(first.logs, /按 Ctrl\+C/); assert.match(second.logs, /按 Ctrl\+C/); return value;
  }, process.platform === 'win32' ? 45_000 : 10_000);
  assert.equal(identity.dataRoot, data); assert.equal(identity.managed, true);
  assert.match(await (await fetch(api)).text(), /<html/);
  assert.deepEqual((await (await fetch(api + '/app/focus')).json()).data.items, []);
  assert.equal((await fetch(api + '/app/health', { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(api + '/app/health', { headers: { Origin: api } })).status, 200);
  assert.equal((await fetch(api + '/.env')).status, 404);
  assert.equal((await fetch(api + '/app/not-found')).status, 404);
  assert.match((await command(['sessions'])).stdout, /暂无会话/);
  assert.ok(!counts.has('seudaily-cli')); assert.ok(counts.has('@miunerofrade/seudaily-web'));
  assert.ok(!counts.has('@miunerofrade/seudaily-python')); assert.ok(!existsSync(join(cache, 'python')));
  first.kill('SIGTERM'); await eventually(async () => { assert.ok(first.exitCode !== null || first.signalCode !== null); });
  const surviving = await eventually(async () => { const value = await (await fetch(api + '/api')).json(); assert.equal(value.clients, 1); return value; }, exitTimeout); assert.equal(surviving.processId, identity.processId);
  await assert.rejects(exec(node, [host, 'status', '--data-dir', join(temporary, 'other'), '--port', String(port)], { env, cwd: temporary }));
  second.kill('SIGTERM');
  await eventually(async () => { await assert.rejects(fetch(api + '/api')); }, exitTimeout);
  await eventually(async () => { assert.ok(!existsSync(join(data, '.seudaily', 'core.lock'))); });
  // Restarting the built-in CLI neither downloads CLI nor requests Web again.
  const before = counts.get('@miunerofrade/seudaily-web'); assert.match((await command(['sessions'])).stdout, /暂无会话/); assert.equal(counts.get('@miunerofrade/seudaily-web'), before);
  await eventually(async () => { await assert.rejects(fetch(api + '/api')); });
  const manual = spawn(node, [join(dirname(dirname(host)), 'dist/core.mjs')], { cwd: temporary, env: { ...env, SEUDAILY_INSTALL_ROOT: dirname(dirname(host)), SEUDAILY_PROJECT_ROOT: data, SEUDAILY_PORT: String(port), SEUDAILY_MANAGED: '0' }, stdio: 'ignore' });
  launchers.push(manual);
  const manuallyStarted = await eventually(async () => { const value = await (await fetch(api + '/api')).json(); assert.equal(value.managed, false); return value; });
  assert.match((await command(['sessions'])).stdout, /暂无会话/);
  assert.equal((await (await fetch(api + '/api')).json()).processId, manuallyStarted.processId);
  await command(['stop']);
  await eventually(async () => { await assert.rejects(fetch(api + '/api')); });
});


test('explicit data import preserves originals and refuses overwrites or a running source', { timeout: 20_000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'seudaily-import-package-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const source = join(temporary, 'legacy'), target = join(temporary, 'data');
  await mkdir(join(source, '.seudaily'), { recursive: true });
  await writeFile(join(source, 'pyproject.toml'), '[project]');
  await writeFile(join(source, '.env'), 'DEEPSEEK_API_KEY=fixture-not-a-real-key\n');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(source, '.seudaily', 'agent.db'));
  db.exec("CREATE TABLE fixture(id TEXT); INSERT INTO fixture VALUES ('中文历史')"); db.close();
  const before = await readFile(join(source, '.seudaily', 'agent.db'));
  const command = () => exec(node, [join(root, 'bin/seudaily.mjs'), 'import-data', source, '--data-dir', target], { env: freshEnv({}), cwd: temporary });
  await mkdir(join(source, '.seudaily', 'core.lock'));
  await assert.rejects(command());
  await rm(join(source, '.seudaily', 'core.lock'), { recursive: true });
  assert.match((await command()).stdout, /原件保留/);
  assert.deepEqual(await readFile(join(source, '.seudaily', 'agent.db')), before);
  assert.deepEqual(await readFile(join(target, '.seudaily', 'agent.db')), before);
  await assert.rejects(command());
});

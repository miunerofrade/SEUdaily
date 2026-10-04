import { spawn } from 'node:child_process';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, open, readdir, cp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { config as dotenv } from 'dotenv';
import { parseCommand, HELP, completion } from './arguments.js';
import { VERSION, PROTOCOL, defaultDataRoot } from './config.js';
import { ensureComponent, ensurePython, cacheRoot } from './components.js';
import { acquireLock } from './lock.js';
const options = parseCommand(process.argv.slice(2));
if (options.values.help) { console.log(HELP); process.exit(0); }
if (options.values.version) { console.log(`seudaily ${VERSION}`); process.exit(0); }
if (options.command === 'completion') { console.log(completion(options.argument!)); process.exit(0); }
const modulePath = fileURLToPath(import.meta.url);
const installRoot = resolve(dirname(modulePath), modulePath.endsWith('.ts') ? '../..' : '..');
const dataRoot = resolve(options.values['data-dir'] ?? process.env.SEUDAILY_DATA_DIR ?? defaultDataRoot());
process.env.SEUDAILY_INSTALL_ROOT = installRoot;
process.env.SEUDAILY_PROJECT_ROOT = dataRoot;
process.env.SEUDAILY_CACHE_DIR = cacheRoot();
process.env.SEUDAILY_PORT = String(options.port);
process.env.SEUDAILY_API_URL = `http://127.0.0.1:${options.port}`;
dotenv({ path: join(dataRoot, '.env') });
const api = process.env.SEUDAILY_API_URL;
async function request(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(api + path, { method, ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error(`后端请求失败（${response.status}）：${await response.text()}`);
  return response.json();
}
async function probe() {
  try { return await request('/api'); }
  catch (error) {
    // Only transport failure means there is no server. A foreign HTTP response is an occupied port.
    if ((error as Error & { cause?: { code?: string } }).cause?.code === 'ECONNREFUSED') return undefined;
    throw error;
  }
}
function verify(identity: any) {
  if (identity.name !== 'SEUdaily' || identity.protocol !== PROTOCOL || identity.version !== VERSION || identity.dataRoot !== dataRoot) throw new Error('端口已有其他服务、旧版后端或不同数据目录的 SEUdaily；请选择另一 --port 或先停止对应服务');
}
async function connect() {
  let identity = await probe();
  if (identity) { verify(identity); await request('/app/health'); return identity; }
  await mkdir(join(dataRoot, '.seudaily', 'logs'), { recursive: true, mode: 0o700 });
  const log = await open(join(dataRoot, '.seudaily', 'logs', 'core.log'), 'a', 0o600);
  // Windows also needs an independent process group/console so one interface exiting cannot kill the shared core.
  const child = spawn(process.execPath, [join(installRoot, 'dist', 'core.mjs')], { cwd: dataRoot, stdio: ['ignore', log.fd, log.fd], detached: true, windowsHide: true, env: { ...process.env, SEUDAILY_MANAGED: '1' } });
  let spawnError: Error | undefined;
  child.once('error', error => { spawnError = error; }); child.unref(); await log.close();
  for (let attempt = 0; attempt < 100; attempt++) {
    await delay(100);
    if (spawnError) throw spawnError;
    identity = await probe();
    if (identity) { verify(identity); await request('/app/health'); return identity; }
  }
  throw new Error(`后端启动失败，请检查 ${join(dataRoot, '.seudaily', 'logs', 'core.log')}`);
}
async function importData(source: string) {
  const from = resolve(source);
  const relation = relative(from, dataRoot);
  if (!relation || !isAbsolute(relation) && !relation.startsWith('..')) throw new Error('目标目录不能位于来源目录内部');
  const entries = ['.env', 'AGENT.md', '.agent', '.seudaily', 'exports', 'cookies.json', 'config.json'];
  if (!(await readdir(dataRoot).catch(() => [])).every(name => name === '.DS_Store')) throw new Error('导入目标必须为空；请指定新的 --data-dir');
  if (!existsSync(join(from, 'pyproject.toml')) || !existsSync(join(from, '.seudaily'))) throw new Error('来源不是包含运行数据的旧 SEUdaily 仓库');
  if (existsSync(join(from, '.seudaily', 'core.lock')) || existsSync(join(from, '.seudaily', 'agent.db-wal'))) throw new Error('请先停止旧后端，再导入，避免复制正在写入的数据库');
  const temporary = `${dataRoot}.import-${process.pid}`;
  try {
    await mkdir(temporary, { recursive: true, mode: 0o700 });
    for (const name of entries) if (existsSync(join(from, name))) await cp(join(from, name), join(temporary, name), { recursive: true, dereference: false, filter: path => !/(?:^|[/\\])(?:probes|logs|core\.lock|backend-clients)(?:[/\\]|$)/.test(path) });
    const { rename } = await import('node:fs/promises');
    await rm(dataRoot, { recursive: true, force: true }); await rename(temporary, dataRoot);
    console.log(`数据已复制到 ${dataRoot}；原件保留。`);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
if (options.command === 'import-data') { await importData(options.argument!); process.exit(0); }
if (options.command === 'status' || options.command === 'stop') {
  const identity = await probe();
  if (!identity) console.log('未运行');
  else { verify(identity); console.log(options.command === 'stop' ? await request('/app/runtime/stop', 'POST') : identity); }
  process.exit(0);
}
await mkdir(dataRoot, { recursive: true, mode: 0o700 });
// Seed editable built-in skills once; updates never overwrite user changes.
const releaseInitialization = await acquireLock(join(dataRoot, '.seudaily', 'init.lock'), 30_000);
try { if (!existsSync(join(dataRoot, '.agent', 'skills'))) await cp(join(installRoot, 'dist', 'skills'), join(dataRoot, '.agent', 'skills'), { recursive: true }); }
finally { await releaseInitialization(); }
if (options.command === 'vpn') {
  if (!process.env.SEUDAILY_USERNAME?.trim() || !process.env.SEUDAILY_PASSWORD?.trim()) throw new Error('缺少校园账号或密码；请在数据目录 .env 配置 SEUDAILY_USERNAME 和 SEUDAILY_PASSWORD');
  const python = await ensurePython();
  process.exitCode = await runChild(python, ['-m', 'seudaily.vpn', String(options.vpn)], dataRoot);
} else {
  const component = await ensureComponent(options.command === 'web' ? 'web' : 'cli');
  const identity = await connect();
  const { id } = await request('/app/runtime/clients', 'POST', { interface: options.command === 'web' ? 'web' : 'cli' });
  let heartbeatActive = false;
  const heartbeat = setInterval(() => {
    if (heartbeatActive) return;
    heartbeatActive = true;
    void request(`/app/runtime/clients/${id}`, 'POST').catch(error => console.error((error as Error).message)).finally(() => { heartbeatActive = false; });
  }, 10_000);
  // Keep the Web launcher alive while waiting for a signal; signal listeners alone do not keep Node running.
  try {
    if (options.command === 'web') {
      await request('/app/runtime/web', 'POST');
      console.log(`SEUdaily Web：${api}\n按 Ctrl+C 关闭此界面。`);
      const opener = process.platform === 'darwin' ? ['open', api] : process.platform === 'win32' ? ['rundll32.exe', 'url.dll,FileProtocolHandler', api] : ['xdg-open', api];
      if (process.env.SEUDAILY_NO_OPEN !== '1') { const browser = spawn(opener[0], opener.slice(1), { stdio: 'ignore' }); browser.on('error', () => {}); browser.unref(); }
      await new Promise<void>(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
    } else {
      process.env.SEUDAILY_CLI_OPTIONS = JSON.stringify({ ...options.values, command: options.command === 'ask' ? 'exec' : options.command,
        message: options.argument, timeout: options.timeout, no_color: options.values['no-color'], cwd: process.cwd() });
      process.exitCode = await runChild(process.execPath, [join(component, 'index.mjs')], dataRoot);
    }
  } finally {
    clearInterval(heartbeat);
    await request(`/app/runtime/clients/${id}`, 'DELETE').catch(() => {});
  }
}
async function runChild(command: string, args: string[], cwd: string): Promise<number> {
  const child = spawn(command, args, { cwd, stdio: 'inherit', env: process.env, windowsHide: true });
  const stop = () => child.kill('SIGTERM');
  process.on('SIGTERM', stop);
  // Terminal raw input handles Ctrl+C; noninteractive child receives the foreground signal itself.
  const interrupt = () => child.kill('SIGINT'); process.on('SIGINT', interrupt);
  try { return await new Promise<number>((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve(code ?? (signal ? 130 : 1))); }); }
  finally { process.off('SIGTERM', stop); process.off('SIGINT', interrupt); }
}

import { execFile, type ExecFileOptions } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import uvRelease from './uv-release.json' with { type: 'json' };
import { acquireLock } from './lock.js';
import { defaultCacheRoot, VERSION } from './config.js';
const installationAbort = new AbortController();
const execute = promisify(execFile);
async function exec(command: string, args: string[], options: ExecFileOptions = {}): Promise<void> { await execute(command, args, { ...options, signal: installationAbort.signal }); }
export function cancelComponentPreparation() { installationAbort.abort(); }
export type Component = 'cli' | 'web' | 'python' | 'browser';
export const cacheRoot = () => resolve(process.env.SEUDAILY_CACHE_DIR ?? defaultCacheRoot());
const modulePath = fileURLToPath(import.meta.url);
const installRoot = () => process.env.SEUDAILY_INSTALL_ROOT ?? resolve(dirname(modulePath), modulePath.endsWith('.ts') ? '../..' : '..');
const componentRoot = (name: Component) => join(cacheRoot(), 'components', VERSION, name);
async function npmCommand() {
  if (process.env.npm_execpath?.endsWith('.js')) return { command: process.execPath, args: [process.env.npm_execpath] };
  if (process.platform !== 'win32') return { command: 'npm', args: [] };
  for (const directory of (process.env.PATH ?? '').split(';')) {
    const cli = join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (existsSync(cli)) return { command: process.execPath, args: [cli] };
  }
  throw new Error('安装可选组件需要 npm；请使用包含 npm 的 Node.js 安装。');
}
export async function ensureComponent(name: Component): Promise<string> {
  if (name === 'cli') {
    const bundled = join(installRoot(), 'dist', 'cli');
    if (!existsSync(join(bundled, 'index.mjs'))) throw new Error('安装包缺少内置 CLI，请重新安装 SEUdaily。');
    return bundled;
  }
  // Source builds keep separately packed components beside the host; npm's file whitelist excludes them.
  const local = join(process.env.SEUDAILY_COMPONENT_DIR ?? join(installRoot(), 'dist', 'components'), name);
  if (existsSync(join(local, 'package.json'))) {
    const metadata = JSON.parse(await readFile(join(local, 'package.json'), 'utf8'));
    if (metadata.version !== VERSION) throw new Error('本地组件版本不匹配');
    return local;
  }
  const manifest = JSON.parse(await readFile(join(installRoot(), 'dist', 'components.json'), 'utf8'));
  const packageName = manifest[name];
  if (typeof packageName !== 'string' || !/^(?:@[a-z0-9-]+\/)?[a-z0-9-]+$/.test(packageName)) throw new Error('组件清单无效');
  const target = componentRoot(name);
  const installed = join(target, 'node_modules', packageName);
  if (existsSync(join(target, 'ready.json'))) return installed;
  const release = await acquireLock(`${target}.lock`, 15 * 60_000);
  try {
    if (existsSync(join(target, 'ready.json'))) return installed;
    const temporary = `${target}.install-${process.pid}`;
    await rm(temporary, { recursive: true, force: true });
    await mkdir(temporary, { recursive: true });
    console.error(`正在准备 ${name} 组件…`);
    try {
      const npm = await npmCommand();
      await exec(npm.command, [...npm.args, 'install', '--prefix', temporary, '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', '--package-lock=true', `${packageName}@${VERSION}`], { timeout: 10 * 60_000, maxBuffer: 2 * 1024 * 1024 });
      const packagePath = join(temporary, 'node_modules', packageName);
      const metadata = JSON.parse(await readFile(join(packagePath, 'package.json'), 'utf8'));
      if (metadata.version !== VERSION) throw new Error('组件版本不匹配');
      // Keep dependency layout (needed by browser); publish the whole private prefix atomically.
      await writeFile(join(temporary, 'ready.json'), JSON.stringify({ version: VERSION }), { mode: 0o600 });
      await rm(target, { recursive: true, force: true });
      await rename(temporary, target);
      return installed;
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      throw new Error(`${name} 组件准备失败，可重试：${(error as Error).message}`);
    }
  } finally { await release(); }
}

const UV_VERSION = uvRelease.version;
async function compatibleUv(command: string): Promise<boolean> {
  try {
    const { stdout } = await execute(command, ['--version'], { timeout: 5000, windowsHide: true });
    const version = /^uv (\d+)\.(\d+)\.(\d+)/.exec(stdout);
    if (!version) return false;
    const actual = version.slice(1).map(Number), minimum = UV_VERSION.split('.').map(Number);
    for (let i = 0; i < 3; i++) if (actual[i] !== minimum[i]) return actual[i] > minimum[i];
    return true;
  } catch { return false; }
}
export async function ensureUv(): Promise<string> {
  if (process.env.SEUDAILY_UV_BINARY) {
    const configured = resolve(process.env.SEUDAILY_UV_BINARY);
    if (!await compatibleUv(configured)) throw new Error(`指定的 uv 无法运行或版本低于 ${UV_VERSION}`);
    return configured;
  }
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory) continue;
    const candidate = resolve(directory, process.platform === 'win32' ? 'uv.exe' : 'uv');
    if (existsSync(candidate) && await compatibleUv(candidate)) return candidate;
  }
  const directory = join(cacheRoot(), 'uv', UV_VERSION);
  const executable = join(directory, process.platform === 'win32' ? 'uv.exe' : 'uv');
  if (existsSync(executable)) return executable;
  const release = await acquireLock(`${directory}.lock`, 5 * 60_000);
  try {
    if (existsSync(executable)) return executable;
    const family = process.platform === 'darwin' ? 'macosx_' : process.platform === 'win32' ? 'win_' : process.platform === 'linux' ? 'manylinux_2_17_' : '';
    const architecture = process.arch === 'arm64' ? process.platform === 'linux' ? 'aarch64' : 'arm64' : process.platform === 'win32' ? 'amd64' : 'x86_64';
    if (!family || !['x64', 'arm64'].includes(process.arch)) throw new Error('当前平台尚不支持自动准备 uv');
    const wheel = uvRelease.files.find(file => file.filename.includes(family) && file.filename.endsWith(`${architecture}.whl`));
    if (!wheel) throw new Error('没有对应平台的 uv 构建');
    const download = await fetch(wheel.url, { signal: AbortSignal.timeout(120_000) });
    if (!download.ok) throw new Error(`uv 下载失败（${download.status}）`);
    const bytes = new Uint8Array(await download.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== wheel.sha256) throw new Error('uv 校验失败');
    const binaryName = `/scripts/${process.platform === 'win32' ? 'uv.exe' : 'uv'}`;
    const files = unzipSync(bytes, { filter: file => file.name.endsWith(binaryName) || file.name.includes('/licenses/') });
    const binary = Object.entries(files).find(([name]) => name.endsWith(binaryName))?.[1];
    if (!binary) throw new Error('uv 安装包缺少可执行文件');
    await mkdir(directory, { recursive: true });
    for (const [name, content] of Object.entries(files)) if (name.includes('/licenses/')) await writeFile(join(directory, name.split('/').at(-1)!), content);
    await writeFile(`${executable}.tmp`, binary, { mode: 0o700 });
    await chmod(`${executable}.tmp`, 0o700);
    await rename(`${executable}.tmp`, executable);
    return executable;
  } finally { await release(); }
}
let pythonLoading: Promise<string> | undefined;
export function ensurePython(): Promise<string> {
  return pythonLoading ??= preparePython().catch(error => { pythonLoading = undefined; throw error; });
}
async function preparePython(): Promise<string> {
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(cacheRoot(), 'browsers');
  const component = await ensureComponent('python');
  process.env.SEUDAILY_MEDIA_REQUIREMENTS = join(component, 'media-requirements.txt');
  process.env.UV_CACHE_DIR ??= join(cacheRoot(), 'uv-cache');
  const directory = join(cacheRoot(), 'python', VERSION);
  const executable = join(directory, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (existsSync(join(directory, 'ready.json')) && existsSync(executable)) {
    process.env.SEUDAILY_UV_BINARY ??= await ensureUv();
    return executable;
  }
  const release = await acquireLock(`${directory}.lock`, 15 * 60_000);
  try {
    if (existsSync(join(directory, 'ready.json')) && existsSync(executable)) {
      process.env.SEUDAILY_UV_BINARY ??= await ensureUv();
      return executable;
    }
    const uv = await ensureUv();

    process.env.SEUDAILY_UV_BINARY = uv;
    const environment = process.env;
    console.error('正在准备校园与文档工具运行环境…');
    try {
      // The final venv path must be used when creating it: scripts contain absolute paths.
      await rm(directory, { recursive: true, force: true });
      await mkdir(directory, { recursive: true });
      let interpreter: string;
      try {
        const found = await execute(uv, ['python', 'find', '--no-config', '--no-project', '--system', '--no-python-downloads', '>=3.11'], { env: environment, timeout: 30_000, windowsHide: true });
        interpreter = found.stdout.trim();
      } catch {
        // No compatible interpreter exists: keep the downloaded runtime in our cache.
        environment.UV_PYTHON_INSTALL_DIR ??= join(cacheRoot(), 'python-runtime');
        interpreter = '3.13';
      }
      await exec(uv, ['venv', '--python', interpreter, join(directory, 'venv')], { env: environment, timeout: 10 * 60_000 });
      const wheel = (await readdir(component)).find(file => file.endsWith('.whl'));
      if (!wheel) throw new Error('Python 组件缺少 wheel');
      await exec(uv, ['pip', 'install', '--python', executable, '--no-deps', join(component, wheel)], { env: environment, timeout: 10 * 60_000 });
      await exec(uv, ['pip', 'install', '--python', executable, '--require-hashes', '-r', join(component, 'requirements.txt')], { env: environment, timeout: 10 * 60_000, maxBuffer: 2 * 1024 * 1024 });
      await writeFile(join(directory, 'ready.json'), JSON.stringify({ version: VERSION }), { mode: 0o600 });
      return executable;
    } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }

  } finally { await release(); }
}

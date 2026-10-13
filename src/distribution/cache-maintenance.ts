import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { unlinkSync } from 'node:fs';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { acquireLock } from './lock.js';
import { discoverServices, nodeListeners, processCommand, isServiceCommand } from './services.js';
import { defaultCacheRoot, VERSION } from './config.js';

const execute = promisify(execFile);
const versionName = /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/;
const rootPath = () => resolve(process.env.SEUDAILY_CACHE_DIR ?? defaultCacheRoot());
const alive = (pid: number) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
};
const inside = (root: string, path: string) => {
  const child = relative(root, path);
  return Boolean(child) && child !== '..' && !child.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) && !isAbsolute(child);
};
const entries = (path: string) => readdir(path, {withFileTypes:true}).catch((error:NodeJS.ErrnoException) => {
  if (error.code === 'ENOENT') return [];
  throw error;
});
async function safeDirectory(root: string, path: string) {
  const info = await lstat(path).catch(() => undefined);
  return Boolean(info?.isDirectory() && !info.isSymbolicLink() && inside(root, await realpath(path)));
}

/** Each launcher/core pins its version until exit; crashed owners are reclaimed. */
export async function registerCacheUse(root = rootPath(), version = VERSION): Promise<() => void> {
  const release = await acquireLock(join(root, 'maintenance.lock'), 30_000);
  const file = join(root, 'leases', `${process.pid}-${randomUUID()}.json`);
  try {
    await mkdir(join(root, 'leases'), {recursive:true, mode:0o700});
    await writeFile(file, JSON.stringify({pid:process.pid, version}), {mode:0o600, flag:'wx'});
  } finally { await release(); }
  let closed = false;
  const close = () => { if (!closed) { closed = true; try { unlinkSync(file); } catch {} } };
  process.once('exit', close);
  return () => { process.off('exit', close); close(); };
}

export type CleanupReport = {removed:string[]; retainedVersions:string[]; warnings:string[]; uvPruned:boolean};
type Options = {
  currentVersion?:string;
  activeVersions?:() => Promise<string[]>;
  uvCommand?:string;
  pruneUv?:boolean;
  now?:number;
};
async function lockInUse(path: string): Promise<boolean> {
  for (const entry of await entries(path)) {
    if (entry.isSymbolicLink()) continue;
    const child = join(path, entry.name);
    if (!entry.isDirectory()) continue;
    if (/\.lock(?:\.|$)/.test(entry.name)) {
      const owner = await readFile(join(child, 'owner.json'), 'utf8').then(JSON.parse).catch(() => undefined);
      if (!owner || alive(owner.pid)) return true;
    } else if (await lockInUse(child)) return true;
  }
  return false;
}
async function hasUvSymlinks(path: string, uvCache: string):Promise<boolean> {
  for (const entry of await entries(path)) {
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) {
      const actual = await realpath(child).catch(() => undefined);
      if (!actual || actual === uvCache || inside(uvCache, actual)) return true;
    } else if (entry.isDirectory() && await hasUvSymlinks(child, uvCache)) return true;
  }
  return false;
}

async function runningVersions(root:string):Promise<string[]> {
  const listeners = await nodeListeners();
  const services = await discoverServices(async () => listeners);
  const known = new Set(services.map(service => service.pid));
  for (const pid of new Set(listeners.map(listener => listener.pid))) {
    if (known.has(pid)) continue;
    const command = await processCommand(pid);
    if (isServiceCommand(command)) throw new Error('旧后端版本无法确认');
  }
  const versions = services.map(service => service.version);
  // Old standalone clients may not have an HTTP listener or a cache lease.
  const command = process.platform === 'win32'
    ? await execute('powershell.exe', ['-NoProfile','-NonInteractive','-Command', 'Get-CimInstance Win32_Process | Select-Object -ExpandProperty CommandLine'], {timeout:30_000,windowsHide:true,maxBuffer:8*1024*1024})
    : await execute('ps', ['-axo','args='], {timeout:5000,maxBuffer:8*1024*1024});
  const prefix = root.replaceAll('\\','/').toLowerCase() + '/';
  for (const line of command.stdout.replaceAll('\\','/').split('\n')) {
    const start = line.toLowerCase().indexOf(prefix);
    if (start < 0) continue;
    const match = /^(?:components|python)\/(\d+\.\d+\.\d+(?:-[\w.-]+)?)\//.exec(line.slice(start+prefix.length));
    if (match) versions.push(match[1]);
  }
  return versions;
}

/** Delete only application-owned version caches; user data and shared runtimes stay intact. */
export async function cleanVersionCache(root = rootPath(), options:Options = {}):Promise<CleanupReport> {
  root = resolve(root);
  await mkdir(root, {recursive:true});
  root = await realpath(root);
  const report:CleanupReport = {removed:[], retainedVersions:[], warnings:[], uvPruned:false};
  const release = await acquireLock(join(root, 'maintenance.lock'), 30_000);
  let locked = true;
  try {
    const keep = new Set([options.currentVersion ?? VERSION]);
    for (const entry of await entries(join(root, 'leases'))) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const file = join(root, 'leases', entry.name);
      const lease = await readFile(file, 'utf8').then(JSON.parse).catch(() => undefined);
      if (!lease || !versionName.test(lease.version) || !Number.isSafeInteger(lease.pid)) {
        report.warnings.push('缓存使用记录无效，跳过本次清理'); return report;
      }
      if (alive(lease.pid)) keep.add(lease.version);
      else await rm(file);
    }
    // Pre-mechanism servers have no leases; preserve their advertised version too.
    try {
      const active = await (options.activeVersions ?? (() => runningVersions(root)))();
      if (active.some(version => !versionName.test(version))) throw new Error('无法确认旧后端版本');
      active.forEach(version => keep.add(version));
    } catch {
      report.warnings.push('无法确认运行中的旧版服务，跳过本次清理'); return report;
    }
    report.retainedVersions = [...keep];
    for (const kind of ['components', 'python']) {
      const directory = join(root, kind);
      if (!await safeDirectory(root, directory)) continue;
      for (const entry of await entries(directory)) {
        if (!entry.isDirectory() || !versionName.test(entry.name) || keep.has(entry.name)) continue;
        const path = join(directory, entry.name);
        if (!await safeDirectory(root, path) || await lockInUse(path) || await lockInUseForVersion(directory, entry.name)) continue;
        await rm(path, {recursive:true, force:true, maxRetries:3, retryDelay:100});
        report.removed.push(path);
      }
      // Interrupted npm installs and lock candidates are identified by their owner PID.
      await removeAbandoned(root, directory, report);
    }
    await release();
    locked = false;
    if (options.pruneUv !== false) {
      const cache = join(root, 'uv-cache');
      const statePath = join(root, 'maintenance.json');
      const state = await readFile(statePath, 'utf8').then(JSON.parse).catch(() => ({}));
      const now = options.now ?? Date.now();
      if (await safeDirectory(root, cache) && (!state.prunedAt || now - state.prunedAt > 24*60*60*1000 || report.removed.length)) {
        if (process.env.UV_LINK_MODE === 'symlink' || await hasUvSymlinks(join(root, 'python'), cache)) {
          report.warnings.push('环境依赖 uv 缓存符号链接，保留下载缓存');
        } else {
          try {
            await execute(options.uvCommand ?? process.env.SEUDAILY_UV_BINARY ?? 'uv', ['cache','prune','--ci','--cache-dir',cache,'--no-config','--offline'], {timeout:60_000,windowsHide:true,maxBuffer:1024*1024});
            await writeFile(statePath, JSON.stringify({prunedAt:now}), {mode:0o600});
            report.uvPruned = true;
          } catch { report.warnings.push('uv 下载缓存清理未完成，下次启动重试'); }
        }
      }
    }
    return report;
  } finally { if (locked) await release(); }
}
async function lockInUseForVersion(directory:string, version:string) {
  const path = join(directory, version + '.lock');
  if (!await lstat(path).catch(() => undefined)) return false;
  const owner = await readFile(join(path,'owner.json'),'utf8').then(JSON.parse).catch(() => undefined);
  return !owner || alive(owner.pid);
}
async function removeAbandoned(root:string, directory:string, report:CleanupReport) {
  for (const entry of await entries(directory)) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (!await safeDirectory(root, path)) continue;
    const install = /\.install-(\d+)$/.exec(entry.name);
    const lock = /\.lock(?:\.|$)/.test(entry.name);
    if (install || lock) {
      const owner = lock ? await readFile(join(path,'owner.json'),'utf8').then(JSON.parse).catch(() => undefined) : {pid:Number(install![1])};
      if (owner && Number.isSafeInteger(owner.pid) && !alive(owner.pid)) {
        await rm(path,{recursive:true,force:true}); report.removed.push(path);
      }
    } else if (versionName.test(entry.name)) await removeAbandoned(root,path,report);
  }
}
export async function maintainCache() {
  try {
    const report = await cleanVersionCache();
    for (const warning of report.warnings) console.error(`SEUdaily 缓存维护：${warning}`);
    return report;
  } catch (error) { console.error(`SEUdaily 缓存维护失败：${(error as Error).message}`); }
}

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { VERSION } from './config.js';
import { randomUUID } from 'node:crypto';
import { cacheRoot, npmCommand } from './components.js';

const execute = promisify(execFile);
export function newerVersion(latest: string, current = VERSION) {
  const a = latest.split('.').map(Number), b = current.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}
export async function checkForUpdate(signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(5000);
  const response = await fetch('https://registry.npmjs.org/seudaily/latest', {signal:signal ? AbortSignal.any([signal,timeout]) : timeout});
  if (!response.ok) throw new Error('检查更新失败（' + response.status + '）');
  const metadata = await response.json() as {version:string};
  if (!/^\d+\.\d+\.\d+$/.test(metadata.version)) throw new Error('更新版本格式无效');
  return {current:VERSION, latest:metadata.version, available:newerVersion(metadata.version)};
}
export async function updateNotice(installRoot: string, dataRoot: string, signal?: AbortSignal) {
  const metadata = JSON.parse(await readFile(join(installRoot,'package.json'),'utf8'));
  if (metadata.private) return; // Source checkouts are updated through Git.
  const file = join(dataRoot,'.seudaily','update-check.json');
  const cached = await readFile(file,'utf8').then(JSON.parse).catch(()=>undefined);
  let latest = cached?.latest;
  if (!cached || Date.now() - cached.checkedAt > 24 * 60 * 60 * 1000) {
    latest = (await checkForUpdate(signal)).latest;
    await mkdir(dirname(file),{recursive:true});
    await writeFile(file,JSON.stringify({latest,checkedAt:Date.now()}));
  }
  return typeof latest === 'string' && newerVersion(latest) ? '发现新版本 ' + latest + '，运行 seudaily update 自动更新并重启后端。' : undefined;
}
export async function prepareUpdate(installRoot: string) {
  const metadata = JSON.parse(await readFile(join(installRoot,'package.json'),'utf8'));
  if (metadata.name !== 'seudaily') throw new Error('安装目录不是 SEUdaily');
  if (metadata.private) throw new Error('当前从源码运行，请使用 git pull 更新；npm 安装支持 seudaily update。');
  const checked = await checkForUpdate();
  const version = {...checked,current:metadata.version,available:newerVersion(checked.latest,metadata.version)};
  if (!version.available) return {version};
  const npm = await npmCommand();
  const root = (await execute(npm.command,[...npm.args,'root','--global'],{timeout:15000})).stdout.trim();
  const global = await realpath(join(root,'seudaily')).catch(()=>join(root,'seudaily'));
  const installed = await realpath(installRoot);
  let location: string[];
  if (global === installed) location = ['--global'];
  else if (basename(dirname(installRoot)) === 'node_modules') location = ['--prefix',dirname(dirname(installRoot))];
  else throw new Error('无法确定安装位置，请通过原安装方式更新。');
  const recovery = join(cacheRoot(), 'updates', `${process.pid}-${randomUUID()}`);
  const previousHost = join(recovery, 'host');
  let backedUp = false;
  const finalize = async () => { await rm(recovery,{recursive:true,force:true}); backedUp = false; };
  const rollback = async () => {
    if (!backedUp) return;
    try {
      await rm(installRoot,{recursive:true,force:true});
      await cp(previousHost,installRoot,{recursive:true,dereference:false});
      await finalize();
    } catch (error) { throw new Error(`原安装包恢复失败，恢复副本保留在 ${previousHost}：${(error as Error).message}`); }
  };
  return {version, rollback, finalize, install:async()=>{
    await mkdir(recovery,{recursive:true,mode:0o700});
    try {
      await cp(installRoot,previousHost,{recursive:true,dereference:false});
      await writeFile(join(recovery,'owner.json'),JSON.stringify({pid:process.pid,from:version.current,to:version.latest}),{mode:0o600});
      backedUp = true;
    } catch (error) { await finalize(); throw error; }
    try {
    console.log('正在更新 SEUdaily ' + version.current + ' → ' + version.latest + '…');
    const child = spawn(npm.command,[...npm.args,'install',...location,'seudaily@'+version.latest,'--registry=https://registry.npmjs.org/','--ignore-scripts','--no-audit','--no-fund'],{stdio:'inherit',windowsHide:true});
    await new Promise<void>((resolve,reject)=>{
      child.once('error',reject);
      child.once('exit',code=>code===0?resolve():reject(new Error('更新失败，请检查 npm 输出；退出码 '+code)));
    });
    const installed = JSON.parse(await readFile(join(installRoot,'package.json'),'utf8'));
    if (installed.name !== 'seudaily' || installed.version !== version.latest) throw new Error('新安装包的版本校验失败');
    console.log('安装完成：' + version.latest + '。正在恢复原后端并检查运行状态。');
    } catch (error) { await rollback(); throw error; }
  }};
}

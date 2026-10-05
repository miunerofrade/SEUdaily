import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { VERSION } from './config.js';
import { npmCommand } from './components.js';

const execute = promisify(execFile);
export function newerVersion(latest: string, current = VERSION) {
  const a = latest.split('.').map(Number), b = current.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}
export async function checkForUpdate() {
  const response = await fetch('https://registry.npmjs.org/seudaily/latest', {signal:AbortSignal.timeout(5000)});
  if (!response.ok) throw new Error('检查更新失败（' + response.status + '）');
  const metadata = await response.json() as {version:string};
  if (!/^\d+\.\d+\.\d+$/.test(metadata.version)) throw new Error('更新版本格式无效');
  return {current:VERSION, latest:metadata.version, available:newerVersion(metadata.version)};
}
export async function updateNotice(installRoot: string, dataRoot: string) {
  const metadata = JSON.parse(await readFile(join(installRoot,'package.json'),'utf8'));
  if (metadata.private) return; // Source checkouts are updated through Git.
  const file = join(dataRoot,'.seudaily','update-check.json');
  const cached = await readFile(file,'utf8').then(JSON.parse).catch(()=>undefined);
  let latest = cached?.latest;
  if (!cached || Date.now() - cached.checkedAt > 24 * 60 * 60 * 1000) {
    latest = (await checkForUpdate()).latest;
    await mkdir(dirname(file),{recursive:true});
    await writeFile(file,JSON.stringify({latest,checkedAt:Date.now()}));
  }
  return typeof latest === 'string' && newerVersion(latest) ? '发现新版本 ' + latest + '，退出后运行 seudaily update 更新。' : undefined;
}
export async function prepareUpdate(installRoot: string) {
  const metadata = JSON.parse(await readFile(join(installRoot,'package.json'),'utf8'));
  if (metadata.private) throw new Error('当前从源码运行，请使用 git pull 更新；npm 安装支持 seudaily update。');
  const version = await checkForUpdate();
  if (!version.available) return {version};
  const npm = await npmCommand();
  const root = (await execute(npm.command,[...npm.args,'root','--global'],{timeout:15000})).stdout.trim();
  const global = await realpath(join(root,'seudaily')).catch(()=>join(root,'seudaily'));
  const installed = await realpath(installRoot);
  let location: string[];
  if (global === installed) location = ['--global'];
  else if (basename(dirname(installRoot)) === 'node_modules') location = ['--prefix',dirname(dirname(installRoot))];
  else throw new Error('无法确定安装位置，请通过原安装方式更新。');
  return {version, install:async()=>{
    console.log('正在更新 SEUdaily ' + version.current + ' → ' + version.latest + '…');
    const child = spawn(npm.command,[...npm.args,'install',...location,'seudaily@'+version.latest,'--registry=https://registry.npmjs.org/','--ignore-scripts','--no-audit','--no-fund'],{stdio:'inherit',windowsHide:true});
    await new Promise<void>((resolve,reject)=>{
      child.once('error',reject);
      child.once('exit',code=>code===0?resolve():reject(new Error('更新失败，请检查 npm 输出；退出码 '+code)));
    });
    console.log('更新完成：' + version.latest + '。重新运行 seudaily 即可；可选组件首次使用时自动准备。');
  }};
}

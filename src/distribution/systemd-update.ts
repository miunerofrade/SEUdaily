import {readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import type {BackendIdentity} from './update-lifecycle.js';
const execute=promisify(execFile);
/** Resolve old and new user-service backends by their actual cgroup membership. */
export async function systemdUnit(identity:BackendIdentity, platform=process.platform,
  membership=(pid:number)=>readFile(`/proc/${pid}/cgroup`,'utf8'),
  controlGroup=async(unit:string)=>(await execute('systemctl',['--user','show',unit,'--property=ControlGroup','--value'],{timeout:10_000})).stdout.trim()) {
  if (platform !== 'linux') return undefined;
  if (!identity.processId) {
    if(identity.serviceManager)throw new Error('后端未提供 PID，无法验证服务管理器');
    return undefined;
  }
  const groups=await membership(identity.processId);
  const paths=groups.split('\n').map(line=>line.split(':').slice(2).join(':'));
  const detected=paths.map(path=>path.split('/').at(-1)).find(name=>name?.endsWith('.service'));
  const unit=identity.serviceManager==='systemd-user' ? identity.serviceUnit ?? 'seudaily.service' : detected;
  if (!unit) return undefined;
  if (!/^[\w@.-]+\.service$/.test(unit)) throw new Error('systemd 服务名称无效');
  const group=await controlGroup(unit);
  if (!group || !paths.some(path=>path===group || path.startsWith(group+'/')))
    throw new Error('无法验证 systemd 服务所属进程，未停止后端');
  return unit;
}

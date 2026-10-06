import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readlink } from 'node:fs/promises';
const exec = promisify(execFile);
export type Listener = { pid:number; port:number; command?:string };
export type RunningService = Listener & { version:string; dataRoot:string; persistent?:boolean; legacy:boolean; command:string };
function number(value: unknown) { const n=Number(value); return Number.isInteger(n) && n>0 ? n : undefined; }
export function parseLsofListeners(output:string): Listener[] {
  const result:Listener[]=[]; let pid:number|undefined, node=false;
  for(const line of output.split('\n')) {
    if(line.startsWith('p')) {pid=number(line.slice(1));node=false;}
    else if(line.startsWith('c')) node=/^(?:node(?:\.exe)?|MainThread)$/i.test(line.slice(1));
    else if(line.startsWith('n') && pid && node) {const port=number(line.match(/:(\d+)$/)?.[1]);if(port)result.push({pid,port});}
  }
  return result;
}
export function parseSsListeners(output:string): Listener[] {
  return output.split('\n').flatMap(line=>{
    const match=line.match(/\busers:\(\("(?:node(?:\.exe)?|MainThread)",pid=(\d+)/),address=line.trim().split(/\s+/)[3];
    const pid=number(match?.[1]),port=number(address?.match(/:(\d+)$/)?.[1]);return pid&&port?[{pid,port}]:[];
  });
}
export function parseWindowsListeners(output:string):Listener[] {
  const value=JSON.parse(output.trim()||'[]');
  return (Array.isArray(value)?value:value?[value]:[]).flatMap(item=>{const pid=number(item?.pid),port=number(item?.port);return pid&&port&&port<=65535?[{pid,port,...(typeof item.command==='string'?{command:item.command}:{})}]:[];});
}
export async function nodeListeners(): Promise<Listener[]> {
  if(process.platform==='win32') {
    const script = "$nodes=@{}; Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" -ErrorAction Stop | ForEach-Object {$nodes[[int]$_.ProcessId]=$_.CommandLine}; $listeners=@(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object {$nodes.ContainsKey([int]$_.OwningProcess)} | ForEach-Object {@{pid=[int]$_.OwningProcess;port=[int]$_.LocalPort;command=$nodes[[int]$_.OwningProcess]}}); ConvertTo-Json -InputObject $listeners -Compress";
    // CIM/network providers can initialize slowly on a busy Windows host.
    for (let attempt = 0; ; attempt++) {
      try {
        const {stdout}=await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{timeout:30000,windowsHide:true,maxBuffer:4*1024*1024});
        return parseWindowsListeners(stdout);
      } catch (error) {
        if (attempt === 0) continue;
        const failure = error as { killed?: boolean; stderr?: string; message?: string };
        throw new Error(`无法查询 Windows 服务端口：${failure.killed ? '系统查询超时，请重试' : failure.stderr?.trim() || failure.message}`);
      }
    }
  }
  try {const {stdout}=await exec('lsof',['-nP','-iTCP','-sTCP:LISTEN','-Fpcn'],{timeout:5000,maxBuffer:4*1024*1024});return parseLsofListeners(stdout);}
  catch(error) {
    if((error as {code?:number}).code===1 && (error as {stdout?:string}).stdout==='')return [];
    if(process.platform!=='linux')throw new Error('无法列出服务：需要系统 lsof 命令');
    const {stdout}=await exec('ss',['-ltnp'],{timeout:5000,maxBuffer:4*1024*1024});return parseSsListeners(stdout);
  }
}
export async function processCommand(pid:number):Promise<string> {
  if(process.platform==='win32') {
    const {stdout}=await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',`(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`],{timeout:5000,windowsHide:true});return stdout.trim();
  }
  return (await exec('ps',['-p',String(pid),'-o','args='],{timeout:5000})).stdout.trim();
}
export async function processDirectory(pid:number):Promise<string|undefined> {
  if(process.platform==='linux')return readlink(`/proc/${pid}/cwd`).catch(()=>undefined);
  if(process.platform==='darwin')return (await exec('lsof',['-a','-p',String(pid),'-d','cwd','-Fn'],{timeout:5000})).stdout.split('\n').find(line=>line.startsWith('n'))?.slice(1);
  return undefined;
}
export function isServiceCommand(command:string) {
  return /(?:^|[/\\\s"'])core\.mjs(?:[\s"']|$)/.test(command) || /(?:^|[/\\\s"'])src[/\\]server[/\\]main\.(?:ts|js)(?:[\s"']|$)/.test(command);
}
export function isServiceIdentity(value:any) {return value?.name==='SEUdaily' && value?.runtime==='agent';}
export async function discoverServices(list = nodeListeners, command = processCommand, probe = async(port:number)=>{
  const response=await fetch(`http://127.0.0.1:${port}/api`,{signal:AbortSignal.timeout(1500),redirect:'error'});
  return response.ok ? response.json() : undefined;
}):Promise<RunningService[]> {
  const listeners=await list(),unique=[...new Map(listeners.map(item=>[`${item.pid}:${item.port}`,item])).values()];
  const commands=new Map<number,Promise<string>>();
  const results:RunningService[]=[];
  // Bound parallelism so ps never floods local Node services with connections.
  for(let index=0;index<unique.length;index+=8) {
    const batch=await Promise.all(unique.slice(index,index+8).map(async listener=>{
      try {
        if(!commands.has(listener.pid))commands.set(listener.pid,listener.command!==undefined?Promise.resolve(listener.command):command(listener.pid));
        const cmd=await commands.get(listener.pid)!;if(!isServiceCommand(cmd))return undefined;
        const identity=await probe(listener.port);if(!isServiceIdentity(identity) || identity.processId!==undefined && identity.processId!==listener.pid)return undefined;
        return {...listener,command:cmd,version:typeof identity.version==='string'?identity.version:'旧版',dataRoot:typeof identity.dataRoot==='string'?identity.dataRoot:'未知（旧版）',persistent:typeof identity.persistent==='boolean'?identity.persistent:undefined,legacy:identity.protocol===undefined};
      }catch{return undefined;}
    }));
    for(const service of batch)if(service)results.push(service);
  }
  return results.sort((a,b)=>a.port-b.port || a.pid-b.pid);
}

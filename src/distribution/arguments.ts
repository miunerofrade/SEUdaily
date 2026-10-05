import { parseArgs } from 'node:util';
import { VERSION } from './config.js';
export const HELP = `SEUdaily ${VERSION}
用法：seudaily [命令] [参数]

  chat                 终端聊天（默认）；--chat / -c
  web                  本地网页；--web / -w
  settings             打开终端设置，配置模型和校园账号
  ask "问题"           单次提问；--stdin 读取管道，--json 输出 JSONL
  vpn PORT             独立校园 VPN；--vpn PORT，使用已保存的账号密码
  status / stop        查看状态 / 停止本地后端
  update               检查并安装最新版本
  sessions / skills    会话 / Skill 列表
  completion SHELL     bash、zsh、fish、powershell 补全
  import-data PATH     从旧仓库复制数据，保留原件；目标须为空

  --data-dir PATH      用户数据目录
  --port PORT          后端端口（默认 4111）
  --resume [ID], -r    恢复会话；省略 ID 打开列表（chat）
  --skill NAME         本轮 Skill，可重复
  --timeout SECONDS    请求超时，默认 300 秒
  --quiet / -q         简洁输出
  --verbose / -v       详细输出
  --no-color / --vi    终端显示及按键
  --help / -h          帮助
  --version / -V       版本

CLI 与后端已内置；首次使用 Web/校园工具时准备可选组件；普通聊天不需要 Python。`;
export function parseCommand(args: string[]) {
  const normalized = args.flatMap((value, index) => (value === '--resume' || value === '-r') && (!args[index + 1] || args[index + 1].startsWith('-')) ? [value, 'choose'] : [value]);
  const { values, positionals } = parseArgs({ args: normalized, allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'V' },
    chat: { type: 'boolean', short: 'c' }, web: { type: 'boolean', short: 'w' }, vpn: { type: 'string' },
    'data-dir': { type: 'string' }, port: { type: 'string' }, resume: { type: 'string', short: 'r' },
    skill: { type: 'string', multiple: true }, timeout: { type: 'string' }, stdin: { type: 'boolean' }, json: { type: 'boolean' },
    quiet: { type: 'boolean', short: 'q' }, verbose: { type: 'boolean', short: 'v' }, 'no-color': { type: 'boolean' }, vi: { type: 'boolean' },
  } });
  const modes = [values.chat && 'chat', values.web && 'web', values.vpn !== undefined && 'vpn'].filter((value): value is string => typeof value === 'string');
  if (modes.length > 1) throw new Error('请只选择一种运行模式');
  const command = positionals.shift() ?? modes[0] ?? 'chat';
  if (modes.length && modes[0] !== command) throw new Error('运行模式与子命令冲突');
  if (!['chat', 'web', 'settings', 'ask', 'vpn', 'status', 'stop', 'update', 'sessions', 'skills', 'completion', 'import-data'].includes(command)) throw new Error(`未知命令：${command}；运行 seudaily --help 查看用法`);
  const argument = command === 'vpn' ? values.vpn ?? positionals.shift() : positionals.shift();
  if (positionals.length || argument && !['ask', 'vpn', 'completion', 'import-data'].includes(command)) throw new Error('额外的位置参数');
  const port = Number(values.port ?? process.env.SEUDAILY_PORT ?? 4111), timeout = Number(values.timeout ?? 300);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('--port 应为 1024–65535');
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('--timeout 必须是有限正数');
  if (values.quiet && values.verbose) throw new Error('--quiet 与 --verbose 不能同时使用');
  if ((values.stdin || values.json) && command !== 'ask') throw new Error('--stdin / --json 仅用于 ask');
  if (values.resume && command !== 'chat') throw new Error('--resume 仅用于 chat');
  if (['vpn', 'completion', 'import-data'].includes(command) && !argument && !values.help && !values.version) throw new Error(`${command} 缺少参数`);
  const vpn = command === 'vpn' ? Number(argument) : undefined;
  if (vpn !== undefined && (!Number.isInteger(vpn) || vpn < 1024 || vpn > 65535)) throw new Error('VPN 端口应为 1024–65535');
  return { values, command: String(command), argument, port, timeout, vpn };
}
export function completion(shell: string) {
  const words = 'chat web settings ask vpn status stop update sessions skills completion import-data --chat --web --vpn --data-dir --port --resume --skill --timeout --stdin --json --quiet --verbose --no-color --vi --help --version';
  if (shell === 'bash') return `complete -W '${words}' seudaily`;
  if (shell === 'zsh') return `#compdef seudaily\n_arguments '*:command:(${words})'`;
  if (shell === 'fish') return `complete -c seudaily -f -a '${words}'`;
  if (shell === 'powershell') return `Register-ArgumentCompleter -Native -CommandName seudaily -ScriptBlock { param($wordToComplete) '${words}'.Split(' ') | Where-Object { $_ -like "$wordToComplete*" } }`;
  throw new Error('补全支持 bash、zsh、fish、powershell');
}

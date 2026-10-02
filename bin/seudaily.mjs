#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const metadata = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
const [command = '--help', argument, ...extra] = process.argv.slice(2);
const templateFiles = ['src', 'apps', 'skills', 'tests', 'bin', 'scripts', 'docs', 'tsconfig.json', 'pyproject.toml', 'uv.lock', 'requirements.txt', 'requirements-media.txt', '.env.example', '.node-version', '.python-version', 'README.md', 'CHANGELOG.md', 'LICENSE'];

function init(directory = 'seudaily') {
  const target = resolve(directory);
  if (existsSync(target) && readdirSync(target).length) throw new Error(`目标目录不是空目录：${target}`);
  mkdirSync(target, { recursive: true });
  for (const name of templateFiles) {
    const source = join(packageRoot, name);
    if (!existsSync(source)) continue;
    cpSync(source, join(target, name), { recursive: true, filter: (path) => !relative(packageRoot, path).split(/[\\/]/).some((part) => ['__pycache__', 'node_modules', '.venv', 'dist'].includes(part)) });
  }
  const lockPath = [join(packageRoot, 'template/npm-lock.json'), join(packageRoot, 'package-lock.json')].find(existsSync);
  if (!lockPath) throw new Error('npm 模板缺少锁文件，请使用完整的发布包。');
  cpSync(lockPath, join(target, 'package-lock.json'));
  writeFileSync(join(target, 'package.json'), `${JSON.stringify({ ...metadata, private: true }, null, 2)}\n`);
  writeFileSync(join(target, '.env'), readFileSync(join(target, '.env.example')), { mode: 0o600, flag: 'wx' });
  writeFileSync(join(target, '.gitignore'), 'node_modules/\n.venv/\n.mastra/\n.seudaily/\n.cvstream/\n.env\n.env.*\n!.env.example\nexports/\nbrowser_data/\ncookies.json\nconfig.json\n__pycache__/\ndist/\n*.tgz\n');
  console.log(`已初始化 ${target}\n接下来进入该目录：\n  npm ci\n  uv sync --frozen\n填写 .env，然后执行：\n  npx --no-install seudaily start`);
}

function findProjectRoot(start) {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, 'pyproject.toml')) && existsSync(join(current, 'src/seudaily/launcher.py')) && existsSync(join(current, 'package.json'))) return current;
    const parent = dirname(current);
    if (parent === current) throw new Error('请在 SEUdaily 项目内运行；先执行 seudaily init <目录>。');
    current = parent;
  }
}

function doctor() {
  console.log(`Node ${process.version} (${process.execPath})\n支持范围：${metadata.engines.node}`);
  for (const [name, args, optional] of [['uv', ['--version'], false], ['ffmpeg', ['-version'], true]]) {
    const result = spawnSync(name, args, { encoding: 'utf8' });
    console.log(result.error || result.status !== 0 ? `${name}: 未找到${optional ? '（媒体处理才需要）' : '（必需）'}` : result.stdout.split('\n')[0]);
    if (!optional && (result.error || result.status !== 0)) process.exitCode = 1;
  }
  console.log('Python：项目要求 3.13+，推荐 uv sync --frozen 使用 3.13。浏览器默认 Windows Edge / macOS WebKit / Linux Firefox；macOS/Linux 需安装 Node 与 Python 对应的 Playwright 浏览器运行时。API key 请在项目 .env 填写。');
}

try {
  if (extra.length || (argument && !['init', 'start'].includes(command))) throw new Error('参数过多；运行 seudaily --help 查看用法。');
  if (command === 'init') init(argument);
  else if (command === 'doctor') doctor();
  else if (command === 'start') {
    const root = findProjectRoot(argument || process.cwd());
    if (!existsSync(join(root, 'node_modules/mastra'))) throw new Error('请先在项目目录执行 npm ci（包含开发依赖）和 uv sync --frozen。');
    const result = spawnSync('uv', ['run', '--frozen', 'seudaily', 'start'], { cwd: root, stdio: 'inherit', env: { ...process.env, SEUDAILY_PROJECT_ROOT: root } });
    if (result.error) throw new Error(`无法启动 uv：${result.error.message}`);
    process.exitCode = result.status ?? 1;
  } else if (['--version', '-v'].includes(command)) console.log(metadata.version);
  else if (['--help', '-h', 'help'].includes(command)) console.log('SEUdaily\n  seudaily init [目录]  在空目录初始化本地应用及 .env\n  seudaily start [目录] 启动已安装依赖的本地应用\n  seudaily doctor       检查运行依赖\n  seudaily --version\n此 npm 包分发应用源码模板；init 后需 npm ci 和 uv sync --frozen。');
  else throw new Error(`未知命令：${command}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

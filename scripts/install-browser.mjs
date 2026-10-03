import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
config({ path: resolve(root, '.env') });
const core = dirname(require.resolve('playwright-core/package.json'));
const nodeVersion = require('playwright-core/package.json').version;
const metadata = spawnSync('uv', ['run', '--frozen', 'python', '-c',
  'import json,pathlib,playwright,importlib.metadata; p=pathlib.Path(playwright.__file__).parent/"driver/package/browsers.json"; print(json.dumps({"version":importlib.metadata.version("playwright"),"browsers":json.loads(p.read_text())}))'],
  { cwd: root, encoding: 'utf8' });
if (metadata.status !== 0) {
  process.stderr.write(metadata.stderr || '无法读取 Python Playwright 版本；请先运行 uv sync --frozen。\n');
  process.exit(1);
}
const python = JSON.parse(metadata.stdout);
if (nodeVersion !== python.version || JSON.stringify(JSON.parse(readFileSync(resolve(core, 'browsers.json'), 'utf8'))) !== JSON.stringify(python.browsers)) {
  console.error('Node 与 Python Playwright 版本或浏览器构建不一致，请同时更新 package.json、pyproject.toml 和两份锁文件。');
  process.exit(1);
}
console.log(`Node/Python Playwright 已统一：${nodeVersion}`);
let browser = (process.env.SEUDAILY_BROWSER ?? process.env.CVSTREAM_BROWSER ?? 'auto').trim().toLowerCase() || 'auto';
if (browser === 'auto') browser = process.platform === 'win32' ? 'msedge' : process.platform === 'darwin' ? 'webkit' : 'firefox';
if (browser === 'safari') browser = 'webkit';
if (!['msedge', 'webkit', 'firefox', 'chromium'].includes(browser)) {
  console.error('SEUDAILY_BROWSER 必须为 auto、msedge、webkit、safari、firefox 或 chromium');
  process.exit(1);
}
if (browser === 'msedge') {
  console.log('使用已安装的 Microsoft Edge，无需下载浏览器。');
} else {
  const result = spawnSync('uv', ['run', '--frozen', 'playwright', 'install', browser], { cwd: root, stdio: 'inherit' });
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status ?? 1;
}

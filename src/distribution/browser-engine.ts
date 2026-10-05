import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { ensureComponent, cacheRoot, setPreparation } from './components.js';
import { playwrightBrowserConfig } from '../runtime/tools/browser-config.js';
const exec = promisify(execFile);
const preparations = new Map<string, Promise<void>>();
export async function prepareBrowserEngine(component: string, configured = process.env.SEUDAILY_BROWSER ?? process.env.CVSTREAM_BROWSER ?? 'auto') {
  const config = playwrightBrowserConfig(process.platform, configured);
  const engine = config.browser.launchOptions.channel ?? config.browser.browserName;
  if (process.env.SEUDAILY_INSTALL_ROOT) process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(cacheRoot(), 'browsers');
  if (engine === 'msedge') return; // Windows uses the system Edge installation.
  const key = `${component}:${engine}:${process.env.PLAYWRIGHT_BROWSERS_PATH ?? ''}`;
  if (preparations.has(key)) return preparations.get(key);
  const pending = (async () => {
    const require = createRequire(join(component, 'index.mjs'));
    const core = dirname(require.resolve('playwright-core/package.json'));
    if (existsSync(require('playwright-core')[engine].executablePath())) return;
    console.error(`正在下载 ${engine} 浏览器（首次使用）…`);
    setPreparation('browser', 'preparing', `正在下载并安装 ${engine === 'firefox' ? 'Firefox' : engine === 'webkit' ? 'WebKit' : 'Chromium'} 浏览器…`);
    try { await exec(process.execPath, [join(core, 'cli.js'), 'install', engine], { env: process.env, timeout: 10 * 60_000, maxBuffer: 2 * 1024 * 1024 }); }
    catch (error) { const message = `浏览器自动安装失败，请检查网络后重试：${(error as Error).message}`; setPreparation('browser', 'failed', message); throw new Error(message); }
  })();
  preparations.set(key, pending);
  try { await pending; setPreparation('browser', 'ready', '浏览器运行环境已就绪'); } finally { preparations.delete(key); }
}
export async function browserComponent(configured?: string) {
  setPreparation('browser', 'preparing', '正在检查或下载浏览器工具组件…');
  try {
    const component = await ensureComponent('browser');
    await prepareBrowserEngine(component, configured);
    setPreparation('browser', 'ready', '浏览器运行环境已就绪');
    return join(component, 'index.mjs');
  } catch (error) { setPreparation('browser', 'failed', (error as Error).message); throw error; }
}

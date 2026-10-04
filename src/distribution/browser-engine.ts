import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { ensureComponent, cacheRoot } from './components.js';
const exec = promisify(execFile);
export async function browserComponent() {
  const component = await ensureComponent('browser');
  const require = createRequire(join(component, 'index.mjs'));
  const core = dirname(require.resolve('playwright-core/package.json'));
  const selected = process.env.SEUDAILY_BROWSER?.toLowerCase() || 'auto';
  const engine = selected === 'auto' ? process.platform === 'darwin' ? 'webkit' : process.platform === 'win32' ? 'msedge' : 'firefox' : selected === 'safari' ? 'webkit' : selected;
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(cacheRoot(), 'browsers');
  if (engine !== 'msedge') await exec(process.execPath, [join(core, 'cli.js'), 'install', engine], { env: process.env, timeout: 10 * 60_000, maxBuffer: 2 * 1024 * 1024 });
  return join(component, 'index.mjs');
}

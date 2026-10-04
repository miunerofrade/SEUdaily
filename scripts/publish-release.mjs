// Publishing is an explicit, protected Actions step. Preparation/dry-run never invokes this script.
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
if (process.argv[2] !== version || process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('发布只允许在 main 的 GitHub Actions 中显式执行匹配版本。');
if (!process.env.npm_execpath) throw new Error('请通过 npm run release:publish 执行');
const index = JSON.parse(await readFile(join(root, 'build/release/packages/index.json'), 'utf8'));
// Check every version before the first mutation; network/auth errors must not be treated as absence.
for (const item of index) {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(item.name)}/${item.version}`);
  if (response.status !== 404) throw new Error(response.ok ? `${item.name}@${item.version} 已存在，请更新版本。` : `npm 检查失败：${response.status}`);
}
for (const item of index) execFileSync(process.execPath, [process.env.npm_execpath, 'publish', join(root, 'build/release/packages', item.filename), '--access', 'public', '--provenance'], { cwd: root, stdio: 'inherit' });

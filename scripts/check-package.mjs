import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const result = process.env.npm_execpath
  ? spawnSync(process.execPath, [process.env.npm_execpath, 'pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' })
  : spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' });
assert.equal(result.status, 0, result.stderr || result.error?.message);
const [pack] = JSON.parse(result.stdout);
const paths = pack.files.map((file) => file.path);
for (const required of ['bin/seudaily.mjs', 'src/mastra/index.ts', 'src/seudaily/worker.py', 'apps/web/index.html', 'skills/training-plan-audit/SKILL.md', 'pyproject.toml', 'uv.lock', '.env.example', 'template/npm-lock.json', 'LICENSE']) assert(paths.includes(required), `缺少发布文件：${required}`);
for (const path of paths) assert(!/(^|\/)(?:\.env(?:$|\.(?!example$))|\.seudaily|\.cvstream|\.venv|node_modules|browser_data|exports|__pycache__|res)(\/|$)|\.pyc$|\.tgz$|(?:^|\/)cookies\.json$/.test(path), `私有/无关文件进入包：${path}`);
console.log(`发布白名单检查通过：${paths.length} 文件，压缩 ${pack.size} bytes。`);

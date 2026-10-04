import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..'), output = resolve(root, 'build/packages');
if (!process.env.npm_execpath) throw new Error('请通过 npm run pack:local 执行');
await rm(output, { recursive: true, force: true }); await mkdir(output, { recursive: true });
const report = [];
for (const name of ['host', 'web', 'python', 'browser']) {
  const cwd = name === 'host' ? root : resolve(root, 'dist/components', name);
  const packed = JSON.parse(execFileSync(process.execPath, [process.env.npm_execpath, 'pack', '--json', '--pack-destination', output], { cwd, encoding: 'utf8' }))[0];
  report.push({ component: name, filename: packed.filename, size: packed.size, unpackedSize: packed.unpackedSize, integrity: packed.integrity });
}
await writeFile(resolve(output, 'index.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

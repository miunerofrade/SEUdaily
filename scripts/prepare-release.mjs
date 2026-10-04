// Produces public candidates in a separate staging tree; never changes private source manifests.
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, cp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (process.argv[2] !== metadata.version) throw new Error('输入版本必须与 package.json 的版本一致；先提交版本更新，再生成发布候选。');
if (!process.env.npm_execpath) throw new Error('请通过 npm run release:prepare -- VERSION 执行');
const output = join(root, 'build/release');
await rm(output, { recursive: true, force: true });
await mkdir(join(output, 'packages'), { recursive: true });
const report = [];
for (const component of ['web', 'python', 'browser', 'host']) {
  const source = component === 'host' ? root : join(root, 'dist/components', component);
  const directory = join(output, 'staging', component);
  const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  if (manifest.version !== metadata.version) throw new Error('组件版本未对齐');
  await mkdir(directory, { recursive: true });
  const files = component === 'host' ? [...metadata.files, 'README.md', 'LICENSE'] : ['LICENSE', 'README.md', ...manifest.files.map(file => file.startsWith('*') ? null : file).filter(Boolean)];
  if (component === 'python') {
    const { readdir } = await import('node:fs/promises');
    files.push(...(await readdir(source)).filter(file => file.endsWith('.whl') || file.endsWith('requirements.txt')));
  }
  for (const file of files) await cp(join(source, file), join(directory, file), { recursive: true });
  manifest.private = false;
  manifest.repository = metadata.repository;
  manifest.homepage = metadata.homepage;
  manifest.bugs = metadata.bugs;
  manifest.publishConfig = { access: 'public', registry: 'https://registry.npmjs.org/' };
  if (component === 'host') { delete manifest.scripts; delete manifest.devDependencies; delete manifest.overrides; delete manifest.packageManager; }
  await writeFile(join(directory, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  const packed = JSON.parse(execFileSync(process.execPath, [process.env.npm_execpath, 'pack', '--json', '--pack-destination', join(output, 'packages')], { cwd: directory, encoding: 'utf8' }))[0];
  report.push({ component, name: packed.name, version: packed.version, filename: packed.filename, integrity: packed.integrity, size: packed.size, unpackedSize: packed.unpackedSize });
}
await writeFile(join(output, 'packages/index.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));

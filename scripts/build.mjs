import { build } from 'esbuild';
import { thirdPartyNotices } from './licenses.mjs';
import { productionBuildOptions } from './build-options.mjs';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const metadata = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const version = metadata.version;
const output = resolve(root, 'dist');
await rm(output, { recursive: true, force: true }); await mkdir(output, { recursive: true });
const common = productionBuildOptions;
const launcher = await build({ ...common, metafile: true, entryPoints: [resolve(root, 'src/distribution/launcher.ts')], outfile: resolve(output, 'launcher.mjs') });
const core = await build({ ...common, metafile: true, entryPoints: [resolve(root, 'src/distribution/core.ts')], outfile: resolve(output, 'core.mjs') });
await writeFile(resolve(output, 'THIRD_PARTY_NOTICES.txt'), await thirdPartyNotices([...Object.keys(launcher.metafile.inputs), ...Object.keys(core.metafile.inputs)]));
await cp(resolve(root, '.agent/skills'), resolve(output, 'skills'), { recursive: true });
const components = {};
for (const name of ['cli', 'web', 'python', 'browser']) {
  const directory = resolve(output, 'components', name); await mkdir(directory, { recursive: true });
  const packageName = `seudaily-${name}`; components[name] = packageName;
  await writeFile(resolve(directory, 'package.json'), JSON.stringify({ name: packageName, version, private: true, type: 'module', license: 'MIT',
    ...(name === 'browser' ? { dependencies: { 'playwright-core': metadata.dependencies?.playwright ?? metadata.devDependencies.playwright } } : {}), files: name === 'python' ? ['*.whl', '*requirements.txt'] : name === 'web' ? ['assets'] : ['index.mjs', 'THIRD_PARTY_NOTICES.txt'] }, null, 2));
  await cp(resolve(root, 'LICENSE'), resolve(directory, 'LICENSE'));
  if (name === 'cli' || name === 'browser') {
    const result = await build({ ...common, metafile: true, entryPoints: [resolve(root, name === 'cli' ? 'src/terminal/main.tsx' : 'src/distribution/browser.ts')], outfile: resolve(directory, 'index.mjs'),
      ...(name === 'browser' ? { external: [...common.external, 'playwright-core/lib/coreBundle'] } : {}) });
    await writeFile(resolve(directory, 'THIRD_PARTY_NOTICES.txt'), await thirdPartyNotices(Object.keys(result.metafile.inputs)));
  }
  if (name === 'web') {
    execFileSync(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), 'build', '--config', 'apps/web/vite.config.ts'], { cwd: root, stdio: 'inherit' });
    await cp(resolve(output, 'web'), resolve(directory, 'assets'), { recursive: true });
    await rm(resolve(output, 'web'), { recursive: true });
  }
  if (name === 'python') {
    execFileSync('uv', ['build', '--wheel', '--out-dir', directory], { cwd: root, stdio: 'inherit' });
    execFileSync('uv', ['export', '--frozen', '--no-dev', '--no-emit-project', '--output-file', resolve(directory, 'requirements.txt')], { cwd: root, stdio: 'ignore' });
    execFileSync('uv', ['export', '--frozen', '--no-dev', '--no-emit-project', '--extra', 'media', '--output-file', resolve(directory, 'media-requirements.txt')], { cwd: root, stdio: 'ignore' });
  }
}
await writeFile(resolve(output, 'components.json'), JSON.stringify(components, null, 2));
console.log('构建完成：基础包与 CLI、Web、Python、浏览器组件独立；未发布。');

import { build } from 'esbuild';
import { productionBuildOptions } from './build-options.mjs';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..'), output = resolve(root, 'build/validation');
await rm(output, { recursive: true, force: true }); await mkdir(output, { recursive: true });
for (const [name, entry] of Object.entries({ 'node/core': 'tests/distribution-fixtures/core.ts', terminal: 'tests/distribution-fixtures/terminal.tsx', 'browser-client': 'tests/distribution-fixtures/browser-client.ts', browser: 'src/distribution/browser.ts' })) {
  await build({ ...productionBuildOptions, entryPoints: [resolve(root, entry)], outfile: resolve(output, name + '.mjs'),
    ...(name === 'browser' ? { external: [...productionBuildOptions.external, 'playwright-core/lib/coreBundle'] } : {}) });
}

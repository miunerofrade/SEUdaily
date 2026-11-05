import { build } from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

/** Bundle complete modules, replacing only dependency boundaries with test doubles. */
export async function moduleFixture(directory, entry, mocks = {}) {
  const outfile = join(directory, 'fixture.mjs');
  await build({
    stdin: { contents: entry, resolveDir: repositoryRoot, sourcefile: 'test-entry.ts' },
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
    banner: { js: "import {createRequire as testCreateRequire} from 'node:module';const require=testCreateRequire(import.meta.url);" },
    plugins: [{
      name: 'fixture-dependencies',
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, args => {
          const key = Object.keys(mocks).find(key => args.path.endsWith(key));
          return key ? { path: key, namespace: 'fixture' } : undefined;
        });
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({
          contents: mocks[args.path], loader: 'js',
        }));
      },
    }],
  });
  return import(pathToFileURL(outfile).href);
}

import { readFile } from 'node:fs/promises';
const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
export const productionBuildOptions = { bundle: true, platform: 'node', target: 'node22.22', format: 'esm', minify: true,
  define: { 'process.env.NODE_ENV': '"production"', 'process.env.DEV': '"false"', 'process.env.SEUDAILY_BUILD_VERSION': JSON.stringify(metadata.version) },
  banner: { js: "import {createRequire as __createRequire} from 'node:module'; const require = __createRequire(import.meta.url);" },
  external: ['react-devtools-core'],
  plugins: [{ name: 'ink-production', setup(builder) { builder.onLoad({ filter: /[/\\]ink[/\\]build[/\\]reconciler\.js$/ }, async args => ({ contents: (await readFile(args.path, 'utf8')).replace("await import('./devtools.js');", 'void 0;'), loader: 'js' })); } }] };

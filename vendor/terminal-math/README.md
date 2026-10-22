# Vendored terminal-math core

Source: https://github.com/reyabsaluja/terminal-math
Commit: `be328dfe709eb9932a7bb1aa74c80a1d057a0be8` (package version 0.1.0).
The upstream `package.json` declares MIT; upstream has no standalone license
file. `LICENSE` records that declaration, attribution, and the standard MIT text.

This local build dependency bundles the unmodified parser, symbol table, box
layout and math renderer. The upstream whole-message formatter is excluded:
SEUdaily handles Markdown boundaries, streaming and lossless fallback itself.
No network fetch or compilation is required during installation.

To regenerate `index.mjs`, download that exact revision and use the repository's
existing esbuild with this entry, `bundle:true`, `format:'esm'`, `platform:'node'`:

```ts
export {parseMath} from './math/parser.js';
export {renderNode} from './math/render.js';
export {boxToString} from './core/stringify.js';
export {glyphFor} from './math/symbols.js';
```

Resolve the entry relative to upstream `src/`. Keep the provenance banner.
`index.d.mts` describes only the four exported functions used by our adapter.

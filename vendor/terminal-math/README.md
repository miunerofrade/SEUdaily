# Vendored terminal-math core

Source: https://github.com/reyabsaluja/terminal-math
Commit: `be328dfe709eb9932a7bb1aa74c80a1d057a0be8` (package version 0.1.0).
The upstream `package.json` declares MIT; upstream has no standalone license
file. `LICENSE` records that declaration, attribution, and the standard MIT text.

This local build dependency bundles the parser, symbol table, box layout and math renderer, with the local patch described below. The upstream whole-message formatter is excluded:
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

## Local patch

`compact-scripts.patch` adds the optional `compactScripts` rendering flag (default
`true`, preserving upstream behavior). When false, superscripts and subscripts
use the existing two-dimensional box layout instead of compact Unicode glyphs.
SEUdaily disables compact scripts for formulas containing letter subscripts and
promotes multiline inline results to display blocks. This keeps Greek symbols
and fraction layout while avoiding missing subscript glyphs in terminal fonts.

After regenerating `index.mjs`, apply from the SEUdaily repository root:

```sh
git apply vendor/terminal-math/compact-scripts.patch
```

`index.d.mts` includes the added option.

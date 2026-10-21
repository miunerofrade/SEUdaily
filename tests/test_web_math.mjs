import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {tsImport} from 'tsx/esm/api';
import {fileURLToPath} from 'node:url';
import {normalizeMathMarkdown} from '../apps/web/src/markdown.ts';
const options={parentURL:import.meta.url,tsconfig:fileURLToPath(new URL('../apps/web/tsconfig.json',import.meta.url))};
const {MarkdownContent}=await tsImport('../apps/web/src/chat/markdown-content.tsx',options);
const render=text=>renderToStaticMarkup(createElement(MarkdownContent,{text}));

test('LaTeX inline and display delimiters render the reported Fibonacci formulas',()=>{
 const source=String.raw`关于斐波那契数列，把 \(F_1=1,\ F_2=1,\ F_n=F_{n-1}+F_{n-2}\) 作为定义。

\[
F_n=\frac{\varphi^n-\psi^n}{\sqrt5},\qquad \varphi=\frac{1+\sqrt5}{2}\approx1.6180,\quad \psi=\frac{1-\sqrt5}{2}\approx-0.6180
\]

由于 \(|\psi|<1\)，当 \(n\) 较大时，可取整。`;
 const html=render(source);
 assert.equal((html.match(/class="katex"/g)??[]).length,4);
 assert.match(html,/class="katex-display"/);assert.doesNotMatch(html,/katex-error/);
});

test('dollar formulas remain supported and ordinary Markdown brackets stay unchanged',()=>{
 const source=String.raw`行内 $\dfrac{a}{b}$ 和 \(\displaystyle \dfrac{x}{y}\)。

$$
\dfrac{1}{2}
$$

[文件](https://example.com) 与 [普通文字]。`;
 const normalized=normalizeMathMarkdown(source);
 assert.match(normalized,/\$\\frac\{a\}\{b\}\$/);assert.match(normalized,/\$\\frac\{x\}\{y\}\$/);
 assert.match(normalized,/\n\\dfrac\{1\}\{2\}\n/);
 const html=render(source);assert.equal((html.match(/class="katex"/g)??[]).length,3);
 assert.match(html,/href="https:\/\/example.com"/);assert.match(html,/\[普通文字\]/);
});

test('inline code, backtick and tilde fences keep mathematical examples verbatim',()=>{
 const inline='`'+String.raw`\(x\) $\dfrac{1}{2}$`+'`';
 const multi='`` '+String.raw`\[x\]`+' `code` ``';
 for(const marker of ['```','~~~~']) {
  const fenced=marker+'text\n'+String.raw`\[x\] $\dfrac{1}{2}$`+'\n'+marker;
  assert.equal(normalizeMathMarkdown(fenced),fenced);
  assert.equal(normalizeMathMarkdown(fenced.replace('\n'+marker,'')),fenced.replace('\n'+marker,''));
 }
 assert.equal(normalizeMathMarkdown(inline),inline);assert.equal(normalizeMathMarkdown(multi),multi);
 assert.doesNotMatch(render(inline),/class="katex"/);
});

test('escaped delimiters and incomplete streaming math are preserved until complete',()=>{
 const escaped=String.raw`\\(ordinary\\)`;
 assert.equal(normalizeMathMarkdown(escaped),escaped);
 const partial=String.raw`结果：\[\frac{1}{2}`;
 assert.equal(normalizeMathMarkdown(partial),partial);
 assert.match(render(partial+String.raw`\]`),/class="katex-display"/);
});

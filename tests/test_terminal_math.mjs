import {test} from 'node:test';
import assert from 'node:assert/strict';
import stringWidth from 'string-width';
import {messageLines} from '../src/terminal/markdown.ts';
import {processLines} from '../src/terminal/process.ts';
import {terminalMath} from '../src/terminal/math.ts';

const rows = (message, width=80) => messageLines(message, width).map(row=>row.map(span=>span.text).join(''));
const answer = (text, width=80) => rows({role:'SEUdaily',text},width).join('\n');

test('terminal renders inline scripts and Greek symbols with both delimiter styles',()=>{
  for(const formula of ['$x_1^2+\\alpha$','\\(x_1^2+\\alpha\\)'])
    assert.match(answer('公式 '+formula+'，继续。'), /公式 x₁² \+ α，继续。/);
});

test('display fraction and radical preserve numerator, denominator, scope and surrounding prose',()=>{
  const text=answer(String.raw`前文\[x=\frac{-b\pm\sqrt{b^2-4ac}}{2a}\]后文`);
  assert.match(text,/前文\n/);
  assert.match(text,/- b ± √\(b² - 4ac\)/);
  assert.match(text,/x = ─+/);
  assert.match(text,/\n\s+2a\n/);
  assert.match(text,/后文/);
});

test('compact fractions retain grouping rather than changing operator precedence',()=>{
  assert.match(answer(String.raw`$\frac{a+b}{c}$`),/\(a \+ b\)\s*\/\s*c/);
  assert.match(answer(String.raw`$\frac{1}{\frac{a}{b}}$`),/1\s*\/\s*\(a\s*\/\s*b\)/);
  assert.match(answer(String.raw`$\frac{a}{b}^2$`),/\(a\s*\/\s*b\)²/);
  assert.match(answer('${a+b}^2$'),/\(a \+ b\)²/);
  const display=answer(String.raw`$$\tfrac{a+b}{c}$$`);
  assert.match(display,/a \+ b/);assert.match(display,/─+/);assert.match(display,/\n\s+c\n/);
});

test('matrix and aligned rows remain intact and are not treated as Markdown tables',()=>{
  const matrix=answer(String.raw`$$\begin{pmatrix}1&2\\3&4\end{pmatrix}$$`);
  assert.match(matrix,/⎛ 1  2 ⎞\n  ⎝ 3  4 ⎠/);
  const aligned=answer(String.raw`$$\begin{aligned}a&=1\\b&=2\end{aligned}$$`);
  assert.match(aligned,/a\s*= 1/);assert.match(aligned,/b\s*= 2/);
  assert.ok(!aligned.includes('┌'));
});

test('code, currency, escaped delimiters and user input are not transformed',()=>{
  for(const source of [
    '```tex\n$x^2$\n\\[x^2\\]\n```',
    '~~~js\nconst a = "$x^2$";\n~~~',
    '``use `$x^2$` here``',
    '价格 $5 and $10。',
    String.raw`转义 \$x^2\$ 和 \\(x^2\\)`,
    '```tex\n$x^2$',
    '    example $x^2$\n\tmore $x^2$',
  ]) assert.equal(terminalMath(source,80).text,source);
  assert.match(rows({role:'你',text:'$x^2$'}).join('\n'),/\$x\^2\$/);
});

test('unsupported, incomplete and oversized formulas keep exact source instead of dropping content',()=>{
  for(const source of [
    String.raw`$$\frac{a}{$$`,
    String.raw`$$\unknown{x}$$`,
    String.raw`$\begin{pmatrix}1&2\\3&4\end{pmatrix}$`,
    String.raw`$$\begin{array}{cc}1&2\\3&4\end{array}$$`,
    String.raw`$$a\over b$$`,
    String.raw`$$\text{单位}\frac{1}{2}$$`,
    '$$'+ 'x+'.repeat(1100)+'x$$',
    '$$'+ '{'.repeat(40)+'x'+'}'.repeat(40)+'$$',
  ]) assert.equal(terminalMath(source,80).text,source);
});

test('streamed prefixes stay raw until closed; resize falls back without breaking a formula grid',()=>{
  const source=String.raw`$$x=\frac{12345}{67890}$$`;
  const message={role:'SEUdaily',text:''};
  for(let i=1;i<source.length;i++) {
    message.text=source.slice(0,i);
    assert.equal(terminalMath(message.text,80).text,message.text);
    assert.ok(rows(message).join('\n').includes(message.text));
  }
  message.text=source;
  assert.match(rows(message).join('\n'),/─+/);
  const narrow=rows(message,6);
  assert.ok(narrow.every(row=>stringWidth(row)<=6));
  assert.equal(narrow.join('').replaceAll(' ',''),source);
  assert.match(rows(message,80).join('\n'),/67890/);
});

test('reasoning and answer render identically in live and restored process messages',()=>{
  const text=String.raw`$$\frac{1}{2}$$`;
  const process=[{type:'reasoning',text:'先看 $x^2$',expanded:true},{type:'text',text}];
  const live={role:'SEUdaily',text,streaming:true,process};
  const restored=structuredClone({...live,streaming:false});
  assert.deepEqual(processLines(live,80,true),processLines(restored,80,true));
  assert.ok(processLines(live,80,true).flat().some(span=>span.text.includes('x²')));
  assert.equal(live.text,text);
  assert.equal(live.process[0].text,'先看 $x^2$');
});

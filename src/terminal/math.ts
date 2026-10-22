import katex from 'katex';
import stringWidth from 'string-width';
import {parseMath, renderNode, boxToString, glyphFor, type MathNode} from 'terminal-math-typesetter';

const cache = new Map<string, string | null>();

/** Reject unsupported symbols; retain radical scope explicitly in text output. */
function prepareNode(value: unknown, display: boolean): unknown {
  if (Array.isArray(value)) return value.map(child => prepareNode(child, display));
  if (!value || typeof value !== 'object') return value;
  const node = value as MathNode;
  if (node.type === 'raw' || (node.type === 'symbol' && typeof node.value === 'string' && node.value.startsWith('\\') && !glyphFor(node.value)))
    throw new Error('Unsupported math');
  const next = Object.fromEntries(Object.entries(node).map(([key, child]) => [key, prepareNode(child, display)]));
  if (next.type === 'sqrt') next.body = {type:'paren', left:'(', right:')', body:next.body};
  if (next.type === 'supsub' && !['symbol','text','paren','opname','bigop'].includes((next.base as MathNode).type))
    next.base = {type:'paren', left:'(', right:')', body:next.base};
  if (next.type === 'frac') {
    if (display) next.variant = 'display';
    else {
      const operand = (body: unknown) => (body as MathNode)?.type === 'symbol' ? body : {type:'paren', left:'(', right:')', body};
      return {type:'group', children:[operand(next.numerator), {type:'symbol', value:'/'}, operand(next.denominator)]};
    }
  }
  return next;
}

function renderFormula(formula: string, display: boolean, width: number): string | null {
  if (formula.length > 2048) return null;
  const key = JSON.stringify([formula, display, width]);
  if (cache.has(key)) return cache.get(key)!;
  let rendered: string | null = null;
  try {
    // Bound synchronous layout work and refuse commands the upstream simplifies.
    if (/%|\\(?:over|atop|choose|def|newcommand)\b/.test(formula)) throw new Error('Unsupported math');
    let depth = 0;
    for (let i = 0; i < formula.length; i++) {
      if (!/\s/.test(formula[i]) && stringWidth(formula[i]) !== 1) throw new Error('Unsupported cell width');
      if (escaped(formula, i)) continue;
      if (formula[i] === '{' && ++depth > 32) throw new Error('Formula too deeply nested');
      if (formula[i] === '}') depth--;
    }
    for (const match of formula.matchAll(/\\begin\{([^}]+)\}/g))
      if (!['matrix','pmatrix','bmatrix','Bmatrix','vmatrix','Vmatrix','smallmatrix','cases','aligned','align','align*','equation','equation*','gather','gather*'].includes(match[1])) throw new Error('Unsupported environment');
    // The terminal parser is permissive. Validate completeness before layout.
    katex.renderToString(formula, {throwOnError:true, strict:'ignore', maxExpand:100, maxSize:20, output:'mathml'});
    const node = prepareNode(parseMath(formula), display) as MathNode;
    const box = renderNode(node, {display, unicode:true, ansi:false});
    const text = boxToString(box, {ansi:false, trim:true});
    const rows = text.split('\n');
    if (text.trim() && rows.every(row => stringWidth(row) <= width) && (display || rows.length === 1)) rendered = text;
  } catch { /* Preserve the exact source when syntax or layout cannot be represented. */ }
  if (cache.size >= 128) cache.delete(cache.keys().next().value!);
  cache.set(key, rendered);
  return rendered;
}

function escaped(source: string, index: number) {
  let count = 0;
  while (index > 0 && source[--index] === '\\') count++;
  return count % 2 === 1;
}

/** Display blocks are kept out of the Markdown renderer, preserving their grid. */
export function terminalMath(source: string, width: number) {
  const blocks = new Map<string, string[]>();
  const output: string[] = [];
  let start = 0, index = 0;
  while (index < source.length) {
    if (index === 0 || source[index - 1] === '\n') {
      if (/^(?: {4}|\t)/.test(source.slice(index))) {
        const end = source.indexOf('\n', index);
        index = end < 0 ? source.length : end + 1;
        continue;
      }
      const fence = /^ {0,3}(`{3,}|~{3,})[^\n]*(?:\n|$)/.exec(source.slice(index));
      if (fence) {
        const closing = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}[ \\t]*\\r?$`, 'gm');
        closing.lastIndex = index + fence[0].length;
        const match = closing.exec(source);
        index = match ? match.index + match[0].length : source.length;
        continue;
      }
    }
    if (source[index] === '`' && !escaped(source, index)) {
      const ticks = /^`+/.exec(source.slice(index))![0];
      const closing = new RegExp('(?<!`)`{' + ticks.length + '}(?!`)', 'g');
      closing.lastIndex = index + ticks.length;
      const match = closing.exec(source);
      index = match ? match.index + ticks.length : source.length;
      continue;
    }
    const pair = source.slice(index, index + 2);
    const opener = pair === '\\[' || pair === '\\(' || pair === '$$' ? pair : source[index] === '$' ? '$' : '';
    if (!opener) { index += source[index] === '\\' ? 2 : 1; continue; }
    if (escaped(source, index)) { index++; continue; }
    const display = opener === '$$' || opener === '\\[';
    const closer = opener === '\\[' ? '\\]' : opener === '\\(' ? '\\)' : opener;
    const bodyStart = index + opener.length;
    let end = source.indexOf(closer, bodyStart);
    while (end >= 0 && (escaped(source, end) || (closer === '$' && source[end + 1] === '$'))) end = source.indexOf(closer, end + closer.length);
    if (end < 0) { index = source.length; continue; }
    const formula = source.slice(bodyStart, end);
    if (!display && (formula.includes('\n') || !formula.trim() || (opener === '$' && (/^\s|\s$/.test(formula) || /\d/.test(source[end + 1] ?? ''))))) { index += opener.length; continue; }
    const rendered = renderFormula(formula, display, Math.max(1, width - (display ? 2 : 0)));
    if (rendered !== null) {
      output.push(source.slice(start, index));
      if (display) {
        const id = `\0terminal-math-${blocks.size}\0`;
        blocks.set(id, rendered.split('\n').map(row => '  ' + row));
        output.push(`\n${id}\n`);
      } else output.push(rendered);
      start = end + closer.length;
    }
    index = end + closer.length;
  }
  output.push(source.slice(start));
  return {text:output.join(''), blocks};
}

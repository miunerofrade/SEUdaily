// Vendored terminal-math-typesetter 0.1.0, MIT.
// Source: reyabsaluja/terminal-math@be328dfe709eb9932a7bb1aa74c80a1d057a0be8
// Generated with esbuild; do not edit this bundle directly.

// ../../../../private/tmp/seudaily-math-trial.KxkOln/src/math/ast.ts
function group(children) {
  if (children.length === 1) return children[0];
  return { type: "group", children };
}

// ../../../../private/tmp/seudaily-math-trial.KxkOln/src/core/errors.ts
var MathParseError = class extends Error {
  position;
  input;
  constructor(message, position, input) {
    super(message);
    this.name = "MathParseError";
    this.position = position;
    this.input = input;
  }
};

// ../../../../private/tmp/seudaily-math-trial.KxkOln/src/math/tokenizer.ts
var SINGLE_ESCAPES = /* @__PURE__ */ new Set([
  ",",
  ";",
  ":",
  "!",
  " ",
  "{",
  "}",
  "$",
  "%",
  "&",
  "#",
  "_",
  "|",
  "\\"
]);
function tokenize(source) {
  const tokens = [];
  const n = source.length;
  let i = 0;
  while (i < n) {
    const ch = source[i];
    if (ch === "{") {
      tokens.push({ type: "lbrace", pos: i });
      i++;
      continue;
    }
    if (ch === "}") {
      tokens.push({ type: "rbrace", pos: i });
      i++;
      continue;
    }
    if (ch === "^") {
      tokens.push({ type: "sup", pos: i });
      i++;
      continue;
    }
    if (ch === "_") {
      tokens.push({ type: "sub", pos: i });
      i++;
      continue;
    }
    if (ch === "&") {
      tokens.push({ type: "amp", pos: i });
      i++;
      continue;
    }
    if (ch === "\\") {
      if (i + 1 < n && source[i + 1] === "\\") {
        tokens.push({ type: "dblbackslash", pos: i });
        i += 2;
        continue;
      }
      const start = i;
      i++;
      if (i >= n) {
        tokens.push({ type: "command", name: "\\", pos: start });
        continue;
      }
      const next = source[i];
      if (SINGLE_ESCAPES.has(next)) {
        tokens.push({ type: "command", name: "\\" + next, pos: start });
        i++;
        continue;
      }
      if (/[a-zA-Z]/.test(next)) {
        let j = i;
        while (j < n && /[a-zA-Z]/.test(source[j])) j++;
        const name = "\\" + source.slice(i, j);
        tokens.push({ type: "command", name, pos: start });
        i = j;
        while (i < n && source[i] === " ") i++;
        continue;
      }
      tokens.push({ type: "command", name: "\\" + next, pos: start });
      i++;
      continue;
    }
    tokens.push({ type: "char", value: ch, pos: i });
    i++;
  }
  tokens.push({ type: "eof", pos: n });
  return tokens;
}

// ../../../../private/tmp/seudaily-math-trial.KxkOln/src/math/symbols.ts
function glyphFor(command) {
  const e = SYMBOLS[command];
  if (e) return e;
  return void 0;
}
var SYMBOLS = {
  // Greek lowercase
  "\\alpha": { unicode: "\u03B1", ascii: "alpha" },
  "\\beta": { unicode: "\u03B2", ascii: "beta" },
  "\\gamma": { unicode: "\u03B3", ascii: "gamma" },
  "\\delta": { unicode: "\u03B4", ascii: "delta" },
  "\\epsilon": { unicode: "\u03B5", ascii: "epsilon" },
  "\\varepsilon": { unicode: "\u03B5", ascii: "epsilon" },
  "\\zeta": { unicode: "\u03B6", ascii: "zeta" },
  "\\eta": { unicode: "\u03B7", ascii: "eta" },
  "\\theta": { unicode: "\u03B8", ascii: "theta" },
  "\\vartheta": { unicode: "\u03D1", ascii: "theta" },
  "\\iota": { unicode: "\u03B9", ascii: "iota" },
  "\\kappa": { unicode: "\u03BA", ascii: "kappa" },
  "\\lambda": { unicode: "\u03BB", ascii: "lambda" },
  "\\mu": { unicode: "\u03BC", ascii: "mu" },
  "\\nu": { unicode: "\u03BD", ascii: "nu" },
  "\\xi": { unicode: "\u03BE", ascii: "xi" },
  "\\pi": { unicode: "\u03C0", ascii: "pi" },
  "\\varpi": { unicode: "\u03D6", ascii: "pi" },
  "\\rho": { unicode: "\u03C1", ascii: "rho" },
  "\\varrho": { unicode: "\u03F1", ascii: "rho" },
  "\\sigma": { unicode: "\u03C3", ascii: "sigma" },
  "\\varsigma": { unicode: "\u03C2", ascii: "sigma" },
  "\\tau": { unicode: "\u03C4", ascii: "tau" },
  "\\upsilon": { unicode: "\u03C5", ascii: "upsilon" },
  "\\phi": { unicode: "\u03C6", ascii: "phi" },
  "\\varphi": { unicode: "\u03C6", ascii: "phi" },
  "\\chi": { unicode: "\u03C7", ascii: "chi" },
  "\\psi": { unicode: "\u03C8", ascii: "psi" },
  "\\omega": { unicode: "\u03C9", ascii: "omega" },
  // Greek uppercase
  "\\Gamma": { unicode: "\u0393", ascii: "Gamma" },
  "\\Delta": { unicode: "\u0394", ascii: "Delta" },
  "\\Theta": { unicode: "\u0398", ascii: "Theta" },
  "\\Lambda": { unicode: "\u039B", ascii: "Lambda" },
  "\\Xi": { unicode: "\u039E", ascii: "Xi" },
  "\\Pi": { unicode: "\u03A0", ascii: "Pi" },
  "\\Sigma": { unicode: "\u03A3", ascii: "Sigma" },
  "\\Upsilon": { unicode: "\u03A5", ascii: "Upsilon" },
  "\\Phi": { unicode: "\u03A6", ascii: "Phi" },
  "\\Psi": { unicode: "\u03A8", ascii: "Psi" },
  "\\Omega": { unicode: "\u03A9", ascii: "Omega" },
  // Operators / miscellany
  "\\partial": { unicode: "\u2202", ascii: "d" },
  "\\nabla": { unicode: "\u2207", ascii: "nabla" },
  "\\infty": { unicode: "\u221E", ascii: "inf" },
  "\\times": { unicode: "\xD7", ascii: "x", kind: "bin" },
  "\\div": { unicode: "\xF7", ascii: "/", kind: "bin" },
  "\\cdot": { unicode: "\xB7", ascii: "*", kind: "bin" },
  "\\pm": { unicode: "\xB1", ascii: "+-", kind: "bin" },
  "\\mp": { unicode: "\u2213", ascii: "-+", kind: "bin" },
  "\\propto": { unicode: "\u221D", ascii: "~", kind: "rel" },
  "\\circ": { unicode: "\u2218", ascii: "o", kind: "bin" },
  "\\bullet": { unicode: "\u2022", ascii: "*", kind: "bin" },
  "\\star": { unicode: "\u22C6", ascii: "*", kind: "bin" },
  "\\oplus": { unicode: "\u2295", ascii: "(+)", kind: "bin" },
  "\\otimes": { unicode: "\u2297", ascii: "(x)", kind: "bin" },
  "\\ast": { unicode: "\u2217", ascii: "*", kind: "bin" },
  // Relations
  "\\leq": { unicode: "\u2264", ascii: "<=", kind: "rel" },
  "\\le": { unicode: "\u2264", ascii: "<=", kind: "rel" },
  "\\geq": { unicode: "\u2265", ascii: ">=", kind: "rel" },
  "\\ge": { unicode: "\u2265", ascii: ">=", kind: "rel" },
  "\\neq": { unicode: "\u2260", ascii: "!=", kind: "rel" },
  "\\ne": { unicode: "\u2260", ascii: "!=", kind: "rel" },
  "\\approx": { unicode: "\u2248", ascii: "~=", kind: "rel" },
  "\\equiv": { unicode: "\u2261", ascii: "==", kind: "rel" },
  "\\sim": { unicode: "\u223C", ascii: "~", kind: "rel" },
  "\\simeq": { unicode: "\u2243", ascii: "~=", kind: "rel" },
  "\\cong": { unicode: "\u2245", ascii: "~=", kind: "rel" },
  "\\ll": { unicode: "\u226A", ascii: "<<", kind: "rel" },
  "\\gg": { unicode: "\u226B", ascii: ">>", kind: "rel" },
  "\\coloneqq": { unicode: "\u2254", ascii: ":=", kind: "rel" },
  "\\eqqcolon": { unicode: "\u2255", ascii: "=:", kind: "rel" },
  "\\prec": { unicode: "\u227A", ascii: "<", kind: "rel" },
  "\\succ": { unicode: "\u227B", ascii: ">", kind: "rel" },
  "\\preceq": { unicode: "\u2AAF", ascii: "<=", kind: "rel" },
  "\\succeq": { unicode: "\u2AB0", ascii: ">=", kind: "rel" },
  // Sets / logic
  "\\in": { unicode: "\u2208", ascii: "in", kind: "rel" },
  "\\notin": { unicode: "\u2209", ascii: "!in", kind: "rel" },
  "\\ni": { unicode: "\u220B", ascii: "ni", kind: "rel" },
  "\\subset": { unicode: "\u2282", ascii: "subset", kind: "rel" },
  "\\supset": { unicode: "\u2283", ascii: "supset", kind: "rel" },
  "\\subseteq": { unicode: "\u2286", ascii: "subseteq", kind: "rel" },
  "\\supseteq": { unicode: "\u2287", ascii: "supseteq", kind: "rel" },
  "\\cup": { unicode: "\u222A", ascii: "U", kind: "bin" },
  "\\cap": { unicode: "\u2229", ascii: "^", kind: "bin" },
  "\\setminus": { unicode: "\u2216", ascii: "\\", kind: "bin" },
  "\\emptyset": { unicode: "\u2205", ascii: "{}" },
  "\\varnothing": { unicode: "\u2205", ascii: "{}" },
  "\\forall": { unicode: "\u2200", ascii: "forall" },
  "\\exists": { unicode: "\u2203", ascii: "exists" },
  "\\nexists": { unicode: "\u2204", ascii: "!exists" },
  "\\neg": { unicode: "\xAC", ascii: "!" },
  "\\lnot": { unicode: "\xAC", ascii: "!" },
  "\\land": { unicode: "\u2227", ascii: "&&", kind: "bin" },
  "\\wedge": { unicode: "\u2227", ascii: "&&", kind: "bin" },
  "\\lor": { unicode: "\u2228", ascii: "||", kind: "bin" },
  "\\vee": { unicode: "\u2228", ascii: "||", kind: "bin" },
  "\\implies": { unicode: "\u21D2", ascii: "=>", kind: "rel" },
  "\\iff": { unicode: "\u21D4", ascii: "<=>", kind: "rel" },
  "\\therefore": { unicode: "\u2234", ascii: "therefore" },
  "\\because": { unicode: "\u2235", ascii: "because" },
  // Arrows
  "\\to": { unicode: "\u2192", ascii: "->", kind: "rel" },
  "\\rightarrow": { unicode: "\u2192", ascii: "->", kind: "rel" },
  "\\leftarrow": { unicode: "\u2190", ascii: "<-", kind: "rel" },
  "\\gets": { unicode: "\u2190", ascii: "<-", kind: "rel" },
  "\\leftrightarrow": { unicode: "\u2194", ascii: "<->", kind: "rel" },
  "\\Rightarrow": { unicode: "\u21D2", ascii: "=>", kind: "rel" },
  "\\Leftarrow": { unicode: "\u21D0", ascii: "<=", kind: "rel" },
  "\\Leftrightarrow": { unicode: "\u21D4", ascii: "<=>", kind: "rel" },
  "\\mapsto": { unicode: "\u21A6", ascii: "|->", kind: "rel" },
  "\\hookrightarrow": { unicode: "\u21AA", ascii: "->", kind: "rel" },
  "\\longrightarrow": { unicode: "\u27F6", ascii: "-->", kind: "rel" },
  "\\longleftarrow": { unicode: "\u27F5", ascii: "<--", kind: "rel" },
  // Dots
  "\\ldots": { unicode: "\u2026", ascii: "..." },
  "\\cdots": { unicode: "\u22EF", ascii: "..." },
  "\\vdots": { unicode: "\u22EE", ascii: ":" },
  "\\ddots": { unicode: "\u22F1", ascii: "..." },
  "\\dots": { unicode: "\u2026", ascii: "..." },
  // Delimiter names
  "\\{": { unicode: "{", ascii: "{", kind: "open" },
  "\\}": { unicode: "}", ascii: "}", kind: "close" },
  "\\lbrace": { unicode: "{", ascii: "{", kind: "open" },
  "\\rbrace": { unicode: "}", ascii: "}", kind: "close" },
  "\\langle": { unicode: "\u27E8", ascii: "<", kind: "open" },
  "\\rangle": { unicode: "\u27E9", ascii: ">", kind: "close" },
  "\\lceil": { unicode: "\u2308", ascii: "[", kind: "open" },
  "\\rceil": { unicode: "\u2309", ascii: "]", kind: "close" },
  "\\lfloor": { unicode: "\u230A", ascii: "[", kind: "open" },
  "\\rfloor": { unicode: "\u230B", ascii: "]", kind: "close" },
  "\\vert": { unicode: "|", ascii: "|" },
  "\\Vert": { unicode: "\u2016", ascii: "||" },
  "\\|": { unicode: "\u2016", ascii: "||" },
  "\\backslash": { unicode: "\\", ascii: "\\" },
  // Spaces (handled in parser usually)
  "\\,": { unicode: " ", ascii: " " },
  "\\;": { unicode: " ", ascii: " " },
  "\\:": { unicode: " ", ascii: " " },
  "\\!": { unicode: "", ascii: "" },
  "\\ ": { unicode: " ", ascii: " " },
  // Miscellaneous
  "\\prime": { unicode: "\u2032", ascii: "'" },
  "\\degree": { unicode: "\xB0", ascii: "deg" },
  "\\angle": { unicode: "\u2220", ascii: "angle" },
  "\\hbar": { unicode: "\u210F", ascii: "hbar" },
  "\\ell": { unicode: "\u2113", ascii: "l" },
  "\\Re": { unicode: "\u211C", ascii: "Re" },
  "\\Im": { unicode: "\u2111", ascii: "Im" },
  "\\aleph": { unicode: "\u2135", ascii: "aleph" },
  // Escaped characters
  "\\$": { unicode: "$", ascii: "$" },
  "\\%": { unicode: "%", ascii: "%" },
  "\\&": { unicode: "&", ascii: "&" },
  "\\#": { unicode: "#", ascii: "#" },
  "\\_": { unicode: "_", ascii: "_" }
};
var BIG_OPS = {
  "\\int": { unicode: "\u222B", ascii: "int" },
  "\\iint": { unicode: "\u222C", ascii: "iint" },
  "\\iiint": { unicode: "\u222D", ascii: "iiint" },
  "\\oint": { unicode: "\u222E", ascii: "oint" },
  "\\sum": { unicode: "\u2211", ascii: "Sum" },
  "\\prod": { unicode: "\u220F", ascii: "Prod" },
  "\\coprod": { unicode: "\u2210", ascii: "Coprod" },
  "\\bigcup": { unicode: "\u22C3", ascii: "U" },
  "\\bigcap": { unicode: "\u22C2", ascii: "^" },
  "\\bigoplus": { unicode: "\u2A01", ascii: "(+)" },
  "\\bigotimes": { unicode: "\u2A02", ascii: "(x)" },
  "\\lim": { unicode: "lim", ascii: "lim" },
  "\\max": { unicode: "max", ascii: "max" },
  "\\min": { unicode: "min", ascii: "min" },
  "\\sup": { unicode: "sup", ascii: "sup" },
  "\\inf": { unicode: "inf", ascii: "inf" },
  "\\argmax": { unicode: "argmax", ascii: "argmax" },
  "\\argmin": { unicode: "argmin", ascii: "argmin" }
};

// ../../../../private/tmp/seudaily-math-trial.KxkOln/src/math/parser.ts
var Parser = class {
  tokens;
  pos = 0;
  input;
  constructor(source) {
    this.input = source;
    this.tokens = tokenize(source);
  }
  parse() {
    const nodes = this.parseExpression({});
    return group(nodes);
  }
  peek(offset = 0) {
    return this.tokens[this.pos + offset] ?? { type: "eof", pos: this.input.length };
  }
  consume() {
    const t = this.peek();
    this.pos++;
    return t;
  }
  error(msg, pos) {
    return new MathParseError(msg, pos, this.input);
  }
  parseExpression(stop) {
    const out = [];
    while (true) {
      const t = this.peek();
      if (t.type === "eof") break;
      if (stop.rbrace && t.type === "rbrace") break;
      if (stop.rowBreak && t.type === "dblbackslash") break;
      if (stop.ampersand && t.type === "amp") break;
      if (stop.rightCmd && t.type === "command" && t.name === "\\right") break;
      if (stop.endEnv && t.type === "command" && t.name === "\\end") break;
      const atom = this.parseAtom();
      if (atom === void 0) break;
      const withScripts = this.parseScripts(atom);
      out.push(withScripts);
    }
    return out;
  }
  /**
   * Pull scripts (`^{...}` / `_{...}`) attached to the atom. Supports
   * x^2_1 and x_1^2 symmetrically, collapses primes into sup.
   */
  parseScripts(base) {
    let sup;
    let sub;
    while (true) {
      const t = this.peek();
      if (t.type === "sup") {
        this.consume();
        const s = this.parseScriptOperand();
        sup = sup ? group([sup, s]) : s;
        continue;
      }
      if (t.type === "sub") {
        this.consume();
        const s = this.parseScriptOperand();
        sub = sub ? group([sub, s]) : s;
        continue;
      }
      if (t.type === "char" && t.value === "'") {
        let count = 0;
        while (this.peek().type === "char" && this.peek().value === "'") {
          this.consume();
          count++;
        }
        const primes = [];
        for (let i = 0; i < count; i++) primes.push({ type: "symbol", value: "\u2032" });
        const primesNode = group(primes);
        sup = sup ? group([sup, primesNode]) : primesNode;
        continue;
      }
      break;
    }
    if (sup === void 0 && sub === void 0) return base;
    const node = { type: "supsub", base };
    if (sup !== void 0) node.sup = sup;
    if (sub !== void 0) node.sub = sub;
    if (base.type === "symbol" && this.isBigOpSymbol(base.value)) {
      const bigop = { type: "bigop", op: base.value };
      if (sup !== void 0) bigop.upper = sup;
      if (sub !== void 0) bigop.lower = sub;
      return bigop;
    }
    return node;
  }
  isBigOpSymbol(v) {
    return v === "\u222B" || v === "\u222C" || v === "\u222D" || v === "\u222E" || v === "\u2211" || v === "\u220F" || v === "\u2210" || v === "\u22C3" || v === "\u22C2" || v === "\u2A01" || v === "\u2A02" || v === "lim" || v === "max" || v === "min" || v === "sup" || v === "inf" || v === "argmax" || v === "argmin";
  }
  parseScriptOperand() {
    const t = this.peek();
    if (t.type === "lbrace") {
      return this.parseRequiredGroup();
    }
    if (t.type === "eof") {
      return group([]);
    }
    const atom = this.parseAtomNoScripts();
    return atom ?? group([]);
  }
  parseAtom() {
    return this.parseAtomNoScripts();
  }
  parseAtomNoScripts() {
    const t = this.peek();
    if (t.type === "eof") return void 0;
    if (t.type === "rbrace") return void 0;
    if (t.type === "dblbackslash") return void 0;
    if (t.type === "amp") return void 0;
    if (t.type === "lbrace") {
      return this.parseRequiredGroup();
    }
    if (t.type === "sup" || t.type === "sub") {
      return group([]);
    }
    if (t.type === "command") {
      return this.parseCommand();
    }
    this.consume();
    const ch = t.value;
    if (ch === " " || ch === "	" || ch === "\n") {
      return this.parseAtomNoScripts();
    }
    return { type: "symbol", value: ch };
  }
  parseRequiredGroup() {
    const t = this.peek();
    if (t.type !== "lbrace") {
      const a = this.parseAtomNoScripts();
      return a ?? group([]);
    }
    this.consume();
    const children = this.parseExpression({ rbrace: true });
    const closing = this.peek();
    if (closing.type === "rbrace") this.consume();
    return group(children);
  }
  parseOptionalGroup() {
    const t = this.peek();
    if (t.type === "char" && t.value === "[") {
      const start = this.pos;
      this.consume();
      const children = [];
      while (true) {
        const p = this.peek();
        if (p.type === "eof") {
          this.pos = start;
          this.consume();
          return void 0;
        }
        if (p.type === "char" && p.value === "]") {
          this.consume();
          return group(children);
        }
        const atom = this.parseAtomNoScripts();
        if (!atom) break;
        const withScripts = this.parseScripts(atom);
        children.push(withScripts);
      }
      return group(children);
    }
    return void 0;
  }
  parseCommand() {
    const tok = this.consume();
    if (tok.type !== "command") {
      throw this.error("expected command", tok.pos);
    }
    const name = tok.name;
    switch (name) {
      case "\\frac":
      case "\\dfrac":
      case "\\tfrac": {
        const num = this.parseRequiredGroup();
        const den = this.parseRequiredGroup();
        const variant = name === "\\dfrac" ? "display" : name === "\\tfrac" ? "text" : "normal";
        return { type: "frac", numerator: num, denominator: den, variant };
      }
      case "\\sqrt": {
        const degree = this.parseOptionalGroup();
        const body = this.parseRequiredGroup();
        if (degree !== void 0) return { type: "sqrt", body, degree };
        return { type: "sqrt", body };
      }
      case "\\mathbf":
      case "\\bm":
      case "\\boldsymbol":
        return { type: "font", font: "bf", body: this.parseRequiredGroup() };
      case "\\mathrm":
        return { type: "font", font: "rm", body: this.parseRequiredGroup() };
      case "\\mathit":
        return { type: "font", font: "it", body: this.parseRequiredGroup() };
      case "\\mathbb":
        return { type: "font", font: "bb", body: this.parseRequiredGroup() };
      case "\\mathcal":
        return { type: "font", font: "cal", body: this.parseRequiredGroup() };
      case "\\mathfrak":
        return { type: "font", font: "frak", body: this.parseRequiredGroup() };
      case "\\mathsf":
        return { type: "font", font: "sf", body: this.parseRequiredGroup() };
      case "\\mathtt":
        return { type: "font", font: "tt", body: this.parseRequiredGroup() };
      case "\\text":
      case "\\textrm":
      case "\\textbf":
      case "\\textit":
      case "\\mbox": {
        const body = this.parseTextGroup();
        return body;
      }
      case "\\operatorname":
      case "\\operatorname*": {
        const body = this.parseRequiredGroup();
        const s = renderNodeToFlatText(body);
        return { type: "opname", name: s };
      }
      case "\\boxed":
        return { type: "boxed", body: this.parseRequiredGroup() };
      case "\\tag": {
        const body = this.parseTextGroup();
        return { type: "tag", body };
      }
      case "\\left": {
        const open = this.readDelimiterToken();
        const body = group(this.parseExpression({ rightCmd: true }));
        const next = this.peek();
        let close = ".";
        if (next.type === "command" && next.name === "\\right") {
          this.consume();
          close = this.readDelimiterToken();
        }
        return { type: "paren", left: open, body, right: close, scalable: true };
      }
      case "\\right": {
        this.readDelimiterToken();
        return group([]);
      }
      case "\\begin": {
        return this.parseEnvironment();
      }
      case "\\end": {
        this.consumeEnvName();
        return group([]);
      }
      // Explicit horizontal spaces
      case "\\,":
        return { type: "space", width: 1 };
      case "\\:":
      case "\\;":
        return { type: "space", width: 1 };
      case "\\!":
        return { type: "space", width: 0 };
      case "\\ ":
        return { type: "space", width: 1 };
      case "\\quad":
        return { type: "space", width: 4 };
      case "\\qquad":
        return { type: "space", width: 6 };
      case "\\over": {
        return { type: "symbol", value: "/" };
      }
      default:
        break;
    }
    if (BIG_OPS[name]) {
      const g = BIG_OPS[name];
      return { type: "symbol", value: g.unicode };
    }
    if (name === "\\hat" || name === "\\bar" || name === "\\vec" || name === "\\tilde" || name === "\\dot" || name === "\\ddot" || name === "\\widehat" || name === "\\widetilde" || name === "\\overline") {
      const body = this.parseRequiredGroup();
      return { type: "accent", kind: name.replace(/^\\/, ""), body };
    }
    return { type: "symbol", value: name };
  }
  /**
   * Text-group parser used by \text{...}. Tokenizing inside preserves the
   * literal characters (including spaces), skipping over \ escapes.
   */
  parseTextGroup() {
    const t = this.peek();
    if (t.type !== "lbrace") {
      const a = this.parseAtomNoScripts();
      if (!a) return group([]);
      if (a.type === "symbol") return { type: "text", value: a.value };
      return a;
    }
    const open = this.consume();
    const start = open.pos + 1;
    let depth = 1;
    let i = start;
    while (i < this.input.length && depth > 0) {
      const ch = this.input[i];
      if (ch === "\\" && i + 1 < this.input.length) {
        i += 2;
        continue;
      }
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) break;
      }
      i++;
    }
    const raw = this.input.slice(start, i);
    while (this.pos < this.tokens.length) {
      const tk = this.tokens[this.pos];
      if (tk.pos > i) break;
      this.pos++;
    }
    const cleaned = raw.replace(/\\([%$&#_{}])/g, "$1");
    return { type: "text", value: cleaned };
  }
  readDelimiterToken() {
    const t = this.peek();
    if (t.type === "char") {
      this.consume();
      return t.value;
    }
    if (t.type === "command") {
      this.consume();
      switch (t.name) {
        case "\\{":
          return "{";
        case "\\}":
          return "}";
        case "\\lbrace":
          return "{";
        case "\\rbrace":
          return "}";
        case "\\langle":
          return "\u27E8";
        case "\\rangle":
          return "\u27E9";
        case "\\lceil":
          return "\u2308";
        case "\\rceil":
          return "\u2309";
        case "\\lfloor":
          return "\u230A";
        case "\\rfloor":
          return "\u230B";
        case "\\vert":
          return "|";
        case "\\|":
        case "\\Vert":
          return "\u2016";
        case "\\backslash":
          return "\\";
        default:
          return ".";
      }
    }
    if (t.type === "lbrace") {
      this.consume();
      return "{";
    }
    if (t.type === "rbrace") {
      this.consume();
      return "}";
    }
    return ".";
  }
  consumeEnvName() {
    const t = this.peek();
    if (t.type !== "lbrace") return "";
    this.consume();
    let name = "";
    while (true) {
      const p = this.peek();
      if (p.type === "rbrace") {
        this.consume();
        break;
      }
      if (p.type === "eof") break;
      if (p.type === "char") {
        name += p.value;
        this.consume();
        continue;
      }
      if (p.type === "command") {
        name += p.name.replace(/^\\/, "");
        this.consume();
        continue;
      }
      this.consume();
    }
    return name.trim();
  }
  parseEnvironment() {
    const envName = this.consumeEnvName();
    const isMatrixLike = envName === "matrix" || envName === "pmatrix" || envName === "bmatrix" || envName === "Bmatrix" || envName === "vmatrix" || envName === "Vmatrix" || envName === "smallmatrix";
    const rows = [];
    let currentRow = [];
    let currentCell = [];
    const finishCell = () => {
      currentRow.push(currentCell);
      currentCell = [];
    };
    const finishRow = () => {
      finishCell();
      if (currentRow.length > 0 && !(currentRow.length === 1 && currentRow[0].length === 0)) {
        rows.push(currentRow);
      }
      currentRow = [];
    };
    while (true) {
      const t = this.peek();
      if (t.type === "eof") break;
      if (t.type === "char" && (t.value === " " || t.value === "	" || t.value === "\n")) {
        this.consume();
        continue;
      }
      if (t.type === "command" && t.name === "\\end") {
        this.consume();
        this.consumeEnvName();
        break;
      }
      if (t.type === "amp") {
        this.consume();
        finishCell();
        continue;
      }
      if (t.type === "dblbackslash") {
        this.consume();
        finishRow();
        continue;
      }
      const atom = this.parseAtomNoScripts();
      if (!atom) {
        if (this.peek().type !== "eof") this.consume();
        continue;
      }
      const node = this.parseScripts(atom);
      currentCell.push(node);
    }
    if (currentCell.length > 0 || currentRow.length > 0) finishRow();
    if (isMatrixLike) {
      return {
        type: "matrix",
        kind: envName,
        rows: rows.map((r) => r.map((cell) => group(cell)))
      };
    }
    if (envName === "cases") {
      const caseRows = rows.map((r) => {
        const expr = group(r[0] ?? []);
        if (r[1]) return { expr, condition: group(r[1]) };
        return { expr };
      });
      return { type: "cases", rows: caseRows };
    }
    if (envName === "aligned" || envName === "align" || envName === "align*" || envName === "equation" || envName === "equation*" || envName === "gather" || envName === "gather*") {
      return {
        type: "aligned",
        rows: rows.map((r) => ({ columns: r.map((c) => group(c)) }))
      };
    }
    const flat = [];
    for (const r of rows) {
      for (const cell of r) flat.push(...cell);
    }
    return group(flat);
  }
};
function renderNodeToFlatText(node) {
  switch (node.type) {
    case "group":
      return node.children.map(renderNodeToFlatText).join("");
    case "symbol":
      return node.value.startsWith("\\") ? node.value.slice(1) : node.value;
    case "text":
      return node.value;
    case "space":
      return " ";
    default:
      return "";
  }
}
function parseMath(input) {
  const p = new Parser(input);
  return p.parse();
}

// ../../../../private/tmp/seudaily-math-trial.KxkOln/src/core/cell.ts
function cloneCell(cell) {
  if (cell.style === void 0) return { ch: cell.ch };
  return { ch: cell.ch, style: { ...cell.style } };
}
function styleEquals(a, b) {
  if (a === b) return true;
  if (!a || !b) return !a && !b;
  return !!a.bold === !!b.bold && !!a.italic === !!b.italic && !!a.dim === !!b.dim && a.fg === b.fg && a.bg === b.bg;
}
function mergeStyle(base, over) {
  if (!base) return over ? { ...over } : void 0;
  if (!over) return { ...base };
  const merged = { ...base };
  if (over.bold !== void 0) merged.bold = over.bold || !!base.bold;
  if (over.italic !== void 0) merged.italic = over.italic || !!base.italic;
  if (over.dim !== void 0) merged.dim = over.dim || !!base.dim;
  if (over.fg !== void 0) merged.fg = over.fg;
  if (over.bg !== void 0) merged.bg = over.bg;
  return merged;
}

// ../../../../private/tmp/seudaily-math-trial.KxkOln/src/core/box.ts
function blankBox(width, height, baseline = 0) {
  const cells = [];
  for (let y = 0; y < height; y++) {
    const row = [];
    for (let x = 0; x < width; x++) row.push({ ch: " " });
    cells.push(row);
  }
  return { width, height, baseline, cells };
}
function textBox(text, style) {
  if (text === "") return blankBox(0, 1, 0);
  const lines = text.split("\n");
  const rows = lines.map((line) => Array.from(line));
  const width = rows.reduce((m, r) => r.length > m ? r.length : m, 0);
  const height = rows.length;
  const box = blankBox(width, height, 0);
  for (let y = 0; y < height; y++) {
    const row = rows[y];
    if (!row) continue;
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      if (ch === void 0) continue;
      box.cells[y][x] = style ? { ch, style: { ...style } } : { ch };
    }
  }
  return box;
}
function spaceBox(width) {
  return blankBox(width, 1, 0);
}
function cloneBox(box) {
  const cells = [];
  for (let y = 0; y < box.height; y++) {
    const row = box.cells[y];
    const newRow = [];
    for (let x = 0; x < box.width; x++) {
      const c = row[x];
      newRow.push(c ? cloneCell(c) : { ch: " " });
    }
    cells.push(newRow);
  }
  const out = {
    width: box.width,
    height: box.height,
    baseline: box.baseline,
    cells
  };
  if (box.tagWidth !== void 0) out.tagWidth = box.tagWidth;
  if (box.subShift !== void 0) out.subShift = box.subShift;
  if (box.supShift !== void 0) out.supShift = box.supShift;
  return out;
}
function blit(target, source, x, y) {
  for (let sy = 0; sy < source.height; sy++) {
    const dy = y + sy;
    if (dy < 0 || dy >= target.height) continue;
    const srcRow = source.cells[sy];
    const dstRow = target.cells[dy];
    if (!srcRow || !dstRow) continue;
    for (let sx = 0; sx < source.width; sx++) {
      const dx = x + sx;
      if (dx < 0 || dx >= target.width) continue;
      const s = srcRow[sx];
      if (!s) continue;
      const d = dstRow[dx];
      if (s.ch === " " && d && d.ch !== " ") continue;
      dstRow[dx] = cloneCell(s);
    }
  }
}
function pad(box, padding) {
  const left = padding.left ?? 0;
  const right = padding.right ?? 0;
  const top = padding.top ?? 0;
  const bottom = padding.bottom ?? 0;
  const width = box.width + left + right;
  const height = box.height + top + bottom;
  const baseline = box.baseline + top;
  const out = blankBox(width, height, baseline);
  blit(out, box, left, top);
  if (box.tagWidth !== void 0) out.tagWidth = box.tagWidth;
  if (box.subShift !== void 0) out.subShift = box.subShift;
  if (box.supShift !== void 0) out.supShift = box.supShift;
  return out;
}
function center(box, width) {
  if (width <= box.width) return box;
  const leftPad = Math.floor((width - box.width) / 2);
  const rightPad = width - box.width - leftPad;
  return pad(box, { left: leftPad, right: rightPad });
}
function hcat(boxes, gap = 0) {
  const nonEmpty = boxes.filter((b) => b.width > 0 || b.height > 0);
  if (nonEmpty.length === 0) return blankBox(0, 1, 0);
  let above = 0;
  let below = 0;
  for (const b of nonEmpty) {
    if (b.baseline > above) above = b.baseline;
    const bel = b.height - b.baseline - 1;
    if (bel > below) below = bel;
  }
  const outHeight = above + 1 + below;
  const outBaseline = above;
  let totalW = 0;
  for (let i = 0; i < nonEmpty.length; i++) {
    totalW += nonEmpty[i].width;
    if (i > 0) totalW += gap;
  }
  const out = blankBox(totalW, outHeight, outBaseline);
  let x = 0;
  for (let i = 0; i < nonEmpty.length; i++) {
    const b = nonEmpty[i];
    const y = outBaseline - b.baseline;
    blit(out, b, x, y);
    x += b.width;
    if (i < nonEmpty.length - 1) x += gap;
  }
  return out;
}
function vstackCentered(boxes) {
  if (boxes.length === 0) return blankBox(0, 1, 0);
  const width = boxes.reduce((m, b) => b.width > m ? b.width : m, 0);
  const height = boxes.reduce((s, b) => s + b.height, 0);
  const out = blankBox(width, height, Math.floor(height / 2));
  let y = 0;
  for (const b of boxes) {
    const x = Math.floor((width - b.width) / 2);
    blit(out, b, x, y);
    y += b.height;
  }
  return out;
}
function frameBox(content, asciiOnly = false) {
  const innerPadded = pad(content, { left: 1, right: 1 });
  const width = innerPadded.width + 2;
  const height = innerPadded.height + 2;
  const out = blankBox(width, height, innerPadded.baseline + 1);
  const h = asciiOnly ? "-" : "\u2500";
  const v = asciiOnly ? "|" : "\u2502";
  const tl = asciiOnly ? "+" : "\u250C";
  const tr = asciiOnly ? "+" : "\u2510";
  const bl = asciiOnly ? "+" : "\u2514";
  const br = asciiOnly ? "+" : "\u2518";
  for (let x = 1; x < width - 1; x++) {
    out.cells[0][x] = { ch: h };
    out.cells[height - 1][x] = { ch: h };
  }
  for (let y = 1; y < height - 1; y++) {
    out.cells[y][0] = { ch: v };
    out.cells[y][width - 1] = { ch: v };
  }
  out.cells[0][0] = { ch: tl };
  out.cells[0][width - 1] = { ch: tr };
  out.cells[height - 1][0] = { ch: bl };
  out.cells[height - 1][width - 1] = { ch: br };
  blit(out, innerPadded, 1, 1);
  return out;
}
function applyStyle(box, style) {
  const out = cloneBox(box);
  for (let y = 0; y < out.height; y++) {
    const row = out.cells[y];
    for (let x = 0; x < out.width; x++) {
      const c = row[x];
      if (c.ch === " ") continue;
      const merged = mergeStyle(c.style, style);
      out.cells[y][x] = merged ? { ch: c.ch, style: merged } : { ch: c.ch };
    }
  }
  return out;
}

// ../../../../private/tmp/seudaily-math-trial.KxkOln/src/math/scripts.ts
var SUP_MAP = {
  "0": "\u2070",
  "1": "\xB9",
  "2": "\xB2",
  "3": "\xB3",
  "4": "\u2074",
  "5": "\u2075",
  "6": "\u2076",
  "7": "\u2077",
  "8": "\u2078",
  "9": "\u2079",
  "+": "\u207A",
  "-": "\u207B",
  "=": "\u207C",
  "(": "\u207D",
  ")": "\u207E",
  n: "\u207F",
  i: "\u2071"
};
var SUB_MAP = {
  "0": "\u2080",
  "1": "\u2081",
  "2": "\u2082",
  "3": "\u2083",
  "4": "\u2084",
  "5": "\u2085",
  "6": "\u2086",
  "7": "\u2087",
  "8": "\u2088",
  "9": "\u2089",
  "+": "\u208A",
  "-": "\u208B",
  "=": "\u208C",
  "(": "\u208D",
  ")": "\u208E",
  a: "\u2090",
  e: "\u2091",
  h: "\u2095",
  i: "\u1D62",
  j: "\u2C7C",
  k: "\u2096",
  l: "\u2097",
  m: "\u2098",
  n: "\u2099",
  o: "\u2092",
  p: "\u209A",
  r: "\u1D63",
  s: "\u209B",
  t: "\u209C",
  u: "\u1D64",
  v: "\u1D65",
  x: "\u2093"
};
function toUnicodeSup(s, max = 8) {
  if (s.length === 0 || s.length > max) return void 0;
  let out = "";
  for (const ch of s) {
    const m = SUP_MAP[ch];
    if (!m) return void 0;
    out += m;
  }
  return out;
}
function toUnicodeSub(s, max = 8) {
  if (s.length === 0 || s.length > max) return void 0;
  let out = "";
  for (const ch of s) {
    const m = SUB_MAP[ch];
    if (!m) return void 0;
    out += m;
  }
  return out;
}

// ../../../../private/tmp/seudaily-math-trial.KxkOln/src/math/fonts.ts
var BB = {
  A: "\u{1D538}",
  B: "\u{1D539}",
  C: "\u2102",
  D: "\u{1D53B}",
  E: "\u{1D53C}",
  F: "\u{1D53D}",
  G: "\u{1D53E}",
  H: "\u210D",
  I: "\u{1D540}",
  J: "\u{1D541}",
  K: "\u{1D542}",
  L: "\u{1D543}",
  M: "\u{1D544}",
  N: "\u2115",
  O: "\u{1D546}",
  P: "\u2119",
  Q: "\u211A",
  R: "\u211D",
  S: "\u{1D54A}",
  T: "\u{1D54B}",
  U: "\u{1D54C}",
  V: "\u{1D54D}",
  W: "\u{1D54E}",
  X: "\u{1D54F}",
  Y: "\u{1D550}",
  Z: "\u2124",
  a: "\u{1D552}",
  b: "\u{1D553}",
  c: "\u{1D554}",
  d: "\u{1D555}",
  e: "\u{1D556}",
  f: "\u{1D557}",
  g: "\u{1D558}",
  h: "\u{1D559}",
  i: "\u{1D55A}",
  j: "\u{1D55B}",
  k: "\u{1D55C}",
  l: "\u{1D55D}",
  m: "\u{1D55E}",
  n: "\u{1D55F}",
  o: "\u{1D560}",
  p: "\u{1D561}",
  q: "\u{1D562}",
  r: "\u{1D563}",
  s: "\u{1D564}",
  t: "\u{1D565}",
  u: "\u{1D566}",
  v: "\u{1D567}",
  w: "\u{1D568}",
  x: "\u{1D569}",
  y: "\u{1D56A}",
  z: "\u{1D56B}",
  "0": "\u{1D7D8}",
  "1": "\u{1D7D9}",
  "2": "\u{1D7DA}",
  "3": "\u{1D7DB}",
  "4": "\u{1D7DC}",
  "5": "\u{1D7DD}",
  "6": "\u{1D7DE}",
  "7": "\u{1D7DF}",
  "8": "\u{1D7E0}",
  "9": "\u{1D7E1}"
};
var CAL = {
  A: "\u{1D49C}",
  B: "\u212C",
  C: "\u{1D49E}",
  D: "\u{1D49F}",
  E: "\u2130",
  F: "\u2131",
  G: "\u{1D4A2}",
  H: "\u210B",
  I: "\u2110",
  J: "\u{1D4A5}",
  K: "\u{1D4A6}",
  L: "\u2112",
  M: "\u2133",
  N: "\u{1D4A9}",
  O: "\u{1D4AA}",
  P: "\u{1D4AB}",
  Q: "\u{1D4AC}",
  R: "\u211B",
  S: "\u{1D4AE}",
  T: "\u{1D4AF}",
  U: "\u{1D4B0}",
  V: "\u{1D4B1}",
  W: "\u{1D4B2}",
  X: "\u{1D4B3}",
  Y: "\u{1D4B4}",
  Z: "\u{1D4B5}"
};
var FRAK = {
  A: "\u{1D504}",
  B: "\u{1D505}",
  C: "\u212D",
  D: "\u{1D507}",
  E: "\u{1D508}",
  F: "\u{1D509}",
  G: "\u{1D50A}",
  H: "\u210C",
  I: "\u2111",
  J: "\u{1D50D}",
  K: "\u{1D50E}",
  L: "\u{1D50F}",
  M: "\u{1D510}",
  N: "\u{1D511}",
  O: "\u{1D512}",
  P: "\u{1D513}",
  Q: "\u{1D514}",
  R: "\u211C",
  S: "\u{1D516}",
  T: "\u{1D517}",
  U: "\u{1D518}",
  V: "\u{1D519}",
  W: "\u{1D51A}",
  X: "\u{1D51B}",
  Y: "\u{1D51C}",
  Z: "\u2128",
  a: "\u{1D51E}",
  b: "\u{1D51F}",
  c: "\u{1D520}",
  d: "\u{1D521}",
  e: "\u{1D522}",
  f: "\u{1D523}",
  g: "\u{1D524}",
  h: "\u{1D525}",
  i: "\u{1D526}",
  j: "\u{1D527}",
  k: "\u{1D528}",
  l: "\u{1D529}",
  m: "\u{1D52A}",
  n: "\u{1D52B}",
  o: "\u{1D52C}",
  p: "\u{1D52D}",
  q: "\u{1D52E}",
  r: "\u{1D52F}",
  s: "\u{1D530}",
  t: "\u{1D531}",
  u: "\u{1D532}",
  v: "\u{1D533}",
  w: "\u{1D534}",
  x: "\u{1D535}",
  y: "\u{1D536}",
  z: "\u{1D537}"
};
function remapLetter(ch, font, unicode) {
  if (!unicode) return ch;
  switch (font) {
    case "bb":
      return BB[ch] ?? ch;
    case "cal":
      return CAL[ch] ?? ch;
    case "frak":
      return FRAK[ch] ?? ch;
    default:
      return ch;
  }
}

// ../../../../private/tmp/seudaily-math-trial.KxkOln/src/math/spacing.ts
function classifySymbol(value) {
  const g = glyphFor(value);
  if (g?.kind) {
    if (g.kind === "op" || g.kind === "inner") return "ord";
    return g.kind;
  }
  if (value.length === 1) {
    if (value === "+" || value === "-" || value === "*" || value === "/") return "bin";
    if (value === "=" || value === "<" || value === ">") return "rel";
    if (value === "(" || value === "[" || value === "{") return "open";
    if (value === ")" || value === "]" || value === "}") return "close";
    if (value === "," || value === ";" || value === ":") return "punct";
  }
  if (value === "\u2264" || value === "\u2265" || value === "\u2260" || value === "\u2248" || value === "\u2261" || value === "\u2192" || value === "\u2190" || value === "\u2194" || value === "\u21D2" || value === "\u21D0" || value === "\u21D4" || value === "\u21A6" || value === "\u2208" || value === "\u2209" || value === "\u2282" || value === "\u2283" || value === "\u2286" || value === "\u2287") {
    return "rel";
  }
  if (value === "\xB1" || value === "\u2213" || value === "\xD7" || value === "\xF7" || value === "\xB7" || value === "\u222A" || value === "\u2229" || value === "\u2227" || value === "\u2228" || value === "\u2295" || value === "\u2297") {
    return "bin";
  }
  return "ord";
}

// ../../../../private/tmp/seudaily-math-trial.KxkOln/src/core/ansi.ts
function openCodes(style) {
  const codes = [];
  if (style.bold) codes.push(1);
  if (style.dim) codes.push(2);
  if (style.italic) codes.push(3);
  if (style.fg !== void 0) {
    if (style.fg < 16) {
      codes.push(style.fg < 8 ? 30 + style.fg : 90 + (style.fg - 8));
    } else {
      codes.push(38, 5, style.fg);
    }
  }
  if (style.bg !== void 0) {
    if (style.bg < 16) {
      codes.push(style.bg < 8 ? 40 + style.bg : 100 + (style.bg - 8));
    } else {
      codes.push(48, 5, style.bg);
    }
  }
  if (codes.length === 0) return "";
  return `\x1B[${codes.join(";")}m`;
}
var RESET = "\x1B[0m";
function hasAnyStyle(s) {
  if (!s) return false;
  return !!(s.bold || s.italic || s.dim || s.fg !== void 0 || s.bg !== void 0);
}

// ../../../../private/tmp/seudaily-math-trial.KxkOln/src/core/stringify.ts
function boxToString(box, options = {}) {
  const ansi = options.ansi ?? false;
  const trim = options.trim ?? true;
  const lines = [];
  for (let y = 0; y < box.height; y++) {
    const row = box.cells[y];
    let line = "";
    if (ansi) {
      let curStyle = void 0;
      for (let x = 0; x < box.width; x++) {
        const c = row[x];
        const styleOn = hasAnyStyle(c.style) ? c.style : void 0;
        if (!styleEquals(curStyle, styleOn)) {
          if (hasAnyStyle(curStyle)) line += RESET;
          if (styleOn) line += openCodes(styleOn);
          curStyle = styleOn;
        }
        line += c.ch;
      }
      if (hasAnyStyle(curStyle)) line += RESET;
    } else {
      for (let x = 0; x < box.width; x++) {
        line += row[x].ch;
      }
    }
    if (trim) line = line.replace(/[ \t]+$/, "");
    lines.push(line);
  }
  return lines.join("\n");
}

// ../../../../private/tmp/seudaily-math-trial.KxkOln/src/math/render.ts
function defaultCtx(opts) {
  const unicode = opts.ascii ? false : opts.unicode !== false;
  return {
    unicode,
    compactScripts: opts.compactScripts !== false,
    ansi: !!opts.ansi,
    display: !!opts.display,
    fontStack: [],
    upright: false,
    compactTrivialFracInDisplay: false
  };
}
function currentFont(ctx) {
  return ctx.fontStack.length > 0 ? ctx.fontStack[ctx.fontStack.length - 1] : void 0;
}
function currentStyle(ctx) {
  const f = currentFont(ctx);
  if (!f || !ctx.ansi) return void 0;
  if (f === "bf") return { bold: true };
  if (f === "it") return { italic: true };
  return void 0;
}
function renderLetter(ch, ctx) {
  const font = currentFont(ctx);
  let rendered = ch;
  if (font && (font === "bb" || font === "cal" || font === "frak")) {
    rendered = remapLetter(ch, font, ctx.unicode);
  }
  const style = currentStyle(ctx);
  return textBox(rendered, style);
}
function renderNode(node, options = {}) {
  const ctx = defaultCtx(options);
  const box = renderIn(node, ctx);
  return box;
}
function renderIn(node, ctx) {
  switch (node.type) {
    case "group":
      return renderGroup(node.children, ctx);
    case "symbol":
      return renderSymbolNode(node.value, ctx);
    case "text":
      return textBox(node.value);
    case "space":
      return spaceBox(Math.max(0, node.width));
    case "frac":
      return renderFrac(node.numerator, node.denominator, node.variant, ctx);
    case "sqrt":
      return renderSqrt(node.body, node.degree, ctx);
    case "supsub":
      return renderSupsub(node.base, node.sup, node.sub, ctx);
    case "style":
      return applyStyle(renderIn(node.body, ctx), node.style);
    case "font": {
      ctx.fontStack.push(node.font);
      try {
        return renderIn(node.body, ctx);
      } finally {
        ctx.fontStack.pop();
      }
    }
    case "bigop":
      return renderBigOp(node, ctx);
    case "paren":
      return renderParen(node, ctx);
    case "boxed":
      return frameBox(renderIn(node.body, ctx), !ctx.unicode);
    case "tag":
      return hcat([textBox("("), renderIn(node.body, ctx), textBox(")")], 0);
    case "matrix":
      return renderMatrix(node, ctx);
    case "cases":
      return renderCases(node, ctx);
    case "aligned":
      return renderAligned(node, ctx);
    case "accent":
      return renderAccent(node, ctx);
    case "opname":
      return textBox(node.name);
    case "raw":
      return textBox(node.value);
  }
}
function renderGroup(children, ctx) {
  if (children.length === 0) return blankBox(0, 1, 0);
  const savedCompact = ctx.compactTrivialFracInDisplay;
  if (ctx.display && !savedCompact && hasBigOp(children)) {
    ctx.compactTrivialFracInDisplay = true;
  }
  const items = [];
  for (const child of children) {
    const kind = classifyChild(child);
    const isSpace = child.type === "space";
    const box = renderIn(child, ctx);
    items.push({ box, kind, isSpace, node: child });
  }
  ctx.compactTrivialFracInDisplay = savedCompact;
  const seq = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (i > 0) {
      const prev = items[i - 1];
      const gap = gapBetween(prev, it);
      if (gap > 0) seq.push(spaceBox(gap));
    }
    seq.push(it.box);
  }
  return hcat(seq, 0);
}
function hasBigOp(children) {
  for (const c of children) {
    if (c.type === "bigop") return true;
    if (c.type === "group" && hasBigOp(c.children)) return true;
    if (c.type === "font" && hasBigOp([c.body])) return true;
  }
  return false;
}
function classifyChild(node) {
  switch (node.type) {
    case "symbol":
      return classifySymbol(node.value);
    case "space":
      return "space";
    case "frac":
    case "sqrt":
    case "supsub":
    case "group":
    case "font":
    case "boxed":
    case "paren":
    case "matrix":
    case "cases":
    case "aligned":
    case "accent":
    case "opname":
    case "text":
    case "raw":
      return "ord";
    case "bigop":
      return "op";
    default:
      return "ord";
  }
}
function gapBetween(prev, cur) {
  if (prev.isSpace || cur.isSpace) return 0;
  const a = prev.kind;
  const b = cur.kind;
  if (a === "rel" || b === "rel") return 1;
  if (a === "bin" || b === "bin") return 1;
  if (a === "punct") return 1;
  if (prev.node.type === "bigop" && (prev.node.upper || prev.node.lower)) return 1;
  if (prev.node.type === "supsub" && cur.kind !== "close" && cur.kind !== "punct") return 1;
  if (cur.node.type === "bigop" && a === "ord") return 1;
  if (a === "op" || b === "op") return 0;
  return 0;
}
function renderSymbolNode(value, ctx) {
  if (value.startsWith("\\")) {
    const g = glyphFor(value);
    if (g) {
      const ch = ctx.unicode ? g.unicode : g.ascii;
      return textBox(ch);
    }
    return textBox(value.slice(1));
  }
  if (value.length > 1) {
    return textBox(value);
  }
  if (/[A-Za-z]/.test(value)) {
    return renderLetter(value, ctx);
  }
  return textBox(value);
}
function isTrivialTextNode(n) {
  if (n.type === "symbol") return n.value;
  if (n.type === "text") return n.value;
  if (n.type === "group" && n.children.length === 0) return "";
  if (n.type === "group") {
    let s = "";
    for (const c of n.children) {
      const v = isTrivialTextNode(c);
      if (v === void 0) return void 0;
      s += v;
    }
    return s;
  }
  return void 0;
}
function flatScriptText(n) {
  const raw = isTrivialTextNode(n);
  if (raw === void 0) return void 0;
  if (raw.includes("\\")) return void 0;
  return raw;
}
function renderSupsub(base, sup, sub, ctx) {
  const baseBox = renderIn(base, ctx);
  let compactSup;
  let compactSub;
  if ((ctx.unicode && ctx.compactScripts) && sup !== void 0) {
    const flat = flatScriptText(sup);
    if (flat !== void 0) compactSup = toUnicodeSup(flat);
  }
  if ((ctx.unicode && ctx.compactScripts) && sub !== void 0) {
    const flat = flatScriptText(sub);
    if (flat !== void 0) compactSub = toUnicodeSub(flat);
  }
  if ((ctx.unicode && ctx.compactScripts)) {
    if (sub !== void 0 && compactSub === void 0) {
      const raw = flatScriptText(sub);
      if (raw !== void 0 && isShortLabel(raw)) compactSub = `\u208D${raw}\u208E`;
    }
    if (sup !== void 0 && compactSup === void 0) {
      const raw = flatScriptText(sup);
      if (raw !== void 0 && isShortLabel(raw)) compactSup = `\u207D${raw}\u207E`;
    }
  }
  if ((sup === void 0 || compactSup !== void 0) && (sub === void 0 || compactSub !== void 0)) {
    const str = (compactSub ?? "") + (compactSup ?? "");
    if (str.length === 0) return baseBox;
    return hcat([baseBox, textBox(str)], 0);
  }
  const subBoxRaw = sub !== void 0 ? renderIn(sub, ctx) : void 0;
  const supBoxRaw = sup !== void 0 ? renderIn(sup, ctx) : void 0;
  const subBox = subBoxRaw;
  const supBox = supBoxRaw;
  const width = Math.max(subBox?.width ?? 0, supBox?.width ?? 0);
  if (width === 0) return baseBox;
  const filler = spaceBox(width);
  const stack = [];
  if (supBox) stack.push(padToWidth(supBox, width));
  stack.push(filler);
  if (subBox) stack.push(padToWidth(subBox, width));
  const scriptCol = vstackCentered(stack);
  const scriptBaseline = supBox ? supBox.height : 0;
  scriptCol.baseline = scriptBaseline;
  return hcat([baseBox, scriptCol], 0);
}
function bothLimitsAreShortLabels(upper, lower) {
  const check = (n) => {
    if (n === void 0) return true;
    const flat = flatScriptText(n);
    if (flat === void 0) return false;
    return isShortLabel(flat);
  };
  if (upper === void 0 && lower === void 0) return false;
  return check(upper) && check(lower);
}
function isShortLabel(s) {
  if (s.length === 0 || s.length > 4) return false;
  return /^[A-Za-z0-9+\-=,]+$/.test(s);
}
function padToWidth(box, w) {
  if (box.width >= w) return box;
  return center(box, w);
}
function isSimpleFragment(n) {
  if (n.type === "symbol") return true;
  if (n.type === "text") return n.value.length <= 4;
  if (n.type === "font") return isSimpleFragment(n.body);
  if (n.type === "opname") return true;
  if (n.type === "group") {
    let total = 0;
    for (const c of n.children) {
      if (!isSimpleFragment(c)) return false;
      total++;
      if (total > 3) return false;
    }
    return true;
  }
  return false;
}
function renderFrac(num, den, variant, ctx) {
  const forceText = variant === "text";
  const forceDisplay = variant === "display";
  if (!forceDisplay) {
    const inline = forceText || !ctx.display;
    if (inline && isSimpleFragment(num) && isSimpleFragment(den)) {
      return hcat([renderIn(num, ctx), textBox("/"), renderIn(den, ctx)], 0);
    }
    if (ctx.display && ctx.compactTrivialFracInDisplay && isObviouslyTrivial(num, den)) {
      return hcat([renderIn(num, ctx), textBox("/"), renderIn(den, ctx)], 0);
    }
  }
  const nBox = pad(renderIn(num, ctx), { left: 1, right: 1 });
  const dBox = pad(renderIn(den, ctx), { left: 1, right: 1 });
  const width = Math.max(nBox.width, dBox.width);
  const ruleCh = ctx.unicode ? "\u2500" : "-";
  const ruleStr = ruleCh.repeat(width);
  const ruleBox = textBox(ruleStr);
  const nCentered = center(nBox, width);
  const dCentered = center(dBox, width);
  const stacked = vstackCentered([nCentered, ruleBox, dCentered]);
  stacked.baseline = nCentered.height;
  return stacked;
}
function isObviouslyTrivial(num, den) {
  const a = flatScriptText(num);
  const b = flatScriptText(den);
  if (a === void 0 || b === void 0) return false;
  if (a.length <= 2 && b.length <= 2) return true;
  return false;
}
function renderSqrt(body, degree, ctx) {
  const inner = renderIn(body, ctx);
  if (inner.height === 1) {
    const hook = ctx.unicode ? "\u221A" : "sqrt(";
    const tail = ctx.unicode ? "" : ")";
    const pieces = [];
    if (degree !== void 0) {
      const degBox = renderIn(degree, ctx);
      pieces.push(renderSupsub({ type: "symbol", value: hook }, degree, void 0, ctx));
    } else {
      pieces.push(textBox(hook));
    }
    pieces.push(inner);
    if (tail) pieces.push(textBox(tail));
    return hcat(pieces, 0);
  }
  const vinculum = ctx.unicode ? "\u2500" : "_";
  const bar = textBox(vinculum.repeat(inner.width + 2));
  const padded = pad(inner, { left: 2, right: 1 });
  const combined = vstackCentered([bar, padded]);
  combined.baseline = padded.baseline + 1;
  const radHook = ctx.unicode ? "\u2571" : "/";
  const radVert = ctx.unicode ? "\u2502" : "|";
  const radRows = combined.height;
  const radBox = blankBox(1, radRows, combined.baseline);
  for (let y = 0; y < radRows; y++) {
    radBox.cells[y][0] = { ch: y === radRows - 1 ? "\u221A" : radVert };
  }
  if (!ctx.unicode) {
    for (let y = 0; y < radRows - 1; y++) radBox.cells[y][0] = { ch: "|" };
    radBox.cells[radRows - 1][0] = { ch: "V" };
  } else {
    if (radRows >= 2) {
      radBox.cells[radRows - 2][0] = { ch: radHook };
    }
  }
  if (degree !== void 0) {
    const degBox = renderIn(degree, ctx);
    return hcat([degBox, radBox, combined], 0);
  }
  return hcat([radBox, combined], 0);
}
function renderBigOp(node, ctx) {
  const opBox = textBox(node.op);
  const base = { type: "symbol", value: node.op };
  const opSymbol = node.op;
  const isIntegral = opSymbol === "\u222B" || opSymbol === "\u222C" || opSymbol === "\u222D" || opSymbol === "\u222E";
  const limitsAreTrivial = bothLimitsAreShortLabels(node.upper, node.lower) && ctx.unicode;
  if (!ctx.display || isIntegral || limitsAreTrivial) {
    const main = renderSupsub(base, node.upper, node.lower, ctx);
    if (node.body !== void 0) return hcat([main, renderIn(node.body, ctx)], 1);
    return main;
  }
  const pieces = [];
  const hasUpper = node.upper !== void 0;
  const hasLower = node.lower !== void 0;
  const upperBox = hasUpper ? renderIn(node.upper, ctx) : void 0;
  const lowerBox = hasLower ? renderIn(node.lower, ctx) : void 0;
  const width = Math.max(opBox.width, upperBox?.width ?? 0, lowerBox?.width ?? 0);
  const centeredOp = center(opBox, width);
  const centeredUpper = upperBox ? center(upperBox, width) : void 0;
  const centeredLower = lowerBox ? center(lowerBox, width) : void 0;
  const stack = [];
  if (centeredUpper) stack.push(centeredUpper);
  stack.push(centeredOp);
  if (centeredLower) stack.push(centeredLower);
  const stacked = vstackCentered(stack);
  stacked.baseline = centeredUpper ? centeredUpper.height : 0;
  pieces.push(stacked);
  if (node.body !== void 0) pieces.push(renderIn(node.body, ctx));
  return hcat(pieces, 1);
}
var TALL_PIECES_UNICODE = {
  "(": { top: "\u239B", ext: "\u239C", bot: "\u239D" },
  ")": { top: "\u239E", ext: "\u239F", bot: "\u23A0" },
  "[": { top: "\u23A1", ext: "\u23A2", bot: "\u23A3" },
  "]": { top: "\u23A4", ext: "\u23A5", bot: "\u23A6" },
  "{": { top: "\u23A7", ext: "\u23AA", bot: "\u23A9" },
  "}": { top: "\u23AB", ext: "\u23AA", bot: "\u23AD" },
  "|": { top: "\u2502", ext: "\u2502", bot: "\u2502" },
  "\u2016": { top: "\u2016", ext: "\u2016", bot: "\u2016" }
};
var TALL_PIECES_ASCII = {
  "(": { top: "/", ext: "|", bot: "\\" },
  ")": { top: "\\", ext: "|", bot: "/" },
  "[": { top: "|", ext: "|", bot: "|" },
  "]": { top: "|", ext: "|", bot: "|" },
  "{": { top: "/", ext: "|", bot: "\\" },
  "}": { top: "\\", ext: "|", bot: "/" },
  "|": { top: "|", ext: "|", bot: "|" },
  "\u2016": { top: "|", ext: "|", bot: "|" }
};
function buildTallDelim(ch, height, unicode) {
  if (ch === "." || ch === "") return blankBox(0, height, Math.floor(height / 2));
  if (height <= 1) {
    const display = ch;
    return textBox(display);
  }
  const set = unicode ? TALL_PIECES_UNICODE : TALL_PIECES_ASCII;
  const pieces = set[ch];
  if (!pieces) {
    const box2 = blankBox(1, height, Math.floor(height / 2));
    for (let y = 0; y < height; y++) box2.cells[y][0] = { ch };
    return box2;
  }
  const box = blankBox(1, height, Math.floor(height / 2));
  box.cells[0][0] = { ch: pieces.top };
  box.cells[height - 1][0] = { ch: pieces.bot };
  for (let y = 1; y < height - 1; y++) box.cells[y][0] = { ch: pieces.ext };
  return box;
}
function renderParen(node, ctx) {
  const body = renderIn(node.body, ctx);
  const height = body.height;
  const left = buildTallDelim(node.left, height, ctx.unicode);
  const right = buildTallDelim(node.right, height, ctx.unicode);
  left.baseline = body.baseline;
  right.baseline = body.baseline;
  return hcat([left, body, right], 0);
}
function renderMatrix(node, ctx) {
  const rowBoxes = node.rows.map((row) => row.map((cell) => renderIn(cell, ctx)));
  if (rowBoxes.length === 0) return blankBox(0, 1, 0);
  const numCols = rowBoxes.reduce((m, r) => Math.max(m, r.length), 0);
  const colWidths = new Array(numCols).fill(0);
  const rowHeights = new Array(rowBoxes.length).fill(0);
  const rowBaselines = new Array(rowBoxes.length).fill(0);
  for (let r = 0; r < rowBoxes.length; r++) {
    const row = rowBoxes[r];
    let above = 0;
    let below = 0;
    for (let c = 0; c < row.length; c++) {
      const b = row[c];
      if (b.width > colWidths[c]) colWidths[c] = b.width;
      if (b.baseline > above) above = b.baseline;
      const bel = b.height - b.baseline - 1;
      if (bel > below) below = bel;
    }
    rowHeights[r] = above + 1 + below;
    rowBaselines[r] = above;
  }
  const colGap = 2;
  const rowGap = 0;
  const contentWidth = colWidths.reduce((s, w) => s + w, 0) + colGap * Math.max(0, numCols - 1);
  const contentHeight = rowHeights.reduce((s, h) => s + h, 0) + rowGap * Math.max(0, rowBoxes.length - 1);
  const content = blankBox(contentWidth, contentHeight, Math.floor(contentHeight / 2));
  let y = 0;
  for (let r = 0; r < rowBoxes.length; r++) {
    let x = 0;
    const row = rowBoxes[r];
    const rowBaseline = rowBaselines[r];
    for (let c = 0; c < numCols; c++) {
      const cell = row[c];
      const colW = colWidths[c];
      if (cell) {
        const cx = x + Math.floor((colW - cell.width) / 2);
        const cy = y + (rowBaseline - cell.baseline);
        blit(content, cell, cx, cy);
      }
      x += colW + (c < numCols - 1 ? colGap : 0);
    }
    y += rowHeights[r] + rowGap;
  }
  let left = "";
  let right = "";
  switch (node.kind) {
    case "pmatrix":
      left = "(";
      right = ")";
      break;
    case "bmatrix":
      left = "[";
      right = "]";
      break;
    case "Bmatrix":
      left = "{";
      right = "}";
      break;
    case "vmatrix":
      left = "|";
      right = "|";
      break;
    case "Vmatrix":
      left = "\u2016";
      right = "\u2016";
      break;
    case "matrix":
    default:
      left = "";
      right = "";
  }
  const padded = pad(content, { left: 1, right: 1 });
  const lBox = buildTallDelim(left, padded.height, ctx.unicode);
  const rBox = buildTallDelim(right, padded.height, ctx.unicode);
  lBox.baseline = padded.baseline;
  rBox.baseline = padded.baseline;
  return hcat([lBox, padded, rBox], 0);
}
function renderCases(node, ctx) {
  const rows = node.rows.map((r) => {
    const row = [renderIn(r.expr, ctx)];
    if (r.condition) row.push(renderIn(r.condition, ctx));
    return row;
  });
  const matrix = {
    type: "matrix",
    kind: "matrix",
    rows: node.rows.map((r) => {
      const cells = [r.expr];
      if (r.condition) cells.push(r.condition);
      return cells;
    })
  };
  const body = renderMatrix(matrix, ctx);
  const brace = buildTallDelim("{", body.height, ctx.unicode);
  brace.baseline = body.baseline;
  return hcat([brace, body], 0);
  void rows;
}
function renderAligned(node, ctx) {
  if (node.rows.length === 0) return blankBox(0, 1, 0);
  const numCols = node.rows.reduce((m, r) => Math.max(m, r.columns.length), 0);
  const matrix = {
    type: "matrix",
    kind: "matrix",
    rows: node.rows.map((r) => {
      const cells = [];
      for (let i = 0; i < numCols; i++) cells.push(r.columns[i] ?? { type: "group", children: [] });
      return cells;
    })
  };
  return renderMatrix(matrix, ctx);
}
function renderAccent(node, ctx) {
  const body = renderIn(node.body, ctx);
  if (!ctx.unicode) return body;
  const accentChar = (() => {
    switch (node.kind) {
      case "hat":
      case "widehat":
        return "^";
      case "tilde":
      case "widetilde":
        return "~";
      case "bar":
      case "overline":
        return "\u2500";
      case "vec":
        return "\u2192";
      case "dot":
        return "\u02D9";
      case "ddot":
        return "\xA8";
      default:
        return "";
    }
  })();
  if (!accentChar) return body;
  const accentStr = accentChar.repeat(body.width);
  const accentBox = textBox(accentStr);
  const stacked = vstackCentered([accentBox, body]);
  stacked.baseline = body.baseline + 1;
  return stacked;
}
export {
  boxToString,
  glyphFor,
  parseMath,
  renderNode
};

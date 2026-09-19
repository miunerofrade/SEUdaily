/** Keep inline formulas compact enough to sit naturally on a text line. */
export function normalizeMathMarkdown(source: string) {
  return source.replace(/(^|[^\\$])\$([^$\n]+)\$(?!\$)/g, (_match, prefix: string, formula: string) => {
    const inlineFormula = formula
      .replace(/\\dfrac/g, "\\frac")
      .replace(/\\displaystyle\s*/g, "");
    return `${prefix}$${inlineFormula}$`;
  });
}

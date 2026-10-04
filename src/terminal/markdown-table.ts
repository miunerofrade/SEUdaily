import stringWidth from "string-width";
import type { Span } from "./markdown.js";
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export function inlineSpans(text: string, bold = false): Span[] {
  return text
    .split(/(\*\*[^*]+\*\*|`[^`]+`)/)
    .filter(Boolean)
    .map((part) =>
      part.startsWith("**") && part.endsWith("**")
        ? { text: part.slice(2, -2), bold: true }
        : part.startsWith("`") && part.endsWith("`")
          ? { text: part.slice(1, -1), code: true, bold }
          : { text: part, bold },
    );
}
/** Split actual cell separators; escaped pipes and pipes inside inline code stay in their cell. */
export function tableCells(line: string): string[] | null {
  const text = line.trim(),
    cells: string[] = [];
  let cell = "",
    fence = 0,
    separators = 0,
    endsWithSeparator = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    endsWithSeparator = false;
    if (char === "\\" && (text[i + 1] === "|" || text[i + 1] === "\\")) {
      cell += text[++i];
      continue;
    }
    if (char === "`") {
      let count = 1;
      while (text[i + count] === "`") count++;
      fence = fence === count ? 0 : fence || count;
      cell += "`".repeat(count);
      i += count - 1;
      continue;
    }
    if (char === "|" && !fence) {
      cells.push(cell.trim());
      cell = "";
      separators++;
      endsWithSeparator = true;
    } else cell += char;
  }
  cells.push(cell.trim());
  if (!separators) return null;
  if (text.startsWith("|")) cells.shift();
  if (endsWithSeparator) cells.pop();
  return cells;
}
function wrapCell(spans: Span[], width: number): Span[][] {
  const rows: Span[][] = [[]];
  let used = 0;
  for (const span of spans)
    for (const { segment } of graphemes.segment(span.text)) {
      if (segment === "\n") {
        rows.push([]);
        used = 0;
        continue;
      }
      const size = stringWidth(segment);
      if (used && used + size > width) {
        rows.push([]);
        used = 0;
      }
      const row = rows.at(-1)!,
        last = row.at(-1);
      if (last && last.bold === span.bold && last.code === span.code)
        last.text += segment;
      else row.push({ ...span, text: segment });
      used += size;
    }
  return rows;
}
export function renderTable(
  header: string[],
  separator: string[],
  body: string[][],
  width: number,
): Span[][] {
  const count = header.length,
    output: Span[][] = [];
  const values = [header, ...body].map((row) =>
    header.map((_, i) =>
      i === count - 1 ? row.slice(i).join(" | ") : (row[i] ?? ""),
    ),
  );
  const parsed = values.map((row, r) =>
    row.map((cell) =>
      inlineSpans(cell.replace(/<br\s*\/?\s*>/gi, "\n"), r === 0),
    ),
  );
  if (width < count * 5 + 1) {
    // A narrow terminal cannot fit all columns; stack cells instead of truncating their contents.
    parsed.slice(1).forEach((row, r) => {
      row.forEach((cell, i) => {
        output.push(
          ...wrapCell([...inlineSpans(header[i] + ": ", true), ...cell], width),
        );
      });
      if (r < parsed.length - 2)
        output.push([{ text: "─".repeat(width), muted: true }]);
    });
    if (parsed.length === 1)
      parsed[0].forEach((cell) => output.push(...wrapCell(cell, width)));
    return output;
  }
  const natural = header.map((_, i) =>
    Math.max(
      2,
      ...parsed.map((row) =>
        Math.max(
          ...row[i]
            .map((s) => s.text)
            .join("")
            .split("\n")
            .map((value) => stringWidth(value)),
        ),
      ),
    ),
  );
  const available = width - count * 3 - 1,
    widths = header.map(() => 2);
  let remaining = available - count * 2;
  // Give columns an equal share until their content fits. A long paragraph
  // must wrap instead of consuming the width needed by shorter labels.
  while (remaining > 0) {
    let index = -1;
    for (let i = 0; i < count; i++)
      if (
        widths[i] < natural[i] &&
        (index < 0 || widths[i] < widths[index])
      )
        index = i;
    if (index < 0) break;
    widths[index]++;
    remaining--;
  }
  const border = (left: string, joint: string, right: string) => [
    {
      text: left + widths.map((n) => "─".repeat(n + 2)).join(joint) + right,
      muted: true,
    },
  ];
  output.push(border("┌", "┬", "┐"));
  parsed.forEach((row, r) => {
    const wrapped = row.map((cell, i) => wrapCell(cell, widths[i]));
    for (
      let line = 0;
      line < Math.max(...wrapped.map((cell) => cell.length));
      line++
    ) {
      const spans: Span[] = [{ text: "│ ", muted: true }];
      wrapped.forEach((cell, i) => {
        const current = cell[line] ?? [],
          size = stringWidth(current.map((s) => s.text).join("")),
          space = Math.max(0, widths[i] - size),
          align = separator[i];
        const left =
          align.startsWith(":") && align.endsWith(":")
            ? Math.floor(space / 2)
            : align.endsWith(":")
              ? space
              : 0;
        spans.push(
          { text: " ".repeat(left) },
          ...current,
          { text: " ".repeat(space - left) },
          { text: " │ ", muted: true },
        );
      });
      spans.at(-1)!.text = " │";
      output.push(spans);
    }
    output.push(
      r === parsed.length - 1 ? border("└", "┴", "┘") : border("├", "┼", "┤"),
    );
  });
  return output;
}
export function readTable(lines: string[], start: number) {
  const header = tableCells(lines[start]),
    separator = tableCells(lines[start + 1] ?? "");
  if (
    !header?.length ||
    !separator ||
    separator.length !== header.length ||
    !separator.every((cell) => /^:?-{3,}:?$/.test(cell))
  )
    return null;
  const body: string[][] = [];
  let end = start + 2;
  while (end < lines.length && lines[end].trim()) {
    if (/^\s*(```|~~~)/.test(lines[end])) break;
    const row = tableCells(lines[end]);
    if (!row) break;
    body.push(row);
    end++;
  }
  return { header, separator, body, end };
}

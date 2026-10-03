import stringWidth from "string-width";
import { readTable, renderTable, inlineSpans } from "./markdown-table.js";
import { clean } from "./client.js";
export interface Span {
  text: string;
  bold?: boolean;
  code?: boolean;
  muted?: boolean;
  role?: string;
  user?: boolean;
  color?: string;
}
const cache = new WeakMap<
  object,
  { text: string; width: number; lines: Span[][] }
>();
/** Cache completed messages and wrap styled text in terminal cells, including CJK. */
export function messageLines(
  message: { role: string; text: string },
  width: number,
): Span[][] {
  const hit = cache.get(message);
  if (hit?.text === message.text && hit.width === width) return hit.lines;
  const lines: Span[][] = [];
  let fence = "";
  const append = (spans: Span[]) => {
    let row: Span[] = [],
      used = 0;
    for (const span of spans)
      for (const char of span.text) {
        const size = stringWidth(char);
        if (used && used + size > width) {
          lines.push(row);
          row = [];
          used = 0;
        }
        const last = row.at(-1);
        if (
          last &&
          last.bold === span.bold &&
          last.code === span.code &&
          last.muted === span.muted &&
          last.role === span.role
        )
          last.text += char;
        else row.push({ ...span, text: char });
        used += size;
      }
    lines.push(row.length ? row : [{ text: " " }]);
  };
  if (message.role !== "你" && message.role !== "SEUdaily")
    append([{ text: message.role, role: message.role, bold: true }]);
  const source = clean(message.text).split("\n");
  for (let index = 0; index < source.length; index++) {
    const original = source[index],
      marker = original.trim().match(/^(`{3,}|~{3,})/);
    if (
      marker &&
      (!fence ||
        (marker[1][0] === fence[0] && marker[1].length >= fence.length))
    ) {
      const opening = !fence;
      fence = opening ? marker[1] : "";
      append([
        {
          text: opening ? "  " + original.trim().slice(marker[1].length) : " ",
          muted: true,
        },
      ]);
      continue;
    }
    if (fence) {
      append([{ text: "  " + original, code: true }]);
      continue;
    }
    const table = readTable(source, index);
    if (table) {
      lines.push(
        ...renderTable(table.header, table.separator, table.body, width),
      );
      index = table.end - 1;
      continue;
    }
    const heading = /^#{1,6}\s/.test(original),
      line = original
        .replace(/^#{1,6}\s+/, "")
        .replace(/^(\s*)[-*] /, "$1• ")
        .replace(/^> /, "│ ");
    const spans = inlineSpans(line, heading);
    append(spans);
  }
  if (message.role === "你") {
    lines.unshift([{ text: " " }]);
    lines.push([{ text: " " }]);
    for (const row of lines) {
      for (const span of row) span.user = true;
      const size = stringWidth(row.map((span) => span.text).join(""));
      if (size < width) row.push({ text: " ".repeat(width - size), user: true });
    }
  }
  lines.push([{ text: " " }]);
  cache.set(message, { text: message.text, width, lines });
  return lines;
}

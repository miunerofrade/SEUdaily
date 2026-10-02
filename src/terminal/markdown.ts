import stringWidth from "string-width";
import { clean } from "./client.js";
export interface Span {
  text: string;
  bold?: boolean;
  code?: boolean;
  muted?: boolean;
  role?: string;
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
  let fenced = false;
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
  append([{ text: message.role, role: message.role, bold: true }]);
  for (const original of clean(message.text).split("\n")) {
    if (original.trim().startsWith("```")) {
      fenced = !fenced;
      append([
        { text: fenced ? "  " + original.trim().slice(3) : " ", muted: true },
      ]);
      continue;
    }
    if (fenced) {
      append([{ text: "  " + original, code: true }]);
      continue;
    }
    const heading = /^#{1,6}\s/.test(original),
      line = original
        .replace(/^#{1,6}\s+/, "")
        .replace(/^(\s*)[-*] /, "$1• ")
        .replace(/^> /, "│ ");
    const spans: Span[] = line
      .split(/(\*\*[^*]+\*\*|`[^`]+`)/)
      .filter(Boolean)
      .map((part) =>
        part.startsWith("**") && part.endsWith("**")
          ? { text: part.slice(2, -2), bold: true }
          : part.startsWith("`") && part.endsWith("`")
            ? { text: part.slice(1, -1), code: true }
            : { text: part, bold: heading },
      );
    append(spans);
  }
  lines.push([{ text: " " }]);
  cache.set(message, { text: message.text, width, lines });
  return lines;
}

import stringWidth from "string-width";
import type { Span } from "./markdown.js";

// Each pair of terminal cells forms a square pixel: curled tail, ears, eye,
// cream muzzle and paws holding an acorn. No timer or animation is needed.
const squirrel = [
  "      a  a  ",
  "      abba  ",
  " aaaa aabba ",
  "abbbbaaboba ",
  "ab aabbccao ",
  "ab  aaabbca ",
  "abbbbaabbca ",
  "  abbbabbba ",
  "  abbbaccaa ",
  "   abbaccda ",
  "    abbdaa  ",
  "    aaaaa   ",
];
const palette: Record<string, string> = {
  a: "#a66c42", b: "#dc9958", c: "#f4ddb3", d: "#bd7843", o: "#161c24",
};
const artWidth = 24;
const pad = (row: Span[], width: number): Span[] => [
  ...row, { text: " ".repeat(Math.max(0, width - stringWidth(row.map(s => s.text).join("")))) },
];
const wrap = (text: string, width: number): string[] => text.split("\n").flatMap(line => {
  const rows: string[] = [];let row = "";
  for (const char of line) {
    if (stringWidth(row + char) > width) { rows.push(row);row = ""; }
    row += char;
  }
  rows.push(row);return rows;
});
export function welcomeLines(prompt: string, width: number): Span[][] {
  const boxWidth = Math.min(width, 100), inner = boxWidth - 4;
  const art: Span[][] = squirrel.map(row => Array.from(row).map(pixel =>
    pixel === " " ? { text: "  " } : { text: "██", color: palette[pixel] }));
  const sideBySide = boxWidth >= 64;
  const leftWidth = Math.max(28, Math.floor(inner * 0.33));
  const rightWidth = sideBySide ? inner - leftWidth : inner;
  const text: Span[][] = [[{ text: "SEUdaily", bold: true, color: "#a8bfff" }], [],
    ...wrap(prompt, rightWidth).map(line => [{ text: line }])];
  const content: Span[][] = [];
  if (sideBySide) {
    const height = Math.max(art.length, text.length);
    const textTop = Math.floor((height - text.length) / 2);
    for (let y = 0; y < height; y++) {
      const drawing = art[y] ?? [];
      const centered = [{ text: " ".repeat(Math.floor((leftWidth - artWidth) / 2)) }, ...drawing];
      content.push([...pad(centered, leftWidth), ...pad(text[y - textTop] ?? [], rightWidth)]);
    }
  } else if (inner >= artWidth) {
    content.push(...art.map(row => [{ text: " ".repeat(Math.floor((inner - artWidth) / 2)) }, ...row]), [], ...text);
  } else {
    // Tiny terminals retain the instructions without cutting through the pixel drawing.
    content.push(...text);
  }
  const border = (left: string, right: string): Span[] => [{ text: left + "─".repeat(boxWidth - 2) + right, muted: true }];
  const line = (row: Span[]): Span[] => [{ text: "│ ", muted: true }, ...pad(row, inner), { text: " │", muted: true }];
  return [border("╭", "╮"), line([]), ...content.map(line), line([]), border("╰", "╯"), [{ text: " " }]];
}

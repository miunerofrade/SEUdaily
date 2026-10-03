import stringWidth from "string-width";
import type { Span } from "./markdown.js";

// Two vertical pixels share one terminal cell. Half blocks retain the eye
// highlights, cheek blush and curled tail without making the welcome taller.
const squirrel = [
  "               o            o   ",
  "              oobo       ooobo  ",
  "              obbboo     oobbo  ",
  "             obpppbb     obppbo ",
  "             obpppbbh    obppbo ",
  "             oobppphhoohoobppbo ",
  "              oboohhhhhbbooopoo ",
  "              ooobbbbbhbbbbooo  ",
  "       oooooo oobbbbbbbbbbbboo  ",
  "     ooaaaaaaoobbbbbbbbbbbbbboo ",
  "    oahhhhhbbobbccecbbbbbccebbo ",
  "   oahhhhhhhobbcwweecbbbcwweebbo",
  "  oahhhhaaaaobbcwweeebbbcwweeebo",
  " ooahhhaaaooobcceeewecbcceeewebo",
  " oahhhaaoo  obcceeghecbcceeghebo",
  " oahhaaao   obccceggceeecceggcbo",
  "oabhhaao     opppceccceccccecco ",
  "oabhhaao     opppcccccccccccppp ",
  "oabbhaao      occcccooooocccppp ",
  "oabbhhaao      occcccooocccco   ",
  "oabbbhhaoo    obooobbbbobooo    ",
  "oaahbbhhaaooobbbbbbboooooob     ",
  " oabhhbbbbbbbbbbocccoooooooco   ",
  " oaahhhbbbbbhbboccccctttttccco  ",
  " ooaahhhhhhhhhooocccotttttocoo  ",
  "  oaahhhhhhhhhobooootthtttnooo  ",
  "   oaaabhhhhhaobbbcnttttttnbbo  ",
  "    oaaaaahaaaaobbbcntttttbbo   ",
  "     ooaaaaaaoooooobcttttoooo   ",
  "       oooooohhhhhhhhbbthhhhhho ",
  "            ohhhhhhhhooohhhhhho ",
  "              ooooo      oooo   ",
];
const palette: Record<string, string> = {
  o: "#684539", a: "#b87749", b: "#df9c61", h: "#f5c283",
  c: "#ffe4b4", w: "#fff5df", e: "#342d39", g: "#88685d",
  p: "#edac9c", n: "#aa6d39", t: "#cf914c",
};
const artWidth = 32;
const pixelRows = (): Span[][] => {
  const rows: Span[][] = [];
  for (let y = 0; y < squirrel.length; y += 2) {
    rows.push(Array.from(squirrel[y]!).map((upper, x) => {
      const lower = squirrel[y + 1]?.[x] ?? " ";
      if (upper === " " && lower === " ") return { text: " " };
      if (upper === " ") return { text: "▄", color: palette[lower] };
      if (lower === " ") return { text: "▀", color: palette[upper] };
      if (upper === lower) return { text: "█", color: palette[upper] };
      return { text: "▀", color: palette[upper], backgroundColor: palette[lower] };
    }));
  }
  return rows;
};
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
  const art = pixelRows();
  const sideBySide = boxWidth >= 64;
  const leftWidth = Math.max(36, Math.floor(inner * 0.38));
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

import stringWidth from "string-width";
import type { Span } from "./markdown.js";

// Static campus mascot based on the supplied reference: orange round head,
// cream cheeks, large oval eyes and warm brown body fur. Two vertical pixels share a cell.
const squirrel = [
  "                oo            oo        ",
  "               oiio    r     oiio       ",
  "              ooiioo   r    ooiioo      ",
  "              oiiiio  rrr   oiiiio      ",
  "              oiiiiorrrrrrrroiiiio      ",
  "              oiiorrhhhhhhhhrroiio      ",
  "              oirhhhhhhhhhhhhhhrio      ",
  "              orhhhhhhhhhhhhhhhhro      ",
  "              rhhhtthhhhhhhhtthhhr      ",
  "        ooooorrhhhtthhhhhhhhtthhhrr     ",
  "      occcccorrrhccchhhhhhhhccchrrro    ",
  "     cccccccrrrrccccchhhhhhcccccrrrr    ",
  "    cccccccorrrccceccchhhhcccecccrrro   ",
  "   scccccccorrcccwgecccrrcccwgecccrro   ",
  "  sccccccccorrcceggeeccrrcceggeeccrro   ",
  " osccccccccorrcceeeeeccrrcceeeeeccrro   ",
  " osccccccccorrcceeeeecccccceeeeeccrro   ",
  " ossccccccccorcceeeeecccccceeeeeccro    ",
  "orhhcchcccccorccceeecccccccceeecccro    ",
  "ohhhshhcchcccccppcecccwwwwcccecppcc     ",
  "ohhhhhhhhhccocppppccceeeeeecccppppc     ",
  "orhhhhhhhhoooccppccccceoeecccccppcc     ",
  "orhhhhhhhhoooocccccccccooccccccccc      ",
  "orhhhhhhhhoooooocccccooccooccccc        ",
  "orrhhhhhhhooooommffccccccccccffmm       ",
  "orrrhhhhhhoooommffmmcccccccsmmffmm      ",
  " orrrhhhhhhhhfmmfmmsccccccccsmmfmmf     ",
  " orrrrhhhhhhhfmfmmsccccccccccsmmfmf     ",
  " oorrrrhhhhhhfffmmsccccccccccsmmfff     ",
  "  orrrrrrhhhhhufmmsccccccccccsmmfu      ",
  "   orrrrrrrrrruufmssccccccccssmfuu      ",
  "    orrrrrrrrrruffmssccccccssmffu       ",
  "     orrrrrrrrro ffmssccccssmff         ",
  "      oorrrrroo   ffffssssffff          ",
  "        ooooo    fuuuuffffuuuuf         ",
  "                  ffff    ffff          ",
];
const palette: Record<string, string> = {
  o: "#9e4939",
  r: "#d9654c",
  h: "#ee8661",
  i: "#b95140",
  c: "#f6edce",
  s: "#dfd7bb",
  e: "#162526",
  w: "#f8fbef",
  g: "#afcbd7",
  p: "#eb9697",
  f: "#94613f",
  m: "#b98156",
  u: "#d7a16e",
  t: "#d6ac68",
};
const artWidth = 40;
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
  const sideBySide = boxWidth >= 80;
  const leftWidth = Math.max(44, Math.floor(inner * 0.44));
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

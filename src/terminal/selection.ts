import { measureElement, type DOMElement } from "ink";
import stringWidth from "string-width";
import { clean } from "./client.js";

export interface Point { x: number; y: number }
export interface Selection { start: Point; end: Point; screen: string[][]; moved: boolean }
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Snapshot laid-out Ink text in terminal cells, without ANSI styles or wide-cell duplication. */
export function screenText(root: DOMElement, columns: number, rows: number): string[][] {
  const screen = Array.from({ length: rows }, () => Array<string>(columns).fill(" "));
  const content = (node: DOMElement): string => node.childNodes.map((child) =>
    child.nodeName === "#text" ? child.nodeValue : content(child),
  ).join("");
  const visit = (node: DOMElement, clip: { top: number; bottom: number; left: number; right: number }) => {
    const box = measureElement(node);
    if (node.nodeName === "ink-text") {
      let x = box.x, y = box.y;
      const width = Math.max(1, Math.floor(box.width));
      for (const { segment } of graphemes.segment(clean(content(node)))) {
        if (segment === "\n") { x = box.x; y++; continue; }
        const size = stringWidth(segment);
        if (x + size > box.x + width) {
          if (node.style.textWrap?.startsWith("truncate")) break;
          x = box.x; y++;
        }
        if (y >= box.y + box.height || y >= clip.bottom) break;
        if (y >= clip.top && x >= clip.left && x + size <= clip.right && size) {
          screen[y][x] = segment;
          for (let index = 1; index < size; index++) screen[y][x + index] = "";
        }
        x += size;
      }
      return;
    }
    const next = node.style.overflow === "hidden" ? {
      top: Math.max(clip.top, box.y), bottom: Math.min(clip.bottom, box.y + box.height),
      left: Math.max(clip.left, box.x), right: Math.min(clip.right, box.x + box.width),
    } : clip;
    for (const child of node.childNodes) if (child.nodeName !== "#text") visit(child, next);
  };
  visit(root, { top: 0, bottom: rows, left: 0, right: columns });
  return screen;
}

export function selectionRows(selection: Selection): { x: number; y: number; text: string }[] {
  let { start, end } = selection;
  if (start.y > end.y || (start.y === end.y && start.x > end.x)) [start, end] = [end, start];
  const result: { x: number; y: number; text: string }[] = [];
  for (let y = Math.max(0, start.y); y <= Math.min(end.y, selection.screen.length - 1); y++) {
    const row = selection.screen[y];
    let left = y === start.y ? Math.max(0, Math.min(start.x, row.length - 1)) : 0;
    let right = y === end.y ? Math.min(end.x + 1, row.length) : row.length;
    while (left > 0 && row[left] === "") left--;
    while (right < row.length && row[right] === "") right++;
    result.push({ x: left, y, text: row.slice(left, right).join("") });
  }
  return result;
}
export const selectedText = (selection: Selection) => selectionRows(selection)
  .map((row) => row.text.trimEnd()).join("\n");

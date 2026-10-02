import stringWidth from "string-width";
export function editorRows(text: string, cursor: number, width: number) {
  const rows: { text: string; inverse: boolean }[][] = [[]];
  let used = 0,
    index = 0,
    cursorRow = 0;
  const add = (value: string, inverse: boolean) => {
    const size = stringWidth(value);
    if (used && used + size > width) {
      rows.push([]);
      used = 0;
    }
    rows.at(-1)!.push({ text: value, inverse });
    if (inverse) cursorRow = rows.length - 1;
    used += size;
  };
  for (const char of text) {
    if (char === "\n") {
      if (index === cursor) add(" ", true);
      rows.push([]);
      used = 0;
    } else add(char, index === cursor);
    index += char.length;
  }
  if (cursor === text.length) add(" ", true);
  return { rows, cursorRow };
}

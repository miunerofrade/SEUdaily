import React, { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { Box, Text, measureElement, useCursor, useInput, usePaste, type DOMElement } from "ink";
import stringWidth from "string-width";
import { enterKey, TerminalReplyFilter } from "./keyboard.js";
import { clean } from "./client.js";
export interface SessionPickerHandle { click(x: number, y: number): void; scroll(amount: number): void }
const fit = (text: string, width: number) => {
  let result = "";
  for (const char of text) { if (stringWidth(result + char) > width) break; result += char; }
  return result + " ".repeat(Math.max(0, width - stringWidth(result)));
};
export function sessionDate(value: unknown) {
  const date = new Date(String(value ?? ""));
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(date);
}
export const SessionPicker = forwardRef<SessionPickerHandle, {
  threads: any[]; currentId: string; width: number; height: number;
  onSelect(id: string): void;
  onDelete(id: string): void;
}>(({ threads, currentId, width, height, onSelect, onDelete }, ref) => {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const elements = useRef<(DOMElement | null)[]>([]);
  const terminalReplies = useRef(new TerminalReplyFilter());
  const { setCursorPosition } = useCursor();
  const filtered = threads.filter((thread) => clean(thread.title ?? "未命名").toLowerCase().includes(query.toLowerCase()) || String(thread.id).includes(query));
  const rowHeight = height >= 10 ? 2 : 1;
  const capacity = Math.max(1, Math.floor((height - 5) / rowHeight));
  const current = Math.min(index, Math.max(0, filtered.length - 1));
  const top = Math.max(0, current - capacity + 1);
  const view = useRef({ query, filtered, current, capacity });
  view.current = { query, filtered, current, capacity };
  const change = (amount: number, wrap = false) => {
    const count = view.current.filtered.length;
    if (!count) return;
    const next = view.current.current + amount;
    setIndex(wrap ? (next + count) % count : Math.max(0, Math.min(count - 1, next)));
  };
  useImperativeHandle(ref, () => ({
    scroll: change,
    click: (x, y) => {
      for (let i = 0; i < elements.current.length; i++) {
        const element = elements.current[i];
        if (!element) continue;
        const box = measureElement(element);
        if (x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height) {
          const thread = filtered[top + i];
          if (thread) onSelect(thread.id);
          return;
        }
      }
    },
  }));
  const search = (text: string) => { setQuery(clean(text).replace(/\n/g, "")); setIndex(0); };
  usePaste((text) => search(view.current.query + text));
  useInput((value, key) => {
    key = enterKey(value, key);
    if (terminalReplies.current.consume(value)) return;
    if (key.eventType === "release" || key.ctrl || key.super || key.meta || value.includes("[<") || /^<?\d+;\d+;\d+[Mm]$/.test(value) || /^\[\?/.test(value)) return;
    if (key.upArrow) change(-1, true);
    else if (key.downArrow) change(1, true);
    else if (key.pageUp) change(-view.current.capacity);
    else if (key.pageDown) change(view.current.capacity);
    else if (key.return) { if (view.current.filtered[view.current.current]) onSelect(view.current.filtered[view.current.current].id); }
    else if (key.delete) { const thread = view.current.filtered[view.current.current]; if (thread) onDelete(thread.id); }
    else if (key.backspace) search(Array.from(view.current.query).slice(0, -1).join(""));
    else if (!key.escape && value) search(view.current.query + value);
  });
  // Search is on a known single terminal row; expose a real cursor for IME composition.
  setCursorPosition({ x: Math.min(width - 2, 7 + stringWidth(query)), y: 1 });
  const dateWidth = width >= 55 ? 14 : 0;
  const titleWidth = Math.max(4, width - 4 - dateWidth);
  return <Box flexDirection="column" height={height} overflow="hidden">
    <Text bold>会话 · ↑↓ 选择 · Enter 恢复 · Delete 删除 · Esc 返回</Text>
    <Text>搜索：{fit(query || "", Math.max(1, width - 10))}</Text>
    <Text dimColor>{fit("  会话标题", titleWidth + 2)}{dateWidth ? "更新时间" : ""}</Text>
    {!filtered.length && <Text dimColor>{threads.length ? "没有匹配的会话。" : "暂无历史会话。"}</Text>}
    {filtered.slice(top, top + capacity).map((thread, i) => <Box key={thread.id} ref={(element) => { elements.current[i] = element; }} height={1} marginBottom={rowHeight - 1}>
      <Text inverse={top + i === current}>{top + i === current ? "› " : "  "}{fit(clean(thread.title || "未命名").replace(/\n/g, " ") + (thread.id === currentId ? "（当前）" : ""), titleWidth)}{dateWidth ? "  " + sessionDate(thread.updatedAt) : ""}</Text>
    </Box>)}
    <Text dimColor>{filtered[current]?.id ?? ""}</Text>
  </Box>;
});

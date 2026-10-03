import type { TerminalMessage } from "./session.js";
import { messageLines, type Span } from "./markdown.js";

const cache = new WeakMap<TerminalMessage, { key: string; lines: Span[][] }>();

/** Keep reasoning, narration and tools in the same order as the Web transcript. */
export function processLines(message: TerminalMessage, width: number, expanded: boolean): Span[][] {
  if (!message.process?.length) return messageLines(message, width);
  const key = JSON.stringify([width, expanded, message.streaming, message.text, message.process]);
  const hit = cache.get(message);
  if (hit?.key === key) return hit.lines;
  const parts = message.process.some(part => part.type === "text") || !message.text
    ? message.process : [...message.process, { type: "text" as const, text: message.text }];
  const lines = parts.flatMap((part): Span[][] => {
    if (part.type === "text") return part.text ? messageLines({ role: "SEUdaily", text: part.text }, width) : [];
    if (part.type === "tool") return messageLines({ role: "SEUdaily", text: part.text }, width)
      .map(line => line.map(span => ({ ...span, muted: true })));
    return [[{ text: "＋ 思考 · 点击或 Ctrl+T 展开", muted: true, reasoningText: part.text }], [{ text: " " }]];
  });
  cache.set(message, { key, lines });
  return lines;
}

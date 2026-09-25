import type { AgentProcessEntry, ChatMessage } from "./types";

export function appendProcessText(
  message: ChatMessage,
  type: "reasoning" | "narration",
  text: string,
  startNew = false,
  id: string = crypto.randomUUID(),
): ChatMessage {
  const process = [...(message.process ?? [])];
  const last = process.at(-1);
  if (!startNew && last && last.type === type) {
    process[process.length - 1] = { ...last, text: last.text + text };
  } else {
    const uniqueId = process.some((entry) => entry.id === id) ? `${id}-${crypto.randomUUID()}` : id;
    process.push({ id: uniqueId, type, text });
  }
  return { ...message, process };
}

export function addProcessTool(message: ChatMessage, toolId: string): ChatMessage {
  if (message.process?.some((entry) => entry.type === "tool" && entry.toolId === toolId)) return message;
  return {
    ...message,
    process: [...(message.process ?? []), { id: `tool-${toolId}`, type: "tool", toolId }],
  };
}

export function finalizeProcessAnswer(message: ChatMessage): ChatMessage {
  const process = [...(message.process ?? [])];
  let finalIndex = -1;
  for (let index = process.length - 1; index >= 0; index -= 1) {
    const entry = process[index];
    if (entry.type === "narration" && entry.text.trim()) {
      finalIndex = index;
      break;
    }
  }
  if (finalIndex < 0) return message;
  const finalEntry = process[finalIndex];
  if (finalEntry.type !== "narration") return message;
  process.splice(finalIndex, 1);
  return { ...message, content: finalEntry.text.trim(), process };
}

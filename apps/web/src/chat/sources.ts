import type { Citation, ChatMessage } from "../types";

/** A reply lists each file once, retaining every distinct location it retrieved. */
export function messageSources(message: ChatMessage): Citation[] {
  const sources = new Map<string, { citation: Citation; locators: Set<string> }>();
  for (const tool of message.tools ?? []) {
    for (const citation of tool.result?.citations ?? []) {
      const key = citation.url ? `url:${citation.url}`
        : citation.localPath ? `file:${citation.localPath}` : `title:${citation.title}`;
      let source = sources.get(key);
      if (!source) {
        source = { citation: { ...citation }, locators: new Set() };
        sources.set(key, source);
      }
      if (citation.locator?.trim()) source.locators.add(citation.locator.trim());
    }
  }
  return [...sources.values()].map(({ citation, locators }) => ({
    ...citation,
    locator: [...locators].sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true })).join("；") || undefined,
  }));
}

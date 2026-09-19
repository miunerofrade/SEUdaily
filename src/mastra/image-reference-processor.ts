import type { MastraDBMessage } from "@mastra/core/memory";
import type { ProcessInputArgs, ProcessOutputResultArgs, Processor } from "@mastra/core/processors";
import { readFile, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";

import { projectRoot } from "./runtime-paths.js";

const referencePrefix = "cvstream-image-ref:";
const imageRoot = resolve(projectRoot, ".cvstream", "uploads", "images");

function imageMediaType(path: string) {
  const extension = extname(path).toLowerCase();
  return extension === ".jpg" || extension === ".jpeg" ? "image/jpeg" : extension === ".webp" ? "image/webp" : extension === ".gif" ? "image/gif" : "image/png";
}

async function rehydrateMessage(message: MastraDBMessage): Promise<MastraDBMessage> {
  const parts = await Promise.all(message.content.parts.map(async (part) => {
    if (part.type !== "file") return part;
    const loose = part as typeof part & { data?: unknown; filename?: unknown; mediaType?: string };
    if (typeof loose.data !== "string" || !loose.data.startsWith(referencePrefix)) return part;
    const ref = loose.data.slice(referencePrefix.length);
    if (!ref || basename(ref) !== ref) return null;
    const target = resolve(imageRoot, ref);
    const details = await stat(target).catch(() => null);
    if (!details?.isFile()) return null;
    const data = (await readFile(target)).toString("base64");
    return { ...part, data: `data:${loose.mediaType || imageMediaType(target)};base64,${data}`, filename: ref };
  }));
  return { ...message, content: { ...message.content, parts: parts.filter((part): part is NonNullable<typeof part> => part !== null) } };
}

function persistReferences(message: MastraDBMessage): MastraDBMessage {
  return {
    ...message,
    content: {
      ...message.content,
      parts: message.content.parts.map((part) => {
        if (part.type !== "file") return part;
        const loose = part as typeof part & { data?: unknown; filename?: unknown };
        if (typeof loose.data !== "string" || !loose.data.startsWith("data:image/") || typeof loose.filename !== "string") return part;
        const ref = basename(loose.filename);
        return { ...part, data: `${referencePrefix}${ref}`, filename: ref };
      }),
    },
  };
}

export const imageReferenceInputProcessor = {
  id: "cvstream-image-reference-input",
  async processInput({ messages }: ProcessInputArgs) {
    return Promise.all(messages.map(rehydrateMessage));
  },
} satisfies Processor;

export const imageReferenceOutputProcessor = {
  id: "cvstream-image-reference-output",
  async processOutputResult({ messages }: ProcessOutputResultArgs) {
    return messages.map(persistReferences);
  },
} satisfies Processor;

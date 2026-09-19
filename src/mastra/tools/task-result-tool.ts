import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, basename, relative, resolve } from "node:path";

import { createTool } from "@mastra/core/tools";
import { z } from "zod";

import { projectRoot, taskRuntimeRoot } from "../runtime-paths.js";

const inputSchema = z.object({
  resultRef: z
    .string()
    .min(1)
    .describe("The resultRef returned by a SEUdaily tool"),
  jsonPointer: z
    .string()
    .default("")
    .describe("RFC 6901 JSON Pointer. Use an empty string for the result root, for example /data/results"),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(50).default(12),
  maxChars: z.number().int().min(500).max(12_000).default(6_000),
});

const outputSchema = z.object({
  resultRef: z.string(),
  jsonPointer: z.string(),
  kind: z.enum(["array", "object", "string", "scalar"]),
  offset: z.number().int().nonnegative(),
  returned: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  nextOffset: z.number().int().nonnegative().nullable(),
  value: z.unknown(),
  hint: z.string().optional(),
});

type JsonRecord = Record<string, unknown>;

const sensitiveKey = /password|passwd|secret|api[_-]?key|cookie|authorization|token|signature|signedurl/i;

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function resolveResultPath(resultRef: string): Promise<string> {
  const candidate = resolve(projectRoot, resultRef);
  const [tasksRoot, target] = await Promise.all([
    realpath(taskRuntimeRoot),
    realpath(candidate),
  ]);
  if (!inside(tasksRoot, target) || basename(target).toLowerCase() !== "result.json") {
    throw new Error("resultRef must point to .cvstream/tasks/<taskId>/result.json");
  }
  return target;
}

function decodePointer(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) {
    throw new Error("jsonPointer must be empty or start with /");
  }
  return pointer
    .slice(1)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function selectPointer(document: unknown, pointer: string): unknown {
  let current = document;
  for (const segment of decodePointer(pointer)) {
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(segment)) throw new Error(`Invalid array index: ${segment}`);
      const index = Number(segment);
      if (index >= current.length) throw new Error(`Array index is out of range: ${segment}`);
      current = current[index];
      continue;
    }
    if (current && typeof current === "object") {
      if (["__proto__", "prototype", "constructor"].includes(segment)) {
        throw new Error("Unsafe JSON Pointer segment");
      }
      if (!Object.prototype.hasOwnProperty.call(current, segment)) {
        throw new Error(`JSON Pointer does not exist: ${pointer}`);
      }
      current = (current as JsonRecord)[segment];
      continue;
    }
    throw new Error(`JSON Pointer cannot descend through ${segment}`);
  }
  return current;
}

function cleanUrl(value: string): string {
  if (!/^https?:\/\//i.test(value)) return value;
  try {
    const url = new URL(value);
    if ([...url.searchParams.keys()].some((key) => sensitiveKey.test(key))) {
      url.search = "";
    }
    return url.toString();
  } catch {
    return value;
  }
}

function bounded(value: unknown, budget: { remaining: number }, depth = 0): unknown {
  if (budget.remaining <= 0) return "[字符预算已用尽]";
  if (depth > 8) return "[内容层级过深]";
  if (typeof value === "string") {
    const cleaned = cleanUrl(value);
    const size = Math.min(cleaned.length, budget.remaining);
    budget.remaining -= size;
    return size < cleaned.length ? `${cleaned.slice(0, size)}…[已截断]` : cleaned;
  }
  if (Array.isArray(value)) {
    return value.map((item) => bounded(item, budget, depth + 1));
  }
  if (value && typeof value === "object") {
    const result: JsonRecord = {};
    for (const [key, item] of Object.entries(value as JsonRecord)) {
      if (budget.remaining <= 0) break;
      budget.remaining -= Math.min(key.length, budget.remaining);
      result[key] = sensitiveKey.test(key) ? "[已脱敏]" : bounded(item, budget, depth + 1);
    }
    return result;
  }
  budget.remaining -= Math.min(String(value).length, budget.remaining);
  return value;
}

function pageValue(value: unknown, offset: number, limit: number, maxChars: number) {
  const budget = { remaining: maxChars };
  if (Array.isArray(value)) {
    const items = value.slice(offset, offset + limit);
    return {
      kind: "array" as const,
      value: bounded(items, budget),
      total: value.length,
      returned: items.length,
      hint: "Use offset to read the next page or jsonPointer to select one item.",
    };
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as JsonRecord).slice(offset, offset + limit);
    return {
      kind: "object" as const,
      value: bounded(Object.fromEntries(entries), budget),
      total: Object.keys(value).length,
      returned: entries.length,
      hint: "Use jsonPointer to select a nested field; object keys are paginated by offset.",
    };
  }
  if (typeof value === "string") {
    const chunk = value.slice(offset, offset + maxChars);
    return {
      kind: "string" as const,
      value: bounded(chunk, budget),
      total: value.length,
      returned: chunk.length,
      hint: "For strings, offset and nextOffset are character positions.",
    };
  }
  return {
    kind: "scalar" as const,
    value: bounded(value, budget),
    total: 1,
    returned: offset === 0 ? 1 : 0,
    hint: undefined,
  };
}

export const readTaskResultTool = createTool({
  id: "read-seudaily-task-result",
  description:
    "Read a bounded, paginated section of a full SEUdaily task result using the resultRef returned by another tool. Use only when the compact tool result omitted data needed for the user's request.",
  inputSchema,
  outputSchema,
  execute: async ({ resultRef, jsonPointer, offset, limit, maxChars }) => {
    const target = await resolveResultPath(resultRef);
    const document = JSON.parse(await readFile(target, "utf8")) as unknown;
    const selected = selectPointer(document, jsonPointer);
    const page = pageValue(selected, offset, limit, maxChars);
    const consumed = page.kind === "string" ? page.returned : page.returned;
    const nextOffset = offset + consumed;
    const hasMore = nextOffset < page.total;
    return {
      resultRef: target,
      jsonPointer,
      ...page,
      offset,
      hasMore,
      nextOffset: hasMore ? nextOffset : null,
    };
  },
  toModelOutput: (output) => {
    const text = JSON.stringify(output, null, 2);
    return {
      type: "text" as const,
      value: text.length > 6_500 ? `${text.slice(0, 6_500)}\n…[模型视图已截断]` : text,
    };
  },
});

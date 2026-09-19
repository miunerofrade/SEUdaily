import { z } from "zod";

export const artifactRefSchema = z.object({
  id: z.string(),
  type: z.enum(["subtitle", "video", "audio", "slides", "note", "snapshot"]),
  path: z.string(),
  mimeType: z.string().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
});

export const citationSchema = z.object({
  id: z.string(),
  type: z.enum(["web", "subtitle", "video", "file", "snapshot"]),
  title: z.string(),
  url: z.string().url().optional(),
  localPath: z.string().optional(),
  locator: z.string().optional(),
  publishedAt: z.string().optional(),
  contentHash: z.string().optional(),
});

export const toolResultSchema = z.object({
  status: z.enum([
    "completed",
    "partial",
    "failed",
    "cancelled",
    "auth_required",
    "waiting_for_user",
  ]),
  taskId: z.string(),
  summary: z.string(),
  data: z.unknown().optional(),
  artifacts: z.array(artifactRefSchema),
  citations: z.array(citationSchema),
  warnings: z.array(z.string()),
  metrics: z.record(z.string(), z.number()),
  diagnosticsRef: z.string().optional(),
  resultRef: z.string().optional(),
});

export type ToolResult = z.infer<typeof toolResultSchema>;

function safeCitationLocation(citation: ToolResult["citations"][number]): string {
  if (citation.url) {
    try {
      const url = new URL(citation.url);
      for (const key of [...url.searchParams.keys()]) {
        if (/token|sign|signature|key|auth|cookie/i.test(key)) {
          url.search = "";
          break;
        }
      }
      return url.toString();
    } catch {
      return "";
    }
  }
  return citation.localPath ?? "";
}

const REDACTED_KEY = /password|passwd|secret|api[_-]?key|cookie|authorization|token|signature|signedurl/i;
const OMITTED_KEY = /^(logs?|events?|html|rawHtml|diagnostics)$/i;

function compactData(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[内容层级过深，已省略]";
  if (typeof value === "string") {
    return value.length > 2_500 ? `${value.slice(0, 2_500)}…[已截断]` : value;
  }
  if (Array.isArray(value)) return value.slice(0, 12).map((item) => compactData(item, depth + 1));
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (OMITTED_KEY.test(key)) continue;
      result[key] = REDACTED_KEY.test(key) ? "[已脱敏]" : compactData(item, depth + 1);
    }
    return result;
  }
  return value;
}

function compactDataText(data: unknown): string | undefined {
  if (data === undefined) return undefined;
  const serialized = JSON.stringify(compactData(data), null, 2);
  if (!serialized || serialized === "{}") return undefined;
  return serialized.length > 6_000 ? `${serialized.slice(0, 6_000)}\n…[数据已截断]` : serialized;
}

export function compactToolResultForModel(output: ToolResult) {
  const lines = [`状态：${output.status}`, output.summary, `任务 ID：${output.taskId}`];
  const data = compactDataText(output.data);
  if (data) lines.push("关键数据：", data);
  if (output.artifacts.length) {
    lines.push("产物：");
    for (const artifact of output.artifacts.slice(0, 6)) {
      lines.push(`- ${artifact.type}: ${artifact.path}`);
    }
  }
  if (output.citations.length) {
    lines.push("可引用来源：");
    for (const citation of output.citations.slice(0, 6)) {
      const location = safeCitationLocation(citation);
      lines.push(`- [${citation.id}] ${citation.title}${location ? ` — ${location}` : ""}`);
    }
  }
  if (output.warnings.length) {
    lines.push("警告：", ...output.warnings.slice(0, 3).map((item) => `- ${item}`));
  }
  if (output.resultRef) lines.push(`完整结果：${output.resultRef}`);
  return { type: "text" as const, value: lines.join("\n") };
}

export const standardToolOutput = {
  outputSchema: toolResultSchema,
  toModelOutput: compactToolResultForModel,
};

export const pythonToolOutput = standardToolOutput;

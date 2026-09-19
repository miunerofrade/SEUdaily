import { randomUUID } from "node:crypto";

import { createTool } from "@mastra/core/tools";
import { z } from "zod";

import { standardToolOutput, type ToolResult } from "./tool-result.js";

const TAVILY_ENDPOINT = "https://api.tavily.com/search";

const tavilyResultSchema = z.object({
  title: z.string(),
  url: z.string().url(),
  content: z.string().optional().default(""),
  score: z.number().optional(),
  published_date: z.string().nullish(),
});

const tavilyResponseSchema = z.object({
  results: z.array(tavilyResultSchema).default([]),
  response_time: z.coerce.number().optional(),
  request_id: z.string().optional(),
});

const inputSchema = z.object({
  query: z.string().min(2).max(500).describe("The user's web information need"),
  topic: z.enum(["general", "news", "finance"]).default("general"),
  searchDepth: z.enum(["fast", "basic", "advanced"]).default("basic"),
  maxResults: z.number().int().min(1).max(10).default(5),
  freshness: z.enum(["day", "week", "month", "year"]).optional(),
  domains: z.array(z.string().min(1)).max(20).optional(),
  excludeDomains: z.array(z.string().min(1)).max(20).optional(),
});

function combinedSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function failedResult(taskId: string, summary: string, elapsedMs: number): ToolResult {
  return {
    status: "failed",
    taskId,
    summary,
    artifacts: [],
    citations: [],
    warnings: [],
    metrics: { elapsedMs },
  };
}

export const webSearchTool = createTool({
  ...standardToolOutput,
  id: "web-search",
  description:
    "Search the public web with Tavily for current general information, news, finance, technical documentation, and sources outside the dedicated SEU tools. Returns snippets and explicit W1/W2 citations, not full page content.",
  inputSchema,
  execute: async (input, options): Promise<ToolResult> => {
    const taskId = `web-${randomUUID()}`;
    const startedAt = performance.now();
    const apiKey = process.env.TAVILY_API_KEY?.trim();
    if (!apiKey) {
      return failedResult(
        taskId,
        "Web 搜索未配置：请在 .env 中设置 TAVILY_API_KEY 后重启服务。",
        Math.round(performance.now() - startedAt),
      );
    }

    try {
      const response = await fetch(TAVILY_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: input.query,
          topic: input.topic,
          search_depth: input.searchDepth,
          max_results: input.maxResults,
          time_range: input.freshness,
          include_domains: input.domains,
          exclude_domains: input.excludeDomains,
          include_answer: false,
          include_raw_content: false,
          include_images: false,
          include_published_date: true,
        }),
        signal: combinedSignal(options?.abortSignal, 30_000),
      });

      if (!response.ok) {
        const detail = (await response.text()).replaceAll(apiKey, "[REDACTED]").slice(0, 500);
        return failedResult(
          taskId,
          `Tavily 搜索失败：HTTP ${response.status}${detail ? `，${detail}` : ""}`,
          Math.round(performance.now() - startedAt),
        );
      }

      const payload = tavilyResponseSchema.parse(await response.json());
      const results = payload.results.map((item, index) => ({
        id: `W${index + 1}`,
        title: item.title,
        url: item.url,
        snippet: item.content,
        ...(item.published_date ? { publishedAt: item.published_date } : {}),
        ...(item.score !== undefined ? { score: item.score } : {}),
      }));

      return {
        status: "completed",
        taskId,
        summary: `网页搜索完成，返回 ${results.length} 条结果。`,
        data: {
          query: input.query,
          results,
          ...(payload.request_id ? { requestId: payload.request_id } : {}),
        },
        artifacts: [],
        citations: results.map((item) => ({
          id: item.id,
          type: "web" as const,
          title: item.title,
          url: item.url,
          ...(item.publishedAt ? { publishedAt: item.publishedAt } : {}),
        })),
        warnings: ["搜索结果仅包含摘要；需要核对细节时应使用浏览器打开原始网页。"],
        metrics: {
          elapsedMs: Math.round(performance.now() - startedAt),
          resultCount: results.length,
          ...(payload.response_time !== undefined
            ? { providerResponseTimeMs: Math.round(payload.response_time * 1_000) }
            : {}),
        },
      } satisfies ToolResult;
    } catch (error) {
      if (options?.abortSignal?.aborted) {
        return {
          ...failedResult(taskId, "网页搜索已取消。", Math.round(performance.now() - startedAt)),
          status: "cancelled",
        };
      }
      const message = error instanceof Error ? error.message : String(error);
      return failedResult(
        taskId,
        `Tavily 搜索失败：${message.slice(0, 500)}`,
        Math.round(performance.now() - startedAt),
      );
    }
  },
});

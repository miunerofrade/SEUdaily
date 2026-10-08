import { defineTool as createTool } from "../../agent/tool.js";
import { z } from "zod";
import {
  noticeSources,
  requireNoticeSource,
  type NoticeSource,
} from "../../shared/notice-sources.js";
import { runPythonTool } from "./python-bridge.js";
import { pythonToolOutput } from "./tool-result.js";

/** One pair of tools for all registered sources; no per-site tool definitions. */
export function createNoticeTools(
  sources: Record<string, NoticeSource> = noticeSources,
  run: typeof runPythonTool = runPythonTool,
) {
  const ids = Object.keys(sources).filter((id) => sources[id].adapter);
  if (!ids.length) throw new Error("没有可抓取的通知来源");
  const noticeSourceEnum = ids as [string, ...string[]];
  const getSource = (id: string) => requireNoticeSource(id, sources);
  const noticeCategorySchema = z.enum([
    ...new Set(
      noticeSourceEnum.flatMap((id) => Object.keys(getSource(id).categories)),
    ),
  ] as [string, ...string[]]);
  const noticePathSchema = z.enum([
    ...new Set(
      noticeSourceEnum.flatMap((id) =>
        Object.values(getSource(id).categories).map((entry) => entry[1]),
      ),
    ),
  ] as [string, ...string[]]);
  const noticeSourceDescription = noticeSourceEnum
    .map((id) => `${sources[id].name}（${id}）`)
    .join("、");

  const queryCampusNoticesTool = createTool({
    ...pythonToolOutput,
    id: "query-campus-notices",
    description: `统一查询东南大学通知来源：${noticeSourceDescription}。mode=latest 读取最新栏目列表，mode=search 使用站内 WebPlus 搜索。`,
    inputSchema: z
      .object({
        source: z.enum(noticeSourceEnum),
        mode: z.enum(["latest", "search"]),
        query: z.string().trim().min(1).optional(),
        categories: z.array(noticeCategorySchema).min(1).optional(),
        paths: z.array(noticePathSchema).min(1).optional(),
        freshness: z
          .enum(["latest", "balanced", "archive", "cache_only"])
          .default("latest"),
        timeScope: z.enum(["latest", "recent", "any"]).default("any"),
        recentDays: z.number().int().min(1).max(3650).default(7),
        limit: z.number().int().min(1).max(20).default(5),
        timeoutSeconds: z.number().int().min(5).max(60).default(15),
      })
      .strict()
      .superRefine((value, context) => {
        if (value.mode === "search" && !value.query)
          context.addIssue({
            code: "custom",
            path: ["query"],
            message: "search 模式必须提供 query",
          });
        const source = getSource(value.source);
        const categories = new Set(Object.keys(source.categories));
        const paths = new Set(
          Object.values(source.categories).map((entry) => entry[1]),
        );
        value.categories?.forEach((item, index) => {
          if (!categories.has(item as never))
            context.addIssue({
              code: "custom",
              path: ["categories", index],
              message: `栏目 ${item} 不属于 ${value.source}`,
            });
        });
        value.paths?.forEach((item, index) => {
          if (!paths.has(item as never))
            context.addIssue({
              code: "custom",
              path: ["paths", index],
              message: `路径 ${item} 不属于 ${value.source}`,
            });
        });
      }),
    execute: async (input, options) => {
      const defaults = Object.keys(getSource(input.source).categories);
      const payload =
        input.mode === "latest" &&
        !input.categories?.length &&
        !input.paths?.length
          ? { ...input, categories: defaults }
          : input;
      const action =
        input.mode === "latest" ? "list-notices" : "search-notices";
      return run(action, payload, options?.abortSignal);
    },
  });

  const readCampusNoticeTool = createTool({
    ...pythonToolOutput,
    id: "read-campus-notice",
    description:
      "根据 query-campus-notices 返回的 source 和稳定 articleId 读取一条学校通知正文和附件。",
    inputSchema: z
      .object({
        source: z.enum(noticeSourceEnum),
        articleId: z.string().min(10),
        refresh: z.boolean().default(true),
        timeoutSeconds: z.number().int().min(5).max(60).default(15),
      })
      .strict()
      .superRefine((value, context) => {
        if (!value.articleId.startsWith(getSource(value.source).idPrefix + "-"))
          context.addIssue({
            code: "custom",
            path: ["articleId"],
            message: "articleId 与 source 不匹配",
          });
      }),
    execute: async (input, options) =>
      run("get-notice", input, options?.abortSignal),
  });

  return { queryCampusNoticesTool, readCampusNoticeTool };
}

const defaultTools = createNoticeTools();
export const queryCampusNoticesTool = defaultTools.queryCampusNoticesTool;
export const readCampusNoticeTool = defaultTools.readCampusNoticeTool;

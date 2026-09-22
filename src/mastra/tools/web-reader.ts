import { createTool } from "@mastra/core/tools";
import { z } from "zod";

import { runPythonTool } from "./python-bridge.js";
import { pythonToolOutput } from "./tool-result.js";


export const readWebPageTool = createTool({
  ...pythonToolOutput,
  id: "read-web-page",
  description:
    "在本地读取一个明确的公开 HTTP(S) 网页，返回标题、正文和页面实际发现的支持附件。可按需解析 PDF、DOCX、XLSX、PPTX；适用于用户直接提供 URL 的场景，包括教务处和计软智 WebPlus 页面。includeAttachments=auto 会在用户询问附件、正文为空/过短或提示详见附件时解析附件。优先于 fetch-web-pages 和 Playwright；只有本工具失败且仍需正文时才考虑远程抓取或浏览器。",
  inputSchema: z.object({
    url: z.string().url().describe("用户明确提供或搜索结果中已经确认的公开网页 URL"),
    query: z.string().max(500).default("")
      .describe("用户的信息需求，用于判断 auto 模式是否需要读取附件"),
    includeAttachments: z.enum(["none", "auto", "all"]).default("auto"),
    maxAttachments: z.number().int().min(1).max(5).default(3),
    timeoutSeconds: z.number().int().min(5).max(60).default(20),
  }),
  execute: async (context, options) => runPythonTool("read-web-page", context, options?.abortSignal),
});

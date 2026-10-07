import { defineTool as createTool } from "../../agent/tool.js";
import { z } from "zod";

import { runPythonTool } from "./python-bridge.js";
import { pythonToolOutput, compactToolResultForModel, type ToolResult } from "./tool-result.js";
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { runtimeRoot } from "../runtime-paths.js";
import { persistImage } from "../images.js";
import { fetchPublicWebPages, normalizePublicUrl } from "./web-fetch.js";


async function withCalendarImages(result: ToolResult): Promise<ToolResult> {
  const data = result.data as any;
  if (data?.sourceUrl !== "https://jwc.seu.edu.cn/xl/list.htm") return result;
  const directory = resolve(runtimeRoot, "calendar");
  const images = [];
  const warnings = [...result.warnings];
  for (const attachment of (data.attachments ?? []).slice(0, 5)) {
    const name = String(attachment.file ?? "");
    const extension = extname(name).toLowerCase();
    if (![".png", ".jpg", ".jpeg"].includes(extension)) continue;
    try {
      if (basename(name) !== name) throw new Error("无效附件路径");
      const target = resolve(directory, name);
      const [actual, canonical, info] = await Promise.all([realpath(target), realpath(directory), stat(target)]);
      if (actual !== resolve(canonical, name) || !info.isFile() || info.size <= 0 || info.size > 8 * 1024 * 1024) throw new Error("附件文件无效");
      const bytes = await readFile(target);
      if (createHash("sha256").update(bytes).digest("hex") !== attachment.sha256) throw new Error("附件校验失败");
      const png = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
      const jpeg = bytes.subarray(0, 3).equals(Buffer.from([255,216,255]));
      if (!png && !jpeg) throw new Error("附件不是支持的图片");
      const mime = png ? "image/png" : "image/jpeg";
      images.push(await persistImage({type:"image",image:`data:${mime};base64,${bytes.toString("base64")}`,filename:name,mediaType:mime}));
    } catch (error) {
      warnings.push(`校历图片无法送入模型：${error instanceof Error ? error.message : "读取失败"}`);
    }
  }
  return {...result, status: images.length && result.status === "partial" ? "completed" : result.status,
    data: {...data, modelImages: images}, warnings};
}

export const readWebPageTool = createTool({
  ...pythonToolOutput,
  toModelOutput: (output: ToolResult) => {
    const data = output.data as any;
    const {modelImages = [], ...textData} = data ?? {};
    if (textData.sourceUrl === "https://jwc.seu.edu.cn/xl/list.htm" && Array.isArray(textData.attachments)) {
      // PDF text is already in content; keep attachment metadata without repeating it.
      textData.attachments = textData.attachments.map(({text: _text, ...attachment}: any) => attachment);
    }
    const text = compactToolResultForModel({...output, data: textData});
    return modelImages.length ? {type: "content", value: [{type:"text",text:text.value}, ...modelImages]} : text;
  },
  id: "read-web-page",
  description:
    "读取一个明确的 HTTP(S) 网页，返回标题、正文和页面实际发现的支持附件。可按需解析 PDF、DOCX、XLSX、PPTX；适用于用户直接提供 URL 的场景，包括教务处和计软智 WebPlus 页面。includeAttachments=auto 会在用户询问附件、正文为空/过短或提示详见附件时解析附件。固定校历入口同时返回缓存图片供模型视觉阅读。优先使用本地读取；公开网页本地失败时由工具内部安全回退。",
  inputSchema: z.object({
    url: z.string().url().describe("用户明确提供、系统提示词指定或搜索结果确认的公开网页 URL"),
    query: z.string().max(500).default("")
      .describe("用户的信息需求，用于判断 auto 模式是否需要读取附件"),
    includeAttachments: z.enum(["none", "auto", "all"]).default("auto"),
    maxAttachments: z.number().int().min(1).max(5).default(3),
    timeoutSeconds: z.number().int().min(5).max(60).default(20),
  }),
  execute: async (context, options) => {
    const local = await runPythonTool("read-web-page", context, options?.abortSignal);
    if (local.status !== "failed") return withCalendarImages(local);
    try {
      const url = normalizePublicUrl(context.url);
      const remote = await fetchPublicWebPages({ urls: [url], query: context.query || "读取网页正文", chunksPerSource: 3, extractDepth: "basic", format: "markdown", timeoutSeconds: context.timeoutSeconds }, options?.abortSignal);
      if (remote.status !== "failed") return remote;
      return { ...local, summary: `${local.summary}；远程回退也失败：${remote.summary}`, warnings: [...local.warnings, ...remote.warnings] };
    } catch (error) {
      return { ...local, summary: `${local.summary}；未执行远程回退：${error instanceof Error ? error.message : String(error)}` };
    }
  },
});

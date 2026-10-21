import { noticeSources, noticeSourceIds } from "../../shared/notice-sources.js";
import { defineTool as createTool } from "../../agent/tool.js";
import { z } from "zod";

import { isFullAccessExtraEnabled, isUnapprovedAccessEnabled } from "../permission-state.js";
import { getPlaywrightBrowserTools, isBrowserApprovalRequired } from "./browser-tools.js";
import {
  auditTrainingPlanTool,
  captureCourseMaterialsTool,
  getScheduleTool,
  proposeLocalActionTool,
  queryCampusNoticesTool,
  readCampusNoticeTool,
  resolveCourseTool,
} from "./course-tools.js";
import { readWebPageTool } from "./web-reader.js";
import { searchKnowledgeTool } from "./knowledge-tools.js";
import { webSearchTool } from "./web-search.js";

export const toolNamespaceSchema = z.enum(["schedule", "course-materials", "notices", "training-plan", "web", "browser", "local-actions", "workspace", "knowledge"]);
export type ToolNamespace = z.infer<typeof toolNamespaceSchema>;

type AnyTool = any;
type Capability = { namespace: ToolNamespace; tool: AnyTool; aliases: string[]; approvalRequired?: boolean };
const staticCapabilities: Capability[] = [
  { namespace: "knowledge", tool: searchKnowledgeTool, aliases: ["知识库", "上传资料", "我的文件", "文档检索", "knowledge", "rag"] },
  { namespace: "schedule", tool: getScheduleTool, aliases: ["课表", "schedule", "timetable", "上课"] },
  { namespace: "local-actions", tool: proposeLocalActionTool, aliases: ["修改课表", "移动课程", "创建关注", "focus", "edit schedule"] },
  { namespace: "course-materials", tool: resolveCourseTool, aliases: ["课程", "课次", "回放", "course", "session"] },
  { namespace: "course-materials", tool: captureCourseMaterialsTool, aliases: ["字幕", "视频", "幻灯片", "ppt", "subtitle", "capture"] },
  { namespace: "notices", tool: queryCampusNoticesTool, aliases: ["通知", "计软智", "notice", ...noticeSourceIds.flatMap(id => [id, noticeSources[id].name])] },
  { namespace: "notices", tool: readCampusNoticeTool, aliases: ["通知正文", "通知附件", "article", "notice detail"] },
  { namespace: "training-plan", tool: auditTrainingPlanTool, aliases: ["培养方案", "学分", "毕业", "training plan", "credits"] },
  { namespace: "web", tool: webSearchTool as AnyTool, aliases: ["互联网", "网页搜索", "最新", "web", "search"] },
  { namespace: "web", tool: readWebPageTool as AnyTool, aliases: ["网页正文", "url", "附件", "read page"] },
];

function requestValue(options: any, key: string) {
  const legacyKey = key.startsWith("seudaily") ? `cvstream${key.slice("seudaily".length)}` : key;
  const value = options?.requestContext?.get?.(key) ?? options?.requestContext?.get?.(legacyKey);
  return typeof value === "string" ? value : "";
}

async function browserCapabilities(scope?: string): Promise<Capability[]> {
  const tools = await getPlaywrightBrowserTools(scope);
  return Object.entries(tools).map(([name, tool]) => ({
    namespace: "browser" as const,
    tool: tool as AnyTool,
    aliases: ["browser", "playwright", "浏览器", "点击", "输入", "页面交互", name],
    approvalRequired: isBrowserApprovalRequired(name),
  }));
}

let closeWorkspace: (()=>void) | undefined;
export function closeBrokerWorkspace() { closeWorkspace?.(); }

async function workspaceCapabilities(options: any): Promise<Capability[]> {
  if (!isFullAccessExtraEnabled(options)) return [];
  const module = await import('../workspace.js');
  closeWorkspace = module.closeWorkspace;
  return Object.values(await module.getWorkspaceTools()).map(tool => ({namespace:'workspace' as const,tool,aliases:['工作区','文件','终端','workspace','terminal',tool.id]}));
}

async function allCapabilities(includeBrowser: boolean, scope?: string, options?: any, includeWorkspace=false) {
  return [...staticCapabilities,
    ...includeBrowser ? await browserCapabilities(scope) : [],
    ...includeWorkspace ? await workspaceCapabilities(options) : [],
  ];
}

function normalizedWords(value: string) {
  return value.toLowerCase().split(/[\s,.;:!?()[\]{}\-_/\\|]+/).map((word) => word.trim()).filter(Boolean);
}

function capabilityScore(capability: Capability, query: string) {
  const haystack = [capability.tool.id, capability.tool.description, capability.namespace, ...capability.aliases].join(" ").toLowerCase();
  const normalized = query.toLowerCase().trim();
  let score = normalized && haystack.includes(normalized) ? 20 : 0;
  for (const word of normalizedWords(query)) if (haystack.includes(word)) score += Math.max(1, Math.min(word.length, 8));
  return score;
}

function jsonSchema(tool: AnyTool) {
  const schema = tool.inputSchema as any;
  try {
    if (schema instanceof z.ZodType) return z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });
    if (schema?.toJSONSchema) return schema.toJSONSchema();
    return z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });
  } catch {
    return { type: "object", additionalProperties: true };
  }
}

async function validateInput(tool: AnyTool, value: unknown) {
  const schema = tool.inputSchema as any;
  if (schema?.safeParseAsync) {
    const result = await schema.safeParseAsync(value);
    if (!result.success) throw new Error(result.error.issues.map((issue: any) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; "));
    return result.data;
  }
  const result = await schema?.["~standard"]?.validate?.(value);
  if (result?.issues?.length) throw new Error(result.issues.map((issue: any) => issue.message).join("; "));
  return result?.value ?? value;
}

async function capabilityFor(name: string, namespace: ToolNamespace | undefined, options: any) {
  const includeBrowser = namespace === 'browser' || name.startsWith('playwright_browser_');
  const includeWorkspace = namespace === 'workspace' || name.startsWith('mastra_workspace_');
  if (includeWorkspace && !isFullAccessExtraEnabled(options)) throw new Error('当前未开启工作区权限');
  const matches = (await allCapabilities(includeBrowser, requestValue(options, 'seudailyThreadId'), options, includeWorkspace))
    .filter(item => item.tool.id === name && (!namespace || item.namespace === namespace));
  if (matches.length !== 1) throw new Error(`未找到可调用的能力：${name}。请使用 search-capabilities 查询正确的名称和参数。`);
  const capability = matches[0];
  return capability;
}

export const searchCapabilitiesTool = createTool({
  id: "search-capabilities",
  description: "当当前工具不足以完成任务时，在 SEUdaily 的可信能力目录中查找最相关的工具。最多返回五个能力的稳定名称、说明和参数 Schema，可用 invoke-capability 按名称调用。",
  inputSchema: z.object({ query: z.string().trim().min(1).max(500), namespace: toolNamespaceSchema.optional() }).strict(),
  execute: async ({ query, namespace }, options) => {
    const includeBrowser = namespace === "browser" || /browser|playwright|浏览器|点击|输入|页面交互/i.test(query);
    const includeWorkspace = namespace === "workspace" || /工作区|文件|终端|workspace|terminal/i.test(query);
    const capabilities = (await allCapabilities(includeBrowser, requestValue(options, "seudailyThreadId"), options, includeWorkspace))
      .filter((item) => !namespace || item.namespace === namespace)
      .map((item) => ({ item, score: capabilityScore(item, query) }))
      .filter((item) => item.score > 0 || Boolean(namespace))
      .sort((a, b) => b.score - a.score || a.item.tool.id.localeCompare(b.item.tool.id))
      .slice(0, 5);
    const results = capabilities.map(({ item }) => {
      return { namespace: item.namespace, name: item.tool.id, description: item.tool.description, inputSchema: jsonSchema(item.tool) };
    });
    return { results, count: results.length };
  },
});

export const invokeCapabilityTool = createTool({
  id: "invoke-capability",
  toModelOutput: async (output: any) => {
    const name = output?.data?.brokerCapability?.name;
    const tool = staticCapabilities.find(item => item.tool.id === name)?.tool;
    if (tool?.toModelOutput) return tool.toModelOutput(output);
    return {type: "text", value: JSON.stringify(output)};
  },
  description: "按稳定的能力名称调用工具，名称可跨轮复用；未知名称或参数时先用 search-capabilities 查询。仍遵守该能力的参数校验和审批规则。历史记录中的 ticket 已停用，不要再传递。",
  inputSchema: z.object({ name: z.string().trim().min(1), namespace: toolNamespaceSchema.optional(), arguments: z.record(z.string(), z.unknown()).default({}) }).strict(),
  requireApproval: async ({ name, namespace, arguments: input }: { name: string; namespace?: ToolNamespace; arguments: Record<string, unknown> }, options) => {
    const entry = await capabilityFor(name, namespace, options);
    const tool = entry.tool;
    const parsed = await validateInput(tool, input);
    const required = typeof tool.requireApproval === "function" ? await tool.requireApproval(parsed, options) : tool.requireApproval;
    return Boolean(required || (entry.approvalRequired && !isUnapprovedAccessEnabled(options)));
  },
  execute: async ({ name, namespace, arguments: input }, options) => {
    const entry = await capabilityFor(name, namespace, options);
    const parsed = await validateInput(entry.tool, input);
    if (!entry.tool.execute) throw new Error(`能力 ${entry.tool.id} 不可执行`);
    const output = await entry.tool.execute(parsed, options as any);
    const brokerCapability = { name: entry.tool.id, namespace: entry.namespace };
    if (output && typeof output === "object" && !Array.isArray(output)) {
      const record = output as Record<string, unknown>;
      const data = record.data && typeof record.data === "object" && !Array.isArray(record.data) ? record.data as Record<string, unknown> : {};
      return { ...record, data: { ...data, brokerCapability } };
    }
    return { output, brokerCapability };
  },
});

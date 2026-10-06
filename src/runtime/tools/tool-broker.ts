import { randomUUID } from "node:crypto";
import { defineTool as createTool } from "../../agent/tool.js";
import { z } from "zod";

import { isUnapprovedAccessEnabled } from "../permission-state.js";
import { getPlaywrightBrowserTools, isBrowserApprovalRequired } from "./browser-tools.js";
import {
  auditTrainingPlanTool,
  captureCourseMaterialsTool,
  getScheduleTool,
  getAcademicCalendarTool,
  proposeLocalActionTool,
  queryCampusNoticesTool,
  readCampusNoticeTool,
  resolveCourseTool,
} from "./course-tools.js";
import { readWebPageTool } from "./web-reader.js";
import { webSearchTool } from "./web-search.js";

export const toolNamespaceSchema = z.enum(["schedule", "course-materials", "notices", "training-plan", "web", "browser", "local-actions", "workspace"]);
export type ToolNamespace = z.infer<typeof toolNamespaceSchema>;

type AnyTool = any;
type Capability = { namespace: ToolNamespace; tool: AnyTool; aliases: string[]; approvalRequired?: boolean };
type Ticket = { id: string; runToken: string; capability: Capability; expiresAt: number };

const tickets = new Map<string, Ticket>();
const ticketLifetimeMs = 10 * 60 * 1000;

const staticCapabilities: Capability[] = [
  { namespace: "schedule", tool: getAcademicCalendarTool, aliases: ["校历", "节假日", "国庆", "调休", "调课", "calendar", "holiday"] },
  { namespace: "schedule", tool: getScheduleTool, aliases: ["课表", "schedule", "timetable", "上课"] },
  { namespace: "local-actions", tool: proposeLocalActionTool, aliases: ["修改课表", "移动课程", "创建关注", "focus", "edit schedule"] },
  { namespace: "course-materials", tool: resolveCourseTool, aliases: ["课程", "课次", "回放", "course", "session"] },
  { namespace: "course-materials", tool: captureCourseMaterialsTool, aliases: ["字幕", "视频", "幻灯片", "ppt", "subtitle", "capture"] },
  { namespace: "notices", tool: queryCampusNoticesTool, aliases: ["通知", "教务处", "计软智", "jwc", "cse", "notice"] },
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

function pruneTickets() {
  const now = Date.now();
  for (const [id, ticket] of tickets) if (ticket.expiresAt <= now) tickets.delete(id);
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

async function allCapabilities(includeBrowser: boolean, scope?: string) {
  return includeBrowser ? [...staticCapabilities, ...await browserCapabilities(scope)] : staticCapabilities;
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

async function ticketFor(id: string, runToken: string, options: any) {
  pruneTickets();
  let ticket = tickets.get(id);
  if (!ticket) {
    const saved = options?.requestContext?.get?.("seudailyCapabilityTickets")?.find((entry: any) => entry.id === id);
    if (saved && saved.expiresAt > Date.now()) {
      const capability = (await allCapabilities(saved.namespace === "browser", requestValue(options, "seudailyThreadId"))).find(item => item.tool.id === saved.name && item.namespace === saved.namespace);
      if (capability) ticket = { id, runToken, capability, expiresAt: saved.expiresAt };
    }
  }
  if (!ticket || ticket.runToken !== runToken) throw new Error("能力票据不存在、已过期或不属于当前运行");
  return ticket;
}

export const searchCapabilitiesTool = createTool({
  id: "search-capabilities",
  description: "当当前工具不足以完成任务时，在 SEUdaily 的可信能力目录中查找最相关的工具。最多返回五个可在当前运行中调用的能力票据。",
  inputSchema: z.object({ query: z.string().trim().min(1).max(500), namespace: toolNamespaceSchema.optional() }).strict(),
  execute: async ({ query, namespace }, options) => {
    const runToken = requestValue(options, "seudailyRunToken");
    if (!runToken) throw new Error("当前运行缺少 Broker 绑定令牌");
    const includeBrowser = namespace === "browser" || /browser|playwright|浏览器|点击|输入|页面交互/i.test(query);
    const capabilities = (await allCapabilities(includeBrowser, requestValue(options, "seudailyThreadId")))
      .filter((item) => !namespace || item.namespace === namespace)
      .map((item) => ({ item, score: capabilityScore(item, query) }))
      .filter((item) => item.score > 0 || Boolean(namespace))
      .sort((a, b) => b.score - a.score || a.item.tool.id.localeCompare(b.item.tool.id))
      .slice(0, 5);
    const results = capabilities.map(({ item }) => {
      const id = `cap-${randomUUID()}`;
      const expiresAt = Date.now() + ticketLifetimeMs;
      tickets.set(id, { id, runToken, capability: item, expiresAt });
      const saved = options?.requestContext?.get?.("seudailyCapabilityTickets");
      if (Array.isArray(saved)) { saved.splice(0, saved.length, ...saved.filter((entry: any) => entry.expiresAt > Date.now()).slice(-50)); saved.push({ id, name: item.tool.id, namespace: item.namespace, expiresAt }); }
      return { ticket: id, namespace: item.namespace, name: item.tool.id, description: item.tool.description, inputSchema: jsonSchema(item.tool) };
    });
    return { results, count: results.length, expiresInSeconds: ticketLifetimeMs / 1_000 };
  },
});

export const invokeCapabilityTool = createTool({
  id: "invoke-capability",
  description: "使用 search-capabilities 在当前运行中签发的 ticket 调用对应能力。不接受工具名，ticket 与线程、运行和具体能力绑定。",
  inputSchema: z.object({ ticket: z.string().startsWith("cap-"), arguments: z.record(z.string(), z.unknown()).default({}) }).strict(),
  requireApproval: async ({ ticket }: { ticket: string }, options) => {
    const entry = await ticketFor(ticket, requestValue(options, "seudailyRunToken"), options);
    return Boolean(entry?.capability.approvalRequired && !isUnapprovedAccessEnabled(options));
  },
  execute: async ({ ticket, arguments: input }, options) => {
    const entry = await ticketFor(ticket, requestValue(options, "seudailyRunToken"), options);
    const parsed = await validateInput(entry.capability.tool, input);
    if (!entry.capability.tool.execute) throw new Error(`能力 ${entry.capability.tool.id} 不可执行`);
    const output = await entry.capability.tool.execute(parsed, options as any);
    const brokerCapability = { name: entry.capability.tool.id, namespace: entry.capability.namespace };
    if (output && typeof output === "object" && !Array.isArray(output)) {
      const record = output as Record<string, unknown>;
      const data = record.data && typeof record.data === "object" && !Array.isArray(record.data) ? record.data as Record<string, unknown> : {};
      return { ...record, data: { ...data, brokerCapability } };
    }
    return { output, brokerCapability };
  },
});

export function namespaceTools(namespaces: Iterable<ToolNamespace>) {
  const selected = new Set(namespaces);
  return Object.fromEntries(staticCapabilities.filter((item) => selected.has(item.namespace)).map((item) => [item.tool.id, item.tool]));
}

export async function browserNamespaceTools(namespaces: Iterable<ToolNamespace>, scope?: string) {
  return new Set(namespaces).has("browser") ? getPlaywrightBrowserTools(scope) : {};
}

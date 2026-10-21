import {Pencil, SquareTerminal, Wrench} from "lucide-react";
import type {ToolRun,ToolResult} from "../types";

const toolLabels: Record<string, string> = {
  getScheduleTool: "读取课表",
  getCurrentDateTool: "获取日期",
  auditTrainingPlanTool: "检查培养方案",
  authorizeScheduleTool: "课表登录",
  authorizePortalTool: "课程平台登录",
  resolveCourseTool: "定位课程",
  captureCourseMaterialsTool: "抓取课程资料",
  searchJwcTool: "搜索教务通知",
  listJwcTool: "读取教务通知",
  getJwcArticleTool: "读取通知正文",
  searchCseNoticesTool: "搜索院系通知",
  getCseNoticeTool: "读取院系通知",
  webSearchTool: "搜索网页",
  readWebPageTool: "读取网页与附件",
  readTaskResultTool: "读取完整结果",
  proposeLocalActionTool: "提出本地操作",
  queryCampusNoticesTool: "查询校园通知",
  readCampusNoticeTool: "读取通知正文",
  searchCapabilitiesTool: "查找可用能力",
  invokeCapabilityTool: "调用扩展能力",
  "query-campus-notices": "查询校园通知",
  "read-campus-notice": "读取通知正文",
  "search-capabilities": "查找可用能力",
  "invoke-capability": "调用扩展能力",
  "get-course-schedule": "读取课表",
  "resolve-course": "定位课程",
  "capture-course-materials": "抓取课程资料",
  "propose-local-action": "提出本地操作",
  "audit-training-plan": "检查培养方案",
};

const toolNarrations: Record<string, { running: string; completed: string }> = {
  getScheduleTool: { running: "正在读取课表", completed: "已读取课表" },
  getCurrentDateTool: { running: "正在获取当前日期", completed: "当前日期已获取" },
  auditTrainingPlanTool: { running: "正在检查培养方案与历年课表", completed: "培养方案检查已完成" },
  authorizeScheduleTool: { running: "正在打开课表登录", completed: "课表登录已完成" },
  authorizePortalTool: { running: "正在打开课程平台登录", completed: "课程平台登录已完成" },
  resolveCourseTool: { running: "正在定位课程", completed: "课程定位已完成" },
  captureCourseMaterialsTool: { running: "正在获取课程资料", completed: "课程资料已获取" },
  searchJwcTool: { running: "正在搜索教务通知", completed: "已搜索教务通知" },
  listJwcTool: { running: "正在读取教务通知", completed: "已读取教务通知" },
  getJwcArticleTool: { running: "正在阅读通知正文", completed: "已阅读通知正文" },
  searchCseNoticesTool: { running: "正在搜索院系通知", completed: "已搜索院系通知" },
  getCseNoticeTool: { running: "正在阅读院系通知", completed: "已阅读院系通知" },
  webSearchTool: { running: "正在搜索网页", completed: "网页搜索已完成" },
  readWebPageTool: { running: "正在读取网页与附件", completed: "网页与附件已读取" },
  readTaskResultTool: { running: "正在读取任务结果", completed: "已读取任务结果" },
  proposeLocalActionTool: { running: "正在准备本地操作", completed: "本地操作已准备" },
  queryCampusNoticesTool: { running: "正在查询校园通知", completed: "校园通知查询完成" },
  readCampusNoticeTool: { running: "正在读取通知正文", completed: "通知正文已读取" },
  searchCapabilitiesTool: { running: "正在查找可用能力", completed: "已找到可用能力" },
  invokeCapabilityTool: { running: "正在调用扩展能力", completed: "扩展能力已完成" },
  "query-campus-notices": { running: "正在查询校园通知", completed: "校园通知查询完成" },
  "read-campus-notice": { running: "正在读取通知正文", completed: "通知正文已读取" },
  "search-capabilities": { running: "正在查找可用能力", completed: "已找到可用能力" },
  "invoke-capability": { running: "正在调用扩展能力", completed: "扩展能力已完成" },
  "get-course-schedule": { running: "正在读取课表", completed: "课表读取完成" },
  "resolve-course": { running: "正在定位课程", completed: "课程定位完成" },
  "capture-course-materials": { running: "正在获取课程资料", completed: "课程资料已获取" },
  "propose-local-action": { running: "正在准备本地操作", completed: "本地操作已准备" },
  "audit-training-plan": { running: "正在检查培养方案", completed: "培养方案检查完成" },
};

export function brokerCapabilityName(result: ToolResult | undefined) {
  const data = result?.data;
  if (!data || typeof data !== "object") return "";
  const capability = (data as { brokerCapability?: unknown }).brokerCapability;
  return capability && typeof capability === "object" && typeof (capability as { name?: unknown }).name === "string"
    ? String((capability as { name: string }).name)
    : "";
}

export function toolLabel(name: string) {
  return toolLabels[name] ?? name.replace(/Tool$/, "");
}

function toolDetail(tool: ToolRun) {
  const args = tool.args ?? {};
  const name = tool.name.toLowerCase();
  if (name === "skill_search" || name.includes("skill_search")) {
    const query = [args.query, args.search, args.keyword, args.name].find((value) => typeof value === "string" && value.trim()) as string | undefined;
    return query ? `搜索“${query}”` : "搜索技能";
  }
  if (name === "skill" || (name.includes("skill") && !name.includes("search"))) {
    const skill = [args.skill, args.skillName, args.name, args.id].find((value) => typeof value === "string" && value.trim()) as string | undefined;
    return skill ? `执行技能：${skill}` : "执行技能";
  }
  if (name.includes("readtaskresult") || name.includes("read-seudaily-task-result")) {
    const pointer = typeof args.jsonPointer === "string" && args.jsonPointer.trim() ? args.jsonPointer : undefined;
    return pointer ? `读取任务结果字段：${pointer}` : "读取任务结果详情";
  }
  const path = [args.path, args.filePath, args.file, args.filename].find((value) => typeof value === "string" && value.trim()) as string | undefined;
  if (path && (name.includes("read_file") || name.includes("readfile") || name.includes("file_stat") || name.includes("list_files"))) {
    return path;
  }
  const command = [args.command, args.cmd].find((value) => typeof value === "string" && value.trim()) as string | undefined;
  if (command && (name.includes("execute_command") || name.includes("command") || name.includes("terminal"))) {
    return command;
  }
  return undefined;
}

export function toolNarration(tool: ToolRun, mode: "running" | "completed") {
  const detail = toolDetail(tool);
  const lower = tool.name.toLowerCase();
  if (detail && (lower.includes("skill") || lower.includes("readtaskresult") || lower.includes("read-seudaily-task-result"))) return mode === "running" ? `正在${detail}` : `${detail}已完成`;
  if (detail && (lower.includes("read_file") || lower.includes("readfile"))) return mode === "running" ? `正在读取文件：${detail}` : `已读取文件：${detail}`;
  if (detail && (lower.includes("execute_command") || lower.includes("command") || lower.includes("terminal"))) return mode === "running" ? `正在运行命令：${detail}` : `已运行命令：${detail}`;
  const copy = toolNarrations[tool.name];
  if (copy) return copy[mode];
  const label = toolLabel(tool.name);
  return mode === "running" ? `正在执行${label}` : `${label}已完成`;
}

export function ToolGlyph({ name, size = 16 }: { name: string; size?: number }) {
  const lower = name.toLowerCase();
  if (lower.includes("command") || lower.includes("terminal") || lower.includes("workspace") || lower.includes("browser")) return <SquareTerminal size={size} />;
  if (lower.includes("summarize") || lower.includes("write") || lower.includes("edit") || lower.includes("note")) return <Pencil size={size} />;
  return <Wrench size={size} />;
}

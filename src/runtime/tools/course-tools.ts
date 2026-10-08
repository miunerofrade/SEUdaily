import { defineTool as createTool } from "../../agent/tool.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { consumeActionRequest, issueActionRequest } from "../action-request-store.js";
import { issueAuthResume, type AuthTarget } from "../auth-resume-store.js";
import { localActionExecutionPayload, localActionProposalSchema } from "../local-action-schema.js";
import { runPythonTool } from "./python-bridge.js";
import { isUnapprovedAccessEnabled } from "../permission-state.js";
import { pythonToolOutput, type ToolResult } from "./tool-result.js";

const commonPortalFields = {
  targetUrl: z.string().url().default("https://cvs.seu.edu.cn"),
  cookieFile: z.string().default("cookies.json"),
  exportDir: z.string().default("exports"),
};

const scheduleFields = {
  targetUrl: z
    .string()
    .default("https://ehall.seu.edu.cn/jwapp/sys/wdkb/*default/index.do"),
  cookieFile: z.string().default(".seudaily/ehall-cookies.json"),
  cacheFile: z.string().default(".seudaily/schedule.json"),
};

type JsonRecord = Record<string, unknown>;

function objectValue(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function courseFact(value: unknown): JsonRecord {
  const course = objectValue(value);
  const fact: JsonRecord = {};
  for (const key of [
    "code",
    "name",
    "group",
    "nature",
    "credits",
    "semester",
    "status",
    "choiceNote",
    "source",
    "classificationSource",
  ]) {
    if (course[key] !== undefined && course[key] !== "") fact[key] = course[key];
  }
  const options = arrayValue(course.options).map((option) => {
    const item = objectValue(option);
    return {
      code: item.code,
      name: item.name,
      credits: item.credits,
      semester: item.semester,
      status: item.status,
    };
  });
  if (options.length) fact.options = options;
  return fact;
}

function trainingPlanAuditModelOutput(output: ToolResult) {
  const data = objectValue(output.data);
  const modelView = {
    status: output.status,
    summary: output.summary,
    officialPlan: data.plan,
    officialHardRequirements: arrayValue(data.studyRequirements),
    creditTotals: data.creditTotals,
    evidenceCounts: data.counts,
    evidenceRules: data.evidence,
    limitations: data.limitations,
    coursesByStatus: {
      completedCourses: arrayValue(data.completedCourses).map(courseFact),
      attentionPoints: arrayValue(data.attentionPoints),
      studyingCourses: arrayValue(data.studyingCourses).map(courseFact),
      missingPastCourses: arrayValue(data.missingPastCourses).map(courseFact),
      missingCurrentCourses: arrayValue(data.missingCurrentCourses).map(courseFact),
      futureCourses: arrayValue(data.futureCourses).map(courseFact),
      scheduleOnlyCourses: arrayValue(data.scheduleOnlyCourses).map(courseFact),
      choiceGroups: arrayValue(data.choiceGroups).map(courseFact),
    },
    fullResult: output.resultRef
      ? {
          resultRef: output.resultRef,
          readWith: "read-seudaily-task-result",
          detailPointers: {
            completedCourses: "/data/completedCourses",
            futureCourses: "/data/futureCourses",
            studyingCourses: "/data/studyingCourses",
            choiceGroups: "/data/choiceGroups",
          },
        }
      : undefined,
  };
  return { type: "text" as const, value: JSON.stringify(modelView, null, 2) };
}

function scheduleModelOutput(output: ToolResult) {
  const data = objectValue(output.data);
  const { cacheFile: _cacheFile, customizations: _customizations, calendar: _calendar, ...visibleData } = data;
  const modelView = {
    status: output.status,
    summary: output.summary,
    ...visibleData,
    courses: arrayValue(data.courses),
  };
  return { type: "text" as const, value: JSON.stringify(modelView, null, 2) };
}

function completedResult(summary: string, data?: unknown): ToolResult {
  return {
    status: "completed",
    taskId: `task-${randomUUID()}`,
    summary,
    data,
    artifacts: [],
    citations: [],
    warnings: [],
    metrics: {},
  };
}

async function runAuthAwareTool(
  target: AuthTarget,
  namespace: string,
  action: string,
  payload: Record<string, unknown>,
  options?: { abortSignal?: AbortSignal; requestContext?: { get?: (key: string) => unknown } },
) {
  const result = await runPythonTool<ToolResult>(action, payload, options?.abortSignal);
  if (result.status !== "auth_required") return result;
  const threadId = String(options?.requestContext?.get?.("seudailyThreadId") ?? options?.requestContext?.get?.("cvstreamThreadId") ?? "");
  const authRequest = await issueAuthResume({ target, namespace, action, payload, threadId });
  const data = result.data && typeof result.data === "object" && !Array.isArray(result.data) ? result.data as JsonRecord : {};
  return { ...result, data: { ...data, authRequest } };
}

const focusRequestSchema = z.object({
  kind: z.enum(["notice", "course"]),
  title: z.string().min(1).max(120),
  description: z.string().min(1).max(2_000),
  categories: z.array(z.enum(["news", "academic", "lectures", "student_status", "practice", "teaching_research", "downloads"])).min(1).max(7).optional(),
  courseName: z.string().max(200).optional(),
  teacherNames: z.array(z.string().min(1).max(100)).max(10).optional(),
  sourceKeys: z.array(z.string().min(1)).max(20).optional(),
  semester: z.string().max(100).optional(),
  summary: z.boolean().default(true),
  summaryInstructions: z.string().max(2_000).optional(),
});

const editableScheduleCourseFields = {
  courseName: z.string().min(1).max(200),
  teacherName: z.string().max(100).default(""),
  weekday: z.number().int().min(1).max(7),
  startPeriod: z.number().int().min(1).max(13),
  endPeriod: z.number().int().min(1).max(13),
  weeks: z.array(z.number().int().min(1).max(30)).min(1).max(30),
  classroom: z.string().max(200).default(""),
  courseCode: z.string().max(100).default(""),
};

const editableScheduleCourseSchema = z.object(editableScheduleCourseFields);

const scheduleCourseChangesSchema = z.object({
  courseName: z.string().min(1).max(200).optional(),
  teacherName: z.string().max(100).optional(),
  weekday: z.number().int().min(1).max(7).optional(),
  startPeriod: z.number().int().min(1).max(13).optional(),
  endPeriod: z.number().int().min(1).max(13).optional(),
  weeks: z.array(z.number().int().min(1).max(30)).min(1).max(30).optional(),
  classroom: z.string().max(200).optional(),
  courseCode: z.string().max(100).optional(),
});

const scheduleChangeSchema = z.object({
  operation: z.enum(["add", "update", "move"]),
  course: editableScheduleCourseSchema.optional().describe("新增课程时必填"),
  sourceKey: z.string().min(1).optional().describe("修改或移动已有课程时必填，来自课表查询结果"),
  changes: scheduleCourseChangesSchema.optional().describe("修改课程字段或移动后的节次、教室等变化"),
  fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("移动单次课程时的原日期"),
  toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("移动单次课程时的新日期"),
});

function deferredRequestModelOutput() {
  return { type: "text" as const, value: "OK" };
}

const requestCreateFocusTool = createTool({
  ...pythonToolOutput,
  toModelOutput: deferredRequestModelOutput,
  id: "request-create-focus",
  description: "记录一个待执行的创建关注请求；此工具不修改数据。普通创建关注请求使用此工具。",
  inputSchema: focusRequestSchema,
  execute: async (input) => {
    const text = `替我创建“${input.title}”的关注`;
    const actionRequest = await issueActionRequest("create-focus", text, input);
    return completedResult("请求已记录。", { actionRequest });
  },
});

const createFocusFromRequestTool = createTool({
  ...pythonToolOutput,
  id: "create-focus-from-request",
  description: "执行由 requestId 标识的已授权创建关注请求。仅处理 SEUDAILY_ACTION_REQUEST 消息。",
  inputSchema: z.object({ requestId: z.string().startsWith("action-") }),
  execute: async ({ requestId }, options) => {
    const payload = await consumeActionRequest(requestId, "create-focus");
    const id = `focus-${randomUUID()}`;
    return runPythonTool("upsert-focus", {
      item: { ...payload, id, threadId: id, resourceId: "seudaily-focus-local", enabled: true },
    }, options?.abortSignal);
  },
});

const requestModifyScheduleTool = createTool({
  ...pythonToolOutput,
  toModelOutput: deferredRequestModelOutput,
  id: "request-modify-schedule",
  description: "记录一个待执行的本地课表新增、修改或单次移动请求；此工具不修改数据。普通课表变更请求使用此工具。",
  inputSchema: scheduleChangeSchema,
  execute: async (input) => {
    if (input.operation === "add") {
      if (!input.course) throw new Error("新增课表课程时必须提供 course");
      if (input.course.endPeriod < input.course.startPeriod) throw new Error("endPeriod 不能早于 startPeriod");
    } else if (input.operation === "update") {
      if (!input.sourceKey || !input.changes || !Object.keys(input.changes).length) {
        throw new Error("修改课表课程时必须提供 sourceKey 和至少一个 changes 字段");
      }
      if (input.changes.startPeriod !== undefined && input.changes.endPeriod !== undefined && input.changes.endPeriod < input.changes.startPeriod) {
        throw new Error("endPeriod 不能早于 startPeriod");
      }
    } else {
      if (!input.sourceKey || !input.fromDate || !input.toDate) {
        throw new Error("移动单次课程时必须提供 sourceKey、fromDate 和 toDate");
      }
      if (input.changes?.startPeriod !== undefined && input.changes.endPeriod !== undefined && input.changes.endPeriod < input.changes.startPeriod) {
        throw new Error("endPeriod 不能早于 startPeriod");
      }
    }
    const detail = input.operation === "add" ? `新增“${input.course!.courseName}”` : input.operation === "move" ? "移动指定课次" : "修改指定课程";
    const actionRequest = await issueActionRequest("modify-schedule", `替我修改课表：${detail}`, input);
    return completedResult("请求已记录。", { actionRequest });
  },
});

const modifyScheduleFromRequestTool = createTool({
  ...pythonToolOutput,
  id: "modify-schedule-from-request",
  description: "执行由 requestId 标识的已授权本地课表变更请求。仅处理 SEUDAILY_ACTION_REQUEST 消息。",
  inputSchema: z.object({ requestId: z.string().startsWith("action-") }),
  execute: async ({ requestId }, options) => {
    const payload = await consumeActionRequest(requestId, "modify-schedule");
    return runPythonTool("apply-agent-schedule-change", payload, options?.abortSignal);
  },
});

const authorizePortalTool = createTool({
  ...pythonToolOutput,
  id: "authorize-course-portal",
  description:
    "Establish the course application's session over HTTP using saved credentials. Open a visible login window only for captcha or interactive verification. Use when a course tool returns auth_required.",
  inputSchema: z.object(commonPortalFields),
  execute: async (context, options) => runPythonTool("authorize", context, options?.abortSignal),
});

const authorizeScheduleTool = createTool({
  ...pythonToolOutput,
  id: "authorize-schedule-portal",
  description:
    "Authorize SEU eHall using saved credentials over HTTP. Open a visible login window only when interactive verification is required. The user handles captcha or secondary confirmation. Call when get-course-schedule returns auth_required.",
  inputSchema: z.object({
    ...scheduleFields,
    timeoutSeconds: z.number().int().min(30).max(600).default(300),
    resetSession: z
      .boolean()
      .default(true)
      .describe("Clear the saved SEU eHall cookie and use a fresh visible browser session"),
  }),
  execute: async (context, options) => runPythonTool("authorize-schedule", context, options?.abortSignal),
});

export const getScheduleTool = createTool({
  ...pythonToolOutput,
  toModelOutput: scheduleModelOutput,
  id: "get-course-schedule",
  description:
    "Read the complete SEU timetable for the current or a historical academic semester. Always returns all courses; it is never limited to the first 12. Omit date for the normal complete timetable. Pass date as YYYY-MM-DD to return only courses scheduled on that date, using the configured semester start date, teaching week, weekday, odd/even weeks, and date overrides.",
  inputSchema: z.object({
    ...scheduleFields,
    semester: z
      .string()
      .regex(/^\d{4}-\d{4}-\d+$/)
      .optional()
      .describe("Exact eHall timetable semester code. Usually 1=summer school, 2=fall semester, 3=spring semester, but use the dynamic value returned by availableSemesters when it differs. Example: 2025-2026-2. Omit for the portal's current semester."),
    refresh: z
      .boolean()
      .default(false)
      .describe("Explicitly re-fetch the timetable and check the official calendar page. Otherwise existing timetable caches never expire; only a missing cache triggers synchronization."),
    localOnly: z
      .boolean()
      .default(false)
      .describe("Set true for an explicitly offline read: never access the network and return an empty status when no cache exists. With the default false, a missing timetable is synchronized automatically; an existing cache is reused regardless of age unless refresh=true."),
    includeAvailableSemesters: z
      .boolean()
      .default(false)
      .describe("Return the complete dynamic semester list exposed by eHall"),
    prefetchAvailableSemesters: z
      .boolean()
      .default(true)
      .describe("Remote synchronization defaults to fetching and caching every available semester whose academic start year is at least the current Shanghai calendar year minus four through the authenticated API. Set false only when the user explicitly requests synchronization of one semester. Local-only reads never access the network."),
    date: z
      .union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)])
      .optional()
      .describe("Optional target date in YYYY-MM-DD. Omit or leave empty for the complete timetable; when provided, return only that day's courses."),
  }),
  execute: async (context, options) => runAuthAwareTool("schedule", "schedule", "get-schedule", context, options),
});

const unifiedCourseTarget = z.object({
  source: z.enum(["schedule", "manual"]),
  scheduleId: z.string().trim().min(1).optional(), courseName: z.string().trim().min(1).optional(), teacherName: z.string().trim().min(1).optional(),
  weeklyPeriods: z.array(z.number().int().min(1).max(13)).min(1).max(13).optional(), courseDate: z.iso.date().optional(), semester: z.string().optional(),
}).superRefine((value, context) => {
  if (value.source === "schedule" && !value.scheduleId) {
    context.addIssue({ code: "custom", path: ["scheduleId"], message: "schedule 目标必须提供 scheduleId" });
  }
  if (value.source === "manual") {
    for (const field of ["courseName", "teacherName", "weeklyPeriods"] as const) {
      if (!value[field]) context.addIssue({ code: "custom", path: [field], message: `manual 目标必须提供 ${field}` });
    }
  }
});

export const resolveCourseTool = createTool({
  ...pythonToolOutput,
  id: "resolve-course",
  description: "统一搜索课程、列出课程课次或精确定位课次。mode=search 搜索候选课程，sessions 返回按日期聚合的课次，resolve 返回 found/ambiguous/not_found。",
  inputSchema: z.object({
    ...commonPortalFields, scheduleCacheFile: z.string().default(".seudaily/schedule.json"),
    mode: z.enum(["search", "sessions", "resolve"]), query: z.string().optional(), courseName: z.string().optional(), teacherName: z.string().optional(), weeklyPeriods: z.array(z.number().int().min(1).max(13)).optional(), courseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), semester: z.string().optional(), source: z.enum(["schedule", "manual"]).optional(), scheduleId: z.string().optional(),
  }).superRefine((v, ctx) => {
    if (v.mode === "search" && !v.query) ctx.addIssue({ code: "custom", path: ["query"], message: "search 模式需要 query" });
    if (v.mode === "sessions" && !v.courseName && !(v.source === "schedule" && v.scheduleId)) ctx.addIssue({ code: "custom", path: ["courseName"], message: "sessions 模式需要 courseName，或提供 source=schedule 与 scheduleId" });
    if (v.mode === "resolve" && (!v.source || (v.source === "schedule" ? !v.scheduleId : (!v.courseName || !v.teacherName || !v.weeklyPeriods?.length)))) ctx.addIssue({ code: "custom", path: ["source"], message: "resolve 模式需要完整的 source 目标" });
  }),
  execute: async (input, options) => {
    const action = input.mode === "search" ? "search-courses" : input.mode === "sessions" ? "list-course-sessions" : "find-course-session";
    let resolvedCourseName = input.courseName;
    let resolvedTeacherName = input.teacherName;
    if (input.mode === "sessions" && input.source === "schedule" && input.scheduleId && !resolvedCourseName) {
      const schedule = await runPythonTool("get-schedule", { cacheFile: input.scheduleCacheFile, semester: input.semester, localOnly: true }, options?.abortSignal);
      const courses = arrayValue(objectValue(schedule.data).courses);
      const course = courses.map(objectValue).find((item) => item.scheduleId === input.scheduleId || item.id === input.scheduleId);
      if (!course) throw new Error(`本地课表中找不到课程 ${input.scheduleId}，请先同步课表或使用 source=manual`);
      resolvedCourseName = String(course.courseName ?? course.name ?? "").trim();
      const teachers = arrayValue(course.teacherNames ?? course.teachers).map(String).filter(Boolean);
      resolvedTeacherName = resolvedTeacherName || String(course.teacherName ?? teachers[0] ?? "").trim();
    }
    const payload = input.mode === "search" ? { ...input } : input.mode === "sessions" ? { ...input, courseName: resolvedCourseName, teacherName: resolvedTeacherName ?? "" } : { ...input, target: { source: input.source, scheduleId: input.scheduleId, courseName: input.courseName, teacherName: input.teacherName, weeklyPeriods: input.weeklyPeriods, courseDate: input.courseDate, semester: input.semester } };
    return runAuthAwareTool("course", "course-materials", action, payload, options);
  },
});

export const captureCourseMaterialsTool = createTool({
  ...pythonToolOutput,
  id: "capture-course-materials",
  description: "按一个或多个课程目标抓取课程字幕、媒体或 PPT；targets 长度为一时抓取单门，多个时批量抓取。结果会分别报告录像是否存在、官方字幕是否存在、ASR 是否执行及失败原因、媒体是否保存和最终产物数量。注意：hasAiContent=false 仅表示没有官方 AI 字幕，不代表没有录像；keepMedia=false 时成功定位到的临时录像不会保留。",
  inputSchema: z.object({ ...commonPortalFields, scheduleCacheFile: z.string().default(".seudaily/schedule.json"), targets: z.array(unifiedCourseTarget).min(1), needSubtitle: z.boolean().default(true), needPpt: z.boolean().default(false), keepMedia: z.boolean().default(false), asrEngine: z.enum(["local", "cloud"]).default("local"), modelPath: z.string().optional(), asrModel: z.string().default("paraformer-realtime-v2"), maxConcurrency: z.number().int().min(1).max(2).default(2) }),
  execute: async (input, options) => {
    const action = input.targets.length === 1 ? "capture-course-session" : "capture-course-sessions";
    const payload = input.targets.length === 1 ? { ...input, target: input.targets[0] } : input;
    return runAuthAwareTool("course", "course-materials", action, payload, options);
  },
});

export const proposeLocalActionTool = createTool({
  ...pythonToolOutput,
  toModelOutput: (output: ToolResult) => {
    const data = objectValue(output.data);
    if (data.actionRequest) return deferredRequestModelOutput();
    return {type: "text" as const, value: JSON.stringify({status: output.status, summary: output.summary, change: data.change, warnings: output.warnings})};
  },
  id: "propose-local-action",
  description: "管理本地课表或创建关注。preview 只提出方案；apply 按现有权限执行，普通模式需审批，完全访问模式可直接执行。支持学期设置、周期/单日增课、改单日课程、停课与移动单次课，不能修改学校远端课表。学期起止日期可先用 read-web-page 读取学校校历确认；semester 仅支持 name/startDate/totalWeeks，未指定总周数保留已有值，缺省为 16 周。",
  requireApproval: (input, options) => input.mode === "apply" && !isUnapprovedAccessEnabled(options),
  inputSchema: localActionProposalSchema,
  execute: async (input, options) => {
    if (input.mode === "apply") {
      if (options?.requestContext?.get("seudailyFocus") === true) throw new Error("Focus 任务不能自行修改课表或创建其他关注");
      const payload = localActionExecutionPayload(input);
      if (input.kind !== "create_focus") return runPythonTool("apply-agent-schedule-change", payload, options?.abortSignal);
      const id = `focus-${randomUUID()}`;
      const result = await runPythonTool<ToolResult>("upsert-focus", {item:{...payload,id,threadId:id,resourceId:'seudaily-focus-local',enabled:true}}, options?.abortSignal);
      if (result.status === 'completed') (await import('../focus-runtime.js')).startFocusRuntime();
      return result;
    }
    const kind = input.kind === "create_focus" ? "create-focus" : "modify-schedule";
    const text = input.kind === "create_focus" ? `替我创建“${input.focus!.title}”的关注` : `替我修改课表`;
    const actionRequest = await issueActionRequest(kind, text, {
      kind: input.kind,
      payload: localActionExecutionPayload(input),
    });
    return completedResult("已生成待执行的本地操作。", { actionRequest, proposal: input });
  },
});

export const getCurrentDateTool = createTool({
  ...pythonToolOutput,
  id: "get-current-date",
  description:
    "Get the current date and weekday in Asia/Shanghai for resolving relative requests such as today or tomorrow. Use this instead of terminal commands or reading local files. This tool does not read the timetable.",
  inputSchema: z.object({}),
  execute: async () => {
    const now = new Date();
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
    const weekday = new Date(`${date}T12:00:00+08:00`).getUTCDay() || 7;
    return completedResult(`上海时间：${date}，${['周一','周二','周三','周四','周五','周六','周日'][weekday - 1]}`, { date, weekday, timezone: 'Asia/Shanghai', timestamp: now.toISOString() });
  },
});

export const auditTrainingPlanTool = createTool({
  outputSchema: pythonToolOutput.outputSchema,
  toModelOutput: trainingPlanAuditModelOutput,
  id: "audit-training-plan",
  description:
    "返回 eHall 官方培养方案要求和课表证据，供模型进行判断。结果包含硬性要求、选择组、当前或缺失的课表证据、仅课表课程和数据限制，但不直接判断是否符合毕业条件，也不分配风险等级。历史课表出现只能证明有修读记录，不能证明课程通过或已经获得学分。",
  inputSchema: z.object({
    cookieFile: z.string().default(".seudaily/ehall-cookies.json"),
    cacheFile: z.string().default(".seudaily/training-plan.json"),
    scheduleCacheFile: z.string().default(".seudaily/schedule.json"),
    planId: z.string().optional().describe("当 eHall 返回多个个人方案时，可指定准确的方案 ID"),
    refresh: z.boolean().default(false).describe("核查前从 eHall 刷新个人方案；除非用户明确要求同步，否则保持 false"),
  }),
  execute: async (context, options) => runAuthAwareTool("schedule", "training-plan", "analyze-training-plan", context, options),
});

export { queryCampusNoticesTool, readCampusNoticeTool } from "./notices.js";

const listCourseDatesTool = createTool({
  ...pythonToolOutput,
  id: "list-course-dates",
  description: "List all available lecture dates from the authenticated course page.",
  inputSchema: z.object(commonPortalFields),
  execute: async (context, options) => runPythonTool("list-dates", context, options?.abortSignal),
});

const listCoursesTool = createTool({
  ...pythonToolOutput,
  id: "list-courses",
  description:
    "List courses in the authenticated CVS on-demand/replay catalog. Use only when the user wants course recordings, subtitles, slides, or other replay-course materials; do not use for the user's personal timetable, today's classes, or JWC/CSE notices.",
  inputSchema: z.object(commonPortalFields),
  execute: async (context, options) => runPythonTool("list-courses", context, options?.abortSignal),
});

const searchCoursesTool = createTool({
  ...pythonToolOutput,
  id: "search-courses",
  description:
    "Search on-demand courses by course name, classroom, teacher, or course number, then select an optional academic semester before reading results.",
  inputSchema: z.object({
    ...commonPortalFields,
    query: z.string().min(1).describe("Course name, classroom, teacher, or course number"),
    semester: z.string().min(1).optional().describe("Academic semester, for example 2025-2026学年第3学期"),
  }),
  execute: async (context, options) => runPythonTool("search-courses", context, options?.abortSignal),
});

const listCourseSessionsTool = createTool({
  ...pythonToolOutput,
  id: "list-course-sessions",
  description: "List published session dates and periods for one exact course and teacher in the replay catalog.",
  inputSchema: z.object({
    ...commonPortalFields,
    courseName: z.string().min(1),
    teacherName: z.string().min(1),
    semester: z.string().min(1).optional(),
  }),
  execute: async (context, options) => runPythonTool("list-course-sessions", context, options?.abortSignal),
});

const courseSessionIdentity = {
  courseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  semester: z.string().min(1).optional().describe("Academic semester used to disambiguate repeated courses, for example 2025-2026学年第3学期"),
};

const courseTarget = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("schedule"),
    scheduleId: z
      .string()
      .startsWith("seu-")
      .describe("Stable id returned by get-course-schedule"),
    ...courseSessionIdentity,
  }),
  z.object({
    source: z.literal("manual"),
    courseName: z.string().min(1).describe("Exact course name inferred from the request"),
    teacherName: z.string().min(1).describe("Exact teacher name inferred from the request"),
    weeklyPeriods: z
      .array(z.number().int().min(1))
      .min(1)
      .describe("All scheduled period numbers, for example [3, 4, 5]"),
    ...courseSessionIdentity,
  }),
]);

const captureOptions = {
  needSubtitle: z.boolean().default(true),
  needPpt: z.boolean().default(false),
  keepMedia: z.boolean().default(false),
  asrEngine: z.enum(["local", "cloud"]).default("local"),
  modelPath: z.string().optional(),
  asrModel: z.string().default("paraformer-realtime-v2"),
};

const findCourseSessionTool = createTool({
  ...pythonToolOutput,
  id: "find-course-session",
  description:
    "Resolve a course target in the selected on-demand semester. Use source=schedule with a scheduleId for timetable courses; use source=manual with model-filled course name, teacher, and periods for courses outside the timetable.",
  inputSchema: z.object({
    ...commonPortalFields,
    scheduleCacheFile: z.string().default(".seudaily/schedule.json"),
    target: courseTarget,
  }),
  execute: async (context, options) => runPythonTool("find-course-session", context, options?.abortSignal),
});

const captureCourseSessionTool = createTool({
  ...pythonToolOutput,
  id: "capture-course-session",
  description:
    "Capture every lesson segment for one target date. Timetable targets use scheduleId; courses outside the timetable use a manual target filled from the user's semantic request. Date defaults to latest.",
  inputSchema: z.object({
    ...commonPortalFields,
    scheduleCacheFile: z.string().default(".seudaily/schedule.json"),
    target: courseTarget,
    ...captureOptions,
  }),
  execute: async (context, options) => runPythonTool("capture-course-session", context, options?.abortSignal),
});

const captureCourseSessionsTool = createTool({
  ...pythonToolOutput,
  id: "capture-course-sessions",
  description:
    "Capture a queue of course sessions over HTTP. Media, ASR fallback, and slide processing stay serialized to limit peak resource use; no browser is required for normal course access.",
  inputSchema: z.object({
    ...commonPortalFields,
    scheduleCacheFile: z.string().default(".seudaily/schedule.json"),
    targets: z.array(courseTarget).min(1),
    maxConcurrency: z.number().int().min(1).max(2).default(2),
    ...captureOptions,
  }),
  execute: async (context, options) => runPythonTool("capture-course-sessions", context, options?.abortSignal),
});

const captureCourseTool = createTool({
  ...pythonToolOutput,
  id: "capture-course",
  description:
    "Capture official subtitles and optionally media or slides for a lecture date. Credentials are read from environment variables.",
  inputSchema: z.object({
    ...commonPortalFields,
    targetDate: z.string().default("自动获取最新"),
    needSubtitle: z.boolean().default(true),
    needPpt: z.boolean().default(false),
    keepMedia: z.boolean().default(false),
    asrEngine: z.enum(["local", "cloud"]).default("local"),
    modelPath: z.string().optional(),
    asrModel: z.string().default("paraformer-realtime-v2"),
  }),
  execute: async (context, options) => runPythonTool("capture-course", context, options?.abortSignal),
});

const transcribeMediaTool = createTool({
  ...pythonToolOutput,
  id: "transcribe-local-media",
  description: "Transcribe a local audio or video file with Faster Whisper.",
  inputSchema: z.object({
    mediaPath: z.string(),
    modelPath: z.string(),
    outputDir: z.string().default("exports/subtitle"),
    taskName: z.string(),
  }),
  execute: async (context, options) => runPythonTool("transcribe-local", context, options?.abortSignal),
});

const transcribeCloudAudioTool = createTool({
  ...pythonToolOutput,
  id: "transcribe-cloud-audio",
  description: "Transcribe a local MP3 or WAV file with the configured cloud ASR service.",
  inputSchema: z.object({
    audioPath: z.string(),
    outputDir: z.string().default("exports/subtitle"),
    taskName: z.string(),
    model: z.string().default("paraformer-realtime-v2"),
  }),
  execute: async (context, options) => runPythonTool("transcribe-cloud", context, options?.abortSignal),
});

const extractSlidesTool = createTool({
  ...pythonToolOutput,
  id: "extract-course-slides",
  description: "Detect slide changes in a lecture video and create a PDF.",
  inputSchema: z.object({
    videoPath: z.string(),
    outputDir: z.string().default("exports/media"),
    taskName: z.string(),
    intervalSec: z.number().int().min(1).max(120).default(10),
  }),
  execute: async (context, options) => runPythonTool("extract-slides", context, options?.abortSignal),
});

const summarizeCourseTool = createTool({
  ...pythonToolOutput,
  id: "summarize-course-transcripts",
  description:
    "Generate a Markdown course note from one captured batch, selected transcript files, or direct text. Use summaryInstructions to specify the desired focus or output format.",
  inputSchema: z.object({
    exportDir: z.string().default("exports"),
    courseName: z.string().min(1).describe("Course name used for note organization"),
    sourceType: z.enum(["batch", "files", "text"]).default("batch"),
    dateTeacher: z
      .string()
      .optional()
      .describe("Required for batch: captured date-teacher directory name"),
    transcriptPaths: z
      .array(z.string())
      .min(1)
      .max(50)
      .optional()
      .describe("Required for files: selected paths under exportDir/subtitle"),
    content: z
      .string()
      .max(1_000_000)
      .optional()
      .describe("Required for text: direct course content to summarize"),
    summaryInstructions: z
      .string()
      .max(10_000)
      .optional()
      .describe("Requested focus and format, such as exam points or an outline"),
    outputName: z.string().optional().describe("Markdown filename without a path"),
    llmEngine: z.string().default("DeepSeek (api.deepseek.com)"),
    baseUrl: z.string().url().optional(),
    model: z.string().default("deepseek-flash"),
  }),
  execute: async (context, options) => runPythonTool("summarize-course", context, options?.abortSignal),
});

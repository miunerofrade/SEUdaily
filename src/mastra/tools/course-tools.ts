import { createTool } from "@mastra/core/tools";
import { z } from "zod";

import { runPythonTool } from "./python-bridge.js";
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
  cookieFile: z.string().default(".cvstream/ehall-cookies.json"),
  cacheFile: z.string().default(".cvstream/schedule.json"),
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

export const authorizePortalTool = createTool({
  ...pythonToolOutput,
  id: "authorize-course-portal",
  description:
    "Open a visible browser and establish a course-portal session. Use only when authentication is missing or expired.",
  inputSchema: z.object(commonPortalFields),
  execute: async (context, options) => runPythonTool("authorize", context, options?.abortSignal),
});

export const authorizeScheduleTool = createTool({
  ...pythonToolOutput,
  id: "authorize-schedule-portal",
  description:
    "Open a visible SEU eHall timetable window, automatically fill credentials from CVSTREAM_USERNAME/CVSTREAM_PASSWORD, and submit ordinary login. The user only handles captcha or secondary VPN confirmation. Call when get-course-schedule returns auth_required.",
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
  id: "get-course-schedule",
  description:
    "Read an SEU timetable for the current or a historical academic semester. Omit semester for the current timetable; pass an exact semester code returned by eHall (for example 2025-2026-2) for another timetable. Semester-specific caches are isolated. The school response is the source of truth for available semester values.",
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
      .describe("Re-fetch the selected semester from SEU eHall instead of using that semester's local cache"),
    includeAvailableSemesters: z
      .boolean()
      .default(false)
      .describe("Return the complete dynamic semester list exposed by eHall"),
    prefetchAvailableSemesters: z
      .boolean()
      .default(false)
      .describe("Sequentially fetch and cache every semester returned by eHall in the authenticated session"),
  }),
  execute: async (context, options) => runPythonTool("get-schedule", context, options?.abortSignal),
});

export const auditTrainingPlanTool = createTool({
  outputSchema: pythonToolOutput.outputSchema,
  toModelOutput: trainingPlanAuditModelOutput,
  id: "audit-training-plan",
  description:
    "返回 eHall 官方培养方案要求和课表证据，供模型进行判断。结果包含硬性要求、选择组、当前或缺失的课表证据、仅课表课程和数据限制，但不直接判断是否符合毕业条件，也不分配风险等级。历史课表出现只能证明有修读记录，不能证明课程通过或已经获得学分。",
  inputSchema: z.object({
    cookieFile: z.string().default(".cvstream/ehall-cookies.json"),
    cacheFile: z.string().default(".cvstream/training-plan.json"),
    scheduleCacheFile: z.string().default(".cvstream/schedule.json"),
    planId: z.string().optional().describe("当 eHall 返回多个个人方案时，可指定准确的方案 ID"),
    refresh: z.boolean().default(false).describe("核查前从 eHall 刷新个人方案；除非用户明确要求同步，否则保持 false"),
  }),
  execute: async (context, options) => runPythonTool("analyze-training-plan", context, options?.abortSignal),
});

export const searchJwcTool = createTool({
  ...pythonToolOutput,
  id: "search-seu-academic-affairs",
  description:
    "使用东南大学教务处网站自带的 WebPlus 搜索接口。工具会搜索给定问题，不执行本地关键词匹配。省略栏目和列表路径时进行全站搜索；提供一个或多个路径时，将搜索范围限制在指定栏目。",
  inputSchema: z.object({
    baseUrl: z.string().url().default("https://jwc.seu.edu.cn"),
    cacheDir: z.string().default(".cvstream/jwc"),
    query: z.string().min(1).describe("用户原始的信息需求"),
    categories: z
      .array(z.enum(["news", "academic", "lectures", "student_status", "practice", "teaching_research", "downloads"]))
      .min(1)
      .max(7)
      .optional()
      .describe("Explicit columns: news=最新动态, academic=教务信息, lectures=文化素质教育/讲座预告, student_status=学籍管理, practice=实践教学, teaching_research=教学研究, downloads=下载专区"),
    paths: z
      .array(z.enum(["/zxdt/list.htm", "/jwxx/list.htm", "/cbxx/list.htm", "/xjgl/list.htm", "/sjjx/list.htm", "/jxyj/list.htm", "/xzzq/list.htm"]))
      .min(1)
      .max(7)
      .optional()
      .describe("Explicit list paths with hints: /zxdt/list.htm=最新动态, /jwxx/list.htm=教务信息, /cbxx/list.htm=文化素质教育/讲座预告, /xjgl/list.htm=学籍管理, /sjjx/list.htm=实践教学, /jxyj/list.htm=教学研究, /xzzq/list.htm=下载专区. Multiple paths are allowed."),
    limit: z.number().int().min(1).max(20).default(5),
    timeoutSeconds: z.number().int().min(5).max(60).default(15),
  }),
  execute: async (context, options) => runPythonTool("search-jwc", context, options?.abortSignal),
});

export const listJwcTool = createTool({
  ...pythonToolOutput,
  id: "list-seu-academic-affairs",
  description:
    "刷新指定的教务处栏目，并按发布日期和数量限制返回筛选后的列表。查询最新或近期通知时使用此工具；它不执行关键词匹配。",
  inputSchema: z.object({
    baseUrl: z.string().url().default("https://jwc.seu.edu.cn"),
    cacheDir: z.string().default(".cvstream/jwc"),
    categories: z.array(z.enum(["news", "academic", "lectures", "student_status", "practice", "teaching_research", "downloads"])).min(1).max(7).optional(),
    paths: z.array(z.enum(["/zxdt/list.htm", "/jwxx/list.htm", "/cbxx/list.htm", "/xjgl/list.htm", "/sjjx/list.htm", "/jxyj/list.htm", "/xzzq/list.htm"])).min(1).max(7).optional(),
    freshness: z.enum(["latest", "balanced", "archive", "cache_only"]).default("latest"),
    timeScope: z.enum(["latest", "recent", "any"]).default("any"),
    recentDays: z.number().int().min(1).max(3650).default(7),
    limit: z.number().int().min(1).max(20).default(5),
    timeoutSeconds: z.number().int().min(5).max(60).default(15),
  }).refine((value) => Boolean(value.categories?.length || value.paths?.length), {
    message: "必须明确提供栏目或路径；已禁用自动路由。",
    path: ["categories"],
  }),
  execute: async (context, options) => runPythonTool("list-jwc", context, options?.abortSignal),
});

export const getJwcArticleTool = createTool({
  ...pythonToolOutput,
  id: "get-seu-academic-affairs-notice",
  description:
    "根据搜索结果返回的稳定文章 ID，读取一条教务处通知。只有需要正文或附件链接时才使用；refresh=true 会重新验证选中的详情页。",
  inputSchema: z.object({
    baseUrl: z.string().url().default("https://jwc.seu.edu.cn"),
    cacheDir: z.string().default(".cvstream/jwc"),
    articleId: z.string().min(10),
    refresh: z.boolean().default(true),
    timeoutSeconds: z.number().int().min(5).max(60).default(15),
  }),
  execute: async (context, options) => runPythonTool("get-jwc-article", context, options?.abortSignal),
});

export const searchCseNoticesTool = createTool({
  ...pythonToolOutput,
  id: "search-seu-cse-notices",
  description:
    "Search the SEU Computer Science, Software and AI school website. It validates only semantically relevant list columns, returns matching metadata immediately, and queues detail snapshots in the background.",
  inputSchema: z.object({
    baseUrl: z.string().url().default("https://cse.seu.edu.cn"),
    cacheDir: z.string().default(".cvstream/cse"),
    query: z.string().min(1).describe("The user's original information need"),
    categories: z
      .array(z.enum([
        "undergraduate_notices",
        "teaching",
        "student_affairs",
        "employment",
        "research",
        "academic_events",
        "recruitment",
        "undergraduate_downloads",
        "graduate_downloads",
      ]))
      .min(1)
      .max(9)
      .optional(),
    paths: z.array(z.enum(["/49469/list.htm", "/49470/list.htm", "/49447/list.htm", "/jyxx/list.htm", "/49441/list.htm", "/xshd_53564/list.htm", "/rczp/list.htm", "/xzzq_53939/list.htm", "/xzzq_52683/list.htm"])).min(1).max(9).optional().describe("Explicit CSE list paths; multiple paths are allowed."),
    limit: z.number().int().min(1).max(20).default(5),
    timeoutSeconds: z.number().int().min(5).max(60).default(15),
  }).refine((value) => Boolean(value.categories?.length || value.paths?.length), {
    message: "Provide explicit categories or paths; automatic routing is disabled.",
    path: ["categories"],
  }),
  execute: async (context, options) => runPythonTool("search-cse", context, options?.abortSignal),
});

export const getCseNoticeTool = createTool({
  ...pythonToolOutput,
  id: "get-seu-cse-notice",
  description:
    "Read one Computer Science, Software and AI school notice by the stable article id returned from search, including normalized body and attachment links.",
  inputSchema: z.object({
    baseUrl: z.string().url().default("https://cse.seu.edu.cn"),
    cacheDir: z.string().default(".cvstream/cse"),
    articleId: z.string().startsWith("seu-cse-"),
    refresh: z.boolean().default(true),
    timeoutSeconds: z.number().int().min(5).max(60).default(15),
  }),
  execute: async (context, options) => runPythonTool("get-cse-article", context, options?.abortSignal),
});

export const listCourseDatesTool = createTool({
  ...pythonToolOutput,
  id: "list-course-dates",
  description: "List all available lecture dates from the authenticated course page.",
  inputSchema: z.object(commonPortalFields),
  execute: async (context, options) => runPythonTool("list-dates", context, options?.abortSignal),
});

export const listCoursesTool = createTool({
  ...pythonToolOutput,
  id: "list-courses",
  description: "List courses currently visible in the authenticated course replay catalog.",
  inputSchema: z.object(commonPortalFields),
  execute: async (context, options) => runPythonTool("list-courses", context, options?.abortSignal),
});

export const searchCoursesTool = createTool({
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

export const listCourseSessionsTool = createTool({
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

export const findCourseSessionTool = createTool({
  ...pythonToolOutput,
  id: "find-course-session",
  description:
    "Resolve a course target in the selected on-demand semester. Use source=schedule with a scheduleId for timetable courses; use source=manual with model-filled course name, teacher, and periods for courses outside the timetable.",
  inputSchema: z.object({
    ...commonPortalFields,
    scheduleCacheFile: z.string().default(".cvstream/schedule.json"),
    target: courseTarget,
  }),
  execute: async (context, options) => runPythonTool("find-course-session", context, options?.abortSignal),
});

export const captureCourseSessionTool = createTool({
  ...pythonToolOutput,
  id: "capture-course-session",
  description:
    "Capture every lesson segment for one target date. Timetable targets use scheduleId; courses outside the timetable use a manual target filled from the user's semantic request. Date defaults to latest.",
  inputSchema: z.object({
    ...commonPortalFields,
    scheduleCacheFile: z.string().default(".cvstream/schedule.json"),
    target: courseTarget,
    ...captureOptions,
  }),
  execute: async (context, options) => runPythonTool("capture-course-session", context, options?.abortSignal),
});

export const captureCourseSessionsTool = createTool({
  ...pythonToolOutput,
  id: "capture-course-sessions",
  description:
    "Capture a queue of course sessions. The current shared-browser worker serializes portal access to control memory use; video, ASR fallback, and slide processing are also serialized.",
  inputSchema: z.object({
    ...commonPortalFields,
    scheduleCacheFile: z.string().default(".cvstream/schedule.json"),
    targets: z.array(courseTarget).min(1),
    maxConcurrency: z.number().int().min(1).max(2).default(2),
    ...captureOptions,
  }),
  execute: async (context, options) => runPythonTool("capture-course-sessions", context, options?.abortSignal),
});

export const captureCourseTool = createTool({
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

export const transcribeMediaTool = createTool({
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

export const transcribeCloudAudioTool = createTool({
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

export const extractSlidesTool = createTool({
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

export const summarizeCourseTool = createTool({
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

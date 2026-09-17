import { createTool } from "@mastra/core/tools";
import { z } from "zod";

import { runPythonTool } from "./python-bridge.js";

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

export const authorizePortalTool = createTool({
  id: "authorize-course-portal",
  description:
    "Open a visible browser and establish a course-portal session. Use only when authentication is missing or expired.",
  inputSchema: z.object(commonPortalFields),
  execute: async (context) => runPythonTool("authorize", context),
});

export const authorizeScheduleTool = createTool({
  id: "authorize-schedule-portal",
  description:
    "Open a visible SEU eHall timetable window, automatically fill credentials from CVSTREAM_USERNAME/CVSTREAM_PASSWORD, and submit ordinary login. The user only handles captcha or secondary VPN confirmation. Call when get-course-schedule returns auth_required.",
  inputSchema: z.object({
    ...scheduleFields,
    timeoutSeconds: z.number().int().min(30).max(600).default(300),
  }),
  execute: async (context) => runPythonTool("authorize-schedule", context),
});

export const getScheduleTool = createTool({
  id: "get-course-schedule",
  description:
    "Read the normalized local timetable cache. Set refresh=true only for the first sync or when the user explicitly requests an update. Returns course name, teacher, weekday, weekly periods, weeks, and classroom.",
  inputSchema: z.object({
    ...scheduleFields,
    refresh: z
      .boolean()
      .default(false)
      .describe("Fetch from SEU eHall instead of using the local cache"),
  }),
  execute: async (context) => runPythonTool("get-schedule", context),
});

export const searchJwcTool = createTool({
  id: "search-seu-academic-affairs",
  description:
    "Search SEU Academic Affairs notice lists and return matching metadata immediately. Matching details are queued for silent background snapshot sync. Separate result time scope from cache freshness. For words such as 最新、最近、今天、截至目前, use freshness=latest.",
  inputSchema: z.object({
    baseUrl: z.string().url().default("https://jwc.seu.edu.cn"),
    cacheDir: z.string().default(".cvstream/jwc"),
    query: z.string().min(1).describe("The user's original information need"),
    keywords: z
      .array(z.string().min(1))
      .min(1)
      .max(8)
      .optional()
      .describe("Concise search terms semantically extracted from the request"),
    categories: z
      .array(z.enum(["auto", "news", "academic", "student_status", "practice", "teaching_research", "downloads"]))
      .min(1)
      .max(3)
      .default(["auto"])
      .describe("Search only relevant columns; auto routes by semantics"),
    freshness: z
      .enum(["latest", "balanced", "archive", "cache_only"])
      .default("balanced")
      .describe("All modes except cache_only validate relevant list pages; latest is strict fresh intent, archive expands to older pages on miss"),
    timeScope: z
      .enum(["latest", "recent", "any"])
      .default("any")
      .describe("latest returns the newest matching notice; recent filters by recentDays"),
    recentDays: z.number().int().min(1).max(3650).default(7),
    limit: z.number().int().min(1).max(20).default(5),
    timeoutSeconds: z.number().int().min(5).max(60).default(15),
  }),
  execute: async (context) => runPythonTool("search-jwc", context),
});

export const getJwcArticleTool = createTool({
  id: "get-seu-academic-affairs-notice",
  description:
    "Read one SEU Academic Affairs notice by the stable article id returned from search. Use this only when the full body or attachment links are needed; refresh=true validates the selected detail page.",
  inputSchema: z.object({
    baseUrl: z.string().url().default("https://jwc.seu.edu.cn"),
    cacheDir: z.string().default(".cvstream/jwc"),
    articleId: z.string().min(10),
    refresh: z.boolean().default(true),
    timeoutSeconds: z.number().int().min(5).max(60).default(15),
  }),
  execute: async (context) => runPythonTool("get-jwc-article", context),
});

export const searchCseNoticesTool = createTool({
  id: "search-seu-cse-notices",
  description:
    "Search the SEU Computer Science, Software and AI school website. It validates only semantically relevant list columns, returns matching metadata immediately, and queues detail snapshots in the background.",
  inputSchema: z.object({
    baseUrl: z.string().url().default("https://cse.seu.edu.cn"),
    cacheDir: z.string().default(".cvstream/cse"),
    query: z.string().min(1).describe("The user's original information need"),
    keywords: z.array(z.string().min(1)).min(1).max(8).optional(),
    categories: z
      .array(z.enum([
        "auto",
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
      .max(3)
      .default(["auto"]),
    freshness: z.enum(["latest", "balanced", "archive", "cache_only"]).default("balanced"),
    timeScope: z.enum(["latest", "recent", "any"]).default("any"),
    recentDays: z.number().int().min(1).max(3650).default(7),
    limit: z.number().int().min(1).max(20).default(5),
    timeoutSeconds: z.number().int().min(5).max(60).default(15),
  }),
  execute: async (context) => runPythonTool("search-cse", context),
});

export const getCseNoticeTool = createTool({
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
  execute: async (context) => runPythonTool("get-cse-article", context),
});

export const listCourseDatesTool = createTool({
  id: "list-course-dates",
  description: "List all available lecture dates from the authenticated course page.",
  inputSchema: z.object(commonPortalFields),
  execute: async (context) => runPythonTool("list-dates", context),
});

export const listCoursesTool = createTool({
  id: "list-courses",
  description: "List courses currently visible in the authenticated course replay catalog.",
  inputSchema: z.object(commonPortalFields),
  execute: async (context) => runPythonTool("list-courses", context),
});

export const searchCoursesTool = createTool({
  id: "search-courses",
  description:
    "Search the course replay catalog by course name, classroom, teacher, or course number.",
  inputSchema: z.object({
    ...commonPortalFields,
    query: z.string().min(1).describe("Course name, classroom, teacher, or course number"),
  }),
  execute: async (context) => runPythonTool("search-courses", context),
});

const courseSessionIdentity = {
  courseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
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
  id: "find-course-session",
  description:
    "Resolve a course target. Use source=schedule with a scheduleId for timetable courses; use source=manual with model-filled course name, teacher, and periods for courses outside the timetable.",
  inputSchema: z.object({
    ...commonPortalFields,
    scheduleCacheFile: z.string().default(".cvstream/schedule.json"),
    target: courseTarget,
  }),
  execute: async (context) => runPythonTool("find-course-session", context),
});

export const captureCourseSessionTool = createTool({
  id: "capture-course-session",
  description:
    "Capture every lesson segment for one target date. Timetable targets use scheduleId; courses outside the timetable use a manual target filled from the user's semantic request. Date defaults to latest.",
  inputSchema: z.object({
    ...commonPortalFields,
    scheduleCacheFile: z.string().default(".cvstream/schedule.json"),
    target: courseTarget,
    ...captureOptions,
  }),
  execute: async (context) => runPythonTool("capture-course-session", context),
});

export const captureCourseSessionsTool = createTool({
  id: "capture-course-sessions",
  description:
    "Capture a queue of course sessions. Subtitle-only work runs with up to two workers; video, ASR fallback, and slide processing are serialized to control memory use.",
  inputSchema: z.object({
    ...commonPortalFields,
    scheduleCacheFile: z.string().default(".cvstream/schedule.json"),
    targets: z.array(courseTarget).min(1),
    maxConcurrency: z.number().int().min(1).max(2).default(2),
    ...captureOptions,
  }),
  execute: async (context) => runPythonTool("capture-course-sessions", context),
});

export const captureCourseTool = createTool({
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
  execute: async (context) => runPythonTool("capture-course", context),
});

export const transcribeMediaTool = createTool({
  id: "transcribe-local-media",
  description: "Transcribe a local audio or video file with Faster Whisper.",
  inputSchema: z.object({
    mediaPath: z.string(),
    modelPath: z.string(),
    outputDir: z.string().default("exports/subtitle"),
    taskName: z.string(),
  }),
  execute: async (context) => runPythonTool("transcribe-local", context),
});

export const transcribeCloudAudioTool = createTool({
  id: "transcribe-cloud-audio",
  description: "Transcribe a local MP3 or WAV file with the configured cloud ASR service.",
  inputSchema: z.object({
    audioPath: z.string(),
    outputDir: z.string().default("exports/subtitle"),
    taskName: z.string(),
    model: z.string().default("paraformer-realtime-v2"),
  }),
  execute: async (context) => runPythonTool("transcribe-cloud", context),
});

export const extractSlidesTool = createTool({
  id: "extract-course-slides",
  description: "Detect slide changes in a lecture video and create a PDF.",
  inputSchema: z.object({
    videoPath: z.string(),
    outputDir: z.string().default("exports/media"),
    taskName: z.string(),
    intervalSec: z.number().int().min(1).max(120).default(10),
  }),
  execute: async (context) => runPythonTool("extract-slides", context),
});

export const summarizeCourseTool = createTool({
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
  execute: async (context) => runPythonTool("summarize-course", context),
});

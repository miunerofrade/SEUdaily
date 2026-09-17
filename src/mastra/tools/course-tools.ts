import { createTool } from "@mastra/core/tools";
import { z } from "zod";

import { runPythonTool } from "./python-bridge.js";

const commonPortalFields = {
  targetUrl: z.string().url().default("https://cvs.seu.edu.cn"),
  cookieFile: z.string().default("cookies.json"),
  exportDir: z.string().default("exports"),
};

export const authorizePortalTool = createTool({
  id: "authorize-course-portal",
  description:
    "Open a visible browser and establish a course-portal session. Use only when authentication is missing or expired.",
  inputSchema: z.object(commonPortalFields),
  execute: async (context) => runPythonTool("authorize", context),
});

export const listCourseDatesTool = createTool({
  id: "list-course-dates",
  description: "List all available lecture dates from the authenticated course page.",
  inputSchema: z.object(commonPortalFields),
  execute: async (context) => runPythonTool("list-dates", context),
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
    "Read a captured transcript batch and generate a structured Markdown course note with the configured DeepSeek model.",
  inputSchema: z.object({
    exportDir: z.string().default("exports"),
    courseName: z.string(),
    dateTeacher: z.string(),
    llmEngine: z.string().default("DeepSeek (api.deepseek.com)"),
    baseUrl: z.string().url().optional(),
  }),
  execute: async (context) => runPythonTool("summarize-course", context),
});

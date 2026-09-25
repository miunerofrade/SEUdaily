import { registerApiRoute } from "@mastra/core/server";
import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";

import { projectRoot } from "./runtime-paths.js";
import { runPythonTool } from "./tools/python-bridge.js";
import type { ToolResult } from "./tools/tool-result.js";
import { courseAgentMemory, mastraStorage } from "./storage.js";
import { runCourseFocusQueue, runFocusAgentCycle, sendFocusAgentMessage, type FocusAgentItem } from "./focus-runtime.js";
import { isFullAccessEnabled, setFullAccessEnabled } from "./permission-state.js";
import { storeDocumentContext } from "./document-context.js";
import { activateActionRequest } from "./action-request-store.js";

const FOCUS_RESOURCE_ID = "seudaily-focus-local";

const editableEnvironment = [
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_MODEL",
  "TAVILY_API_KEY",
  "CVSTREAM_USERNAME",
  "CVSTREAM_PASSWORD",
  "CVSTREAM_ASR_API_KEY",
  "CVSTREAM_WHISPER_MODEL",
  "CVSTREAM_FULL_ACCESS",
] as const;

const secretEnvironment = new Set(["DEEPSEEK_API_KEY", "TAVILY_API_KEY", "CVSTREAM_PASSWORD", "CVSTREAM_ASR_API_KEY"]);
const agentInstructionsPath = resolve(projectRoot, "AGENTS.md");
const supportedDocumentExtensions = new Set([".pdf", ".docx", ".xlsx", ".pptx"]);
const documentMediaTypes: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

const titleGenerationTasks = new Map<string, Promise<{ title: string; generated: boolean; reason?: string }>>();

function compactTitleInput(value: unknown) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 600) : "";
}

function cleanGeneratedTitle(value: unknown) {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\r\n]+/g, " ")
    .replace(/^[\s“”‘’"'《》【】]+|[\s“”‘’"'《》【】。！？!?，,：:；;]+$/g, "")
    .replace(/\.(pdf|docx|xlsx|pptx)(?=\s|$)/ig, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
}

function fallbackConversationTitle(titleInput: string) {
  const withoutExtension = titleInput.replace(/\.(pdf|docx|xlsx|pptx)$/i, "");
  const cleaned = cleanGeneratedTitle(withoutExtension);
  return cleaned.length > 24 ? cleaned.slice(0, 24) : cleaned || "新对话";
}

async function requestConversationTitle(titleInput: string) {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) throw new Error("未配置 DEEPSEEK_API_KEY");
  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.DEEPSEEK_MODEL?.trim() || "deepseek-flash",
      messages: [
        {
          role: "system",
          content: "你是对话标题生成器。根据用户请求或附件文件名生成一个可辨识的短标题。跟随用户语言；中文通常6到14字，英文通常3到8词；不要保留 PDF、DOCX、XLSX、PPTX 扩展名，不要引号、句号、emoji或‘关于/讨论’等套话。只返回合法 JSON，格式为 {\"title\":\"标题\"}。",
        },
        { role: "user", content: titleInput },
      ],
      thinking: { type: "disabled" },
      response_format: { type: "json_object" },
      temperature: 0.2,
      max_tokens: 160,
      stream: false,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`DeepSeek 标题生成失败（${response.status}）`);
  const result = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = result.choices?.[0]?.message?.content;
  if (!content) return fallbackConversationTitle(titleInput);
  let parsedTitle: unknown;
  try {
    parsedTitle = (JSON.parse(content) as { title?: unknown }).title;
  } catch {
    return fallbackConversationTitle(titleInput);
  }
  const title = cleanGeneratedTitle(parsedTitle);
  if (!title) throw new Error("DeepSeek 返回了空标题");
  return title;
}

async function generateFirstTurnTitle(input: { threadId: string; resourceId: string; titleInput: string }) {
  const memoryStore = await mastraStorage.getStore("memory");
  if (!memoryStore) throw new Error("会话存储不可用");
  const thread = await memoryStore.getThreadById({ threadId: input.threadId, resourceId: input.resourceId });
  if (!thread) return { title: "", generated: false, reason: "thread-not-found" };
  if (typeof thread.metadata?.titleGeneratedAt === "string") {
    return { title: thread.title?.trim() ?? "", generated: false, reason: "already-generated" };
  }
  const history = await memoryStore.listMessages({
    threadId: input.threadId,
    resourceId: input.resourceId,
    perPage: 20,
    includeTotal: false,
  });
  const userMessageCount = history.messages.filter((message) => message.role === "user").length;
  if (userMessageCount !== 1) {
    return { title: thread.title?.trim() ?? "", generated: false, reason: "not-first-turn" };
  }
  await memoryStore.patchThread({
    id: input.threadId,
    metadata: {
      ...thread.metadata,
      titleGenerationAttempted: true,
      titleGenerationAttemptedAt: new Date().toISOString(),
    },
  });
  let title: string;
  try {
    title = await requestConversationTitle(input.titleInput);
  } catch (error) {
    await memoryStore.patchThread({
      id: input.threadId,
      metadata: {
        ...thread.metadata,
        titleGenerationAttempted: true,
        titleGenerationError: error instanceof Error ? error.message : "标题生成失败",
      },
    });
    throw error;
  }
  await memoryStore.patchThread({
    id: input.threadId,
    title,
    metadata: {
      ...thread.metadata,
      titleGenerationAttempted: true,
      titleGeneratedAt: new Date().toISOString(),
    },
  });
  return { title, generated: true };
}

async function readAgentInstructions() {
  try {
    return await readFile(agentInstructionsPath, "utf8");
  } catch {
    return "";
  }
}

function resultResponse(result: ToolResult) {
  return {
    status: result.status,
    summary: result.summary,
    data: result.data,
    warnings: result.warnings,
  };
}

async function fullResultData(result: ToolResult): Promise<unknown> {
  if (!result.resultRef) return result.data;
  try {
    const full = JSON.parse(await readFile(result.resultRef, "utf8")) as { data?: unknown };
    return full.data ?? result.data;
  } catch {
    return result.data;
  }
}

type LibraryFile = { path: string; relativePath: string; name: string; size: number; updatedAt: string; type: string; category: string; course: string; teacher: string };

const libraryRoots = [resolve(projectRoot, "exports"), resolve(projectRoot, ".cvstream", "uploads", "images")];

function safeLibraryTarget(path: string) {
  const target = resolve(path);
  const allowed = libraryRoots.some((root) => {
    const child = relative(root, target);
    return Boolean(child) && !child.startsWith("..") && !isAbsolute(child);
  });
  return allowed ? target : null;
}

function previewContentType(path: string) {
  const extension = extname(path).toLowerCase();
  return ({
    ".md": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".pdf": "application/pdf",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
    ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav", ".mp4": "video/mp4", ".webm": "video/webm",
    ".ppt": "application/vnd.ms-powerpoint", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  } as Record<string, string>)[extension] ?? "application/octet-stream";
}

function libraryIdentity(root: string, path: string) {
  const relativePath = relative(root, path);
  const segments = relativePath.split(/[\\/]/);
  const category = segments[0] || "other";
  const course = segments[1] || "未分类";
  const datedOwner = segments.find((segment) => /^\d{8}-.+/.test(segment));
  const teacher = datedOwner?.replace(/^\d{8}-/, "").replace(/_Summary(?:\.[^.]+)?$/i, "") || "教师未标注";
  return { relativePath, category, course, teacher };
}

async function walkFiles(root: string, directory = root, output: LibraryFile[] = [], seen = new Set<string>()) {
  if (output.length >= 1000) return output;
  const resolvedDirectory = await realpath(directory).catch(() => directory);
  if (seen.has(resolvedDirectory)) return output;
  seen.add(resolvedDirectory);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return output;
  }
  for (const entry of entries) {
    if (output.length >= 1000 || entry.name.startsWith(".")) continue;
    const fullPath = resolve(directory, entry.name);
    const details = await stat(fullPath).catch(() => null);
    if (!details) continue;
    if (details.isDirectory()) {
      await walkFiles(root, fullPath, output, seen);
      continue;
    }
    const extension = extname(entry.name).toLowerCase();
    if (![".md", ".txt", ".pdf", ".ppt", ".pptx", ".mp3", ".m4a", ".wav", ".mp4", ".webm", ".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(extension)) continue;
    output.push({
      path: fullPath,
      ...libraryIdentity(root, fullPath),
      name: entry.name,
      size: details.size,
      updatedAt: details.mtime.toISOString(),
      type: extension.slice(1).toUpperCase(),
    });
  }
  return output;
}

function parseEnv(content: string) {
  const values: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}

async function readEnvFile() {
  try {
    return await readFile(resolve(projectRoot, ".env"), "utf8");
  } catch {
    return "";
  }
}

function encodeEnvValue(value: string) {
  return /^[A-Za-z0-9_./:@-]*$/.test(value) ? value : JSON.stringify(value);
}

async function updateEnvFile(updates: Record<string, string>) {
  const target = resolve(projectRoot, ".env");
  let content = await readEnvFile();
  for (const [key, value] of Object.entries(updates)) {
    const line = `${key}=${encodeEnvValue(value)}`;
    const pattern = new RegExp(`^\\s*${key}\\s*=.*$`, "m");
    content = pattern.test(content) ? content.replace(pattern, line) : `${content.trimEnd()}${content.trim() ? "\n" : ""}${line}\n`;
    process.env[key] = value;
  }
  const temporary = `${target}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, target);
}

export const appRoutes = [
  registerApiRoute("/app/conversations/title", {
    method: "POST",
    requiresAuth: false,
    handler: async (c: any) => {
      const body = await c.req.json() as Record<string, unknown>;
      const threadId = compactTitleInput(body.threadId);
      const resourceId = compactTitleInput(body.resourceId);
      const titleInput = compactTitleInput(body.titleInput);
      if (!threadId || !resourceId || !titleInput) {
        return c.json({ error: "缺少生成标题所需的信息" }, 400);
      }
      const taskKey = `${resourceId}:${threadId}`;
      const running = titleGenerationTasks.get(taskKey);
      if (running) return c.json(await running);
      const task = generateFirstTurnTitle({ threadId, resourceId, titleInput })
        .finally(() => titleGenerationTasks.delete(taskKey));
      titleGenerationTasks.set(taskKey, task);
      try {
        return c.json(await task);
      } catch (error) {
        return c.json({
          title: "",
          generated: false,
          reason: "generation-failed",
          error: error instanceof Error ? error.message : "标题生成失败",
        }, 502);
      }
    },
  }),
  registerApiRoute("/app/schedule", {
    method: "GET",
    requiresAuth: false,
    handler: async (c: any) => {
      const refresh = c.req.query("refresh") === "true";
      const semester = c.req.query("semester")?.trim();
      const includeAvailableSemesters = c.req.query("includeSemesters") === "true";
      const prefetchAvailableSemesters = c.req.query("prefetchSemesters") === "true";
      const result = await runPythonTool<ToolResult>("get-schedule", {
        refresh,
        includeAvailableSemesters,
        prefetchAvailableSemesters,
        ...(semester ? { semester } : {}),
      });
      const data = await fullResultData(result);
      return c.json({ ...resultResponse(result), data });
    },
  }),
  registerApiRoute("/app/action-requests/:id/activate", {
    method: "POST",
    requiresAuth: false,
    handler: async (c: any) => {
      try {
        const actionRequest = await activateActionRequest(c.req.param("id"));
        return c.json({ status: "completed", actionRequest });
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : "操作请求激活失败" }, 409);
      }
    },
  }),
  registerApiRoute("/app/schedule", {
    method: "PUT",
    requiresAuth: false,
    handler: async (c: any) => {
      const body = await c.req.json() as Record<string, unknown>;
      await runPythonTool<ToolResult>("save-schedule-customizations", body);
      const result = await runPythonTool<ToolResult>("get-schedule", { refresh: false });
      const data = await fullResultData(result);
      return c.json({ ...resultResponse(result), data });
    },
  }),
  registerApiRoute("/app/focus", {
    method: "GET",
    requiresAuth: false,
    handler: async (c: any) => {
      const result = await runPythonTool<ToolResult>("list-focus", {});
      return c.json({ ...resultResponse(result), data: await fullResultData(result) });
    },
  }),
  registerApiRoute("/app/focus", {
    method: "POST",
    requiresAuth: false,
    handler: async (c: any) => {
      const body = await c.req.json() as Record<string, unknown>;
      const creating = typeof body.id !== "string" || !body.id;
      const focusId = creating ? `focus-${randomUUID()}` : String(body.id);
      const item = {
        ...body,
        id: focusId,
        threadId: typeof body.threadId === "string" && body.threadId ? body.threadId : focusId,
        resourceId: typeof body.resourceId === "string" && body.resourceId ? body.resourceId : FOCUS_RESOURCE_ID,
      };
      const result = await runPythonTool<ToolResult>("upsert-focus", { item });
      const data = await fullResultData(result) as { item?: FocusAgentItem };
      return c.json({ ...resultResponse(result), data });
    },
  }),
  registerApiRoute("/app/focus/:id", {
    method: "DELETE",
    requiresAuth: false,
    handler: async (c: any) => {
      const focusId = c.req.param("id");
      const listed = await runPythonTool<ToolResult>("list-focus", {});
      const listData = await fullResultData(listed) as { items?: FocusAgentItem[] };
      const focus = listData.items?.find((item) => item.id === focusId);
      const result = await runPythonTool<ToolResult>("delete-focus", { focusId });
      if (focus?.threadId) await courseAgentMemory.deleteThread(focus.threadId).catch(() => undefined);
      return c.json(resultResponse(result));
    },
  }),
  registerApiRoute("/app/focus/run", {
    method: "POST",
    requiresAuth: false,
    handler: async (c: any) => {
      const courseQueue = await runCourseFocusQueue();
      await runFocusAgentCycle({ force: true });
      return c.json({
        status: "completed",
        summary: "关注检查已完成；课程任务仅在到达队列执行时间后运行。",
        data: { courseQueue },
      });
    },
  }),
  registerApiRoute("/app/focus/:id/run/claim", {
    method: "POST",
    requiresAuth: false,
    handler: async (c: any) => {
      const body = await c.req.json().catch(() => ({})) as { force?: unknown; respectInterval?: unknown };
      const result = await runPythonTool<ToolResult>("claim-focus-agent-run", {
        focusId: c.req.param("id"),
        force: body.force === true,
        respectInterval: body.respectInterval !== false,
      });
      return c.json({ ...resultResponse(result), data: await fullResultData(result) });
    },
  }),
  registerApiRoute("/app/focus/:id/run/record", {
    method: "POST",
    requiresAuth: false,
    handler: async (c: any) => {
      const body = await c.req.json() as { runId?: unknown; status?: unknown; message?: unknown };
      const runId = typeof body.runId === "string" ? body.runId : "";
      if (!runId) return c.json({ error: "runId 不能为空" }, 400);
      const result = await runPythonTool<ToolResult>("record-focus-agent-run", {
        focusId: c.req.param("id"),
        runId,
        runStatus: body.status === "failed" ? "failed" : "completed",
        message: typeof body.message === "string" ? body.message : "",
      });
      return c.json({ ...resultResponse(result), data: await fullResultData(result) });
    },
  }),
  registerApiRoute("/app/focus/:id/message", {
    method: "POST",
    requiresAuth: false,
    handler: async (c: any) => {
      const body = await c.req.json() as { message?: unknown };
      const message = typeof body.message === "string" ? body.message.trim() : "";
      if (!message) return c.json({ error: "消息不能为空" }, 400);
      const listed = await runPythonTool<ToolResult>("list-focus", {});
      const data = await fullResultData(listed) as { items?: FocusAgentItem[] };
      const focus = data.items?.find((item) => item.id === c.req.param("id"));
      if (!focus) return c.json({ error: "Focus 不存在" }, 404);
      const text = await sendFocusAgentMessage(focus, message);
      return c.json({ status: "completed", data: { text } });
    },
  }),
  registerApiRoute("/app/focus/courses/search", {
    method: "GET",
    requiresAuth: false,
    handler: async (c: any) => {
      const query = c.req.query("q")?.trim();
      if (!query) return c.json({ error: "请输入课程名称、教师或课程号" }, 400);
      const semester = c.req.query("semester")?.trim();
      const result = await runPythonTool<ToolResult>("search-courses", {
        query,
        ...(semester ? { semester } : {}),
      });
      return c.json({ ...resultResponse(result), data: await fullResultData(result) });
    },
  }),
  registerApiRoute("/app/programs", {
    method: "GET",
    requiresAuth: false,
    handler: async (c: any) => {
      const result = await runPythonTool<ToolResult>("get-training-plan", {
        refresh: c.req.query("refresh") === "true",
      });
      return c.json({ ...resultResponse(result), data: await fullResultData(result) });
    },
  }),
  registerApiRoute("/app/programs/course-status", {
    method: "PATCH",
    requiresAuth: false,
    handler: async (c: any) => {
      const body = await c.req.json() as { planId?: unknown; courseId?: unknown; semester?: unknown; status?: unknown };
      const result = await runPythonTool<ToolResult>("save-training-plan-course-override", {
        planId: typeof body.planId === "string" ? body.planId : "",
        courseId: typeof body.courseId === "string" ? body.courseId : "",
        semester: typeof body.semester === "string" ? body.semester : "",
        status: typeof body.status === "string" ? body.status : "auto",
      });
      return c.json({ ...resultResponse(result), data: await fullResultData(result) });
    },
  }),
  registerApiRoute("/app/schedule/authorize", {
    method: "POST",
    requiresAuth: false,
    handler: async (c: any) => {
      const result = await runPythonTool<ToolResult>("authorize-schedule", { timeoutSeconds: 300, resetSession: true });
      return c.json(resultResponse(result));
    },
  }),
  registerApiRoute("/app/library", {
    method: "GET",
    requiresAuth: false,
    handler: async (c: any) => {
      const root = resolve(projectRoot, "exports");
      const files = await walkFiles(root);
      const imageRoot = resolve(projectRoot, ".cvstream", "uploads", "images");
      const images = await walkFiles(imageRoot);
      files.push(...images.map((file) => ({ ...file, category: "images", course: "临时图片", teacher: "本地上传" })));
      files.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return c.json({ root, files, count: files.length });
    },
  }),
  registerApiRoute("/app/library/preview", {
    method: "GET",
    requiresAuth: false,
    handler: async (c: any) => {
      const requested = c.req.query("path");
      if (!requested) return c.json({ error: "缺少文件路径" }, 400);
      const target = safeLibraryTarget(requested);
      if (!target) return c.json({ error: "只能预览资料库内的文件" }, 403);
      const details = await stat(target).catch(() => null);
      if (!details?.isFile()) return c.json({ error: "文件不存在" }, 404);
      if (details.size > 50 * 1024 * 1024) return c.json({ error: "文件超过 50 MB，无法在线预览" }, 413);
      const bytes = await readFile(target);
      return new Response(new Uint8Array(bytes), { headers: { "Content-Type": previewContentType(target), "Content-Disposition": "inline", "Cache-Control": "private, max-age=60", "X-Content-Type-Options": "nosniff" } });
    },
  }),
  registerApiRoute("/app/library", {
    method: "DELETE",
    requiresAuth: false,
    handler: async (c: any) => {
      const body = await c.req.json() as { path?: unknown };
      if (typeof body.path !== "string") return c.json({ error: "缺少文件路径" }, 400);
      const target = safeLibraryTarget(body.path);
      if (!target) return c.json({ error: "只能删除资料库内的文件" }, 403);
      await unlink(target);
      return c.json({ deleted: true, path: target });
    },
  }),
  registerApiRoute("/app/images", {
    method: "POST",
    requiresAuth: false,
    handler: async (c: any) => {
      const body = await c.req.json() as { dataUrl?: unknown; name?: unknown };
      if (typeof body.dataUrl !== "string") return c.json({ error: "缺少图片数据" }, 400);
      const match = body.dataUrl.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/);
      if (!match) return c.json({ error: "仅支持 PNG、JPEG、WebP 或 GIF 图片" }, 400);
      const bytes = Buffer.from(match[2], "base64");
      if (!bytes.length || bytes.length > 10 * 1024 * 1024) return c.json({ error: "图片大小必须在 10 MB 以内" }, 400);
      const extension = match[1] === "image/jpeg" ? "jpg" : match[1].slice(6);
      const directory = resolve(projectRoot, ".cvstream", "uploads", "images");
      await mkdir(directory, { recursive: true });
      const target = resolve(directory, `${Date.now()}-${randomUUID()}.${extension}`);
      await writeFile(target, bytes);
      return c.json({ path: target, ref: basename(target), sha256: createHash("sha256").update(bytes).digest("hex"), name: typeof body.name === "string" ? body.name : `image.${extension}`, mediaType: match[1], size: bytes.length });
    },
  }),
  registerApiRoute("/app/documents", {
    method: "POST",
    requiresAuth: false,
    handler: async (c: any) => {
      const body = await c.req.parseBody();
      const upload = body?.file;
      if (!(upload instanceof File)) return c.json({ error: "缺少文档文件" }, 400);
      const filename = upload.name || "document";
      const extension = extname(filename).toLowerCase();
      if (!supportedDocumentExtensions.has(extension)) {
        return c.json({ error: "仅支持 PDF、DOCX、XLSX、PPTX；不支持旧版 DOC、XLS、PPT" }, 400);
      }
      if (upload.size <= 0 || upload.size > 50 * 1024 * 1024) {
        return c.json({ error: "文档大小必须在 50 MB 以内" }, 413);
      }

      const bytes = Buffer.from(await upload.arrayBuffer());
      const validSignature = extension === ".pdf"
        ? bytes.subarray(0, 5).toString("ascii") === "%PDF-"
        : bytes[0] === 0x50 && bytes[1] === 0x4b;
      if (!validSignature) return c.json({ error: "文件内容与扩展名不匹配或文件已损坏" }, 400);

      const temporaryDirectory = await mkdtemp(join(tmpdir(), "cvstream-document-"));
      const temporaryPath = join(temporaryDirectory, `${randomUUID()}${extension}`);
      try {
        await writeFile(temporaryPath, bytes);
        let result: ToolResult;
        try {
          result = await runPythonTool<ToolResult>("parse-document", { path: temporaryPath, filename });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return c.json({ error: `文档解析失败：${message}` }, 422);
        }
        const data = await fullResultData(result) as { filename?: string; extension?: string; markdown?: string; charCount?: number } | undefined;
        if (result.status !== "completed" || !data?.markdown) {
          return c.json({ error: result.summary || "文档解析失败", warnings: result.warnings }, 422);
        }
        const contextRef = randomUUID();
        storeDocumentContext(contextRef, data.filename || filename, data.markdown);
        return c.json({
          filename: data.filename || filename,
          extension: data.extension || extension,
          mediaType: documentMediaTypes[extension],
          contextRef,
          markdown: data.markdown,
          charCount: data.charCount ?? data.markdown.length,
        });
      } finally {
        await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  }),
  registerApiRoute("/app/images/resolve", {
    method: "GET",
    requiresAuth: false,
    handler: async (c: any) => {
      const imageRoot = resolve(projectRoot, ".cvstream", "uploads", "images");
      const ref = c.req.query("ref");
      const sha256 = c.req.query("sha256")?.toLowerCase();
      if (ref) {
        if (basename(ref) !== ref) return c.json({ error: "图片引用无效" }, 400);
        const target = resolve(imageRoot, ref);
        const details = await stat(target).catch(() => null);
        if (!details?.isFile()) return c.json({ error: "图片已被删除" }, 404);
        return c.json({ path: target, ref, mediaType: previewContentType(target) });
      }
      if (!sha256 || !/^[a-f0-9]{64}$/.test(sha256)) return c.json({ error: "缺少图片引用" }, 400);
      const entries = await readdir(imageRoot, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const target = resolve(imageRoot, entry.name);
        const bytes = await readFile(target).catch(() => null);
        if (bytes && createHash("sha256").update(bytes).digest("hex") === sha256) return c.json({ path: target, ref: entry.name, mediaType: previewContentType(target) });
      }
      return c.json({ error: "图片已被删除" }, 404);
    },
  }),
  registerApiRoute("/app/notices", {
    method: "GET",
    requiresAuth: false,
    handler: async (c: any) => {
      const refresh = c.req.query("refresh") !== "false";
      const result = await runPythonTool<ToolResult>("list-jwc", {
        categories: ["news", "academic", "lectures"],
        freshness: refresh ? "latest" : "cache_only",
        timeScope: "any",
        limit: 20,
      });
      return c.json(resultResponse(result));
    },
  }),
  registerApiRoute("/app/settings", {
    method: "GET",
    requiresAuth: false,
    handler: async (c: any) => {
      const values = parseEnv(await readEnvFile());
      return c.json({
        provider: { name: "DeepSeek", baseUrl: "https://api.deepseek.com", editable: false },
        agentInstructions: await readAgentInstructions(),
        fields: editableEnvironment.map((name) => ({
          name,
          secret: secretEnvironment.has(name),
          configured: Boolean(values[name] || process.env[name]),
          value: secretEnvironment.has(name)
            ? ""
            : name === "CVSTREAM_FULL_ACCESS"
              ? String(isFullAccessEnabled())
              : (values[name] ?? process.env[name] ?? ""),
        })),
      });
    },
  }),
  registerApiRoute("/app/settings", {
    method: "POST",
    requiresAuth: false,
    handler: async (c: any) => {
      const body = await c.req.json() as { values?: Record<string, unknown>; agentInstructions?: unknown };
      const values: Record<string, string> = {};
      for (const name of editableEnvironment) {
        const value = body.values?.[name];
        if (typeof value === "string" && value.trim()) values[name] = value.trim();
      }
      if (Object.hasOwn(values, "CVSTREAM_FULL_ACCESS")) {
        setFullAccessEnabled(values.CVSTREAM_FULL_ACCESS === "true" || values.CVSTREAM_FULL_ACCESS === "1" || values.CVSTREAM_FULL_ACCESS === "yes" || values.CVSTREAM_FULL_ACCESS === "on");
      }
      await updateEnvFile(values);
      const agentInstructionsSaved = typeof body.agentInstructions === "string";
      if (agentInstructionsSaved) await writeFile(agentInstructionsPath, body.agentInstructions as string, "utf8");
      const restartRequired = Object.keys(values).some((name) => name !== "CVSTREAM_FULL_ACCESS");
      return c.json({ saved: Object.keys(values), agentInstructionsSaved, restartRequired });
    },
  }),
];

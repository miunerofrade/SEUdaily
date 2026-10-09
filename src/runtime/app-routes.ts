import { requireNoticeSource } from "../shared/notice-sources.js";
import { webLibraryEntries } from "./web-library.js";
import { redactText } from "../agent/redaction.js";
import {
  parseEnv,
  readEnvFile,
  updateEnvFile,
} from "./environment-settings.js";
import { existsSync } from "node:fs";
import { diskSize } from "../shared/disk-size.js";
import { z } from "zod";
import { registerApiRoute } from "../server/routes.js";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import {
  basename,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { tmpdir } from "node:os";

import {
  envValue,
  projectRoot,
  agentInstructionsPath,
} from "./runtime-paths.js";
import { runPythonTool } from "./tools/python-bridge.js";
import type { ToolResult } from "./tools/tool-result.js";
import { agentStore } from "./storage.js";
import { agentRuntime } from "./application.js";
import {
  runCourseFocusQueue,
  runFocusAgentCycle,
  sendFocusAgentMessage,
  startFocusRuntime,
  type FocusAgentItem,
} from "./focus-runtime.js";
import {
  isFullAccessEnabled,
  isFullAccessExtraEnabled,
  setFullAccessEnabled,
  setFullAccessExtraEnabled,
} from "./permission-state.js";
import {
  storeDocumentContext,
  resolveDocumentContexts,
} from "./document-context.js";
import {
  activateActionRequest,
  claimActionRequest,
  completeActionRequest,
  failActionRequest,
} from "./action-request-store.js";
import {
  localActionExecutionPayload,
  localActionProposalSchema,
  localOperations,
} from "./local-action-schema.js";
import { executeAuthResume } from "./auth-resume-store.js";

const FOCUS_RESOURCE_ID = "seudaily-focus-local";

const editableEnvironment = [
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_MODEL",
  "TAVILY_API_KEY",
  "DASHSCOPE_API_KEY",
  "SEUDAILY_EMBEDDING_MODEL",
  "SEUDAILY_RERANK_MODEL",
  "SEUDAILY_EMBEDDING_BASE_URL",
  "SEUDAILY_VPN_BINARY",
  "SEUDAILY_VPN_DNS_SERVER",
  "SEUDAILY_USERNAME",
  "SEUDAILY_PASSWORD",
  "SEUDAILY_ASR_API_KEY",
  "SEUDAILY_WHISPER_MODEL",
  "SEUDAILY_FULL_ACCESS",
  "SEUDAILY_FULL_ACCESS_EXTRA",
] as const;

const secretEnvironment = new Set([
  "DASHSCOPE_API_KEY",
  "DEEPSEEK_API_KEY",
  "TAVILY_API_KEY",
  "SEUDAILY_PASSWORD",
  "SEUDAILY_ASR_API_KEY",
]);
import {
  documentExtensions as supportedDocumentExtensions,
  documentMediaTypes,
} from "../shared/document-formats.js";

import {
  titleGenerationTasks,
  compactTitleInput,
  generateFirstTurnTitle,
} from "./conversation-title.js";

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
    const full = JSON.parse(await readFile(result.resultRef, "utf8")) as {
      data?: unknown;
    };
    return full.data ?? result.data;
  } catch {
    return result.data;
  }
}

import {
  safeLibraryTarget,
  previewContentType,
  walkFiles,
  isWithinDirectory,
} from "./library-files.js";
export { safeLibraryTarget } from "./library-files.js";

function legacyEnvironmentName(name: string) {
  return name.startsWith("SEUDAILY_")
    ? `CVSTREAM_${name.slice("SEUDAILY_".length)}`
    : undefined;
}

export const appRoutes = [
  registerApiRoute("/app/runtime/preparation", {
    method: "GET",
    handler: async (c: any) =>
      c.json(
        (await import("../distribution/components.js")).preparationStatus(),
      ),
  }),
  registerApiRoute("/app/vpn", {
    method: "GET",
    handler: async (c: any) => {
      const result = await runPythonTool<ToolResult>("vpn-status", {});
      return c.json(await fullResultData(result));
    },
  }),
  registerApiRoute("/app/vpn", {
    method: "POST",
    handler: async (c: any) => {
      const input = z
        .object({
          action: z.enum(["connect", "disconnect", "verify", "resend"]),
          code: z.string().max(16).optional(),
          port: z.number().int().min(1024).max(65535).optional(),
        })
        .strict()
        .parse(await c.req.json());
      const result = await runPythonTool<ToolResult>(`vpn-${input.action}`, {
        code: input.code,
        port: input.port,
      });
      return c.json({
        ...resultResponse(result),
        data: await fullResultData(result),
      });
    },
  }),
  registerApiRoute("/app/auth/sms", {
    method: "POST",
    handler: async (c: any) => {
      const input = z
        .object({
          challengeId: z.string().regex(/^[a-f0-9]{32}$/),
          operation: z.enum(["send", "verify"]),
          code: z.string().max(16).optional(),
        })
        .strict()
        .parse(await c.req.json());
      const result = await runPythonTool<ToolResult>("campus-sms", input);
      return c.json({
        ...resultResponse(result),
        data: await fullResultData(result),
      });
    },
  }),
  registerApiRoute("/app/ramdisk/reveal", {
    method: "POST",
    handler: async (c: any) => {
      const result = await runPythonTool<ToolResult>("reveal-ramdisk", {});
      return c.json(resultResponse(result));
    },
  }),
  registerApiRoute("/app/ramdisk", {
    method: "GET",
    handler: async (c: any) => {
      const result = await runPythonTool<ToolResult>("ramdisk-status", {});
      return c.json(await fullResultData(result));
    },
  }),
  registerApiRoute("/app/ramdisk", {
    method: "POST",
    handler: async (c: any) => {
      const input = z
        .object({
          action: z.enum(["mount", "unmount"]),
          size: z
            .string()
            .default("1G")
            .transform((value) => diskSize(value)),
        })
        .strict()
        .parse(await c.req.json());
      const result = await runPythonTool<ToolResult>(
        input.action === "mount" ? "mount-ramdisk" : "unmount-ramdisk",
        { size: input.size },
      );
      return c.json({
        ...resultResponse(result),
        data: await fullResultData(result),
      });
    },
  }),
  registerApiRoute("/app/conversations/title", {
    method: "POST",
    requiresAuth: false,
    handler: async (c: any) => {
      const body = (await c.req.json()) as Record<string, unknown>;
      const threadId = compactTitleInput(body.threadId);
      const resourceId = compactTitleInput(body.resourceId);
      const titleInput = compactTitleInput(body.titleInput);
      if (!threadId || !resourceId || !titleInput) {
        return c.json({ error: "缺少生成标题所需的信息" }, 400);
      }
      const taskKey = `${resourceId}:${threadId}`;
      const running = titleGenerationTasks.get(taskKey);
      if (running) return c.json(await running);
      const task = generateFirstTurnTitle({
        threadId,
        resourceId,
        titleInput,
      }).finally(() => titleGenerationTasks.delete(taskKey));
      titleGenerationTasks.set(taskKey, task);
      try {
        return c.json(await task);
      } catch (error) {
        return c.json(
          {
            title: "",
            generated: false,
            reason: "generation-failed",
            error: error instanceof Error ? error.message : "标题生成失败",
          },
          502,
        );
      }
    },
  }),
  registerApiRoute("/app/schedule", {
    method: "GET",
    requiresAuth: false,
    handler: async (c: any) => {
      const refresh = c.req.query("refresh") === "true";
      const semester = c.req.query("semester")?.trim();
      const includeAvailableSemesters =
        c.req.query("includeSemesters") === "true";
      const prefetchAvailableSemesters =
        c.req.query("prefetchSemesters") !== "false";
      const result = await runPythonTool<ToolResult>("get-schedule", {
        refresh,
        localOnly: c.req.query("localOnly") === "true",
        ...(c.req.query("date") ? { date: c.req.query("date") } : {}),
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
        return c.json(
          {
            error: error instanceof Error ? error.message : "操作请求激活失败",
          },
          409,
        );
      }
    },
  }),
  registerApiRoute("/app/action-requests/:id/execute", {
    method: "POST",
    requiresAuth: false,
    handler: async (c: any) => {
      let claimed: Awaited<ReturnType<typeof claimActionRequest>> | undefined;
      try {
        claimed = await claimActionRequest(c.req.param("id"));
        if (claimed.state === "consumed")
          return c.json(
            claimed.request.result ?? {
              status: "completed",
              summary: "操作已执行",
            },
          );
        if (claimed.state === "executing")
          return c.json({ error: "操作正在执行，请勿重复提交" }, 409);
        const data = claimed.request.payload as Record<string, unknown>;
        const proposal = localActionProposalSchema.parse({
          kind: data.kind,
          ...(data.kind === "create_focus"
            ? { focus: data.payload }
            : { schedule: Object.fromEntries(Object.entries(data.payload as Record<string, unknown>).filter(([key]) => key !== "operation")) }),
        });
        const payload = localActionExecutionPayload(proposal) as Record<
          string,
          unknown
        >;
        let result: ToolResult;
        if (proposal.kind === "create_focus") {
          const id = `focus-${randomUUID()}`;
          result = await runPythonTool<ToolResult>(localOperations[proposal.kind].action, {
            item: {
              ...payload,
              id,
              threadId: id,
              resourceId: FOCUS_RESOURCE_ID,
              enabled: true,
            },
          });
          if (result.status === "completed") startFocusRuntime();
        } else
          result = await runPythonTool<ToolResult>(
            localOperations[proposal.kind].action,
            payload,
          );
        if (result.status === "failed" || result.status === "cancelled") {
          const error = new Error(result.summary || "本地操作执行失败");
          await failActionRequest(
            claimed.request.id,
            claimed.request.attemptId!,
            error,
          );
          return c.json(
            { ...resultResponse(result), data: await fullResultData(result) },
            422,
          );
        }
        const response = {
          ...resultResponse(result),
          data: await fullResultData(result),
        };
        await completeActionRequest(
          claimed.request.id,
          claimed.request.attemptId!,
          response,
        );
        return c.json(response, 200);
      } catch (error) {
        if (claimed?.state === "claimed")
          await failActionRequest(
            claimed.request.id,
            claimed.request.attemptId!,
            error,
          );
        return c.json(
          {
            error: error instanceof Error ? error.message : "本地操作执行失败",
          },
          409,
        );
      }
    },
  }),
  registerApiRoute("/app/schedule", {
    method: "PUT",
    requiresAuth: false,
    handler: async (c: any) => {
      const body = (await c.req.json()) as Record<string, unknown>;
      await runPythonTool<ToolResult>("save-schedule-customizations", body);
      const result = await runPythonTool<ToolResult>("get-schedule", {
        refresh: false,
      });
      const data = await fullResultData(result);
      return c.json({ ...resultResponse(result), data });
    },
  }),
  registerApiRoute("/app/focus", {
    method: "GET",
    requiresAuth: false,
    handler: async (c: any) => {
      if (!existsSync(resolve(projectRoot, ".seudaily", "focus.json")))
        return c.json({ status: "completed", data: { items: [] } });
      const result = await runPythonTool<ToolResult>("list-focus", {});
      return c.json({
        ...resultResponse(result),
        data: await fullResultData(result),
      });
    },
  }),
  registerApiRoute("/app/focus", {
    method: "POST",
    requiresAuth: false,
    handler: async (c: any) => {
      const body = (await c.req.json()) as Record<string, unknown>;
      const creating = typeof body.id !== "string" || !body.id;
      const focusId = creating ? `focus-${randomUUID()}` : String(body.id);
      const item = {
        ...body,
        id: focusId,
        threadId:
          typeof body.threadId === "string" && body.threadId
            ? body.threadId
            : focusId,
        resourceId:
          typeof body.resourceId === "string" && body.resourceId
            ? body.resourceId
            : FOCUS_RESOURCE_ID,
      };
      const result = await runPythonTool<ToolResult>("upsert-focus", { item });
      if (result.status === "completed") startFocusRuntime();
      const data = (await fullResultData(result)) as { item?: FocusAgentItem };
      return c.json({ ...resultResponse(result), data });
    },
  }),
  registerApiRoute("/app/focus/:id", {
    method: "DELETE",
    requiresAuth: false,
    handler: async (c: any) => {
      const focusId = c.req.param("id");
      const listed = await runPythonTool<ToolResult>("list-focus", {});
      const listData = (await fullResultData(listed)) as {
        items?: FocusAgentItem[];
      };
      const focus = listData.items?.find((item) => item.id === focusId);
      if (focus?.threadId && agentRuntime.isActive(focus.threadId))
        return c.json(
          { error: "当前关注会话正在运行，请先停止并等待完成" },
          409,
        );
      const result = await runPythonTool<ToolResult>("delete-focus", {
        focusId,
      });
      if (focus?.threadId)
        await agentStore.deleteThread(focus.threadId).catch(() => undefined);
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
      const body = (await c.req.json().catch(() => ({}))) as {
        force?: unknown;
        respectInterval?: unknown;
      };
      const result = await runPythonTool<ToolResult>("claim-focus-agent-run", {
        focusId: c.req.param("id"),
        force: body.force === true,
        respectInterval: body.respectInterval !== false,
      });
      return c.json({
        ...resultResponse(result),
        data: await fullResultData(result),
      });
    },
  }),
  registerApiRoute("/app/focus/:id/run/record", {
    method: "POST",
    requiresAuth: false,
    handler: async (c: any) => {
      const body = (await c.req.json()) as {
        runId?: unknown;
        status?: unknown;
        message?: unknown;
      };
      const runId = typeof body.runId === "string" ? body.runId : "";
      if (!runId) return c.json({ error: "runId 不能为空" }, 400);
      const result = await runPythonTool<ToolResult>("record-focus-agent-run", {
        focusId: c.req.param("id"),
        runId,
        runStatus: body.status === "failed" ? "failed" : "completed",
        message: typeof body.message === "string" ? body.message : "",
      });
      return c.json({
        ...resultResponse(result),
        data: await fullResultData(result),
      });
    },
  }),
  registerApiRoute("/app/focus/:id/message", {
    method: "POST",
    requiresAuth: false,
    handler: async (c: any) => {
      const body = (await c.req.json()) as { message?: unknown };
      const message =
        typeof body.message === "string" ? body.message.trim() : "";
      if (!message) return c.json({ error: "消息不能为空" }, 400);
      const listed = await runPythonTool<ToolResult>("list-focus", {});
      const data = (await fullResultData(listed)) as {
        items?: FocusAgentItem[];
      };
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
      return c.json({
        ...resultResponse(result),
        data: await fullResultData(result),
      });
    },
  }),
  registerApiRoute("/app/programs", {
    method: "GET",
    requiresAuth: false,
    handler: async (c: any) => {
      const result = await runPythonTool<ToolResult>("get-training-plan", {
        refresh: c.req.query("refresh") === "true",
      });
      return c.json({
        ...resultResponse(result),
        data: await fullResultData(result),
      });
    },
  }),
  registerApiRoute("/app/programs/course-status", {
    method: "PATCH",
    requiresAuth: false,
    handler: async (c: any) => {
      const body = (await c.req.json()) as {
        planId?: unknown;
        courseId?: unknown;
        semester?: unknown;
        status?: unknown;
      };
      const result = await runPythonTool<ToolResult>(
        "save-training-plan-course-override",
        {
          planId: typeof body.planId === "string" ? body.planId : "",
          courseId: typeof body.courseId === "string" ? body.courseId : "",
          semester: typeof body.semester === "string" ? body.semester : "",
          status: typeof body.status === "string" ? body.status : "auto",
        },
      );
      return c.json({
        ...resultResponse(result),
        data: await fullResultData(result),
      });
    },
  }),
  registerApiRoute("/app/schedule/authorize", {
    method: "POST",
    requiresAuth: false,
    handler: async (c: any) => {
      const input = z
        .object({ resetSession: z.boolean().default(true) })
        .parse(await c.req.json().catch(() => ({})));
      const result = await runPythonTool<ToolResult>("authorize-schedule", {
        timeoutSeconds: 300,
        resetSession: input.resetSession,
      });
      return c.json(resultResponse(result));
    },
  }),
  registerApiRoute("/app/auth-resumes/:id/execute", {
    method: "POST",
    requiresAuth: false,
    handler: async (c: any) => {
      try {
        const input = z
          .object({ resetSession: z.boolean().default(true) })
          .parse(await c.req.json().catch(() => ({})));
        const resume = await executeAuthResume(
          c.req.param("id"),
          input.resetSession,
        );
        return c.json({
          status: resume.status,
          resumeId: resume.id,
          target: resume.target,
          challengeId: resume.challengeId,
        });
      } catch (error) {
        return c.json(
          { error: error instanceof Error ? error.message : "登录续接失败" },
          409,
        );
      }
    },
  }),
  registerApiRoute("/app/library", {
    method: "GET",
    requiresAuth: false,
    handler: async (c: any) => {
      const root = resolve(projectRoot, "exports");
      const category = c.req.query("category") || "",
        query = (c.req.query("query") || "").trim().toLocaleLowerCase();
      const labels = [
        ["documents", "上传文件"],
        ["references", "参考资料"],
        ["web", "网页与通知"],
        ["knowledge", "课程笔记"],
        ["subtitle", "课程字幕"],
        ["media", "课程媒体"],
        ["images", "临时图片"],
      ];
      if (!category && !query && c.req.query("all") !== "1")
        return c.json({
          root,
          level: "categories",
          directories: labels.map(([id, label]) => ({ id, label })),
          files: [],
          count: 0,
        });
      const files = await walkFiles(root);
      const imageRoot = resolve(projectRoot, ".seudaily", "uploads", "images");
      const images = await walkFiles(imageRoot);
      files.push(
        ...images.map((file) => ({
          ...file,
          category: "images",
          course: "临时图片",
          teacher: "本地上传",
        })),
      );
      const documents = await walkFiles(
        resolve(projectRoot, ".seudaily", "uploads", "documents"),
      );
      const { knowledge } = await import("./knowledge/index.js");
      const sources = new Set(await knowledge.sources());
      files.push(
        ...documents
          .filter((file) => !sources.has(file.path))
          .map((file) => ({
            ...file,
            name:
              resolveDocumentContexts([
                basename(file.path, extname(file.path)),
              ])[0]?.name || file.name,
            category: "documents",
            course: "上传文件",
            teacher: "本地文件",
          })),
      );
      const knowledgeDocuments = await knowledge.list();
      const webRoot = resolve(projectRoot, ".seudaily", "web-files", "files");
      const webDocumentIds = new Set(
        (
          await Promise.all(
            knowledgeDocuments.map(async (document) =>
              (await knowledge.sources(document.id)).some((path) =>
                isWithinDirectory(webRoot, resolve(path)),
              )
                ? document.id
                : null,
            ),
          )
        ).filter(Boolean),
      );
      const indexed = new Map(
        knowledgeDocuments
          .filter((document) => !webDocumentIds.has(document.id))
          .map((document) => [document.path, document]),
      );
      const builtinIds = await knowledge.builtinIds();
      const originals = await walkFiles(
        resolve(projectRoot, ".seudaily", "knowledge", "files"),
      );
      files.push(
        ...originals.flatMap((file) => {
          const document = indexed.get(file.path);
          return document
            ? [
                {
                  ...file,
                  name: document.name,
                  category: builtinIds.has(document.id)
                    ? "references"
                    : "documents",
                  course: builtinIds.has(document.id) ? "参考资料" : "上传文件",
                  teacher: "本地文件",
                },
              ]
            : [];
        }),
      );
      const webEntries = await webLibraryEntries(projectRoot);
      await knowledge.relocateSources(
        [...webEntries].flatMap(([path, item]) =>
          item.legacyPaths.map((oldPath) => ({ oldPath, path })),
        ),
      );
      const webFiles = await walkFiles(
        resolve(projectRoot, ".seudaily", "web-files", "files"),
      );
      files.push(
        ...webFiles.map((file) => ({
          ...file,
          name: webEntries.get(file.path)?.name || file.name,
          sources: webEntries.get(file.path)?.sources || ["未分类"],
          sections: webEntries.get(file.path)?.sections || [],
          notice: webEntries.get(file.path)?.notice,
          category: "web",
          course: "网页与通知",
          teacher: "本地缓存",
        })),
      );
      files.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      if (c.req.query("all") === "1")
        return c.json({ root, files, count: files.length });
      const source = c.req.query("source") || "",
        section = c.req.query("section") || "",
        notice = c.req.query("notice") || "",
        course = c.req.query("course") || "",
        teacher = c.req.query("teacher") || "";
      let chosen = query
        ? files.filter((file) => file.name.toLocaleLowerCase().includes(query))
        : files.filter((file) => file.category === category);
      let level = "files";
      let directories: { id: string; label: string }[] = [];
      const groups = (values: string[]) =>
        [...new Set(values)]
          .sort((a, b) => a.localeCompare(b, "zh-CN"))
          .map((value) => ({ id: value, label: value }));
      if (!query && category === "web") {
        if (!source) {
          level = "sources";
          directories = groups(
            chosen.flatMap((file: any) => file.sources || ["未分类"]),
          );
        } else {
          chosen = chosen.filter((file: any) => file.sources?.includes(source));
          if (!section) {
            level = "sections";
            directories = groups(
              chosen.flatMap(
                (file: any) =>
                  file.sections
                    ?.filter((item: any) => item.source === source)
                    .map((item: any) => item.label) || ["其他资料"],
              ),
            );
          } else {
            chosen = chosen.filter((file: any) =>
              file.sections?.some(
                (item: any) => item.source === source && item.label === section,
              ),
            );
            if (!notice) {
              level = "notices";
              directories = [
                ...new Map(
                  chosen.map((file: any) => [
                    file.notice?.id || file.path,
                    {
                      id: file.notice?.id || file.path,
                      label: file.notice?.title || file.name,
                    },
                  ]),
                ).values(),
              ] as { id: string; label: string }[];
            } else
              chosen = chosen.filter(
                (file: any) => (file.notice?.id || file.path) === notice,
              );
          }
        }
      } else if (
        !query &&
        !["documents", "references", "images"].includes(category)
      ) {
        if (!course) {
          level = "courses";
          directories = groups(chosen.map((file) => file.course));
        } else {
          chosen = chosen.filter((file) => file.course === course);
          if (!teacher) {
            level = "teachers";
            directories = groups(
              chosen.map((file) => file.teacher || "未分类"),
            );
          } else
            chosen = chosen.filter(
              (file) => (file.teacher || "未分类") === teacher,
            );
        }
      }
      if (level !== "files")
        return c.json({
          root,
          level,
          directories,
          files: [],
          count: directories.length,
        });
      if (c.req.query("pdf") === "1")
        chosen = chosen.filter((file) => file.type === "PDF");
      const limit = Math.max(
          1,
          Math.min(100, Number(c.req.query("limit")) || 50),
        ),
        offset = Math.max(
          0,
          Number.parseInt(c.req.query("cursor") || "0", 10) || 0,
        );
      const page = chosen.slice(offset, offset + limit),
        next = offset + page.length;
      return c.json({
        root,
        level: query ? "search" : "files",
        directories: [],
        files: page,
        count: chosen.length,
        nextCursor: next < chosen.length ? String(next) : null,
      });
    },
  }),
  registerApiRoute("/app/library/preview", {
    method: "GET",
    requiresAuth: false,
    handler: async (c: any) => {
      const requested = c.req.query("path");
      if (!requested) return c.json({ error: "缺少文件路径" }, 400);
      const target = await safeLibraryTarget(requested);
      if (!target) return c.json({ error: "只能预览资料库内的文件" }, 403);
      const details = await stat(target).catch(() => null);
      if (!details?.isFile()) return c.json({ error: "文件不存在" }, 404);
      if (details.size > 50 * 1024 * 1024)
        return c.json({ error: "文件超过 50 MB，无法在线预览" }, 413);
      const bytes = await readFile(target);
      return new Response(new Uint8Array(bytes), {
        headers: {
          "Content-Type": previewContentType(target),
          "Content-Disposition":
            c.req.query("download") === "1"
              ? "attachment; filename*=UTF-8\'\'" +
                encodeURIComponent(basename(c.req.query("name") || target))
              : "inline",
          "Cache-Control": "private, max-age=60",
          "X-Content-Type-Options": "nosniff",
        },
      });
    },
  }),
  registerApiRoute("/app/library", {
    method: "DELETE",
    requiresAuth: false,
    handler: async (c: any) => {
      const body = (await c.req.json()) as { path?: unknown };
      if (typeof body.path !== "string")
        return c.json({ error: "缺少文件路径" }, 400);
      const target = await safeLibraryTarget(body.path);
      if (!target) return c.json({ error: "只能删除资料库内的文件" }, 403);
      const knowledgeFiles = await realpath(
        resolve(projectRoot, ".seudaily", "knowledge", "files"),
      ).catch(() => null);
      if (knowledgeFiles && isWithinDirectory(knowledgeFiles, target)) {
        const { knowledge } = await import("./knowledge/index.js");
        const document = (await knowledge.list()).find(
          (item) => resolve(item.path) === resolve(body.path as string),
        );
        if (!document)
          return c.json({ error: "知识库文件未登记，请通过知识库管理" }, 409);
        const sources = await knowledge.sources(document.id);
        const uploads = await realpath(
          resolve(projectRoot, ".seudaily", "uploads", "documents"),
        ).catch(() => null);
        await knowledge.remove(document.id);
        for (const source of sources) {
          const safe = await safeLibraryTarget(source);
          if (safe && uploads && isWithinDirectory(uploads, safe))
            await unlink(safe).catch((error) => {
              if (error.code !== "ENOENT") throw error;
            });
        }
      } else await unlink(target);
      return c.json({ deleted: true, path: target });
    },
  }),
  registerApiRoute("/app/images", {
    method: "POST",
    requiresAuth: false,
    handler: async (c: any) => {
      const body = (await c.req.json()) as {
        dataUrl?: unknown;
        name?: unknown;
      };
      if (typeof body.dataUrl !== "string")
        return c.json({ error: "缺少图片数据" }, 400);
      const match = body.dataUrl.match(
        /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/,
      );
      if (!match)
        return c.json({ error: "仅支持 PNG、JPEG、WebP 或 GIF 图片" }, 400);
      const bytes = Buffer.from(match[2], "base64");
      if (!bytes.length || bytes.length > 10 * 1024 * 1024)
        return c.json({ error: "图片大小必须在 10 MB 以内" }, 400);
      const extension = match[1] === "image/jpeg" ? "jpg" : match[1].slice(6);
      const directory = resolve(projectRoot, ".seudaily", "uploads", "images");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const target = resolve(
        directory,
        `${Date.now()}-${randomUUID()}.${extension}`,
      );
      await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
      return c.json({
        path: target,
        ref: basename(target),
        sha256: createHash("sha256").update(bytes).digest("hex"),
        name: typeof body.name === "string" ? body.name : `image.${extension}`,
        mediaType: match[1],
        size: bytes.length,
      });
    },
  }),
  registerApiRoute("/app/documents", {
    method: "POST",
    requiresAuth: false,
    handler: async (c: any) => {
      const body = await c.req.parseBody();
      const upload = body?.file;
      if (!(upload instanceof File))
        return c.json({ error: "缺少文档文件" }, 400);
      const filename = upload.name || "document";
      const extension = extname(filename).toLowerCase();
      if (!supportedDocumentExtensions.has(extension)) {
        return c.json(
          {
            error:
              "仅支持 PDF、DOCX、XLSX、PPTX、TXT、MD；不支持旧版 DOC、XLS、PPT",
          },
          400,
        );
      }
      if (upload.size <= 0 || upload.size > 50 * 1024 * 1024) {
        return c.json({ error: "文档大小必须在 50 MB 以内" }, 413);
      }

      const bytes = Buffer.from(await upload.arrayBuffer());
      const plainText = [".txt", ".md"].includes(extension);
      const validSignature =
        plainText ||
        (extension === ".pdf"
          ? bytes.subarray(0, 5).toString("ascii") === "%PDF-"
          : bytes[0] === 0x50 && bytes[1] === 0x4b);
      if (!validSignature)
        return c.json({ error: "文件内容与扩展名不匹配或文件已损坏" }, 400);

      const temporaryDirectory = await mkdtemp(
        join(tmpdir(), "seudaily-document-"),
      );
      const temporaryPath = join(
        temporaryDirectory,
        `${randomUUID()}${extension}`,
      );
      try {
        await writeFile(temporaryPath, bytes);
        let result: ToolResult;
        try {
          if (plainText) {
            const markdown = new TextDecoder("utf-8", { fatal: true }).decode(
              bytes,
            );
            result = {
              status: "completed",
              taskId: randomUUID(),
              summary: "文档已读取",
              data: {
                filename,
                extension,
                markdown,
                charCount: markdown.length,
              },
              artifacts: [],
              citations: [],
              warnings: [],
              metrics: {},
            };
          } else
            result = await runPythonTool<ToolResult>("parse-document", {
              path: temporaryPath,
              filename,
            });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          return c.json({ error: `文档解析失败：${message}` }, 422);
        }
        const data = (await fullResultData(result)) as
          | {
              filename?: string;
              extension?: string;
              markdown?: string;
              charCount?: number;
            }
          | undefined;
        if (result.status !== "completed" || !data?.markdown) {
          return c.json(
            {
              error: result.summary || "文档解析失败",
              warnings: result.warnings,
            },
            422,
          );
        }
        const contextRef = randomUUID();
        const documentDirectory = resolve(
          projectRoot,
          ".seudaily",
          "uploads",
          "documents",
        );
        await mkdir(documentDirectory, { recursive: true, mode: 0o700 });
        const originalPath = join(
          documentDirectory,
          `${contextRef}${extension}`,
        );
        await writeFile(originalPath, bytes, { flag: "wx", mode: 0o600 });
        try {
          storeDocumentContext(
            contextRef,
            data.filename || filename,
            data.markdown,
          );
        } catch (error) {
          await unlink(originalPath).catch(() => undefined);
          throw error;
        }
        let knowledgeIndex:
          | { id: string; state: string; duplicate: boolean }
          | { state: string; error: string };
        try {
          const { knowledge } = await import("./knowledge/index.js");
          knowledgeIndex = await knowledge.enqueue(
            data.filename || filename,
            bytes,
            data.markdown,
            originalPath,
          );
        } catch (error) {
          // Keep the uploaded attachment usable even when local indexing fails.
          knowledgeIndex = {
            state: "failed",
            error: redactText((error as Error).message),
          };
        }
        return c.json({
          knowledge: knowledgeIndex,
          filename: data.filename || filename,
          extension: data.extension || extension,
          mediaType: documentMediaTypes[extension],
          contextRef,
          path: originalPath,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          markdown: data.markdown,
          charCount: data.charCount ?? data.markdown.length,
        });
      } finally {
        await rm(temporaryDirectory, { recursive: true, force: true }).catch(
          () => undefined,
        );
      }
    },
  }),
  registerApiRoute("/app/images/resolve", {
    method: "GET",
    requiresAuth: false,
    handler: async (c: any) => {
      const imageRoot = resolve(projectRoot, ".seudaily", "uploads", "images");
      const ref = c.req.query("ref");
      const sha256 = c.req.query("sha256")?.toLowerCase();
      if (ref) {
        if (basename(ref) !== ref)
          return c.json({ error: "图片引用无效" }, 400);
        const target = resolve(imageRoot, ref);
        const details = await stat(target).catch(() => null);
        if (!details?.isFile()) return c.json({ error: "图片已被删除" }, 404);
        return c.json({
          path: target,
          ref,
          mediaType: previewContentType(target),
        });
      }
      if (!sha256 || !/^[a-f0-9]{64}$/.test(sha256))
        return c.json({ error: "缺少图片引用" }, 400);
      const entries = await readdir(imageRoot, { withFileTypes: true }).catch(
        () => [],
      );
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const target = resolve(imageRoot, entry.name);
        const bytes = await readFile(target).catch(() => null);
        if (
          bytes &&
          createHash("sha256").update(bytes).digest("hex") === sha256
        )
          return c.json({
            path: target,
            ref: entry.name,
            mediaType: previewContentType(target),
          });
      }
      return c.json({ error: "图片已被删除" }, 404);
    },
  }),
  registerApiRoute("/app/notices", {
    method: "GET",
    requiresAuth: false,
    handler: async (c: any) => {
      const refresh = c.req.query("refresh") !== "false";
      const sourceId = c.req.query("source") || "jwc";
      let source;
      try {
        source = requireNoticeSource(sourceId);
      } catch {
        return c.json({ error: "未知通知来源" }, 400);
      }
      const category = c.req.query("category");
      if (category && !source.categories[category])
        return c.json({ error: "未知通知栏目" }, 400);
      const result = await runPythonTool<ToolResult>("list-notices", {
        source: sourceId,
        categories: category
          ? [category]
          : source.displayCategories || Object.keys(source.categories),
        freshness: refresh ? "latest" : "cache_only",
        timeScope: "any",
        limit: 60,
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
        provider: {
          name: "DeepSeek",
          baseUrl: "https://api.deepseek.com",
          editable: false,
        },
        agentInstructions: await readAgentInstructions(),
        fields: editableEnvironment.map((name) => ({
          name,
          secret: secretEnvironment.has(name),
          configured: Boolean(
            values[name] ||
              values[legacyEnvironmentName(name) ?? ""] ||
              envValue(name),
          ),
          value: secretEnvironment.has(name)
            ? ""
            : name === "SEUDAILY_FULL_ACCESS" ||
                name === "SEUDAILY_FULL_ACCESS_EXTRA"
              ? String(
                  name === "SEUDAILY_FULL_ACCESS_EXTRA"
                    ? isFullAccessExtraEnabled()
                    : isFullAccessEnabled(),
                )
              : (values[name] ??
                values[legacyEnvironmentName(name) ?? ""] ??
                envValue(name) ??
                ""),
        })),
      });
    },
  }),
  registerApiRoute("/app/settings", {
    method: "POST",
    requiresAuth: false,
    handler: async (c: any) => {
      const body = (await c.req.json()) as {
        values?: Record<string, unknown>;
        agentInstructions?: unknown;
      };
      const values: Record<string, string> = {};
      for (const name of editableEnvironment) {
        const legacyName = legacyEnvironmentName(name);
        const value =
          body.values?.[name] ??
          (legacyName ? body.values?.[legacyName] : undefined);
        if (typeof value === "string" && value.trim())
          values[name] = value.trim();
      }
      await updateEnvFile(values);
      if (Object.hasOwn(values, "SEUDAILY_FULL_ACCESS")) {
        setFullAccessEnabled(
          values.SEUDAILY_FULL_ACCESS === "true" ||
            values.SEUDAILY_FULL_ACCESS === "1" ||
            values.SEUDAILY_FULL_ACCESS === "yes" ||
            values.SEUDAILY_FULL_ACCESS === "on",
        );
      }
      if (Object.hasOwn(values, "SEUDAILY_FULL_ACCESS_EXTRA")) {
        setFullAccessExtraEnabled(
          values.SEUDAILY_FULL_ACCESS_EXTRA === "true" ||
            values.SEUDAILY_FULL_ACCESS_EXTRA === "1" ||
            values.SEUDAILY_FULL_ACCESS_EXTRA === "yes" ||
            values.SEUDAILY_FULL_ACCESS_EXTRA === "on",
        );
      }
      const agentInstructionsSaved = typeof body.agentInstructions === "string";
      if (agentInstructionsSaved)
        await writeFile(
          agentInstructionsPath,
          body.agentInstructions as string,
          "utf8",
        );
      const restartRequired = Object.keys(values).some(
        (name) =>
          ![
            "SEUDAILY_FULL_ACCESS",
            "SEUDAILY_FULL_ACCESS_EXTRA",
            "DASHSCOPE_API_KEY",
            "SEUDAILY_EMBEDDING_MODEL",
            "SEUDAILY_RERANK_MODEL",
            "SEUDAILY_EMBEDDING_BASE_URL",
          ].includes(name),
      );
      return c.json({
        saved: Object.keys(values),
        agentInstructionsSaved,
        restartRequired,
      });
    },
  }),
];

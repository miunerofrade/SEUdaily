import { requireNoticeSource } from "../shared/notice-sources.js";
import { existsSync } from "node:fs";
import { z } from "zod";
import { registerApiRoute } from "../server/routes.js";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { projectRoot } from "./runtime-paths.js";
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
  FOCUS_RESOURCE_ID,
  resultResponse,
  fullResultData,
} from "./app-route-helpers.js";

export const scheduleRoutes = [
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
];

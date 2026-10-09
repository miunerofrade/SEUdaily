import { z } from "zod";
import { registerApiRoute } from "../server/routes.js";
import { randomUUID } from "node:crypto";
import { runPythonTool } from "./tools/python-bridge.js";
import type { ToolResult } from "./tools/tool-result.js";
import { startFocusRuntime } from "./focus-runtime.js";
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
import {
  FOCUS_RESOURCE_ID,
  resultResponse,
  fullResultData,
} from "./app-route-helpers.js";

export const conversationsRoutes = [
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
            : {
                schedule: Object.fromEntries(
                  Object.entries(
                    data.payload as Record<string, unknown>,
                  ).filter(([key]) => key !== "operation"),
                ),
              }),
        });
        const payload = localActionExecutionPayload(proposal) as Record<
          string,
          unknown
        >;
        let result: ToolResult;
        if (proposal.kind === "create_focus") {
          const id = `focus-${randomUUID()}`;
          result = await runPythonTool<ToolResult>(
            localOperations[proposal.kind].action,
            {
              item: {
                ...payload,
                id,
                threadId: id,
                resourceId: FOCUS_RESOURCE_ID,
                enabled: true,
              },
            },
          );
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
];

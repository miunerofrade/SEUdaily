import {
  parseEnv,
  readEnvFile,
  updateEnvFile,
} from "./environment-settings.js";
import { diskSize } from "../shared/disk-size.js";
import { z } from "zod";
import { registerApiRoute } from "../server/routes.js";
import { writeFile } from "node:fs/promises";
import { envValue, agentInstructionsPath } from "./runtime-paths.js";
import { runPythonTool } from "./tools/python-bridge.js";
import type { ToolResult } from "./tools/tool-result.js";
import {
  isFullAccessEnabled,
  isFullAccessExtraEnabled,
  setFullAccessEnabled,
  setFullAccessExtraEnabled,
} from "./permission-state.js";
import {
  editableEnvironment,
  secretEnvironment,
  readAgentInstructions,
  resultResponse,
  fullResultData,
  legacyEnvironmentName,
} from "./app-route-helpers.js";

export const settingsRoutes = [
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

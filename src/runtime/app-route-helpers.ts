import { readFile } from "node:fs/promises";
import { agentInstructionsPath } from "./runtime-paths.js";
import type { ToolResult } from "./tools/tool-result.js";

export const FOCUS_RESOURCE_ID = "seudaily-focus-local";

export const editableEnvironment = [
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

export const secretEnvironment = new Set([
  "DASHSCOPE_API_KEY",
  "DEEPSEEK_API_KEY",
  "TAVILY_API_KEY",
  "SEUDAILY_PASSWORD",
  "SEUDAILY_ASR_API_KEY",
]);

export async function readAgentInstructions() {
  try {
    return await readFile(agentInstructionsPath, "utf8");
  } catch {
    return "";
  }
}

export function resultResponse(result: ToolResult) {
  return {
    status: result.status,
    summary: result.summary,
    data: result.data,
    warnings: result.warnings,
  };
}

export async function fullResultData(result: ToolResult): Promise<unknown> {
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

export function legacyEnvironmentName(name: string) {
  return name.startsWith("SEUDAILY_")
    ? `CVSTREAM_${name.slice("SEUDAILY_".length)}`
    : undefined;
}

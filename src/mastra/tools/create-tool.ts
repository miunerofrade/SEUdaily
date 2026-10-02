import { createTool as createMastraTool } from "@mastra/core/tools";
import { z } from "zod";
import { defineTool, type ToolDefinition } from "../../agent/tool.js";

// Temporary adapter keeps the old entry runnable while business tools are extracted.
export function createTool<S extends z.ZodType, O>(definition: ToolDefinition<S, O>): any {
  return createMastraTool(defineTool(definition) as any);
}

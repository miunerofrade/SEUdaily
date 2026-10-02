import { z } from "zod";

export interface ToolExecutionOptions {
  abortSignal?: AbortSignal;
  requestContext?: { get(key: string): any };
}

export interface ToolDefinition<S extends z.ZodType = any, O = any> {
  id: string;
  description: string;
  inputSchema: S;
  outputSchema?: z.ZodType;
  execute: (input: z.output<S>, options: ToolExecutionOptions) => O | Promise<O>;
  requireApproval?: boolean | ((input: z.output<S>) => boolean | Promise<boolean>);
  toModelOutput?: (output: any) => { type: string; value: any } | Promise<{ type: string; value: any }>;
}

export function defineTool<S extends z.ZodType, O>(definition: ToolDefinition<S, O>): ToolDefinition<S, O> {
  return definition;
}

export function toolJsonSchema(tool: ToolDefinition): Record<string, unknown> {
  return z.toJSONSchema(tool.inputSchema, { io: "input", unrepresentable: "any" });
}

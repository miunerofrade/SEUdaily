import { AgentRuntime } from '../agent/runtime.js';
import { DeepSeekProvider } from '../agent/provider.js';
import { agentStore } from './storage.js';
import { agentInstructions } from './instructions.js';
import { hydrateImages } from './images.js';
import { getCurrentDateTool } from './tools/course-tools.js';
import { readTaskResultTool } from './tools/task-result-tool.js';
import { namespaceTools, browserNamespaceTools, searchCapabilitiesTool, invokeCapabilityTool, toolNamespaceSchema } from './tools/tool-broker.js';
import { isFullAccessExtraEnabled } from './permission-state.js';
import { envValue } from './runtime-paths.js';

export const agentRuntime = new AgentRuntime({
  store: agentStore, provider: new DeepSeekProvider(), instructions: agentInstructions, hydrate: hydrateImages,
  memory: { windowTokens: Number(envValue('SEUDAILY_CONTEXT_WINDOW_TOKENS')) || 512_000, ratio: Number(envValue('SEUDAILY_OBSERVATION_COMPRESSION_RATIO')) || .8, lastMessages: Number(envValue('SEUDAILY_MEMORY_LAST_MESSAGES')) || 200 },
  tools: async context => {
    const namespaces = (context.namespaces ?? []).flatMap(value => { const result = toolNamespaceSchema.safeParse(value); return result.success ? [result.data] : []; });
    const workspace = namespaces.includes('workspace') && isFullAccessExtraEnabled() ? await (await import('./workspace.js')).getWorkspaceTools() : {};
    return { getCurrentDateTool, readTaskResultTool, searchCapabilitiesTool, invokeCapabilityTool, ...namespaceTools(namespaces), ...await browserNamespaceTools(namespaces), ...workspace };
  },
});

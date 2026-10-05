import { resolveDocumentContexts } from './document-context.js';
import { AgentRuntime } from '../agent/runtime.js';
import { DeepSeekProvider } from '../agent/provider.js';
import { agentStore } from './storage.js';
import { agentInstructions } from './instructions.js';
import { hydrateImages } from './images.js';
import { getCurrentDateTool } from './tools/course-tools.js';
import { readTaskResultTool } from './tools/task-result-tool.js';
import { namespaceTools, browserNamespaceTools, searchCapabilitiesTool, invokeCapabilityTool, toolNamespaceSchema } from './tools/tool-broker.js';
import { isFullAccessExtraEnabled } from './permission-state.js';
import { resolveFocusPermission } from './focus-permission.js';
import { envValue } from './runtime-paths.js';
import { listSkillsTool, readSkillTool } from './skills.js';
let closeWorkspace: (() => void) | undefined;
export function closeApplicationWorkspace() { closeWorkspace?.(); }
export const agentRuntime = new AgentRuntime({
    store: agentStore, provider: new DeepSeekProvider(), instructions: agentInstructions, hydrate: hydrateImages, resolveDocuments: resolveDocumentContexts,
    memory: { windowTokens: Number(envValue('SEUDAILY_CONTEXT_WINDOW_TOKENS')) || 512000, ratio: Number(envValue('SEUDAILY_OBSERVATION_COMPRESSION_RATIO')) || .8, lastMessages: Number(envValue('SEUDAILY_MEMORY_LAST_MESSAGES')) || 200 },
    tools: async (context) => {
        context.focus = await resolveFocusPermission(context);
        const namespaces = (context.namespaces ?? []).flatMap(value => { const result = toolNamespaceSchema.safeParse(value); return result.success ? [result.data] : []; });
        let workspace = {};
        if (namespaces.includes('workspace') && !context.focus && isFullAccessExtraEnabled()) {
            const module = await import('./workspace.js');
            closeWorkspace = module.closeWorkspace;
            workspace = await module.getWorkspaceTools();
        }
        return { getCurrentDateTool, readTaskResultTool, listSkillsTool, readSkillTool, searchCapabilitiesTool, invokeCapabilityTool, ...namespaceTools(namespaces), ...await browserNamespaceTools(namespaces, context.threadId), ...workspace };
    },
});

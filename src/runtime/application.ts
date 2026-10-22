import {ensureConversationTitle} from "./conversation-title.js";
import { resolveDocumentContexts } from './document-context.js';
import { AgentRuntime } from '../agent/runtime.js';
import { DeepSeekProvider } from '../agent/provider.js';
import { agentStore } from './storage.js';
import { agentInstructions, turnInstructions } from './instructions.js';
import { hydrateImages } from './images.js';
import { getCurrentDateTool } from './tools/course-tools.js';
import { readTaskResultTool } from './tools/task-result-tool.js';
import { searchCapabilitiesTool, invokeCapabilityTool, closeBrokerWorkspace } from './tools/tool-broker.js';
import { resolveFocusPermission } from './focus-permission.js';
import { envValue } from './runtime-paths.js';
import { listSkillsTool, readSkillTool } from './skills.js';
export function closeApplicationWorkspace() { closeBrokerWorkspace(); }
export const contextWindowTokens=Number(envValue('SEUDAILY_CONTEXT_WINDOW_TOKENS')) || 512000;
export const agentRuntime = new AgentRuntime({
    store: agentStore, provider: new DeepSeekProvider(), instructions: agentInstructions, initialContext: turnInstructions, hydrate: hydrateImages, resolveDocuments: resolveDocumentContexts,
    onCompleted: run => {
        return ensureConversationTitle({threadId:run.context.threadId,resourceId:run.context.resourceId});
    },
    memory: { windowTokens: contextWindowTokens, ratio: Number(envValue('SEUDAILY_OBSERVATION_COMPRESSION_RATIO')) || .8, lastMessages: Number(envValue('SEUDAILY_MEMORY_LAST_MESSAGES')) || 200 },
    tools: async (context) => {
        context.focus = await resolveFocusPermission(context);
        return { getCurrentDateTool, readTaskResultTool, listSkillsTool, readSkillTool, searchCapabilitiesTool, invokeCapabilityTool };
    },
});

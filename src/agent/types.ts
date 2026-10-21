import type { RunTiming } from '../shared/timing.js';

export type ContentPart = {
    type: string;
    [key: string]: any;
};
export type ModelMessage = {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | ContentPart[] | null;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
    reasoning_content?: string;
};
export type ToolCall = {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string;
    };
};
export type AgentEvent = (
    | { type: 'text-delta' | 'reasoning-delta'; payload: { text: string } }
    | { type: 'reasoning-start' | 'reasoning-end'; payload: Record<string, never> }
    | { type: 'tool-call'; payload: { toolCallId: string; toolName: string; args?: Record<string, unknown>; startedAt?: number } }
    | { type: 'tool-approval-request'; payload: { toolCallId: string; toolName: string; args?: Record<string, unknown>; approvalId: string } }
    | { type: 'tool-result'; payload: { toolCallId: string; toolName: string; args?: Record<string, unknown>; result: any; startedAt?: number; finishedAt?: number } }
    | { type: 'finish'; payload: { usage?: Record<string, number> } }
    | { type: 'input-added'; payload: { id: string; text: string } }
    | { type: 'error'; payload: { error: { message: string } } }
) & { timestamp?: number; timing?: RunTiming };
export type TurnContext = {
    threadId: string;
    resourceId: string;
    runToken: string;
    namespaces?: string[];
    documentRefs?: string[];
    authResumeId?: string;
    parentMessageId?: string | null;
    userMessageId?: string;
    assistantMessageId?: string;
    regenerateFrom?: string;
    skills?: string[];
    interface?: string;
    focus?: boolean;
    capabilityNamespaces?: string[];
};
export type StoredMessage = {
    id: string;
    threadId: string;
    resourceId: string;
    role: 'user' | 'assistant';
    createdAt: string;
    content: {
        content?: string;
        parentId?: string | null;
        parts: ContentPart[];
        modelMessages?: ModelMessage[];
        runToken?: string;
        usage?: Record<string, number>;
        timing?: RunTiming;
    };
    sequence?: number;
};
export type Thread = {
    id: string;
    resourceId: string;
    title?: string;
    metadata: Record<string, any>;
    createdAt: string;
    updatedAt: string;
};
export type RunState = {
    id: string;
    context: TurnContext;
    status: 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
    step: number;
    messages: ModelMessage[];
    parts: ContentPart[];
    pendingCalls: ToolCall[];
    pendingToolImages?: ContentPart[];
    cursor: number;
    approval?: {
        id: string;
        callId: string;
    };
    executing?: string;
    startedAt: string;
    inputMessageIds?: string[];
    usage?: Record<string, number>;
    timing?: RunTiming;
};

export type ContentPart = { type: string; [key: string]: any };
export type ModelMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
};
export type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
export type AgentEvent = { type: string; payload: Record<string, any> };
export type TurnContext = { threadId: string; resourceId: string; runToken: string; namespaces?: string[]; documentRefs?: string[]; authResumeId?: string };
export type StoredMessage = { id: string; threadId: string; resourceId: string; role: 'user' | 'assistant'; createdAt: string; content: { content?: string; parts: ContentPart[]; modelMessages?: ModelMessage[]; runToken?: string }; sequence?: number };
export type Thread = { id: string; resourceId: string; title?: string; metadata: Record<string, any>; createdAt: string; updatedAt: string };
export type RunState = { id: string; context: TurnContext; status: 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'interrupted'; step: number; messages: ModelMessage[]; parts: ContentPart[]; pendingCalls: ToolCall[]; cursor: number; approval?: { id: string; callId: string }; executing?: string; startedAt: string; inputMessageIds?: string[]; usage?: Record<string, number> };

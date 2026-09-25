export type Artifact = {
  id: string;
  type: "subtitle" | "video" | "audio" | "slides" | "note" | "snapshot";
  path: string;
  mimeType?: string;
  sizeBytes?: number;
};

export type Citation = {
  id: string;
  type: "web" | "subtitle" | "video" | "file" | "snapshot";
  title: string;
  url?: string;
  localPath?: string;
  locator?: string;
  publishedAt?: string;
};

export type ToolResult = {
  status: "completed" | "partial" | "failed" | "cancelled" | "auth_required" | "waiting_for_user";
  taskId: string;
  summary: string;
  data?: unknown;
  artifacts: Artifact[];
  citations: Citation[];
  warnings: string[];
  metrics: Record<string, number>;
  resultRef?: string;
};

export type ToolRun = {
  id: string;
  name: string;
  state: "running" | "approval-requested" | "completed" | "failed";
  args?: Record<string, unknown>;
  approvalId?: string;
  result?: ToolResult;
};

export type AgentProcessEntry =
  | {
      id: string;
      type: "reasoning" | "narration";
      text: string;
    }
  | {
      id: string;
      type: "tool";
      toolId: string;
    };

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  modelContent?: string;
  attachments?: ImageAttachment[];
  documents?: DocumentAttachment[];
  createdAt: number;
  tools?: ToolRun[];
  process?: AgentProcessEntry[];
  reasoningActive?: boolean;
  reasoningDone?: boolean;
  streaming?: boolean;
  error?: string;
};

export type ImageAttachment = {
  id: string;
  name: string;
  mediaType: string;
  dataUrl?: string;
  path?: string;
};

export type DocumentAttachment = {
  id: string;
  name: string;
  mediaType: string;
  contextRef?: string;
  markdown?: string;
  charCount: number;
};

export type Conversation = {
  id: string;
  resourceId?: string;
  focusId?: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
};

export type StreamEvent = {
  type: string;
  runId?: string;
  payload?: Record<string, unknown>;
  data?: unknown;
};

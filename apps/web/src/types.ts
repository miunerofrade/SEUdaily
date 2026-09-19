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
  state: "running" | "completed" | "failed";
  args?: Record<string, unknown>;
  result?: ToolResult;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  attachments?: ImageAttachment[];
  createdAt: number;
  tools?: ToolRun[];
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

export type Conversation = {
  id: string;
  resourceId?: string;
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

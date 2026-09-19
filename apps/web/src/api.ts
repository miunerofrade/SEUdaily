import type { ChatMessage, Conversation, ImageAttachment, StreamEvent, ToolResult, ToolRun } from "./types";

const AGENT_ENDPOINT = "/api/agents/seudaily-agent/stream";
export const RESOURCE_ID = "seudaily-web-local";
const HISTORY_RESOURCES = [RESOURCE_ID, "cvstream-web-local"];

export type AgentContent = string | Array<
  | { type: "text"; text: string }
  | { type: "image"; image: string; mediaType?: string }
  | { type: "file"; data: string; mediaType: string; filename?: string }
>;
export type AgentInput = string | Array<{ role: "user" | "assistant"; content: AgentContent }>;

type StreamOptions = {
  message: AgentInput;
  threadId: string;
  signal: AbortSignal;
  onEvent: (event: StreamEvent) => void;
};

export async function streamAgent({ message, threadId, signal, onEvent }: StreamOptions) {
  const response = await fetch(AGENT_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: message,
      memory: { thread: threadId, resource: RESOURCE_ID },
    }),
    signal,
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || `Agent 请求失败（${response.status}）`);
  }
  if (!response.body) throw new Error("浏览器没有收到流式响应");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const processBlock = (block: string) => {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") return;
    try {
      onEvent(JSON.parse(data) as StreamEvent);
    } catch {
      // Ignore keep-alives or non-JSON server diagnostics.
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? "";
    blocks.forEach(processBlock);
    if (done) {
      if (buffer.trim()) processBlock(buffer);
      break;
    }
  }
}

type StoredThread = {
  id: string;
  title?: string;
  resourceId: string;
  createdAt: string;
  updatedAt: string;
};

type StoredMessage = {
  id: string;
  role: "user" | "assistant";
  createdAt: string;
  content?: {
    content?: string;
    parts?: Array<Record<string, unknown>>;
  };
};

function storedTools(parts: Array<Record<string, unknown>> = []): ToolRun[] {
  return parts.flatMap((part) => {
    if (part.type !== "tool-invocation" || !part.toolInvocation || typeof part.toolInvocation !== "object") return [];
    const invocation = part.toolInvocation as Record<string, unknown>;
    const result = invocation.result as ToolResult | undefined;
    return [{
      id: String(invocation.toolCallId ?? crypto.randomUUID()),
      name: String(invocation.toolName ?? "工具调用"),
      state: invocation.state === "result" ? (result?.status === "failed" ? "failed" : "completed") : "completed",
      args: invocation.args as Record<string, unknown> | undefined,
      result,
    } satisfies ToolRun];
  });
}

const storedImagePaths = new Map<string, string | null>();

async function legacyImageHash(dataUrl: string) {
  const bytes = Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(",") + 1)), (character) => character.charCodeAt(0));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function resolveStoredImage(part: Record<string, unknown>) {
  const filename = typeof part.filename === "string" ? part.filename : "";
  const data = typeof part.data === "string" ? part.data : typeof part.image === "string" ? part.image : "";
  const key = filename ? `ref:${filename}` : data.startsWith("data:image/") ? `sha256:${await legacyImageHash(data)}` : "";
  if (!key) return null;
  if (storedImagePaths.has(key)) return storedImagePaths.get(key) ?? null;
  const [kind, value] = key.split(":", 2);
  const response = await fetch(`/app/images/resolve?${kind === "ref" ? "ref" : "sha256"}=${encodeURIComponent(value)}`);
  if (!response.ok) { storedImagePaths.set(key, null); return null; }
  const resolved = await response.json() as { path: string };
  storedImagePaths.set(key, resolved.path);
  return resolved.path;
}

async function storedAttachments(messageId: string, parts: Array<Record<string, unknown>> = []): Promise<ImageAttachment[]> {
  let imageIndex = 0;
  const attachments = await Promise.all(parts.map(async (part, index) => {
    if (part.type !== "file" && part.type !== "image") return [];
    const path = await resolveStoredImage(part);
    if (!path) return [];
    const mediaType = typeof part.mimeType === "string" ? part.mimeType : "image/*";
    imageIndex += 1;
    return [{ id: `${messageId}-image-${index}`, name: `历史图片 ${imageIndex}`, mediaType, path } satisfies ImageAttachment];
  }));
  return attachments.flat();
}

async function fetchThreadMessages(thread: StoredThread): Promise<Conversation | null> {
  const query = new URLSearchParams({ resourceId: thread.resourceId, perPage: "100" });
  const response = await fetch(`/api/memory/threads/${encodeURIComponent(thread.id)}/messages?${query}`);
  if (!response.ok) return null;
  const data = await response.json() as { messages?: StoredMessage[] };
  const restored = await Promise.all((data.messages ?? []).map(async (item): Promise<ChatMessage | null> => {
    if (item.role !== "user" && item.role !== "assistant") return null;
    const content = item.content?.content ?? "";
    const attachments = item.role === "user" ? await storedAttachments(item.id, item.content?.parts) : undefined;
    if (!content && item.role === "user" && !attachments?.length) return null;
    return {
      id: item.id,
      role: item.role,
      content,
      createdAt: Date.parse(item.createdAt),
      attachments,
      tools: item.role === "assistant" ? storedTools(item.content?.parts) : undefined,
      reasoningDone: item.role === "assistant" && Boolean(item.content?.parts?.some((part) => part.type === "reasoning")),
    } satisfies ChatMessage;
  }));
  const messages = restored.filter((message): message is ChatMessage => message !== null);
  if (!messages.length) return null;
  const firstPrompt = messages.find((message) => message.role === "user")?.content ?? "新对话";
  return {
    id: thread.id,
    resourceId: thread.resourceId,
    title: thread.title?.trim() || (firstPrompt.length > 18 ? `${firstPrompt.slice(0, 18)}…` : firstPrompt),
    createdAt: Date.parse(thread.createdAt),
    updatedAt: Date.parse(thread.updatedAt),
    messages,
  };
}

export async function loadServerConversations(): Promise<Conversation[]> {
  const threadGroups = await Promise.all(HISTORY_RESOURCES.map(async (resourceId) => {
    const query = new URLSearchParams({ resourceId, perPage: "100", orderBy: JSON.stringify({ field: "updatedAt", direction: "DESC" }) });
    const response = await fetch(`/api/memory/threads?${query}`);
    if (!response.ok) return [] as StoredThread[];
    const data = await response.json() as { threads?: StoredThread[] };
    return data.threads ?? [];
  }));
  const conversations = await Promise.all(threadGroups.flat().map(fetchThreadMessages));
  return conversations.filter((conversation): conversation is Conversation => conversation !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteServerConversation(threadId: string, resourceId?: string) {
  if (!resourceId) return;
  const query = new URLSearchParams({ agentId: "seudaily-agent", resourceId });
  const response = await fetch(`/api/memory/threads/${encodeURIComponent(threadId)}?${query}`, { method: "DELETE" });
  if (!response.ok && response.status !== 404) {
    const detail = await response.text();
    throw new Error(detail || "删除会话失败");
  }
}

export type ScheduleCourse = {
  scheduleId: string;
  courseName: string;
  teacherName?: string;
  weekday: number;
  startPeriod?: number;
  endPeriod?: number;
  weeklyPeriods?: number[];
  weeks?: number[];
  classroom?: string;
  courseCode?: string;
};

export type ScheduleResponse = {
  status: string;
  summary: string;
  data?: { fetchedAt?: string; count?: number; courses?: ScheduleCourse[]; cacheAvailable?: boolean };
  warnings?: string[];
};

export type LibraryFile = { path: string; relativePath: string; name: string; size: number; updatedAt: string; type: string; category: string; course: string; teacher: string };
export type NoticeItem = { id: string; title: string; url: string; publishedAt?: string; category?: string; detailStatus?: string };

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error((await response.text()) || `请求失败（${response.status}）`);
  return response.json() as Promise<T>;
}

export function fetchSchedule(refresh = false) {
  return jsonRequest<ScheduleResponse>(`/app/schedule?refresh=${refresh}`);
}

export function authorizeSchedule() {
  return jsonRequest<ScheduleResponse>("/app/schedule/authorize", { method: "POST" });
}

export function fetchLibrary() {
  return jsonRequest<{ root: string; files: LibraryFile[]; count: number }>("/app/library");
}

export function deleteLibraryFile(path: string) {
  return jsonRequest<{ deleted: boolean; path: string }>("/app/library", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
}

export function libraryPreviewUrl(path: string) {
  return `/app/library/preview?path=${encodeURIComponent(path)}`;
}

export function uploadTemporaryImage(image: { dataUrl: string; name: string }) {
  return jsonRequest<{ path: string; ref: string; sha256: string; name: string; mediaType: string; size: number }>("/app/images", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(image),
  });
}

export function fetchNotices(refresh = true) {
  return jsonRequest<{ status: string; summary: string; data?: { results?: NoticeItem[]; source?: string }; warnings?: string[] }>(`/app/notices?refresh=${refresh}`);
}

export type SettingsPayload = {
  provider: { name: string; baseUrl: string; editable: boolean };
  fields: Array<{ name: string; secret: boolean; configured: boolean; value: string }>;
};

export function fetchSettings() {
  return jsonRequest<SettingsPayload>("/app/settings");
}

export function saveSettings(values: Record<string, string>) {
  return jsonRequest<{ saved: string[]; restartRequired: boolean }>("/app/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ values }),
  });
}

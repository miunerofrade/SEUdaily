import type { ChatMessage, Conversation, DocumentAttachment, ImageAttachment, StreamEvent, ToolResult, ToolRun } from "./types";

const AGENT_ENDPOINT = "/api/agents/seudaily-agent/stream";
export const RESOURCE_ID = "seudaily-web-local";
const HISTORY_RESOURCES = [RESOURCE_ID, "cvstream-web-local"];
const DOCUMENT_SECTION_MARKER = "\n\n<!-- cvstream:documents -->";

export type AgentContent = string | Array<
  | { type: "text"; text: string }
  | { type: "image"; image: string; mediaType?: string }
  | { type: "file"; data: string; mediaType: string; filename?: string }
>;
export type AgentInput = string | Array<
  | { role: "user" | "assistant"; content: AgentContent }
  | { role: "tool"; content: Array<{ type: "tool-approval-response"; approvalId: string; approved: boolean; reason?: string }> }
>;

type StreamOptions = {
  message: AgentInput;
  threadId: string;
  resourceId?: string;
  documents?: DocumentAttachment[];
  signal: AbortSignal;
  onEvent: (event: StreamEvent) => void;
};

export async function streamAgent({ message, threadId, resourceId = RESOURCE_ID, documents = [], signal, onEvent }: StreamOptions) {
  const response = await fetch(AGENT_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: message,
      memory: { thread: threadId, resource: resourceId },
      ...(documents.some((document) => document.contextRef) ? {
        requestContext: { cvstreamDocumentRefs: documents.flatMap((document) => document.contextRef ? [document.contextRef] : []) },
      } : {}),
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

function visibleStoredContent(content: string) {
  const packagedMarker = content.indexOf(DOCUMENT_SECTION_MARKER);
  const legacyMarker = content.indexOf("\n\n【附件：");
  const marker = packagedMarker >= 0 ? packagedMarker : legacyMarker;
  return (marker >= 0 ? content.slice(0, marker) : content).trim();
}

function legacyStoredDocuments(messageId: string, content: string): DocumentAttachment[] {
  return [...content.matchAll(/【附件：([^】]+)】(?:\r?\n【字符数：(\d+)】)?/g)].map((match, index) => ({
    id: `${messageId}-document-${index}`,
    name: match[1].trim(),
    mediaType: "application/octet-stream",
    charCount: Number(match[2] ?? 0),
  }));
}

async function fetchThreadMessages(thread: StoredThread): Promise<Conversation | null> {
  const query = new URLSearchParams({ resourceId: thread.resourceId, perPage: "100" });
  const response = await fetch(`/api/memory/threads/${encodeURIComponent(thread.id)}/messages?${query}`);
  if (!response.ok) return null;
  const data = await response.json() as { messages?: StoredMessage[] };
  const restored = await Promise.all((data.messages ?? []).map(async (item): Promise<ChatMessage | null> => {
    if (item.role !== "user" && item.role !== "assistant") return null;
    const storedContent = item.content?.content ?? "";
    const content = item.role === "user" ? visibleStoredContent(storedContent) : storedContent;
    const attachments = item.role === "user" ? await storedAttachments(item.id, item.content?.parts) : undefined;
    const documents = item.role === "user" ? legacyStoredDocuments(item.id, storedContent) : undefined;
    if (!content && item.role === "user" && !attachments?.length && !documents?.length) return null;
    return {
      id: item.id,
      role: item.role,
      content,
      modelContent: item.role === "user" && storedContent !== content ? storedContent : undefined,
      createdAt: Date.parse(item.createdAt),
      attachments,
      documents,
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

export async function generateConversationTitle(input: {
  threadId: string;
  resourceId?: string;
  titleInput: string;
}) {
  const response = await fetch("/app/conversations/title", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...input, resourceId: input.resourceId ?? RESOURCE_ID }),
  });
  const result = await response.json() as { title?: string; generated?: boolean; reason?: string; error?: string };
  if (!response.ok) throw new Error(result.error || "标题生成失败");
  return result;
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
  semester?: string;
  sourceKey: string;
  source?: "remote" | "custom";
  customId?: string;
  occurrenceDate?: string;
};

export type ScheduleSemesterOption = { value: string; label: string };

export type SemesterSettings = { name: string; startDate: string; totalWeeks: number };
export type ScheduleCustomizations = {
  version: number;
  semester: SemesterSettings;
  overrides: Record<string, Partial<ScheduleCourse> & { hidden?: boolean }>;
  customCourses: Array<ScheduleCourse & { customId: string }>;
  dateOverrides: Array<{
    id: string;
    date: string;
    action: "add" | "replace" | "cancel";
    targetSourceKey?: string;
    course?: ScheduleCourse & { customId: string };
  }>;
};

export type ScheduleResponse = {
  status: string;
  summary: string;
  data?: {
    fetchedAt?: string;
    count?: number;
    courses?: ScheduleCourse[];
    cacheAvailable?: boolean;
    customizations?: ScheduleCustomizations;
    currentSemester?: string;
    currentSemesterLabel?: string;
    selectedSemester?: string;
    selectedSemesterLabel?: string;
    availableSemesters?: ScheduleSemesterOption[];
    prefetchedSemesters?: Array<ScheduleSemesterOption & { count: number; cacheFile: string }>;
    prefetchFailures?: Array<ScheduleSemesterOption & { message: string }>;
    prefetchCounts?: Record<string, number>;
  };
  warnings?: string[];
};

export type LibraryFile = { path: string; relativePath: string; name: string; size: number; updatedAt: string; type: string; category: string; course: string; teacher: string };
export type NoticeItem = { id: string; title: string; url: string; publishedAt?: string; category?: string; detailStatus?: string };
export type TrainingPlanSource = {
  title: string;
  url: string;
  path: string[];
  source: string;
};
export type TrainingPlanCourseStatus = "completed" | "studying" | "not_taken" | "upcoming" | "unscheduled" | "unknown";
export type TrainingPlanCourse = {
  id: string;
  code: string;
  name: string;
  group: string;
  nature: string;
  credits: number;
  hours: number;
  semester: string;
  semesterLabel: string;
  semesterOptions: Array<{ value: string; label: string; status?: TrainingPlanCourseStatus }>;
  department: string;
  assessment: string;
  note: string;
  status: TrainingPlanCourseStatus;
  options: Array<{ name: string; code: string }>;
  choiceNote: string;
  source?: "plan" | "schedule";
  classificationSource?: "ehall" | "schedule_explicit" | "course_code" | "unknown";
  isGeneralElective?: boolean;
};
export type TrainingPlanStudyRequirement = {
  name: string;
  nature: string;
  requiredCredits: number;
  availableCredits: number;
  note: string;
};
export type TrainingPlan = {
  id: string;
  title: string;
  major: string;
  grade: string;
  department: string;
  track: string;
  degree: string;
  startSemester: string;
  requiredCredits: number;
  completedCredits: number;
  progress: number;
  objective: string;
  requirements: string;
  mainCourses: string;
  currentSemester: string;
  currentSemesterLabel: string;
  studyRequirements: TrainingPlanStudyRequirement[];
  courseGroupCount: number;
  courseCount: number;
  courses: TrainingPlanCourse[];
};
export type TrainingPlanResponse = {
  status: string;
  summary: string;
  data?: {
    status: string;
    message?: string;
    source: TrainingPlanSource;
    fetchedAt?: string;
    plans: TrainingPlan[];
  };
  warnings?: string[];
};
export type TrainingPlanAccess = TrainingPlanSource & {
  guidanceTitle: string;
  guidanceUrl: string;
};
export type TrainingPlanArchive = {
  id: string;
  title: string;
  url: string;
  year?: string;
  publishedAt?: string;
  articleTitle: string;
  articleUrl: string;
  source: string;
};
export type TrainingPlanSearchResponse = {
  status: string;
  summary: string;
  data?: {
    query: string;
    currentAccess: TrainingPlanAccess;
    archives: TrainingPlanArchive[];
    warnings?: string[];
  };
  warnings?: string[];
};

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error((await response.text()) || `请求失败（${response.status}）`);
  return response.json() as Promise<T>;
}

export function fetchSchedule(refresh = false, semester = "", includeSemesters = false, prefetchSemesters = false) {
  const params = new URLSearchParams({ refresh: String(refresh) });
  if (semester.trim()) params.set("semester", semester.trim());
  if (includeSemesters) params.set("includeSemesters", "true");
  if (prefetchSemesters) params.set("prefetchSemesters", "true");
  return jsonRequest<ScheduleResponse>(`/app/schedule?${params}`);
}

export function fetchTrainingPlans(refresh = false) {
  return jsonRequest<TrainingPlanResponse>(`/app/programs?refresh=${refresh}`);
}

export async function searchTrainingPlans(query = ""): Promise<TrainingPlanSearchResponse> {
  const params = new URLSearchParams();
  if (query.trim()) params.set("q", query.trim());
  const response = await jsonRequest<TrainingPlanResponse>(`/app/programs${params.size ? `?${params}` : ""}`);
  const source = response.data?.source ?? { title: "个人方案查询", url: "", path: [], source: "东南大学网上办事服务大厅" };
  return {
    status: response.status,
    summary: response.summary,
    warnings: response.warnings,
    data: {
      query,
      currentAccess: {
        ...source,
        guidanceTitle: source.title,
        guidanceUrl: source.url,
      },
      archives: (response.data?.plans ?? []).map((plan) => ({
        id: plan.id,
        title: plan.title,
        url: source.url,
        year: plan.grade,
        articleTitle: plan.title,
        articleUrl: source.url,
        source: source.source,
      })),
      warnings: response.warnings,
    },
  };
}

export function saveScheduleCustomizations(customizations: ScheduleCustomizations) {
  return jsonRequest<ScheduleResponse>("/app/schedule", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(customizations),
  });
}

export type FocusItem = {
  id: string;
  kind: "notice" | "course";
  title: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastCheckedAt?: string;
  lastAgentRunAt?: string;
  threadId?: string;
  resourceId?: string;
  description?: string;
  generatedQueries?: string[];
  keywords?: string[];
  categories?: string[];
  sourceKey?: string;
  sourceKeys?: string[];
  courseSource?: "schedule" | "portal";
  courseName?: string;
  teacherNames?: string[];
  semester?: string;
  summary?: boolean;
  summaryInstructions?: string;
};

export type FocusEvent = {
  id: string;
  focusId: string;
  focusTitle: string;
  kind: "notice" | "course";
  type: string;
  createdAt: string;
  article?: NoticeItem;
  courseDate?: string;
  courseName?: string;
  notePath?: string;
  message?: string;
  reason?: string;
};

export type FocusResponse = {
  status: string;
  summary: string;
  data?: { item?: FocusItem; items?: FocusItem[]; activity?: FocusEvent[]; jobs?: Record<string, unknown>; lastRunAt?: string };
  warnings?: string[];
};

export function fetchFocus() { return jsonRequest<FocusResponse>("/app/focus"); }
export function saveFocus(item: Partial<FocusItem>) {
  return jsonRequest<FocusResponse>("/app/focus", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(item),
  });
}
export function deleteFocus(id: string) {
  return jsonRequest<FocusResponse>(`/app/focus/${encodeURIComponent(id)}`, { method: "DELETE" });
}
export function runFocus() { return jsonRequest<FocusResponse>("/app/focus/run", { method: "POST" }); }

export type FocusRunClaim = {
  claimed?: boolean;
  reason?: "disabled" | "interval" | "running" | string;
  remainingSeconds?: number;
  runId?: string;
  item?: FocusItem;
};

export function claimFocusRun(id: string, options: { force?: boolean; respectInterval?: boolean } = {}) {
  return jsonRequest<{ status: string; data?: FocusRunClaim }>(`/app/focus/${encodeURIComponent(id)}/run/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options),
  });
}

export function recordFocusRun(id: string, runId: string, status: "completed" | "failed", message: string) {
  return jsonRequest<{ status: string }>(`/app/focus/${encodeURIComponent(id)}/run/record`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ runId, status, message }),
  });
}

export async function fetchFocusMessages(item: FocusItem): Promise<ChatMessage[]> {
  if (!item.threadId || !item.resourceId) return [];
  const query = new URLSearchParams({ resourceId: item.resourceId, perPage: "100" });
  const response = await fetch(`/api/memory/threads/${encodeURIComponent(item.threadId)}/messages?${query}`);
  if (!response.ok) return [];
  const data = await response.json() as { messages?: StoredMessage[] };
  const messages = await Promise.all((data.messages ?? []).map(async (stored): Promise<ChatMessage | null> => {
    if (stored.role !== "user" && stored.role !== "assistant") return null;
    const content = stored.content?.content ?? "";
    const attachments = stored.role === "user" ? await storedAttachments(stored.id, stored.content?.parts) : undefined;
    if (!content && stored.role === "user" && !attachments?.length) return null;
    return {
      id: stored.id,
      role: stored.role,
      content,
      createdAt: Date.parse(stored.createdAt),
      attachments,
      tools: stored.role === "assistant" ? storedTools(stored.content?.parts) : undefined,
      reasoningDone: stored.role === "assistant" && Boolean(stored.content?.parts?.some((part) => part.type === "reasoning")),
    };
  }));
  return messages.filter((message): message is ChatMessage => message !== null);
}

export async function loadFocusConversations(): Promise<Conversation[]> {
  const response = await fetchFocus();
  const conversations = await Promise.all((response.data?.items ?? []).map(async (item): Promise<Conversation | null> => {
    const messages = await fetchFocusMessages(item);
    if (!messages.length) return null;
    return {
      id: item.threadId || item.id,
      resourceId: item.resourceId,
      focusId: item.id,
      title: item.title,
      createdAt: Date.parse(item.createdAt),
      updatedAt: messages.at(-1)?.createdAt ?? Date.parse(item.updatedAt),
      messages,
    };
  }));
  return conversations.filter((conversation): conversation is Conversation => conversation !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function sendFocusMessage(id: string, message: string) {
  return jsonRequest<{ status: string; data?: { text?: string } }>(`/app/focus/${encodeURIComponent(id)}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
}

export type PortalCourse = {
  title: string;
  teacher: string;
  semester: string;
  lessonCount?: string;
};

export type PortalCourseSearchResponse = {
  status: string;
  summary: string;
  data?: { courses?: PortalCourse[]; availableSemesters?: string[]; selectedSemester?: string };
  warnings?: string[];
};

export function searchPortalCourses(description: string, semester = "") {
  const params = new URLSearchParams({ q: description });
  if (semester.trim()) params.set("semester", semester.trim());
  return jsonRequest<PortalCourseSearchResponse>(`/app/focus/courses/search?${params}`);
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

export async function uploadDocument(file: File) {
  const form = new FormData();
  form.append("file", file, file.name);
  const response = await fetch("/app/documents", { method: "POST", body: form });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(detail.error || `文档解析失败（${response.status}）`);
  }
  return await response.json() as { filename: string; extension: string; mediaType: string; contextRef: string; markdown: string; charCount: number };
}

export function fetchNotices(refresh = true) {
  return jsonRequest<{ status: string; summary: string; data?: { results?: NoticeItem[]; source?: string }; warnings?: string[] }>(`/app/notices?refresh=${refresh}`);
}

export type SettingsPayload = {
  provider: { name: string; baseUrl: string; editable: boolean };
  agentInstructions: string;
  fields: Array<{ name: string; secret: boolean; configured: boolean; value: string }>;
};

export function fetchSettings() {
  return jsonRequest<SettingsPayload>("/app/settings");
}

export function saveSettings(values: Record<string, string>, agentInstructions: string) {
  return jsonRequest<{ saved: string[]; agentInstructionsSaved: boolean; restartRequired: boolean }>("/app/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ values, agentInstructions }),
  });
}

export function saveFullAccess(enabled: boolean) {
  return jsonRequest<{ saved: string[]; agentInstructionsSaved: boolean; restartRequired: boolean }>("/app/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ values: { CVSTREAM_FULL_ACCESS: String(enabled) } }),
  });
}

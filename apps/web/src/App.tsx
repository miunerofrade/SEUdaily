import {
  ArrowUp,
  BookOpen,
  Bot,
  Check,
  ChevronRight,
  CircleStop,
  Clock3,
  Copy,
  FileAudio,
  FileText,
  FolderOpen,
  Link2,
  Menu,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  Plus,
  RefreshCw,
  SquareTerminal,
  TriangleAlert,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import { ChangeEvent, ClipboardEvent, FormEvent, isValidElement, KeyboardEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import rehypeKatex from "rehype-katex";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { deleteServerConversation, libraryPreviewUrl, loadServerConversations, RESOURCE_ID, streamAgent, uploadTemporaryImage } from "./api";
import type { AgentContent, AgentInput } from "./api";
import { normalizeMathMarkdown } from "./markdown";
import { SidebarIcon } from "./sidebar-icons";
import type { ChatMessage, Conversation, ImageAttachment, StreamEvent, ToolResult, ToolRun } from "./types";
import { LibraryPage, NoticesPage, SchedulePage, SettingsPage } from "./workspace-pages";

const STORAGE_KEY = "seudaily.web.conversations.v1";
const LEGACY_STORAGE_KEY = "cvstream.web.conversations.v1";
type AppView = "chat" | "schedule" | "library" | "notices" | "settings";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("css", css);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("python", python);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("xml", xml);

const languageAliases: Record<string, string> = {
  html: "xml", js: "javascript", jsx: "javascript", md: "markdown", py: "python",
  sh: "bash", shell: "bash", ts: "typescript", tsx: "typescript", vue: "xml",
};

const toolLabels: Record<string, string> = {
  getScheduleTool: "读取课表",
  authorizeScheduleTool: "课表登录",
  authorizePortalTool: "课程平台登录",
  listCoursesTool: "获取课程",
  searchCoursesTool: "搜索课程",
  findCourseSessionTool: "定位课次",
  captureCourseSessionTool: "抓取课程",
  captureCourseSessionsTool: "批量抓取",
  transcribeMediaTool: "本地转写",
  transcribeCloudAudioTool: "云端转写",
  extractSlidesTool: "提取课件",
  summarizeCourseTool: "生成笔记",
  searchJwcTool: "搜索教务通知",
  listJwcTool: "读取教务通知",
  getJwcArticleTool: "读取通知正文",
  searchCseNoticesTool: "搜索院系通知",
  getCseNoticeTool: "读取院系通知",
  webSearchTool: "搜索网页",
  webFetchTool: "读取网页",
  readTaskResultTool: "读取完整结果",
};

const toolNarrations: Record<string, { running: string; completed: string }> = {
  getScheduleTool: { running: "正在读取课表", completed: "已读取课表" },
  authorizeScheduleTool: { running: "正在打开课表登录", completed: "课表登录已完成" },
  authorizePortalTool: { running: "正在打开课程平台登录", completed: "课程平台登录已完成" },
  listCoursesTool: { running: "正在读取课程列表", completed: "已读取课程列表" },
  searchCoursesTool: { running: "正在搜索课程", completed: "已搜索课程" },
  findCourseSessionTool: { running: "正在定位课程课次", completed: "已定位课程课次" },
  captureCourseSessionTool: { running: "正在获取课程资料", completed: "已获取课程资料" },
  captureCourseSessionsTool: { running: "正在批量获取课程资料", completed: "已批量获取课程资料" },
  transcribeMediaTool: { running: "正在转写课程音视频", completed: "音视频转写已完成" },
  transcribeCloudAudioTool: { running: "正在进行云端转写", completed: "云端转写已完成" },
  extractSlidesTool: { running: "正在提取课件", completed: "已提取课件" },
  summarizeCourseTool: { running: "正在整理课程笔记", completed: "课程笔记已生成" },
  searchJwcTool: { running: "正在搜索教务通知", completed: "已搜索教务通知" },
  listJwcTool: { running: "正在读取教务通知", completed: "已读取教务通知" },
  getJwcArticleTool: { running: "正在阅读通知正文", completed: "已阅读通知正文" },
  searchCseNoticesTool: { running: "正在搜索院系通知", completed: "已搜索院系通知" },
  getCseNoticeTool: { running: "正在阅读院系通知", completed: "已阅读院系通知" },
  webSearchTool: { running: "正在搜索网页", completed: "网页搜索已完成" },
  webFetchTool: { running: "正在阅读网页", completed: "已阅读网页" },
  readTaskResultTool: { running: "正在读取任务结果", completed: "已读取任务结果" },
};

function uid() {
  return crypto.randomUUID();
}

function createConversation(): Conversation {
  const now = Date.now();
  return { id: uid(), resourceId: RESOURCE_ID, title: "新对话", createdAt: now, updatedAt: now, messages: [] };
}

function loadConversations(): Conversation[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
    const parsed = stored ? (JSON.parse(stored) as Conversation[]) : [];
    return Array.isArray(parsed) && parsed.length ? parsed : [createConversation()];
  } catch {
    return [createConversation()];
  }
}

function humanTime(timestamp: number) {
  const date = new Date(timestamp);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  return date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

function titleFromPrompt(prompt: string) {
  const cleaned = prompt.replace(/\s+/g, " ").trim();
  return cleaned.length > 18 ? `${cleaned.slice(0, 18)}…` : cleaned;
}

function messageContent(message: ChatMessage): AgentContent {
  const images = (message.attachments ?? []).filter((item) => item.dataUrl);
  if (!images.length) return message.content;
  return [
    ...(message.content ? [{ type: "text" as const, text: message.content }] : []),
    ...images.map((item) => ({ type: "file" as const, data: item.dataUrl!, mediaType: item.mediaType, filename: item.path ? fileName(item.path) : item.name })),
  ];
}

function attachmentSource(image: ImageAttachment) {
  return image.dataUrl ?? (image.path ? libraryPreviewUrl(image.path) : "");
}

function MessageImage({ image, onPreview }: { image: ImageAttachment; onPreview?: (image: ImageAttachment) => void }) {
  const source = attachmentSource(image);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [source]);
  if (!source || failed) return null;
  return <button type="button" onClick={() => onPreview?.(image)}><img src={source} alt={image.name} onError={() => setFailed(true)} /></button>;
}

function readImage(file: File): Promise<ImageAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ id: uid(), name: file.name || "粘贴的图片", mediaType: file.type, dataUrl: String(reader.result) });
    reader.onerror = () => reject(reader.error ?? new Error("图片读取失败"));
    reader.readAsDataURL(file);
  });
}

function fileName(path: string) {
  return path.split(/[\\/]/).pop() || path;
}

function formatBytes(value?: number) {
  if (value == null) return "";
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 ** 2).toFixed(1)} MB`;
}

function toolLabel(name: string) {
  return toolLabels[name] ?? name.replace(/Tool$/, "");
}

function toolNarration(tool: ToolRun, mode: "running" | "completed") {
  const copy = toolNarrations[tool.name];
  if (copy) return copy[mode];
  const label = toolLabel(tool.name);
  return mode === "running" ? `正在执行${label}` : `${label}已完成`;
}

function ToolGlyph({ name, size = 16 }: { name: string; size?: number }) {
  const lower = name.toLowerCase();
  if (lower.includes("command") || lower.includes("terminal") || lower.includes("workspace") || lower.includes("browser")) return <SquareTerminal size={size} />;
  if (lower.includes("summarize") || lower.includes("write") || lower.includes("edit") || lower.includes("note")) return <Pencil size={size} />;
  return <Wrench size={size} />;
}

function updateTool(tools: ToolRun[] = [], next: ToolRun) {
  const found = tools.findIndex((tool) => tool.id === next.id);
  if (found < 0) return [...tools, next];
  return tools.map((tool, index) => (index === found ? { ...tool, ...next } : tool));
}

function textFromNode(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textFromNode).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textFromNode(node.props.children);
  return "";
}

function CopyButton({ text, label = "复制", iconOnly = false }: { text: string; label?: string; iconOnly?: boolean }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const input = document.createElement("textarea");
      input.value = text;
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      input.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return <button type="button" className={`copy-button ${iconOnly ? "icon-only" : ""}`} onClick={copy} aria-label={copied ? "已复制" : label} title={copied ? "已复制" : label}>{copied ? <Check size={14} /> : <Copy size={14} />}{!iconOnly && <span>{copied ? "已复制" : label}</span>}</button>;
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const code = textFromNode(children).replace(/\n$/, "");
  const child = Array.isArray(children) ? children[0] : children;
  const className = isValidElement<{ className?: string }>(child) ? child.props.className ?? "" : "";
  const requestedLanguage = className.match(/language-([\w-]+)/)?.[1]?.toLowerCase();
  const language = requestedLanguage ? languageAliases[requestedLanguage] ?? requestedLanguage : undefined;
  const highlighted = language && hljs.getLanguage(language)
    ? hljs.highlight(code, { language }).value
    : hljs.highlightAuto(code).value;
  return (
    <div className="code-block">
      <div className="code-toolbar"><span>{requestedLanguage ?? "代码"}</span><CopyButton text={code} label="复制代码" iconOnly /></div>
      <pre><code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted }} /></pre>
    </div>
  );
}

function ToolCard({ tool, compact = false }: { tool: ToolRun; compact?: boolean }) {
  const result = tool.result;
  const failed = result?.status === "failed" || tool.state === "failed";
  return (
    <div className={`tool-card ${compact ? "compact" : ""} ${failed ? "failed" : ""}`}>
      <div className="tool-card-head">
        <span className={`tool-icon ${tool.state === "running" ? "active" : ""}`}>{failed ? <TriangleAlert size={15} /> : <ToolGlyph name={tool.name} size={15} />}</span>
        <div>
          <strong>{failed ? result?.summary ?? `${toolLabel(tool.name)}失败` : result?.summary ?? toolNarration(tool, tool.state === "running" ? "running" : "completed")}</strong>
        </div>
      </div>
    </div>
  );
}

function ToolActivity({ tools, streaming, hasAnswer }: { tools: ToolRun[]; streaming?: boolean; hasAnswer: boolean }) {
  const [open, setOpen] = useState(Boolean(streaming));
  const runningTool = [...tools].reverse().find((tool) => tool.state === "running");
  const failedCount = tools.filter((tool) => tool.state === "failed").length;

  useEffect(() => {
    if (!streaming && hasAnswer) setOpen(false);
    else if (streaming) setOpen(true);
  }, [streaming, hasAnswer]);

  const focusTool = runningTool ?? tools.at(-1)!;
  const statusText = runningTool
    ? toolNarration(runningTool, "running")
    : streaming
      ? "工具执行完成，正在生成回答"
      : failedCount
        ? `${failedCount} 项操作失败`
        : tools.length === 1
          ? toolNarration(tools[0], "completed")
          : `已完成 ${tools.length} 项操作`;

  return (
    <div className={`tool-activity ${open ? "open" : ""}`}>
      <button type="button" className="tool-activity-toggle" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span className={`tool-activity-status ${runningTool ? "running" : failedCount ? "failed" : "done"}`}>
          {failedCount && !runningTool ? <TriangleAlert size={16} /> : <ToolGlyph name={focusTool.name} size={16} />}
        </span>
        <span>{statusText}</span>
        <ChevronRight className="tool-activity-chevron" size={15} />
      </button>
      {open && (
        <div className="tool-activity-list">
          {tools.map((tool) => (
            <div className="tool-activity-item" key={tool.id}>
              <span className={tool.state === "running" ? "active" : ""}>{tool.state === "failed" ? <TriangleAlert size={14} /> : <ToolGlyph name={tool.name} size={14} />}</span>
              <div><strong>{tool.result?.summary ?? toolNarration(tool, tool.state === "running" ? "running" : "completed")}</strong></div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Message({ message, canRegenerate = false, disabled = false, onEdit, onRegenerate, onPreviewImage }: {
  message: ChatMessage;
  canRegenerate?: boolean;
  disabled?: boolean;
  onEdit?: (message: ChatMessage, content: string) => void;
  onRegenerate?: (message: ChatMessage) => void;
  onPreviewImage?: (image: ImageAttachment) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(message.content);

  if (message.role === "user") {
    return (
      <article className="message user-message">
        {editing ? (
          <div className="prompt-editor">
            <textarea value={editValue} onChange={(event) => setEditValue(event.target.value)} autoFocus />
            <div><button type="button" onClick={() => { setEditing(false); setEditValue(message.content); }}>取消</button><button type="button" className="primary" disabled={!editValue.trim()} onClick={() => { setEditing(false); onEdit?.(message, editValue.trim()); }}>发送</button></div>
          </div>
        ) : <div className="user-bubble">{!!message.attachments?.length && <div className="message-images">{message.attachments.map((image) => <MessageImage key={image.id} image={image} onPreview={onPreviewImage} />)}</div>}{message.content && <span>{message.content}</span>}</div>}
        {!editing && <div className="user-meta"><time>{humanTime(message.createdAt)}</time><CopyButton text={message.content} label="复制提示词" iconOnly /><button type="button" className="message-action" aria-label="编辑提示词" title="编辑提示词" disabled={disabled} onClick={() => setEditing(true)}><Pencil size={14} /></button></div>}
      </article>
    );
  }

  return (
    <article className="message assistant-message">
      <div className="assistant-body">
        {(message.reasoningActive || message.reasoningDone) && (
          <div className={`reasoning-status ${message.reasoningActive ? "active" : "done"}`}>
            <span>{message.reasoningActive ? "正在思考" : "已完成思考"}</span>
          </div>
        )}
        {!!message.tools?.length && (
          <div className="inline-tools">
            <ToolActivity tools={message.tools} streaming={message.streaming} hasAnswer={Boolean(message.content)} />
          </div>
        )}
        {message.content ? (
          <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} components={{
            pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
            a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer">{children}</a>,
            table: ({ children }) => <div className="table-scroll"><table>{children}</table></div>,
          }}>{normalizeMathMarkdown(message.content)}</ReactMarkdown></div>
        ) : message.streaming ? (
          <div className="thinking"><span /><span /><span /> 正在思考</div>
        ) : null}
        {message.error && <div className="message-error"><TriangleAlert size={16} />{message.error}</div>}
        {!message.streaming && !message.error && <div className="message-meta"><time>{humanTime(message.createdAt)}</time>{message.content && <CopyButton text={message.content} label="复制回答" iconOnly />}{canRegenerate && <button type="button" className="message-action" aria-label="重新生成" title="重新生成" disabled={disabled} onClick={() => onRegenerate?.(message)}><RefreshCw size={14} /></button>}</div>}
      </div>
    </article>
  );
}

export default function App() {
  const [conversations, setConversations] = useState<Conversation[]>(loadConversations);
  const [activeId, setActiveId] = useState(() => conversations[0].id);
  const [view, setView] = useState<AppView>("chat");
  const [draft, setDraft] = useState("");
  const [pendingImages, setPendingImages] = useState<ImageAttachment[]>([]);
  const [previewImage, setPreviewImage] = useState<ImageAttachment | null>(null);
  const [attachmentError, setAttachmentError] = useState("");
  const [rightOpen, setRightOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Conversation | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const messageEndRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const active = conversations.find((item) => item.id === activeId) ?? conversations[0];
  const allTools = useMemo(() => active.messages.flatMap((message) => message.tools ?? []).reverse(), [active.messages]);
  const allArtifacts = useMemo(() => allTools.flatMap((tool) => tool.result?.artifacts ?? []), [allTools]);
  const allCitations = useMemo(() => allTools.flatMap((tool) => tool.result?.citations ?? []), [allTools]);
  const lastAssistantId = [...active.messages].reverse().find((message) => message.role === "assistant")?.id;

  const syncServerHistory = useCallback(async () => {
    try {
      const remote = await loadServerConversations();
      if (!remote.length) return;
      setConversations((current) => {
        const remoteIds = new Set(remote.map((conversation) => conversation.id));
        const localOnly = current.filter((conversation) => !remoteIds.has(conversation.id));
        const hydrated = remote.map((conversation) => {
          const local = current.find((item) => item.id === conversation.id);
          if (!local) return conversation;
          return { ...conversation, messages: conversation.messages.map((message, index) => {
            const localMessage = local.messages[index];
            if (!message.attachments?.length || !localMessage?.attachments?.length) return message;
            return { ...message, attachments: message.attachments.map((attachment, attachmentIndex) => ({ ...attachment, path: localMessage.attachments?.[attachmentIndex]?.path })) };
          }) };
        });
        return [...hydrated, ...localOnly].sort((a, b) => b.updatedAt - a.updatedAt);
      });
    } catch {
      // The browser cache remains available while the local Agent server is offline.
    }
  }, []);

  useEffect(() => {
    const cacheSafe = conversations.map((conversation) => ({
      ...conversation,
      messages: conversation.messages.map((message) => ({
        ...message,
        attachments: message.attachments?.flatMap(({ dataUrl: _dataUrl, ...attachment }) => attachment.path ? [attachment] : []),
      })),
    }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cacheSafe));
  }, [conversations]);

  useEffect(() => {
    fetch("/api/agents", { signal: AbortSignal.timeout(4000) })
      .then((response) => { if (response.ok) void syncServerHistory(); })
      .catch(() => undefined);
    const handleFocus = () => void syncServerHistory();
    const handleVisibility = () => { if (document.visibilityState === "visible") void syncServerHistory(); };
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [syncServerHistory]);

  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth <= 1180) setRightOpen(false);
      if (window.innerWidth > 760) setNavOpen(false);
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    if (!deleteTarget) return;
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !deleting) setDeleteTarget(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [deleteTarget, deleting]);

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [active.messages]);

  function mutateMessage(conversationId: string, messageId: string, updater: (message: ChatMessage) => ChatMessage) {
    setConversations((current) => current.map((conversation) => conversation.id === conversationId
      ? { ...conversation, updatedAt: Date.now(), messages: conversation.messages.map((message) => message.id === messageId ? updater(message) : message) }
      : conversation));
  }

  function newChat() {
    if (sending) abortRef.current?.abort();
    setView("chat");
    setRightOpen(false);
    if (!active.messages.length) {
      setDraft("");
      setNavOpen(false);
      return;
    }
    const conversation = createConversation();
    setConversations((current) => [conversation, ...current]);
    setActiveId(conversation.id);
    setDraft("");
    setPendingImages([]);
    setNavOpen(false);
  }

  async function confirmDeleteConversation() {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    setDeleteError("");
    try {
      await deleteServerConversation(deleteTarget.id, deleteTarget.resourceId);
      const remaining = conversations.filter((conversation) => conversation.id !== deleteTarget.id);
      if (remaining.length) {
        setConversations(remaining);
        if (activeId === deleteTarget.id) setActiveId(remaining[0].id);
      } else {
        const blank = createConversation();
        setConversations([blank]);
        setActiveId(blank.id);
      }
      setDeleteTarget(null);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "删除会话失败，请稍后重试。");
    } finally {
      setDeleting(false);
    }
  }

  function handleStreamEvent(conversationId: string, messageId: string, event: StreamEvent) {
    const payload = event.payload ?? {};
    if (event.type === "reasoning-start" || event.type === "reasoning-delta") {
      mutateMessage(conversationId, messageId, (message) => ({ ...message, reasoningActive: true, reasoningDone: true }));
    }
    if (event.type === "reasoning-end") {
      mutateMessage(conversationId, messageId, (message) => ({ ...message, reasoningActive: false, reasoningDone: true }));
    }
    if (event.type === "text-delta" && typeof payload.text === "string") {
      mutateMessage(conversationId, messageId, (message) => ({ ...message, content: message.content + payload.text, reasoningActive: false }));
    }
    if (event.type === "tool-call-input-streaming-start" || event.type === "tool-call") {
      const id = String(payload.toolCallId ?? uid());
      const name = String(payload.toolName ?? "工具调用");
      mutateMessage(conversationId, messageId, (message) => ({
        ...message,
        tools: updateTool(message.tools, { id, name, state: "running", args: payload.args as Record<string, unknown> | undefined }),
      }));
    }
    if (event.type === "tool-result" || event.type === "tool-output") {
      const id = String(payload.toolCallId ?? uid());
      const rawResult = payload.result ?? payload.output;
      const result = (rawResult && typeof rawResult === "object" && "value" in rawResult
        ? (rawResult as { value: unknown }).value
        : rawResult) as ToolResult;
      mutateMessage(conversationId, messageId, (message) => ({
        ...message,
        tools: updateTool(message.tools, {
          id,
          name: String(payload.toolName ?? "工具调用"),
          state: result?.status === "failed" ? "failed" : "completed",
          args: payload.args as Record<string, unknown> | undefined,
          result,
        }),
      }));
    }
    if (event.type === "tool-error" || event.type === "tool-output-denied") {
      const id = String(payload.toolCallId ?? uid());
      mutateMessage(conversationId, messageId, (message) => ({
        ...message,
        tools: updateTool(message.tools, {
          id,
          name: String(payload.toolName ?? "工具调用"),
          state: "failed",
          result: {
            status: "failed",
            taskId: id,
            summary: typeof payload.error === "string" ? payload.error : "工具执行失败或未获授权。",
            artifacts: [],
            citations: [],
            warnings: [],
            metrics: {},
          },
        }),
      }));
    }
    if (event.type === "finish") {
      mutateMessage(conversationId, messageId, (message) => ({
        ...message,
        streaming: false,
        reasoningActive: false,
        tools: message.tools?.map((tool) => tool.state === "running" ? { ...tool, state: "completed" as const } : tool),
      }));
    }
  }

  async function executeStream(conversationId: string, assistantId: string, input: AgentInput) {
    setSending(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await streamAgent({
        message: input,
        threadId: conversationId,
        signal: controller.signal,
        onEvent: (event) => handleStreamEvent(conversationId, assistantId, event),
      });
      mutateMessage(conversationId, assistantId, (message) => ({
        ...message,
        streaming: false,
        reasoningActive: false,
        tools: message.tools?.map((tool) => tool.state === "running" ? { ...tool, state: "completed" as const } : tool),
      }));
    } catch (error) {
      const aborted = controller.signal.aborted;
      mutateMessage(conversationId, assistantId, (message) => ({
        ...message,
        streaming: false,
        reasoningActive: false,
        error: aborted ? "已停止本次回答。" : error instanceof Error ? error.message : "请求失败，请稍后重试。",
        tools: message.tools?.map((tool) => tool.state === "running" ? { ...tool, state: "failed" as const } : tool),
      }));
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setSending(false);
    }
  }

  async function send(prompt = draft) {
    const text = prompt.trim();
    if ((!text && !pendingImages.length) || sending) return;
    const conversationId = active.id;
    const assistantId = uid();
    const now = Date.now();
    const attachments = pendingImages;
    const userMessage: ChatMessage = { id: uid(), role: "user", content: text, createdAt: now, attachments };
    const assistantMessage: ChatMessage = { id: assistantId, role: "assistant", content: "", createdAt: now, tools: [], streaming: true };
    setDraft("");
    setPendingImages([]);
    setConversations((current) => current.map((conversation) => conversation.id === conversationId ? {
      ...conversation,
      title: conversation.messages.length ? conversation.title : titleFromPrompt(text || "图片对话"),
      updatedAt: now,
      messages: [...conversation.messages, userMessage, assistantMessage],
    } : conversation));
    await executeStream(conversationId, assistantId, attachments.length ? [{ role: "user", content: messageContent(userMessage) }] : text);
  }

  async function editPrompt(message: ChatMessage, content: string) {
    if (sending) return;
    const index = active.messages.findIndex((item) => item.id === message.id);
    if (index < 0) return;
    const now = Date.now();
    const branch = createConversation();
    const editedUser: ChatMessage = { id: uid(), role: "user", content, createdAt: now };
    const assistant: ChatMessage = { id: uid(), role: "assistant", content: "", createdAt: now, tools: [], streaming: true };
    const prefix = active.messages.slice(0, index).filter((item) => !item.streaming && !item.error);
    const messages = [...prefix, editedUser, assistant];
    const next: Conversation = { ...branch, title: titleFromPrompt(content), updatedAt: now, messages };
    setConversations((current) => [next, ...current]);
    setActiveId(next.id);
    setNavOpen(false);
    const input = [...prefix, editedUser].map((item) => ({ role: item.role, content: messageContent(item) }));
    await executeStream(next.id, assistant.id, input);
  }

  async function regenerate(message: ChatMessage) {
    if (sending) return;
    const index = active.messages.findIndex((item) => item.id === message.id);
    if (index < 1) return;
    const prefix = active.messages.slice(0, index).filter((item) => !item.streaming && !item.error);
    const prompt = [...prefix].reverse().find((item) => item.role === "user")?.content;
    if (!prompt) return;
    const now = Date.now();
    const branch = createConversation();
    const assistant: ChatMessage = { id: uid(), role: "assistant", content: "", createdAt: now, tools: [], streaming: true };
    const next: Conversation = { ...branch, title: active.title, updatedAt: now, messages: [...prefix, assistant] };
    setConversations((current) => [next, ...current]);
    setActiveId(next.id);
    const input = prefix.map((item) => ({ role: item.role, content: messageContent(item) }));
    await executeStream(next.id, assistant.id, input);
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void send();
  }

  async function addImages(files: File[]) {
    const accepted = files.filter((file) => file.type.startsWith("image/") && file.size <= 10 * 1024 * 1024).slice(0, Math.max(0, 4 - pendingImages.length));
    if (!accepted.length) {
      setAttachmentError("仅支持 10 MB 以内的图片，一次最多 4 张。");
      return;
    }
    setAttachmentError("");
    try {
      const images = await Promise.all(accepted.map(async (file) => {
        const image = await readImage(file);
        const stored = await uploadTemporaryImage({ dataUrl: image.dataUrl!, name: image.name });
        return { ...image, path: stored.path };
      }));
      setPendingImages((current) => [...current, ...images].slice(0, 4));
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : "图片暂存失败");
    }
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const images = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
    if (!images.length) return;
    event.preventDefault();
    void addImages(images);
  }

  function onImageInput(event: ChangeEvent<HTMLInputElement>) {
    void addImages(Array.from(event.target.files ?? []));
    event.target.value = "";
  }

  const composer = (
    <form className={`composer-wrap ${active.messages.length ? "" : "centered"}`} onSubmit={onSubmit}>
      <div className="composer">
        {attachmentError && <div className="composer-attachment-error">{attachmentError}</div>}
        {!!pendingImages.length && <div className={`composer-images ${pendingImages.length > 2 ? "compact" : ""}`}>{pendingImages.map((image) => <div key={image.id}><button type="button" className="composer-image-preview" aria-label={`预览图片：${image.name}`} onClick={() => setPreviewImage(image)}><img src={image.dataUrl} alt={image.name} /></button><button type="button" className="composer-image-remove" aria-label={`移除图片：${image.name}`} onClick={() => setPendingImages((current) => current.filter((item) => item.id !== image.id))}><X size={12} /></button></div>)}</div>}
        <button type="button" className="composer-add" aria-label="添加图片" title="添加图片" onClick={() => fileInputRef.current?.click()}><Plus size={20} /></button>
        <input ref={fileInputRef} className="image-input" type="file" accept="image/*" multiple onChange={onImageInput} />
        <textarea value={draft} onChange={(event) => setDraft(event.target.value)} onPaste={onPaste} onKeyDown={onComposerKeyDown} placeholder="问问 SEUdaily，或粘贴图片" rows={1} disabled={sending} />
        {sending ? (
          <button type="button" className="send-button stop" onClick={() => abortRef.current?.abort()} aria-label="停止回答"><CircleStop size={19} /></button>
        ) : (
          <button type="submit" className="send-button" disabled={!draft.trim() && !pendingImages.length} aria-label="发送消息"><ArrowUp size={20} /></button>
        )}
      </div>
      {!!active.messages.length && <div className="composer-hint"><span>Enter 发送 · Shift + Enter 换行</span><span>AI 可能出错，请核对重要信息</span></div>}
    </form>
  );

  function openView(next: AppView) {
    setView(next);
    setRightOpen(false);
    setNavOpen(false);
  }

  return (
    <div className={`app-shell ${rightOpen && view === "chat" ? "with-inspector" : ""}`}>
      <div className={`mobile-scrim ${navOpen ? "visible" : ""}`} onClick={() => setNavOpen(false)} />
      <aside className={`sidebar ${navOpen ? "open" : ""}`}>
        <div className="brand">
          <div><strong>SEUdaily</strong></div>
          <button className="icon-button sidebar-close" onClick={() => setNavOpen(false)} aria-label="关闭侧栏"><X size={19} /></button>
        </div>
        <nav className="primary-nav" aria-label="主要功能">
          <button className={view === "chat" && !active.messages.length ? "active" : ""} onClick={newChat}><SidebarIcon kind="compose" />新对话</button>
          <button className={view === "schedule" ? "active" : ""} onClick={() => openView("schedule")}><SidebarIcon kind="schedule" />课表</button>
          <button className={view === "library" ? "active" : ""} onClick={() => openView("library")}><SidebarIcon kind="library" />资料库</button>
          <button className={view === "notices" ? "active" : ""} onClick={() => openView("notices")}><SidebarIcon kind="notice" />教务通知</button>
        </nav>
        <nav className="conversation-list" aria-label="历史对话">
          <div className="nav-label">最近</div>
          {[...conversations].filter((conversation) => conversation.messages.length).sort((a, b) => b.updatedAt - a.updatedAt).map((conversation) => (
            <div key={conversation.id} className={`conversation-row ${view === "chat" && conversation.id === active.id ? "active" : ""}`}>
              <button className="conversation-item" onClick={() => { setActiveId(conversation.id); setView("chat"); setNavOpen(false); }}>
                <span><strong>{conversation.title}</strong><small>{humanTime(conversation.updatedAt)}</small></span>
              </button>
              <button
                type="button"
                className="conversation-delete"
                aria-label={`删除会话：${conversation.title}`}
                title="删除会话"
                onClick={() => { setDeleteError(""); setDeleteTarget(conversation); }}
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </nav>
        <div className="sidebar-footer">
          <button className={`settings-button ${view === "settings" ? "active" : ""}`} onClick={() => openView("settings")}><SidebarIcon kind="settings" /><span>设置</span></button>
        </div>
      </aside>

      {view === "chat" ? <main className={`chat-panel ${active.messages.length ? "has-messages" : "empty"}`}>
        <header className="topbar">
          <button className="icon-button menu-button" onClick={() => setNavOpen(true)} aria-label="打开导航"><Menu size={20} /></button>
          {active.messages.length ? <h1>{active.title}</h1> : <span className="topbar-product">SEUdaily</span>}
          <div className="topbar-actions">
            <button className="icon-button" onClick={() => setRightOpen((value) => !value)} aria-label={rightOpen ? "关闭任务面板" : "打开任务面板"}>
              {rightOpen ? <PanelRightClose size={20} /> : <PanelRightOpen size={20} />}
            </button>
          </div>
        </header>

        <section className="chat-scroll">
          {!active.messages.length ? (
            <div className="welcome">
              <div className="welcome-core">
                <h2>今天想学点什么？</h2>
                {composer}
              </div>
            </div>
          ) : (
            <div className="message-list">
              {active.messages.map((message) => <Message key={message.id} message={message} disabled={sending} canRegenerate={message.id === lastAssistantId} onEdit={editPrompt} onRegenerate={regenerate} onPreviewImage={setPreviewImage} />)}
              <div ref={messageEndRef} />
            </div>
          )}
        </section>
        {!!active.messages.length && composer}
      </main> : <main className="workspace-panel">
        <header className="workspace-mobile-bar"><button className="icon-button menu-button" onClick={() => setNavOpen(true)} aria-label="打开导航"><Menu size={20} /></button><span>SEUdaily</span></header>
        <div className="workspace-scroll">
          {view === "schedule" && <SchedulePage />}
          {view === "library" && <LibraryPage />}
          {view === "notices" && <NoticesPage />}
          {view === "settings" && <SettingsPage />}
        </div>
      </main>}

      <aside className={`inspector ${rightOpen && view === "chat" ? "open" : ""}`}>
        <div className="inspector-head"><div><span className="eyebrow">WORKSPACE</span><h2>任务与资料</h2></div><button className="icon-button" onClick={() => setRightOpen(false)}><X size={19} /></button></div>
        <div className="inspector-scroll">
          <section className="inspector-section">
            <div className="section-title"><span>执行记录</span><small>{allTools.length}</small></div>
            {allTools.length ? <div className="task-list">{allTools.map((tool) => <ToolCard key={tool.id} tool={tool} />)}</div> : (
              <div className="empty-card"><Clock3 size={20} /><p>Agent 调用工具后，执行过程会出现在这里。</p></div>
            )}
          </section>
          <section className="inspector-section">
            <div className="section-title"><span>生成资料</span><small>{allArtifacts.length}</small></div>
            {allArtifacts.length ? <div className="resource-list">{allArtifacts.map((artifact) => (
              <div className="resource-item" key={artifact.id} title={artifact.path}>
                <span>{artifact.type === "audio" ? <FileAudio size={17} /> : artifact.type === "slides" ? <BookOpen size={17} /> : <FileText size={17} />}</span>
                <div><strong>{fileName(artifact.path)}</strong><small>{artifact.type.toUpperCase()} {formatBytes(artifact.sizeBytes)}</small></div>
              </div>
            ))}</div> : <div className="empty-card small"><FolderOpen size={19} /><p>字幕、课件和笔记会集中显示。</p></div>}
          </section>
          {!!allCitations.length && <section className="inspector-section">
            <div className="section-title"><span>引用来源</span><small>{allCitations.length}</small></div>
            <div className="citation-list">{allCitations.map((citation, index) => citation.url ? (
              <a key={`${citation.id}-${index}`} href={citation.url} target="_blank" rel="noreferrer"><span>{citation.id}</span><div><strong>{citation.title}</strong><small>{citation.type}</small></div><Link2 size={14} /></a>
            ) : (
              <div className="citation-item" key={`${citation.id}-${index}`} title={citation.localPath}><span>{citation.id}</span><div><strong>{citation.title}</strong><small>{citation.type}</small></div></div>
            ))}</div>
          </section>}
        </div>
        <div className="privacy-note"><Bot size={16} /><span>课程凭据不会发送到对话内容中</span></div>
      </aside>
      {previewImage && attachmentSource(previewImage) && <div className="preview-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setPreviewImage(null); }}><div className="image-preview-dialog" role="dialog" aria-modal="true" aria-label="图片预览"><button type="button" className="preview-close" aria-label="关闭预览" onClick={() => setPreviewImage(null)}><X size={19} /></button><img src={attachmentSource(previewImage)} alt={previewImage.name} /></div></div>}
      {deleteTarget && (
        <div
          className="confirm-overlay"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !deleting) setDeleteTarget(null);
          }}
        >
          <div className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-dialog-title">
            <div className="confirm-icon"><Trash2 size={18} /></div>
            <h2 id="delete-dialog-title">删除这个对话？</h2>
            <p>“{deleteTarget.title}”及其消息记录将从本机永久删除，无法恢复。</p>
            {deleteError && <div className="confirm-error">{deleteError}</div>}
            <div className="confirm-actions">
              <button type="button" disabled={deleting} onClick={() => setDeleteTarget(null)}>取消</button>
              <button type="button" className="danger" disabled={deleting} onClick={() => void confirmDeleteConversation()}>
                {deleting ? "正在删除…" : "删除"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

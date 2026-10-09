import { Message } from "./chat/message";
import { SourcesSidebar, messageSources } from "./chat/sources-sidebar";
import { brokerCapabilityName } from "./chat/tool-presentation";
import { WeChatPanel } from './wechat';
import { MAX_ATTACHMENTS } from "../../../src/shared/attachment-limits";
import { RuntimePreparationNotice } from './runtime-preparation';
import { CampusSmsDialog } from "./campus-sms";
import { useVpn, VpnPanel, VpnLicense } from './vpn-panel';
import { useRamDisk } from './ramdisk';
import { matchSlashCommands, slashCommandHint } from './slash-commands';
import { packageDocumentContent } from '../../../src/shared/document-content';
import { useImeComposition } from "./ime";
import { PromptVersions } from "./prompt-versions";
import { messageContent, editedDocumentContent, writeConversationCache } from "./conversation-cache";
import { conversationPath, withParents, latestDescendant } from '../../../src/shared/conversation-tree';
import { conversationUsage, normalizedUsage, telemetryLabel } from "../../../src/shared/telemetry";
import { ArrowUp, BookOpen, CircleAlert, CircleStop, FileAudio, FileText, Hand, ListChecks, Menu, Paperclip, PanelLeft, Plus, Sparkles, Trash2, X } from "lucide-react";
import { ChangeEvent, ClipboardEvent, FormEvent, KeyboardEvent, ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { executeAgentActionRequest, executeAgentAuthRequest, deleteServerConversation, fetchSettings, fetchSkills, type ProjectSkill, generateConversationTitle, libraryPreviewUrl, loadFocusConversations, loadServerConversations, loadConversationMessages, RESOURCE_ID, saveAccessMode, streamAgent, uploadDocument, uploadTemporaryImage } from "./api";
import type { AgentActionRequest, AgentAuthRequest, AgentInput } from "./api";
import { RamDiskPanel } from "./ramdisk-panel";
import { SidebarIcon } from "./sidebar-icons";
import { addProcessTool, appendProcessText, finalizeProcessAnswer } from "./stream-state";
import type { ChatMessage, Conversation, DocumentAttachment, ImageAttachment, StreamEvent, ToolResult, ToolRun } from "./types";
import { FocusPage, LibraryPage, NoticesPage, ProgramsPage, SchedulePage, SettingsPage } from "./workspace-pages";

const STORAGE_KEY = "seudaily.web.conversations.v1";
const LEGACY_STORAGE_KEY = "cvstream.web.conversations.v1";
type AppView = "chat" | "schedule" | "programs" | "focus" | "library" | "notices" | "settings";

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

function titleFromPrompt(prompt: string) {
  const cleaned = prompt.replace(/\s+/g, " ").trim();
  return cleaned.length > 18 ? `${cleaned.slice(0, 18)}…` : cleaned;
}

function attachmentSource(image: ImageAttachment) {
  return image.dataUrl ?? (image.path ? libraryPreviewUrl(image.path) : "");
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

function updateTool(tools: ToolRun[] = [], next: ToolRun) {
  const found = tools.findIndex((tool) => tool.id === next.id);
  if (found < 0) return [...tools, next];
  return tools.map((tool, index) => (index === found ? {
    ...tool,
    ...next,
    args: next.args ?? tool.args,
    approvalId: next.approvalId ?? tool.approvalId,
  } : tool));
}

export default function App() {
  const ime = useImeComposition();
  const [conversations, setConversations] = useState<Conversation[]>(loadConversations);
  const [focusConversations, setFocusConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState(() => conversations[0].id);
  const [selectedFocusId, setSelectedFocusId] = useState("");
  const [view, setView] = useState<AppView>("chat");
  const [draft, setDraft] = useState("");
  const [agentInfo, setAgentInfo] = useState({ model: "—", effort: "—" });
  useEffect(() => {
    if (view !== "chat") return;
    const controller = new AbortController();
    void fetch("/app/agent-info", { signal: controller.signal })
      .then(async response => {
        if (!response.ok) return;
        const info = await response.json();
        if (!controller.signal.aborted) setAgentInfo({
          model: typeof info.model === "string" ? info.model : "—",
          effort: typeof info.effort === "string" ? info.effort : "—",
        });
      }).catch(() => undefined);
    return () => controller.abort();
  }, [view]);
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null);
  const [projectSkills, setProjectSkills] = useState<ProjectSkill[]>([]);
  const [skillError, setSkillError] = useState("");
  useEffect(() => {
    let stopped = false;
    void fetchSkills().then(result => { if (!stopped) setProjectSkills(result.skills); }).catch(() => { if (!stopped) setSkillError("技能目录暂时不可用"); });
    return () => { stopped = true; };
  }, []);
  const attachmentUploadRef = useRef<object | null>(null);
  const [pendingImages, setPendingImages] = useState<ImageAttachment[]>([]);
  const [pendingDocuments, setPendingDocuments] = useState<DocumentAttachment[]>([]);
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
  const [previewImage, setPreviewImage] = useState<ImageAttachment | null>(null);
  const [attachmentError, setAttachmentError] = useState("");
  const [composerMenuOpen, setComposerMenuOpen] = useState(false);
  const [fullAccess, setFullAccess] = useState(false);
  const [fullAccessExtra, setFullAccessExtra] = useState(false);
  const [permissionSaving, setPermissionSaving] = useState(false);
  const [permissionError, setPermissionError] = useState("");
  const [conversationError, setConversationError] = useState("");
  const [historyReload, setHistoryReload] = useState(0);
  const [permissionMenuOpen, setPermissionMenuOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [sourceMessage, setSourceMessage] = useState<ChatMessage | null>(null);
  useEffect(() => { setSourceMessage(null); }, [activeId, view, selectedFocusId]);
  const closeSources = useCallback(() => setSourceMessage(null), []);
  function openSources(message: ChatMessage) {
    setRightOpen(false);
    setSourceMessage(current => current?.id === message.id ? null : message);
  }
  const vpn = useVpn(rightOpen && view === "chat");
  const ramdisk = useRamDisk(rightOpen && view === "chat");
  const panelToggleRef = useRef<HTMLButtonElement>(null);
  const inspectorRef = useRef<HTMLElement>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [queueState, setQueueState] = useState<{active:boolean;items:any[];progress?:{text:string};runToken?:string}>({active:false,items:[]});
  const queueStateRef = useRef(queueState);
  queueStateRef.current = queueState;
  const submittingRef = useRef(false);
  const [stopping, setStopping] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Conversation | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const activeStreamRef = useRef<{threadId:string;resourceId:string;runToken:string} | null>(null);
  const messageEndRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const slashListRef = useRef<HTMLDivElement | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const slashMatches = matchSlashCommands(draft);
  const slashOpen = !slashDismissed && !sending && slashMatches.length > 0;
  const selectedSlashIndex = Math.min(slashIndex, Math.max(0, slashMatches.length - 1));
  useEffect(() => { setSlashIndex(0); setSlashDismissed(false); }, [draft, activeId]);
  useLayoutEffect(() => {
    if (!slashOpen) return;
    const list = slashListRef.current;
    const row = list?.children[selectedSlashIndex] as HTMLElement | undefined;
    if (!list || !row) return;
    const top = row.offsetTop - list.offsetTop;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (top + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + row.offsetHeight - list.clientHeight;
  }, [slashOpen, selectedSlashIndex, draft]);

  useLayoutEffect(() => {
    if (!rightOpen || view !== "chat") return;
    const updateOrigin = () => {
      const button = panelToggleRef.current;
      const panel = inspectorRef.current;
      if (!button || !panel) return;
      const anchor = button.getBoundingClientRect();
      panel.style.transformOrigin = `${anchor.left + anchor.width / 2 - panel.offsetLeft}px ${anchor.top + anchor.height / 2 - panel.offsetTop}px`;
    };
    updateOrigin();
    window.addEventListener("resize", updateOrigin);
    return () => window.removeEventListener("resize", updateOrigin);
  }, [rightOpen, view]);

  const activeRaw = conversations.find((item) => item.id === activeId) ?? conversations[0];
  function resetComposerAttachments() {
    attachmentUploadRef.current = null;
    setUploadingAttachments(false);
    setPendingImages([]); setPendingDocuments([]);
    setAttachmentError(""); setPreviewImage(null);
    setSelectedSkill(null);
  }
  useLayoutEffect(() => {
    resetComposerAttachments();
  }, [activeRaw.id]);
  const activeMessages=useMemo(()=>activeRaw.messagesLoaded === false ? [] : conversationPath(activeRaw.messages,activeRaw.activeLeaf).filter(message=>!message.hidden),[activeRaw.messages,activeRaw.activeLeaf,activeRaw.messagesLoaded]);
  const active = { ...activeRaw, messages:activeMessages };
  const activeUsage = useMemo(() => conversationUsage(active.messages), [active.messages]);
  const telemetry = telemetryLabel(agentInfo.model, agentInfo.effort, activeUsage);
  const recentConversations = useMemo(() => [
    ...conversations.filter((conversation) => (conversation.messages.length || conversation.messagesLoaded === false)).map((conversation) => ({ kind: "chat" as const, conversation })),
    ...focusConversations.map((conversation) => ({ kind: "focus" as const, conversation })),
  ].sort((a, b) => b.conversation.updatedAt - a.conversation.updatedAt), [conversations, focusConversations]);
  const allTools = useMemo(() => active.messages.flatMap((message) => message.tools ?? []).reverse(), [active.messages]);
  const allArtifacts = useMemo(() => allTools.flatMap((tool) => tool.result?.artifacts ?? []), [allTools]);

  useLayoutEffect(() => {
    const textarea = composerTextareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    const nextHeight = Math.min(textarea.scrollHeight, 150);
    textarea.style.height = `${Math.max(nextHeight, 36)}px`;
    textarea.style.overflowY = textarea.scrollHeight > 150 ? "auto" : "hidden";
  }, [draft, selectedSkill, activeId]);

  useEffect(() => {
    void fetchSettings().then((settings) => {
      const field = settings.fields.find((item) => item.name === "SEUDAILY_FULL_ACCESS");
      const extraField = settings.fields.find((item) => item.name === "SEUDAILY_FULL_ACCESS_EXTRA");
      setFullAccess(field?.value === "true");
      setFullAccessExtra(extraField?.value === "true");
    }).catch(() => undefined);
  }, []);

  const historySyncRef = useRef(0);
  const syncServerHistory = useCallback(async () => {
    const request = ++historySyncRef.current;
    const [remoteResult, focusResult] = await Promise.allSettled([loadServerConversations(), loadFocusConversations()]);
    if (request !== historySyncRef.current) return;
    if (focusResult.status === "fulfilled") setFocusConversations(focusResult.value);
    if (remoteResult.status === "fulfilled") {
      const remote = remoteResult.value;
      setConversations((current) => {
        const remoteIds = new Set(remote.map((conversation) => conversation.id));
        // Once the server responds successfully it is authoritative for completed
        // conversations. Keep only drafts and in-flight/failed local turns that
        // may not have reached the server yet; stale cached history must not reappear.
        const localTransient = current.filter((conversation) => !remoteIds.has(conversation.id) && (
          (conversation.messages.length === 0 && conversation.messagesLoaded !== false)
          || conversation.messages.some((message) => message.streaming || message.error)
        ));
        const hydrated = remote.map((conversation) => {
          const local = current.find((item) => item.id === conversation.id);
          if (!local) return conversation;
          // A focus/visibility sync can resolve while the response stream is still
          // active. The server snapshot is intentionally behind at that point and
          // replacing the local messages would also discard the local assistant ID,
          // causing all subsequent stream events to be ignored.
          if (local.messages.some((message) => message.streaming) || local.updatedAt > conversation.updatedAt) return local;
          // Metadata refreshes must retain complete loaded trees and attachment IDs.
          if (local.messagesLoaded !== false && local.updatedAt === conversation.updatedAt) {
            return { ...local, title: conversation.title, activeLeaf: conversation.activeLeaf ?? local.activeLeaf };
          }
          return conversation;
        });
        const merged = [...hydrated, ...localTransient].sort((a, b) => b.updatedAt - a.updatedAt);
        return merged.length ? merged : [createConversation()];
      });
    } else {
      setConversationError(remoteResult.reason instanceof Error ? remoteResult.reason.message : "会话历史加载失败");
    }
  }, []);

  useEffect(() => {
    if (activeRaw.messagesLoaded !== false) return;
    let cancelled = false;
    setConversationError("");
    void loadConversationMessages(activeRaw).then(loaded => {
      if (cancelled) return;
      setConversations(current => current.map(item => item.id === activeRaw.id
        ? loaded ?? { ...item, messagesLoaded: true } : item));
    }).catch(error => { if (!cancelled) setConversationError(error instanceof Error ? error.message : "会话历史加载失败"); });
    return () => { cancelled = true; };
  }, [activeRaw.id, activeRaw.messagesLoaded, activeRaw.updatedAt, historyReload]);

  useEffect(() => {
    if (!conversations.some((conversation) => conversation.id === activeId)) {
      setActiveId(conversations[0].id);
    }
  }, [activeId, conversations]);

  const cacheSnapshotRef = useRef(conversations);
  cacheSnapshotRef.current = conversations;
  useEffect(() => {
    let storage: Storage;
    try { storage = window.localStorage; } catch { return; }
    let lastSaved: Conversation[] | undefined;
    const flush = () => {
      const snapshot = cacheSnapshotRef.current;
      if (lastSaved === snapshot) return;
      lastSaved = snapshot;
      writeConversationCache(storage, STORAGE_KEY, snapshot);
    };
    const timer = window.setInterval(flush, 1000);
    window.addEventListener("pagehide", flush);
    return () => { clearInterval(timer); window.removeEventListener("pagehide", flush); };
  }, []);

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

  const chatScrollRef=useRef<HTMLElement>(null);
  const followBottomRef=useRef(true);
  useLayoutEffect(()=>{followBottomRef.current=true;},[active.id,view]);
  useLayoutEffect(()=>{
    const container=chatScrollRef.current;
    if(container && followBottomRef.current)container.scrollTop=container.scrollHeight;
  },[active.messages,active.id,view]);

  function mutateMessage(conversationId: string, messageId: string, updater: (message: ChatMessage) => ChatMessage) {
    setConversations((current) => current.map((conversation) => conversation.id === conversationId
      ? { ...conversation, updatedAt: Date.now(), messages: conversation.messages.map((message) => message.id === messageId ? updater(message) : message) }
      : conversation));
  }

  function newChat() {
    if (sending) abortRef.current?.abort();
    setView("chat");
    setRightOpen(false);
    resetComposerAttachments();
    if (!active.messages.length && activeRaw.messagesLoaded !== false) {
      setDraft("");
      setNavOpen(false);
      return;
    }
    const conversation = createConversation();
    setConversations((current) => [conversation, ...current]);
    setActiveId(conversation.id);
    setDraft("");
    setPendingImages([]);
    setPendingDocuments([]);
    setNavOpen(false);
  }

  async function confirmDeleteConversation() {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    setDeleteError("");
    try {
      await deleteServerConversation(deleteTarget.id, deleteTarget.resourceId);
      historySyncRef.current += 1;
      setConversations(current => {
        const remaining = current.filter(conversation => conversation.id !== deleteTarget.id);
        return remaining.length ? remaining : [createConversation()];
      });
      setDeleteTarget(null);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "删除会话失败，请稍后重试。");
    } finally {
      setDeleting(false);
    }
  }

  function handleStreamEvent(conversationId: string, messageId: string, event: StreamEvent) {
    const payload = event.payload ?? {};
    if (event.type === "finish") {
      const usage = normalizedUsage(payload.usage);
      if (Object.keys(usage).length) mutateMessage(conversationId, messageId, message => ({ ...message, usage }));
    }
    if (event.type === "reasoning-start") {
      const text = typeof payload.text === "string" ? payload.text : "";
      mutateMessage(conversationId, messageId, (message) => ({
        ...appendProcessText(message, "reasoning", text, true, String(payload.id ?? uid())),
        reasoningActive: true,
        reasoningDone: true,
      }));
    }
    if (event.type === "reasoning-delta") {
      const text = typeof payload.text === "string" ? payload.text : typeof payload.delta === "string" ? payload.delta : "";
      mutateMessage(conversationId, messageId, (message) => ({
        ...appendProcessText(message, "reasoning", text),
        reasoningActive: true,
        reasoningDone: true,
      }));
    }
    if (event.type === "reasoning-end") {
      mutateMessage(conversationId, messageId, (message) => ({ ...message, reasoningActive: false, reasoningDone: true }));
    }
    if (event.type === "text-delta" && typeof payload.text === "string") {
      const text = payload.text;
      mutateMessage(conversationId, messageId, (message) => ({ ...appendProcessText(message, "narration", text), reasoningActive: false }));
    }
    if (event.type === "tool-call-input-streaming-start" || event.type === "tool-call") {
      const id = String(payload.toolCallId ?? uid());
      const name = String(payload.toolName ?? "工具调用");
      const approvalId = typeof payload.approvalId === "string" ? payload.approvalId : undefined;
      mutateMessage(conversationId, messageId, (message) => {
        const next = addProcessTool(message, id);
        return {
          ...next,
          reasoningActive: false,
          reasoningDone: true,
          tools: updateTool(next.tools, {
          id,
          name,
          state: approvalId ? "approval-requested" : "running",
          approvalId,
          args: payload.args as Record<string, unknown> | undefined,
          ...(approvalId ? { result: { status: "waiting_for_user", taskId: id, summary: "等待用户批准工具执行。", artifacts: [], citations: [], warnings: [], metrics: {} } } : {}),
          }),
        };
      });
    }
    if (event.type === "tool-approval-request" || event.type === "approval-requested") {
      const id = String(payload.toolCallId ?? uid());
      const nestedApproval = payload.approval as Record<string, unknown> | undefined;
      const approvalId = typeof payload.approvalId === "string"
        ? payload.approvalId
        : typeof nestedApproval?.id === "string" ? nestedApproval.id : "";
      if (approvalId) mutateMessage(conversationId, messageId, (message) => {
        const next = addProcessTool(message, id);
        return {
          ...next,
          tools: updateTool(next.tools, {
          id,
          name: String(payload.toolName ?? "工具调用"),
          state: "approval-requested",
          approvalId,
          args: payload.args as Record<string, unknown> | undefined,
          result: { status: "waiting_for_user", taskId: id, summary: "等待用户批准工具执行。", artifacts: [], citations: [], warnings: [], metrics: {} },
          }),
        };
      });
    }
    if (event.type === "tool-result" || event.type === "tool-output") {
      const id = String(payload.toolCallId ?? uid());
      const rawResult = payload.result ?? payload.output;
      const result = (rawResult && typeof rawResult === "object" && "value" in rawResult
        ? (rawResult as { value: unknown }).value
        : rawResult) as ToolResult;
      mutateMessage(conversationId, messageId, (message) => {
        const next = addProcessTool(message, id);
        return {
          ...next,
          tools: updateTool(next.tools, {
          id,
          name: brokerCapabilityName(result) || String(payload.toolName ?? "工具调用"),
          state: result?.status === "failed" ? "failed" : "completed",
          args: payload.args as Record<string, unknown> | undefined,
          result,
          }),
        };
      });
    }
    if (event.type === "tool-error" || event.type === "tool-output-denied") {
      const id = String(payload.toolCallId ?? uid());
      const rawError = payload.error;
      const errorText = typeof rawError === "string"
        ? rawError
        : rawError && typeof rawError === "object" && "message" in rawError
          ? String((rawError as { message?: unknown }).message ?? "工具执行失败")
          : event.type === "tool-output-denied" ? "工具审批被拒绝。" : "工具执行失败。";
      mutateMessage(conversationId, messageId, (message) => {
        const next = addProcessTool(message, id);
        return {
          ...next,
          tools: updateTool(next.tools, {
          id,
          name: String(payload.toolName ?? "工具调用"),
          state: "failed",
          result: {
            status: "failed",
            taskId: id,
            summary: errorText,
            artifacts: [],
            citations: [],
            warnings: [],
            metrics: {},
          },
          }),
        };
      });
    }
  }

  type AccessMode = "normal" | "full" | "extra";
  const accessMode: AccessMode = fullAccessExtra ? "extra" : fullAccess ? "full" : "normal";
  const accessModeInfo: Record<AccessMode, { label: string; description: string; icon: string }> = {
    normal: { label: "普通", description: "需要写入、命令和浏览器交互时逐项审批；不提供 Workspace 工具。", icon: "普通模式" },
    full: { label: "完全访问", description: "普通业务工具和浏览器交互免审批；不提供 Workspace 工具。", icon: "完全访问" },
    extra: { label: "完全访问-extra", description: "包含完全访问能力，并额外提供 Workspace 文件与命令工具；同样免审批。", icon: "完全访问-extra" },
  };
  const accessModeIcons: Record<AccessMode, ReactNode> = {
    normal: <Hand size={18} />,
    full: <CircleAlert size={18} />,
    extra: <Sparkles size={18} />,
  };

  async function setAccessMode(mode: AccessMode) {
    if (permissionSaving || mode === accessMode) return;
    setPermissionSaving(true);
    setPermissionError("");
    try {
      await saveAccessMode(mode);
      setFullAccess(mode === "full" || mode === "extra");
      setFullAccessExtra(mode === "extra");
      setPermissionMenuOpen(false);
    } catch (error) {
      setPermissionError(error instanceof Error ? error.message : "权限模式切换失败");
    } finally {
      setPermissionSaving(false);
    }
  }

  async function executeStream(conversationId: string, assistantId: string, input: AgentInput, documents: DocumentAttachment[] = [], authResumeId?: string, existingRunToken?: string, skills: string[] = [], graph: { parentMessageId?: string | null; userMessageId?: string; regenerateFrom?: string } = {}) {
    setSending(true);
    const controller = new AbortController();
    abortRef.current = controller;
    const runToken = existingRunToken ?? crypto.randomUUID();
    activeStreamRef.current = {threadId:conversationId,resourceId:active.resourceId || RESOURCE_ID,runToken};
    mutateMessage(conversationId, assistantId, (message) => ({ ...message, brokerRunToken: runToken }));
    let assistantText = "";
    const pendingToolCalls = new Set<string>();
    let waitingForApproval = false;
    try {
      await streamAgent({
        message: input,
        threadId: conversationId,
        documents,
        skills,
        ...graph,
        assistantMessageId: graph.userMessageId || graph.regenerateFrom ? assistantId : undefined,
        resourceId: active.resourceId,
        authResumeId,
        runToken,
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === "text-delta" && typeof event.payload?.text === "string") assistantText += event.payload.text;
          if (event.type === "reasoning-start") assistantText = "";
          if (event.type === "tool-call-input-streaming-start" || event.type === "tool-call") {
            assistantText = "";
            pendingToolCalls.add(String(event.payload?.toolCallId ?? "unknown-tool"));
          }
          if (event.type === "tool-result" || event.type === "tool-output" || event.type === "tool-error" || event.type === "tool-output-denied") {
            pendingToolCalls.delete(String(event.payload?.toolCallId ?? "unknown-tool"));
          }
          if (event.type === "tool-approval-request" || event.type === "approval-requested") waitingForApproval = true;
          handleStreamEvent(conversationId, assistantId, event);
        },
      });
      const interrupted = pendingToolCalls.size > 0 && !waitingForApproval;
      const missingAnswer = !assistantText.trim() && !waitingForApproval;
      mutateMessage(conversationId, assistantId, (message) => {
        const awaitingAuthentication = message.tools?.some((tool) => tool.result?.status === "auth_required") ?? false;
        const effectiveMissingAnswer = missingAnswer && !awaitingAuthentication;
        const completed = !interrupted && !effectiveMissingAnswer && !waitingForApproval ? finalizeProcessAnswer(message) : message;
        return {
          ...completed,
          streaming: false,
          reasoningActive: false,
          ...(interrupted || effectiveMissingAnswer ? {
            error: interrupted
              ? "工具执行尚未完成，回答流已意外中断，请重试。"
              : "Agent 未生成最终回答，请重试。",
          } : {}),
          tools: completed.tools?.map((tool) => tool.state === "running"
            ? { ...tool, state: interrupted ? "failed" as const : "completed" as const }
            : tool),
        };
      });
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
      if (abortRef.current === controller) { abortRef.current = null; activeStreamRef.current = null; }
      setSending(false);
    }
    return assistantText;
  }

  async function respondToApproval(messageId: string, tool: ToolRun, approved: boolean) {
    if (!tool.approvalId || sending) return;
    mutateMessage(active.id, messageId, (message) => ({
      ...message,
      streaming: true,
      tools: updateTool(message.tools, {
        ...tool,
        state: approved ? "running" : "completed",
        result: approved ? undefined : { status: "failed", taskId: tool.id, summary: "用户拒绝了工具执行。", artifacts: [], citations: [], warnings: [], metrics: {} },
      }),
    }));
    const runToken = active.messages.find((message) => message.id === messageId)?.brokerRunToken;
    await executeStream(active.id, messageId, [{
      role: "tool",
      content: [{
        type: "tool-approval-response",
        approvalId: tool.approvalId,
        approved,
        reason: approved ? "用户批准工具执行" : "用户拒绝工具执行",
      }],
    }], [], undefined, runToken);
  }

  const queuePath = `/api/memory/threads/${encodeURIComponent(active.id)}/queue?resourceId=${encodeURIComponent(active.resourceId || RESOURCE_ID)}`;
  async function queueRequest(path: string, method = 'GET', body?: unknown) {
    const response = await fetch(path, {method, headers:{'Content-Type':'application/json'}, body:body === undefined ? undefined : JSON.stringify(body), signal:AbortSignal.timeout(20000)});
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '队列操作失败');
    return result;
  }
  useEffect(() => {
    let disposed = false, polling = false;
    setQueueState({active:false,items:[]});
    const poll = async () => {
      if (polling) return; polling = true;
      try {
        const state = await queueRequest(queuePath);
        if (disposed) return;
        const previous = queueStateRef.current;
        if (!sending && ((previous.active && !state.active) || previous.items.some(item => !state.items.some((next:any) => next.id === item.id) || item.state === 'running' && state.items.some((next:any) => next.id === item.id && next.state !== 'running')))) {
          void syncServerHistory(); setHistoryReload(value => value + 1);
        }
        queueStateRef.current = state; setQueueState(state);
      } catch { /* The normal API connection indicator reports an unavailable backend. */ }
      finally { polling = false; }
    };
    void poll(); const timer = window.setInterval(() => void poll(), 1000);
    return () => { disposed = true; clearInterval(timer); };
  }, [queuePath, sending, syncServerHistory]);
  async function takeQueue(item: any, edit = false) {
    if (edit && (draft.trim() || pendingImages.length || pendingDocuments.length)) { setConversationError('请先发送或清空当前草稿，再取回排队消息'); return; }
    try {
      const payload = await queueRequest(queuePath.replace('?','/' + encodeURIComponent(item.id) + '?'), 'DELETE');
      setQueueState(current => ({...current,items:current.items.filter(row => row.id !== item.id)}));
      if (edit) { setDraft(payload.text); setPendingImages(payload.images); setPendingDocuments(payload.documents); setSelectedSkill(payload.skills[0] ?? null); composerTextareaRef.current?.focus(); }
    } catch(error) { setConversationError((error as Error).message); }
  }
  async function stopAnswer() {
    if (stopping) return;
    setStopping(true);
    try {
      const target = activeStreamRef.current?.threadId === active.id ? activeStreamRef.current : {threadId:active.id,resourceId:active.resourceId || RESOURCE_ID,runToken:queueState.runToken};
      const result = await queueRequest(`/api/memory/threads/${encodeURIComponent(target.threadId)}/cancel?resourceId=${encodeURIComponent(target.resourceId)}`, 'POST', {runToken:target.runToken});
      if (result.active) throw new Error('任务仍在停止，请稍候；后端尚未确认结束');
      if (activeStreamRef.current?.threadId === active.id) abortRef.current?.abort();
      setHistoryReload(value => value + 1);
    } catch(error) { setConversationError((error as Error).message); }
    finally { setStopping(false); }
  }
  async function send(prompt = draft, options: { preserveComposer?: boolean; displayText?: string } = {}) {
    const text = prompt.trim();
    if ((!text && !pendingImages.length && !pendingDocuments.length) || attachmentUploadRef.current || activeRaw.messagesLoaded === false) return;
    if (!options.preserveComposer && /^\/ramdisk(?:\s|$)/i.test(text)) {
      if (ramdisk.busy) return;
      setDraft(''); setRightOpen(true);
      await ramdisk.run(text.replace(/^\/ramdisk/i, '').trim());
      return;
    }
    if (!options.preserveComposer && /^\/vpn(?:\s|$)/i.test(text)) {
      const [action = 'connect', port, ...extra] = text.replace(/^\/vpn/i, '').trim().split(/\s+/).filter(Boolean);
      setRightOpen(true);
      if (!['connect', 'disconnect', 'status'].includes(action) || extra.length || (port && action !== 'connect')) { setConversationError('/vpn connect [端口]；或 disconnect / status；额外验证码在面板填写'); return; }
      if (vpn.busy) return;
      setDraft(''); await vpn.run(action as 'connect' | 'disconnect' | 'status', undefined, port ? Number(port) : undefined); return;
    }
    if (sending || queueState.active || queueState.items.length || submittingRef.current) {
      if (submittingRef.current) return;
      submittingRef.current = true;
      try {
        await queueRequest(queuePath, 'POST', {text,images:options.preserveComposer ? [] : pendingImages,documents:options.preserveComposer ? [] : pendingDocuments,skills:!options.preserveComposer && selectedSkill ? [selectedSkill] : [],interface:'web'});
        if (!options.preserveComposer) {
          setDraft(current => current === prompt ? '' : current);
          setPendingImages(current => current.filter(image => !pendingImages.some(sent => sent.id === image.id)));
          setPendingDocuments(current => current.filter(document => !pendingDocuments.some(sent => sent.id === document.id)));
          setSelectedSkill(current => current === selectedSkill ? null : current);
        }
        const state = await queueRequest(queuePath); setQueueState(state);
      } catch(error) { setConversationError((error as Error).message); }
      finally { submittingRef.current = false; }
      return;
    }
    const effectivePrompt = !options.preserveComposer && selectedSkill ? `请使用 ${selectedSkill} Skill 处理下面的用户要求：\n${text}` : text;
    const conversationId = active.id;
    const firstTurn = active.messages.length === 0;
    const assistantId = uid();
    const now = Date.now();
    const attachments = options.preserveComposer ? [] : pendingImages;
    const documents = options.preserveComposer ? [] : pendingDocuments;
    const modelContent = packageDocumentContent(effectivePrompt, documents);
    const userMessage: ChatMessage = { id: uid(), parentId: active.messages.at(-1)?.id ?? null, role: "user", content: options.displayText ?? text, modelContent, createdAt: now, attachments, documents };
    const assistantMessage: ChatMessage = { id: assistantId, parentId: userMessage.id, role: "assistant", content: "", createdAt: now, tools: [], streaming: true };
    if (!options.preserveComposer) {
      setDraft("");
      setSelectedSkill(null);
      setComposerMenuOpen(false);
      setPendingImages([]);
      setPendingDocuments([]);
    }
    setConversations((current) => current.map((conversation) => conversation.id === conversationId ? {
      ...conversation,
      title: conversation.messages.length ? conversation.title : titleFromPrompt(documents[0]?.name || text || "图片对话"),
      updatedAt: now,
      messages: [...withParents(conversation.messages), userMessage, assistantMessage], activeLeaf: assistantId,
    } : conversation));
    const assistantText = await executeStream(conversationId, assistantId, attachments.length ? [{ role: "user", content: messageContent(userMessage) }] : modelContent, [], undefined, undefined, !options.preserveComposer && selectedSkill ? [selectedSkill] : [], {parentMessageId: userMessage.parentId, userMessageId: userMessage.id});
    if (firstTurn && assistantText.trim()) {
      const titleInput = documents[0]?.name || text || attachments[0]?.name || "新对话";
      void generateConversationTitle({ threadId: conversationId, resourceId: active.resourceId, titleInput })
        .then((result) => {
          if (!result.title?.trim()) return;
          setConversations((current) => current.map((conversation) => conversation.id === conversationId
            ? { ...conversation, title: result.title!.trim() }
            : conversation));
        })
        .catch(() => undefined);
    }
  }

  async function handleAgentActionRequest(request: AgentActionRequest) {
    await executeAgentActionRequest(request.id);
    await syncServerHistory();
  }

  async function handleAgentAuthRequest(request: AgentAuthRequest) {
    const resumed = await executeAgentAuthRequest(request.id);
    const conversationId=active.id,now=Date.now();
    const user:ChatMessage={id:uid(),parentId:active.messages.at(-1)?.id ?? null,role:'user',hidden:true,content:`[SEUDAILY_AUTH_RESUME id=${resumed.resumeId}] 登录已完成，请继续完成被中断的原任务。`,createdAt:now};
    const assistant:ChatMessage={id:uid(),parentId:user.id,role:'assistant',content:'',createdAt:now,tools:[],streaming:true};
    setConversations(current=>current.map(conversation=>conversation.id===conversationId?{...conversation,updatedAt:now,activeLeaf:assistant.id,messages:[...withParents(conversation.messages),user,assistant]}:conversation));
    await executeStream(conversationId,assistant.id,user.content,[],resumed.resumeId,undefined,[],{parentMessageId:user.parentId,userMessageId:user.id});
  }

  async function editPrompt(message: ChatMessage, content: string) {
    if (sending) return;
    const original = withParents(activeRaw.messages).find(item => item.id === message.id);
    if (!original) return;
    const now = Date.now(), editedUser: ChatMessage = { ...original, id: uid(), content, modelContent: editedDocumentContent(content, original, packageDocumentContent(content, original.documents ?? [])), createdAt: now };
    const assistant: ChatMessage = { id: uid(), parentId: editedUser.id, role: 'assistant', content: '', createdAt: now, tools: [], streaming: true };
    setConversations(current => current.map(conversation => conversation.id === active.id ? {
      ...conversation, updatedAt: now, activeLeaf: assistant.id, messages: [...withParents(conversation.messages), editedUser, assistant],
    } : conversation));
    await executeStream(active.id, assistant.id, [{role:'user',content:messageContent(editedUser)}], editedUser.documents ?? [], undefined, undefined, [], {parentMessageId: editedUser.parentId, userMessageId: editedUser.id});
  }

  async function regenerate(message: ChatMessage) {
    if (sending) return;
    const original = withParents(activeRaw.messages).find(item => item.id === message.id);
    const user = activeRaw.messages.find(item => item.id === original?.parentId && item.role === 'user');
    if (!user) return;
    const assistant: ChatMessage = { id: uid(), parentId: user.id, role: 'assistant', content: '', createdAt: Date.now(), tools: [], streaming: true };
    setConversations(current => current.map(conversation => conversation.id === active.id ? {
      ...conversation, updatedAt: Date.now(), activeLeaf: assistant.id, messages: [...withParents(conversation.messages), assistant],
    } : conversation));
    await executeStream(active.id, assistant.id, user.modelContent ?? user.content, [], undefined, undefined, [], {regenerateFrom: user.id});
  }

  async function branchConversation(message: ChatMessage) {
    if(sending)return;
    setConversationError("");
    try {
      const response=await fetch(`/api/memory/threads/${encodeURIComponent(active.id)}/fork`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({resourceId:active.resourceId || RESOURCE_ID,messageId:message.id})});
      if(!response.ok)throw new Error((await response.json()).error || '创建分支失败');
      const {threadId}=await response.json();await syncServerHistory();setActiveId(threadId);
    }catch(error){setConversationError((error as Error).message);}
  }

  async function switchVersion(id: string) {
    if (sending) return;
    setConversationError("");
    const leafId = latestDescendant(activeRaw.messages, id);
    try {
      const response = await fetch(`/api/memory/threads/${encodeURIComponent(active.id)}/version`, {method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({resourceId:active.resourceId || RESOURCE_ID,leafId})});
      if (!response.ok) throw new Error((await response.json()).error || '切换失败');
      setConversations(current => current.map(conversation => conversation.id === active.id ? {...conversation,activeLeaf:leafId} : conversation));
    } catch (error) { setConversationError((error as Error).message); }
  }

  function versionPicker(message: ChatMessage) {
    return <PromptVersions messages={activeRaw.messages} message={message} leaf={activeRaw.activeLeaf} disabled={sending} onSwitch={id => void switchVersion(id)} />;
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (ime.isComposing(event)) return;
    if (slashOpen && !event.shiftKey) {
      if (event.key === 'Escape') { event.preventDefault(); setSlashDismissed(true); return; }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setSlashIndex((selectedSlashIndex + (event.key === 'ArrowDown' ? 1 : -1) + slashMatches.length) % slashMatches.length);
        return;
      }
      if (event.key === 'Tab' || event.key === 'Enter') {
        event.preventDefault(); completeSlashCommand(slashMatches[selectedSlashIndex].command); return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  }

  function completeSlashCommand(command: string) {
    setDraft(command + ' ');
    setSlashDismissed(true);
    composerTextareaRef.current?.focus();
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (slashOpen) { completeSlashCommand(slashMatches[selectedSlashIndex].command); return; }
    void send();
  }

  async function addAttachments(files: File[]) {
    if (!files.length) return;
    if (attachmentUploadRef.current) { setAttachmentError("附件正在上传，请稍候。"); return; }
    const remaining = MAX_ATTACHMENTS - pendingImages.length - pendingDocuments.length;
    if (remaining <= 0) { setAttachmentError("每轮最多 10 个附件，请删除不需要的附件。"); return; }
    const allowed = new Set([".pdf", ".docx", ".xlsx", ".pptx", ".txt", ".md"]);
    const accepted = files.filter(file => file.type.startsWith("image/")
      ? file.size <= 10 * 1024 * 1024
      : allowed.has(file.name.slice(file.name.lastIndexOf(".")).toLowerCase()) && file.size <= 50 * 1024 * 1024).slice(0, remaining);
    if (!accepted.length) { setAttachmentError("支持 10 MB 以内的图片，以及 50 MB 以内的 PDF、DOCX、XLSX、PPTX、TXT、MD。"); return; }
    const upload = {};
    attachmentUploadRef.current = upload;
    setUploadingAttachments(true); setAttachmentError("");
    try {
      const uploaded = await Promise.all(accepted.map(async file => {
        if (file.type.startsWith("image/")) {
          const image = await readImage(file);
          const stored = await uploadTemporaryImage({ dataUrl: image.dataUrl!, name: image.name });
          return { image: { ...image, path: stored.path, ref: `seudaily-image-ref:${stored.ref}` } };
        }
        const parsed = await uploadDocument(file);
        if (parsed.knowledge?.error) setAttachmentError("文档已添加，但自动入库失败：" + parsed.knowledge.error);
        return { document: { id: uid(), name: parsed.filename, mediaType: parsed.mediaType, contextRef: parsed.contextRef, markdown: parsed.markdown, charCount: parsed.charCount } satisfies DocumentAttachment };
      }));
      if (attachmentUploadRef.current !== upload) return;
      setPendingImages(current => [...current, ...uploaded.flatMap(item => item.image ? [item.image] : [])]);
      setPendingDocuments(current => [...current, ...uploaded.flatMap(item => item.document ? [item.document] : [])]);
      if (accepted.length < files.length) setAttachmentError("部分文件未添加：每轮最多 10 个附件，并受格式与大小限制。");
    } catch (error) {
      if (attachmentUploadRef.current === upload) setAttachmentError(error instanceof Error ? error.message : "附件上传失败");
    } finally {
      if (attachmentUploadRef.current === upload) { attachmentUploadRef.current = null; setUploadingAttachments(false); }
    }
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const images = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
    if (!images.length) return;
    event.preventDefault();
    void addAttachments(images);
  }

  function onImageInput(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    void addAttachments(files);
    event.target.value = "";
  }

  function selectProjectSkill(name: string) {
    if (sending) return;
    setComposerMenuOpen(false);
    setSelectedSkill(name);
  }

  const composer = (
    <form className={`composer-wrap ${active.messages.length ? "" : "centered"}`} onSubmit={onSubmit}>
      <div className="composer">
        {slashOpen && <div className="slash-menu">
          <div className="slash-menu-heading">命令 <span>↑↓ 选择 · Tab / Enter 补全 · Esc 收起</span></div>
          <div id="composer-slash-list" className="slash-menu-list" role="listbox" aria-label="斜杠命令" ref={slashListRef}>
            {slashMatches.map((item, index) => <button type="button" role="option" id={`composer-slash-${index}`} aria-selected={index === selectedSlashIndex} className={index === selectedSlashIndex ? 'selected' : ''} key={item.command} onMouseDown={event => event.preventDefault()} onClick={() => completeSlashCommand(item.command)}><strong>{item.command}</strong><span>{item.description}</span></button>)}
          </div>
        </div>}
        {uploadingAttachments && <div className="composer-attachment-error">正在上传附件，请稍候…</div>}
        {attachmentError && !uploadingAttachments && <div className="composer-attachment-error">{attachmentError}</div>}
        {!!pendingImages.length && <div className={`composer-images ${pendingImages.length > 2 ? "compact" : ""}`}>{pendingImages.map((image) => <div key={image.id}><button type="button" className="composer-image-preview" aria-label={`预览图片：${image.name}`} onClick={() => setPreviewImage(image)}><img src={image.dataUrl} alt={image.name} /></button><button type="button" className="composer-image-remove" aria-label={`移除图片：${image.name}`} onClick={() => setPendingImages((current) => current.filter((item) => item.id !== image.id))}><X size={12} /></button></div>)}</div>}
        {!!pendingDocuments.length && <div className="composer-files">{pendingDocuments.map((document) => <div className="composer-file" key={document.id}><FileText size={16} /><span title={document.name}>{document.name}</span><button type="button" aria-label={`移除文件：${document.name}`} onClick={() => setPendingDocuments((current) => current.filter((item) => item.id !== document.id))}><X size={13} /></button></div>)}</div>}
        <div className="composer-add-wrap" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setComposerMenuOpen(false); }}>
          <button type="button" className="composer-add" aria-label="添加内容或调用技能" title="添加内容或调用技能" aria-haspopup="menu" aria-expanded={composerMenuOpen} onClick={() => setComposerMenuOpen((value) => !value)}><Plus size={20} /></button>
          {composerMenuOpen && <div className="composer-add-menu" role="menu">
            <button type="button" role="menuitem" onClick={() => { setComposerMenuOpen(false); fileInputRef.current?.click(); }}><Paperclip size={19} /><span><strong>添加照片和文件</strong><small>从电脑上传</small></span></button>
            <div className="composer-add-menu-separator" />
            {projectSkills.map(skill => <button type="button" role="menuitem" key={skill.name} onClick={() => selectProjectSkill(skill.name)}><ListChecks size={19} /><span><strong>{skill.name === "training-plan-audit" ? "培养方案检查" : skill.name}</strong><small title={skill.description}>选中后可继续补充要求</small></span></button>)}
            {skillError && <small role="status">{skillError}</small>}
          </div>}
        </div>
        <div className="composer-permission-wrap" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setPermissionMenuOpen(false); }}>
          <button type="button" className={`composer-permission ${accessMode !== "normal" ? "enabled" : ""} ${permissionError ? "failed" : ""}`} disabled={permissionSaving} aria-label={`权限模式：${accessModeInfo[accessMode].label}`} aria-expanded={permissionMenuOpen} title={permissionError || `${accessModeInfo[accessMode].label}：${accessModeInfo[accessMode].description}`} onClick={() => setPermissionMenuOpen((value) => !value)}>{accessModeIcons[accessMode]}</button>
          {permissionMenuOpen && <div className="composer-permission-menu" role="menu">
            <div className="composer-permission-heading"><strong>权限模式</strong><small>{permissionSaving ? "正在保存…" : "选择后立即生效"}</small></div>
            {(Object.keys(accessModeInfo) as AccessMode[]).map((mode) => <button type="button" role="menuitemradio" aria-checked={accessMode === mode} className={accessMode === mode ? "selected" : ""} key={mode} onClick={() => void setAccessMode(mode)}><span className={`composer-permission-mode-icon mode-${mode}`}>{accessModeIcons[mode]}</span><span><strong>{accessModeInfo[mode].label}</strong><small>{accessModeInfo[mode].description}</small></span></button>)}
          </div>}
        </div>
        <input ref={fileInputRef} className="image-input" type="file" accept=".png,.jpg,.jpeg,.webp,.gif,.pdf,.docx,.xlsx,.pptx,.txt,.md" multiple onChange={onImageInput} />
        {selectedSkill && <button type="button" className="selected-skill" onClick={() => setSelectedSkill(null)} title="移除当前技能"><span>{selectedSkill}</span><X size={13} /></button>}
        <textarea ref={composerTextareaRef} value={draft} aria-autocomplete="list" aria-controls={slashOpen ? 'composer-slash-list' : undefined} aria-activedescendant={slashOpen ? `composer-slash-${selectedSlashIndex}` : undefined} onChange={(event) => setDraft(event.target.value)} onPaste={onPaste} onCompositionStart={ime.onCompositionStart} onCompositionEnd={ime.onCompositionEnd} onKeyDown={onComposerKeyDown} placeholder="问问 SEUdaily，或粘贴图片" rows={1} />
        {(sending || queueState.active) ? <button type="button" className="send-button stop" disabled={stopping} onClick={() => void stopAnswer()} aria-label={stopping ? '正在停止' : '停止回答'}><CircleStop size={19} /></button> :
        <button type="submit" className="send-button" disabled={activeRaw.messagesLoaded === false || uploadingAttachments || (!draft.trim() && !pendingImages.length && !pendingDocuments.length)} aria-label="发送消息"><ArrowUp size={20} /></button>}
      </div>
      {!!queueState.items.length && <div className="composer-queue" aria-label="待发送队列">
        {queueState.items.map(item => <div key={item.id} className="composer-queue-row"><span title={item.error || item.text}><small>{item.state === 'running' ? '发送中' : item.state === 'pending' ? '待发送' : '已暂停'}</small> {item.text || `${item.images.length + item.documents.length} 个附件`}{item.error && ` · ${item.error}`}</span><button type="button" disabled={item.state === 'running'} onClick={() => void takeQueue(item,true)}>编辑</button><button type="button" disabled={item.state === 'running'} onClick={() => void takeQueue(item)}>删除</button></div>)}
        {queueState.progress?.text && <div className="composer-queue-progress">{queueState.progress.text}</div>}
        {queueState.items.some(item => item.state === 'paused') && <button type="button" onClick={() => void queueRequest(queuePath.replace('?', '/resume?'), 'POST', {}).catch(error => setConversationError(error.message))}>继续队列</button>}
      </div>}
      {slashCommandHint(draft) && <div className="slash-command-hint" role="status">{slashCommandHint(draft)}</div>}
      {!!active.messages.length && <div className="composer-telemetry" aria-label="模型和当前会话用量">{telemetry.split(" · ").map((item, index) => <span key={index}>{item}</span>)}</div>}
      {!!active.messages.length && <div className="composer-hint"><span>{sending || queueState.active ? "Enter 加入队列" : "Enter 发送"} · Shift + Enter 换行</span><span>AI 可能出错，请核对重要信息</span></div>}
    </form>
  );

  function openView(next: AppView) {
    setView(next);
    setRightOpen(false);
    setNavOpen(false);
  }

  function openFocusConversation(focusId: string) {
    setSelectedFocusId(focusId);
    setView("focus");
    setRightOpen(false);
    setNavOpen(false);
  }

  return (
    <div className={`app-shell ${rightOpen && view === "chat" ? "with-inspector" : ""} ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      <CampusSmsDialog />
      <div className={`mobile-scrim ${navOpen ? "visible" : ""}`} onClick={() => setNavOpen(false)} />
      <aside className={`sidebar ${navOpen ? "open" : ""} ${sidebarCollapsed ? "collapsed" : ""}`}>
        <div className="brand">
          <div><strong>SEUdaily</strong></div>
          <button className="icon-button sidebar-collapse" onClick={() => setSidebarCollapsed((value) => !value)} aria-label={sidebarCollapsed ? "展开导航栏" : "收起导航栏"} title={sidebarCollapsed ? "展开导航栏" : "收起导航栏"}><PanelLeft size={20} /></button>
          <button className="icon-button sidebar-close" onClick={() => setNavOpen(false)} aria-label="关闭侧栏"><X size={19} /></button>
        </div>
        <nav className="primary-nav" aria-label="主要功能">
            <button className={view === "chat" && !active.messages.length ? "active" : ""} onClick={newChat}><SidebarIcon kind="compose" /><span>新对话</span></button>
            <button className={view === "schedule" ? "active" : ""} onClick={() => openView("schedule")}><SidebarIcon kind="schedule" /><span>课表</span></button>
            <button className={view === "programs" ? "active" : ""} onClick={() => openView("programs")}><SidebarIcon kind="programs" /><span>培养方案</span></button>
            <button className={view === "focus" ? "active" : ""} onClick={() => { setSelectedFocusId(""); openView("focus"); }}><SidebarIcon kind="focus" /><span>关注</span></button>
          <button className={view === "library" ? "active" : ""} onClick={() => openView("library")}><SidebarIcon kind="library" /><span>资料库</span></button>
          <button className={view === "notices" ? "active" : ""} onClick={() => openView("notices")}><SidebarIcon kind="notice" /><span>教务通知</span></button>
        </nav>
        <nav className="conversation-list" aria-label="历史对话">
          <div className="nav-label">最近</div>
          {recentConversations.map(({ kind, conversation }) => (
            <div key={`${kind}-${conversation.id}`} className={`conversation-row ${kind === "focus" ? "focus-conversation" : ""} ${(kind === "chat" && view === "chat" && conversation.id === active.id) || (kind === "focus" && view === "focus" && conversation.focusId === selectedFocusId) ? "active" : ""}`}>
              <button className="conversation-item" onClick={() => kind === "focus" ? openFocusConversation(conversation.focusId || conversation.id) : (() => { setActiveId(conversation.id); setView("chat"); setNavOpen(false); })()}>
                <span><strong>{conversation.title.replace(/^微信 · /,'')}</strong><small>{conversation.source || (conversation.resourceId==='seudaily-wechat-local' ? '微信' : '网页')}</small></span>
              </button>
              {kind === "chat" && <button
                type="button"
                className="conversation-delete"
                aria-label={`删除会话：${conversation.title}`}
                title="删除会话"
                onClick={() => { setDeleteError(""); setDeleteTarget(conversation); }}
              >
                <Trash2 size={15} />
              </button>}
            </div>
          ))}
        </nav>
        <div className="sidebar-footer">
          <button className={`settings-button ${view === "settings" ? "active" : ""}`} onClick={() => openView("settings")}><SidebarIcon kind="settings" /><span>设置</span></button>
          <WeChatPanel />
        </div>
      </aside>

      {view === "chat" ? <main className={`chat-panel ${active.messages.length ? "has-messages" : "empty"}`}>
        <header className="topbar">
          <button className="icon-button menu-button" onClick={() => setNavOpen(true)} aria-label="打开导航"><Menu size={20} /></button>
          {active.messages.length ? <h1>{active.title}</h1> : <span className="topbar-product">SEUdaily</span>}
          <div className="topbar-actions">
            <button ref={panelToggleRef} className={`icon-button task-panel-toggle ${rightOpen ? "is-open" : ""}`} onClick={() => { setSourceMessage(null); setRightOpen((value) => !value); }} aria-expanded={rightOpen} aria-label={rightOpen ? "关闭任务面板" : "打开任务面板"}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="5" cy="6" r="2.5" /><path d="M13 6h8" /><circle cx="5" cy="18" r="2.5" /><path d="M13 18h8" /></svg>
            </button>
          </div>
        </header>

        <section className="chat-scroll" ref={chatScrollRef} onScroll={event=>{
          const container=event.currentTarget;
          followBottomRef.current=container.scrollHeight-container.scrollTop-container.clientHeight<24;
        }}>
          {conversationError && !active.messages.length && activeRaw.messagesLoaded !== false && <div className="page-state error">{conversationError}</div>}
          {activeRaw.messagesLoaded === false && <div className="page-state">{conversationError || "正在加载会话历史…"}{conversationError && <button type="button" onClick={() => setHistoryReload(current => current + 1)}>重试</button>}</div>}
          {!active.messages.length ? (
            <div className="welcome">
              <div className="welcome-core">
                <h2>今天要做些什么？</h2>
              </div>
            </div>
          ) : (
            <div className="message-list">
              {conversationError && <div className="page-state error">{conversationError}</div>}
              {active.messages.map((message) => <div key={message.id}><Message message={message} onSources={openSources} sourcesOpen={sourceMessage?.id === message.id} versionControls={versionPicker(message)} disabled={sending} canRegenerate={true} onBranch={message=>void branchConversation(message)} onEdit={editPrompt} onRegenerate={regenerate} onPreviewImage={setPreviewImage} onApproval={(tool, approved) => void respondToApproval(message.id, tool, approved)} onActionRequest={handleAgentActionRequest} onAuthRequest={handleAgentAuthRequest} /></div>)}
              <div ref={messageEndRef} />
            </div>
          )}
        </section>
        {composer}
      </main> : <main className="workspace-panel">
        <header className="workspace-mobile-bar"><button className="icon-button menu-button" onClick={() => setNavOpen(true)} aria-label="打开导航"><Menu size={20} /></button><span>SEUdaily</span></header>
        <div className="workspace-scroll">
            {view === "schedule" && <SchedulePage />}
            {view === "programs" && <ProgramsPage />}
            {view === "focus" && <FocusPage selectedFocusId={selectedFocusId} onSelectedFocusChange={setSelectedFocusId} onHistoryChange={() => void syncServerHistory()} renderMessage={(message, controls) => <Message message={message} onSources={openSources} sourcesOpen={sourceMessage?.id === message.id} disabled={controls.disabled} onEdit={controls.onEdit} onAuthRequest={controls.onAuth} onActionRequest={controls.onAction} onApproval={controls.onApproval} versionControls={controls.versions} />} />}
          {view === "library" && <LibraryPage />}
          {view === "notices" && <NoticesPage />}
          {view === "settings" && <SettingsPage />}
        </div>
      </main>}

      <aside ref={inspectorRef} className={`inspector ${rightOpen && view === "chat" ? "open" : ""}`}>
        <div className="inspector-head"><div><span className="eyebrow">WORKSPACE</span><h2>任务与资料</h2></div><button className="icon-button" onClick={() => setRightOpen(false)} aria-label="关闭任务面板" title="关闭任务面板"><X size={17} /></button></div>
        <div className="inspector-scroll">
          <VpnPanel controller={vpn} />
          <RamDiskPanel controller={ramdisk} />
          <section className="inspector-section">
            <div className="section-title"><span>生成资料</span><small>{allArtifacts.length}</small></div>
            {allArtifacts.length ? <div className="resource-list">{allArtifacts.map((artifact) => (
              <div className="resource-item" key={artifact.id} title={artifact.path}>
                <span>{artifact.type === "audio" ? <FileAudio size={17} /> : artifact.type === "slides" ? <BookOpen size={17} /> : <FileText size={17} />}</span>
                <div><strong>{fileName(artifact.path)}</strong><small>{artifact.type.toUpperCase()} {formatBytes(artifact.sizeBytes)}</small></div>
              </div>
            ))}</div> : <p className="inspector-description">字幕、课件和笔记会集中显示。</p>}
          </section>
        </div>
        <div className="inspector-footer"><span>课程凭据不会发送到对话内容中</span><VpnLicense /></div>
      </aside>
      {sourceMessage && <SourcesSidebar sources={messageSources(sourceMessage)} onClose={closeSources} />}
      {previewImage && attachmentSource(previewImage) && <div className="preview-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setPreviewImage(null); }}><div className="image-preview-dialog" role="dialog" aria-modal="true" aria-label="图片预览"><button type="button" className="preview-close" aria-label="关闭预览" onClick={() => setPreviewImage(null)}><X size={19} /></button><img src={attachmentSource(previewImage)} alt={previewImage.name} /></div></div>}
      <RuntimePreparationNotice />
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



import { useImeComposition } from "../ime";
import { conversationPath, withParents, latestDescendant } from "../../../../src/shared/conversation-tree";
import { PromptVersions } from "../prompt-versions";
import { editedDocumentContent, messageContent } from "../conversation-cache";
import { ArrowLeft, ArrowUp, CircleStop, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import rehypeKatex from "rehype-katex";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

import { claimFocusRun, fetchFocus, fetchFocusConversation, executeAgentActionRequest, executeAgentAuthRequest, type AgentActionRequest, type AgentAuthRequest, type AgentInput, saveFocus, deleteFocus, runFocus, recordFocusRun, streamAgent, type FocusItem } from "../api";
import { normalizeMathMarkdown } from "../markdown";
import { addProcessTool, appendProcessText, finalizeProcessAnswer } from "../stream-state";
import type { ChatMessage, StreamEvent, ToolResult, ToolRun } from "../types";

import { PageHeader, PageState } from "./page-ui";

function updateFocusTool(tools: ToolRun[] = [], next: ToolRun) {
  const found = tools.findIndex((tool) => tool.id === next.id);
  if (found < 0) return [...tools, next];
  return tools.map((tool, index) => index === found ? { ...tool, ...next } : tool);
}

function applyFocusStreamEvent(message: ChatMessage, event: StreamEvent): ChatMessage {
  const payload = event.payload ?? {};
  if (event.type === "reasoning-start") {
    const text = typeof payload.text === "string" ? payload.text : "";
    return { ...appendProcessText(message, "reasoning", text, true, String(payload.id ?? crypto.randomUUID())), reasoningActive: true, reasoningDone: true };
  }
  if (event.type === "reasoning-delta") {
    const text = typeof payload.text === "string" ? payload.text : typeof payload.delta === "string" ? payload.delta : "";
    return { ...appendProcessText(message, "reasoning", text), reasoningActive: true, reasoningDone: true };
  }
  if (event.type === "reasoning-end") {
    return { ...message, reasoningActive: false, reasoningDone: true };
  }
  if (event.type === "text-delta" && typeof payload.text === "string") {
    return { ...appendProcessText(message, "narration", payload.text), reasoningActive: false };
  }
  if (event.type === "tool-approval-request") {
    const id = String(payload.toolCallId);
    const next = addProcessTool(message, id);
    return { ...next, tools: updateFocusTool(next.tools, { id, name: String(payload.toolName), state: "approval-requested", approvalId: String(payload.approvalId), args: payload.args as Record<string, unknown> }) };
  }
  if (event.type === "tool-call-input-streaming-start" || event.type === "tool-call") {
    const id = String(payload.toolCallId ?? crypto.randomUUID());
    const next = addProcessTool(message, id);
    return { ...next, reasoningActive: false, reasoningDone: true, tools: updateFocusTool(next.tools, { id, name: String(payload.toolName ?? "工具调用"), state: "running", args: payload.args as Record<string, unknown> | undefined }) };
  }
  if (event.type === "tool-result" || event.type === "tool-output") {
    const id = String(payload.toolCallId ?? crypto.randomUUID());
    const rawResult = payload.result ?? payload.output;
    const result = (rawResult && typeof rawResult === "object" && "value" in rawResult ? (rawResult as { value: unknown }).value : rawResult) as ToolResult;
    const next = addProcessTool(message, id);
    return { ...next, tools: updateFocusTool(next.tools, { id, name: String(payload.toolName ?? "工具调用"), state: result?.status === "failed" ? "failed" : "completed", args: payload.args as Record<string, unknown> | undefined, result }) };
  }
  if (event.type === "tool-error" || event.type === "tool-output-denied") {
    const id = String(payload.toolCallId ?? crypto.randomUUID());
    const result: ToolResult = { status: "failed", taskId: id, summary: typeof payload.error === "string" ? payload.error : "工具执行失败或未获授权。", artifacts: [], citations: [], warnings: [], metrics: {} };
    const next = addProcessTool(message, id);
    return { ...next, tools: updateFocusTool(next.tools, { id, name: String(payload.toolName ?? "工具调用"), state: "failed", result }) };
  }
  return message;
}

export function FocusPage({
  renderMessage,
  selectedFocusId = "",
  onSelectedFocusChange,
  onHistoryChange,
}: {
  renderMessage?: (message: ChatMessage, controls: {
    disabled: boolean; versions: ReactNode;
    onEdit: (message: ChatMessage, content: string) => void;
    onAuth: (request: AgentAuthRequest) => Promise<void>;
    onAction: (request: AgentActionRequest) => Promise<void>;
    onApproval: (tool: ToolRun, approved: boolean) => void;
  }) => ReactNode;
  selectedFocusId?: string;
  onSelectedFocusChange?: (focusId: string) => void;
  onHistoryChange?: () => void;
}) {
  const ime = useImeComposition();
  const [items, setItems] = useState<FocusItem[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activeLeaf, setActiveLeaf] = useState<string>();
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [conversationLoading, setConversationLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState<"notice" | "course" | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const messageEndRef = useRef<HTMLDivElement | null>(null);
  const externalFocusRef = useRef("");

  const load = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true);
    setError("");
    try {
      const focus = await fetchFocus();
      const nextItems = focus.data?.items ?? [];
      setItems(nextItems);
      setSelectedId((current) => current && nextItems.some((item) => item.id === current) ? current : "");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "关注读取失败"); }
    finally { if (showLoading) setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { messageEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [messages]);
  useEffect(() => {
    if (!selectedFocusId) {
      if (externalFocusRef.current) {
        externalFocusRef.current = "";
        setSelectedId("");
        setMessages([]);
      }
      return;
    }
    if (loading || externalFocusRef.current === selectedFocusId) return;
    const item = items.find((candidate) => candidate.id === selectedFocusId);
    if (!item) return;
    externalFocusRef.current = selectedFocusId;
    void openFocus(item);
  }, [items, loading, selectedFocusId]);

  const selected = items.find((item) => item.id === selectedId);

  function mutateMessage(messageId: string, updater: (message: ChatMessage) => ChatMessage) {
    setMessages((current) => current.map((message) => message.id === messageId ? updater(message) : message));
  }

  async function openFocus(item: FocusItem) {
    if (streaming) return;
    externalFocusRef.current = item.id;
    onSelectedFocusChange?.(item.id);
    setSelectedId(item.id);
    setMessages([]);
    setConversationLoading(true);
    setError("");
    try { const conversation = await fetchFocusConversation(item); setMessages(conversation?.messages ?? []); setActiveLeaf(conversation?.activeLeaf); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "关注会话读取失败"); }
    finally { setConversationLoading(false); }
  }

  async function executeFocusStream(item: FocusItem, prompt: string, assistantId: string, options: { force?: boolean; respectInterval: boolean; user?: ChatMessage; authResumeId?: string; approval?: { approvalId: string; approved: boolean; runToken: string } }) {
    setStreaming(true);
    setError("");
    const controller = new AbortController();
    abortRef.current = controller;
    let runId = "";
    let responseText = "";
    try {
      const claim = await claimFocusRun(item.id, options);
      const claimed = claim.data;
      if (!claimed?.claimed || !claimed.runId || !claimed.item) {
        throw new Error(claimed?.reason === "running" ? "这项关注正在执行，请稍后再发送。" : "当前尚未到检查时间。可稍后再试。" );
      }
      runId = claimed.runId;
      await streamAgent({
        message: options.approval ? [{ role: "tool", content: [{ type: "tool-approval-response", approvalId: options.approval.approvalId, approved: options.approval.approved }] }] as AgentInput : options.user ? [{ role: "user", content: messageContent(options.user) }] : prompt,
        runToken: options.approval?.runToken,
        parentMessageId: options.user?.parentId,
        userMessageId: options.user?.id,
        assistantMessageId: assistantId,
        authResumeId: options.authResumeId,
        threadId: claimed.item.threadId || item.threadId || item.id,
        resourceId: claimed.item.resourceId || item.resourceId,
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === "text-delta" && typeof event.payload?.text === "string") responseText += event.payload.text;
          if (event.type === "reasoning-start" || event.type === "tool-call-input-streaming-start" || event.type === "tool-call") responseText = "";
          mutateMessage(assistantId, (message) => applyFocusStreamEvent(message, event));
          if (event.type === "tool-approval-request") throw new Error("该关注有待审批工具，请完成审批后再继续。");
        },
      });
      mutateMessage(assistantId, (message) => ({ ...finalizeProcessAnswer(message), streaming: false, reasoningActive: false, tools: message.tools?.map((tool) => tool.state === "running" ? { ...tool, state: "completed" as const } : tool) }));
      await recordFocusRun(item.id, runId, "completed", responseText);
      const conversation = await fetchFocusConversation(claimed.item);
      if (conversation) { setMessages(conversation.messages); setActiveLeaf(conversation.activeLeaf); }
      void load(false);
    } catch (reason) {
      const aborted = controller.signal.aborted;
      const message = aborted ? "已停止本次回答。" : reason instanceof Error ? reason.message : "请求失败，请稍后重试。";
      mutateMessage(assistantId, (current) => ({ ...current, streaming: false, reasoningActive: false, error: message, tools: current.tools?.map((tool) => tool.state === "running" ? { ...tool, state: "failed" as const } : tool) }));
      if (runId) await recordFocusRun(item.id, runId, "failed", message).catch(() => undefined);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setStreaming(false);
      onHistoryChange?.();
    }
  }

  async function create() {
    const kind = adding;
    const nextTitle = title.trim();
    const prompt = description.trim();
    if (!kind || !nextTitle || !prompt || creating) { setError("请填写关注名称和持续关注要求。"); return; }
    const id = `focus-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const optimistic: FocusItem = { id, kind, title: nextTitle, description: prompt, enabled: true, createdAt: now, updatedAt: now, threadId: id, resourceId: "seudaily-focus-local" };
    const assistantId = crypto.randomUUID();
    setCreating(true);
    setStreaming(true);
    setItems((current) => [...current, optimistic]);
    externalFocusRef.current = id;
    onSelectedFocusChange?.(id);
    setSelectedId(id);
    const user: ChatMessage = { id: crypto.randomUUID(), parentId: null, role: "user", content: prompt, createdAt: Date.now() };
    setActiveLeaf(assistantId);
    setMessages([
      user,
      { id: assistantId, parentId: user.id, role: "assistant", content: "", createdAt: Date.now(), tools: [], streaming: true },
    ]);
    setAdding(null); setTitle(""); setDescription(""); setError("");
    try {
      const saved = await saveFocus(optimistic);
      const created = saved.data?.item;
      if (!created) throw new Error("关注已提交，但服务端没有返回会话信息。");
      setItems((current) => current.map((item) => item.id === id ? created : item));
      await executeFocusStream(created, prompt, assistantId, { force: true, respectInterval: true, user });
    } catch (reason) {
      setStreaming(false);
      mutateMessage(assistantId, (message) => ({ ...message, streaming: false, error: reason instanceof Error ? reason.message : "关注创建失败，请稍后重试。" }));
    } finally { setCreating(false); }
  }

  const visibleMessages = messages.length ? conversationPath(messages, activeLeaf).filter(message => !message.hidden) : [];

  async function submitFocusPrompt(content: string, parentId: string | null, original?: ChatMessage, authResumeId?: string) {
    if (!selected || streaming) return;
    const now = Date.now();
    const user: ChatMessage = { ...original, id: crypto.randomUUID(), parentId, role: "user", content,
      modelContent: original ? editedDocumentContent(content, original, content) : undefined,
      hidden: Boolean(authResumeId), createdAt: now };
    const assistant: ChatMessage = { id: crypto.randomUUID(), parentId: user.id, role: "assistant", content: "", createdAt: now, tools: [], streaming: true };
    setMessages(current => [...withParents(current), user, assistant]);
    setActiveLeaf(assistant.id);
    await executeFocusStream(selected, content, assistant.id, { respectInterval: false, user, authResumeId });
  }

  async function sendFollowup() {
    const prompt = draft.trim();
    if (!prompt || streaming) return;
    setDraft("");
    await submitFocusPrompt(prompt, visibleMessages.at(-1)?.id ?? null);
  }

  async function editPrompt(message: ChatMessage, content: string) {
    if (!selected || streaming) return;
    const original = withParents(messages).find(node => node.id === message.id);
    if (!original) return;
    try {
      // Update the existing task, preserving its ID, thread and history.
      const saved = await saveFocus({ ...selected, description: content });
      const updated = saved.data?.item;
      if (!updated) throw new Error("关注要求保存失败");
      setItems(current => current.map(item => item.id === updated.id ? updated : item));
      await submitFocusPrompt(content, original.parentId ?? null, original);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "关注编辑失败"); }
  }

  async function switchVersion(id: string) {
    if (!selected || streaming) return;
    try {
      const leafId = latestDescendant(messages, id);
      const response = await fetch(`/api/memory/threads/${encodeURIComponent(selected.threadId || selected.id)}/version`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resourceId: selected.resourceId, leafId }),
      });
      if (!response.ok) throw new Error("切换关注会话版本失败");
      setActiveLeaf(leafId);
      onHistoryChange?.();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "切换失败"); }
  }

  async function approveTool(message: ChatMessage, tool: ToolRun, approved: boolean) {
    if (!selected || streaming || !tool.approvalId) return;
    try {
      const query = new URLSearchParams({ resourceId: selected.resourceId || "seudaily-focus-local" });
      const response = await fetch(`/api/memory/threads/${encodeURIComponent(selected.threadId || selected.id)}/run?${query}`);
      if (!response.ok) throw new Error("读取关注审批状态失败");
      const { pending } = await response.json();
      if (pending?.approvalId !== tool.approvalId) throw new Error("审批已失效，请重新打开关注会话");
      mutateMessage(message.id, current => ({ ...current, streaming: true, error: undefined }));
      await executeFocusStream(selected, "", message.id, { respectInterval: false,
        approval: { approvalId: pending.approvalId, approved, runToken: pending.runToken } });
    } catch (reason) { setError(reason instanceof Error ? reason.message : "审批失败"); }
  }

  async function authorize(request: AgentAuthRequest) {
    const resumed = await executeAgentAuthRequest(request.id);
    await submitFocusPrompt(`[SEUDAILY_AUTH_RESUME id=${resumed.resumeId}] 登录已完成，请继续原任务。`, visibleMessages.at(-1)?.id ?? null, undefined, resumed.resumeId);
  }

  async function applyAction(request: AgentActionRequest) {
    await executeAgentActionRequest(request.id);
    await load(false);
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (ime.isComposing(event)) return;
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendFollowup(); }
  }

  function onSubmit(event: FormEvent) { event.preventDefault(); void sendFollowup(); }

  async function toggle(item: FocusItem) {
    try { await saveFocus({ ...item, enabled: !item.enabled }); await load(false); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "关注更新失败"); }
  }

  async function remove(id: string) {
    try { await deleteFocus(id); setItems((current) => current.filter((item) => item.id !== id)); if (selectedId === id) setSelectedId(""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "关注删除失败"); }
  }

  async function checkNow() {
    setRunning(true); setError("");
    try { await runFocus(); await load(false); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "关注检查失败"); }
    finally { setRunning(false); }
  }

  if (selected) return <div className="focus-chat-panel">
    <header className="topbar focus-chat-topbar"><button className="icon-button" aria-label="返回关注列表" title="返回关注列表" onClick={() => { externalFocusRef.current = ""; setSelectedId(""); setMessages([]); onSelectedFocusChange?.(""); }}><ArrowLeft size={20} /></button><h1>{selected.title}</h1><span className={`focus-chat-state ${streaming ? "running" : selected.enabled ? "enabled" : "paused"}`}>{streaming ? "执行中" : selected.enabled ? "已启用" : "已暂停"}</span></header>
    <section className="chat-scroll focus-chat-scroll">{error && <div className="page-state error">{error}</div>}{conversationLoading ? <div className="page-state"><LoaderCircle className="spin" size={20} /><span>正在读取会话…</span></div> : <div className="message-list">{visibleMessages.length ? visibleMessages.map((message) => <div key={message.id}>{renderMessage ? renderMessage(message, {
      disabled: streaming, onEdit: editPrompt, onAuth: authorize, onAction: applyAction, onApproval: (tool, approved) => void approveTool(message, tool, approved),
      versions: <PromptVersions messages={messages} message={message} leaf={activeLeaf} disabled={streaming} onSwitch={id => void switchVersion(id)} />,
    }) : <article className={`focus-message ${message.role}`}><ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>{normalizeMathMarkdown(message.content)}</ReactMarkdown></article>}</div>) : <div className="focus-empty-chat">还没有会话内容，可以在下方补充任务要求。</div>}<div ref={messageEndRef} /></div>}</section>
    <form className="composer-wrap focus-chat-composer" onSubmit={onSubmit}><div className="composer"><textarea value={draft} onChange={(event) => setDraft(event.target.value)} onCompositionStart={ime.onCompositionStart} onCompositionEnd={ime.onCompositionEnd} onKeyDown={onComposerKeyDown} placeholder="补充或修正这项关注的要求" rows={1} disabled={streaming} />{streaming ? <button type="button" className="send-button stop" onClick={() => abortRef.current?.abort()} aria-label="停止回答"><CircleStop size={19} /></button> : <button type="submit" className="send-button" disabled={!draft.trim()} aria-label="发送消息"><ArrowUp size={20} /></button>}</div><div className="composer-hint"><span>Enter 发送 · Shift + Enter 换行</span><span>消息会追加到这项关注的独立会话</span></div></form>
  </div>;

  return <div className="workspace-page focus-page focus-list-page">
    <PageHeader title="关注" description="" action={<div className="schedule-actions focus-actions"><button className="page-action" onClick={() => setAdding("notice")}>关注通知</button><button className="page-action" onClick={() => setAdding("course")}>关注课程</button><button className="page-action primary" disabled={running} onClick={() => void checkNow()}>立即检查</button></div>} />
    {error && <div className="page-state error">{error}</div>}
    <PageState loading={loading} error="">{items.length ? <div className="focus-list">{items.map((item) => <article className="focus-card" key={item.id} onClick={() => void openFocus(item)}><div className="focus-card-copy"><strong>{item.title}</strong><small>{item.lastCheckedAt ? `上次执行 ${new Date(item.lastCheckedAt).toLocaleString("zh-CN")}` : "尚未执行"}</small></div><button className={`focus-toggle ${item.enabled ? "on" : ""}`} onClick={(event) => { event.stopPropagation(); void toggle(item); }}>{item.enabled ? "已启用" : "已暂停"}</button><button className="focus-delete" onClick={(event) => { event.stopPropagation(); void remove(item.id); }}>删除</button></article>)}</div> : <div className="page-empty compact focus-empty"><h2>还没有关注</h2></div>}</PageState>
    {adding && <div className="confirm-overlay"><div className="course-editor focus-editor"><button className="confirm-close focus-close" aria-label="关闭" disabled={creating} onClick={() => setAdding(null)}>关闭</button><h2>{adding === "notice" ? "新建通知关注" : "新建课程关注"}</h2><p className="focus-permission-notice">创建即授权该关注完全访问，可自动查询、抓取和生成资料，无需逐次审批。不包含 extra 工作区文件和终端权限，也不改变普通会话权限。验证码或交互登录仍需你完成。</p><div className="course-editor-grid"><label className="wide"><span>关注名称</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder={adding === "notice" ? "例如：推免信息" : "例如：课程转写跟进"} /></label><label className="wide"><span>交给 Agent 的持续任务</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder={adding === "notice" ? "例如：持续关注本校推免政策、报名节点和夏令营，普通成绩公示不用提醒" : "例如：关注张老师的编译原理，即使不在我的课表；发现新课次一天后抓取转写并总结"} /></label></div><div className="confirm-actions"><button disabled={creating} onClick={() => setAdding(null)}>取消</button><button className="primary" disabled={creating || !title.trim() || !description.trim()} onClick={() => void create()}>{creating ? "正在创建…" : "授权并创建"}</button></div></div></div>}
  </div>;
}


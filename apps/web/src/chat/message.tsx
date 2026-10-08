import {ArrowUp,BookOpen,Bot,ChevronRight,CircleAlert,FileText,Pencil,RefreshCw, X} from "lucide-react";
import {useEffect,useState,type ReactNode} from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import {normalizeMathMarkdown} from "../markdown";
import {libraryPreviewUrl} from "../api";
import type {AgentActionRequest,AgentAuthRequest} from "../api";
import type {AgentProcessEntry,ChatMessage,ImageAttachment,ToolRun} from "../types";
import {ToolGlyph,toolLabel,toolNarration} from "./tool-presentation";
import {CopyButton,MarkdownContent} from "./markdown-content";
import {messageSources} from "./sources-sidebar";
function attachmentSource(image: ImageAttachment) { return image.dataUrl ?? (image.path ? libraryPreviewUrl(image.path) : ""); }

function MessageTime({ timestamp }: { timestamp: number }) {
  const expiresAt = timestamp + 24 * 60 * 60 * 1000;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    const remaining = expiresAt - Date.now();
    if (!Number.isFinite(remaining) || remaining < 0) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(remaining + 1, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [expiresAt]);
  if (!Number.isFinite(timestamp) || now > expiresAt) return null;
  const date = new Date(timestamp);
  return <time dateTime={date.toISOString()}>{date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}</time>;
}


function MessageImage({ image, onPreview }: { image: ImageAttachment; onPreview?: (image: ImageAttachment) => void }) {
  const source = attachmentSource(image);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [source]);
  if (!source || failed) return null;
  return <button type="button" onClick={() => onPreview?.(image)}><img src={source} alt={image.name} onError={() => setFailed(true)} /></button>;
}



function ApprovalButtons({ tool, onApproval }: { tool: ToolRun; onApproval?: (approved: boolean) => void }) {
  if (tool.state !== "approval-requested" || !tool.approvalId || !onApproval) return null;
  return <div className="tool-approval"><span>需要你的许可才能继续</span><div><button type="button" onClick={() => onApproval(false)}>拒绝</button><button type="button" className="primary" onClick={() => onApproval(true)}>批准</button></div></div>;
}

function ToolActivity({ tools, process = [], streaming, reasoningActive, onApproval }: { tools: ToolRun[]; process?: AgentProcessEntry[]; streaming?: boolean; reasoningActive?: boolean; onApproval?: (tool: ToolRun, approved: boolean) => void }) {
  const [open, setOpen] = useState(Boolean(streaming));
  const runningTool = [...tools].reverse().find((tool) => tool.state === "running");
  const approvalTool = [...tools].reverse().find((tool) => tool.state === "approval-requested");
  const failedCount = tools.filter((tool) => tool.state === "failed").length;
  const referencedToolIds = new Set(process.flatMap((entry) => entry.type === "tool" ? [entry.toolId] : []));
  const entries: AgentProcessEntry[] = [
    ...process,
    ...tools.filter((tool) => !referencedToolIds.has(tool.id)).map((tool) => ({ id: `tool-${tool.id}`, type: "tool" as const, toolId: tool.id })),
  ];
  const sequence: Array<{ id: string; type: "activity"; entries: AgentProcessEntry[] } | { id: string; type: "text"; text: string }> = [];
  let activityEntries: AgentProcessEntry[] = [];
  const flushActivityEntries = () => {
    if (!activityEntries.length) return;
    sequence.push({ id: `segment-${activityEntries[0].id}`, type: "activity", entries: activityEntries });
    activityEntries = [];
  };
  for (const entry of entries) {
    if (entry.type === "narration") {
      flushActivityEntries();
      if (entry.text.trim()) sequence.push({ id: entry.id, type: "text", text: entry.text });
    } else {
      activityEntries.push(entry);
    }
  }
  flushActivityEntries();

  useEffect(() => {
    setOpen(Boolean(streaming));
  }, [streaming]);

  const focusTool = runningTool ?? approvalTool ?? tools.at(-1);
  const statusText = runningTool
    ? toolNarration(runningTool, "running")
    : approvalTool
      ? `等待批准：${toolLabel(approvalTool.name)}`
      : streaming
        ? reasoningActive ? "正在思考" : "正在继续处理"
        : failedCount
          ? `已完成思考，${failedCount} 项操作失败`
          : "已完成思考";

  return (
    <div className={`tool-activity ${open ? "open" : ""}`}>
      <button type="button" className="tool-activity-toggle" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span className={`tool-activity-status ${runningTool ? "running" : failedCount ? "failed" : "done"}`}>
          {failedCount && !runningTool ? <CircleAlert size={19} className="error-icon" /> : focusTool ? <ToolGlyph name={focusTool.name} size={19} /> : <Bot size={19} />}
        </span>
        <span>{statusText}</span>
        <ChevronRight className="tool-activity-chevron" size={18} />
      </button>
      {open && (
        <div className="tool-activity-sequence">
          {sequence.map((block) => block.type === "text"
            ? <div className="tool-activity-text" key={block.id}><MarkdownContent text={block.text} /></div>
            : <div className="tool-activity-list" key={block.id}>{block.entries.map((entry) => {
              if (entry.type === "reasoning") {
                if (!entry.text.trim()) return null;
                return <div className="process-text reasoning" key={entry.id}><ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>{normalizeMathMarkdown(entry.text)}</ReactMarkdown></div>;
              }
              if (entry.type !== "tool") return null;
              const tool = tools.find((item) => item.id === entry.toolId);
              if (!tool) return null;
              return (
                <div className="tool-activity-item" key={entry.id}>
                  <span className={tool.state === "running" ? "active" : ""}>{tool.state === "failed" || tool.state === "approval-requested" ? <CircleAlert size={18} className={tool.state === "failed" ? "error-icon" : undefined} /> : <ToolGlyph name={tool.name} size={18} />}</span>
                  <div><strong>{tool.state === "approval-requested" ? `等待批准：${toolLabel(tool.name)}` : tool.result?.summary ?? toolNarration(tool, tool.state === "running" ? "running" : "completed")}</strong><ApprovalButtons tool={tool} onApproval={(approved) => onApproval?.(tool, approved)} /></div>
                </div>
              );
            })}</div>)}
        </div>
      )}
    </div>
  );
}

function visibleUserContent(content: string) {
  if (/^\[SEUDAILY_AUTH_RESUME\s+id=auth-[^\]]+\]/i.test(content)) return "";
  return content.replace(/^\[SEUDAILY_ACTION_REQUEST\s+id=action-[^\]]+\]\s*/i, "").trim();
}


function StreamingProcess({ message, onApproval }: { message: ChatMessage; onApproval?: (tool: ToolRun, approved: boolean) => void }) {
  const blocks: Array<{ id: string; type: "activity"; entries: AgentProcessEntry[] } | { id: string; type: "text"; text: string }> = [];
  let activity: AgentProcessEntry[] = [];
  const flushActivity = () => {
    if (!activity.length) return;
    blocks.push({ id: `activity-${activity[0].id}`, type: "activity", entries: activity });
    activity = [];
  };

  for (const entry of message.process ?? []) {
    if (entry.type === "narration") {
      flushActivity();
      if (entry.text.trim()) blocks.push({ id: entry.id, type: "text", text: entry.text });
    } else {
      activity.push(entry);
    }
  }
  flushActivity();

  if (!blocks.some((block) => block.type === "activity") && message.tools?.length) {
    blocks.unshift({ id: "activity-tools", type: "activity", entries: [] });
  }
  let lastActivityIndex = -1;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (blocks[index].type === "activity") {
      lastActivityIndex = index;
      break;
    }
  }

  return <>
    {blocks.map((block, index) => {
      if (block.type === "text") return <MarkdownContent key={block.id} text={block.text} />;
      const toolIds = new Set(block.entries.flatMap((entry) => entry.type === "tool" ? [entry.toolId] : []));
      const tools = (message.tools ?? []).filter((tool) => toolIds.has(tool.id) || (!block.entries.length && block.id === "activity-tools"));
      const active = index === lastActivityIndex && block === blocks.at(-1);
      return <div className="inline-tools" key={block.id}><ToolActivity tools={tools} process={block.entries} streaming={active} reasoningActive={active && message.reasoningActive} onApproval={onApproval} /></div>;
    })}
  </>;
}


function actionRequestFromTool(tool: ToolRun): AgentActionRequest | null {
  if (!["propose-local-action", "proposeLocalActionTool", "request-create-focus", "request-modify-schedule"].includes(tool.name)) return null;
  const data = tool.result?.data;
  if (!data || typeof data !== "object") return null;
  const value = (data as { actionRequest?: unknown }).actionRequest;
  if (!value || typeof value !== "object") return null;
  const request = value as Record<string, unknown>;
  if (typeof request.id !== "string" || typeof request.text !== "string") return null;
  if (!["create-focus", "modify-schedule", "create_focus", "add_schedule", "update_schedule", "move_schedule"].includes(String(request.kind))) return null;
  return {
    id: request.id,
    kind: String(request.kind) as AgentActionRequest["kind"],
    text: request.text,
    expiresAt: typeof request.expiresAt === "string" ? request.expiresAt : undefined,
  };
}

function MessageActionRequests({ tools, disabled, onAction }: { tools: ToolRun[]; disabled?: boolean; onAction?: (request: AgentActionRequest) => Promise<void> }) {
  const [pendingId, setPendingId] = useState("");
  const [completedIds, setCompletedIds] = useState<string[]>([]);
  const [error, setError] = useState("");
  const requests = Array.from(new Map(tools.flatMap((tool) => {
    const request = actionRequestFromTool(tool);
    return request ? [[request.id, request] as const] : [];
  })).values());
  if (!requests.length) return null;

  async function activate(request: AgentActionRequest) {
    if (!onAction || pendingId || completedIds.includes(request.id)) return;
    setPendingId(request.id);
    setError("");
    try {
      await onAction(request);
      setCompletedIds((current) => [...current, request.id]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "操作请求提交失败");
    } finally {
      setPendingId("");
    }
  }

  return <section className="message-action-requests">
    {requests.some(request => ["create-focus", "create_focus"].includes(request.kind)) && <p className="focus-permission-notice">创建即授权该关注完全访问，可自动执行其任务；不包含 extra 工作区文件和终端权限。</p>}
    <div className="message-action-request-list">{requests.map((request) => {
      const completed = completedIds.includes(request.id);
      return <button type="button" key={request.id} disabled={disabled || !onAction || Boolean(pendingId) || completed} onClick={() => void activate(request)}>
        {pendingId === request.id ? "正在发起…" : completed ? "已发起" : request.text}
        <ArrowUp size={14} />
      </button>;
    })}</div>
    {error && <div className="message-action-request-error">{error}</div>}
  </section>;
}

function authRequestFromTool(tool: ToolRun): AgentAuthRequest | null {
  const data = tool.result?.data;
  if (!data || typeof data !== "object") return null;
  const value = (data as { authRequest?: unknown }).authRequest;
  if (!value || typeof value !== "object") return null;
  const request = value as Record<string, unknown>;
  if (typeof request.id !== "string" || typeof request.text !== "string" || (request.target !== "schedule" && request.target !== "course")) return null;
  return { id: request.id, target: request.target, text: request.text, expiresAt: typeof request.expiresAt === "string" ? request.expiresAt : undefined };
}

function MessageAuthRequests({ tools, disabled, onAuth }: { tools: ToolRun[]; disabled?: boolean; onAuth?: (request: AgentAuthRequest) => Promise<void> }) {
  const [pendingId, setPendingId] = useState("");
  const [completedIds, setCompletedIds] = useState<string[]>([]);
  const [error, setError] = useState("");
  const requests = Array.from(new Map(tools.flatMap((tool) => {
    const request = authRequestFromTool(tool);
    return request ? [[request.id, request] as const] : [];
  })).values());
  if (!requests.length) return null;
  async function authorize(request: AgentAuthRequest) {
    if (!onAuth || pendingId || completedIds.includes(request.id)) return;
    setPendingId(request.id); setError("");
    try { await onAuth(request); setCompletedIds((current) => [...current, request.id]); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "登录续接失败"); }
    finally { setPendingId(""); }
  }
  return <section className="message-action-requests"><div className="message-action-request-list">{requests.map((request) => {
    const completed = completedIds.includes(request.id);
    return <button type="button" key={request.id} disabled={disabled || !onAuth || Boolean(pendingId) || completed} onClick={() => void authorize(request)}>{pendingId === request.id ? "正在登录…" : completed ? "已登录并续接" : request.text}<ArrowUp size={14} /></button>;
  })}</div>{error && <div className="message-action-request-error">{error}</div>}</section>;
}

export function Message({ message, canRegenerate = false, disabled = false, onEdit, onRegenerate, onPreviewImage, onApproval, onActionRequest, onAuthRequest, onBranch, versionControls, onSources, sourcesOpen = false }: {
  message: ChatMessage;
  versionControls?: ReactNode;
  canRegenerate?: boolean;
  disabled?: boolean;
  onEdit?: (message: ChatMessage, content: string) => void;
  onRegenerate?: (message: ChatMessage) => void;
  onBranch?: (message: ChatMessage) => void;
  onPreviewImage?: (image: ImageAttachment) => void;
  onApproval?: (tool: ToolRun, approved: boolean) => void;
  onActionRequest?: (request: AgentActionRequest) => Promise<void>;
  onAuthRequest?: (request: AgentAuthRequest) => Promise<void>;
  onSources?: (message: ChatMessage) => void;
  sourcesOpen?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(message.content);
  const hasProcess = Boolean(message.reasoningActive || message.reasoningDone || message.process?.length || message.tools?.length);

  if (message.role === "user") {
    return (
      <article className="message user-message">
        {editing ? (
          <div className="prompt-editor">
            <textarea value={editValue} onChange={(event) => setEditValue(event.target.value)} autoFocus />
            <div><button type="button" onClick={() => { setEditing(false); setEditValue(message.content); }}>取消</button><button type="button" className="primary" disabled={!editValue.trim()} onClick={() => { setEditing(false); onEdit?.(message, editValue.trim()); }}>发送</button></div>
          </div>
        ) : <div className="user-bubble">
          {!!message.attachments?.length && <div className="message-images">{message.attachments.map((image) => <MessageImage key={image.id} image={image} onPreview={onPreviewImage} />)}</div>}
          {!!message.documents?.length && <div className="message-documents">{message.documents.map((document) => <div className="message-document" key={document.id}><FileText size={17} /><div><strong title={document.name}>{document.name}</strong>{document.charCount > 0 && <span>{document.charCount.toLocaleString("zh-CN")} 字符</span>}</div></div>)}</div>}
          {visibleUserContent(message.content) && <span>{visibleUserContent(message.content)}</span>}
        </div>}
        {!editing && versionControls}
        {!editing && <div className="user-meta"><MessageTime timestamp={message.createdAt} /><CopyButton text={visibleUserContent(message.content)} label="复制提示词" iconOnly />{onEdit && <button type="button" className="message-action" aria-label="编辑提示词" title="编辑提示词" disabled={disabled} onClick={() => setEditing(true)}><Pencil size={14} /></button>}</div>}
      </article>
    );
  }

  return (
    <article className="message assistant-message">
      <div className="assistant-body">
        {hasProcess && message.streaming && (
          <StreamingProcess message={message} onApproval={onApproval} />
        )}
        {hasProcess && !message.streaming && (
          <div className="inline-tools">
            <ToolActivity tools={message.tools ?? []} process={message.process} streaming={message.streaming} reasoningActive={message.reasoningActive} onApproval={onApproval} />
          </div>
        )}
        {message.content ? (
          <MarkdownContent text={message.content} />
        ) : message.streaming && !hasProcess ? (
          <div className="thinking"><span /><span /><span /> 正在思考</div>
        ) : null}
        {message.error && <div className="message-error"><CircleAlert size={16} className="error-icon" />{message.error}</div>}
        {!message.streaming && !message.error && <MessageAuthRequests tools={message.tools ?? []} disabled={disabled} onAuth={onAuthRequest} />}
        {!message.streaming && !message.error && <MessageActionRequests tools={message.tools ?? []} disabled={disabled} onAction={onActionRequest} />}
        {!message.streaming && !message.error && <div className="message-meta"><MessageTime timestamp={message.createdAt} />{message.content && <CopyButton text={message.content} label="复制回答" iconOnly />}{canRegenerate && <button type="button" className="message-action" aria-label="重新生成" title="重新生成" disabled={disabled} onClick={() => onRegenerate?.(message)}><RefreshCw size={14} /></button>}{onBranch && <button type="button" className="message-action" title="分支为新会话" aria-label="分支为新会话" disabled={disabled} onClick={()=>onBranch(message)}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="6" cy="5" r="2.5" /><circle cx="6" cy="19" r="2.5" /><circle cx="18" cy="5" r="2.5" /><path d="M6 7.5v9M18 7.5A11.5 11.5 0 0 1 6 16.5" /></svg></button>}{onSources && messageSources(message).length > 0 && <button type="button" className={`message-action source-action ${sourcesOpen ? "is-open" : ""}`} title="来源" aria-label="来源" aria-expanded={sourcesOpen} aria-controls="message-sources-panel" onClick={() => onSources(message)}><BookOpen size={17} /></button>}</div>}
      </div>
    </article>
  );
}


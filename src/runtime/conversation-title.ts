import type { AgentStore } from "../agent/storage.js";
import { isProgramConversation } from '../shared/conversation-policy.js';
export const titleGenerationTasks = new Map<
  string,
  Promise<{ title: string; generated: boolean; reason?: string }>
>();

function compactTitleInput(value: unknown) {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").trim().slice(0, 600)
    : "";
}

function cleanGeneratedTitle(value: unknown) {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\r\n]+/g, " ")
    .replace(/^[\s“”‘’"'《》【】]+|[\s“”‘’"'《》【】。！？!?，,：:；;]+$/g, "")
    .replace(/\.(pdf|docx|xlsx|pptx)(?=\s|$)/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
}

function fallbackConversationTitle(titleInput: string) {
  const withoutExtension = titleInput.replace(/\.(pdf|docx|xlsx|pptx)$/i, "");
  const cleaned = cleanGeneratedTitle(withoutExtension);
  return cleaned.length > 24 ? cleaned.slice(0, 24) : cleaned || "新对话";
}

async function requestConversationTitle(titleInput: string) {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) throw new Error("未配置 DEEPSEEK_API_KEY");
  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.DEEPSEEK_MODEL?.trim() || "deepseek-flash",
      messages: [
        {
          role: "system",
          content:
            '你是对话标题生成器。根据用户请求或附件文件名生成一个可辨识的短标题。跟随用户语言；中文通常6到14字，英文通常3到8词；不要保留 PDF、DOCX、XLSX、PPTX 扩展名，不要引号、句号、emoji或‘关于/讨论’等套话。只返回合法 JSON，格式为 {"title":"标题"}。',
        },
        { role: "user", content: titleInput },
      ],
      thinking: { type: "disabled" },
      response_format: { type: "json_object" },
      temperature: 0.2,
      max_tokens: 160,
      stream: false,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    throw new Error(`DeepSeek 标题生成失败（${response.status}）`);
  const result = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = result.choices?.[0]?.message?.content;
  if (!content) return fallbackConversationTitle(titleInput);
  let parsedTitle: unknown;
  try {
    parsedTitle = (JSON.parse(content) as { title?: unknown }).title;
  } catch {
    return fallbackConversationTitle(titleInput);
  }
  const title = cleanGeneratedTitle(parsedTitle);
  if (!title) throw new Error("DeepSeek 返回了空标题");
  return title;
}

type TitleInput = { threadId: string; resourceId: string };
type TitleDependencies = { store?: AgentStore; request?: (text: string) => Promise<string> };

function messageText(content: any): string {
  if (typeof content === "string") return compactTitleInput(content.split('<!-- seudaily:documents -->')[0]);
  const parts = Array.isArray(content) ? content : content?.parts ?? [];
  return compactTitleInput(parts.filter((part: any) => part.type === "text").map((part: any) => part.text ?? "").join("\n").split('<!-- seudaily:documents -->')[0]);
}

function attachmentName(content: any): string {
  const parts = Array.isArray(content) ? content : content?.parts ?? [];
  const file = parts.find((part:any) => part.type === 'file' && part.filename);
  if (file) return compactTitleInput(file.filename);
  const text = typeof content === 'string' ? content : parts.filter((part:any)=>part.type === 'text').map((part:any)=>part.text ?? '').join('\n');
  return compactTitleInput(text.match(/【附件：([^】]+)】/)?.[1]);
}

export function hasConversationTopic(text: string): boolean {
  const value = text.trim().replace(/[\s，。！？!?、,.：:；;～~]+/g, "").toLowerCase();
  return Boolean(value) && !/^(你好|您好|嗨|哈喽|hello|hi|hey|在吗|你是谁|介绍一下自己|谢谢|继续|好的|ok)$/.test(value)
    && !/^\/|^<\/?(?:upload|attachment)>|^\[SEUDAILY_AUTH_RESUME\b/i.test(text.trim());
}

/** All entrances share background naming, including deduplication of concurrent completions. */
export function ensureConversationTitle(input: TitleInput, dependencies: TitleDependencies = {}) {
  const key = `${input.resourceId}:${input.threadId}`;
  const running = titleGenerationTasks.get(key);
  if (running) return running;
  const task = generateTitle(input, dependencies).finally(() => titleGenerationTasks.delete(key));
  titleGenerationTasks.set(key, task);
  return task;
}

async function generateTitle(input: TitleInput, dependencies: TitleDependencies) {
  const memoryStore = dependencies.store ?? (await import('./storage.js')).agentStore;
  const getThread = () => memoryStore.getThreadById({threadId:input.threadId,resourceId:input.resourceId});
  const thread = await getThread();
  if (!thread) return {title:"",generated:false,reason:"thread-not-found"};
  if (isProgramConversation(thread.resourceId,thread.metadata?.channel))
    return {title:thread.title ?? '',generated:false,reason:'program-title'};
  if (thread.metadata?.titleManual) return {title:thread.title ?? "",generated:false,reason:"manual-title"};
  if (typeof thread.metadata?.titleGeneratedAt === "string")
    return {title:thread.title ?? "",generated:false,reason:"already-generated"};
  const history = await memoryStore.allMessages(input.threadId,input.resourceId);
  const users = history.filter(message => message.role === "user");
  if (!users.length) return {title:thread.title ?? "",generated:false,reason:"no-user-message"};
  // Old unmarked titles are preserved; every new client gets the same provisional state.
  if (thread.title?.trim() && !thread.metadata?.titleProvisional)
    return {title:thread.title,generated:false,reason:"existing-title"};
  const topic = users.map(message => messageText(message.content)).find(hasConversationTopic);
  const titleInput = topic || users.map(message=>attachmentName(message.content)).find(Boolean) || '';
  if (!titleInput) {
    await memoryStore.patchThread({id:input.threadId,preserveUpdatedAt:true,metadata:{...thread.metadata,titleProvisional:true}});
    return {title:thread.title ?? "",generated:false,reason:"waiting-for-topic"};
  }
  await memoryStore.patchThread({id:input.threadId,preserveUpdatedAt:true,metadata:{...thread.metadata,titleProvisional:true,titleGenerationAttempted:true,titleGenerationAttemptedAt:new Date().toISOString()}});
  let title: string;
  try {
    title = await (dependencies.request ?? requestConversationTitle)(titleInput);
  } catch(error) {
    const latest = await getThread();
    if (latest) await memoryStore.patchThread({id:input.threadId,preserveUpdatedAt:true,metadata:{...latest.metadata,titleGenerationError:error instanceof Error ? error.message : "标题生成失败"}});
    throw error;
  }
  const latest = await getThread();
  if (!latest) return {title:"",generated:false,reason:"thread-not-found"};
  if (latest.metadata?.titleManual || latest.metadata?.titleGeneratedAt)
    return {title:latest.title ?? "",generated:false,reason:"title-changed"};
  const generatedAt = new Date().toISOString();
  await memoryStore.patchThread({id:input.threadId,preserveUpdatedAt:true,title,metadata:{...latest.metadata,titleProvisional:false,titleGenerationError:undefined,titleGeneratedAt:generatedAt,titleUpdatedAt:generatedAt}});
  return {title,generated:true};
}

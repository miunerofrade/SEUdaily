import { agentStore } from "./storage.js";
export const titleGenerationTasks = new Map<
  string,
  Promise<{ title: string; generated: boolean; reason?: string }>
>();

export function compactTitleInput(value: unknown) {
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

export async function generateFirstTurnTitle(input: {
  threadId: string;
  resourceId: string;
  titleInput: string;
}) {
  const memoryStore = agentStore;
  if (!memoryStore) throw new Error("会话存储不可用");
  const thread = await memoryStore.getThreadById({
    threadId: input.threadId,
    resourceId: input.resourceId,
  });
  if (!thread)
    return { title: "", generated: false, reason: "thread-not-found" };
  if (typeof thread.metadata?.titleGeneratedAt === "string") {
    return {
      title: thread.title?.trim() ?? "",
      generated: false,
      reason: "already-generated",
    };
  }
  const history = await memoryStore.listMessages({
    threadId: input.threadId,
    resourceId: input.resourceId,
    perPage: 20,
    includeTotal: false,
  });
  const userMessageCount = history.messages.filter(
    (message) => message.role === "user",
  ).length;
  if (userMessageCount !== 1 && thread.title?.trim()) {
    return {
      title: thread.title?.trim() ?? "",
      generated: false,
      reason: "not-first-turn",
    };
  }
  // CLI histories may predate automatic naming. Recover their original topic,
  // never overwrite a named multi-turn conversation with a later request.
  if (!thread.title?.trim()) {
    const first = await memoryStore.firstUserMessage(
      input.threadId,
      input.resourceId,
    );
    if (!first)
      return { title: "", generated: false, reason: "no-user-message" };
    const content = first.content as any;
    const firstText =
      typeof content === "string"
        ? content
        : (Array.isArray(content) ? content : (content?.parts ?? []))
            .filter((part: any) => part.type === "text")
            .map((part: any) => part.text ?? "")
            .join("\n");
    input = {
      ...input,
      titleInput: compactTitleInput(firstText) || input.titleInput,
    };
  }
  await memoryStore.patchThread({
    id: input.threadId,
    preserveUpdatedAt: true,
    metadata: {
      ...thread.metadata,
      titleGenerationAttempted: true,
      titleGenerationAttemptedAt: new Date().toISOString(),
    },
  });
  let title: string;
  try {
    title = await requestConversationTitle(input.titleInput);
  } catch (error) {
    await memoryStore.patchThread({
      id: input.threadId,
      preserveUpdatedAt: true,
      metadata: {
        ...thread.metadata,
        titleGenerationAttempted: true,
        titleGenerationError:
          error instanceof Error ? error.message : "标题生成失败",
      },
    });
    throw error;
  }
  await memoryStore.patchThread({
    id: input.threadId,
    preserveUpdatedAt: true,
    title,
    metadata: {
      ...thread.metadata,
      titleGenerationAttempted: true,
      titleGeneratedAt: new Date().toISOString(),
    },
  });
  return { title, generated: true };
}

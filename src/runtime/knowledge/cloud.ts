export class RetryableKnowledgeError extends Error {}
function providerError(status: number, message: string) {
  return status === 429 || status === 408 || status >= 500
    ? new RetryableKnowledgeError(message)
    : new Error(message);
}
async function providerFetch(
  url: string,
  options: RequestInit,
): Promise<Response> {
  try {
    return await fetch(url, options);
  } catch (error) {
    if (
      error instanceof TypeError ||
      (error as Error).name === "TimeoutError"
    ) {
      throw new RetryableKnowledgeError(
        "向量或重排服务暂时无法连接，请稍后重试",
      );
    }
    throw error;
  }
}

export type EmbeddingConfig = {
  key: string;
  model: string;
  baseUrl: string;
  rerankModel?: string;
};
export type Embed = (
  texts: string[],
  config: EmbeddingConfig,
  signal?: AbortSignal,
) => Promise<number[][]>;
export function vectorValid(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 8192 &&
    value.every((n) => typeof n === "number" && Number.isFinite(n)) &&
    value.some((n) => n !== 0)
  );
}

export async function cloudEmbedding(
  texts: string[],
  config: EmbeddingConfig,
  signal?: AbortSignal,
): Promise<number[][]> {
  if (!config.key) throw new Error("请在设置中填写阿里云 API Key");
  const url = new URL(config.baseUrl);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("向量服务地址必须是 HTTPS 地址");
  const response = await providerFetch(
    config.baseUrl.replace(/\/$/, "") + "/embeddings",
    {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.any([
        AbortSignal.timeout(60_000),
        ...(signal ? [signal] : []),
      ]),
      headers: {
        Authorization: `Bearer ${config.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        input: texts,
        encoding_format: "float",
      }),
    },
  );
  // Do not include upstream bodies: they can echo API keys or uploaded content.
  if (!response.ok)
    throw providerError(
      response.status,
      `向量服务请求失败（HTTP ${response.status}）${response.status === 429 ? "，请稍后重试" : ""}`,
    );
  const body = (await response.json()) as any;
  if (!Array.isArray(body.data) || body.data.length !== texts.length)
    throw new Error("向量服务返回数量不匹配");
  const vectors: number[][] = new Array(texts.length);
  for (const item of body.data) {
    if (
      !Number.isInteger(item.index) ||
      item.index < 0 ||
      item.index >= texts.length ||
      vectors[item.index] ||
      !vectorValid(item.embedding)
    )
      throw new Error("向量服务返回格式无效");
    vectors[item.index] = item.embedding;
  }
  if (new Set(vectors.map((v) => v.length)).size !== 1)
    throw new Error("向量维度不一致");
  return vectors;
}

export const MAX_KNOWLEDGE_RECALL = 32;
export type Rank = (
  query: string,
  texts: string[],
  config: EmbeddingConfig,
  limit: number,
  signal?: AbortSignal,
) => Promise<{ index: number; relevance_score: number }[]>;
export async function cloudRerank(
  query: string,
  texts: string[],
  config: EmbeddingConfig,
  limit: number,
  signal?: AbortSignal,
) {
  if (!config.key) throw new Error("请在设置中填写阿里云 API Key");
  const url = new URL(config.baseUrl);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("阿里云服务地址必须是 HTTPS 地址");
  const compatible = config.rerankModel === "qwen3-rerank";
  url.pathname = compatible
    ? "/compatible-api/v1/reranks"
    : "/api/v1/services/rerank/text-rerank/text-rerank";
  const body = compatible
    ? { model: config.rerankModel, query, documents: texts, top_n: limit }
    : {
        model: config.rerankModel,
        input: { query, documents: texts },
        parameters: { top_n: limit },
      };
  const response = await providerFetch(url.toString(), {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.any([
      AbortSignal.timeout(30_000),
      ...(signal ? [signal] : []),
    ]),
    headers: {
      Authorization: `Bearer ${config.key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok)
    throw providerError(
      response.status,
      `重排服务请求失败（HTTP ${response.status}）`,
    );
  const data = (await response.json()) as any,
    results = compatible ? data.results : data.output?.results;
  if (
    !Array.isArray(results) ||
    results.length !== Math.min(limit, texts.length)
  )
    throw new Error("重排服务返回数量不匹配");
  const seen = new Set<number>();
  for (const item of results) {
    if (
      !Number.isInteger(item.index) ||
      item.index < 0 ||
      item.index >= texts.length ||
      seen.has(item.index) ||
      typeof item.relevance_score !== "number" ||
      !Number.isFinite(item.relevance_score) ||
      item.relevance_score < 0 ||
      item.relevance_score > 1
    )
      throw new Error("重排服务返回格式无效");
    seen.add(item.index);
  }
  return (results as { index: number; relevance_score: number }[]).sort(
    (a, b) => b.relevance_score - a.relevance_score,
  );
}

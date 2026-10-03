export type Usage = Record<string, number>;
export function normalizedUsage(value: unknown): Usage {
  const usage: Usage = {};
  if (value && typeof value === "object")
    for (const [key, amount] of Object.entries(value))
      if (typeof amount === "number" && Number.isFinite(amount) && amount >= 0)
        usage[key] = amount;
  return usage;
}
export function telemetryLabel(
  model: string,
  effort: string,
  usage: Usage,
  compact = false,
) {
  const prompt = usage.prompt_tokens,
    output = usage.completion_tokens;
  const total =
    usage.total_tokens ??
    (prompt !== undefined && output !== undefined
      ? prompt + output
      : undefined);
  const hit = usage.prompt_cache_hit_tokens;
  const ratio =
    prompt !== undefined && hit !== undefined && prompt > 0
      ? ((100 * hit) / prompt).toFixed(1) + "%"
      : "—";
  if (compact)
    return `${model} · effort ${effort} · tokens ${total?.toLocaleString("en-US") ?? "—"} · 缓存 ${ratio}`;
  return `${model} · effort ${effort} · tokens ${total?.toLocaleString("en-US") ?? "—"} (in ${prompt?.toLocaleString("en-US") ?? "—"} / out ${output?.toLocaleString("en-US") ?? "—"}) · 缓存 ${ratio}`;
}

/** Approval continuations and restored records can repeat one run's cumulative usage. */
export function conversationUsage(messages: ReadonlyArray<{ role: string; id: string; brokerRunToken?: string; usage?: unknown }>): Usage {
  const runs = new Map<string, Usage>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const usage = normalizedUsage(message.usage);
    if (Object.keys(usage).length) runs.set(message.brokerRunToken || message.id, usage);
  }
  const total: Usage = {};
  for (const usage of runs.values())
    for (const [key, value] of Object.entries(usage)) total[key] = (total[key] ?? 0) + value;
  return total;
}

/** HTTP boundary shared by interactive and one-shot terminal entry points. */
export const API = process.env.SEUDAILY_API_URL ?? "http://127.0.0.1:4111";
export const RESOURCE = "seudaily-web-local";
export const clean = (value: unknown): string =>
  String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
export class Client {
  operationSignal: AbortSignal | undefined;
  constructor(public timeout = 300) {}
  async request(
    path: string,
    init: RequestInit = {},
    signal?: AbortSignal,
    timeoutSeconds = this.timeout,
  ): Promise<any> {
    signal ??= this.operationSignal;
    const timeout = AbortSignal.timeout(timeoutSeconds * 1000);
    const response = await fetch(API + path, {
      ...init,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) {
      const text = await response.text();
      let error = text;
      try {
        error = JSON.parse(text).error ?? text;
      } catch {}
      throw new Error(clean(error || `HTTP ${response.status}`));
    }
    return response;
  }
  async json(
    path: string,
    method = "GET",
    body?: unknown,
    signal?: AbortSignal,
    timeoutSeconds = this.timeout,
  ): Promise<any> {
    return (
      await this.request(
        path,
        {
          method,
          ...(body === undefined
            ? {}
            : {
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
              }),
        },
        signal,
        timeoutSeconds,
      )
    ).json();
  }
  async *stream(
    body: unknown,
    signal: AbortSignal,
  ): AsyncGenerator<{ type: string; payload: any }> {
    const response = await this.request(
      "/api/agents/seudaily-agent/stream",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      signal,
    );
    if (!response.body) throw new Error("没有事件流");
    const reader = response.body.getReader(),
      decoder = new TextDecoder();
    let lineBuffer = "",
      packet: string[] = [],
      complete = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        lineBuffer += done
          ? decoder.decode()
          : decoder.decode(value, { stream: true });
        let boundary: number;
        while ((boundary = lineBuffer.indexOf("\n")) >= 0) {
          const line = lineBuffer.slice(0, boundary).replace(/\r$/, "");
          lineBuffer = lineBuffer.slice(boundary + 1);
          if (line) {
            if (line.startsWith("data:"))
              packet.push(line.slice(5).trimStart());
            continue;
          }
          const data = packet.join("\n");
          packet = [];
          if (!data || data === "[DONE]") continue;
          const event = JSON.parse(data);
          if (["finish", "error", "tool-approval-request"].includes(event.type))
            complete = true;
          yield event;
        }
        if (done) break;
      }
      if (!complete)
        throw new Error("模型事件流提前结束；已完成的工具不会重试。");
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  async threads(): Promise<any[]> {
    const result: any[] = [];
    for (const resource of [RESOURCE, "cvstream-web-local", "seudaily-wechat-local"])
      for (let page = 0; ; page++) {
        const data = await this.json(
          `/api/memory/threads?resourceId=${resource}&page=${page}&perPage=100`,
        );
        result.push(...data.threads);
        if (data.threads.length < 100) break;
      }
    return result.sort((a, b) =>
      String(b.updatedAt).localeCompare(String(a.updatedAt)),
    );
  }
}

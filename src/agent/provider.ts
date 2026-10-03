import { redactValue } from './redaction.js';
import type { ModelMessage, ToolCall } from './types.js';
export type ProviderEvent = {
    type: 'text' | 'reasoning';
    text: string;
} | {
    type: 'complete';
    message: ModelMessage;
    finishReason: string;
    usage?: Record<string, number>;
};
export interface ModelProvider {
    stream(messages: ModelMessage[], tools: any[], signal?: AbortSignal): AsyncIterable<ProviderEvent>;
    summarize(messages: ModelMessage[], signal?: AbortSignal): Promise<string>;
}
export class ModelError extends Error {
    constructor(message: string, public status: number, public contextExceeded = false) { super(message); }
}
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<any> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const parse = (block: string) => {
        const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data || data === '[DONE]')
            return undefined;
        return JSON.parse(data);
    };
    try {
        while (true) {
            const { value, done } = await reader.read();
            buffer += decoder.decode(value, { stream: !done });
            const blocks = buffer.split(/\r?\n\r?\n/);
            buffer = blocks.pop() ?? '';
            for (const block of blocks) {
                const event = parse(block);
                if (event !== undefined)
                    yield event;
            }
            if (done) {
                const event = parse(buffer);
                if (event !== undefined)
                    yield event;
                return;
            }
        }
    }
    finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
    }
}
export const DEFAULT_REASONING_EFFORT = 'high';
export class DeepSeekProvider implements ModelProvider {
    constructor(private config: {
        apiKey?: string;
        model?: string;
        baseUrl?: string;
    } = {}) { }
    private async request(messages: ModelMessage[], tools: any[], stream: boolean, signal?: AbortSignal) {
        const apiKey = this.config.apiKey ?? process.env.DEEPSEEK_API_KEY;
        if (!apiKey?.trim())
            throw new Error('未配置 DEEPSEEK_API_KEY');
        const response = await fetch(`${(this.config.baseUrl ?? 'https://api.deepseek.com').replace(/\/$/, '')}/chat/completions`, {
            method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: this.config.model ?? process.env.DEEPSEEK_MODEL ?? 'deepseek-flash', messages: redactValue(messages), stream,
                ...(stream ? { reasoning_effort: DEFAULT_REASONING_EFFORT, max_tokens: 8192, stream_options: { include_usage: true }, ...(tools.length ? { tools } : {}) } : { max_tokens: 4096, thinking: { type: 'disabled' }, response_format: { type: 'json_object' } }),
            }),
            signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(360000)]) : AbortSignal.timeout(360000),
        });
        if (!response.ok) {
            const detail = await response.text();
            throw new ModelError(`模型请求失败（${response.status}）`, response.status, /context.*(?:length|window)|maximum.*tokens|too many tokens/i.test(detail));
        }
        return response;
    }
    async *stream(messages: ModelMessage[], tools: any[], signal?: AbortSignal): AsyncGenerator<ProviderEvent> {
        const response = await this.request(messages, tools, true, signal);
        if (!response.body)
            throw new Error('模型未返回流式响应');
        let text = '', reasoning = '', finishReason = '';
        let usage: Record<string, number> | undefined;
        const calls = new Map<number, ToolCall>();
        for await (const chunk of parseSse(response.body)) {
            if (chunk.error)
                throw new Error('模型流返回错误');
            if (chunk.usage)
                usage = chunk.usage;
            const choice = chunk.choices?.[0];
            if (!choice)
                continue;
            const delta = choice.delta ?? {};
            if (delta.content) {
                text += delta.content;
                yield { type: 'text', text: delta.content };
            }
            if (delta.reasoning_content) {
                reasoning += delta.reasoning_content;
                yield { type: 'reasoning', text: delta.reasoning_content };
            }
            for (const part of delta.tool_calls ?? []) {
                const call = calls.get(part.index) ?? { id: '', type: 'function' as const, function: { name: '', arguments: '' } };
                if (part.id)
                    call.id += part.id;
                if (part.function?.name)
                    call.function.name += part.function.name;
                if (part.function?.arguments)
                    call.function.arguments += part.function.arguments;
                calls.set(part.index, call);
            }
            if (choice.finish_reason)
                finishReason = choice.finish_reason;
        }
        if (!finishReason)
            throw new Error('模型响应流意外中断，未收到完成标记');
        if (!['stop', 'tool_calls'].includes(finishReason))
            throw new Error(`模型未完整完成回答（${finishReason}）`);
        const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
        if (toolCalls.some(call => !call.id || !call.function.name))
            throw new Error('模型返回了不完整的工具调用');
        yield { type: 'complete', message: { role: 'assistant', content: text || null, ...(reasoning ? { reasoning_content: reasoning } : {}), ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, finishReason, usage };
    }
    async summarize(messages: ModelMessage[], signal?: AbortSignal): Promise<string> {
        const response = await this.request(messages, [], false, signal);
        const data = await response.json() as any;
        if (data.choices?.[0]?.finish_reason !== 'stop' || !data.choices?.[0]?.message?.content)
            throw new Error('摘要生成未完整完成');
        return data.choices[0].message.content;
    }
}

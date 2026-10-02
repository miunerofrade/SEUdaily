import { redactText, redactValue } from './redaction.js';
import { randomUUID } from 'node:crypto';
import { ModelError, type ModelProvider } from './provider.js';
import { AgentStore } from './storage.js';
import { ContextMemory } from './memory.js';
import { toolJsonSchema, type ToolDefinition, type ToolExecutionOptions } from './tool.js';
import type { AgentEvent, ModelMessage, RunState, TurnContext } from './types.js';
export class BusyError extends Error {
    status = 409;
}
export class ApprovalError extends Error {
    status = 400;
}
export class AgentRuntime {
    private active = new Map<string, AbortController & { runToken: string }>();
    private memory: ContextMemory;
    private unstarted = new Set<string>();
    constructor(private config: {
        store: AgentStore;
        provider: ModelProvider;
        tools: (context: TurnContext) => Promise<Record<string, ToolDefinition>>;
        instructions: (context: TurnContext) => Promise<string>;
        hydrate?: (messages: ModelMessage[]) => Promise<ModelMessage[]>;
        maxSteps?: number;
        memory?: {
            windowTokens?: number;
            ratio?: number;
            lastMessages?: number;
        };
    }) {
        this.memory = new ContextMemory(config.store, config.provider, config.memory);
    }
    isActive(threadId: string) { return this.active.has(threadId); }
    cancelTurn(threadId: string, runToken?: string) {
        const controller = this.active.get(threadId);
        if (!controller || runToken && controller.runToken !== runToken) return false;
        controller.abort();
        return true;
    }
    private claim(context: TurnContext, signal?: AbortSignal) {
        if (this.active.has(context.threadId))
            throw new BusyError('当前会话正在回答，请先停止或等待完成');
        const controller = Object.assign(new AbortController(), { runToken: context.runToken });
        this.active.set(context.threadId, controller);
        this.unstarted.add(context.threadId);
        return signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    }
    async runTurn(input: ModelMessage[], context: TurnContext, signal?: AbortSignal): Promise<AsyncIterable<AgentEvent>> {
        const combined = this.claim(context, signal);
        try {
            await this.config.store.ensureThread(context);
            if (await this.config.store.waitingRun(context.threadId))
                throw new BusyError('当前会话有待审批的工具，请先批准或拒绝');
            const run: RunState = { id: context.runToken, context, status: 'running', step: 0, messages: [], parts: [], pendingCalls: [], cursor: 0, startedAt: new Date().toISOString(), inputMessageIds: [] };
            if (await this.config.store.getRun(run.id))
                throw new ApprovalError('运行令牌已使用，请重新发起请求');
            for (const message of input) {
                if (message.role !== 'user')
                    throw new Error('新轮次只接受用户消息');
                const parts = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : (message.content ?? []).map(part => part.type === 'image_url' ? { type: 'file', data: part.image_url.url, filename: part.filename, mimeType: part.mediaType } : part);
                const messageId = randomUUID();
                run.inputMessageIds!.push(messageId);
                await this.config.store.saveMessage({ id: messageId, threadId: context.threadId, resourceId: context.resourceId, role: 'user', createdAt: new Date().toISOString(), content: { content: parts.filter(part => part.type === 'text').map(part => part.text ?? '').join('\n'), parts, modelMessages: [message] } });
            }
            await this.config.store.saveRun(run);
            return this.drive(run, combined);
        }
        catch (error) {
            this.active.delete(context.threadId);
            this.unstarted.delete(context.threadId);
            throw error;
        }
    }
    async resumeApproval(input: {
        approvalId: string;
        approved: boolean;
    }, context: TurnContext, signal?: AbortSignal): Promise<AsyncIterable<AgentEvent>> {
        const combined = this.claim(context, signal);
        try {
            const run = await this.config.store.waitingRun(context.threadId);
            if (!run || run.approval?.id !== input.approvalId || run.context.resourceId !== context.resourceId || run.context.runToken !== context.runToken)
                throw new ApprovalError('审批不存在、已消费或不属于当前运行');
            const approvedCall = run.approval.callId;
            run.approval = undefined;
            run.status = 'running';
            await this.config.store.saveRun(run);
            return this.drive(run, combined, { callId: approvedCall, approved: input.approved });
        }
        catch (error) {
            this.active.delete(context.threadId);
            this.unstarted.delete(context.threadId);
            throw error;
        }
    }
    async discardUnstartedTurn(context: TurnContext) {
        if (!this.unstarted.delete(context.threadId)) return;
        this.cancelTurn(context.threadId);
        this.active.delete(context.threadId);
        const run = await this.config.store.getRun(context.runToken);
        if (run && run.status === 'running') {
            run.status = 'cancelled';
            await this.persist(run);
        }
    }
    private async persist(run: RunState) {
        await this.config.store.saveTurn(run, { id: `${run.id}-assistant`, threadId: run.context.threadId, resourceId: run.context.resourceId, role: 'assistant', createdAt: run.startedAt, content: { parts: run.parts, modelMessages: run.messages, runToken: run.context.runToken, usage: run.usage } });
    }
    private async *drive(run: RunState, signal: AbortSignal, decision?: {
        callId: string;
        approved: boolean;
    }): AsyncGenerator<AgentEvent> {
        this.unstarted.delete(run.context.threadId);
        const event = (type: string, payload: Record<string, any> = {}): AgentEvent => ({ type, payload }) as AgentEvent;
        try {
            const tools = await this.config.tools(run.context);
            const definitions = Object.values(tools).map(tool => ({ type: 'function', function: { name: tool.id, description: tool.description, parameters: toolJsonSchema(tool) } }));
            run.context.capabilityTickets ??= [];
            run.context.skills ??= [];
            const requestContext = new Map<string, any>([['seudailyRunToken', run.context.runToken], ['seudailyThreadId', run.context.threadId], ['seudailyResourceId', run.context.resourceId], ['seudailyToolNamespaces', run.context.namespaces ?? []], ['seudailyCapabilityTickets', run.context.capabilityTickets]]);
            requestContext.set('seudailySkills', run.context.skills);
            const options: ToolExecutionOptions = { requestContext, abortSignal: signal };
            while (true) {
                signal.throwIfAborted();
                while (run.cursor < run.pendingCalls.length) {
                    signal.throwIfAborted();
                    const call = run.pendingCalls[run.cursor];
                    const tool = tools[call.function.name] ?? Object.values(tools).find(item => item.id === call.function.name);
                    const payload: any = { toolCallId: call.id, toolName: call.function.name };
                    let output: any;
                    let modelOutput: string;
                    try {
                        if (!tool)
                            throw new Error('请求的工具不在当前工具目录中');
                        const parsed = await tool.inputSchema.parseAsync(JSON.parse(call.function.arguments));
                        payload.args = redactValue(parsed);
                        const approvalRequired = typeof tool.requireApproval === 'function' ? await tool.requireApproval(parsed, options) : tool.requireApproval;
                        if (approvalRequired && decision?.callId !== call.id) {
                            run.status = 'waiting';
                            run.approval = { id: `approval-${randomUUID()}`, callId: call.id };
                            run.parts.push({ type: 'tool-invocation', toolInvocation: { ...payload, state: 'call', approvalId: run.approval.id } });
                            await this.persist(run);
                            yield event('tool-approval-request', { ...payload, approvalId: run.approval.id });
                            return;
                        }
                        if (decision?.callId === call.id && !decision.approved)
                            throw new Error('用户拒绝了工具执行');
                        run.executing = call.id;
                        await this.persist(run); // Durable execution boundary: a restart cannot replay it.
                        yield event('tool-call', payload);
                        signal.throwIfAborted();
                        output = await tool.execute(parsed, options);
                        if (tool.outputSchema)
                            output = await tool.outputSchema.parseAsync(output);
                        output = redactValue(output);
                        modelOutput = tool.toModelOutput ? String((await tool.toModelOutput(output)).value) : JSON.stringify(output);
                    }
                    catch (error) {
                        if (signal.aborted)
                            throw error;
                        output = { status: 'failed', taskId: call.id, summary: error instanceof Error ? redactText(error.message) : '工具执行失败', artifacts: [], citations: [], warnings: [], metrics: {} };
                        modelOutput = JSON.stringify(output);
                    }
                    decision = undefined;
                    run.executing = undefined;
                    const existing = run.parts.find(part => part.type === 'tool-invocation' && part.toolInvocation?.toolCallId === call.id);
                    const invocation = { ...payload, state: 'result', result: output };
                    if (existing)
                        existing.toolInvocation = invocation;
                    else
                        run.parts.push({ type: 'tool-invocation', toolInvocation: invocation });
                    run.messages.push({ role: 'tool', tool_call_id: call.id, content: modelOutput });
                    run.cursor++;
                    await this.persist(run);
                    yield event('tool-result', { ...payload, result: output });
                    if (output?.data?.errorCode === 'campus_network_required' || output?.errorCode === 'campus_network_required' || output?.summary === '需要校园网环境') {
                        run.parts.push({ type: 'text', text: '需要校园网环境' });
                        // Resolve any remaining tool IDs without executing them.
                        for (const skipped of run.pendingCalls.slice(run.cursor))
                            run.messages.push({ role: 'tool', tool_call_id: skipped.id, content: '需要校园网环境，本轮已停止，工具未执行。' });
                        run.messages.push({ role: 'assistant', content: '需要校园网环境' });
                        run.status = 'completed';
                        await this.persist(run);
                        yield event('text-delta', { text: '需要校园网环境' });
                        yield event('finish');
                        return;
                    }
                }
                if (run.step >= (this.config.maxSteps ?? 30))
                    throw new Error('已达到本轮最多 30 步的限制，请缩小任务范围');
                const prefix: ModelMessage[] = [{ role: 'system', content: await this.config.instructions(run.context) }];
                const contextHistoryId = `${run.id}-assistant`;
                let context = await this.memory.build(run.context.threadId, run.context.resourceId, prefix, definitions, run.messages, signal, false, contextHistoryId, run.inputMessageIds);
                let completed = false;
                let retried = false;
                let message: ModelMessage | undefined;
                const streamOnce = async function* (runtime: AgentRuntime): AsyncGenerator<AgentEvent> {
                    const hydrated = runtime.config.hydrate ? await runtime.config.hydrate(context) : context;
                    let reasoningStarted = false, textPart: any, reasoningPart: any;
                    for await (const item of runtime.config.provider.stream(hydrated, definitions, signal)) {
                        if (item.type === 'text') {
                            if (!textPart) {
                                textPart = { type: 'text', text: '' };
                                run.parts.push(textPart);
                            }
                            textPart.text += item.text;
                            yield event('text-delta', { text: item.text });
                        }
                        else if (item.type === 'reasoning') {
                            if (!reasoningStarted) {
                                reasoningStarted = true;
                                yield event('reasoning-start');
                            }
                            if (!reasoningPart) {
                                reasoningPart = { type: 'reasoning', text: '' };
                                run.parts.push(reasoningPart);
                            }
                            reasoningPart.text += item.text;
                            yield event('reasoning-delta', { text: item.text });
                        }
                        else if (item.type === 'complete') {
                            message = item.message;
                            if (item.usage) {
                                run.usage ??= {};
                                for (const [name, value] of Object.entries(item.usage))
                                    if (typeof value === 'number' && Number.isFinite(value)) run.usage[name] = (run.usage[name] ?? 0) + value;
                            }
                            completed = true;
                        }
                    }
                    if (reasoningStarted)
                        yield event('reasoning-end');
                };
                while (true) {
                    try {
                        yield* streamOnce(this);
                        break;
                    }
                    catch (error) {
                        if (!(error instanceof ModelError) || !error.contextExceeded || retried)
                            throw error;
                        retried = true;
                        context = await this.memory.build(run.context.threadId, run.context.resourceId, prefix, definitions, run.messages, signal, true, contextHistoryId, run.inputMessageIds);
                    }
                }
                if (!completed || !message)
                    throw new Error('模型未返回完整回答');
                run.step++;
                run.messages.push(message);
                run.pendingCalls = message.tool_calls ?? [];
                run.cursor = 0;
                if (!run.pendingCalls.length) {
                    run.status = 'completed';
                    await this.persist(run);
                    yield event('finish', { usage: run.usage });
                    return;
                }
                await this.persist(run);
            }
        }
        catch (error) {
            run.status = signal.aborted ? 'cancelled' : 'failed';
            const text = signal.aborted ? '已停止本次回答。' : error instanceof Error ? redactText(error.message) : 'Agent 执行失败';
            const answered = new Set(run.messages.filter(message => message.role === 'tool').map(message => message.tool_call_id));
            for (const call of run.pendingCalls)
                if (!answered.has(call.id))
                    run.messages.push({ role: 'tool', tool_call_id: call.id, content: '本轮中断，未完成的调用不得自动重放。' });
            run.parts.push({ type: 'error', error: { message: text } });
            await this.persist(run);
            yield event('error', { error: { message: text } });
        }
        finally {
            if (run.status === 'running') {
                run.status = 'cancelled';
                await this.persist(run);
            }
            this.active.delete(run.context.threadId);
        }
    }
    shutdown() { for (const controller of this.active.values())
        controller.abort(); }
}

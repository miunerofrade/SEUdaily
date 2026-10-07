import { installKnowledgeRoutes } from './knowledge.js';
import { installWeChatRoutes } from './wechat.js';
import { identity, installLifecycle } from './lifecycle.js';
import { installMessageQueue } from './message-queue.js';
import { MAX_ATTACHMENTS } from "../shared/attachment-limits.js";
import { Hono } from 'hono';
import { DEFAULT_REASONING_EFFORT } from '../agent/provider.js';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { agentRuntime } from '../runtime/application.js';
import { agentStore } from '../runtime/storage.js';
import { appRoutes } from '../runtime/app-routes.js';
import { guardLocalRequests, localOrigins } from '../runtime/local-request-guard.js';
import { persistImage } from '../runtime/images.js';
import { redactText } from '../agent/redaction.js';
import type { ModelMessage, TurnContext } from '../agent/types.js';
import { inferToolNamespaces } from '../agent/namespaces.js';
import { skillCatalog } from '../runtime/skills.js';
const identifier = z.string().min(1).max(200);
const contextSchema = z.object({ threadId: identifier, resourceId: identifier, runToken: identifier, namespaces: z.array(z.string()).max(8).default([]), skills: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/)).max(8).default([]), interface: z.enum(['web', 'cli']).default('web'), documentRefs: z.array(z.string()).max(MAX_ATTACHMENTS).default([]), authResumeId: z.string().optional(), parentMessageId: identifier.nullable().optional(), userMessageId: identifier.optional(), assistantMessageId: identifier.optional(), regenerateFrom: identifier.optional() });
export const app = new Hono();
app.use('*', guardLocalRequests);
app.use('*', cors({ origin: localOrigins }));
app.use('*', bodyLimit({ maxSize: 52 * 1024 * 1024 }));
app.onError((error, c) => c.json({ error: redactText(error.message) }, ((error as any).status ?? (error instanceof z.ZodError ? 400 : 500)) as any));
app.get('/api', c => c.json(identity()));
const installStaticPages = installLifecycle(app);
installWeChatRoutes(app);
installKnowledgeRoutes(app);
app.get('/api/agents', async (c) => { await agentStore.ready; return c.json({ 'seudaily-agent': { id: 'seudaily-agent', name: 'SEUdaily' } }); });
app.get('/app/health', async (c) => { await agentStore.ready; await agentStore.client.execute('SELECT 1'); return c.json({ status: 'ready' }); });
app.get('/app/agent-info', c => c.json({ model: process.env.DEEPSEEK_MODEL?.trim() || 'deepseek-flash', effort: DEFAULT_REASONING_EFFORT }));
app.get('/app/skills', async c => c.json({ skills: await skillCatalog.list() }));
for (const route of appRoutes)
    app.on(route.method, route.path, route.handler);
app.get('/api/memory/threads', async (c) => c.json({ threads: await agentStore.listThreads(c.req.query('resourceId') ?? '', Math.min(100, Math.max(1, Number(c.req.query('perPage')) || 100)), Math.max(0, Number(c.req.query('page')) || 0)) }));
app.get('/api/memory/threads/:id/messages', async (c) => c.json(await agentStore.listMessages({ threadId: c.req.param('id'), resourceId: c.req.query('resourceId'), perPage: Math.min(1000, Math.max(1, Number(c.req.query('perPage')) || 100)), page: Math.max(0, Number(c.req.query('page')) || 0), selectedPath: c.req.query('selectedPath') === 'true' })));
app.get('/api/memory/threads/:id/run', async c => {
    const resourceId = identifier.parse(c.req.query('resourceId'));
    const thread = await agentStore.getThreadById({ threadId: c.req.param('id'), resourceId });
    if (!thread) return c.json({ error: '会话不存在' }, 404);
    const run = await agentStore.waitingRun(thread.id);
    const call = run?.pendingCalls.find(call => call.id === run.approval?.callId);
    const invocation = run?.parts.slice().reverse().find(part => part.type === 'tool-invocation' && part.toolInvocation?.approvalId === run.approval?.id)?.toolInvocation;
    return c.json({ active: agentRuntime.isActive(thread.id), pending: run?.approval && call ? {
        runToken: run.context.runToken, approvalId: run.approval.id, toolCallId: call.id,
        toolName: call.function.name, args: invocation?.args ?? {},
    } : null });
});
app.post('/api/memory/threads/:id/cancel', async c => {
    const resourceId = identifier.parse(c.req.query('resourceId'));
    const thread = await agentStore.getThreadById({ threadId: c.req.param('id'), resourceId });
    if (!thread) return c.json({ error: '会话不存在' }, 404);
    const body = z.object({ runToken: identifier.optional() }).parse(await c.req.json().catch(() => ({})));
    if (body.runToken && agentRuntime.isActive(thread.id) && agentRuntime.activeRunToken(thread.id) !== body.runToken)
        return c.json({cancelled:false,active:true});
    await agentStore.client.execute({sql:"UPDATE message_queue SET state='paused',error='任务已取消，等待继续' WHERE threadId=? AND resourceId=? AND state='pending'",args:[thread.id,resourceId]});
    const cancelled = agentRuntime.cancelTurn(thread.id, body.runToken);
    if (cancelled) {
        const deadline = Date.now() + 15000;
        while (agentRuntime.isActive(thread.id) && Date.now() < deadline)
            await new Promise(resolve => setTimeout(resolve, 50));
    }
    return c.json({ cancelled, active: agentRuntime.isActive(thread.id) });
});
app.post('/api/memory/threads/:id/fork', async c => {
 const id=c.req.param('id');
 if(agentRuntime.isActive(id) || await agentStore.waitingRun(id)) return c.json({error:'请先结束当前运行或处理审批'},409);
 const body=z.object({resourceId:identifier,messageId:identifier}).parse(await c.req.json());
 const {randomUUID}=await import('node:crypto');const newId=randomUUID();
 await agentStore.forkThread(id,body.resourceId,body.messageId,newId);
 return c.json({threadId:newId});
});
app.patch('/api/memory/threads/:id/version', async c => {
 const id=c.req.param('id');
 if(agentRuntime.isActive(id) || await agentStore.waitingRun(id)) return c.json({error:'请先结束当前运行或处理审批'},409);
 const body=z.object({resourceId:identifier,leafId:identifier}).parse(await c.req.json());
 await agentStore.selectLeaf(id,body.resourceId,body.leafId);
 return c.json({selected:true});
});
app.delete('/api/memory/threads/:id', async (c) => { const id = c.req.param('id'); if (agentRuntime.isActive(id))
    return c.json({ error: '当前会话正在运行，请先停止并等待完成' }, 409); await agentStore.deleteThread(id, c.req.query('resourceId')); return c.json({ deleted: true }); });
async function normalizeInput(value: unknown): Promise<ModelMessage[]> {
    const messages = typeof value === 'string' ? [{ role: 'user', content: value }] : value;
    if (!Array.isArray(messages) || !messages.length || messages.length > 8)
        throw new Error('无效用户消息');
    return Promise.all(messages.map(async (message) => {
        if (message.role !== 'user')
            throw new Error('新轮次仅接受用户消息');
        if (typeof message.content === 'string')
            return { role: 'user' as const, content: message.content };
        if (!Array.isArray(message.content) || message.content.length > MAX_ATTACHMENTS + 1)
            throw new Error('无效消息内容');
        const content = await Promise.all(message.content.map(async (part: any) => {
            if (part.type === 'text' && typeof part.text === 'string')
                return { type: 'text', text: part.text };
            if (part.type === 'file' || part.type === 'image')
                return persistImage(part);
            throw new Error('不支持的消息附件');
        }));
        return { role: 'user' as const, content };
    }));
}
app.post('/api/agents/seudaily-agent/stream', async (c) => {
    const body = await c.req.json();
    const request = body.requestContext ?? {};
    const context: TurnContext = contextSchema.parse({ threadId: body.memory?.thread, resourceId: body.memory?.resource, runToken: request.seudailyRunToken, namespaces: request.seudailyToolNamespaces, skills: request.seudailySkills, interface: request.seudailyInterface, documentRefs: request.seudailyDocumentRefs, authResumeId: request.seudailyAuthResumeId, parentMessageId: request.seudailyParentMessageId, userMessageId: request.seudailyUserMessageId, assistantMessageId: request.seudailyAssistantMessageId, regenerateFrom: request.seudailyRegenerateFrom });
    const catalog = await skillCatalog.list();
    for (const name of context.skills ?? []) if (!catalog.some(skill => skill.name === name)) return c.json({ error: `Skill 不存在：${name}` }, 400);
    const text = typeof body.messages === 'string' ? body.messages : '';
    context.namespaces = [...new Set([...context.namespaces ?? [], ...inferToolNamespaces(text), ...catalog.filter(skill => context.skills?.includes(skill.name)).flatMap(skill => skill.namespaces)])];
    const controller = new AbortController();
    const abort = () => controller.abort();
    c.req.raw.signal.addEventListener('abort', abort, { once: true });
    if (c.req.raw.signal.aborted)
        controller.abort();
    let events: AsyncIterable<any>;
    try {
        const approval = Array.isArray(body.messages) && body.messages.length === 1 && body.messages[0].role === 'tool' ? body.messages[0].content?.[0] : undefined;
        if (approval) {
            const parsed = z.object({ type: z.literal('tool-approval-response'), approvalId: identifier, approved: z.boolean(), reason: z.string().optional() }).parse(approval);
            events = await agentRuntime.resumeApproval(parsed, context, controller.signal);
        }
        else
            events = await agentRuntime.runTurn(context.regenerateFrom ? [] : await normalizeInput(body.messages), context, controller.signal);
    }
    catch (error) {
        c.req.raw.signal.removeEventListener('abort', abort);
        throw error;
    }
    return streamSSE(c, async (stream) => {
        stream.onAbort(abort);
        const iterator = events[Symbol.asyncIterator]();
        const keepAlive = setInterval(() => { if (!stream.aborted)
            void stream.write(': keep-alive\n\n').catch(abort); }, 15000);
        try {
            while (true) {
                const next = await iterator.next();
                if (next.done)
                    break;
                if (stream.aborted) {
                    abort();
                    break;
                }
                await stream.writeSSE({ data: JSON.stringify(next.value) });
            }
            if (!stream.aborted)
                await stream.writeSSE({ data: '[DONE]' });
        }
        finally {
            clearInterval(keepAlive);
            abort();
            await iterator.return?.();
            await agentRuntime.discardUnstartedTurn(context);
            c.req.raw.signal.removeEventListener('abort', abort);
        }
    });
});

installMessageQueue(app, normalizeInput);
installStaticPages();

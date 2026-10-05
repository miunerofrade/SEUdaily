import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import { z } from 'zod';
import { agentStore } from '../runtime/storage.js';
import { agentRuntime } from '../runtime/application.js';
import { inferToolNamespaces } from '../agent/namespaces.js';
import type { ModelMessage, TurnContext } from '../agent/types.js';
import { skillCatalog } from '../runtime/skills.js';
import { redactText } from '../agent/redaction.js';
const id = z.string().min(1).max(200);
const draftSchema = z.object({ text: z.string().max(1000000), images: z.array(z.object({ ref: z.string(), name: z.string(), mediaType: z.string() }).passthrough()).max(10).default([]), documents: z.array(z.object({ contextRef: z.string(), name: z.string() }).passthrough()).max(10).default([]), skills: z.array(z.string()).max(8).default([]), interface: z.enum(['web', 'cli']).default('web') });
const running = new Set<string>();
const progress = new Map<string, {
    runToken: string;
    text: string;
}>();
let ticking = false;
let stopped = false;
export function queueHasWork() { return running.size > 0; }
export async function stopMessageQueue() {
    stopped = true;
    clearInterval(timer);
    while (running.size)
        await new Promise(resolve => setTimeout(resolve, 25));
}
async function execute(row: any, normalize: (input: unknown) => Promise<ModelMessage[]>) {
    const threadId = String(row.threadId), resourceId = String(row.resourceId), queueId = String(row.id);
    running.add(threadId);
    let context: TurnContext | undefined;
    try {
        if (agentRuntime.isActive(threadId) || await agentStore.waitingRun(threadId))
            return;
        const blocked = await agentStore.client.execute({ sql: "SELECT id FROM message_queue WHERE threadId=? AND state IN ('failed','paused') LIMIT 1", args: [threadId] });
        if (blocked.rows.length)
            return;
        const claimed = await agentStore.client.execute({ sql: "UPDATE message_queue SET state='running' WHERE id=? AND state='pending'", args: [queueId] });
        if (!claimed.rowsAffected)
            return;
        const draft = JSON.parse(String(row.payload));
        const catalog = await skillCatalog.list();
        for (const name of draft.skills)
            if (!catalog.some(skill => skill.name === name))
                throw new Error(`Skill 不存在：${name}`);
        const input = draft.images.length ? [{ role: 'user', content: [{ type: 'text', text: draft.text }, ...draft.images.map((image: any) => ({ type: 'file', data: `seudaily-image-ref:${image.ref}`, filename: image.name, mediaType: image.mediaType }))] }] : draft.text;
        context = { threadId, resourceId, runToken: randomUUID(), interface: draft.interface, skills: draft.skills, namespaces: [...new Set([...inferToolNamespaces(draft.text), ...catalog.filter(skill => draft.skills.includes(skill.name)).flatMap(skill => skill.namespaces)])], documentRefs: draft.documents.map((d: any) => d.contextRef) };
        progress.set(threadId, { runToken: context.runToken, text: '' });
        const events = await agentRuntime.runTurn(await normalize(input), context);
        let error = '';
        for await (const event of events) {
            if (event.type === 'error')
                error = event.payload.error.message;
            if (event.type === 'text-delta')
                progress.get(threadId)!.text += event.payload.text;
        }
        const run = await agentStore.getRun(context.runToken);
        if (run?.status === 'cancelled' || run?.status === 'interrupted')
            error = '发送已取消，队列已暂停';
        if (error)
            await agentStore.client.execute({ sql: "UPDATE message_queue SET state='failed',error=? WHERE id=?", args: [redactText(error), queueId] });
        else
            await agentStore.client.execute({ sql: 'DELETE FROM message_queue WHERE id=?', args: [queueId] });
    }
    catch (error) {
        const busy = (error as any).status === 409;
        await agentStore.client.execute({ sql: 'UPDATE message_queue SET state=?,error=? WHERE id=?', args: [busy ? 'pending' : 'failed', busy ? '' : redactText((error as Error).message), queueId] });
    }
    finally {
        try {
            if (context)
                await agentRuntime.discardUnstartedTurn(context);
        }
        finally {
            running.delete(threadId);
            progress.delete(threadId);
        }
    }
}
let normalizeInput: ((input: unknown) => Promise<ModelMessage[]>) | undefined;
async function tick() {
    if (stopped || ticking || !normalizeInput)
        return;
    ticking = true;
    try {
        await agentStore.ready;
        const rows = await agentStore.client.execute("SELECT * FROM message_queue WHERE state='pending' ORDER BY sequence");
        const seen = new Set<string>();
        for (const row of rows.rows) {
            const thread = String(row.threadId);
            if (seen.has(thread) || running.has(thread))
                continue;
            seen.add(thread);
            void execute(row, normalizeInput).catch(() => { });
        }
    }
    finally {
        ticking = false;
    }
}
const timer = setInterval(() => void tick().catch(() => { }), 500);
timer.unref();
export function installMessageQueue(app: Hono, normalize: (input: unknown) => Promise<ModelMessage[]>) {
    normalizeInput = normalize;
    const path = '/api/memory/threads/:id/queue';
    app.get(path, async (c) => {
        await agentStore.ready;
        const threadId = c.req.param('id'), resourceId = id.parse(c.req.query('resourceId'));
        const rows = await agentStore.client.execute({ sql: 'SELECT * FROM message_queue WHERE threadId=? AND resourceId=? ORDER BY sequence', args: [threadId, resourceId] });
        return c.json({ active: agentRuntime.isActive(threadId), runToken: agentRuntime.activeRunToken(threadId), progress: progress.get(threadId), items: rows.rows.map(row => ({ id: row.id, state: row.state, error: row.error, ...JSON.parse(String(row.payload)) })) });
    });
    app.post(path, async (c) => {
        const resourceId = id.parse(c.req.query('resourceId')), threadId = id.parse(c.req.param('id')), draft = draftSchema.parse(await c.req.json());
        if (!draft.text.trim() && !draft.images.length && !draft.documents.length)
            return c.json({ error: '消息不能为空' }, 400);
        if (draft.images.length + draft.documents.length > 10)
            return c.json({ error: '每轮最多 10 个附件' }, 400);
        await agentStore.ensureThread({ threadId, resourceId });
        const queueId = randomUUID();
        await agentStore.client.execute({ sql: "INSERT INTO message_queue(id,threadId,resourceId,state,payload,error) VALUES(?,?,?,'pending',?,'')", args: [queueId, threadId, resourceId, JSON.stringify(draft)] });
        return c.json({ id: queueId });
    });
    app.post(path + '/resume', async (c) => {
        const resourceId = id.parse(c.req.query('resourceId'));
        await agentStore.client.execute({ sql: "UPDATE message_queue SET state='pending',error='' WHERE threadId=? AND resourceId=? AND state='paused'", args: [id.parse(c.req.param('id')), resourceId] });
        return c.json({ ok: true });
    });
    app.delete(path + '/:queueId', async (c) => {
        await agentStore.ready;
        const resourceId = id.parse(c.req.query('resourceId'));
        const removed = await agentStore.client.execute({ sql: "DELETE FROM message_queue WHERE id=? AND threadId=? AND resourceId=? AND state!='running' RETURNING payload", args: [id.parse(c.req.param('queueId')), id.parse(c.req.param('id')), resourceId] });
        if (!removed.rows.length)
            return c.json({ error: '消息已经开始发送或已移出队列' }, 409);
        return c.json(JSON.parse(String(removed.rows[0].payload)));
    });
}

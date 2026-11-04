import { z } from 'zod';
import { defineTool } from '../../agent/tool.js';
const reminder = z.object({ beforeMinutes: z.number().int().min(1).max(5256000), message: z.string().trim().min(1).max(4000) }).strict();
const fields = { title: z.string().trim().min(1).max(200), dueAt: z.string().datetime({ offset: true }), requirements: z.string().max(4000).default(''), reminders: z.array(reminder).min(1).max(20).optional() };
export const manageDeadlinesTool = defineTool({ id: 'manage-deadlines', description: '创建、查看、修改、完成或取消 DDL 飞书群提醒。截止时间必须包含年份、时间与 UTC 偏移。默认提前 3 天、1 天、6 小时；提醒正文在创建时保存，到点直接发送。先读取 deadline-reminders Skill；不明确的日期要询问用户。', inputSchema: z.discriminatedUnion('action', [
        z.object({ action: z.literal('list') }).strict(), z.object({ action: z.literal('create'), requestKey: z.string().min(1).max(200), ...fields }).strict(), z.object({ action: z.literal('update'), id: z.string().uuid(), ...fields }).strict(), z.object({ action: z.literal('complete'), id: z.string().uuid() }).strict(), z.object({ action: z.literal('cancel'), id: z.string().uuid() }).strict(),
    ]), execute: async (input, options) => {
        const owner = options.requestContext?.get('seudailyResourceId');
        if (typeof owner !== 'string' || !owner)
            throw new Error('当前运行缺少用户上下文');
        const {deadlineStore} = await import('../deadlines/runtime.js');
        if (input.action === 'list')
            return { items: await deadlineStore.list(owner), feishuConfigured: !!process.env.SEUDAILY_FEISHU_WEBHOOK };
        if (input.action === 'complete' || input.action === 'cancel') {
            await deadlineStore.finish(owner, input.id, input.action === 'complete' ? 'completed' : 'cancelled');
            return { id: input.id, state: input.action };
        }
        const reminders = input.reminders ?? [4320, 1440, 360].map(beforeMinutes => ({ beforeMinutes, message: `请检查并完成：${input.title}\n${input.requirements}` }));
        if (new Set(reminders.map(r => r.beforeMinutes)).size !== reminders.length)
            throw new Error('提醒节点不能重复');
        const result = await deadlineStore.save(owner, input.action === 'create' ? input.requestKey : '', { title: input.title, dueAt: input.dueAt, requirements: input.requirements, reminders }, input.action === 'update' ? input.id : undefined);
        (await import('../../server/lifecycle.js')).ensurePersistentRuntime();
        return { ...result, feishuConfigured: !!process.env.SEUDAILY_FEISHU_WEBHOOK, warning: process.env.SEUDAILY_FEISHU_WEBHOOK ? undefined : '任务已保存，配置飞书群机器人后才可发送' };
    } });

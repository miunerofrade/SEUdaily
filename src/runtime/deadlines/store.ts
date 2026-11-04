import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { LocalClient } from '../../agent/sqlite.js';
export type Reminder = {
    beforeMinutes: number;
    message: string;
};
export type DeadlineInput = {
    title: string;
    dueAt: string;
    requirements: string;
    reminders: Reminder[];
};
const clients = new Map<string, {
    db: LocalClient;
    refs: number;
}>();
export class DeadlineStore {
    private closed = false;
    private readonly path: string;
    readonly db: LocalClient;
    readonly ready: Promise<unknown>;
    constructor(path: string) {
        this.path = resolve(path);
        let shared = clients.get(this.path);
        if (!shared) {
            shared = { db: new LocalClient(this.path), refs: 0 };
            clients.set(this.path, shared);
        }
        shared.refs++;
        this.db = shared.db;
        this.ready = this.db.batch([
            `CREATE TABLE IF NOT EXISTS deadlines(id TEXT PRIMARY KEY,owner TEXT NOT NULL,requestKey TEXT NOT NULL,revision INTEGER NOT NULL,data TEXT NOT NULL,state TEXT NOT NULL,UNIQUE(owner,requestKey))`,
            `CREATE TABLE IF NOT EXISTS deadline_events(id TEXT PRIMARY KEY,deadlineId TEXT NOT NULL REFERENCES deadlines(id),revision INTEGER NOT NULL,scheduled INTEGER NOT NULL,message TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,nextAttempt INTEGER NOT NULL DEFAULT 0,lease INTEGER NOT NULL DEFAULT 0,error TEXT)`
        ]);
    }
    async hasPending() { await this.ready; return (await this.db.execute("SELECT id FROM deadline_events WHERE state IN ('pending','sending') LIMIT 1")).rows.length > 0; }
    async list(owner: string, now = Date.now()) {
        await this.ready;
        const result = await this.db.execute({sql: 'SELECT * FROM deadlines WHERE owner=? ORDER BY id', args: [owner]});
        const items = [];
        for (const row of result.rows) {
            const data = JSON.parse(String(row.data));
            const due = Date.parse(data.dueAt);
            const deliveries = await this.db.execute({
                sql: 'SELECT scheduled,state,attempts,error FROM deadline_events WHERE deadlineId=? ORDER BY scheduled',
                args: [String(row.id)],
            });
            items.push({id: row.id, ...data, state: row.state === 'active' && due <= now ? 'overdue' : row.state,
                remainingSeconds: Math.ceil((due - now) / 1000), deliveries: deliveries.rows});
        }
        return items;
    }
    async save(owner: string, key: string, input: DeadlineInput, id?: string, now = Date.now()) {
        await this.ready;
        const due = Date.parse(input.dueAt);
        if (!Number.isFinite(due) || due <= now)
            throw new Error('截止时间必须明确且晚于当前时间');
        const future = input.reminders.filter(r => due - r.beforeMinutes * 60000 >= now);
        if (!future.length)
            throw new Error('提醒节点均已过去，请设置更短的提前时间');
        const tx = await this.db.transaction();
        try {
            const existing = (await tx.execute({ sql: id ? 'SELECT * FROM deadlines WHERE owner=? AND id=?' : 'SELECT * FROM deadlines WHERE owner=? AND requestKey=?', args: [owner, id ?? key] })).rows[0];
            if (id && !existing)
                throw new Error('提醒任务不存在');
            if (!id && existing) {
                if (String(existing.data) !== JSON.stringify(input))
                    throw new Error('requestKey 已用于不同内容的任务');
                await tx.commit();
                return { id: existing.id, created: false };
            }
            const ident = id ?? randomUUID(), revision = Number(existing?.revision ?? 0) + 1;
            await tx.execute({ sql: 'INSERT INTO deadlines VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,data=excluded.data,state=excluded.state', args: [ident, owner, String(existing?.requestKey ?? key), revision, JSON.stringify(input), 'active'] });
            await tx.execute({ sql: "UPDATE deadline_events SET state='cancelled' WHERE deadlineId=? AND state IN ('pending','sending')", args: [ident] });
            for (const r of future)
                await tx.execute({ sql: 'INSERT INTO deadline_events(id,deadlineId,revision,scheduled,message,state) VALUES(?,?,?,?,?,?)', args: [randomUUID(), ident, revision, due - r.beforeMinutes * 60000, r.message, 'pending'] });
            await tx.commit();
            return { id: ident, created: !id, scheduled: future.length };
        }
        catch (e) {
            await tx.rollback();
            throw e;
        }
        finally {
            tx.close();
        }
    }
    async finish(owner: string, id: string, state: 'completed' | 'cancelled') {
        await this.ready;
        const tx = await this.db.transaction();
        try {
            const r = await tx.execute({ sql: 'UPDATE deadlines SET state=? WHERE owner=? AND id=?', args: [state, owner, id] });
            if (!r.rowsAffected)
                throw new Error('提醒任务不存在');
            await tx.execute({ sql: "UPDATE deadline_events SET state='cancelled' WHERE deadlineId=? AND state IN ('pending','sending')", args: [id] });
            await tx.commit();
        }
        catch (e) {
            await tx.rollback();
            throw e;
        }
        finally {
            tx.close();
        }
    }
    async tick(send: ((message: string) => Promise<void>) | undefined, now = Date.now()) {
        await this.ready;
        await this.db.execute({ sql: "UPDATE deadline_events SET state='pending' WHERE state='sending' AND lease<?", args: [now] });
        const rows = (await this.db.execute({ sql: "SELECT e.*,d.data FROM deadline_events e JOIN deadlines d ON d.id=e.deadlineId AND d.revision=e.revision WHERE e.state='pending' AND d.state='active' AND e.scheduled<=? ORDER BY e.scheduled DESC", args: [now] })).rows;
        const seen = new Set<string>();
        for (const row of rows) {
            const id = String(row.id), data = JSON.parse(String(row.data));
            if (Date.parse(data.dueAt) <= now || seen.has(String(row.deadlineId))) {
                await this.db.execute({ sql: "UPDATE deadline_events SET state=? WHERE id=? AND state='pending'", args: [Date.parse(data.dueAt) <= now ? 'expired' : 'superseded', id] });
                continue;
            }
            seen.add(String(row.deadlineId));
            if (!send || Number(row.nextAttempt) > now)
                continue;
            const claimed = await this.db.execute({ sql: "UPDATE deadline_events SET state='sending',lease=?,attempts=attempts+1 WHERE id=? AND state='pending' AND NOT EXISTS(SELECT 1 FROM deadline_events running WHERE running.deadlineId=deadline_events.deadlineId AND running.state='sending')", args: [now + 120000, id] });
            if (!claimed.rowsAffected)
                continue;
            // Recheck edits/cancellation after claiming, before making an external request.
            const active = await this.db.execute({ sql: "SELECT e.id FROM deadline_events e JOIN deadlines d ON d.id=e.deadlineId AND d.revision=e.revision WHERE e.id=? AND e.state='sending' AND d.state='active'", args: [id] });
            if (!active.rows.length)
                continue;
            const late = now - Number(row.scheduled) > 90000;
            const text = `【DDL 提醒${late ? '｜补发' : ''}】${data.title}\n截止：${data.dueAt}\n${late ? '原计划提醒：' + new Date(Number(row.scheduled)).toISOString() + '\n' : ''}${row.message}`;
            try {
                await send(text);
                await this.db.execute({ sql: "UPDATE deadline_events SET state='sent',error=NULL WHERE id=? AND state='sending'", args: [id] });
            }
            catch {
                const attempts = Number(row.attempts) + 1;
                await this.db.execute({ sql: "UPDATE deadline_events SET state=?,nextAttempt=?,error=? WHERE id=? AND state='sending'", args: [attempts >= 5 ? 'failed' : 'pending', now + Math.min(30, 2 ** attempts) * 60000, '飞书发送失败，请检查机器人配置或网络', id] });
            }
        }
    }
    async close() {
        if (this.closed) return;
        this.closed = true;
        await this.ready;
        const shared = clients.get(this.path);
        if (shared && --shared.refs === 0) {
            clients.delete(this.path);
            await shared.db.close();
        }
    }
}

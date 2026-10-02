import { createClient, type Client, type InStatement } from '@libsql/client';
import { existsSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RunState, StoredMessage, Thread } from './types.js';
export type Summary = {
    throughSequence: number;
    value: Record<string, any>;
    updatedAt: string;
};
const exec = promisify(execFile);
const snapshotScript = `import sqlite3,json,sys\nfrom pathlib import Path\nc=sqlite3.connect(Path(sys.argv[1]).resolve().as_uri()+'?mode=ro',uri=True)\nc.row_factory=sqlite3.Row\ntables={r[0] for r in c.execute(\"SELECT name FROM sqlite_master WHERE type='table'\")}\nresult={}\nfor name in ['mastra_threads','mastra_messages','mastra_observational_memory']:\n if name in tables: result[name]=[dict(r) for r in c.execute('SELECT * FROM '+name+(' ORDER BY createdAt,rowid' if name != 'mastra_observational_memory' else ' ORDER BY rowid'))]\nprint(json.dumps(result))\nc.close()`;
export class AgentStore {
    readonly client: Client;
    readonly ready: Promise<void>;
    constructor(path: string, private legacyPath?: string) {
        if (path !== ':memory:') {
            mkdirSync(dirname(resolve(path)), { recursive: true });
        }
        this.client = createClient({ url: path === ':memory:' ? 'file::memory:' : `file:${resolve(path)}` });
        if (path !== ':memory:')
            chmodSync(resolve(path), 0o600);
        this.ready = this.initialize();
    }
    private async initialize() {
        await this.client.batch([
            'CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, resourceId TEXT NOT NULL, title TEXT, metadata TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)',
            'CREATE TABLE IF NOT EXISTS messages (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, threadId TEXT NOT NULL, resourceId TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, createdAt TEXT NOT NULL)',
            'CREATE INDEX IF NOT EXISTS messages_thread ON messages(threadId, resourceId, sequence)',
            'CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, threadId TEXT NOT NULL, resourceId TEXT NOT NULL, status TEXT NOT NULL, state TEXT NOT NULL)',
            'CREATE TABLE IF NOT EXISTS summaries (threadId TEXT PRIMARY KEY, throughSequence INTEGER NOT NULL, value TEXT NOT NULL, updatedAt TEXT NOT NULL)',
            'CREATE TABLE IF NOT EXISTS legacy_memory (id TEXT PRIMARY KEY, threadId TEXT, resourceId TEXT, content TEXT NOT NULL)',
            'CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
        ], 'write');
        if (this.legacyPath && existsSync(this.legacyPath)) {
            const migrated = await this.client.execute("SELECT value FROM metadata WHERE key='mastra-import-v1'");
            if (!migrated.rows.length) {
                const { stdout } = await exec('uv', ['run', '--frozen', 'python', '-c', snapshotScript, resolve(this.legacyPath)], { maxBuffer: 128 * 1024 * 1024 });
                const snapshot = JSON.parse(stdout);
                const threadResources = new Map((snapshot.mastra_threads ?? []).map((thread: any) => [thread.id, thread.resourceId]));
                const tx = await this.client.transaction('write');
                try {
                    for (const t of snapshot.mastra_threads ?? [])
                        await tx.execute({ sql: 'INSERT OR IGNORE INTO threads VALUES (?,?,?,?,?,?)', args: [t.id, t.resourceId, t.title, t.metadata ?? '{}', t.createdAt, t.updatedAt] });
                    for (const m of snapshot.mastra_messages ?? [])
                        await tx.execute({ sql: 'INSERT OR IGNORE INTO messages(id,threadId,resourceId,role,content,createdAt) VALUES (?,?,?,?,?,?)', args: [m.id, m.thread_id, m.resourceId ?? threadResources.get(m.thread_id) ?? '', m.role, m.content, m.createdAt] });
                    for (const m of snapshot.mastra_observational_memory ?? [])
                        await tx.execute({ sql: 'INSERT OR IGNORE INTO legacy_memory VALUES (?,?,?,?)', args: [m.id, m.threadId ?? null, m.resourceId ?? null, JSON.stringify(m)] });
                    for (const [table, source] of [['threads', snapshot.mastra_threads ?? []], ['messages', snapshot.mastra_messages ?? []], ['legacy_memory', snapshot.mastra_observational_memory ?? []]] as const) {
                        const result = await tx.execute(`SELECT id FROM ${table}`);
                        const ids = new Set(result.rows.map(row => String(row.id)));
                        if (source.some((row: any) => !ids.has(row.id)))
                            throw new Error('旧会话迁移校验失败');
                    }
                    await tx.execute({ sql: 'INSERT INTO metadata VALUES (?,?)', args: ['mastra-import-v1', JSON.stringify({ importedAt: new Date().toISOString() })] });
                    await tx.commit();
                }
                catch (error) {
                    await tx.rollback();
                    throw error;
                }
                finally {
                    tx.close();
                }
            }
        }
        // A crash during execution never authorizes replay of that execution.
        await this.client.execute("UPDATE runs SET status='interrupted' WHERE status='running'");
    }
    async getThreadById({ threadId, resourceId }: {
        threadId: string;
        resourceId?: string;
    }): Promise<Thread | undefined> {
        await this.ready;
        const result = await this.client.execute({ sql: 'SELECT * FROM threads WHERE id=?' + (resourceId ? ' AND resourceId=?' : ''), args: resourceId ? [threadId, resourceId] : [threadId] });
        const row = result.rows[0];
        return row ? { ...row, metadata: JSON.parse(String(row.metadata)) } as unknown as Thread : undefined;
    }
    async ensureThread(context: {
        threadId: string;
        resourceId: string;
    }) {
        await this.ready;
        const existing = await this.getThreadById({ threadId: context.threadId });
        if (existing && existing.resourceId !== context.resourceId)
            throw new Error('会话不属于当前资源');
        const now = new Date().toISOString();
        await this.client.execute({ sql: 'INSERT OR IGNORE INTO threads VALUES (?,?,?,?,?,?)', args: [context.threadId, context.resourceId, '', '{}', now, now] });
    }
    async patchThread({ id, title, metadata }: {
        id: string;
        title?: string;
        metadata?: any;
    }) {
        const old = await this.getThreadById({ threadId: id });
        if (!old)
            throw new Error('会话不存在');
        await this.client.execute({ sql: 'UPDATE threads SET title=?,metadata=?,updatedAt=? WHERE id=?', args: [title ?? old.title ?? '', JSON.stringify(metadata ?? old.metadata), new Date().toISOString(), id] });
    }
    async listThreads(resourceId: string, perPage = 100, page = 0) {
        await this.ready;
        const rows = await this.client.execute({ sql: 'SELECT * FROM threads WHERE resourceId=? ORDER BY updatedAt DESC LIMIT ? OFFSET ?', args: [resourceId, perPage, page * perPage] });
        return rows.rows.map(row => ({ ...row, metadata: JSON.parse(String(row.metadata)) })) as unknown as Thread[];
    }
    async allMessages(threadId: string, resourceId: string): Promise<StoredMessage[]> {
        await this.ready;
        const rows = await this.client.execute({ sql: 'SELECT * FROM messages WHERE threadId=? AND resourceId=? ORDER BY sequence', args: [threadId, resourceId] });
        return rows.rows.map(row => ({ ...row, content: JSON.parse(String(row.content)), sequence: Number(row.sequence) })) as unknown as StoredMessage[];
    }
    async listMessages(input: {
        threadId: string;
        resourceId?: string;
        perPage?: number;
        page?: number;
        includeTotal?: boolean;
    }) {
        const thread = await this.getThreadById(input);
        const all = thread ? await this.allMessages(thread.id, thread.resourceId) : [];
        const size = input.perPage ?? 100;
        const start = Math.max(0, all.length - ((input.page ?? 0) + 1) * size);
        const end = Math.max(0, all.length - (input.page ?? 0) * size);
        return { messages: all.slice(start, end), total: all.length, page: input.page ?? 0, perPage: size, hasMore: start > 0 };
    }
    async saveMessage(message: StoredMessage) {
        await this.ready;
        await this.client.batch([
            { sql: 'INSERT INTO messages(id,threadId,resourceId,role,content,createdAt) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET content=excluded.content', args: [message.id, message.threadId, message.resourceId, message.role, JSON.stringify(message.content), message.createdAt] },
            { sql: 'UPDATE threads SET updatedAt=? WHERE id=?', args: [new Date().toISOString(), message.threadId] },
        ], 'write');
    }
    async deleteThread(threadId: string, resourceId?: string) {
        const thread = await this.getThreadById({ threadId, resourceId });
        if (!thread)
            return;
        await this.client.batch(['messages', 'runs', 'summaries', 'legacy_memory'].map(table => ({ sql: `DELETE FROM ${table} WHERE threadId=?`, args: [threadId] })).concat([{ sql: 'DELETE FROM threads WHERE id=?', args: [threadId] }]), 'write');
    }
    async saveRun(run: RunState) {
        await this.ready;
        await this.client.execute({ sql: 'INSERT INTO runs VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,state=excluded.state', args: [run.id, run.context.threadId, run.context.resourceId, run.status, JSON.stringify(run)] });
    }
    async saveTurn(run: RunState, message: StoredMessage) {
        await this.ready;
        await this.client.batch([
            { sql: 'INSERT INTO runs VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,state=excluded.state', args: [run.id, run.context.threadId, run.context.resourceId, run.status, JSON.stringify(run)] },
            { sql: 'INSERT INTO messages(id,threadId,resourceId,role,content,createdAt) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET content=excluded.content', args: [message.id, message.threadId, message.resourceId, message.role, JSON.stringify(message.content), message.createdAt] },
            { sql: 'UPDATE threads SET updatedAt=? WHERE id=?', args: [new Date().toISOString(), message.threadId] },
        ], 'write');
    }
    async getRun(id: string): Promise<RunState | undefined> {
        await this.ready;
        const result = await this.client.execute({ sql: 'SELECT state,status FROM runs WHERE id=?', args: [id] });
        return result.rows[0] ? { ...JSON.parse(String(result.rows[0].state)), status: result.rows[0].status } : undefined;
    }
    async waitingRun(threadId: string): Promise<RunState | undefined> {
        await this.ready;
        const result = await this.client.execute({ sql: "SELECT state FROM runs WHERE threadId=? AND status='waiting' LIMIT 1", args: [threadId] });
        return result.rows[0] ? JSON.parse(String(result.rows[0].state)) : undefined;
    }
    async summary(threadId: string): Promise<Summary | undefined> {
        await this.ready;
        const result = await this.client.execute({ sql: 'SELECT * FROM summaries WHERE threadId=?', args: [threadId] });
        const row = result.rows[0];
        return row ? { throughSequence: Number(row.throughSequence), value: JSON.parse(String(row.value)), updatedAt: String(row.updatedAt) } : undefined;
    }
    async saveSummary(threadId: string, summary: Summary) {
        await this.ready;
        await this.client.execute({ sql: 'INSERT INTO summaries VALUES (?,?,?,?) ON CONFLICT(threadId) DO UPDATE SET throughSequence=excluded.throughSequence,value=excluded.value,updatedAt=excluded.updatedAt', args: [threadId, summary.throughSequence, JSON.stringify(summary.value), summary.updatedAt] });
    }
    async legacyMemory(threadId: string, resourceId: string): Promise<string[]> {
        await this.ready;
        const rows = await this.client.execute({ sql: 'SELECT content FROM legacy_memory WHERE threadId=? AND resourceId=?', args: [threadId, resourceId] });
        return rows.rows.flatMap(row => { const data = JSON.parse(String(row.content)); return data.activeObservations ? [String(data.activeObservations)] : []; });
    }
    close() { this.client.close(); }
}

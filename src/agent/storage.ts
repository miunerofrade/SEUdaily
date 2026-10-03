import { createClient, type Client, type InStatement } from '@libsql/client';
import { existsSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RunState, StoredMessage, Thread } from './types.js';
import { conversationPath, branchKey, withParents } from '../shared/conversation-tree.js';
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
    async patchThread({ id, title, metadata, preserveUpdatedAt = false }: {
        id: string;
        title?: string;
        metadata?: any;
        preserveUpdatedAt?: boolean;
    }) {
        const old = await this.getThreadById({ threadId: id });
        if (!old)
            throw new Error('会话不存在');
        await this.client.execute({ sql: 'UPDATE threads SET title=?,metadata=?,updatedAt=CASE WHEN ? THEN updatedAt ELSE ? END WHERE id=?', args: [title ?? old.title ?? '', JSON.stringify(metadata ?? old.metadata), preserveUpdatedAt ? 1 : 0, new Date().toISOString(), id] });
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
    async firstUserMessage(threadId: string, resourceId: string): Promise<StoredMessage | undefined> {
        await this.ready;
        const result = await this.client.execute({ sql: "SELECT * FROM messages WHERE threadId=? AND resourceId=? AND role='user' ORDER BY sequence LIMIT 1", args: [threadId, resourceId] });
        const row = result.rows[0];
        return row ? { ...row, content: JSON.parse(String(row.content)), sequence: Number(row.sequence) } as unknown as StoredMessage : undefined;
    }
    async contextMessages(threadId: string, resourceId: string) {
        const all = await this.allMessages(threadId, resourceId);
        const nodes = withParents(all.map(m => ({ ...m, ...(Object.hasOwn(m.content, 'parentId') ? { parentId: m.content.parentId } : {}) })));
        const thread = await this.getThreadById({ threadId, resourceId });
        const leaf = thread?.metadata.activeLeaf;
        return { messages: conversationPath(nodes, leaf), summaryKey: branchKey(nodes, leaf) ? `${threadId}:branch:${branchKey(nodes, leaf)}` : threadId };
    }
    async selectLeaf(threadId: string, resourceId: string, leaf: string | null) {
        const thread = await this.getThreadById({ threadId, resourceId });
        if (!thread) throw new Error('会话不存在');
        const all = await this.allMessages(threadId, resourceId);
        if (leaf && !all.some(m => m.id === leaf)) throw new Error('对话版本不存在');
        await this.patchThread({ id: threadId, metadata: { ...thread.metadata, activeLeaf: leaf }, preserveUpdatedAt: true });
    }
    async forkThread(threadId: string, resourceId: string, messageId: string, newId: string) {
        const thread = await this.getThreadById({threadId,resourceId});
        if (!thread) throw new Error('会话不存在');
        const all = await this.allMessages(threadId,resourceId);
        const nodes = all.map(m=>({...m,...(Object.hasOwn(m.content,'parentId')?{parentId:m.content.parentId}:{})}));
        const path = conversationPath(nodes,messageId);
        const { randomUUID } = await import('node:crypto');
        const now=new Date().toISOString(),tx=await this.client.transaction('write');
        let parent: string|null=null;
        try {
            await tx.execute({sql:'INSERT INTO threads VALUES (?,?,?,?,?,?)',args:[newId,resourceId,thread.title || '',JSON.stringify({forkedFrom:threadId}),now,now]});
            for (const message of path) {
                const id=randomUUID();
                await tx.execute({sql:'INSERT INTO messages(id,threadId,resourceId,role,content,createdAt) VALUES (?,?,?,?,?,?)',args:[id,newId,resourceId,message.role,JSON.stringify({...message.content,parentId:parent}),message.createdAt]});
                parent=id;
            }
            await tx.execute({sql:'UPDATE threads SET metadata=? WHERE id=?',args:[JSON.stringify({forkedFrom:threadId,activeLeaf:parent}),newId]});
            await tx.commit();
        } catch (error) { await tx.rollback(); throw error; } finally { tx.close(); }
    }
    async listMessages(input: {
        threadId: string;
        resourceId?: string;
        perPage?: number;
        page?: number;
        includeTotal?: boolean;
        selectedPath?: boolean;
    }) {
        const thread = await this.getThreadById(input);
        const all = thread ? input.selectedPath ? (await this.contextMessages(thread.id, thread.resourceId)).messages : await this.allMessages(thread.id, thread.resourceId) : [];
        const size = input.perPage ?? 100;
        const start = Math.max(0, all.length - ((input.page ?? 0) + 1) * size);
        const end = Math.max(0, all.length - (input.page ?? 0) * size);
        return { messages: all.slice(start, end), total: all.length, page: input.page ?? 0, perPage: size, hasMore: start > 0 };
    }
    private messageStatement(message: StoredMessage, update = false): InStatement {
        return { sql: 'INSERT INTO messages(id,threadId,resourceId,role,content,createdAt) VALUES (?,?,?,?,?,?)' + (update ? ' ON CONFLICT(id) DO UPDATE SET content=excluded.content' : ''), args: [message.id, message.threadId, message.resourceId, message.role, JSON.stringify(message.content), message.createdAt] };
    }
    private runStatement(run: RunState, update = false): InStatement {
        return { sql: 'INSERT INTO runs VALUES (?,?,?,?,?)' + (update ? ' ON CONFLICT(id) DO UPDATE SET status=excluded.status,state=excluded.state' : ''), args: [run.id, run.context.threadId, run.context.resourceId, run.status, JSON.stringify(run)] };
    }
    async reserveTurn(run: RunState, inputs: StoredMessage[], answer: StoredMessage) {
        this.assertRunMessage(run, answer);
        if (inputs.some(message => message.threadId !== run.context.threadId || message.resourceId !== run.context.resourceId || message.content.parentId === message.id)) throw new Error('运行与消息归属不一致');
        await this.ready;
        const statements: InStatement[] = [this.runStatement(run), ...inputs.map(message => this.messageStatement(message)), this.messageStatement(answer)];
        const thread = await this.getThreadById({ threadId: run.context.threadId, resourceId: run.context.resourceId });
        if (!thread) throw new Error('会话不存在');
        statements.push({ sql: 'UPDATE threads SET metadata=?,updatedAt=? WHERE id=? AND resourceId=?', args: [JSON.stringify({ ...thread.metadata, activeLeaf: answer.id }), new Date().toISOString(), thread.id, thread.resourceId] });
        try { await this.client.batch(statements, 'write'); }
        catch (error) {
            if (String((error as { code?: string }).code).startsWith('SQLITE_CONSTRAINT')) throw new Error('运行令牌、消息 ID 或回复 ID 已使用，请重新发起请求');
            throw error;
        }
    }
    private assertRunMessage(run: RunState, message?: StoredMessage) {
        if (run.id !== run.context.runToken || (message && (message.id !== (run.context.assistantMessageId ?? `${run.id}-assistant`) || message.role !== 'assistant' || message.threadId !== run.context.threadId || message.resourceId !== run.context.resourceId || message.content.parentId === message.id))) throw new Error('运行与消息归属不一致');
    }
    private async saveOwned(run?: RunState, message?: StoredMessage) {
        if (run) this.assertRunMessage(run, message);
        await this.ready;
        const tx = await this.client.transaction('write');
        try {
            if (run) {
                const existing = (await tx.execute({ sql: 'SELECT threadId,resourceId,state FROM runs WHERE id=?', args: [run.id] })).rows[0];
                if (existing && (existing.threadId !== run.context.threadId || existing.resourceId !== run.context.resourceId || (JSON.parse(String(existing.state)).context.assistantMessageId ?? `${run.id}-assistant`) !== (run.context.assistantMessageId ?? `${run.id}-assistant`))) throw new Error('运行令牌不属于当前会话');
            }
            if (message) {
                const existing = (await tx.execute({ sql: 'SELECT threadId,resourceId,role,content FROM messages WHERE id=?', args: [message.id] })).rows[0];
                if (existing && (existing.threadId !== message.threadId || existing.resourceId !== message.resourceId || existing.role !== message.role || (run && JSON.parse(String(existing.content)).runToken !== run.id))) throw new Error('消息 ID 不属于当前运行或角色');
                if (message.content.parentId === message.id) throw new Error('消息不能引用自身为父节点');
            }
            if (run) await tx.execute(this.runStatement(run, true));
            if (message) {
                await tx.execute(this.messageStatement(message, true));
                await tx.execute({ sql: 'UPDATE threads SET updatedAt=? WHERE id=? AND resourceId=?', args: [new Date().toISOString(), message.threadId, message.resourceId] });
            }
            await tx.commit();
        } catch (error) { await tx.rollback(); throw error; } finally { tx.close(); }
    }
    async saveMessage(message: StoredMessage) { await this.saveOwned(undefined, message); }
    async deleteThread(threadId: string, resourceId?: string) {
        const thread = await this.getThreadById({ threadId, resourceId });
        if (!thread)
            return;
        const statements: InStatement[] = ['messages', 'runs', 'legacy_memory'].map(table => ({
            sql: `DELETE FROM ${table} WHERE threadId=?`, args: [threadId],
        }));
        const prefix = `${threadId}:branch:`;
        statements.push(
            { sql: 'DELETE FROM summaries WHERE threadId=? OR substr(threadId,1,?)=?', args: [threadId, prefix.length, prefix] },
            { sql: 'DELETE FROM threads WHERE id=?', args: [threadId] },
        );
        await this.client.batch(statements, 'write');
    }
    async saveRun(run: RunState) { await this.saveOwned(run); }
    async saveTurn(run: RunState, message: StoredMessage) { await this.saveOwned(run, message); }
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

import { atomicWrite } from "../atomic-file.js";
import {
  cloudEmbedding,
  cloudRerank,
  vectorValid,
  RetryableKnowledgeError,
  MAX_KNOWLEDGE_RECALL,
  type EmbeddingConfig,
  type Embed,
  type Rank,
} from "./cloud.js";
export {
  cloudEmbedding,
  cloudRerank,
  MAX_KNOWLEDGE_RECALL,
  RetryableKnowledgeError,
} from "./cloud.js";
export type { EmbeddingConfig } from "./cloud.js";
import { createHash } from "node:crypto";
import { mkdir, readFile, unlink } from "node:fs/promises";
import { extname, join } from "node:path";
import type { LocalClient } from "../../agent/sqlite.js";
import { redactText } from "../../agent/redaction.js";

export const KNOWLEDGE_VERSION = "recursive-1000-150-v1";
import { documentExtensions } from "../../shared/document-formats.js";
export const knowledgeExtensions = documentExtensions;
export type KnowledgeDocument = {
  id: string;
  name: string;
  path: string;
  state: string;
  error: string;
  chunkCount: number;
  createdAt: number;
  space: string;
};
type Python = (
  action: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<any>;
const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export const indexSpace = (config: EmbeddingConfig) =>
  hash(JSON.stringify([config.baseUrl, config.model, KNOWLEDGE_VERSION]));

export class KnowledgeService {
  readonly ready: Promise<void>;
  private timer?: NodeJS.Timeout;
  private processing?: Promise<void>;
  private stopped = false;
  private abort = new AbortController();
  private mutations: Promise<unknown> = Promise.resolve();
  constructor(
    private db: LocalClient,
    readonly root: string,
    private python: Python,
    readonly config: () => EmbeddingConfig,
    private embed: Embed = cloudEmbedding,
    private rank: Rank = cloudRerank,
  ) {
    this.ready = this.initialize();
  }
  private async initialize() {
    await mkdir(join(this.root, "files"), { recursive: true, mode: 0o700 });
    await this.db.execute(
      `CREATE TABLE IF NOT EXISTS knowledge_documents (id TEXT PRIMARY KEY,name TEXT NOT NULL,path TEXT NOT NULL,extension TEXT NOT NULL,state TEXT NOT NULL,error TEXT NOT NULL,space TEXT NOT NULL,chunkCount INTEGER NOT NULL,createdAt INTEGER NOT NULL)`,
    );
    await this.db.execute(
      "CREATE TABLE IF NOT EXISTS knowledge_sources (path TEXT PRIMARY KEY, documentId TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE)",
    );
    await this.db.execute(
      "CREATE TABLE IF NOT EXISTS knowledge_builtin_sources (id TEXT PRIMARY KEY, documentId TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE)",
    );
    const builtinColumns = await this.db.execute("PRAGMA table_info(knowledge_builtin_sources)");
    if (!builtinColumns.rows.some(row => row.name === "groupName"))
      await this.db.execute("ALTER TABLE knowledge_builtin_sources ADD COLUMN groupName TEXT NOT NULL DEFAULT '其他参考资料'");
    await this.db.execute(
      "CREATE TABLE IF NOT EXISTS knowledge_retries (documentId TEXT PRIMARY KEY REFERENCES knowledge_documents(id) ON DELETE CASCADE, attempts INTEGER NOT NULL, nextAttemptAt INTEGER NOT NULL)",
    );
    await this.db.execute(
      "UPDATE knowledge_documents SET state='queued',error='' WHERE state='processing'",
    );
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(operation);
    this.mutations = result.catch(() => {});
    return result;
  }
  private atomic = atomicWrite;
  start() {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => void this.tick().catch(() => {}), 2000);
    this.timer.unref();
    void this.tick().catch(() => {});
  }
  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.abort.abort();
    await this.processing;
    await this.mutations;
  }
  get busy() {
    return Boolean(this.processing);
  }
  async list(): Promise<KnowledgeDocument[]> {
    await this.ready;
    const space = indexSpace(this.config());
    const result = await this.db.execute(
      "SELECT * FROM knowledge_documents ORDER BY createdAt DESC",
    );
    return result.rows.map((row) => ({
      ...row,
      state:
        row.state === "indexed" && row.space !== space ? "outdated" : row.state,
    })) as unknown as KnowledgeDocument[];
  }
  async enqueue(
    name: string,
    bytes: Buffer,
    markdown?: string,
    sourcePath?: string,
  ) {
    await this.ready;
    if (!bytes.length || bytes.length > 50 * 1024 * 1024)
      throw new Error("文件大小必须在 50 MB 以内");
    const extension = extname(name).toLowerCase();
    if (!knowledgeExtensions.has(extension))
      throw new Error(
        "知识库支持 PDF、DOCX、XLSX、PPTX、TXT、MD；图片待后续 OCR 接入",
      );
    if (extension === ".pdf" && bytes.subarray(0, 5).toString() !== "%PDF-")
      throw new Error("PDF 文件内容无效");
    if (
      [".docx", ".xlsx", ".pptx"].includes(extension) &&
      (bytes[0] !== 0x50 || bytes[1] !== 0x4b)
    )
      throw new Error("Office 文件内容无效");
    return this.serialize(async () => {
      const id = hash(bytes),
        existing = (
          await this.db.execute({
            sql: "SELECT id,state FROM knowledge_documents WHERE id=?",
            args: [id],
          })
        ).rows[0];
      if (existing) {
        if (sourcePath)
          await this.db.execute({
            sql: "INSERT OR IGNORE INTO knowledge_sources VALUES(?,?)",
            args: [sourcePath, id],
          });
        return { id, state: String(existing.state), duplicate: true };
      }
      const path = join(this.root, "files", id + extension);
      await this.atomic(path, bytes);
      if (markdown)
        await this.atomic(
          join(this.root, id + ".text.json"),
          JSON.stringify({ hash: id, text: markdown }),
        );
      const state = this.config().key ? "queued" : "waiting_config";
      await this.db.execute({
        sql: "INSERT INTO knowledge_documents VALUES(?,?,?,?,?,?,?,0,?)",
        args: [id, name, path, extension, state, "", "", Date.now()],
      });
      if (sourcePath)
        await this.db.execute({
          sql: "INSERT OR IGNORE INTO knowledge_sources VALUES(?,?)",
          args: [sourcePath, id],
        });
      return { id, state, duplicate: false };
    });
  }
  async sources(id?: string): Promise<string[]> {
    await this.ready;
    const result = await this.db.execute(
      id
        ? {
            sql: "SELECT path FROM knowledge_sources WHERE documentId=?",
            args: [id],
          }
        : "SELECT path FROM knowledge_sources",
    );
    return result.rows.map((row) => String(row.path));
  }
  async relocateSources(moves: { oldPath: string; path: string }[]) {
    await this.ready;
    return this.serialize(async () => {
      for (const move of moves)
        await this.db.execute({
          sql: "INSERT OR IGNORE INTO knowledge_sources(path,documentId) SELECT ?,documentId FROM knowledge_sources WHERE path=?",
          args: [move.path, move.oldPath],
        });
      const destinations = new Set(moves.map((move) => move.path));
      for (const oldPath of new Set(moves.map((move) => move.oldPath)))
        if (!destinations.has(oldPath))
          await this.db.execute({
            sql: "DELETE FROM knowledge_sources WHERE path=?",
            args: [oldPath],
          });
    });
  }
  async enqueueBuiltin(id: string, name: string, bytes: Buffer, groupName = "其他参考资料") {
    await this.ready;
    const previous = (
      await this.db.execute({
        sql: "SELECT documentId FROM knowledge_builtin_sources WHERE id=?",
        args: [id],
      })
    ).rows[0];
    const result = await this.enqueue(name, bytes);
    await this.serialize(() =>
      this.db.execute({
        sql: "INSERT INTO knowledge_builtin_sources(id,documentId,groupName) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET documentId=excluded.documentId,groupName=excluded.groupName",
        args: [id, result.id, groupName],
      }),
    );
    const document = (
      await this.db.execute({
        sql: "SELECT state,space FROM knowledge_documents WHERE id=?",
        args: [result.id],
      })
    ).rows[0];
    if (
      document?.state === "failed" ||
      (document?.state === "indexed" &&
        document.space !== indexSpace(this.config()))
    )
      await this.retry(result.id);
    if (previous && previous.documentId !== result.id) {
      const oldId = String(previous.documentId);
      const owners = (
        await this.db.execute({
          sql: "SELECT id FROM knowledge_builtin_sources WHERE documentId=?",
          args: [oldId],
        })
      ).rows;
      if (!owners.length && !(await this.sources(oldId)).length)
        await this.remove(oldId);
    }
    return result;
  }
  async builtinGroups(): Promise<Map<string, string>> {
    await this.ready;
    const result = await this.db.execute("SELECT documentId,groupName FROM knowledge_builtin_sources");
    return new Map(result.rows.map(row => [String(row.documentId), String(row.groupName)]));
  }
  /** Retire removed manifest entries, preserving documents also owned by user uploads. */
  async retireBuiltinSources(activeIds: Set<string>) {
    await this.ready;
    const result = await this.db.execute("SELECT id,documentId FROM knowledge_builtin_sources");
    for (const row of result.rows) {
      if (activeIds.has(String(row.id))) continue;
      const documentId = String(row.documentId);
      const owners = await this.db.execute({sql:"SELECT id FROM knowledge_builtin_sources WHERE documentId=?",args:[documentId]});
      if (owners.rows.length === 1 && !(await this.sources(documentId)).length)
        await this.remove(documentId);
      else await this.db.execute({sql:"DELETE FROM knowledge_builtin_sources WHERE id=?",args:[row.id]});
    }
  }
  async builtinIds(): Promise<Set<string>> {
    await this.ready;
    return new Set(
      (
        await this.db.execute(
          "SELECT documentId FROM knowledge_builtin_sources",
        )
      ).rows.map((row) => String(row.documentId)),
    );
  }
  async retry(id: string) {
    await this.ready;
    const result = await this.db.execute({
      sql: "UPDATE knowledge_documents SET state='queued',error='' WHERE id=? AND state NOT IN ('processing','deleting')",
      args: [id],
    });
    if (!result.rowsAffected) throw new Error("文档不存在或正在处理中");
    await this.db.execute({
      sql: "DELETE FROM knowledge_retries WHERE documentId=?",
      args: [id],
    });
  }
  async remove(id: string) {
    await this.ready;
    return this.serialize(async () => {
      const row = (
        await this.db.execute({
          sql: "SELECT * FROM knowledge_documents WHERE id=?",
          args: [id],
        })
      ).rows[0];
      if (!row) return;
      if (row.state === "processing")
        throw new Error("文档正在处理中，请完成后再移除");
      await this.db.execute({
        sql: "UPDATE knowledge_documents SET state='deleting' WHERE id=?",
        args: [id],
      });
      // Hide from searches before deleting vectors. A retry completes a partial deletion.
      if (row.space) {
        const result = await this.python("knowledge-index", {
          operation: "delete",
          root: join(this.root, "index"),
          space: String(row.space),
          documentId: id,
        });
        if (result.status && result.status !== "completed")
          throw new Error("知识索引删除失败，请重试");
      }
      for (const path of [String(row.path), join(this.root, id + ".text.json")])
        await unlink(path).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
      await this.db.execute({
        sql: "DELETE FROM knowledge_documents WHERE id=?",
        args: [id],
      });
    });
  }
  async tick() {
    if (this.stopped || this.processing) return this.processing;
    const task = this.work();
    this.processing = task;
    try {
      await task;
    } finally {
      this.processing = undefined;
    }
  }
  private async work() {
    await this.ready;
    if (this.stopped) return;
    if (!this.config().key) {
      await this.db.execute(
        "UPDATE knowledge_documents SET state='waiting_config' WHERE state='queued'",
      );
      return;
    }
    const row = (
      await this.db.execute({
        sql: "SELECT d.* FROM knowledge_documents d LEFT JOIN knowledge_retries r ON r.documentId=d.id WHERE d.state IN ('queued','waiting_config') AND COALESCE(r.nextAttemptAt,0)<=? ORDER BY d.createdAt LIMIT 1",
        args: [Date.now()],
      })
    ).rows[0];
    if (!row || this.stopped) return;
    const claimed = await this.db.execute({
      sql: "UPDATE knowledge_documents SET state='processing',error='' WHERE id=? AND state IN ('queued','waiting_config')",
      args: [row.id],
    });
    if (claimed.rowsAffected) await this.process(row);
  }
  private async process(row: any) {
    const id = String(row.id),
      signal = this.abort.signal,
      config = { ...this.config() },
      space = indexSpace(config);
    try {
      const bytes = await readFile(String(row.path));
      if (hash(bytes) !== id) throw new Error("原文件校验失败，请重新上传");
      let text = "";
      try {
        const cached = JSON.parse(
          await readFile(join(this.root, id + ".text.json"), "utf8"),
        );
        if (cached.hash === id && typeof cached.text === "string")
          text = cached.text;
      } catch {}
      if (!text) {
        if ([".txt", ".md"].includes(String(row.extension)))
          text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        else {
          const result = await this.python(
            "parse-document",
            { path: String(row.path), filename: String(row.name) },
            signal,
          );
          const full = result.resultRef
            ? JSON.parse(await readFile(result.resultRef, "utf8"))
            : result;
          if (result.status !== "completed")
            throw new Error(result.summary || "文件解析失败");
          text = String(full.data?.markdown ?? result.data?.markdown ?? "");
        }
        if (text.trim())
          await this.atomic(
            join(this.root, id + ".text.json"),
            JSON.stringify({ hash: id, text }),
          );
      }
      if (!text.trim()) {
        await this.db.execute({
          sql: "UPDATE knowledge_documents SET state='needs_ocr',error='未提取到文字，扫描文件需等待 OCR' WHERE id=?",
          args: [id],
        });
        return;
      }
      if (text.length > 2_000_000)
        throw new Error("解析文本超过 200 万字符，请拆分文件后上传");
      const split = await this.python(
        "knowledge-index",
        { operation: "split", text },
        signal,
      );
      if (split.status && split.status !== "completed")
        throw new Error(split.summary || "文件分块失败");
      const fullSplit = split.resultRef
        ? JSON.parse(await readFile(split.resultRef, "utf8"))
        : split;
      const chunks = fullSplit.data?.chunks as {
        text: string;
        page: number;
        ordinal: number;
      }[];
      if (!Array.isArray(chunks) || !chunks.length || chunks.length > 5000)
        throw new Error("分块结果无效或超过 5000 块");
      const cache = join(this.root, "vectors", space);
      await mkdir(cache, { recursive: true, mode: 0o700 });
      const vectors: number[][] = [];
      for (let start = 0; start < chunks.length; start += 8) {
        signal.throwIfAborted();
        const batch = chunks.slice(start, start + 8),
          missing: number[] = [];
        for (let offset = 0; offset < batch.length; offset++) {
          const item = batch[offset],
            path = join(cache, hash(item.text) + ".json");
          try {
            const vector = JSON.parse(await readFile(path, "utf8"));
            if (!vectorValid(vector)) throw new Error();
            vectors[start + offset] = vector;
          } catch {
            missing.push(offset);
          }
        }
        if (missing.length) {
          const computed = await this.embed(
            missing.map((offset) => batch[offset].text),
            config,
            signal,
          );
          for (let i = 0; i < missing.length; i++) {
            const offset = missing[i];
            vectors[start + offset] = computed[i];
            await this.atomic(
              join(cache, hash(batch[offset].text) + ".json"),
              JSON.stringify(computed[i]),
            );
          }
        }
      }
      const indexed = await this.python(
        "knowledge-index",
        {
          operation: "index",
          root: join(this.root, "index"),
          space,
          rows: chunks.map((chunk, i) => ({
            ...chunk,
            id: `${id}:${i}`,
            documentId: id,
            vector: vectors[i],
          })),
        },
        signal,
      );
      if (indexed.status && indexed.status !== "completed")
        throw new Error(indexed.summary || "向量索引写入失败");
      await this.db.execute({
        sql: "DELETE FROM knowledge_retries WHERE documentId=?",
        args: [id],
      });
      await this.db.execute({
        sql: "UPDATE knowledge_documents SET state='indexed',error='',space=?,chunkCount=? WHERE id=?",
        args: [space, chunks.length, id],
      });
    } catch (error) {
      let state = signal.aborted ? "queued" : "failed";
      if (!signal.aborted && error instanceof RetryableKnowledgeError) {
        const previous = (
          await this.db.execute({
            sql: "SELECT attempts FROM knowledge_retries WHERE documentId=?",
            args: [id],
          })
        ).rows[0];
        const attempts = Number(previous?.attempts || 0) + 1;
        const nextAttemptAt =
          Date.now() + Math.min(15 * 60_000, 30_000 * 2 ** (attempts - 1));
        await this.db.execute({
          sql: "INSERT INTO knowledge_retries VALUES(?,?,?) ON CONFLICT(documentId) DO UPDATE SET attempts=excluded.attempts,nextAttemptAt=excluded.nextAttemptAt",
          args: [id, attempts, nextAttemptAt],
        });
        if (attempts < 5) state = "queued";
      }
      await this.db.execute({
        sql: "UPDATE knowledge_documents SET state=?,error=? WHERE id=?",
        args: [
          state,
          signal.aborted
            ? ""
            : redactText((error as Error).message).slice(0, 500),
          id,
        ],
      });
    }
  }

  async search(query: string, limit = 5, signal?: AbortSignal) {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_KNOWLEDGE_RECALL)
      throw new Error("返回片段数量必须在 1–32 之间");
    await this.ready;
    const config = { ...this.config() },
      space = indexSpace(config);
    const rows = (
      await this.db.execute({
        sql: "SELECT id,name,path FROM knowledge_documents WHERE state='indexed' AND space=?",
        args: [space],
      })
    ).rows;
    if (!rows.length)
      return {
        matches: [],
        summary:
          "当前配置下没有已完成索引的文档。请先入库，或重建旧模型的索引。",
      };
    const [vector] = await this.embed([query], config, signal);
    const result = await this.python(
      "knowledge-index",
      {
        operation: "search",
        root: join(this.root, "index"),
        space,
        vector,
        documentIds: rows.map((row) => String(row.id)),
        limit: MAX_KNOWLEDGE_RECALL,
      },
      signal,
    );
    if (result.status && result.status !== "completed")
      throw new Error(result.summary || "知识库检索失败");
    const full = result.resultRef
      ? JSON.parse(await readFile(result.resultRef, "utf8"))
      : result;
    const documents = new Map(rows.map((row) => [String(row.id), row]));
    const candidates = (full.data?.matches ?? [])
      .slice(0, MAX_KNOWLEDGE_RECALL)
      .flatMap((match: any) => {
        const document = documents.get(match.documentId);
        return document
          ? [
              {
                ...match,
                name: String(document.name),
                path: String(document.path),
              },
            ]
          : [];
      });
    let matches = candidates.slice(0, limit),
      warning = "";
    if (config.rerankModel && candidates.length) {
      try {
        const ranked = await this.rank(
          query,
          candidates.map((item: any) => item.text),
          config,
          limit,
          signal,
        );
        matches = ranked.map((item) => ({
          ...candidates[item.index],
          rerankScore: item.relevance_score,
        }));
      } catch {
        signal?.throwIfAborted();
        warning = "重排暂时不可用，已按向量相关性返回结果。";
      }
    }
    return {
      matches,
      warning,
      summary:
        warning +
        (matches.length
          ? `找到 ${matches.length} 个相关片段；请核对内容是否回答问题，不相关时说明没有找到。`
          : "未找到相关片段。"),
    };
  }
}

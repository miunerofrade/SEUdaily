import { readFile, readdir, stat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readSavedWebFile } from "./web-file-store.js";
import { atomicWrite } from "./atomic-file.js";

type AttachmentJob = {
  url: string;
  name: string;
  site: string;
  articleId: string;
  attachmentNumber: number;
  revision: string;
  state: "pending" | "completed";
  attempts: number;
  nextAttemptAt: number;
};
type Python = (
  action: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<any>;
type Knowledge = {
  enqueue: (
    name: string,
    bytes: Buffer,
    markdown?: string,
    path?: string,
  ) => Promise<any>;
};

/** Only changed article files are parsed; the pending queue survives backend restarts. */
export class NoticeAttachments {
  private running?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private abort = new AbortController();
  private jobs = new Map<string, AttachmentJob>();
  private snapshots = new Map<string, string>();
  private initialized = false;
  private journal: string;

  constructor(
    private root: string,
    private python: Python,
    private knowledge: Knowledge,
  ) {
    this.journal = join(root, "notice-attachment-jobs.json");
  }

  start() {
    if (this.timer || this.abort.signal.aborted) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 10_000);
    this.timer.unref();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.abort.abort();
    await this.running;
  }

  tick() {
    if (this.abort.signal.aborted) return Promise.resolve();
    return (this.running ??= this.work()
      .catch((error) => {
        if (!this.abort.signal.aborted)
          console.error("通知 PDF 同步失败，将自动重试", error.message);
      })
      .finally(() => {
        this.running = undefined;
      }));
  }

  private async initialize() {
    if (this.initialized) return;
    try {
      const saved = JSON.parse(await readFile(this.journal, "utf8"));
      if (saved.version === 1 && Array.isArray(saved.jobs)) {
        for (const job of saved.jobs) {
          if (
            typeof job.url === "string" &&
            typeof job.name === "string" &&
            ["jwc", "cse"].includes(job.site) &&
            typeof job.articleId === "string" &&
            Number.isInteger(job.attachmentNumber) &&
            job.attachmentNumber > 0 &&
            typeof job.revision === "string" &&
            ["pending", "completed"].includes(job.state) &&
            Number.isFinite(job.nextAttemptAt) &&
            Number.isInteger(job.attempts) &&
            job.attempts >= 0
          ) {
            this.jobs.set(job.url, job);
          }
        }
      }
    } catch (error: any) {
      if (error.code !== "ENOENT")
        console.error("通知附件任务记录无法读取，将从通知缓存恢复");
    }
    this.initialized = true;
  }

  private async persist() {
    await mkdir(this.root, { recursive: true });
    await atomicWrite(
      this.journal,
      JSON.stringify({ version: 1, jobs: [...this.jobs.values()] }),
    );
  }

  private async discover() {
    let changed = false;
    const present = new Set<string>();
    for (const site of ["jwc", "cse"]) {
      const directory = join(this.root, site, "articles");
      const files = await readdir(directory).catch((error) => {
        if (error.code !== "ENOENT") throw error;
        return [] as string[];
      });
      for (const file of files.sort().reverse()) {
        if (!file.endsWith(".json") || this.abort.signal.aborted) continue;
        const path = join(directory, file);
        present.add(path);
        const details = await stat(path).catch(() => null);
        if (!details?.isFile()) continue;
        const snapshot = `${details.mtimeMs}:${details.ctimeMs}:${details.size}`;
        if (this.snapshots.get(path) === snapshot) continue;
        let article: any;
        try {
          article = JSON.parse(await readFile(path, "utf8"));
        } catch {
          continue;
        } // A concurrent writer will be retried on the next tick.
        if (
          typeof article.id !== "string" ||
          !Array.isArray(article.attachments)
        )
          continue;
        this.snapshots.set(path, snapshot);
        const revision = createHash("sha256")
          .update(
            JSON.stringify([
              article.contentHash,
              article.title,
              article.category,
              article.attachments,
            ]),
          )
          .digest("hex");
        for (const [index, attachment] of article.attachments.entries()) {
          if (!attachment || typeof attachment.url !== "string") continue;
          if (
            !/\.pdf(?:$|[?#])/i.test(attachment.url) &&
            !/\.pdf$/i.test(attachment.name || "")
          )
            continue;
          const existing = this.jobs.get(attachment.url);
          if (existing?.revision === revision) continue;
          this.jobs.set(attachment.url, {
            url: attachment.url,
            name: attachment.name || "通知附件.pdf",
            site,
            articleId: article.id,
            attachmentNumber: index + 1,
            revision,
            state: "pending",
            attempts: 0,
            nextAttemptAt: 0,
          });
          changed = true;
        }
      }
    }
    for (const path of this.snapshots.keys())
      if (!present.has(path)) this.snapshots.delete(path);
    if (changed) await this.persist();
  }

  private async work() {
    await this.initialize();
    await this.discover();
    for (const job of this.jobs.values()) {
      if (this.abort.signal.aborted) return;
      if (job.state === "completed" || job.nextAttemptAt > Date.now()) continue;
      try {
        let saved = await readSavedWebFile(this.root, job.url);
        if (!saved) {
          const result = await this.python(
            "sync-notice-pdf",
            {
              site: job.site,
              articleId: job.articleId,
              attachmentNumber: job.attachmentNumber,
            },
            this.abort.signal,
          );
          if (result.status !== "completed")
            throw new Error(result.summary || "附件下载失败");
          saved = await readSavedWebFile(this.root, job.url);
          if (!saved) throw new Error("下载的网页原文件校验失败");
        }
        const { item, bytes } = saved;
        if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-")))
          throw new Error("附件不是 PDF");
        await this.knowledge.enqueue(
          item.name,
          bytes,
          typeof item.markdown === "string" ? item.markdown : undefined,
          item.path,
        );
        job.state = "completed";
        job.nextAttemptAt = 0;
      } catch (error: any) {
        if (this.abort.signal.aborted) return;
        job.attempts++;
        job.nextAttemptAt =
          Date.now() +
          Math.min(
            60 * 60_000,
            5 * 60_000 * 2 ** Math.min(job.attempts - 1, 4),
          );
        console.error(
          `通知 PDF 暂未完成：${job.name}，稍后重试`,
          error.message,
        );
      }
      await this.persist();
    }
  }
}

import { webLibraryEntries } from "./web-library.js";
import { redactText } from "../agent/redaction.js";
import { registerApiRoute } from "../server/routes.js";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, extname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { projectRoot } from "./runtime-paths.js";
import { runPythonTool } from "./tools/python-bridge.js";
import type { ToolResult } from "./tools/tool-result.js";
import {
  storeDocumentContext,
  resolveDocumentContexts,
} from "./document-context.js";
import {
  documentExtensions as supportedDocumentExtensions,
  documentMediaTypes,
} from "../shared/document-formats.js";
import {
  safeLibraryTarget,
  previewContentType,
  walkFiles,
  isWithinDirectory,
} from "./library-files.js";
import { fullResultData } from "./app-route-helpers.js";

export const libraryRoutes = [
  registerApiRoute("/app/library", {
    method: "GET",
    requiresAuth: false,
    handler: async (c: any) => {
      const root = resolve(projectRoot, "exports");
      const category = c.req.query("category") || "",
        query = (c.req.query("query") || "").trim().toLocaleLowerCase();
      const labels = [
        ["documents", "上传文件"],
        ["references", "参考资料"],
        ["web", "网页与通知"],
        ["knowledge", "课程笔记"],
        ["subtitle", "课程字幕"],
        ["media", "课程媒体"],
        ["images", "临时图片"],
      ];
      if (!category && !query && c.req.query("all") !== "1")
        return c.json({
          root,
          level: "categories",
          directories: labels.map(([id, label]) => ({ id, label })),
          files: [],
          count: 0,
        });
      const files = await walkFiles(root);
      const imageRoot = resolve(projectRoot, ".seudaily", "uploads", "images");
      const images = await walkFiles(imageRoot);
      files.push(
        ...images.map((file) => ({
          ...file,
          category: "images",
          course: "临时图片",
          teacher: "本地上传",
        })),
      );
      const documents = await walkFiles(
        resolve(projectRoot, ".seudaily", "uploads", "documents"),
      );
      const { knowledge } = await import("./knowledge/index.js");
      const sources = new Set(await knowledge.sources());
      files.push(
        ...documents
          .filter((file) => !sources.has(file.path))
          .map((file) => ({
            ...file,
            name:
              resolveDocumentContexts([
                basename(file.path, extname(file.path)),
              ])[0]?.name || file.name,
            category: "documents",
            course: "上传文件",
            teacher: "本地文件",
          })),
      );
      const knowledgeDocuments = await knowledge.list();
      const webRoot = resolve(projectRoot, ".seudaily", "web-files", "files");
      const webDocumentIds = new Set(
        (
          await Promise.all(
            knowledgeDocuments.map(async (document) =>
              (await knowledge.sources(document.id)).some((path) =>
                isWithinDirectory(webRoot, resolve(path)),
              )
                ? document.id
                : null,
            ),
          )
        ).filter(Boolean),
      );
      const indexed = new Map(
        knowledgeDocuments
          .filter((document) => !webDocumentIds.has(document.id))
          .map((document) => [document.path, document]),
      );
      const builtinIds = await knowledge.builtinIds();
      const originals = await walkFiles(
        resolve(projectRoot, ".seudaily", "knowledge", "files"),
      );
      files.push(
        ...originals.flatMap((file) => {
          const document = indexed.get(file.path);
          return document
            ? [
                {
                  ...file,
                  name: document.name,
                  category: builtinIds.has(document.id)
                    ? "references"
                    : "documents",
                  course: builtinIds.has(document.id) ? "参考资料" : "上传文件",
                  teacher: "本地文件",
                },
              ]
            : [];
        }),
      );
      const webEntries = await webLibraryEntries(projectRoot);
      await knowledge.relocateSources(
        [...webEntries].flatMap(([path, item]) =>
          item.legacyPaths.map((oldPath) => ({ oldPath, path })),
        ),
      );
      const webFiles = await walkFiles(
        resolve(projectRoot, ".seudaily", "web-files", "files"),
      );
      files.push(
        ...webFiles.map((file) => ({
          ...file,
          name: webEntries.get(file.path)?.name || file.name,
          sources: webEntries.get(file.path)?.sources || ["未分类"],
          sections: webEntries.get(file.path)?.sections || [],
          notice: webEntries.get(file.path)?.notice,
          category: "web",
          course: "网页与通知",
          teacher: "本地缓存",
        })),
      );
      files.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      if (c.req.query("all") === "1")
        return c.json({ root, files, count: files.length });
      const source = c.req.query("source") || "",
        section = c.req.query("section") || "",
        notice = c.req.query("notice") || "",
        course = c.req.query("course") || "",
        teacher = c.req.query("teacher") || "";
      let chosen = query
        ? files.filter((file) => file.name.toLocaleLowerCase().includes(query))
        : files.filter((file) => file.category === category);
      let level = "files";
      let directories: { id: string; label: string }[] = [];
      const groups = (values: string[]) =>
        [...new Set(values)]
          .sort((a, b) => a.localeCompare(b, "zh-CN"))
          .map((value) => ({ id: value, label: value }));
      if (!query && category === "web") {
        if (!source) {
          level = "sources";
          directories = groups(
            chosen.flatMap((file: any) => file.sources || ["未分类"]),
          );
        } else {
          chosen = chosen.filter((file: any) => file.sources?.includes(source));
          if (!section) {
            level = "sections";
            directories = groups(
              chosen.flatMap(
                (file: any) =>
                  file.sections
                    ?.filter((item: any) => item.source === source)
                    .map((item: any) => item.label) || ["其他资料"],
              ),
            );
          } else {
            chosen = chosen.filter((file: any) =>
              file.sections?.some(
                (item: any) => item.source === source && item.label === section,
              ),
            );
            if (!notice) {
              level = "notices";
              directories = [
                ...new Map(
                  chosen.map((file: any) => [
                    file.notice?.id || file.path,
                    {
                      id: file.notice?.id || file.path,
                      label: file.notice?.title || file.name,
                    },
                  ]),
                ).values(),
              ] as { id: string; label: string }[];
            } else
              chosen = chosen.filter(
                (file: any) => (file.notice?.id || file.path) === notice,
              );
          }
        }
      } else if (
        !query &&
        !["documents", "references", "images"].includes(category)
      ) {
        if (!course) {
          level = "courses";
          directories = groups(chosen.map((file) => file.course));
        } else {
          chosen = chosen.filter((file) => file.course === course);
          if (!teacher) {
            level = "teachers";
            directories = groups(
              chosen.map((file) => file.teacher || "未分类"),
            );
          } else
            chosen = chosen.filter(
              (file) => (file.teacher || "未分类") === teacher,
            );
        }
      }
      if (level !== "files")
        return c.json({
          root,
          level,
          directories,
          files: [],
          count: directories.length,
        });
      if (c.req.query("pdf") === "1")
        chosen = chosen.filter((file) => file.type === "PDF");
      const limit = Math.max(
          1,
          Math.min(100, Number(c.req.query("limit")) || 50),
        ),
        offset = Math.max(
          0,
          Number.parseInt(c.req.query("cursor") || "0", 10) || 0,
        );
      const page = chosen.slice(offset, offset + limit),
        next = offset + page.length;
      return c.json({
        root,
        level: query ? "search" : "files",
        directories: [],
        files: page,
        count: chosen.length,
        nextCursor: next < chosen.length ? String(next) : null,
      });
    },
  }),
  registerApiRoute("/app/library/preview", {
    method: "GET",
    requiresAuth: false,
    handler: async (c: any) => {
      const requested = c.req.query("path");
      if (!requested) return c.json({ error: "缺少文件路径" }, 400);
      const target = await safeLibraryTarget(requested);
      if (!target) return c.json({ error: "只能预览资料库内的文件" }, 403);
      const details = await stat(target).catch(() => null);
      if (!details?.isFile()) return c.json({ error: "文件不存在" }, 404);
      if (details.size > 50 * 1024 * 1024)
        return c.json({ error: "文件超过 50 MB，无法在线预览" }, 413);
      const bytes = await readFile(target);
      return new Response(new Uint8Array(bytes), {
        headers: {
          "Content-Type": previewContentType(target),
          "Content-Disposition":
            c.req.query("download") === "1"
              ? "attachment; filename*=UTF-8\'\'" +
                encodeURIComponent(basename(c.req.query("name") || target))
              : "inline",
          "Cache-Control": "private, max-age=60",
          "X-Content-Type-Options": "nosniff",
        },
      });
    },
  }),
  registerApiRoute("/app/library", {
    method: "DELETE",
    requiresAuth: false,
    handler: async (c: any) => {
      const body = (await c.req.json()) as { path?: unknown };
      if (typeof body.path !== "string")
        return c.json({ error: "缺少文件路径" }, 400);
      const target = await safeLibraryTarget(body.path);
      if (!target) return c.json({ error: "只能删除资料库内的文件" }, 403);
      const knowledgeFiles = await realpath(
        resolve(projectRoot, ".seudaily", "knowledge", "files"),
      ).catch(() => null);
      if (knowledgeFiles && isWithinDirectory(knowledgeFiles, target)) {
        const { knowledge } = await import("./knowledge/index.js");
        const document = (await knowledge.list()).find(
          (item) => resolve(item.path) === resolve(body.path as string),
        );
        if (!document)
          return c.json({ error: "知识库文件未登记，请通过知识库管理" }, 409);
        const sources = await knowledge.sources(document.id);
        const uploads = await realpath(
          resolve(projectRoot, ".seudaily", "uploads", "documents"),
        ).catch(() => null);
        await knowledge.remove(document.id);
        for (const source of sources) {
          const safe = await safeLibraryTarget(source);
          if (safe && uploads && isWithinDirectory(uploads, safe))
            await unlink(safe).catch((error) => {
              if (error.code !== "ENOENT") throw error;
            });
        }
      } else await unlink(target);
      return c.json({ deleted: true, path: target });
    },
  }),
  registerApiRoute("/app/images", {
    method: "POST",
    requiresAuth: false,
    handler: async (c: any) => {
      const body = (await c.req.json()) as {
        dataUrl?: unknown;
        name?: unknown;
      };
      if (typeof body.dataUrl !== "string")
        return c.json({ error: "缺少图片数据" }, 400);
      const match = body.dataUrl.match(
        /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/,
      );
      if (!match)
        return c.json({ error: "仅支持 PNG、JPEG、WebP 或 GIF 图片" }, 400);
      const bytes = Buffer.from(match[2], "base64");
      if (!bytes.length || bytes.length > 10 * 1024 * 1024)
        return c.json({ error: "图片大小必须在 10 MB 以内" }, 400);
      const extension = match[1] === "image/jpeg" ? "jpg" : match[1].slice(6);
      const directory = resolve(projectRoot, ".seudaily", "uploads", "images");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const target = resolve(
        directory,
        `${Date.now()}-${randomUUID()}.${extension}`,
      );
      await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
      return c.json({
        path: target,
        ref: basename(target),
        sha256: createHash("sha256").update(bytes).digest("hex"),
        name: typeof body.name === "string" ? body.name : `image.${extension}`,
        mediaType: match[1],
        size: bytes.length,
      });
    },
  }),
  registerApiRoute("/app/documents", {
    method: "POST",
    requiresAuth: false,
    handler: async (c: any) => {
      const body = await c.req.parseBody();
      const upload = body?.file;
      if (!(upload instanceof File))
        return c.json({ error: "缺少文档文件" }, 400);
      const filename = upload.name || "document";
      const extension = extname(filename).toLowerCase();
      if (!supportedDocumentExtensions.has(extension)) {
        return c.json(
          {
            error:
              "仅支持 PDF、DOCX、XLSX、PPTX、TXT、MD；不支持旧版 DOC、XLS、PPT",
          },
          400,
        );
      }
      if (upload.size <= 0 || upload.size > 50 * 1024 * 1024) {
        return c.json({ error: "文档大小必须在 50 MB 以内" }, 413);
      }

      const bytes = Buffer.from(await upload.arrayBuffer());
      const plainText = [".txt", ".md"].includes(extension);
      const validSignature =
        plainText ||
        (extension === ".pdf"
          ? bytes.subarray(0, 5).toString("ascii") === "%PDF-"
          : bytes[0] === 0x50 && bytes[1] === 0x4b);
      if (!validSignature)
        return c.json({ error: "文件内容与扩展名不匹配或文件已损坏" }, 400);

      const temporaryDirectory = await mkdtemp(
        join(tmpdir(), "seudaily-document-"),
      );
      const temporaryPath = join(
        temporaryDirectory,
        `${randomUUID()}${extension}`,
      );
      try {
        await writeFile(temporaryPath, bytes);
        let result: ToolResult;
        try {
          if (plainText) {
            const markdown = new TextDecoder("utf-8", { fatal: true }).decode(
              bytes,
            );
            result = {
              status: "completed",
              taskId: randomUUID(),
              summary: "文档已读取",
              data: {
                filename,
                extension,
                markdown,
                charCount: markdown.length,
              },
              artifacts: [],
              citations: [],
              warnings: [],
              metrics: {},
            };
          } else
            result = await runPythonTool<ToolResult>("parse-document", {
              path: temporaryPath,
              filename,
            });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          return c.json({ error: `文档解析失败：${message}` }, 422);
        }
        const data = (await fullResultData(result)) as
          | {
              filename?: string;
              extension?: string;
              markdown?: string;
              charCount?: number;
            }
          | undefined;
        if (result.status !== "completed" || !data?.markdown) {
          return c.json(
            {
              error: result.summary || "文档解析失败",
              warnings: result.warnings,
            },
            422,
          );
        }
        const contextRef = randomUUID();
        const documentDirectory = resolve(
          projectRoot,
          ".seudaily",
          "uploads",
          "documents",
        );
        await mkdir(documentDirectory, { recursive: true, mode: 0o700 });
        const originalPath = join(
          documentDirectory,
          `${contextRef}${extension}`,
        );
        await writeFile(originalPath, bytes, { flag: "wx", mode: 0o600 });
        try {
          storeDocumentContext(
            contextRef,
            data.filename || filename,
            data.markdown,
          );
        } catch (error) {
          await unlink(originalPath).catch(() => undefined);
          throw error;
        }
        let knowledgeIndex:
          | { id: string; state: string; duplicate: boolean }
          | { state: string; error: string };
        try {
          const { knowledge } = await import("./knowledge/index.js");
          knowledgeIndex = await knowledge.enqueue(
            data.filename || filename,
            bytes,
            data.markdown,
            originalPath,
          );
        } catch (error) {
          // Keep the uploaded attachment usable even when local indexing fails.
          knowledgeIndex = {
            state: "failed",
            error: redactText((error as Error).message),
          };
        }
        return c.json({
          knowledge: knowledgeIndex,
          filename: data.filename || filename,
          extension: data.extension || extension,
          mediaType: documentMediaTypes[extension],
          contextRef,
          path: originalPath,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          markdown: data.markdown,
          charCount: data.charCount ?? data.markdown.length,
        });
      } finally {
        await rm(temporaryDirectory, { recursive: true, force: true }).catch(
          () => undefined,
        );
      }
    },
  }),
  registerApiRoute("/app/images/resolve", {
    method: "GET",
    requiresAuth: false,
    handler: async (c: any) => {
      const imageRoot = resolve(projectRoot, ".seudaily", "uploads", "images");
      const ref = c.req.query("ref");
      const sha256 = c.req.query("sha256")?.toLowerCase();
      if (ref) {
        if (basename(ref) !== ref)
          return c.json({ error: "图片引用无效" }, 400);
        const target = resolve(imageRoot, ref);
        const details = await stat(target).catch(() => null);
        if (!details?.isFile()) return c.json({ error: "图片已被删除" }, 404);
        return c.json({
          path: target,
          ref,
          mediaType: previewContentType(target),
        });
      }
      if (!sha256 || !/^[a-f0-9]{64}$/.test(sha256))
        return c.json({ error: "缺少图片引用" }, 400);
      const entries = await readdir(imageRoot, { withFileTypes: true }).catch(
        () => [],
      );
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const target = resolve(imageRoot, entry.name);
        const bytes = await readFile(target).catch(() => null);
        if (
          bytes &&
          createHash("sha256").update(bytes).digest("hex") === sha256
        )
          return c.json({
            path: target,
            ref: entry.name,
            mediaType: previewContentType(target),
          });
      }
      return c.json({ error: "图片已被删除" }, 404);
    },
  }),
];

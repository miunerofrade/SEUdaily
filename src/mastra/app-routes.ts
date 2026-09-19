import { registerApiRoute } from "@mastra/core/server";
import { mkdir, readdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";

import { projectRoot } from "./runtime-paths.js";
import { runPythonTool } from "./tools/python-bridge.js";
import type { ToolResult } from "./tools/tool-result.js";

const editableEnvironment = [
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_MODEL",
  "TAVILY_API_KEY",
  "CVSTREAM_USERNAME",
  "CVSTREAM_PASSWORD",
  "CVSTREAM_ASR_API_KEY",
  "CVSTREAM_WHISPER_MODEL",
] as const;

const secretEnvironment = new Set(["DEEPSEEK_API_KEY", "TAVILY_API_KEY", "CVSTREAM_PASSWORD", "CVSTREAM_ASR_API_KEY"]);

function resultResponse(result: ToolResult) {
  return {
    status: result.status,
    summary: result.summary,
    data: result.data,
    warnings: result.warnings,
  };
}

type LibraryFile = { path: string; relativePath: string; name: string; size: number; updatedAt: string; type: string; category: string; course: string; teacher: string };

const libraryRoots = [resolve(projectRoot, "exports"), resolve(projectRoot, ".cvstream", "uploads", "images")];

function safeLibraryTarget(path: string) {
  const target = resolve(path);
  const allowed = libraryRoots.some((root) => {
    const child = relative(root, target);
    return Boolean(child) && !child.startsWith("..") && !isAbsolute(child);
  });
  return allowed ? target : null;
}

function previewContentType(path: string) {
  const extension = extname(path).toLowerCase();
  return ({
    ".md": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".pdf": "application/pdf",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
    ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav", ".mp4": "video/mp4", ".webm": "video/webm",
    ".ppt": "application/vnd.ms-powerpoint", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  } as Record<string, string>)[extension] ?? "application/octet-stream";
}

function libraryIdentity(root: string, path: string) {
  const relativePath = relative(root, path);
  const segments = relativePath.split(/[\\/]/);
  const category = segments[0] || "other";
  const course = segments[1] || "未分类";
  const datedOwner = segments.find((segment) => /^\d{8}-.+/.test(segment));
  const teacher = datedOwner?.replace(/^\d{8}-/, "").replace(/_Summary(?:\.[^.]+)?$/i, "") || "教师未标注";
  return { relativePath, category, course, teacher };
}

async function walkFiles(root: string, directory = root, output: LibraryFile[] = [], seen = new Set<string>()) {
  if (output.length >= 1000) return output;
  const resolvedDirectory = await realpath(directory).catch(() => directory);
  if (seen.has(resolvedDirectory)) return output;
  seen.add(resolvedDirectory);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return output;
  }
  for (const entry of entries) {
    if (output.length >= 1000 || entry.name.startsWith(".")) continue;
    const fullPath = resolve(directory, entry.name);
    const details = await stat(fullPath).catch(() => null);
    if (!details) continue;
    if (details.isDirectory()) {
      await walkFiles(root, fullPath, output, seen);
      continue;
    }
    const extension = extname(entry.name).toLowerCase();
    if (![".md", ".txt", ".pdf", ".ppt", ".pptx", ".mp3", ".m4a", ".wav", ".mp4", ".webm", ".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(extension)) continue;
    output.push({
      path: fullPath,
      ...libraryIdentity(root, fullPath),
      name: entry.name,
      size: details.size,
      updatedAt: details.mtime.toISOString(),
      type: extension.slice(1).toUpperCase(),
    });
  }
  return output;
}

function parseEnv(content: string) {
  const values: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}

async function readEnvFile() {
  try {
    return await readFile(resolve(projectRoot, ".env"), "utf8");
  } catch {
    return "";
  }
}

function encodeEnvValue(value: string) {
  return /^[A-Za-z0-9_./:@-]*$/.test(value) ? value : JSON.stringify(value);
}

async function updateEnvFile(updates: Record<string, string>) {
  const target = resolve(projectRoot, ".env");
  let content = await readEnvFile();
  for (const [key, value] of Object.entries(updates)) {
    const line = `${key}=${encodeEnvValue(value)}`;
    const pattern = new RegExp(`^\\s*${key}\\s*=.*$`, "m");
    content = pattern.test(content) ? content.replace(pattern, line) : `${content.trimEnd()}${content.trim() ? "\n" : ""}${line}\n`;
    process.env[key] = value;
  }
  const temporary = `${target}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, target);
}

export const appRoutes = [
  registerApiRoute("/app/schedule", {
    method: "GET",
    requiresAuth: false,
    handler: async (c: any) => {
      const refresh = c.req.query("refresh") === "true";
      const result = await runPythonTool<ToolResult>("get-schedule", { refresh });
      let data = result.data;
      try {
        const cached = JSON.parse(await readFile(resolve(projectRoot, ".cvstream", "schedule.json"), "utf8")) as Record<string, unknown>;
        if (Array.isArray(cached.courses)) data = { ...(result.data as Record<string, unknown>), ...cached };
      } catch {
        // Missing cache is represented by the tool status and summary.
      }
      return c.json({ ...resultResponse(result), data });
    },
  }),
  registerApiRoute("/app/schedule/authorize", {
    method: "POST",
    requiresAuth: false,
    handler: async (c: any) => {
      const result = await runPythonTool<ToolResult>("authorize-schedule", { timeoutSeconds: 300, resetSession: true });
      return c.json(resultResponse(result));
    },
  }),
  registerApiRoute("/app/library", {
    method: "GET",
    requiresAuth: false,
    handler: async (c: any) => {
      const root = resolve(projectRoot, "exports");
      const files = await walkFiles(root);
      const imageRoot = resolve(projectRoot, ".cvstream", "uploads", "images");
      const images = await walkFiles(imageRoot);
      files.push(...images.map((file) => ({ ...file, category: "images", course: "临时图片", teacher: "本地上传" })));
      files.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return c.json({ root, files, count: files.length });
    },
  }),
  registerApiRoute("/app/library/preview", {
    method: "GET",
    requiresAuth: false,
    handler: async (c: any) => {
      const requested = c.req.query("path");
      if (!requested) return c.json({ error: "缺少文件路径" }, 400);
      const target = safeLibraryTarget(requested);
      if (!target) return c.json({ error: "只能预览资料库内的文件" }, 403);
      const details = await stat(target).catch(() => null);
      if (!details?.isFile()) return c.json({ error: "文件不存在" }, 404);
      if (details.size > 50 * 1024 * 1024) return c.json({ error: "文件超过 50 MB，无法在线预览" }, 413);
      const bytes = await readFile(target);
      return new Response(new Uint8Array(bytes), { headers: { "Content-Type": previewContentType(target), "Content-Disposition": "inline", "Cache-Control": "private, max-age=60", "X-Content-Type-Options": "nosniff" } });
    },
  }),
  registerApiRoute("/app/library", {
    method: "DELETE",
    requiresAuth: false,
    handler: async (c: any) => {
      const body = await c.req.json() as { path?: unknown };
      if (typeof body.path !== "string") return c.json({ error: "缺少文件路径" }, 400);
      const target = safeLibraryTarget(body.path);
      if (!target) return c.json({ error: "只能删除资料库内的文件" }, 403);
      await unlink(target);
      return c.json({ deleted: true, path: target });
    },
  }),
  registerApiRoute("/app/images", {
    method: "POST",
    requiresAuth: false,
    handler: async (c: any) => {
      const body = await c.req.json() as { dataUrl?: unknown; name?: unknown };
      if (typeof body.dataUrl !== "string") return c.json({ error: "缺少图片数据" }, 400);
      const match = body.dataUrl.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/);
      if (!match) return c.json({ error: "仅支持 PNG、JPEG、WebP 或 GIF 图片" }, 400);
      const bytes = Buffer.from(match[2], "base64");
      if (!bytes.length || bytes.length > 10 * 1024 * 1024) return c.json({ error: "图片大小必须在 10 MB 以内" }, 400);
      const extension = match[1] === "image/jpeg" ? "jpg" : match[1].slice(6);
      const directory = resolve(projectRoot, ".cvstream", "uploads", "images");
      await mkdir(directory, { recursive: true });
      const target = resolve(directory, `${Date.now()}-${randomUUID()}.${extension}`);
      await writeFile(target, bytes);
      return c.json({ path: target, ref: basename(target), sha256: createHash("sha256").update(bytes).digest("hex"), name: typeof body.name === "string" ? body.name : `image.${extension}`, mediaType: match[1], size: bytes.length });
    },
  }),
  registerApiRoute("/app/images/resolve", {
    method: "GET",
    requiresAuth: false,
    handler: async (c: any) => {
      const imageRoot = resolve(projectRoot, ".cvstream", "uploads", "images");
      const ref = c.req.query("ref");
      const sha256 = c.req.query("sha256")?.toLowerCase();
      if (ref) {
        if (basename(ref) !== ref) return c.json({ error: "图片引用无效" }, 400);
        const target = resolve(imageRoot, ref);
        const details = await stat(target).catch(() => null);
        if (!details?.isFile()) return c.json({ error: "图片已被删除" }, 404);
        return c.json({ path: target, ref, mediaType: previewContentType(target) });
      }
      if (!sha256 || !/^[a-f0-9]{64}$/.test(sha256)) return c.json({ error: "缺少图片引用" }, 400);
      const entries = await readdir(imageRoot, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const target = resolve(imageRoot, entry.name);
        const bytes = await readFile(target).catch(() => null);
        if (bytes && createHash("sha256").update(bytes).digest("hex") === sha256) return c.json({ path: target, ref: entry.name, mediaType: previewContentType(target) });
      }
      return c.json({ error: "图片已被删除" }, 404);
    },
  }),
  registerApiRoute("/app/notices", {
    method: "GET",
    requiresAuth: false,
    handler: async (c: any) => {
      const refresh = c.req.query("refresh") !== "false";
      const result = await runPythonTool<ToolResult>("list-jwc", {
        categories: ["news", "academic", "lectures"],
        freshness: refresh ? "latest" : "cache_only",
        timeScope: "any",
        limit: 20,
      });
      return c.json(resultResponse(result));
    },
  }),
  registerApiRoute("/app/settings", {
    method: "GET",
    requiresAuth: false,
    handler: async (c: any) => {
      const values = parseEnv(await readEnvFile());
      return c.json({
        provider: { name: "DeepSeek", baseUrl: "https://api.deepseek.com", editable: false },
        fields: editableEnvironment.map((name) => ({
          name,
          secret: secretEnvironment.has(name),
          configured: Boolean(values[name] || process.env[name]),
          value: secretEnvironment.has(name) ? "" : (values[name] ?? process.env[name] ?? ""),
        })),
      });
    },
  }),
  registerApiRoute("/app/settings", {
    method: "POST",
    requiresAuth: false,
    handler: async (c: any) => {
      const body = await c.req.json() as { values?: Record<string, unknown> };
      const values: Record<string, string> = {};
      for (const name of editableEnvironment) {
        const value = body.values?.[name];
        if (typeof value === "string" && value.trim()) values[name] = value.trim();
      }
      await updateEnvFile(values);
      return c.json({ saved: Object.keys(values), restartRequired: true });
    },
  }),
];

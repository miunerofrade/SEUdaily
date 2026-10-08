import { projectRoot } from "./runtime-paths.js";
import { readdir, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
type LibraryFile = {
  path: string;
  relativePath: string;
  name: string;
  size: number;
  updatedAt: string;
  type: string;
  category: string;
  course: string;
  teacher: string;
  sources?: string[];
};

const libraryRoots = [
  resolve(projectRoot, "exports"),
  resolve(projectRoot, ".seudaily", "uploads", "images"),
  resolve(projectRoot, ".seudaily", "uploads", "documents"),
  resolve(projectRoot, ".seudaily", "knowledge", "files"),
  resolve(projectRoot, ".seudaily", "web-files", "files"),
];

export function isWithinDirectory(
  root: string,
  target: string,
  allowRoot = false,
) {
  const child = relative(root, target);
  return (
    (allowRoot || Boolean(child)) &&
    child !== ".." &&
    !child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    !isAbsolute(child)
  );
}

export async function safeLibraryTarget(path: string) {
  const target = resolve(path);
  for (const root of libraryRoots) {
    if (!isWithinDirectory(root, target)) continue;
    const canonicalRoot = await realpath(root).catch(() => null);
    const canonicalTarget = await realpath(target).catch(() => null);
    // Keep the configured root itself inside the project, even if it is a symlink.
    const canonicalProject = await realpath(projectRoot).catch(() => null);
    if (!canonicalRoot || !canonicalTarget || !canonicalProject) return null;
    if (!isWithinDirectory(canonicalProject, canonicalRoot)) return null;
    if (!isWithinDirectory(canonicalRoot, canonicalTarget)) return null;
    return canonicalTarget;
  }
  return null;
}

export function previewContentType(path: string) {
  const extension = extname(path).toLowerCase();
  return (
    (
      {
        ".md": "text/markdown; charset=utf-8",
        ".txt": "text/plain; charset=utf-8",
        ".pdf": "application/pdf",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".gif": "image/gif",
        ".mp3": "audio/mpeg",
        ".m4a": "audio/mp4",
        ".wav": "audio/wav",
        ".mp4": "video/mp4",
        ".webm": "video/webm",
        ".ppt": "application/vnd.ms-powerpoint",
        ".pptx":
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      } as Record<string, string>
    )[extension] ?? "application/octet-stream"
  );
}

function libraryIdentity(root: string, path: string) {
  const relativePath = relative(root, path);
  const segments = relativePath.split(/[\\/]/);
  const category = segments[0] || "other";
  const course = segments[1] || "未分类";
  const datedOwner = segments.find((segment) => /^\d{8}-.+/.test(segment));
  const teacher =
    datedOwner?.replace(/^\d{8}-/, "").replace(/_Summary(?:\.[^.]+)?$/i, "") ||
    "教师未标注";
  return { relativePath, category, course, teacher };
}

export async function walkFiles(
  root: string,
  directory = root,
  output: LibraryFile[] = [],
  seen = new Set<string>(),
) {
  if (output.length >= 1000) return output;
  const canonicalRoot = await realpath(root).catch(() => null);
  const canonicalProject = await realpath(projectRoot).catch(() => null);
  const resolvedDirectory = await realpath(directory).catch(() => null);
  if (!canonicalRoot || !canonicalProject || !resolvedDirectory) return output;
  if (
    !isWithinDirectory(canonicalProject, canonicalRoot) ||
    !isWithinDirectory(canonicalRoot, resolvedDirectory, true)
  )
    return output;
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
    const canonicalFile = await realpath(fullPath).catch(() => null);
    if (!canonicalFile || !isWithinDirectory(canonicalRoot, canonicalFile))
      continue;
    const details = await stat(fullPath).catch(() => null);
    if (!details) continue;
    if (details.isDirectory()) {
      await walkFiles(root, fullPath, output, seen);
      continue;
    }
    const extension = extname(entry.name).toLowerCase();
    if (
      ![
        ".md",
        ".txt",
        ".pdf",
        ".docx",
        ".xlsx",
        ".ppt",
        ".pptx",
        ".mp3",
        ".m4a",
        ".wav",
        ".mp4",
        ".webm",
        ".png",
        ".jpg",
        ".jpeg",
        ".webp",
        ".gif",
      ].includes(extension)
    )
      continue;
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

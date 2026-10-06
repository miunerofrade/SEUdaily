import { MAX_ATTACHMENTS } from "../shared/attachment-limits.js";
import { mkdirSync, lstatSync, realpathSync, openSync, closeSync, fstatSync, readFileSync, writeFileSync, fsyncSync, constants } from 'node:fs';
import { join } from 'node:path';
import { runtimeRoot } from './runtime-paths.js';
import { tmpdir } from 'node:os';

type StoredDocumentContext = { name: string; markdown: string; expiresAt: number };
export const contextDirectory = join(runtimeRoot, 'document-context');
const legacyDirectory = join(tmpdir(), `seudaily-document-context-${process.getuid?.() ?? 'user'}`);
const validRef = (ref: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref);

// Never follow caller-controlled symlinks or truncate a file before checking its ownership.
function openContext(ref: string, create = false, root = contextDirectory) {
  if (!validRef(ref)) throw new Error('文档引用格式无效');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const directory = lstatSync(root);
  const uid = process.getuid?.();
  if (!directory.isDirectory() || (uid !== undefined && (directory.uid !== uid || (directory.mode & 0o077) !== 0))) throw new Error('文档暂存目录不安全');
  const path = join(realpathSync(root), `${ref}.json`);
  if (!create && !constants.O_NOFOLLOW) {
    const before = lstatSync(path);
    if (!before.isFile()) throw new Error('文档暂存文件不安全');
  }
  const fd = openSync(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0) | (create ? constants.O_CREAT | constants.O_EXCL : 0), 0o600);
  try {
    const file = fstatSync(fd);
    const current = lstatSync(path);
    if (!current.isFile() || current.ino !== file.ino || current.dev !== file.dev || !file.isFile() || file.nlink !== 1 || (uid !== undefined && file.uid !== uid)) throw new Error('文档暂存文件不安全');
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}

export function storeDocumentContext(ref: string, name: string, markdown: string) {
  const fd = openContext(ref, true);
  try { writeFileSync(fd, JSON.stringify({ name, markdown, expiresAt: Number.MAX_SAFE_INTEGER }), 'utf8'); fsyncSync(fd); }
  finally { closeSync(fd); }
}

export function resolveDocumentContexts(refs: unknown) {
  if (!Array.isArray(refs)) return [];
  const resolved: Array<{ name: string; markdown: string }> = [];
  for (const value of refs.slice(0, MAX_ATTACHMENTS)) {
    if (typeof value !== 'string') continue;
    let fd: number | undefined;
    try {
      try { fd = openContext(value); } catch { fd = openContext(value, false, legacyDirectory); }
      const context = JSON.parse(readFileSync(fd, 'utf8')) as StoredDocumentContext;
      if (!context || typeof context.name !== 'string' || typeof context.markdown !== 'string' || typeof context.expiresAt !== 'number' || !Number.isFinite(context.expiresAt) || context.expiresAt <= Date.now()) continue;
      resolved.push({ name: context.name, markdown: context.markdown });
    } catch { /* Invalid, expired, missing or unsafe references resolve to nothing. */ }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  return resolved;
}

import { mkdirSync, lstatSync, realpathSync, openSync, closeSync, fstatSync, readFileSync, writeFileSync, ftruncateSync, writeSync, unlinkSync, constants } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

type StoredDocumentContext = { name: string; markdown: string; expiresAt: number };
const contextDirectory = join(tmpdir(), `seudaily-document-context-${process.getuid?.() ?? 'user'}`);
const pendingLifetimeMs = 10 * 60 * 1000;
const consumedLifetimeMs = 24 * 60 * 60 * 1000;
const validRef = (ref: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref);

// Never follow caller-controlled symlinks or truncate a file before checking its ownership.
function openContext(ref: string, create = false) {
  if (!validRef(ref)) throw new Error('文档引用格式无效');
  mkdirSync(contextDirectory, { recursive: true, mode: 0o700 });
  const directory = lstatSync(contextDirectory);
  const uid = process.getuid?.();
  if (!directory.isDirectory() || (uid !== undefined && (directory.uid !== uid || (directory.mode & 0o077) !== 0))) throw new Error('文档暂存目录不安全');
  const path = join(realpathSync(contextDirectory), `${ref}.json`);
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

const cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
function scheduleCleanup(ref: string, delay: number) {
  const previous = cleanupTimers.get(ref);
  if (previous) clearTimeout(previous);
  const timer = setTimeout(() => {
    cleanupTimers.delete(ref);
    let fd: number | undefined;
    try {
      fd = openContext(ref);
      const path = join(realpathSync(contextDirectory), `${ref}.json`);
      const opened = fstatSync(fd), current = lstatSync(path);
      if (current.isFile() && current.ino === opened.ino && current.dev === opened.dev) unlinkSync(path);
    } catch { /* Cleanup never follows or removes an unvalidated external file. */ }
    finally { if (fd !== undefined) closeSync(fd); }
  }, delay);
  timer.unref();
  cleanupTimers.set(ref, timer);
}

export function storeDocumentContext(ref: string, name: string, markdown: string) {
  const fd = openContext(ref, true);
  try { writeFileSync(fd, JSON.stringify({ name, markdown, expiresAt: Date.now() + pendingLifetimeMs }), 'utf8'); }
  finally { closeSync(fd); }
  scheduleCleanup(ref, pendingLifetimeMs);
}

export function resolveDocumentContexts(refs: unknown) {
  if (!Array.isArray(refs)) return [];
  const resolved: Array<{ name: string; markdown: string }> = [];
  for (const value of refs.slice(0, 4)) {
    if (typeof value !== 'string') continue;
    let fd: number | undefined;
    try {
      fd = openContext(value);
      const context = JSON.parse(readFileSync(fd, 'utf8')) as StoredDocumentContext;
      if (!context || typeof context.name !== 'string' || typeof context.markdown !== 'string' || typeof context.expiresAt !== 'number' || !Number.isFinite(context.expiresAt) || context.expiresAt <= Date.now()) continue;
      // Positioned write preserves the descriptor's identity even if the pathname changes.
      const bytes = Buffer.from(JSON.stringify({ ...context, expiresAt: Date.now() + consumedLifetimeMs }));
      writeSync(fd, bytes, 0, bytes.length, 0);
      ftruncateSync(fd, bytes.length);
      resolved.push({ name: context.name, markdown: context.markdown });
      scheduleCleanup(value, consumedLifetimeMs);
    } catch { /* Invalid, expired, missing or unsafe references resolve to nothing. */ }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  return resolved;
}

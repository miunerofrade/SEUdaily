import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

type DocumentContext = {
  name: string;
  markdown: string;
  expiresAt: number;
  cleanupTimer?: ReturnType<typeof setTimeout>;
};

type StoredDocumentContext = Omit<DocumentContext, "cleanupTimer">;

const documentContexts = new Map<string, DocumentContext>();
const contextDirectory = join(tmpdir(), "cvstream-document-context");
const pendingLifetimeMs = 10 * 60 * 1000;
const consumedLifetimeMs = 24 * 60 * 60 * 1000;

function contextPath(ref: string) {
  return join(contextDirectory, `${ref}.json`);
}

function scheduleCleanup(ref: string, delay: number) {
  const timer = setTimeout(() => {
    documentContexts.delete(ref);
    try {
      unlinkSync(contextPath(ref));
    } catch {
      // The file may already have been removed by a later cleanup.
    }
  }, delay);
  timer.unref?.();
  return timer;
}

function cacheContext(ref: string, context: StoredDocumentContext) {
  const existing = documentContexts.get(ref);
  if (existing?.cleanupTimer) clearTimeout(existing.cleanupTimer);
  documentContexts.set(ref, { ...context, cleanupTimer: scheduleCleanup(ref, Math.max(0, context.expiresAt - Date.now())) });
}

export function storeDocumentContext(ref: string, name: string, markdown: string) {
  mkdirSync(contextDirectory, { recursive: true });
  const context: StoredDocumentContext = { name, markdown, expiresAt: Date.now() + pendingLifetimeMs };
  // Keep this outside the conversation payload. The file is only an internal,
  // short-lived handoff between upload and the following agent request.
  writeFileSync(contextPath(ref), JSON.stringify(context), "utf8");
  cacheContext(ref, context);
}

function loadContext(ref: string): StoredDocumentContext | undefined {
  const cached = documentContexts.get(ref);
  if (cached && cached.expiresAt > Date.now()) return cached;
  try {
    const context = JSON.parse(readFileSync(contextPath(ref), "utf8")) as StoredDocumentContext;
    if (!context || typeof context.name !== "string" || typeof context.markdown !== "string" || context.expiresAt <= Date.now()) {
      unlinkSync(contextPath(ref));
      return undefined;
    }
    cacheContext(ref, context);
    return context;
  } catch {
    return undefined;
  }
}

export function resolveDocumentContexts(refs: unknown) {
  if (!Array.isArray(refs)) return [];
  const resolved: Array<{ name: string; markdown: string }> = [];
  for (const value of refs.slice(0, 4)) {
    if (typeof value !== "string") continue;
    const context = loadContext(value);
    if (!context) continue;
    resolved.push({ name: context.name, markdown: context.markdown });
    const consumed: StoredDocumentContext = { ...context, expiresAt: Date.now() + consumedLifetimeMs };
    cacheContext(value, consumed);
    writeFileSync(contextPath(value), JSON.stringify(consumed), "utf8");
  }
  return resolved;
}

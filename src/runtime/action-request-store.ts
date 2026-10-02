import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { projectRoot } from "./runtime-paths.js";

export type ActionRequestKind = "create-focus" | "modify-schedule";
export type ActionRequestStatus = "pending" | "activated" | "executing" | "consumed" | "failed" | "expired";

export type StoredActionRequest = {
  id: string;
  kind: ActionRequestKind;
  text: string;
  payload: Record<string, unknown>;
  status: ActionRequestStatus;
  createdAt: string;
  expiresAt: string;
  activatedAt?: string;
  executingAt?: string;
  consumedAt?: string;
  failedAt?: string;
  attemptId?: string;
  attempts: number;
  error?: string;
  result?: unknown;
};

type ActionRequestState = { version: 2; requests: StoredActionRequest[] };

const statePath = resolve(projectRoot, ".seudaily", "action-requests.json");
const maximumAttempts = 3;
let operation = Promise.resolve();

function normalizeRequest(value: Partial<StoredActionRequest>): StoredActionRequest | null {
  if (!value.id || !value.kind || !value.text || !value.payload || !value.createdAt || !value.expiresAt) return null;
  return {
    ...value,
    id: value.id,
    kind: value.kind,
    text: value.text,
    payload: value.payload,
    status: value.status ?? "pending",
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    attempts: Number.isInteger(value.attempts) ? Number(value.attempts) : value.status === "consumed" ? 1 : 0,
  };
}

async function loadState(): Promise<ActionRequestState> {
  try {
    const parsed = JSON.parse(await readFile(statePath, "utf8")) as { requests?: Array<Partial<StoredActionRequest>> };
    if (Array.isArray(parsed.requests)) {
      return { version: 2, requests: parsed.requests.map(normalizeRequest).filter((item): item is StoredActionRequest => Boolean(item)) };
    }
  } catch {
    // Missing or malformed state starts clean.
  }
  return { version: 2, requests: [] };
}

async function saveState(state: ActionRequestState) {
  await mkdir(dirname(statePath), { recursive: true });
  const temporary = `${statePath}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(state, null, 2), "utf8");
  await rename(temporary, statePath);
}

function serialized<T>(task: () => Promise<T>): Promise<T> {
  const result = operation.then(task, task);
  operation = result.then(() => undefined, () => undefined);
  return result;
}

function expireRequest(request: StoredActionRequest) {
  if (request.status !== "consumed" && Date.parse(request.expiresAt) <= Date.now()) request.status = "expired";
}

function prune(state: ActionRequestState) {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const request of state.requests) expireRequest(request);
  state.requests = state.requests.filter((request) => {
    const finishedAt = request.consumedAt ?? request.failedAt ?? request.expiresAt;
    return !["consumed", "expired"].includes(request.status) || Date.parse(finishedAt) > cutoff;
  });
}

export async function issueActionRequest(kind: ActionRequestKind, text: string, payload: Record<string, unknown>) {
  return serialized(async () => {
    const state = await loadState();
    prune(state);
    const now = new Date();
    const request: StoredActionRequest = {
      id: `action-${randomUUID()}`,
      kind,
      text,
      payload,
      status: "pending",
      attempts: 0,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 30 * 60 * 1000).toISOString(),
    };
    state.requests.push(request);
    await saveState(state);
    return { id: request.id, kind: request.kind, text: request.text, expiresAt: request.expiresAt };
  });
}

export async function activateActionRequest(id: string) {
  return serialized(async () => {
    const state = await loadState();
    const request = state.requests.find((item) => item.id === id);
    if (!request) throw new Error("操作请求不存在或已清理，请让 Agent 重新生成");
    expireRequest(request);
    if (request.status === "expired") { await saveState(state); throw new Error("操作请求已过期，请让 Agent 重新生成"); }
    if (request.status === "consumed") return { id: request.id, kind: request.kind, text: request.text, status: request.status };
    if (request.status === "executing") throw new Error("操作正在执行，请勿重复提交");
    request.status = "activated";
    request.activatedAt = new Date().toISOString();
    await saveState(state);
    return { id: request.id, kind: request.kind, text: request.text, status: request.status };
  });
}

export async function claimActionRequest(id: string) {
  return serialized(async () => {
    const state = await loadState();
    const request = state.requests.find((item) => item.id === id);
    if (!request) throw new Error("操作请求不存在或已失效");
    expireRequest(request);
    if (request.status === "expired") { await saveState(state); throw new Error("操作请求已过期，请重新请求"); }
    if (request.status === "consumed") return { state: "consumed" as const, request };
    if (request.status === "executing") {
      const stale = Date.now() - Date.parse(request.executingAt ?? request.createdAt) > 5 * 60 * 1_000;
      if (!stale) return { state: "executing" as const, request };
      request.status = "failed";
      request.failedAt = new Date().toISOString();
      request.error = "上一次执行在服务重启或超时后未完成，已允许重试";
    }
    if (request.status === "failed" && request.attempts >= maximumAttempts) throw new Error(`操作已失败 ${maximumAttempts} 次，请重新生成请求`);
    request.status = "executing";
    request.attempts += 1;
    request.attemptId = `attempt-${randomUUID()}`;
    request.executingAt = new Date().toISOString();
    request.error = undefined;
    await saveState(state);
    return { state: "claimed" as const, request };
  });
}

export async function completeActionRequest(id: string, attemptId: string, result: unknown) {
  return serialized(async () => {
    const state = await loadState();
    const request = state.requests.find((item) => item.id === id);
    if (!request || request.status !== "executing" || request.attemptId !== attemptId) throw new Error("操作请求执行状态已变更");
    request.status = "consumed";
    request.consumedAt = new Date().toISOString();
    request.result = result;
    await saveState(state);
    return request;
  });
}

export async function failActionRequest(id: string, attemptId: string, error: unknown) {
  return serialized(async () => {
    const state = await loadState();
    const request = state.requests.find((item) => item.id === id);
    if (!request || request.status !== "executing" || request.attemptId !== attemptId) return request;
    request.status = "failed";
    request.failedAt = new Date().toISOString();
    request.error = error instanceof Error ? error.message : String(error);
    await saveState(state);
    return request;
  });
}

// Compatibility for old persisted action messages. New code uses claim/complete/fail.
export async function consumeActionRequest(id: string, expectedKind: ActionRequestKind) {
  const claim = await claimActionRequest(id);
  if (claim.request.kind !== expectedKind) throw new Error("操作请求类型不匹配");
  if (claim.state !== "claimed") throw new Error(claim.state === "consumed" ? "该操作请求已经使用" : "操作正在执行");
  return claim.request.payload;
}

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { projectRoot } from "./runtime-paths.js";

export type ActionRequestKind = "create-focus" | "modify-schedule";

type StoredActionRequest = {
  id: string;
  kind: ActionRequestKind;
  text: string;
  payload: Record<string, unknown>;
  status: "pending" | "activated" | "consumed";
  createdAt: string;
  expiresAt: string;
  activatedAt?: string;
  consumedAt?: string;
};

type ActionRequestState = { version: 1; requests: StoredActionRequest[] };

const statePath = resolve(projectRoot, ".cvstream", "action-requests.json");
let operation = Promise.resolve();

async function loadState(): Promise<ActionRequestState> {
  try {
    const parsed = JSON.parse(await readFile(statePath, "utf8")) as Partial<ActionRequestState>;
    if (parsed.version === 1 && Array.isArray(parsed.requests)) {
      return { version: 1, requests: parsed.requests as StoredActionRequest[] };
    }
  } catch {
    // Missing or malformed state starts clean.
  }
  return { version: 1, requests: [] };
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

function prune(state: ActionRequestState) {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  state.requests = state.requests.filter((request) => (
    request.status !== "consumed" || Date.parse(request.consumedAt ?? request.createdAt) > cutoff
  ));
}

export async function issueActionRequest(
  kind: ActionRequestKind,
  text: string,
  payload: Record<string, unknown>,
) {
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
    if (Date.parse(request.expiresAt) <= Date.now()) throw new Error("操作请求已过期，请让 Agent 重新生成");
    if (request.status === "consumed") throw new Error("该操作已经执行，不能重复提交");
    request.status = "activated";
    request.activatedAt = new Date().toISOString();
    await saveState(state);
    return { id: request.id, kind: request.kind, text: request.text };
  });
}

export async function consumeActionRequest(id: string, expectedKind: ActionRequestKind) {
  return serialized(async () => {
    const state = await loadState();
    const request = state.requests.find((item) => item.id === id);
    if (!request) throw new Error("操作请求不存在或已失效");
    if (request.kind !== expectedKind) throw new Error("操作请求类型不匹配");
    if (Date.parse(request.expiresAt) <= Date.now()) throw new Error("操作请求已过期，请重新请求");
    if (request.status !== "activated") {
      throw new Error(request.status === "consumed" ? "该操作请求已经使用" : "该操作请求尚未授权");
    }
    request.status = "consumed";
    request.consumedAt = new Date().toISOString();
    await saveState(state);
    return request.payload;
  });
}

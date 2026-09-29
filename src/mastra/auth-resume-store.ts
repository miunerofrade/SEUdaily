import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { projectRoot } from "./runtime-paths.js";
import { runPythonTool } from "./tools/python-bridge.js";
import { compactToolResultForModel, type ToolResult } from "./tools/tool-result.js";

export type AuthTarget = "schedule" | "course";
type AuthResumeStatus = "pending" | "authorizing" | "completed" | "failed" | "expired";
type AuthResume = {
  id: string;
  target: AuthTarget;
  action: string;
  payload: Record<string, unknown>;
  namespace: string;
  threadId: string;
  status: AuthResumeStatus;
  attempts: number;
  createdAt: string;
  authorizingAt?: string;
  expiresAt: string;
  result?: ToolResult;
  error?: string;
};
type State = { version: 1; resumes: AuthResume[] };

const statePath = resolve(projectRoot, ".seudaily", "auth-resumes.json");
const liveResults = new Map<string, { result: ToolResult; threadId: string }>();
let operation = Promise.resolve();

async function load(): Promise<State> {
  try {
    const value = JSON.parse(await readFile(statePath, "utf8")) as State;
    if (value.version === 1 && Array.isArray(value.resumes)) return value;
  } catch { /* missing state */ }
  return { version: 1, resumes: [] };
}

async function save(state: State) {
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

function expire(item: AuthResume) {
  if (item.status !== "completed" && Date.parse(item.expiresAt) <= Date.now()) item.status = "expired";
}

export async function issueAuthResume(input: Pick<AuthResume, "target" | "action" | "payload" | "namespace" | "threadId">) {
  return serialized(async () => {
    const state = await load();
    const now = new Date();
    const item: AuthResume = {
      ...input,
      id: `auth-${randomUUID()}`,
      status: "pending",
      attempts: 0,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 30 * 60 * 1_000).toISOString(),
    };
    state.resumes = state.resumes.filter((entry) => Date.parse(entry.expiresAt) > Date.now() || entry.status === "completed").slice(-100);
    state.resumes.push(item);
    await save(state);
    return { id: item.id, target: item.target, expiresAt: item.expiresAt, text: item.target === "schedule" ? "登录课表系统并继续" : "登录课程平台并继续" };
  });
}

export async function executeAuthResume(id: string) {
  const claim = await serialized(async () => {
    const state = await load();
    const item = state.resumes.find((entry) => entry.id === id);
    if (!item) throw new Error("登录续接请求不存在");
    expire(item);
    if (item.status === "expired") { await save(state); throw new Error("登录续接请求已过期"); }
    if (item.status === "completed") return { state: "completed" as const, item };
    if (item.status === "authorizing") {
      const stale = Date.now() - Date.parse(item.authorizingAt ?? item.createdAt) > 6 * 60 * 1_000;
      if (!stale) return { state: "authorizing" as const, item };
      item.status = "failed";
      item.error = "上一次登录在服务重启或超时后未完成，已允许重试";
    }
    if (item.attempts >= 3) throw new Error("登录续接已失败 3 次，请重新发起任务");
    item.status = "authorizing";
    item.authorizingAt = new Date().toISOString();
    item.attempts += 1;
    item.error = undefined;
    await save(state);
    return { state: "claimed" as const, item };
  });
  if (claim.state === "completed") {
    if (claim.item.result) liveResults.set(id, { result: claim.item.result, threadId: claim.item.threadId });
    return claim.item;
  }
  if (claim.state === "authorizing") throw new Error("登录正在进行，请勿重复提交");
  try {
    const authorization = await runPythonTool<ToolResult>(claim.item.target === "schedule" ? "authorize-schedule" : "authorize", {
      ...claim.item.payload,
      timeoutSeconds: 300,
      resetSession: true,
    });
    if (authorization.status !== "completed") throw new Error(authorization.summary || "登录未完成");
    const result = await runPythonTool<ToolResult>(claim.item.action, claim.item.payload);
    if (result.status === "auth_required" || result.status === "failed" || result.status === "cancelled") throw new Error(result.summary || "原工具重试失败");
    await serialized(async () => {
      const state = await load();
      const item = state.resumes.find((entry) => entry.id === id);
      if (!item) throw new Error("登录续接请求已丢失");
      item.status = "completed";
      item.result = result;
      await save(state);
    });
    liveResults.set(id, { result, threadId: claim.item.threadId });
    return { ...claim.item, status: "completed" as const, result };
  } catch (error) {
    await serialized(async () => {
      const state = await load();
      const item = state.resumes.find((entry) => entry.id === id);
      if (item) { item.status = "failed"; item.error = error instanceof Error ? error.message : String(error); await save(state); }
    });
    throw error;
  }
}

export function authResumeContext(id: unknown, threadId: unknown) {
  if (typeof id !== "string") return "";
  const entry = liveResults.get(id);
  if (!entry || entry.threadId !== String(threadId ?? "")) return "";
  return compactToolResultForModel(entry.result).value;
}

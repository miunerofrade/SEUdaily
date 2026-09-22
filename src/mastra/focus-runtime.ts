import { readFile } from "node:fs/promises";

import { seuDailyAgent } from "./agents/course-agent.js";
import { runPythonTool } from "./tools/python-bridge.js";
import type { ToolResult } from "./tools/tool-result.js";

type RuntimeState = { timer?: NodeJS.Timeout; running: boolean; version: 4 };
export type FocusAgentItem = {
  id: string;
  kind: "notice" | "course";
  title: string;
  description?: string;
  enabled?: boolean;
  threadId: string;
  resourceId: string;
};
type CourseQueueAlert = { jobKey: string; focus: FocusAgentItem; message: string };
type CourseQueueResult = {
  attempted?: number;
  agentAlerts?: CourseQueueAlert[];
  warnings?: string[];
};

const runtimeKey = Symbol.for("seudaily.focus-runtime");
const globalRuntime = globalThis as typeof globalThis & { [runtimeKey]?: RuntimeState };
const TWO_HOURS_MS = 2 * 60 * 60 * 1_000;

async function fullData<T>(result: ToolResult): Promise<T> {
  if (result.resultRef) {
    const stored = JSON.parse(await readFile(result.resultRef, "utf8")) as { data?: T };
    if (stored.data) return stored.data;
  }
  return result.data as T;
}

function scheduledPrompt(focus: FocusAgentItem): string {
  const cadence = focus.kind === "course" ? "这是每日课程 Focus 检查。" : "这是每两小时通知 Focus 检查。";
  return [
    `[Focus 定时触发｜${focus.title}]`,
    cadence,
    "请延续本会话已经确认的关注目标，主动调用合适的现有工具检查是否出现值得汇报的新内容。",
    "避免重复汇报本会话已经报告过的结果；没有实质变化时明确简短说明。",
    focus.description ? `初始关注描述：${focus.description}` : "",
  ].filter(Boolean).join("\n");
}

async function generateFocusAgentMessage(focus: FocusAgentItem, message: string): Promise<string> {
  const output = await seuDailyAgent.generate(message, {
    memory: { thread: focus.threadId, resource: focus.resourceId },
  });
  return output.text;
}

async function recordFocusAgentRun(
  focusId: string,
  runId: string | undefined,
  status: "completed" | "failed",
  message: string,
): Promise<void> {
  await runPythonTool("record-focus-agent-run", {
    focusId,
    runId,
    runStatus: status,
    message,
  });
}

export async function sendFocusAgentMessage(focus: FocusAgentItem, message: string): Promise<string> {
  const claim = await runPythonTool<ToolResult>("claim-focus-agent-run", {
    focusId: focus.id,
    respectInterval: false,
  });
  const claimed = await fullData<{
    claimed?: boolean;
    reason?: string;
    runId?: string;
    item?: FocusAgentItem;
  }>(claim);
  if (!claimed.claimed || !claimed.item) {
    throw new Error(claimed.reason === "running" ? "这个 Focus 正在执行，请稍后再发送" : "当前无法继续这个 Focus");
  }
  try {
    const response = await generateFocusAgentMessage(claimed.item, message);
    await recordFocusAgentRun(focus.id, claimed.runId, "completed", response);
    return response;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await recordFocusAgentRun(focus.id, claimed.runId, "failed", errorMessage);
    throw error;
  }
}

export async function runFocusAgentCycle(
  options: { force?: boolean; focusId?: string; prompt?: string } = {},
): Promise<void> {
  const listed = await runPythonTool<ToolResult>("list-focus", {});
  const data = await fullData<{ items?: FocusAgentItem[] }>(listed);
  const items = (data.items ?? []).filter(
    (item) => item.kind === "notice"
      && item.enabled !== false
      && (!options.focusId || item.id === options.focusId),
  );
  for (const item of items) {
    const claim = await runPythonTool<ToolResult>("claim-focus-agent-run", {
      focusId: item.id,
      force: options.force ?? false,
    });
    const claimed = await fullData<{ claimed?: boolean; runId?: string; item?: FocusAgentItem }>(claim);
    if (!claimed.claimed || !claimed.item) continue;
    try {
      const response = await generateFocusAgentMessage(
        claimed.item,
        options.prompt ?? scheduledPrompt(claimed.item),
      );
      await recordFocusAgentRun(item.id, claimed.runId, "completed", response);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await recordFocusAgentRun(item.id, claimed.runId, "failed", message);
    }
  }
}

export async function runCourseFocusQueue(): Promise<CourseQueueResult> {
  const result = await runPythonTool<ToolResult>("run-course-focus-queue", {});
  const data = await fullData<CourseQueueResult>(result);
  for (const alert of data.agentAlerts ?? []) {
    try {
      await generateFocusAgentMessage(
        alert.focus,
        [
          `[课程关注异常｜${alert.focus.title}]`,
          alert.message,
          "这是课程队列的系统异常通知。请在本会话中明确告知用户关注已暂停、连续失败的原因和建议检查项。不要自行继续抓取，等待用户恢复关注后再执行。",
        ].join("\n"),
      );
      await runPythonTool("acknowledge-course-focus-alert", { jobKey: alert.jobKey });
    } catch (error) {
      console.error("Failed to notify Focus Agent about paused course queue", error);
    }
  }
  return data;
}

function scheduleNext(state: RuntimeState, delayMs: number): void {
  state.timer = setTimeout(() => void runCycle(state), Math.max(1_000, delayMs));
  state.timer.unref();
}

async function runCycle(state: RuntimeState): Promise<void> {
  if (state.running) {
    scheduleNext(state, 60_000);
    return;
  }
  state.running = true;
  let nextDelay = TWO_HOURS_MS;
  try {
    await runCourseFocusQueue();
  } catch (error) {
    console.error("SEUdaily course Focus queue failed", error);
    nextDelay = 5 * 60 * 1_000;
  }
  try {
    await runFocusAgentCycle();
  } catch (error) {
    console.error("SEUdaily notice Focus cycle failed", error);
    nextDelay = 5 * 60 * 1_000;
  } finally {
    state.running = false;
    scheduleNext(state, nextDelay);
  }
}

export function startFocusRuntime(): void {
  const previous = globalRuntime[runtimeKey];
  if (previous?.timer && previous.version === 4) return;
  if (previous?.timer) clearTimeout(previous.timer);
  const state: RuntimeState = { running: false, version: 4 };
  globalRuntime[runtimeKey] = state;
  scheduleNext(state, 1_000);
}

import { terminateProcessTree } from '../process-tree.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

import { envValue, projectRoot } from "../runtime-paths.js";
import type { ToolResult } from "./tool-result.js";

type WorkerMessage<T> =
  | { requestId: string; type: "result"; result: T }
  | { requestId: string; type: "error"; error: string; errorType?: string };

type PendingRequest<T> = {
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
  timeout: NodeJS.Timeout;
  cleanup?: () => void;
};

export class PythonWorkerClient {
  constructor(private launch?: {command:string;args:string[];cwd:string;env?:NodeJS.ProcessEnv}) {}
  private child?: ChildProcessWithoutNullStreams;
  private closing?: Promise<void>;
  get hasWorker() { return Boolean(this.child); }
  private pending = new Map<string, PendingRequest<unknown>>();
  private stderrTail = "";

  private starting?: Promise<ChildProcessWithoutNullStreams>;
  private ensureWorker(): Promise<ChildProcessWithoutNullStreams> {
    return this.starting ??= this.startWorker().finally(() => { this.starting = undefined; });
  }

  private async startWorker(): Promise<ChildProcessWithoutNullStreams> {
    if (this.child && this.child.exitCode === null && !this.child.killed) return this.child;
    // exitCode can change before close; settle the old generation before replacing it.
    if (this.child) this.failAll(new Error(`SEUdaily worker is no longer running (exit code ${this.child.exitCode}); restarting`));

    const managed = !!process.env.SEUDAILY_INSTALL_ROOT;
    const command = this.launch?.command ?? (managed ? await (await import("../../distribution/components.js")).ensurePython() : "uv");
    const args = this.launch?.args ?? (managed ? ["-m", "seudaily.worker"] : ["run", "seudaily-worker"]);
    const child = spawn(command, args, {
      cwd: this.launch?.cwd ?? projectRoot,
      env: {
        ...process.env,
        ...this.launch?.env,
        SEUDAILY_PROJECT_ROOT: projectRoot,
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    this.child = child;
    this.stderrTail = "";

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-16_000);
    });
    createInterface({ input: child.stdout }).on("line", (line) => this.handleLine(line));
    child.stdin.on("error", (error) => { if (this.child === child) this.failAll(error); });
    child.on("error", (error) => { if (this.child === child) this.failAll(error); });
    child.on("close", (code) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.failAll(
        new Error(
          `SEUdaily worker exited with code ${code}.${this.stderrTail ? `\n${this.stderrTail}` : ""}`,
        ),
      );
    });
    return child;
  }

  private handleLine(line: string): void {
    let message: WorkerMessage<unknown>;
    try {
      message = JSON.parse(line) as WorkerMessage<unknown>;
    } catch {
      this.stderrTail = `${this.stderrTail}\nInvalid worker output: ${line}`.slice(-16_000);
      return;
    }
    const pending = this.takeRequest(message.requestId);
    if (!pending) return;
    if (message.type === "error") pending.reject(new Error(message.error));
    else pending.resolve(message.result);
  }

  private takeRequest(requestId: string) {
    const pending = this.pending.get(requestId);
    if (pending) {
      this.pending.delete(requestId);
      clearTimeout(pending.timeout);
      pending.cleanup?.();
    }
    return pending;
  }

  private failAll(error: Error): void {
    for (const requestId of this.pending.keys()) this.takeRequest(requestId)?.reject(error);
  }

  private async terminateWorkerTree(): Promise<void> {
    const child = this.child;
    if (!child?.pid) return;
    await terminateProcessTree(child.pid);
  }

  async terminate(): Promise<void> {
    return this.closing ??= (async () => {
      await this.starting?.catch(() => {});
      const child = this.child;
      if (!child || child.exitCode !== null) return;
      const ended = new Promise<void>(resolve => child.once("close", () => resolve()));
      await this.terminateWorkerTree();
      await ended;
    })();
  }

  async close(): Promise<void> {
    await this.starting?.catch(() => {});
    const child = this.child;
    if (!child) return;
    for (const requestId of this.pending.keys()) {
      if (!child.stdin.destroyed && child.stdin.writable) {
        child.stdin.write(`${JSON.stringify({ requestId, type: "cancel" })}\n`, () => {});
      }
    }
    this.failAll(new Error('SEUdaily worker is shutting down'));
    const ended = new Promise<void>(resolve => child.once('close', () => resolve()));
    child.stdin.end();
    const fallback = setTimeout(() => void this.terminateWorkerTree().catch(error => this.failAll(error)), 10_000);
    await ended;
    clearTimeout(fallback);
  }

  async call<T>(action: string, payload: Record<string, unknown>, abortSignal?: AbortSignal, isolated = false): Promise<T> {
    if (abortSignal?.aborted) {
      const error = new Error(`Python tool cancelled: ${action}`);
      error.name = "AbortError";
      return Promise.reject(error);
    }
    const child = await this.ensureWorker();
    const requestId = randomUUID();
    const taskId = `task-${randomUUID()}`;

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => cancel(new Error(`Python tool timed out: ${action}`)), 30 * 60 * 1000);

      const pending: PendingRequest<T> = { resolve, reject, timeout };
      this.pending.set(requestId, pending as PendingRequest<unknown>);

      const cancel = (error: Error) => {
        if (!this.takeRequest(requestId)) return;
        // Cancellation belongs to this request. Killing the shared worker here
        // would also discard unrelated queued requests and skip resource cleanup.
        if (!child.stdin.destroyed && child.stdin.writable) {
          child.stdin.write(`${JSON.stringify({ requestId, type: "cancel" })}\n`, () => {});
        }
        if (isolated) void this.terminate().then(() => reject(error), reject);
        else reject(error);
      };
      const abort = () => {
        const error = new Error(`Python tool cancelled: ${action}`);
        error.name = "AbortError";
        cancel(error);
      };

      if (abortSignal?.aborted) {
        abort();
        return;
      }
      abortSignal?.addEventListener("abort", abort, { once: true });
      pending.cleanup = () => abortSignal?.removeEventListener("abort", abort);
      child.stdin.write(`${JSON.stringify({ requestId, taskId, action, payload })}\n`, (error) => {
        if (error) this.takeRequest(requestId)?.reject(error);
      });
    });
  }
}

const workerClient = new PythonWorkerClient();
// Agent requests get a worker of their own. Killing a cancelled task must not
// kill the service worker that owns the VPN or another conversation's work.
const taskWorkers = new Map<AbortSignal, PythonWorkerClient>();
const taskScratch = new Map<AbortSignal,string>();
const serviceAction = (action: string) => action.startsWith('vpn-') || /^(health|ramdisk-status|mount-ramdisk|unmount-ramdisk|reveal-ramdisk)$/.test(action);
export async function releasePythonTask(signal: AbortSignal) {
  const worker = taskWorkers.get(signal);
  if (!worker) return;
  taskWorkers.delete(signal);
  try { await worker.close(); } finally {
    const scratch = taskScratch.get(signal); taskScratch.delete(signal);
    if (scratch) await rm(scratch,{recursive:true,force:true});
  }
}

export async function runPythonTool<T = ToolResult>(
  action: string,
  payload: Record<string, unknown>,
  abortSignal?: AbortSignal,
): Promise<T> {
  if (action === 'unmount-ramdisk' && taskScratch.size) {
    const disk: any = await workerClient.call('ramdisk-status', {}, abortSignal);
    if (disk?.path && [...taskScratch.values()].some(path => {
      const child = relative(disk.path, path);
      return child !== '..' && !child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(child);
    }))
      throw new Error('内存盘正在处理任务，请等待任务完成或取消后再卸载');
  }
  if (!abortSignal || serviceAction(action)) return workerClient.call<T>(action, payload, abortSignal);
  abortSignal.throwIfAborted();
  let worker = taskWorkers.get(abortSignal);
  if (!worker) {
    const disk: any = workerClient.hasWorker ? await workerClient.call('ramdisk-status', {}, abortSignal) : undefined;
    let shared = disk?.path;
    if (!shared && process.platform !== 'win32' && /^(1|true|yes|on)$/i.test(envValue('SEUDAILY_RAMDISK_ENABLED', 'false') ?? '')) {
      const mounted: any = await workerClient.call('mount-ramdisk', {size:envValue('SEUDAILY_RAMDISK_SIZE','1G')}, abortSignal);
      shared = mounted.data?.path;
    }
    const command = !!process.env.SEUDAILY_INSTALL_ROOT ? await (await import('../../distribution/components.js')).ensurePython() : 'uv';
    abortSignal.throwIfAborted();
    const scratch = await mkdtemp(join(shared || tmpdir(), 'seudaily-task-'));
    if (abortSignal.aborted) { await rm(scratch,{recursive:true,force:true}); abortSignal.throwIfAborted(); }
    worker = new PythonWorkerClient({command,args:!!process.env.SEUDAILY_INSTALL_ROOT ? ['-m','seudaily.worker'] : ['run','seudaily-worker'],cwd:projectRoot,env:{TMPDIR:scratch,TMP:scratch,TEMP:scratch,SEUDAILY_TASK_WORKSPACE:scratch}});
    taskScratch.set(abortSignal,scratch);
    taskWorkers.set(abortSignal, worker);
  }
  return worker.call<T>(action, payload, abortSignal, true);
}

export async function closePythonWorker() { await Promise.all([workerClient.close(), ...[...taskWorkers.values()].map(worker => worker.terminate())]); taskWorkers.clear(); await Promise.all([...taskScratch.values()].map(path=>rm(path,{recursive:true,force:true})));taskScratch.clear(); }

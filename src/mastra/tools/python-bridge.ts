import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

import { projectRoot } from "../runtime-paths.js";
import type { ToolResult } from "./tool-result.js";

type WorkerMessage<T> =
  | { requestId: string; type: "result"; result: T }
  | { requestId: string; type: "error"; error: string; errorType?: string };

type PendingRequest<T> = {
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
  timeout: NodeJS.Timeout;
  cancelFallback?: NodeJS.Timeout;
  settled: boolean;
  cleanup?: () => void;
};

class PythonWorkerClient {
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<string, PendingRequest<unknown>>();
  private stderrTail = "";

  private ensureWorker(): ChildProcessWithoutNullStreams {
    if (this.child && this.child.exitCode === null && !this.child.killed) return this.child;

    const child = spawn("uv", ["run", "cvstream-worker"], {
      cwd: projectRoot,
      env: {
        ...process.env,
        CVSTREAM_PROJECT_ROOT: projectRoot,
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    this.stderrTail = "";

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-16_000);
    });
    createInterface({ input: child.stdout }).on("line", (line) => this.handleLine(line));
    child.on("error", (error) => this.failAll(error));
    child.on("close", (code) => {
      if (this.child === child) this.child = undefined;
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
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId);
    clearTimeout(pending.timeout);
    if (pending.cancelFallback) clearTimeout(pending.cancelFallback);
    pending.cleanup?.();
    if (pending.settled) return;
    pending.settled = true;
    if (message.type === "error") pending.reject(new Error(message.error));
    else pending.resolve(message.result);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      if (pending.cancelFallback) clearTimeout(pending.cancelFallback);
      pending.cleanup?.();
      if (!pending.settled) pending.reject(error);
    }
    this.pending.clear();
  }

  private terminateWorkerTree(): void {
    const child = this.child;
    if (!child?.pid) return;
    if (process.platform === "win32") {
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } else {
      child.kill("SIGKILL");
    }
  }

  call<T>(action: string, payload: Record<string, unknown>, abortSignal?: AbortSignal): Promise<T> {
    const child = this.ensureWorker();
    const requestId = randomUUID();
    const taskId = `task-${randomUUID()}`;

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.stdin.write(`${JSON.stringify({ requestId, type: "cancel" })}\n`);
        const current = this.pending.get(requestId);
        if (current && !current.settled) {
          current.settled = true;
          current.reject(new Error(`Python tool timed out: ${action}`));
          current.cancelFallback = setTimeout(() => this.terminateWorkerTree(), 5_000);
        }
      }, 30 * 60 * 1000);

      const pending: PendingRequest<T> = { resolve, reject, timeout, settled: false };
      this.pending.set(requestId, pending as PendingRequest<unknown>);

      const abort = () => {
        child.stdin.write(`${JSON.stringify({ requestId, type: "cancel" })}\n`);
        if (!pending.settled) {
          pending.settled = true;
          const error = new Error(`Python tool cancelled: ${action}`);
          error.name = "AbortError";
          reject(error);
          pending.cancelFallback = setTimeout(() => {
            if (this.pending.has(requestId)) this.terminateWorkerTree();
          }, 5_000);
        }
      };

      if (abortSignal?.aborted) {
        abort();
        return;
      }
      abortSignal?.addEventListener("abort", abort, { once: true });
      pending.cleanup = () => abortSignal?.removeEventListener("abort", abort);
      child.stdin.write(`${JSON.stringify({ requestId, taskId, action, payload })}\n`, (error) => {
        if (error && !pending.settled) {
          pending.settled = true;
          this.pending.delete(requestId);
          clearTimeout(timeout);
          pending.cleanup?.();
          reject(error);
        }
      });
    });
  }
}

const workerClient = new PythonWorkerClient();

export async function runPythonTool<T = ToolResult>(
  action: string,
  payload: Record<string, unknown>,
  abortSignal?: AbortSignal,
): Promise<T> {
  return workerClient.call<T>(action, payload, abortSignal);
}

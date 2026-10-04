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
  cleanup?: () => void;
};

class PythonWorkerClient {
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<string, PendingRequest<unknown>>();
  private stderrTail = "";

  private ensureWorker(): ChildProcessWithoutNullStreams {
    if (this.child && this.child.exitCode === null && !this.child.killed) return this.child;
    // exitCode can change before close; settle the old generation before replacing it.
    if (this.child) this.failAll(new Error(`SEUdaily worker is no longer running (exit code ${this.child.exitCode}); restarting`));

    const child = spawn("uv", ["run", "seudaily-worker"], {
      cwd: projectRoot,
      env: {
        ...process.env,
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

  private terminateWorkerTree(): void {
    const child = this.child;
    if (!child?.pid) return;
    if (process.platform === "win32") {
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } else {
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    }
  }

  async close(): Promise<void> {
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
    const fallback = setTimeout(() => this.terminateWorkerTree(), 10_000);
    await ended;
    clearTimeout(fallback);
  }

  call<T>(action: string, payload: Record<string, unknown>, abortSignal?: AbortSignal): Promise<T> {
    if (abortSignal?.aborted) {
      const error = new Error(`Python tool cancelled: ${action}`);
      error.name = "AbortError";
      return Promise.reject(error);
    }
    const child = this.ensureWorker();
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
        reject(error);
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

export async function runPythonTool<T = ToolResult>(
  action: string,
  payload: Record<string, unknown>,
  abortSignal?: AbortSignal,
): Promise<T> {
  return workerClient.call<T>(action, payload, abortSignal);
}

export async function closePythonWorker() { await workerClient.close(); }

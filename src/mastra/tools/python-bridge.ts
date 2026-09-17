import { spawn } from "node:child_process";
import { resolve } from "node:path";

const projectRoot = resolve(process.env.CVSTREAM_PROJECT_ROOT ?? process.cwd());

type BridgeResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; type?: string };

export async function runPythonTool<T>(
  action: string,
  payload: Record<string, unknown>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn("uv", ["run", "cvstream-tool"], {
      cwd: projectRoot,
      env: {
        ...process.env,
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Python tool timed out: ${action}`));
    }, 30 * 60 * 1000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      try {
        const response = JSON.parse(stdout.trim()) as BridgeResponse<T>;
        if (!response.ok) {
          reject(new Error(response.error));
          return;
        }
        resolve(response.data);
      } catch (error) {
        reject(
          new Error(
            `Python tool ${action} exited with ${code}. ${stderr || stdout}`,
            { cause: error },
          ),
        );
      }
    });

    child.stdin.end(JSON.stringify({ action, payload }));
  });
}

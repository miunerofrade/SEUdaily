import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { LocalSandbox } from "@mastra/core/workspace";

export type CommandSandboxMode = "wsl-bwrap" | "host-fallback" | "native";

export interface CommandSandboxSelection {
  sandbox: LocalSandbox;
  mode: CommandSandboxMode;
  detail: string;
}

interface WslBubblewrapSandboxOptions {
  id: string;
  workingDirectory: string;
  projectRoot: string;
  distro: string;
  timeout: number;
  allowNetwork: boolean;
}

function windowsPathToWsl(path: string): string {
  const absolute = resolve(path);
  const match = /^([A-Za-z]):\\(.*)$/.exec(absolute);
  if (!match) {
    throw new Error(`WSL sandbox requires a drive-letter path: ${absolute}`);
  }
  const drive = match[1]!.toLowerCase();
  const tail = match[2]!.replaceAll("\\", "/");
  return `/mnt/${drive}/${tail}`;
}

function enabled(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

function hasWslBubblewrap(distro: string): boolean {
  if (process.platform !== "win32") return false;
  const result = spawnSync(
    "wsl.exe",
    ["-d", distro, "--exec", "sh", "-lc", "command -v bwrap >/dev/null 2>&1"],
    {
      windowsHide: true,
      timeout: 5_000,
      stdio: "ignore",
      env: { PATH: process.env.PATH },
    },
  );
  return result.status === 0;
}

/**
 * Windows command sandbox backed by the same Linux primitive Codex uses in
 * WSL: Bubblewrap. Mastra still owns timeout, output streaming, and process
 * tracking; this class only replaces the command launch boundary.
 */
class WslBubblewrapSandbox extends LocalSandbox {
  private readonly distro: string;
  private readonly projectPath: string;
  private readonly workspacePath: string;
  private readonly allowNetwork: boolean;

  constructor(options: WslBubblewrapSandboxOptions) {
    super({
      id: options.id,
      workingDirectory: options.workingDirectory,
      timeout: options.timeout,
      isolation: "none",
      env: {},
      instructions: `Commands run in WSL2 ${options.distro} under Bubblewrap isolation.
The host project is read-only at /project. The writable persistent staging directory is /workspace.
Network access is ${options.allowNetwork ? "enabled" : "blocked"}. Host secrets are not inherited.`,
    });
    this.distro = options.distro;
    this.projectPath = windowsPathToWsl(options.projectRoot);
    this.workspacePath = windowsPathToWsl(options.workingDirectory);
    this.allowNetwork = options.allowNetwork;

    // LocalProcessManager uses this flag to avoid the Windows host shell and
    // to route every foreground/background command through our wrapper.
    Object.defineProperty(this, "isolation", {
      configurable: false,
      enumerable: true,
      value: "bwrap",
      writable: false,
    });
  }

  override wrapCommandForIsolation(command: string): {
    command: string;
    args: string[];
  } {
    const args = [
      "-d",
      this.distro,
      "--exec",
      "bwrap",
      "--die-with-parent",
      "--new-session",
      "--unshare-all",
    ];
    if (this.allowNetwork) args.push("--share-net");
    args.push(
      "--ro-bind", "/usr", "/usr",
      "--ro-bind", "/bin", "/bin",
      "--ro-bind", "/lib", "/lib",
      "--ro-bind", "/lib64", "/lib64",
      "--ro-bind", "/etc", "/etc",
      "--dev", "/dev",
      "--proc", "/proc",
      "--tmpfs", "/tmp",
      "--dir", "/tmp/home",
      "--ro-bind", this.projectPath, "/project",
      "--bind", this.workspacePath, "/workspace",
      "--chdir", "/workspace",
      "--clearenv",
      "--setenv", "HOME", "/tmp/home",
      "--setenv", "PATH", "/usr/local/bin:/usr/bin:/bin",
      "--setenv", "LANG", "C.UTF-8",
      "--setenv", "CVSTREAM_PROJECT_READONLY", "/project",
      "--setenv", "CVSTREAM_SANDBOX_WORKSPACE", "/workspace",
      "--",
      "bash",
      "-lc",
      command,
    );
    return { command: "wsl.exe", args };
  }
}

export function createCommandSandbox(options: {
  id: string;
  projectRoot: string;
  workingDirectory: string;
  timeout: number;
}): CommandSandboxSelection {
  const allowNetwork = enabled(process.env.CVSTREAM_SANDBOX_NETWORK, false);

  if (process.platform === "win32") {
    const distro = process.env.CVSTREAM_WSL_DISTRO?.trim() || "Ubuntu-24.04";
    const useWsl = enabled(process.env.CVSTREAM_WSL_SANDBOX, true);
    if (useWsl && hasWslBubblewrap(distro)) {
      return {
        sandbox: new WslBubblewrapSandbox({
          ...options,
          distro,
          allowNetwork,
        }),
        mode: "wsl-bwrap",
        detail: `WSL2 ${distro} + Bubblewrap; network ${allowNetwork ? "enabled" : "blocked"}`,
      };
    }

    return {
      sandbox: new LocalSandbox({
        id: options.id,
        workingDirectory: options.workingDirectory,
        timeout: options.timeout,
        env: {},
        instructions: `Commands run directly on the Windows host in compatibility fallback mode.
The working directory is a dedicated staging directory, but OS-level filesystem and network isolation are unavailable.
Do not claim that this mode is strongly sandboxed and do not access paths outside the staging directory.`,
      }),
      mode: "host-fallback",
      detail: "Windows host fallback; no OS-level filesystem or network isolation",
    };
  }

  const detected = LocalSandbox.detectIsolation();
  if (detected.available && detected.backend !== "none") {
    return {
      sandbox: new LocalSandbox({
        id: options.id,
        workingDirectory: options.workingDirectory,
        timeout: options.timeout,
        isolation: detected.backend,
        nativeSandbox: { allowNetwork },
        env: {},
        instructions: `Commands use the native ${detected.backend} sandbox.
The working directory is writable and network access is ${allowNetwork ? "enabled" : "blocked"}.`,
      }),
      mode: "native",
      detail: `${detected.backend}; network ${allowNetwork ? "enabled" : "blocked"}`,
    };
  }

  return {
    sandbox: new LocalSandbox({
      id: options.id,
      workingDirectory: options.workingDirectory,
      timeout: options.timeout,
      env: {},
      instructions: `Commands run directly on the host in compatibility fallback mode.
OS-level filesystem and network isolation are unavailable. Do not access paths outside the working directory.`,
    }),
    mode: "host-fallback",
    detail: "Host fallback; native isolation backend unavailable",
  };
}

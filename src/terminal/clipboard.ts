import { spawn } from "node:child_process";

function writeClipboard(command: string, args: string[], text: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
    const timer = setTimeout(() => { child.kill(); resolve(false); }, 1500);
    const done = (success: boolean) => { clearTimeout(timer); resolve(success); };
    child.on("error", () => done(false));
    child.on("close", (code) => done(code === 0));
    child.stdin.on("error", () => {});
    child.stdin.end(text, "utf8");
  });
}

/** Text is passed over stdin, never interpolated into shell commands. */
export async function copySelection(text: string): Promise<string> {
  if (!text) return "";
  if (!process.env.SSH_CONNECTION && !process.env.SSH_TTY) {
    const commands: [string, string[]][] = process.platform === "darwin"
      ? [["pbcopy", []]]
      : process.platform === "win32"
        ? [["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "[Console]::InputEncoding = [System.Text.UTF8Encoding]::new(); Set-Clipboard -Value ([Console]::In.ReadToEnd())"]]]
        : [
            ...(process.env.WAYLAND_DISPLAY ? [["wl-copy", []] as [string, string[]]] : []),
            ...(process.env.DISPLAY ? [["xclip", ["-selection", "clipboard"]] as [string, string[]], ["xsel", ["--clipboard", "--input"]] as [string, string[]]] : []),
          ];
    for (const [command, args] of commands) if (await writeClipboard(command, args, text)) return "已复制";
  }
  // SSH/headless fallback: ask the terminal to write its local clipboard. tmux needs DCS passthrough.
  const sequence = `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;
  process.stdout.write(process.env.TMUX ? `\x1bPtmux;${sequence.replaceAll("\x1b", "\x1b\x1b")}\x1b\\` : sequence);
  return "已发送复制请求";
}

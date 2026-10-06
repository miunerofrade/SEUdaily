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

// No shell interpolation: clipboard contents are always data, never commands.
export type ClipboardContent = { text: string } | { image: Buffer; mediaType: 'image/png' };
const clipboardLimit = 10 * 1024 * 1024;
export type ClipboardRunner = (command: string, args: string[]) => Promise<Buffer>;
const runClipboard: ClipboardRunner = async (command, args) => {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve, reject) => execFile(command, args,
    { encoding: 'buffer', timeout: 5000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
    (error, stdout) => error ? reject(error) : resolve(stdout)));
};
function imageContent(image: Buffer): ClipboardContent {
  if (!image.length || image.length > clipboardLimit) throw new Error('剪贴板图片须为 10 MB 以内');
  return { image, mediaType: 'image/png' };
}
export async function readClipboard(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  run: ClipboardRunner = runClipboard,
): Promise<ClipboardContent> {
  if (env.SSH_CONNECTION || env.SSH_TTY) throw new Error('SSH 无法读取你电脑的剪贴板；请使用终端粘贴文本或文件路径，图片可通过 Web 上传');
  if (platform === 'darwin') {
    const { mkdtemp, readFile, rm } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const directory = await mkdtemp(join(tmpdir(), 'seudaily-clipboard-'));
    try {
      // Finder file copies and screenshot image data are different pasteboard types.
      const file = await run('osascript', ['-e', 'POSIX path of (the clipboard as «class furl»)']).catch(() => null);
      if (file?.length) return { text: JSON.stringify(file.toString('utf8').trim()) };
      const target = join(directory, 'clipboard.png');
      const script = `on run argv
set imageData to the clipboard as «class PNGf»
set outputFile to open for access POSIX file (item 1 of argv) with write permission
try
set eof outputFile to 0
write imageData to outputFile
close access outputFile
on error messageText
close access outputFile
error messageText
end try
end run`;
      const copied = await run('osascript', ['-e', script, target]).then(() => true, () => false);
      if (copied) return imageContent(await readFile(target));
      return { text: (await run('pbpaste', [])).toString('utf8') };
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  if (platform === 'win32') {
    const script = `Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing;
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new();
if ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) {
  $paths = @([System.Windows.Forms.Clipboard]::GetFileDropList() | ForEach-Object { '"' + $_ + '"' });
  @{text=($paths -join "\n")} | ConvertTo-Json -Compress
} elseif ([System.Windows.Forms.Clipboard]::ContainsImage()) {
  $image = [System.Windows.Forms.Clipboard]::GetImage(); $stream = [System.IO.MemoryStream]::new();
  try { $image.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png); @{image=[Convert]::ToBase64String($stream.ToArray())} | ConvertTo-Json -Compress }
  finally { $stream.Dispose(); $image.Dispose() }
} else { @{text=[System.Windows.Forms.Clipboard]::GetText()} | ConvertTo-Json -Compress }`;
    const value = JSON.parse((await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', script])).toString('utf8').replace(/^\uFEFF/, ''));
    return typeof value.image === 'string' ? imageContent(Buffer.from(value.image, 'base64')) : { text: String(value.text ?? '') };
  }
  const commands: [string, string[]][] = env.WAYLAND_DISPLAY
    ? [['wl-paste', ['--no-newline', '--type', 'image/png']], ['wl-paste', ['--no-newline', '--type', 'text/uri-list']], ['wl-paste', ['--no-newline', '--type', 'text']]]
    : env.DISPLAY ? [['xclip', ['-selection', 'clipboard', '-o', '-t', 'image/png']], ['xclip', ['-selection', 'clipboard', '-o', '-t', 'text/uri-list']], ['xclip', ['-selection', 'clipboard', '-o']], ['xsel', ['--clipboard', '--output']]] : [];
  for (const [command, args] of commands) {
    const bytes = await run(command, args).catch(() => null);
    if (bytes) return args.includes('image/png') ? imageContent(bytes) : { text: bytes.toString('utf8') };
  }
  throw new Error('无法读取剪贴板；Wayland 请安装 wl-clipboard，X11 请安装 xclip 或 xsel，或使用终端原生粘贴');
}

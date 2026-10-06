/** CSI capability replies are terminal metadata, not user input (Ink strips ESC before useInput). */
export const isTerminalReply = (value: string) => /^(?:\x1b)?\[\?[\d;]*[uc]$/.test(value);

/** Ink may deliver committed text and its final CR in one event. Keep it as a draft;
 * only a separate Return key submits. Bracketed paste uses its own channel. */
export const committedInput = (value: string) => value.replace(/\r+$/, "");

/** Legacy terminals send key repeats but no key-up events; require sustained repeats, never a timer alone. */
export class InterruptHold {
  private started = 0;
  private last = 0;
  private count = 0;
  reset() { this.count = 0; }
  press(now = Date.now()): "first" | "repeat" | "exit" {
    if (!this.count || now - this.last > 750) {
      this.started = now;
      this.count = 0;
    }
    this.last = now;
    this.count++;
    if (this.count >= 3 && now - this.started >= 900) return "exit";
    return this.count === 1 ? "first" : "repeat";
  }
}

/** Ink flushes incomplete CSI after 20 ms; retain capability fragments until their final byte arrives. */
export class TerminalReplyFilter {
  private pending = "";
  private updated = 0;
  consume(value: string, now = Date.now()): boolean {
    if (now - this.updated > 2000) this.pending = "";
    const combined = this.pending + value;
    if (isTerminalReply(combined)) { this.pending = ""; return true; }
    if (/^(?:\x1b)?\[\?[\d;]*$/.test(combined)) {
      this.pending = combined;
      this.updated = now;
      return true;
    }
    this.pending = "";
    return false;
  }
}

/** Disable terminal echo before Ink's constructor sends any capability queries. */
export function prepareTerminalInput(stdin: NodeJS.ReadStream): () => void {
  const wasRaw = stdin.isRaw ?? false;
  stdin.setRawMode(true);
  return () => { if (!stdin.destroyed) stdin.setRawMode(wasRaw); };
}

export function terminalKeyboard(env: NodeJS.ProcessEnv = process.env): import("ink").KittyKeyboardOptions {
  // Terminal.app does not implement kitty keyboard reporting. Avoid querying it at all.
  return env.TERM_PROGRAM === "Apple_Terminal" ? { mode: "disabled" } : {
    mode: "auto",
    // Printable input must remain terminal-composed UTF-8, not physical key codes.
    flags: ["disambiguateEscapeCodes", "reportEventTypes"],
  };
}

/** Clear text-key reporting left in the alternate screen by a previous abnormal exit.
 * Keep shortcut reporting intact. Unsupported terminals ignore this CSI command. */
export function restoreTextInput(stdout: Pick<NodeJS.WriteStream, "write">) {
  stdout.write("\x1b[=24;3u");
}

/** Normalize Enter encodings Ink does not expose as key.return. Text+CR remains
 * a draft because an IME commit is indistinguishable from that encoding. */
export function enterKey(value: string, key: import('ink').Key): import('ink').Key {
  return /^[\r\n]+$/.test(value) || /^\[57414(?:;[\d:]+)*u$/.test(value)
    ? {...key, return: true} : key;
}

/** Ctrl+V matches Codex CLI; Alt+V is a portable explicit clipboard shortcut. */
export function isClipboardPaste(value: string, key: import('ink').Key): boolean {
  return value.toLowerCase() === 'v' && !!(key.ctrl || key.meta || key.super);
}

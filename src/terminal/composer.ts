/** Visible paste elements retain their original text and behave as atomic editor units. */
export class Composer {
  text = "";
  cursor = 0;
  private serial = 0;
  private blocks: { start: number; end: number; content: string; attachmentId?: string }[] = [];
  onAttachmentRemoved?: (id: string) => void;
  set(text: string, cursor: number) {
    if (text !== this.text) {
      let start = 0,
        oldEnd = this.text.length,
        newEnd = text.length;
      while (
        start < oldEnd &&
        start < newEnd &&
        this.text[start] === text[start]
      )
        start++;
      while (
        oldEnd > start &&
        newEnd > start &&
        this.text[oldEnd - 1] === text[newEnd - 1]
      ) {
        oldEnd--;
        newEnd--;
      }
      const removed = this.blocks.filter(
        (b) => b.start < oldEnd && b.end > start,
      );
      for (const block of removed) if (block.attachmentId) this.onAttachmentRemoved?.(block.attachmentId);
      const insertion = text.slice(start, newEnd);
      const expandedStart = Math.min(start, ...removed.map((b) => b.start));
      const expandedEnd = Math.max(oldEnd, ...removed.map((b) => b.end));
      text =
        this.text.slice(0, expandedStart) +
        insertion +
        this.text.slice(expandedEnd);
      const delta = insertion.length - (expandedEnd - expandedStart);
      this.blocks = this.blocks
        .filter((b) => !removed.includes(b))
        .map((b) =>
          b.start >= expandedEnd
            ? { ...b, start: b.start + delta, end: b.end + delta }
            : b,
        );
      cursor = removed.length ? expandedStart + insertion.length : cursor;
      this.text = text;
      if (!text) {
        this.blocks = [];
        this.serial = 0;
      }
    }
    cursor = Math.max(0, Math.min(this.text.length, cursor));
    const inside = this.blocks.find((b) => cursor > b.start && cursor < b.end);
    this.cursor = inside
      ? cursor < this.cursor
        ? inside.start
        : inside.end
      : cursor;
  }
  paste(content: string) {
    const lines = content.split("\n").length;
    if (lines < 6 && content.length < 1000) {
      this.set(
        this.text.slice(0, this.cursor) +
          content +
          this.text.slice(this.cursor),
        this.cursor + content.length,
      );
      return;
    }
    const label = `[pasted text${++this.serial > 1 ? " #" + this.serial : ""} +${lines} lines]`;
    const start = this.cursor;
    this.set(
      this.text.slice(0, start) + label + this.text.slice(start),
      start + label.length,
    );
    this.blocks.push({ start, end: start + label.length, content });
    this.blocks.sort((a, b) => a.start - b.start);
  }
  expanded() {
    let text = this.text;
    for (const block of [...this.blocks].reverse())
      text = text.slice(0, block.start) + block.content + text.slice(block.end);
    return text;
  }
  attachment(id: string, name: string, kind: '图片' | '文档') {
    const label = `[${kind}：${name}]`;
    const start = this.cursor;
    this.set(this.text.slice(0, start) + label + this.text.slice(start), start + label.length);
    this.blocks.push({ start, end: start + label.length, content: '', attachmentId: id });
    this.blocks.sort((a, b) => a.start - b.start);
  }
  /** Sending consumes the editor tokens without deleting the pending uploads. */
  clearAfterSubmit() {
    this.text = '';
    this.cursor = 0;
    this.blocks = [];
    this.serial = 0;
  }
}

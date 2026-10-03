import { useCursor } from "ink";
/** Only the active text editor mounts this cursor owner, including IME composition anchors. */
export function InputCursor({ position }: { position?: { x: number; y: number } }) {
  const { setCursorPosition } = useCursor();
  setCursorPosition(position);
  return null;
}

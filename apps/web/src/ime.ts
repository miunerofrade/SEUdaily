import { useRef, type KeyboardEvent } from 'react';

export function isImeComposing(event: { isComposing: boolean; keyCode: number }, composing: boolean) {
  // Some browsers report 229 when Enter is confirming an IME candidate.
  return composing || event.isComposing || event.keyCode === 229;
}

export function useImeComposition() {
  const composing = useRef(false);
  return {
    onCompositionStart: () => { composing.current = true; },
    onCompositionEnd: () => { composing.current = false; },
    isComposing: (event: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => isImeComposing(event.nativeEvent, composing.current),
  };
}

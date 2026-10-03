import type { ChatMessage, Conversation } from './types';

export function messageContent(message: ChatMessage) {
  const text = message.modelContent ?? message.content;
  const images = (message.attachments ?? []).filter(item => item.ref || item.path || item.dataUrl);
  if (!images.length) return text;
  return [
    ...(text ? [{ type: 'text' as const, text }] : []),
    ...images.map(item => {
      const filename = item.path?.split(/[\\/]/).at(-1) ?? item.name;
      return { type: 'file' as const, data: item.ref ?? (item.path ? `seudaily-image-ref:${filename}` : item.dataUrl!),
        mediaType: item.mediaType, filename };
    }),
  ];
}

export function editedDocumentContent(prompt: string, original: ChatMessage, packaged: string) {
  // Restored documents may have only their names. Preserve the full persisted
  // attachment section instead of silently replacing it with the edited prompt.
  const marker = /\n\n(?:<!-- (?:seudaily|cvstream):documents -->|【附件：)/.exec(original.modelContent ?? '');
  return marker && !(original.documents ?? []).some(document => document.markdown?.trim())
    ? prompt + original.modelContent!.slice(marker.index) : packaged;
}

export function writeConversationCache(storage: Pick<Storage, 'setItem'>, key: string, conversations: Conversation[]) {
  const cache: Conversation[] = [];
  let bytes = 2;
  for (const conversation of [...conversations].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 20)) {
    const safe = { ...conversation, messages: conversation.messages.map(message => ({ ...message,
      attachments: message.attachments?.flatMap(({ dataUrl: _dataUrl, ...attachment }) => attachment.path || attachment.ref ? [attachment] : []),
      documents: message.documents?.map(({ contextRef: _contextRef, ...document }) => document),
    })) };
    // Cache complete trees or metadata only. Never truncate individual messages
    // or branches, since that would change ancestry when a cache is restored.
    const encoded = JSON.stringify(safe);
    if (encoded.length * 2 + bytes <= 1_000_000) {
      cache.push(safe);
      bytes += encoded.length * 2 + 1;
    } else {
      const metadata = { ...safe, messages: [], messagesLoaded: false };
      cache.push(metadata);
      bytes += JSON.stringify(metadata).length * 2 + 1;
    }
  }
  try { storage.setItem(key, JSON.stringify(cache)); return true; }
  catch { return false; } // A full/disabled browser cache must not interrupt a live reply.
}

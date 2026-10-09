import type { Thread } from '../agent/types.js';

export const DEFAULT_CONVERSATION_TITLE = '新对话';

export function isProgramConversation(resourceId: string, channel?: string) {
  return channel === 'program' || resourceId === 'seudaily-focus-local' || resourceId.startsWith('focus-');
}

export function initialConversationMetadata(resourceId: string, channel = 'web', manual = false) {
  return { channel: isProgramConversation(resourceId, channel) ? 'program' : channel,
    titleManual: manual, titleProvisional: !manual };
}

/** Source is metadata, never part of the stored title. Unknown clients need no registry. */
export function conversationSummary(thread: Thread) {
  const channel = thread.metadata?.channel ?? 'web';
  const source = ({wechat:'微信', web:'网页', cli:'终端', program:'程序'} as Record<string,string>)[channel] ?? channel;
  return {...thread, title:thread.title?.trim() || DEFAULT_CONVERSATION_TITLE, source};
}

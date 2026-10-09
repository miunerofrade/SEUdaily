import type { Conversation } from './types';

/** Thread titles can change without changing the message timestamp. */
export function mergeServerConversation(remote: Conversation, local?: Conversation): Conversation {
  if (!local) return remote;
  if (local.messages.some(message => message.streaming) || local.updatedAt > remote.updatedAt) {
    return { ...local, title: remote.title };
  }
  if (local.messagesLoaded !== false && local.updatedAt === remote.updatedAt) {
    return { ...local, title: remote.title, activeLeaf: remote.activeLeaf ?? local.activeLeaf };
  }
  return remote;
}

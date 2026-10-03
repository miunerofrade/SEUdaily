import { conversationPath, withParents } from '../../../src/shared/conversation-tree';
import type { ChatMessage } from './types';

export function promptVersionGroups(messages: ChatMessage[], message: ChatMessage, leaf?: string) {
  if (message.role !== 'user') return [];
  const nodes = withParents(messages);
  const prompt = nodes.find(node => node.id === message.id);
  if (!prompt) return [];
  const prompts = nodes.filter(node => node.role === 'user' && node.parentId === prompt.parentId);
  const replies = nodes.filter(node => node.role === 'assistant' && node.parentId === prompt.id);
  const reply = conversationPath(nodes, leaf).find(node => node.parentId === prompt.id && node.role === 'assistant');
  return [
    { label: '提示词', nodes: prompts, current: prompt.id },
    { label: '回答', nodes: replies, current: reply?.id },
  ].filter(group => group.nodes.length > 1 && group.current);
}

export function PromptVersions({ messages, message, leaf, disabled, onSwitch }: {
  messages: ChatMessage[]; message: ChatMessage; leaf?: string; disabled?: boolean; onSwitch: (id: string) => void;
}) {
  const groups = promptVersionGroups(messages, message, leaf);
  return <>{groups.map(group => {
    const index = group.nodes.findIndex(node => node.id === group.current);
    return <div className="message-versions" key={group.label} aria-label={`${group.label}版本`}>
      {groups.length > 1 && <span>{group.label}</span>}
      <button type="button" disabled={disabled || index === 0} aria-label={`上一个${group.label}版本`} onClick={() => onSwitch(group.nodes[index - 1].id)}>‹</button>
      <span>{index + 1} / {group.nodes.length}</span>
      <button type="button" disabled={disabled || index === group.nodes.length - 1} aria-label={`下一个${group.label}版本`} onClick={() => onSwitch(group.nodes[index + 1].id)}>›</button>
    </div>;
  })}</>;
}

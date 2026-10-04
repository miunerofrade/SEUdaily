import React, { useState } from 'react';
import { spawn } from 'node:child_process';
import { Box, Text, useInput, useApp } from 'ink';
import type { Session } from './session.js';

function openNotice(url: string) {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('通知链接无效');
  const [command, args] = process.platform === 'darwin' ? ['open', [parsed.href]]
    : process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', parsed.href]]
      : ['xdg-open', [parsed.href]];
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command as string, args as string[], { stdio: 'ignore', windowsHide: true });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error('无法打开浏览器，可复制通知链接')));
  });
}
export function NoticesManager({ session, width, height }: { session: Session; width: number; height: number }) {
  const { exit } = useApp();
  const [index, setIndex] = useState(0), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const action = async (fn: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await fn(); } catch (cause) { setError((cause as Error).message); } finally { setBusy(false); }
  };
  const selected = Math.min(index, Math.max(0, session.noticeItems.length - 1));
  useInput((value, key) => {
    if (key.ctrl && value === 'd') { exit(); return; }
    if (key.eventType === 'release' || busy) return;
    if (key.escape) { session.page = 'chat'; session.changed(); return; }
    if (key.upArrow || key.downArrow) setIndex(Math.max(0, Math.min(session.noticeItems.length - 1, selected + (key.upArrow ? -1 : 1))));
    if (value === 'r') void action(() => session.loadNotices());
    const item = session.noticeItems[selected];
    if (key.return && item?.url) void action(() => openNotice(item.url));
  });
  const capacity = Math.max(1, Math.floor((height - 8) / 3)), top = Math.max(0, selected - capacity + 1);
  return <Box width={width} height={height} flexDirection="column" paddingX={2}>
    <Text bold color="#80cbc4">校园通知 · 教务处</Text>
    <Text color="#8993a4">↑↓ 选择 · Enter 打开原文 · r 刷新 · Esc 返回</Text>
    <Box flexDirection="column" flexGrow={1} marginTop={1}>{session.noticeItems.slice(top, top + capacity).map((item, i) =>
      <Box key={item.id ?? item.url ?? top + i} flexDirection="column" marginBottom={1}>
        <Text color={top + i === selected ? '#20242c' : '#dce1ea'} backgroundColor={top + i === selected ? '#80cbc4' : undefined}>{item.title}</Text>
        <Text color="#8993a4">{item.category} · {item.publishedAt ?? item.date}</Text>
      </Box>)}</Box>
    {!session.noticeItems.length && <Text>暂无通知</Text>}
    <Text color="#8993a4" wrap="truncate">{session.noticeItems[selected]?.url}</Text>
    {error && <Text color="red">{error}</Text>}{busy && <Text>读取中…</Text>}
  </Box>;
}

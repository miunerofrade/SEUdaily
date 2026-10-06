import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, usePaste, useStdout } from 'ink';
import { Client, clean } from './client.js';
import { terminalWeChatQR, wechatStateLabel, type WeChatStatus } from '../shared/wechat.js';
export function WeChatApp() {
  const {exit} = useApp(), {stdout} = useStdout();
  const [status,setStatus] = useState<WeChatStatus>(), [error,setError] = useState(''), [busy,setBusy] = useState(true), [code,setCode] = useState('');
  const client = useRef(new Client(20)).current;
  const lifetime = useRef(new AbortController()).current;
  const alive = useRef(true), operation = useRef(false);
  const run = async (path:string,body?:unknown) => {
    if (operation.current) return;
    operation.current = true; setBusy(true); setError('');
    try { const next = await client.json(path,'POST',body ?? {},lifetime.signal); if (alive.current) {setStatus(next);setCode('');} }
    catch (cause) { if (alive.current) setError(clean((cause as Error).message)); }
    finally { operation.current = false; if (alive.current) setBusy(false); }
  };
  useEffect(() => {
    alive.current = true;
    const abort = lifetime; let polling = false;
    void run('/app/wechat/connect');
    const timer = setInterval(async () => {
      if (polling || operation.current) return; polling = true;
      try { const next = await client.json('/app/wechat','GET',undefined,abort.signal,5); if (alive.current) setStatus(next); }
      catch (cause) { if (alive.current) setError(clean((cause as Error).message)); }
      finally { polling = false; }
    },1000);
    return () => {alive.current = false;abort.abort();clearInterval(timer);};
  },[]);
  useInput((input,key) => {
    if (key.eventType === 'release') return;
    if (key.escape || key.ctrl && (input === 'c' || input === 'd')) {exit();return;}
    if (busy) return;
    if (key.ctrl && input.toLowerCase() === 'r') {void run('/app/wechat/connect',{refresh:true});return;}
    if (status?.state === 'need_verifycode') {
      if (key.return && code) void run('/app/wechat/verify',{loginId:status.loginId,code});
      else if (key.backspace || key.delete) setCode(value => value.slice(0,-1));
      else if (/^[a-zA-Z0-9]+$/.test(input)) setCode(value => (value + input).slice(0,12));
    } else if (input.toLowerCase() === 'r') void run('/app/wechat/connect',{refresh:true});
  });
  usePaste(value => {if (!busy && status?.state === 'need_verifycode') setCode(value.replace(/[^a-zA-Z0-9]/g,'').slice(0,12));});
  const qr = status?.qr;
  const showingQR = !!qr && !['connected','expired','verify_code_blocked'].includes(status!.state);
  return <Box flexDirection="column">
    <Text bold>SEUdaily · WeChat</Text>
    <Text>{busy ? '正在连接…' : wechatStateLabel[status?.state ?? ''] ?? '正在读取连接状态…'}</Text>
    {qr && showingQR && <>
      {stdout.columns < qr.size + 8 || stdout.rows < Math.ceil((qr.size + 8) / 2) + 7 ? <Text color="yellow">终端空间不足，请扩大到 {qr.size + 8} 列 × {Math.ceil((qr.size + 8) / 2) + 7} 行，或打开 seudaily web 扫码。</Text> : <Text color="black" backgroundColor="white">{terminalWeChatQR(qr)}</Text>}
    </>}
    {status?.state === 'need_verifycode' && <Text>验证码：{code || '等待输入'}（Enter 提交）</Text>}
    {!showingQR && status?.botId && <Text>Bot：{clean(status.botId)}</Text>}
    {!showingQR && status && <Text>固定会话：{status.threadId} · {status.resourceId}</Text>}
    {!showingQR && status?.messages[0] && <Text>最近消息：{clean(status.messages[0].text).slice(0,100)} · {status.messages[0].state === 'sent' ? '已回复' : '等待回复'}</Text>}
    {(error || status?.error) && <Text color="red">{clean(error || status?.error)}</Text>}
    <Text dimColor>R / Ctrl+R 刷新 · Esc / Ctrl+C 退出（后台继续运行）</Text>
  </Box>;
}

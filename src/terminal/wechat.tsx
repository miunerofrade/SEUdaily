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
  const run = async (path:string,body?:unknown,method:'GET'|'POST' = 'POST') => {
    if (operation.current) return;
    operation.current = true; setBusy(true); setError('');
    try { const next = await client.json(path,method,method === 'GET' ? undefined : body ?? {},lifetime.signal); if (alive.current) {setStatus(next);setCode('');} }
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
  const refresh = () => status?.state === 'connected' ? run('/app/wechat',undefined,'GET') : run('/app/wechat/connect',{refresh:true});
  useInput((input,key) => {
    if (key.eventType === 'release') return;
    if (key.escape || key.ctrl && (input === 'c' || input === 'd')) {exit();return;}
    if (busy) return;
    if (key.ctrl && input.toLowerCase() === 'r') {void run('/app/wechat/connect',{refresh:true});return;}
    if (status?.state === 'need_verifycode') {
      if (key.return && code) void run('/app/wechat/verify',{loginId:status.loginId,code});
      else if (key.backspace || key.delete) setCode(value => value.slice(0,-1));
      else if (/^[a-zA-Z0-9]+$/.test(input)) setCode(value => (value + input).slice(0,12));
    } else if (input.toLowerCase() === 'r') void refresh();
  });
  usePaste(value => {if (!busy && status?.state === 'need_verifycode') setCode(value.replace(/[^a-zA-Z0-9]/g,'').slice(0,12));});
  const qr = status?.qr;
  const showingQR = !!qr && !['connected','expired','verify_code_blocked'].includes(status!.state);
  const connected = status?.state === 'connected';
  const width = Math.max(20,Math.min(showingQR && qr ? Math.max(66,qr.size + 14) : 66,stdout.columns - 4));
  const hint = busy ? '正在准备，请稍候…' : connected ? '在微信发送消息开始聊天，/help 查看命令。' : wechatStateLabel[status?.state ?? ''] ?? '正在读取连接状态…';
  const requiredRows = qr ? Math.ceil((qr.size + 8) / 2) + 13 : 13;
  return <Box width={stdout.columns} height={stdout.rows} flexDirection="column" justifyContent="center" alignItems="center">
    <Box width={width} flexDirection="column" borderStyle="round" borderColor={connected ? 'green' : 'gray'} paddingX={2} paddingY={1}>
      <Box justifyContent="space-between"><Text bold>微信</Text><Text color={connected ? 'green' : 'gray'}>{connected ? '● 已连接' : busy ? '连接中' : '等待连接'}</Text></Box>
      <Box marginTop={1}><Text>{hint}</Text></Box>
      {qr && showingQR && <Box marginTop={1} alignSelf="center">
        {width - 6 < qr.size + 8 || stdout.rows < requiredRows ? <Text color="yellow">请扩大终端窗口，或打开 seudaily web 扫码。</Text> : <Text color="black" backgroundColor="white">{terminalWeChatQR(qr)}</Text>}
      </Box>}
      {status?.state === 'need_verifycode' && <Box marginTop={1}><Text>验证码  {code || '等待输入'} <Text dimColor>↵ 提交</Text></Text></Box>}
      {connected && <Box marginTop={1}><Text dimColor>当前会话  </Text><Text>{clean(status.currentSession?.title ?? '首次发消息时创建')}</Text></Box>}
      {(error || status?.error) && <Box marginTop={1}><Text color="red">{clean(error || status?.error)}</Text></Box>}
    </Box>
    <Box marginTop={1}><Text dimColor>{connected ? 'R 刷新状态' : 'Ctrl+R 刷新二维码'} · Esc 关闭界面</Text></Box>
    <Text dimColor>关闭后，微信服务继续运行</Text>
  </Box>;
}

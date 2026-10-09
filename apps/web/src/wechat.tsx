import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import { wechatStateLabel, type WeChatStatus } from '../../../src/shared/wechat';
import { useImeComposition } from './ime';
async function request(path = '', body?: unknown, signal?: AbortSignal): Promise<WeChatStatus> {
  const response = await fetch('/app/wechat' + path, {method:body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : {headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),signal:signal ?? AbortSignal.timeout(20000)});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '微信连接请求失败');
  return result;
}
export function WeChatPanel() {
  const [status,setStatus] = useState<WeChatStatus>(), [open,setOpen] = useState(false), [code,setCode] = useState(''), [error,setError] = useState(''), [pollError,setPollError] = useState(''), [busy,setBusy] = useState(false);
  const dismissed = useRef(''), mounted = useRef(true), operation = useRef(false), ime = useImeComposition();
  useEffect(() => {
    mounted.current = true; const abort = new AbortController(); let polling = false;
    const poll = async () => {
      if (polling || operation.current) return; polling = true;
      try {const next = await request('',undefined,AbortSignal.any([abort.signal,AbortSignal.timeout(5000)])); if (mounted.current) {setStatus(next);setPollError('');}}
      catch (cause) {if (mounted.current) setPollError((cause as Error).message);}
      finally {polling = false;}
    };
    void poll(); const timer = setInterval(() => void poll(),2000);
    return () => {mounted.current = false;abort.abort();clearInterval(timer);};
  },[]);
  useEffect(() => {
    if (status?.loginId && dismissed.current !== status.loginId) setOpen(true);
  },[status?.loginId]);
  const run = async (path:string,body:unknown) => {
    if (operation.current) return; operation.current = true;setBusy(true);setError('');
    try { const next = await request(path,body); if (mounted.current) {setStatus(next);setCode('');} }
    catch (cause) { if (mounted.current) setError((cause as Error).message); }
    finally {operation.current = false;if (mounted.current) setBusy(false);}
  };
  const close = () => {dismissed.current = status?.loginId ?? '';setOpen(false);};
  const qr = status?.qr;
  return <>
    <button className="settings-button wechat-button" type="button" aria-label="微信接入与连接状态" title={status?.state === "connected" ? "微信已连接 · 点击查看" : "微信接入与连接状态"} onClick={() => {setOpen(true);if (status?.state === 'disconnected' || status?.state === 'needs_login') void run('/connect',{});}}><svg className="wechat-icon" width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M9.3 3C4.7 3 1 6 1 9.8c0 2.1 1.1 4 3 5.3l-.8 2.7 3-1.5c.9.3 2 .4 3.1.4h.6a6.8 6.8 0 0 1-1.5-4.2c0-3.6 3.2-6.5 7.3-6.5h.7C15 4.2 12.4 3 9.3 3Z"/><path fill="currentColor" d="M15.8 7.4c-3.9 0-7 2.5-7 5.5s3.1 5.5 7 5.5c.9 0 1.7-.1 2.5-.4l2.5 1.3-.6-2.2c1.6-1 2.5-2.5 2.5-4.2 0-3-3-5.5-6.9-5.5Z"/><g fill="white"><circle cx="6.3" cy="8.1" r=".9"/><circle cx="11.6" cy="8.1" r=".9"/><circle cx="13.2" cy="11.8" r=".8"/><circle cx="18.1" cy="11.8" r=".8"/></g></svg><span>微信</span></button>
    {open && createPortal(<div className="campus-sms-overlay" onKeyDown={event => {if (event.key === 'Escape') close();}}>
      <section className="campus-sms-dialog wechat-dialog" role="dialog" aria-modal="true" aria-labelledby="wechat-title">
        <h2 id="wechat-title">微信</h2>
        <p role="status">{busy ? '正在处理…' : wechatStateLabel[status?.state ?? ''] ?? '正在读取连接状态…'}</p>
        {qr && !['expired','verify_code_blocked'].includes(status!.state) && <svg className="wechat-qr" role="img" aria-label="请用微信扫描此二维码" viewBox={`-4 -4 ${qr.size+8} ${qr.size+8}`} shapeRendering="crispEdges"><rect x="-4" y="-4" width={qr.size+8} height={qr.size+8} fill="white"/><path fill="black" d={Array.from(qr.modules).flatMap((value,index) => value === '1' ? [`M${index % qr.size} ${Math.floor(index / qr.size)}h1v1h-1z`] : []).join('')}/></svg>}
        {status?.state === 'need_verifycode' && <form onSubmit={event => {event.preventDefault();if (code.trim() && !busy) void run('/verify',{loginId:status.loginId,code:code.trim()});}}>
          <label>手机验证码<input autoFocus autoComplete="one-time-code" maxLength={12} value={code} onChange={event => setCode(event.target.value)} onCompositionStart={ime.onCompositionStart} onCompositionEnd={ime.onCompositionEnd} onKeyDown={event => {if (event.key === 'Enter' && ime.isComposing(event)) event.preventDefault();}} /></label>
          <button type="submit" className="disk-action" disabled={busy || !code.trim()}>提交验证码</button>
        </form>}
        {status?.state === 'connected' && <div className="wechat-connected">
          <p>在微信发送消息开始聊天。</p>
          <p className="inspector-description">当前会话：{status.currentSession?.title ?? '首次发消息时创建'}</p>
          <p className="inspector-description">发送 /help 查看命令，/new 开始新会话。完整记录可在左侧会话列表查看。</p>
        </div>}
        {(error || pollError || status?.error) && <p className="disk-error" role="alert">{error || pollError || status?.error}</p>}
        <div className="campus-sms-actions">
          <button type="button" className="disk-action" disabled={busy} onClick={() => void run('/connect',{refresh:true})}>重新扫码</button>
          {status?.loginId && <button type="button" className="disk-action" disabled={busy} onClick={() => void run('/cancel-login',{})}>取消接入</button>}
          <button type="button" className="disk-action" onClick={close}>关闭</button>
        </div>
        <small>关闭窗口后，微信服务继续运行。</small>
      </section>
    </div>, document.body)}
  </>;
}

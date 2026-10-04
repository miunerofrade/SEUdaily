import { useEffect, useState } from 'react';
import { useImeComposition } from './ime';

type SmsRequest = { challengeId: string; resolve: () => void; reject: (error: Error) => void };
const eventName = 'seudaily-campus-sms';
export async function campusSmsAction(challengeId: string, operation: 'send' | 'verify', code?: string) {
  const response = await fetch('/app/auth/sms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ challengeId, operation, code }) });
  if (!response.ok) throw new Error(`短信验证请求失败（HTTP ${response.status}）`);
  const result = await response.json();
  if (result.status !== 'completed') throw new Error(result.summary || '短信验证失败');
  return result.data as { retryAfter?: number };
}
export async function completeCampusLogin<T>(path: string): Promise<T> {
  let resetSession = true;
  for (;;) {
    const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resetSession }) });
    if (!response.ok) throw new Error((await response.text()) || '登录失败');
    const result = await response.json();
    const challengeId = result.challengeId ?? result.data?.challengeId;
    if (!challengeId) return result as T;
    await new Promise<void>((resolve, reject) => window.dispatchEvent(new CustomEvent<SmsRequest>(eventName, { detail: { challengeId, resolve, reject } })));
    resetSession = false;
  }
}
export function CampusSmsDialog() {
  const ime = useImeComposition();
  const [request, setRequest] = useState<SmsRequest | null>(null);
  const [code, setCode] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [remaining, setRemaining] = useState(0);
  const send = async (id: string) => {
    setBusy(true); setError('');
    try { const result = await campusSmsAction(id, 'send'); setRemaining(result.retryAfter ?? 60); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  useEffect(() => {
    const receive = (event: Event) => {
      const next = (event as CustomEvent<SmsRequest>).detail;
      if (request) { next.reject(new Error('已有短信验证正在进行')); return; }
      setRequest(next); setCode(''); setError(''); setRemaining(0);
      void send(next.challengeId);
    };
    window.addEventListener(eventName, receive);
    return () => window.removeEventListener(eventName, receive);
  }, [request]);
  useEffect(() => {
    if (!request) return;
    const timer = setInterval(() => setRemaining(value => Math.max(0, value - 1)), 1000);
    return () => clearInterval(timer);
  }, [request]);
  if (!request) return null;
  const cancel = () => { request.reject(new Error('已取消短信验证')); setRequest(null); };
  return <div className="campus-sms-overlay"><form className="campus-sms-dialog" role="dialog" aria-modal="true" aria-labelledby="campus-sms-title" onSubmit={async event => {
    event.preventDefault(); if (busy || !code.trim()) return;
    setBusy(true); setError('');
    try { await campusSmsAction(request.challengeId, 'verify', code.trim()); request.resolve(); setRequest(null); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }}>
    <h2 id="campus-sms-title">校园短信验证</h2>
    <p className="inspector-description">输入校园账号绑定手机收到的验证码，5 分钟内有效。</p>
    <label>短信验证码<input autoFocus inputMode="numeric" autoComplete="one-time-code" value={code} onChange={event => setCode(event.target.value)} onCompositionStart={ime.onCompositionStart} onCompositionEnd={ime.onCompositionEnd} onKeyDown={event => { if (event.key === 'Enter' && ime.isComposing(event)) event.preventDefault(); }} /></label>
    {error && <p className="disk-error" role="alert">{error}</p>}
    <div className="campus-sms-actions"><button type="button" className="disk-action" disabled={busy || remaining > 0} onClick={() => void send(request.challengeId)}>{remaining ? `${remaining} 秒后重发` : '重新发送'}</button><button type="button" className="disk-action" onClick={cancel} disabled={busy}>取消</button><button type="submit" className="disk-action" disabled={busy || !code.trim()}>{busy ? '处理中…' : '验证并继续'}</button></div>
  </form></div>;
}

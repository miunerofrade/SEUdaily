import { useCallback, useEffect, useState } from 'react';

type VpnState = { state: string; message: string; httpProxy?: string; configuredPort?: number; smsResend?: boolean; smsRetryAfter?: number };
function checkResponse(response: Response) {
  if (response.status === 404) throw new Error('后端尚未加载 VPN 接口，请重启 SEUdaily 后端');
  if (!response.ok) throw new Error(`VPN 接口请求失败（HTTP ${response.status}）`);
}
export function useVpn(active: boolean) {
  const [state, setState] = useState<VpnState>({ state: 'disconnected', message: '未连接' });
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch('/app/vpn', { signal });
      checkResponse(response);
      const data = await response.json();
      if (!signal?.aborted) { setState(data); setError(''); }
    } catch (cause) { if (!signal?.aborted) setError((cause as Error).message); }
  }, []);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void refresh(controller.signal);
    const timer = setInterval(() => void refresh(controller.signal), 3000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [active, refresh]);
  const run = async (action: 'connect' | 'disconnect' | 'status' | 'verify' | 'resend', code?: string, port?: number) => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      if (action === 'status') { await refresh(); return; }
      const response = await fetch('/app/vpn', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, code, port }) });
      checkResponse(response);
      const result = await response.json();
      if (!response.ok || result.status !== 'completed') throw new Error(result.summary || result.error || 'VPN 操作失败');
      setState(result.data);
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  return { state, error, busy, run };
}
export function VpnPanel({ controller }: { controller: ReturnType<typeof useVpn> }) {
  const { state, error, busy, run } = controller;
  const [code, setCode] = useState('');
  const [port, setPort] = useState('11081');
  useEffect(() => { if (state.configuredPort) setPort(String(state.configuredPort)); }, [state.configuredPort]);
  const active = ['connecting', 'auth_required', 'verification_required', 'connected'].includes(state.state);
  return <section className="inspector-section vpn-section">
    <div className="section-title"><span>校园 VPN</span><button type="button" className="disk-action" disabled={busy} onClick={() => void run(active ? 'disconnect' : 'connect', undefined, active ? undefined : Number(port))}>{busy ? '处理中…' : active ? '断开' : '连接'}</button></div>
    <p className="inspector-description">使用已保存的校园账号，额外验证按提示完成。</p>
    <p className="vpn-status" role="status">{state.state === 'connected' ? '已连接' : state.message}</p>
    <label className="vpn-port-row"><span>代理端口</span><input type="number" aria-label="VPN 代理端口" min={1024} max={65535} value={port} disabled={active || busy} onChange={event => setPort(event.target.value)} /></label>
    {state.state === 'verification_required' && <form onSubmit={event => { event.preventDefault(); void run('verify', code); setCode(''); }}><input type="password" aria-label="VPN 验证码" autoComplete="one-time-code" value={code} onChange={event => setCode(event.target.value)} />{state.smsResend && <button type="button" disabled={busy || Boolean(state.smsRetryAfter)} onClick={() => void run('resend')}>{state.smsRetryAfter ? `${state.smsRetryAfter} 秒后重发` : '重发短信'}</button>}<button type="submit" disabled={busy || !code}>验证</button></form>}
    {error && <p className="disk-error" role="alert">{error}</p>}
  </section>;
}
export function VpnLicense() {
  return <p className="vpn-license">zju-connect · AGPL-3.0 · <a href="https://github.com/Mythologyli/zju-connect/tree/5d7f5b11fcf231f72a0ec0d888bf0f2eadcce1da" target="_blank" rel="noreferrer">源码</a> · <a href="https://github.com/Mythologyli/zju-connect/blob/5d7f5b11fcf231f72a0ec0d888bf0f2eadcce1da/LICENSE" target="_blank" rel="noreferrer">许可</a></p>;
}
export function VpnSettings() {
  const controller = useVpn(true);
  return <section className="settings-card"><VpnPanel controller={controller} /><VpnLicense /></section>;
}

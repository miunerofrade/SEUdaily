import { useCallback, useEffect, useState } from 'react';

type VpnState = { state: string; message: string; httpProxy?: string; configuredPort?: number };
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
  const run = async (action: 'connect' | 'disconnect' | 'status' | 'verify', code?: string, port?: number) => {
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
    <p className="inspector-description">使用已保存的校园账号。首次连接下载约 5–6 MB 核心，验证码在登录窗口完成。校园请求使用本地代理。</p>
    <p className="inspector-description">VPN 核心 zju-connect 使用 AGPL-3.0：<a href="https://github.com/Mythologyli/zju-connect/tree/5d7f5b11fcf231f72a0ec0d888bf0f2eadcce1da" target="_blank" rel="noreferrer">对应源码</a> · <a href="https://github.com/Mythologyli/zju-connect/blob/5d7f5b11fcf231f72a0ec0d888bf0f2eadcce1da/LICENSE" target="_blank" rel="noreferrer">许可证</a></p>
    <p role="status">{state.message}</p>
    <label>HTTP 代理端口 <input type="number" aria-label="VPN 代理端口" min={1024} max={65535} value={port} disabled={active || busy} onChange={event => setPort(event.target.value)} /></label>
    <p className="inspector-description">支持 HTTP 和 HTTPS CONNECT；更换端口请先断开，再修改并连接。</p>
    <p>HTTP 代理地址：<code>{active && state.httpProxy ? state.httpProxy : `http://127.0.0.1:${port}`}</code>{state.state !== 'connected' && '（未连接）'}</p>
    {state.state === 'verification_required' && <form onSubmit={event => { event.preventDefault(); void run('verify', code); setCode(''); }}><input type="password" aria-label="VPN 验证码" autoComplete="one-time-code" value={code} onChange={event => setCode(event.target.value)} /><button type="submit" disabled={busy || !code}>验证</button></form>}
    {error && <p className="disk-error" role="alert">{error}</p>}
  </section>;
}
export function VpnSettings() {
  const controller = useVpn(true);
  return <section className="settings-card"><VpnPanel controller={controller} /></section>;
}

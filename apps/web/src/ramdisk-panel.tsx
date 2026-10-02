import { useEffect, useState } from 'react';

type DiskState = {
  mounted: boolean;
  platform: string;
  backend: string;
  path: string | null;
  capacityBytes: number;
  usedBytes: number;
  availableBytes: number;
  activeTasks: number;
};
const bytes = (value: number) => value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(2)} GB` : `${(value / 1024 ** 2).toFixed(1)} MB`;

export function RamDiskPanel({ active }: { active: boolean }) {
  const [state, setState] = useState<DiskState>();
  const [size, setSize] = useState('1G');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const refresh = async () => {
      try {
        const response = await fetch('/app/ramdisk', { signal: controller.signal });
        if (!response.ok) throw new Error('暂时无法读取内存盘状态');
        const data = await response.json() as DiskState;
        if (!stopped) setState(data);
      } catch (cause) {
        if (!stopped) setError(cause instanceof Error ? cause.message : '状态读取失败');
      } finally {
        if (!stopped) timer = setTimeout(refresh, 15000);
      }
    };
    void refresh();
    return () => { stopped = true; controller.abort(); clearTimeout(timer); };
  }, [active]);
  const change = async () => {
    setBusy(true); setError('');
    try {
      const response = await fetch('/app/ramdisk', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: state?.mounted ? 'unmount' : 'mount', size }) });
      const result = await response.json();
      if (!response.ok || result.status !== 'completed') throw new Error(result.summary || result.error || '内存盘操作失败');
      setState(result.data);
      // Windows UAC creates the disk asynchronously.
      if (!result.data?.mounted && result.summary?.includes('弹窗')) setError('请完成系统授权后等待状态刷新。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '内存盘操作失败');
    } finally { setBusy(false); }
  };
  return <section className="inspector-section ramdisk-section">
    <div className="section-title"><span>内存盘</span><span className="disk-state">{state ? state.mounted ? '已启用' : '未启用' : '读取中'}</span></div>
    <p className="inspector-description">用于媒体临时文件。macOS / Linux 退出服务后自动卸载。</p>
    <div className="disk-control-row"><label htmlFor="ramdisk-size">容量</label><select id="ramdisk-size" value={size} onChange={event => setSize(event.target.value)} disabled={busy || state?.mounted}><option value="512M">512 MB</option><option value="1G">1 GB</option><option value="2G">2 GB</option><option value="4G">4 GB</option></select><button type="button" className="disk-action" disabled={busy || !state || Boolean(state.activeTasks)} onClick={() => void change()}>{busy ? '处理中…' : state?.mounted ? '卸载' : '启用'}</button></div>
    {state?.mounted && <dl className="disk-details"><div><dt>已用 / 可用</dt><dd>{bytes(state.usedBytes)} / {bytes(state.availableBytes)}</dd></div><div><dt>处理任务</dt><dd>{state.activeTasks}</dd></div><div><dt>位置</dt><dd>{state.path}</dd></div></dl>}
    {state?.platform === 'linux' && !state.mounted && <p className="inspector-description">挂载需要 root 权限或已授权的 sudo。</p>}
    {error && <p className="disk-error" role="status">{error} 媒体处理可继续使用普通临时目录。</p>}
  </section>;
}

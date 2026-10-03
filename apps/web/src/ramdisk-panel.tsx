import { Share } from 'lucide-react';
import type { RamDiskController } from './ramdisk';

const bytes = (value: number) => value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(2)} GB` : `${(value / 1024 ** 2).toFixed(1)} MB`;

export function RamDiskPanel({ controller }: { controller: RamDiskController }) {
  const { state, size, setSize, busy, error, run } = controller;
  const revealLabel = state?.platform === 'darwin' ? '在 Finder 中显示' : state?.platform === 'win32' ? '在文件资源管理器中显示' : '在文件管理器中显示';
  return <section className="inspector-section ramdisk-section">
    <div className="section-title"><span>内存盘</span><span className="disk-state">{state ? state.mounted ? '已启用' : '未启用' : '读取中'}</span></div>
    <p className="inspector-description">容量支持 64 MB–64 GB。/ramdisk 768M、status、unmount、reveal。用于媒体临时文件。macOS / Linux 退出服务后自动卸载。</p>
    <div className="disk-control-row"><label htmlFor="ramdisk-size">容量</label><input id="ramdisk-size" aria-label="内存盘容量" list="ramdisk-sizes" value={size} onChange={event => setSize(event.target.value)} disabled={busy || state?.mounted} placeholder="如 768M / 1.5G" /><datalist id="ramdisk-sizes"><option value="512M"/><option value="1G"/><option value="2G"/><option value="4G"/></datalist><button type="button" className="disk-action" disabled={busy || !state || Boolean(state.activeTasks)} onClick={() => void run(state?.mounted ? 'unmount' : size)}>{busy ? '处理中…' : state?.mounted ? '卸载' : '启用'}</button></div>
    {state?.mounted && <dl className="disk-details"><div><dt>已用 / 可用</dt><dd>{bytes(state.usedBytes)} / {bytes(state.availableBytes)}</dd></div><div><dt>处理任务</dt><dd>{state.activeTasks}</dd></div><div><dt>位置</dt><dd className="disk-location"><span title={state.path ?? undefined}>…/{state.path?.split(/[\\/]/).filter(Boolean).at(-1)}</span><button type="button" className="disk-reveal" title={revealLabel} aria-label={revealLabel} disabled={busy} onClick={() => void run('reveal')}><Share size={15} /></button></dd></div></dl>}
    {state?.platform === 'linux' && !state.mounted && <p className="inspector-description">挂载需要 root 权限或已授权的 sudo。</p>}
    {error && <p className="disk-error" role="status">{error} 媒体处理可继续使用普通临时目录。</p>}
  </section>;
}

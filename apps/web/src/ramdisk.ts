import { useCallback, useEffect, useRef, useState } from 'react';
import { diskSize } from '../../../src/shared/disk-size';
export type DiskState = {
  mounted: boolean; platform: string; backend: string; path: string | null;
  capacityBytes: number; usedBytes: number; availableBytes: number; activeTasks: number;
};
export function useRamDisk(active: boolean) {
  const [state, setState] = useState<DiskState>();
  const [size, setSize] = useState('1G');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const revision = useRef(0), operating = useRef(false);
  const accept = useCallback((data: DiskState) => {
    setState(data);
    if (data.mounted && data.capacityBytes) setSize(`${Math.round(data.capacityBytes / 1024 ** 2)}M`);
  }, []);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const version = ++revision.current;
    try {
      const response = await fetch('/app/ramdisk', { signal });
      if (!response.ok) throw new Error('暂时无法读取内存盘状态');
      const data = await response.json();
      if (version === revision.current && !signal?.aborted) { accept(data); setError(''); }
    } catch (cause) {
      if (version === revision.current && !signal?.aborted) setError((cause as Error).message);
    }
  }, [accept]);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void refresh(controller.signal);
    const timer = setInterval(() => { if (!operating.current) void refresh(controller.signal); }, 5000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [active, refresh]);
  const run = async (command = 'status') => {
    if (operating.current) return;
    operating.current = true; ++revision.current; setBusy(true); setError('');
    try {
      const text = command.trim();
      if (!text || text === 'status') { await refresh(); return; }
      const action = text === 'unmount' ? 'unmount' : text === 'reveal' ? 'reveal' : 'mount';
      const capacity = action === 'mount' ? diskSize(text.replace(/^mount\s+/i, '')) : undefined;
      if (capacity) setSize(capacity);
      const response = await fetch(action === 'reveal' ? '/app/ramdisk/reveal' : '/app/ramdisk', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, size: capacity }),
      });
      const result = await response.json();
      if (!response.ok || result.status !== 'completed') throw new Error(result.summary || result.error || '内存盘操作失败');
      if (action === 'reveal') await refresh();
      else { ++revision.current; accept(result.data); }
      if (!result.data?.mounted && result.summary?.includes('弹窗')) setError('请完成系统授权，面板会自动刷新状态。');
    } catch (cause) { setError((cause as Error).message); }
    finally { operating.current = false; setBusy(false); }
  };
  return { state, size, setSize, busy, error, run };
}
export type RamDiskController = ReturnType<typeof useRamDisk>;

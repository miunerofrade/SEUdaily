import { useEffect, useRef, useState } from 'react';
import { Check, LoaderCircle, TriangleAlert, X } from 'lucide-react';

type PreparationEvent = { id: number; name: string; state: string; message: string };

export function RuntimePreparationNotice() {
  const [notice, setNotice] = useState<PreparationEvent | null>(null);
  const cursor = useRef<number | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let expiry = 0;
    async function poll() {
      try {
        const response = await fetch('/app/runtime/preparation', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(4000)]) });
        if (!response.ok) return;
        const snapshot = await response.json();
        const events: PreparationEvent[] = snapshot.events ?? [];
        if (controller.signal.aborted) return;
        const latest = events.at(-1);
        if (cursor.current === null) {
          cursor.current = latest?.id ?? 0;
          const pending = events.filter(event => snapshot[event.name]?.state === 'preparing').at(-1);
          if (pending) setNotice(pending);
          return;
        }
        if (latest && latest.id > cursor.current) {
          cursor.current = latest.id;
          setNotice(latest);
          expiry = latest.state === 'ready' ? Date.now() + 6000 : 0;
        } else if (expiry && Date.now() >= expiry) {
          setNotice(null);
          expiry = 0;
        }
      } catch { /* Keep an in-progress notice during a transient connection failure. */ }
    }
    let timer: ReturnType<typeof setTimeout>;
    const next = async () => {
      await poll();
      if (!controller.signal.aborted) timer = setTimeout(next, 1000);
    };
    void next();
    return () => { controller.abort(); clearTimeout(timer); };
  }, []);
  if (!notice) return null;
  return <div className={`runtime-preparation-notice ${notice.state}`} role={notice.state === 'failed' ? 'alert' : 'status'}>
    {notice.state === 'preparing' ? <LoaderCircle className="runtime-preparation-spinner" size={17} /> : notice.state === 'failed' ? <TriangleAlert size={17} /> : <Check size={17} />}
    <span>{notice.message}</span>
    {notice.state !== 'preparing' && <button type="button" className="icon-button" aria-label="关闭准备提示" onClick={() => setNotice(null)}><X size={16} /></button>}
  </div>;
}

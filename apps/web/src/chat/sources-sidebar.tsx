import {BookOpen,Link2,X} from "lucide-react";
import {useEffect,useRef} from "react";
import {libraryPreviewUrl} from "../api";
import type {Citation} from "../types";
export {messageSources} from "./sources";


export function SourcesSidebar({ sources, onClose }: { sources: Citation[]; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    closeRef.current?.focus({ preventScroll: true });
    return () => { if (trigger?.isConnected) trigger.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => {
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); onClose(); } };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [onClose]);
  const groups = [{ label: "文件", items: sources.filter(source => !source.url) }, { label: "网页", items: sources.filter(source => source.url) }];
  return <aside id="message-sources-panel" className="sources-sidebar" aria-label="回复来源">
    <header><h2>来源 <span>{sources.length}</span></h2><button ref={closeRef} type="button" className="icon-button" aria-label="关闭来源" title="关闭来源" onClick={onClose}><X size={19} /></button></header>
    <div className="sources-sidebar-scroll">{groups.filter(group => group.items.length).map(group => <section key={group.label}><h3>{group.label} · {group.items.length}</h3>{group.items.map((source, index) => {
      const href = source.url ?? (source.localPath ? libraryPreviewUrl(source.localPath) : undefined);
      let origin = "本地文件";
      if (source.url) { try { origin = new URL(source.url).hostname; } catch { origin = "网页"; } }
      const content = <><div className="source-origin">{source.url ? <Link2 size={15} /> : <BookOpen size={15} />}<span>{origin}</span></div><strong>{source.title}</strong>{source.locator && <small>{source.locator}</small>}</>;
      return href ? <a className="source-entry" key={`${source.id}-${index}`} href={href} target="_blank" rel="noreferrer">{content}</a> : <div className="source-entry" key={`${source.id}-${index}`}>{content}</div>;
    })}</section>)}</div>
  </aside>;
}

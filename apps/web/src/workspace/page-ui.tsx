import {LoaderCircle} from "lucide-react";
import type {ReactNode} from "react";

export function PageHeader({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return <div className="workspace-page-head"><div><h1>{title}</h1>{description && <p>{description}</p>}</div>{action}</div>;
}


export function PageState({ loading, error, children }: { loading: boolean; error: string; children: ReactNode }) {
  if (loading) return <div className="page-state"><LoaderCircle className="spin" size={20} /><span>正在读取数据…</span></div>;
  if (error) return <div className="page-state error"><span>{error}</span></div>;
  return <>{children}</>;
}


import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import {Check} from "lucide-react";
import {isValidElement,useState,type ReactNode} from "react";
import rehypeKatex from "rehype-katex";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import {normalizeMathMarkdown} from "../markdown";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("css", css);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("python", python);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("xml", xml);

const languageAliases: Record<string, string> = {
  html: "xml", js: "javascript", jsx: "javascript", md: "markdown", py: "python",
  sh: "bash", shell: "bash", ts: "typescript", tsx: "typescript", vue: "xml",
};


function textFromNode(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textFromNode).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textFromNode(node.props.children);
  return "";
}

export function CopyButton({ text, label = "复制", iconOnly = false }: { text: string; label?: string; iconOnly?: boolean }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const input = document.createElement("textarea");
      input.value = text;
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      input.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return <button type="button" className={`copy-button ${iconOnly ? "icon-only" : ""}`} onClick={copy} aria-label={copied ? "已复制" : label} title={copied ? "已复制" : label}>{copied ? <Check size={14} /> : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 8V6a3 3 0 0 1 3-3h6a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3h-2" /><rect x="3" y="8" width="13" height="13" rx="3" /></svg>}{!iconOnly && <span>{copied ? "已复制" : label}</span>}</button>;
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const code = textFromNode(children).replace(/\n$/, "");
  const child = Array.isArray(children) ? children[0] : children;
  const className = isValidElement<{ className?: string }>(child) ? child.props.className ?? "" : "";
  const requestedLanguage = className.match(/language-([\w-]+)/)?.[1]?.toLowerCase();
  const language = requestedLanguage ? languageAliases[requestedLanguage] ?? requestedLanguage : undefined;
  const highlighted = language && hljs.getLanguage(language)
    ? hljs.highlight(code, { language }).value
    : hljs.highlightAuto(code).value;
  return (
    <div className="code-block">
      <div className="code-toolbar"><span>{requestedLanguage ?? "代码"}</span><CopyButton text={code} label="复制代码" iconOnly /></div>
      <pre><code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted }} /></pre>
    </div>
  );
}

export function MarkdownContent({ text }: { text: string }) {
  return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} components={{
    pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
    a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer">{children}</a>,
    table: ({ children }) => <div className="table-scroll"><table>{children}</table></div>,
  }}>{normalizeMathMarkdown(text)}</ReactMarkdown></div>;
}

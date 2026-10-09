import { KnowledgePanel } from '../knowledge-panel';

import { ArrowLeft, ChevronRight, ExternalLink, File, FileAudio, FileImage, Presentation, FileSpreadsheet, FileText, FileType, FileVideo, Folder, LoaderCircle, RefreshCw, Trash2, UserRound, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import rehypeKatex from "rehype-katex";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

import { deleteLibraryFile, fetchLibrary, libraryPreviewUrl, type LibraryFile } from "../api";
import { normalizeMathMarkdown } from "../markdown";

import { PageHeader, PageState } from "./page-ui";

export function LibraryPage() {
  const [files, setFiles] = useState<LibraryFile[]>([]);
  const [category, setCategory] = useState("");
  const [knowledgeOpen, setKnowledgeOpen] = useState(false);
  const [source, setSource] = useState("");
  const [section, setSection] = useState("");
  const [fileSearch,setFileSearch]=useState("");
  const [notice,setNotice]=useState("");
  const [sources,setSources]=useState<{id:string;label:string}[]>([]);
  const [sections,setSections]=useState<{id:string;label:string}[]>([]);
  const [notices,setNotices]=useState<{id:string;label:string}[]>([]);
  const [courses,setCourses]=useState<{id:string;label:string}[]>([]);
  const [teachers,setTeachers]=useState<{id:string;label:string}[]>([]);
  const [count,setCount]=useState(0),[cursor,setCursor]=useState<string|null>(null);
  const requestVersion=useRef(0),loadedExtra=useRef(false);
  const [widths,setWidths]=useState<Record<number,number>>(()=>{try{return JSON.parse(localStorage.getItem('seudaily-library-widths') || '{}');}catch{return {};}});
  const dragCleanup=useRef<(()=>void)|null>(null);
  useEffect(()=>()=>dragCleanup.current?.(),[]);
  useEffect(()=>{localStorage.setItem('seudaily-library-widths',JSON.stringify(widths));},[widths]);
  const [course, setCourse] = useState("");
  const [teacher, setTeacher] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<LibraryFile | null>(null);
  const [selectedFilePath, setSelectedFilePath] = useState("");
  const [previewTarget, setPreviewTarget] = useState<LibraryFile | null>(null);
  const [previewText, setPreviewText] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const categories = [{id:"documents",label:"上传文件"}, {id:"references",label:"参考资料"}, {id:"web",label:"网页与通知"}, { id: "knowledge", label: "课程笔记" }, { id: "subtitle", label: "课程字幕" }, { id: "media", label: "课程媒体" }, { id: "images", label: "临时图片" }];
  const options=useMemo(()=>({category,source,section,notice,course,teacher,query:fileSearch.trim()}),[category,source,section,notice,course,teacher,fileSearch]);
  const load = useCallback(async (quiet=false,append=false) => {
    const version=++requestVersion.current;loadedExtra.current=append;if(!quiet)setLoading(true);setError("");
    try {
      const response=await fetchLibrary({...options,...(append && cursor?{cursor}:{})});
      if(version!==requestVersion.current)return;
      if(response.level==='sources')setSources(response.directories);
      if(response.level==='sections')setSections(response.directories);
      if(response.level==='notices')setNotices(response.directories);
      if(response.level==='courses')setCourses(response.directories);
      if(response.level==='teachers')setTeachers(response.directories);
      setFiles(previous=>append?[...new Map([...previous,...response.files].map(file=>[file.path,file])).values()]:response.files);
      setCount(response.count);setCursor(response.nextCursor || null);
    }catch(reason){if(version===requestVersion.current && !quiet)setError(reason instanceof Error?reason.message:'资料读取失败');}
    finally{if(version===requestVersion.current)setLoading(false);}
  },[options,cursor]);
  const loadRef=useRef(load);loadRef.current=load;
  useEffect(()=>{void loadRef.current();return ()=>{requestVersion.current++;};},[options]);
  useEffect(()=>{const timer=setInterval(()=>{if(!document.hidden && !loadedExtra.current)void loadRef.current(true);},10_000);return ()=>clearInterval(timer);},[]);
  const flatCategory=["documents","images"].includes(category);
  const displayFiles=files;
  const columnCount=category==='web'?(notice?5:section?4:source?3:2):category==='references'?(course?3:2):flatCategory?2:1+(category?1:0)+(course?1:0)+(teacher?1:0);
  function chooseCategory(next:string){setCategory(next);setSource("");setSection("");setNotice("");setCourse("");setTeacher("");setSelectedFilePath("");}
  function chooseCourse(next:string){setCourse(next);setTeacher("");setSelectedFilePath("");}
  function resizeHandle(index:number){return <div className="browser-column-resize" role="separator" aria-orientation="vertical" aria-label={`调整第${index+1}栏宽度`} tabIndex={0} onKeyDown={event=>{if(!['ArrowLeft','ArrowRight'].includes(event.key))return;event.preventDefault();const width=event.currentTarget.parentElement!.getBoundingClientRect().width;setWidths(current=>({...current,[index]:Math.max(160,Math.min(800,width+(event.key==='ArrowRight'?16:-16)))}));}} onMouseDown={event=>{event.preventDefault();dragCleanup.current?.();const x=event.clientX,width=event.currentTarget.parentElement!.getBoundingClientRect().width;const move=(next:MouseEvent)=>setWidths(current=>({...current,[index]:Math.max(160,Math.min(800,width+next.clientX-x))}));const end=()=>{document.removeEventListener('mousemove',move);document.removeEventListener('mouseup',end);dragCleanup.current=null;};dragCleanup.current=end;document.addEventListener('mousemove',move);document.addEventListener('mouseup',end);}}/>;}
  function columnStyle(index:number){return widths[index]?{flex:`0 0 ${Math.max(160,Math.min(800,widths[index]))}px`}:undefined;}

  async function openPreview(file: LibraryFile) {
    setPreviewTarget(file); setPreviewText(""); setPreviewError("");
    if (!["TXT", "MD"].includes(file.type)) return;
    setPreviewLoading(true);
    try {
      const response = await fetch(libraryPreviewUrl(file.path));
      if (!response.ok) throw new Error((await response.text()) || "文件预览失败");
      setPreviewText(await response.text());
    } catch (reason) { setPreviewError(reason instanceof Error ? reason.message : "文件预览失败"); }
    finally { setPreviewLoading(false); }
  }
  async function removeFile() {
    if (!deleteTarget || deleting) return;
    setDeleting(true); setError("");
    try { await deleteLibraryFile(deleteTarget.path); setFiles((current) => current.filter((file) => file.path !== deleteTarget.path)); if (previewTarget?.path === deleteTarget.path) setPreviewTarget(null); if (selectedFilePath === deleteTarget.path) setSelectedFilePath(""); setDeleteTarget(null); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "文件删除失败"); }
    finally { setDeleting(false); }
  }

  return <div className="workspace-page library-page">
    <PageHeader title="资料库" description="" action={<div className="schedule-actions"><button className="page-action" aria-expanded={knowledgeOpen} onClick={() => setKnowledgeOpen(current => !current)}>{knowledgeOpen ? "收起搜索" : "搜索资料"}</button><button className="page-action" disabled={loading} onClick={() => void load()}><RefreshCw size={15} />刷新</button></div>} />
    {knowledgeOpen && <KnowledgePanel />}
    <div className="library-file-search"><input type="search" aria-label="搜索文件名" placeholder="搜索文件名" value={fileSearch} onChange={event=>setFileSearch(event.target.value)}/>{fileSearch && <button type="button" onClick={()=>setFileSearch("")}>清空</button>}</div>
    <PageState loading={loading} error={error}>
      {fileSearch.trim() ? <div className="library-file-search-results"><p>找到 {count} 个文件</p>{files.map(file=><button key={file.path} title={`${file.name} · ${file.type}`} onClick={()=>void openPreview(file)}><LibraryFileIcon file={file}/><span><strong>{friendlyFileName(file)}</strong><small>{file.sections?.map(item=>`${item.source} / ${item.label}`).join('、') || file.course}</small></span></button>)}{!files.length && <div className="browser-column-empty">没有匹配的文件</div>}</div> : <div className={`column-browser columns-${columnCount}`} onKeyDown={event=>{const file=files.find(item=>item.path===selectedFilePath);if(file && event.key===' '){event.preventDefault();void openPreview(file);}}}>
        <div className="browser-column" style={columnStyle(0)}><div className="browser-column-list">{categories.map(item=><button key={item.id} className={category===item.id?'selected':''} onClick={()=>chooseCategory(item.id)}><Folder size={17}/><span>{item.label}</span><ChevronRight size={15}/></button>)}</div>{resizeHandle(0)}</div>
        {category==='web' && <div className="browser-column" style={columnStyle(1)}><div className="browser-column-list">{sources.map(item=><button key={item.id} className={source===item.id?'selected':''} onClick={()=>{setSource(item.id);setSection('');setNotice('');}}><Folder size={17}/><span>{item.label}</span><ChevronRight size={15}/></button>)}</div>{resizeHandle(1)}</div>}
        {category==='web' && source && <div className="browser-column" style={columnStyle(2)}><div className="browser-column-list">{sections.map(item=><button key={item.id} className={section===item.id?'selected':''} onClick={()=>{setSection(item.id);setNotice('');}}><Folder size={17}/><span>{item.label}</span><ChevronRight size={15}/></button>)}</div>{resizeHandle(2)}</div>}
        {category==='web' && section && <div className="browser-column" style={columnStyle(3)}><div className="browser-column-list">{notices.map(item=><button key={item.id} title={item.label} className={notice===item.id?'selected':''} onClick={()=>{setNotice(item.id);setSelectedFilePath('');}}><Folder size={17}/><span>{item.label}</span><ChevronRight size={15}/></button>)}</div>{resizeHandle(3)}</div>}
        {category && !flatCategory && category!=='web' && <div className="browser-column" style={columnStyle(1)}><div className="browser-column-list">{courses.map(item=><button key={item.id} className={course===item.id?'selected':''} onClick={()=>chooseCourse(item.id)}><Folder size={17}/><span>{item.label}</span><ChevronRight size={15}/></button>)}</div>{resizeHandle(1)}</div>}
        {course && category!=='web' && category!=='references' && <div className="browser-column" style={columnStyle(2)}><div className="browser-column-list">{teachers.map(item=><button key={item.id} className={teacher===item.id?'selected':''} onClick={()=>{setTeacher(item.id);setSelectedFilePath('');}}><UserRound size={17}/><span>{item.label}</span><ChevronRight size={15}/></button>)}</div>{resizeHandle(2)}</div>}
        {((course && teacher) || (category==='references' && course) || flatCategory || (category==='web' && notice)) && <div className="browser-column browser-file-column" style={columnStyle(columnCount-1)}>
          <div className="browser-column-list">{displayFiles.map(file=><button key={file.path} title={`${file.name} · ${file.type}`} className={selectedFilePath===file.path?'selected':''} aria-selected={selectedFilePath===file.path} onClick={()=>setSelectedFilePath(file.path)} onDoubleClick={()=>void openPreview(file)}><LibraryFileIcon file={file}/><span>{friendlyFileName(file)}</span></button>)}{!files.length && <div className="browser-column-empty">暂无文件</div>}</div>{resizeHandle(columnCount-1)}
        </div>}
      </div>}
      {cursor && <button className="page-action" disabled={loading} onClick={()=>void load(false,true)}>加载更多</button>}
    </PageState>
    {previewTarget && <FilePreview file={previewTarget} text={previewText} loading={previewLoading} error={previewError} onClose={() => setPreviewTarget(null)} />}
    {deleteTarget && <div className="confirm-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !deleting) setDeleteTarget(null); }}><div className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-file-title"><button className="confirm-close" onClick={() => setDeleteTarget(null)} aria-label="关闭"><X size={17} /></button><div className="confirm-icon"><Trash2 size={18} /></div><h2 id="delete-file-title">删除这个文件？</h2><p>“{friendlyFileName(deleteTarget)}”将从本机永久删除，无法恢复。</p><div className="confirm-actions"><button disabled={deleting} onClick={() => setDeleteTarget(null)}>取消</button><button className="danger" disabled={deleting} onClick={() => void removeFile()}>{deleting ? "正在删除…" : "删除"}</button></div></div></div>}
  </div>;
}

function FilePreview({ file, text, loading, error, onClose }: { file: LibraryFile; text: string; loading: boolean; error: string; onClose: () => void }) {
  const url = libraryPreviewUrl(file.path);
  const image = ["PNG", "JPG", "JPEG", "WEBP", "GIF"].includes(file.type);
  const video = ["MP4", "WEBM"].includes(file.type);
  const audio = ["MP3", "M4A", "WAV"].includes(file.type);
  const textFile = ["TXT", "MD"].includes(file.type);
  return <div className="preview-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="file-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="file-preview-title"><header><h2 id="file-preview-title">{friendlyFileName(file)}</h2><a className="preview-download" href={url + "&download=1&name=" + encodeURIComponent(file.name)} download={file.name}>下载原文件</a><a href={url} target="_blank" rel="noreferrer" title="在新窗口打开"><ExternalLink size={16} /></a><button type="button" className="preview-close" aria-label="关闭预览" onClick={onClose}><X size={18} /></button></header><div className="file-preview-content">
    {loading ? <div className="preview-state"><LoaderCircle className="spin" size={22} />正在读取文件…</div> : error ? <div className="preview-state error">{error}</div> : image ? <img src={url} alt={file.name} /> : video ? <video src={url} controls /> : audio ? <audio src={url} controls /> : file.type === "PDF" ? <iframe src={url} title={`${file.name} · ${file.type}`} /> : textFile ? (file.type === "MD" ? <div className="preview-markdown"><ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>{normalizeMathMarkdown(text)}</ReactMarkdown></div> : <pre>{text}</pre>) : <div className="preview-state">该格式暂不支持内嵌预览，可点击右上角在新窗口打开。</div>}
  </div></div></div>;
}

function LibraryFileIcon({file}:{file:LibraryFile}) {
  const Icon=file.type === "PDF" ? FileType : ["MD","TXT","DOC","DOCX"].includes(file.type) ? FileText : ["XLS","XLSX","CSV"].includes(file.type) ? FileSpreadsheet : ["PPT","PPTX"].includes(file.type) ? Presentation : ["PNG","JPG","JPEG","WEBP","GIF"].includes(file.type) ? FileImage : ["MP4","WEBM"].includes(file.type) ? FileVideo : ["MP3","M4A","WAV"].includes(file.type) ? FileAudio : File;
  return <Icon size={17} role="img" aria-label={file.type} className={`library-format-icon format-${file.type.toLowerCase()}`}/>;
}

function friendlyFileName(file: LibraryFile) {
  const match = file.name.match(/^(\d{4})(\d{2})(\d{2})(?:-(\d+))?/);
  if (/_Summary\.md$/i.test(file.name)) return match ? `${match[1]}-${match[2]}-${match[3]} · 课程笔记` : "课程笔记";
  if (/_transcript\.txt$/i.test(file.name)) return match ? `${match[1]}-${match[2]}-${match[3]} · 第 ${match[4] ?? "?"} 段字幕` : "课堂字幕";
  return file.name.replace(/\.[^.]+$/, "");
}


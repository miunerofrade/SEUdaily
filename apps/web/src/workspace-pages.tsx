import { CalendarDays, ChevronLeft, ChevronRight, ExternalLink, FileImage, FileText, Folder, FolderOpen, KeyRound, LoaderCircle, RefreshCw, Settings2, Trash2, UserRound, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import rehypeKatex from "rehype-katex";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

import {
  authorizeSchedule,
  deleteLibraryFile,
  fetchLibrary,
  fetchNotices,
  fetchSchedule,
  fetchSettings,
  libraryPreviewUrl,
  saveSettings,
  type LibraryFile,
  type NoticeItem,
  type ScheduleCourse,
  type SettingsPayload,
} from "./api";
import { normalizeMathMarkdown } from "./markdown";

const weekdays = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];

function PageHeader({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return <div className="workspace-page-head"><div><h1>{title}</h1>{description && <p>{description}</p>}</div>{action}</div>;
}

function defaultAcademicWeek(date = new Date()) {
  const year = date.getMonth() >= 7 ? date.getFullYear() : date.getFullYear() - 1;
  const septemberFirst = new Date(year, 8, 1);
  const offset = (8 - septemberFirst.getDay()) % 7;
  const semesterStart = new Date(year, 8, 1 + offset);
  if (date < semesterStart) return 1;
  return Math.max(1, Math.min(20, Math.floor((date.getTime() - semesterStart.getTime()) / 604_800_000) + 1));
}

function PageState({ loading, error, children }: { loading: boolean; error: string; children: ReactNode }) {
  if (loading) return <div className="page-state"><LoaderCircle className="spin" size={20} /><span>正在读取数据…</span></div>;
  if (error) return <div className="page-state error"><span>{error}</span></div>;
  return <>{children}</>;
}

export function SchedulePage() {
  const [courses, setCourses] = useState<ScheduleCourse[]>([]);
  const [fetchedAt, setFetchedAt] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [week, setWeek] = useState(defaultAcademicWeek);

  const load = useCallback(async (refresh = false) => {
    setLoading(true); setError("");
    try {
      const response = await fetchSchedule(refresh);
      setStatus(response.status);
      setCourses(response.data?.courses ?? []);
      setFetchedAt(response.data?.fetchedAt ?? "");
      if (response.status === "failed") setError(response.summary);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "课表读取失败"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(false); }, [load]);
  const grouped = useMemo(() => {
    const slots = new Map<string, ScheduleCourse[]>();
    for (const course of courses) {
      if (course.weeks?.length && !course.weeks.includes(week)) continue;
      const start = course.startPeriod ?? course.weeklyPeriods?.[0] ?? 1;
      const end = course.endPeriod ?? course.weeklyPeriods?.at(-1) ?? start;
      const key = `${course.weekday}-${start}-${end}`;
      slots.set(key, [...(slots.get(key) ?? []), course]);
    }
    return [...slots.entries()].map(([key, items]) => {
      const [weekday, start, end] = key.split("-").map(Number);
      return { key, weekday, start, end, items };
    });
  }, [courses, week]);

  async function login() {
    setLoading(true); setError("");
    try { await authorizeSchedule(); await load(true); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "课表认证失败"); setLoading(false); }
  }

  return <div className="workspace-page">
    <PageHeader title="课表" description={fetchedAt ? `上次同步：${new Date(fetchedAt).toLocaleString("zh-CN")}` : "直接查看本地课表，需要时再从学校系统同步。"} action={<div className="schedule-actions"><div className="week-picker"><button disabled={week <= 1} onClick={() => setWeek((value) => value - 1)}><ChevronLeft size={15} /></button><select value={week} onChange={(event) => setWeek(Number(event.target.value))}>{Array.from({ length: 20 }, (_, index) => <option key={index + 1} value={index + 1}>第 {index + 1} 周 · {(index + 1) % 2 ? "单周" : "双周"}</option>)}</select><button disabled={week >= 20} onClick={() => setWeek((value) => value + 1)}><ChevronRight size={15} /></button></div><button className="page-action" disabled={loading} onClick={() => void load(true)}><RefreshCw size={15} />同步课表</button></div>} />
    <PageState loading={loading} error={error}>
      {courses.length ? <Timetable slots={grouped} /> : <div className="page-empty"><CalendarDays size={28} /><h2>还没有课表数据</h2><p>先连接东南大学课表系统，完成认证后会保存到本地。</p><button className="page-action primary" onClick={() => void login()}>{status === "auth_required" ? "登录并获取课表" : "获取课表"}</button></div>}
    </PageState>
  </div>;
}

const periodTimes = ["", "08:00–08:45", "08:50–09:35", "09:50–10:35", "10:40–11:25", "11:30–12:15", "14:00–14:45", "14:50–15:35", "15:50–16:35", "16:40–17:25", "17:30–18:15", "19:00–19:45", "19:50–20:35", "20:40–21:25"];

function Timetable({ slots }: { slots: Array<{ key: string; weekday: number; start: number; end: number; items: ScheduleCourse[] }> }) {
  return <div className="timetable-wrap"><div className="timetable">
    <div className="timetable-corner">节次 / 时间</div>
    {weekdays.slice(1).map((day, index) => <div className="timetable-day-head" key={day} style={{ gridColumn: index + 2, gridRow: 1 }}>{day}</div>)}
    {periodTimes.slice(1).map((time, index) => <div className="timetable-time" key={time} style={{ gridColumn: 1, gridRow: index + 2 }}><strong>{index + 1}</strong><span>{time}</span></div>)}
    {weekdays.slice(1).flatMap((_, day) => periodTimes.slice(1).map((__, period) => <div className="timetable-cell" key={`${day}-${period}`} style={{ gridColumn: day + 2, gridRow: period + 2 }} />))}
    {slots.map((slot) => <div className="timetable-slot" key={slot.key} style={{ gridColumn: slot.weekday + 1, gridRow: `${slot.start + 1} / span ${slot.end - slot.start + 1}` }}>
      {slot.items.map((course) => <article className="course-card" key={course.scheduleId}><strong>{course.courseName}</strong><span>{[course.teacherName, course.classroom].filter(Boolean).join(" · ")}</span></article>)}
    </div>)}
  </div></div>;
}

export function LibraryPage() {
  const [files, setFiles] = useState<LibraryFile[]>([]);
  const [category, setCategory] = useState("knowledge");
  const [course, setCourse] = useState("");
  const [teacher, setTeacher] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<LibraryFile | null>(null);
  const [previewTarget, setPreviewTarget] = useState<LibraryFile | null>(null);
  const [previewText, setPreviewText] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const load = useCallback(async () => { setLoading(true); setError(""); try { setFiles((await fetchLibrary()).files); } catch (reason) { setError(reason instanceof Error ? reason.message : "资料读取失败"); } finally { setLoading(false); } }, []);
  useEffect(() => { void load(); }, [load]);
  const categories = [{ id: "knowledge", label: "课程笔记" }, { id: "subtitle", label: "课程字幕" }, { id: "media", label: "课程媒体" }, { id: "images", label: "临时图片" }];
  const visible = files.filter((file) => file.category === category);
  const courses = useMemo(() => [...new Set(visible.map((file) => file.course))].sort((a, b) => a.localeCompare(b, "zh-CN")), [visible]);
  const teachers = useMemo(() => [...new Set(visible.filter((file) => file.course === course).map((file) => file.teacher))].sort((a, b) => a.localeCompare(b, "zh-CN")), [visible, course]);
  const selectedFiles = visible.filter((file) => file.course === course && file.teacher === teacher);

  function chooseCategory(next: string) { setCategory(next); setCourse(""); setTeacher(""); }
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
    try { await deleteLibraryFile(deleteTarget.path); setFiles((current) => current.filter((file) => file.path !== deleteTarget.path)); setDeleteTarget(null); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "文件删除失败"); }
    finally { setDeleting(false); }
  }

  const emptyText = category === "images" ? "在对话输入框点击加号或按 Ctrl+V 粘贴图片后，会暂存在这里。" : "这个目录还没有资料。";
  return <div className="workspace-page library-page">
    <PageHeader title="资料库" description="" action={<button className="page-action" disabled={loading} onClick={() => void load()}><RefreshCw size={15} />刷新</button>} />
    <div className="library-tabs">{categories.map((item) => <button key={item.id} className={category === item.id ? "active" : ""} onClick={() => chooseCategory(item.id)}>{item.label}</button>)}</div>
    <PageState loading={loading} error={error}>
      {visible.length ? <div className="file-browser">
        <div className="file-breadcrumb"><button onClick={() => { setCourse(""); setTeacher(""); }}>资料库</button><ChevronRight size={14} /><button onClick={() => { setCourse(""); setTeacher(""); }}>{categories.find((item) => item.id === category)?.label}</button>{course && <><ChevronRight size={14} /><button onClick={() => setTeacher("")}>{course}</button></>}{teacher && <><ChevronRight size={14} /><span>{teacher}</span></>}</div>
        <div className="file-list">
          {!course && courses.map((item) => <button className="file-row" key={item} onClick={() => setCourse(item)}><Folder size={18} /><span>{item}</span><ChevronRight size={15} /></button>)}
          {course && !teacher && teachers.map((item) => <button className="file-row" key={item} onClick={() => setTeacher(item)}><UserRound size={18} /><span>{item}</span><ChevronRight size={15} /></button>)}
          {course && teacher && selectedFiles.map((file) => <div className="file-row" key={file.path}><button className="file-open" title="预览文件" onClick={() => void openPreview(file)}>{file.category === "images" ? <FileImage size={18} /> : <FileText size={18} />}<span>{friendlyFileName(file)}</span></button><button className="file-delete" aria-label={`删除文件：${friendlyFileName(file)}`} title="删除文件" onClick={() => setDeleteTarget(file)}><Trash2 size={15} /></button></div>)}
        </div>
      </div> : <div className="page-empty"><FolderOpen size={28} /><h2>目录为空</h2><p>{emptyText}</p></div>}
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
  return <div className="preview-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="file-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="file-preview-title"><header><h2 id="file-preview-title">{friendlyFileName(file)}</h2><a href={url} target="_blank" rel="noreferrer" title="在新窗口打开"><ExternalLink size={16} /></a><button type="button" className="preview-close" aria-label="关闭预览" onClick={onClose}><X size={18} /></button></header><div className="file-preview-content">
    {loading ? <div className="preview-state"><LoaderCircle className="spin" size={22} />正在读取文件…</div> : error ? <div className="preview-state error">{error}</div> : image ? <img src={url} alt={file.name} /> : video ? <video src={url} controls /> : audio ? <audio src={url} controls /> : file.type === "PDF" ? <iframe src={url} title={file.name} /> : textFile ? (file.type === "MD" ? <div className="preview-markdown"><ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>{normalizeMathMarkdown(text)}</ReactMarkdown></div> : <pre>{text}</pre>) : <div className="preview-state">该格式暂不支持内嵌预览，可点击右上角在新窗口打开。</div>}
  </div></div></div>;
}

function friendlyFileName(file: LibraryFile) {
  const match = file.name.match(/^(\d{4})(\d{2})(\d{2})(?:-(\d+))?/);
  if (/_Summary\.md$/i.test(file.name)) return match ? `${match[1]}-${match[2]}-${match[3]} · 课程笔记` : "课程笔记";
  if (/_transcript\.txt$/i.test(file.name)) return match ? `${match[1]}-${match[2]}-${match[3]} · 第 ${match[4] ?? "?"} 段字幕` : "课堂字幕";
  return file.name;
}

export function NoticesPage() {
  const [items, setItems] = useState<NoticeItem[]>([]); const [loading, setLoading] = useState(true); const [error, setError] = useState("");
  const load = useCallback(async (refresh = true) => { setLoading(true); setError(""); try { const response = await fetchNotices(refresh); setItems(response.data?.results ?? []); if (response.status === "failed") setError(response.summary); } catch (reason) { setError(reason instanceof Error ? reason.message : "通知读取失败"); } finally { setLoading(false); } }, []);
  useEffect(() => { void load(true); }, [load]);
  return <div className="workspace-page"><PageHeader title="教务通知" description="东南大学教务处的最新动态、教务信息与讲座预告。" action={<button className="page-action" disabled={loading} onClick={() => void load(true)}><RefreshCw size={15} />刷新</button>} /><PageState loading={loading} error={error}>{items.length ? <div className="notice-list">{items.map((item) => <a href={item.url} target="_blank" rel="noreferrer" className="notice-row" key={item.id}><div><strong>{item.title}</strong><span>{item.category ?? "教务处"}</span></div><time>{item.publishedAt ?? ""}</time><ExternalLink size={15} /></a>)}</div> : <div className="page-empty"><FileText size={28} /><h2>暂时没有通知</h2><p>可以稍后刷新，或检查网络连接。</p></div>}</PageState></div>;
}

const fieldLabels: Record<string, string> = { DEEPSEEK_API_KEY: "DeepSeek API Key", DEEPSEEK_MODEL: "模型", TAVILY_API_KEY: "Tavily API Key", CVSTREAM_USERNAME: "统一身份认证账号", CVSTREAM_PASSWORD: "统一身份认证密码", CVSTREAM_ASR_API_KEY: "语音转写 API Key", CVSTREAM_WHISPER_MODEL: "本地 Whisper 模型" };

export function SettingsPage() {
  const [settings, setSettings] = useState<SettingsPayload | null>(null); const [values, setValues] = useState<Record<string, string>>({}); const [loading, setLoading] = useState(true); const [saving, setSaving] = useState(false); const [message, setMessage] = useState(""); const [error, setError] = useState("");
  useEffect(() => { fetchSettings().then((data) => { setSettings(data); setValues(Object.fromEntries(data.fields.map((field) => [field.name, field.value]))); }).catch((reason) => setError(reason instanceof Error ? reason.message : "设置读取失败")).finally(() => setLoading(false)); }, []);
  async function save() { setSaving(true); setMessage(""); setError(""); try { const result = await saveSettings(values); setMessage(result.saved.length ? "设置已保存，重启服务后生效。" : "没有需要保存的新内容。"); } catch (reason) { setError(reason instanceof Error ? reason.message : "设置保存失败"); } finally { setSaving(false); } }
  return <div className="workspace-page settings-page"><PageHeader title="设置" description="配置模型与本机服务使用的环境变量。密钥不会回显到浏览器。" /><PageState loading={loading} error={error}>{settings && <div className="settings-sections"><section className="settings-card"><div className="settings-title"><Settings2 size={18} /><div><h2>模型提供商</h2><p>Provider 暂时由后端固定，不可编辑。</p></div></div><label><span>Provider</span><input value={settings.provider.name} disabled /></label><label><span>API 地址</span><input value={settings.provider.baseUrl} disabled /></label></section><section className="settings-card"><div className="settings-title"><KeyRound size={18} /><div><h2>环境变量</h2><p>已配置的密钥保持为空即可保留原值。</p></div></div>{settings.fields.map((field) => <label key={field.name}><span>{fieldLabels[field.name] ?? field.name}<small>{field.configured ? "已配置" : "未配置"}</small></span><input type={field.secret ? "password" : "text"} value={values[field.name] ?? ""} placeholder={field.secret && field.configured ? "••••••••（留空保持不变）" : field.name} onChange={(event) => setValues((current) => ({ ...current, [field.name]: event.target.value }))} /></label>)}<div className="settings-save"><div>{message && <span className="success-text">{message}</span>}</div><button className="page-action primary" disabled={saving} onClick={() => void save()}>{saving ? "正在保存…" : "保存设置"}</button></div></section></div>}</PageState></div>;
}

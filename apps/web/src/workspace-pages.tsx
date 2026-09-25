import { ArrowLeft, ArrowUp, CalendarDays, CalendarPlus, ChevronLeft, ChevronRight, CircleStop, ExternalLink, FileImage, FileText, Folder, FolderOpen, KeyRound, LoaderCircle, Pencil, Plus, RefreshCw, Save, Settings2, Trash2, TriangleAlert, UserRound, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import rehypeKatex from "rehype-katex";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

import {
  authorizeSchedule,
  claimFocusRun,
  deleteLibraryFile,
  fetchLibrary,
  fetchFocus,
  fetchFocusMessages,
  fetchNotices,
  fetchSchedule,
  fetchSettings,
  libraryPreviewUrl,
  saveSettings,
  saveFocus,
  deleteFocus,
  runFocus,
  recordFocusRun,
  saveScheduleCustomizations,
  saveTrainingPlanCourseStatus,
  fetchTrainingPlans,
  streamAgent,
  type LibraryFile,
  type FocusItem,
  type NoticeItem,
  type ScheduleCourse,
  type ScheduleCustomizations,
  type ScheduleSemesterOption,
  type SettingsPayload,
  type TrainingPlan,
  type TrainingPlanSource,
} from "./api";
import { normalizeMathMarkdown } from "./markdown";
import { addProcessTool, appendProcessText, finalizeProcessAnswer } from "./stream-state";
import type { ChatMessage, StreamEvent, ToolResult, ToolRun } from "./types";

const weekdays = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];

function PageHeader({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return <div className="workspace-page-head"><div><h1>{title}</h1>{description && <p>{description}</p>}</div>{action}</div>;
}

function academicWeek(startDate: string, totalWeeks: number, date = new Date()) {
  if (!startDate) return 1;
  const semesterStart = new Date(`${startDate}T00:00:00`);
  return Math.max(1, Math.min(totalWeeks, Math.floor((date.getTime() - semesterStart.getTime()) / 604_800_000) + 1));
}

const emptyCustomizations: ScheduleCustomizations = {
  version: 1,
  semester: { name: "", startDate: "", totalWeeks: 20 },
  overrides: {},
  customCourses: [],
  dateOverrides: [],
};

type CourseDraft = { courseName: string; teacherName: string; classroom: string; weekday: number; startPeriod: number; endPeriod: number; weeks: string; date: string };
const blankCourseDraft: CourseDraft = { courseName: "", teacherName: "", classroom: "", weekday: 1, startPeriod: 1, endPeriod: 2, weeks: "1-16", date: "" };

function parseWeeks(value: string) {
  const weeks = new Set<number>();
  for (const part of value.split(/[,，\s]+/).filter(Boolean)) {
    const match = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!match) continue;
    const start = Number(match[1]); const end = Number(match[2] ?? match[1]);
    for (let week = start; week <= end; week += 1) if (week > 0 && week <= 30) weeks.add(week);
  }
  return [...weeks].sort((a, b) => a - b);
}

function formatWeeks(weeks?: number[]) {
  return weeks?.join(",") ?? "";
}

function PageState({ loading, error, children }: { loading: boolean; error: string; children: ReactNode }) {
  if (loading) return <div className="page-state"><LoaderCircle className="spin" size={20} /><span>正在读取数据…</span></div>;
  if (error) return <div className="page-state error"><span>{error}</span></div>;
  return <>{children}</>;
}

function trainingCourseSemesterOptions(course: TrainingPlan["courses"][number]) {
  if (course.semesterOptions?.length) return course.semesterOptions;
  const values = course.semester.split(/[,，]/).map((value) => value.trim()).filter(Boolean);
  const labels = course.semesterLabel.split(/[,，]/).map((value) => value.trim()).filter(Boolean);
  if (!values.length) return [{ value: "unassigned", label: "未安排学期" }];
  return values.map((value, index) => ({ value, label: labels[index] || value }));
}

export function ProgramsPage() {
  const [plans, setPlans] = useState<TrainingPlan[]>([]);
  const [source, setSource] = useState<TrainingPlanSource | null>(null);
  const [selectedPlanId, setSelectedPlanId] = useState("");
  const [selectedSemester, setSelectedSemester] = useState("all");
  const [status, setStatus] = useState("");
  const [fetchedAt, setFetchedAt] = useState("");
  const [loading, setLoading] = useState(true);
  const [authorizing, setAuthorizing] = useState(false);
  const [savingCourse, setSavingCourse] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async (refresh = false, preserveSemester = false) => {
    setLoading(true);
    setError("");
    try {
      const response = await fetchTrainingPlans(refresh);
      const nextPlans = (response.data?.plans ?? []).map((plan) => ({
        ...plan,
        currentSemester: plan.currentSemester ?? "",
        currentSemesterLabel: plan.currentSemesterLabel ?? "",
        studyRequirements: plan.studyRequirements ?? [],
        courses: (plan.courses ?? []).map((course) => ({
          ...course,
          status: course.status ?? "unknown",
          options: course.options ?? [],
          choiceNote: course.choiceNote ?? "",
          semesterOptions: course.semesterOptions ?? [],
        })),
      }));
      setStatus(response.status);
      setPlans(nextPlans);
      setSource(response.data?.source ?? null);
      setFetchedAt(response.data?.fetchedAt ?? "");
      setSelectedPlanId((current) => nextPlans.some((plan) => plan.id === current) ? current : nextPlans[0]?.id ?? "");
      if (!preserveSemester) setSelectedSemester("all");
      if (response.status === "failed") setError(response.summary);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "培养方案读取失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const plan = plans.find((item) => item.id === selectedPlanId) ?? plans[0];
  const semesters = useMemo(() => {
    if (!plan) return [];
    const labels = new Map<string, string>();
    for (const course of plan.courses) {
      for (const option of trainingCourseSemesterOptions(course)) labels.set(option.value, option.label);
    }
    return [...labels].sort(([left], [right]) => left === "unassigned" ? 1 : right === "unassigned" ? -1 : left.localeCompare(right));
  }, [plan]);
  const visibleCourses = useMemo(() => {
    if (!plan || selectedSemester === "all") return plan?.courses ?? [];
    return plan.courses.filter((course) => trainingCourseSemesterOptions(course).some((option) => option.value === selectedSemester));
  }, [plan, selectedSemester]);
  const semesterGroups = useMemo(() => {
    type CourseStatus = TrainingPlan["courses"][number]["status"];
    type CourseEntry = { course: TrainingPlan["courses"][number]; status: CourseStatus };
    const groups = new Map<string, { label: string; courses: CourseEntry[] }>();
    const statusForSemester = (course: TrainingPlan["courses"][number], semester: string): CourseStatus => {
      if (semester === "unassigned") return "unscheduled";
      return trainingCourseSemesterOptions(course).find((option) => option.value === semester)?.status ?? course.status ?? "unknown";
    };
    for (const course of visibleCourses) {
      const options = trainingCourseSemesterOptions(course).filter((option) => selectedSemester === "all" || option.value === selectedSemester);
      for (const option of options) {
        const group = groups.get(option.value) ?? { label: option.label, courses: [] };
        group.courses.push({ course, status: statusForSemester(course, option.value) });
        groups.set(option.value, group);
      }
    }
    const natureRank: Record<string, number> = { "必修": 0, "限选": 1, "任选": 2, "通识课程": 3, "通选": 3, "课表课程": 4 };
    for (const group of groups.values()) {
      group.courses.sort((left, right) => {
        const leftCourse = left.course;
        const rightCourse = right.course;
        return (natureRank[leftCourse.nature] ?? 5) - (natureRank[rightCourse.nature] ?? 5)
          || Number(Boolean(leftCourse.isGeneralElective)) - Number(Boolean(rightCourse.isGeneralElective))
          || Number(leftCourse.source === "schedule") - Number(rightCourse.source === "schedule")
          || leftCourse.group.localeCompare(rightCourse.group, "zh-CN")
          || leftCourse.name.localeCompare(rightCourse.name, "zh-CN");
      });
    }
    return [...groups].sort(([left], [right]) => left === "unassigned" ? 1 : right === "unassigned" ? -1 : left.localeCompare(right)).map(([semester, group]) => ({
      semester,
      label: group.label,
      status: group.courses.some((entry) => entry.status === "studying")
        ? "studying" as const
        : group.courses.some((entry) => entry.status === "not_taken")
          ? "not_taken" as const
        : group.courses.every((entry) => entry.status === "completed")
          ? "completed" as const
          : group.courses.every((entry) => entry.status === "unscheduled")
            ? "unscheduled" as const
            : group.courses.every((entry) => entry.status === "unknown")
              ? "unknown" as const
              : "upcoming" as const,
      courses: group.courses,
    }));
  }, [plan, selectedSemester, visibleCourses]);
  const statusLabel = (value: TrainingPlan["courses"][number]["status"]) => ({
    completed: "已完成",
    studying: "学习中",
    not_taken: "未修读",
    upcoming: "未开始",
    unscheduled: "未安排",
    unknown: "待确认",
  })[value];

  async function login() {
    setAuthorizing(true);
    setError("");
    try {
      const response = await authorizeSchedule();
      if (response.status === "completed") await load(true);
      else setError(response.summary || "eHall 授权未完成");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "eHall 授权失败");
    } finally {
      setAuthorizing(false);
    }
  }

  async function setCourseStatus(course: TrainingPlan["courses"][number], semester: string, nextStatus: "auto" | "completed" | "studying" | "not_taken") {
    if (!plan) return;
    const courseId = course.id || course.code || course.name;
    const savingKey = `${courseId}::${semester}`;
    setSavingCourse(savingKey);
    setError("");
    try {
      await saveTrainingPlanCourseStatus({ planId: plan.id, courseId, semester, status: nextStatus });
      await load(false, true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "课程状态保存失败");
    } finally {
      setSavingCourse("");
    }
  }

  return <div className="workspace-page programs-page">
    <PageHeader title="培养方案" description={fetchedAt ? `上次同步：${new Date(fetchedAt).toLocaleString("zh-CN")}` : "来自 eHall 个人方案查询"} action={<button className="page-action" disabled={loading || authorizing} onClick={() => void load(true)}><RefreshCw className={loading ? "spin" : ""} size={15} />同步 eHall</button>} />
    {error && <div className="page-state error">{error}</div>}
    {loading && <div className="page-state"><LoaderCircle className="spin" size={20} /><span>正在同步 eHall 个人培养方案…</span></div>}
    {!loading && status === "auth_required" && <div className="program-auth"><h2>需要登录 eHall</h2><p>培养方案和课表使用同一套登录会话。完成认证后会自动重新同步。</p><button className="page-action primary" disabled={authorizing} onClick={() => void login()}><KeyRound size={15} />{authorizing ? "等待认证" : "登录 eHall"}</button></div>}
    {!loading && status !== "auth_required" && !plan && !error && <div className="page-empty compact"><h2>没有可用的个人培养方案</h2><p>请确认当前 eHall 账号具有“个人方案查询”权限。</p></div>}
    {!loading && plan && <>
      <section className="program-overview">
        <div className="program-overview-head"><div><h2>{plan.title}</h2><p>{[plan.department, plan.grade, plan.major, plan.track].filter(Boolean).join(" · ")}</p></div>{source && <a className="page-action" href={source.url} target="_blank" rel="noreferrer">在 eHall 查看<ExternalLink size={15} /></a>}</div>
        {plans.length > 1 && <label className="program-plan-picker"><span>当前方案</span><select value={plan.id} onChange={(event) => { setSelectedPlanId(event.target.value); setSelectedSemester("all"); }}>{plans.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>}
        <div className="program-metrics"><div><strong>{plan.requiredCredits}</strong><span>最低修读学分</span></div><div><strong>{plan.completedCredits}</strong><span>已完成学分</span></div><div><strong>{plan.creditSummary?.studying ?? 0}</strong><span>在修学分</span></div><div><strong>{plan.creditSummary?.remaining ?? Math.max(0, plan.requiredCredits - plan.completedCredits)}</strong><span>尚需学分</span></div><div><strong>{plan.creditSummary?.generalElectiveCompleted ?? 0}</strong><span>已完成通选学分</span></div><div><strong>{plan.progress}%</strong><span>完成进度</span></div></div>
        <div className="program-progress"><span style={{ width: `${plan.progress}%` }} /></div>
        {source && <p className="program-source">{source.path.join(" / ")} · {source.source}</p>}
      </section>
      {(plan.studyRequirements?.length ?? 0) > 0 && <section className="program-requirements">
        <div className="program-section-heading"><h2>修读要求</h2><span>来自 eHall 培养方案说明</span></div>
        <div className="program-requirement-list">{plan.studyRequirements.map((requirement, index) => <article key={`${requirement.name}-${index}`}>
          <div><strong>{requirement.name}</strong>{requirement.nature && <span>{requirement.nature}</span>}</div>
          <p>{requirement.note}</p>
          {requirement.requiredCredits > 0 && <b>要求 {requirement.requiredCredits} 学分</b>}
        </article>)}</div>
      </section>}
      <section className="program-courses">
        <div className="program-courses-head"><div><h2>指导计划课程</h2><span>共 {visibleCourses.length} 门</span></div><label><span>查看学期</span><select value={selectedSemester} onChange={(event) => setSelectedSemester(event.target.value)}><option value="all">全部学期</option>{semesters.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
        <div className="program-course-scroll"><div className="program-course-table">
          <div className="program-course-row header"><span>课程</span><span>课程组</span><span>性质</span><span>学分</span><span>状态</span></div>
          {semesterGroups.map((group) => <section className="program-semester" key={group.semester}>
            <div className="program-semester-heading"><div><strong>{group.label}</strong><span>{group.courses.length} 门课程</span></div><span className={`program-status ${group.status}`}>{statusLabel(group.status)}</span></div>
            {group.courses.map(({ course, status: courseStatus }, index) => {
              const option = trainingCourseSemesterOptions(course).find((item) => item.value === group.semester);
              const courseId = course.id || course.code || course.name;
              const savingKey = `${courseId}::${group.semester}`;
              return <div className="program-course-row" key={`${course.id || course.code}-${group.semester}-${index}`}>
              <span><strong>{course.name}</strong>{(course.code || course.choiceNote) && <small>{[course.code, course.choiceNote].filter(Boolean).join(" · ")}</small>}</span>
              <span>{course.group || "未分类"}</span>
              <span className={`program-nature ${course.nature === "必修" ? "required" : "elective"}`}>{course.nature || course.assessment || "-"}</span>
              <span>{course.credits}</span>
              <label className={`program-status-editor ${option?.manualStatus ? "manual" : ""}`} title={option?.manualStatus ? "手动设置；可切回自动判断" : "按课表同步结果自动判断"}>
                <select disabled={savingCourse === savingKey} value={option?.manualStatus ? courseStatus : "auto"} onChange={(event) => void setCourseStatus(course, group.semester, event.target.value as "auto" | "completed" | "studying" | "not_taken")}>
                  <option value="auto">自动 · {statusLabel(courseStatus)}</option>
                  <option value="completed">手动 · 已完成</option>
                  <option value="studying">手动 · 学习中</option>
                  <option value="not_taken">手动 · 未修读</option>
                </select>
              </label>
            </div>})}
          </section>)}
        </div></div>
      </section>
      {(plan.objective || plan.requirements) && <section className="program-details"><details><summary>培养目标</summary><p>{plan.objective || "未提供"}</p></details><details><summary>毕业要求</summary><p>{plan.requirements || "未提供"}</p></details></section>}
    </>}
  </div>;
}

export function SchedulePage() {
  const [courses, setCourses] = useState<ScheduleCourse[]>([]);
  const [fetchedAt, setFetchedAt] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [week, setWeek] = useState(1);
  const [customizations, setCustomizations] = useState<ScheduleCustomizations>(emptyCustomizations);
  const [editor, setEditor] = useState<{ mode: "edit" | "recurring" | "date"; course?: ScheduleCourse } | null>(null);
  const [draft, setDraft] = useState<CourseDraft>(blankCourseDraft);
  const [saving, setSaving] = useState(false);
  const [semesterSelection, setSemesterSelection] = useState("");
  const [currentSemester, setCurrentSemester] = useState("");
  const [currentSemesterLabel, setCurrentSemesterLabel] = useState("");
  const [selectedSemesterLabel, setSelectedSemesterLabel] = useState("");
  const [semesterOptions, setSemesterOptions] = useState<ScheduleSemesterOption[]>([]);
  const [semestersPrefetched, setSemestersPrefetched] = useState(false);
  const [loadingSemesters, setLoadingSemesters] = useState(false);
  const [semesterError, setSemesterError] = useState("");

  const load = useCallback(async (refresh = false, semester = "") => {
    setLoading(true); setError("");
    if (refresh) setSemesterError("");
    try {
      const response = await fetchSchedule(refresh, semester);
      setStatus(response.status);
      setCourses(response.data?.courses ?? []);
      setFetchedAt(response.data?.fetchedAt ?? "");
      if (response.data?.selectedSemesterLabel) setSelectedSemesterLabel(response.data.selectedSemesterLabel);
      if (response.data?.currentSemester) setCurrentSemester(response.data.currentSemester);
      else if (!semester && response.data?.selectedSemester) setCurrentSemester(response.data.selectedSemester);
      if (response.data?.currentSemesterLabel) setCurrentSemesterLabel(response.data.currentSemesterLabel);
      else if (!semester && response.data?.selectedSemesterLabel) setCurrentSemesterLabel(response.data.selectedSemesterLabel);
      if (response.data?.availableSemesters?.length) setSemesterOptions(response.data.availableSemesters);
      if (response.data?.prefetchedSemesters) setSemestersPrefetched(true);
      if (response.data?.customizations) setCustomizations(response.data.customizations);
      setWeek((current) => semester ? 1 : current === 1 ? academicWeek((response.data?.customizations ?? emptyCustomizations).semester.startDate, (response.data?.customizations ?? emptyCustomizations).semester.totalWeeks) : current);
      if (response.status === "auth_required") setSemesterError(response.summary || "课表登录会话不存在或已失效，请重新登录。");
      else if (["failed", "launch_failed", "semester_switch_failed", "semester_not_found"].includes(response.status)) setError(response.summary);
      else setSemesterError("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "课表读取失败"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(false); }, [load]);

  async function loadSemesterOptions() {
    if (loadingSemesters || semestersPrefetched) return;
    setLoadingSemesters(true);
    setSemesterError("");
    try {
      const response = await fetchSchedule(true, "", true, true);
      if (response.data?.currentSemester) setCurrentSemester(response.data.currentSemester);
      else if (response.data?.selectedSemester) setCurrentSemester(response.data.selectedSemester);
      if (response.data?.currentSemesterLabel) setCurrentSemesterLabel(response.data.currentSemesterLabel);
      else if (response.data?.selectedSemesterLabel) setCurrentSemesterLabel(response.data.selectedSemesterLabel);
      if (response.data?.selectedSemesterLabel && !semesterSelection) setSelectedSemesterLabel(response.data.selectedSemesterLabel);
      setSemesterOptions(response.data?.availableSemesters ?? []);
      if (response.data?.prefetchedSemesters) setSemestersPrefetched(true);
      if (!semesterSelection && response.data?.courses) {
        setCourses(response.data.courses);
        setFetchedAt(response.data.fetchedAt ?? "");
        if (response.data.customizations) setCustomizations(response.data.customizations);
      }
      if (response.status === "failed" || response.status === "auth_required") setSemesterError(response.summary);
    } catch (reason) { setSemesterError(reason instanceof Error ? reason.message : "学期列表读取失败"); }
    finally { setLoadingSemesters(false); }
  }

  async function switchSemester(value: string) {
    setSemesterSelection(value);
    await load(false, value);
  }
  const grouped = useMemo(() => {
    const slots = new Map<string, ScheduleCourse[]>();
    let weekCourses = courses.filter((course) => !course.weeks?.length || course.weeks.includes(week));
    if (!semesterSelection && customizations.semester.startDate) {
      const weekStart = new Date(`${customizations.semester.startDate}T00:00:00`);
      weekStart.setDate(weekStart.getDate() + (week - 1) * 7);
      for (const item of customizations.dateOverrides) {
        const target = new Date(`${item.date}T00:00:00`);
        if (target < weekStart || target.getTime() >= weekStart.getTime() + 7 * 86_400_000) continue;
        if (item.targetSourceKey) weekCourses = weekCourses.filter((course) => course.sourceKey !== item.targetSourceKey);
        if ((item.action === "add" || item.action === "replace") && item.course) {
          weekCourses.push({ ...item.course, scheduleId: `date-${item.id}`, sourceKey: `date-${item.id}`, source: "custom" as const, occurrenceDate: item.date, weekday: target.getDay() || 7 });
        }
      }
    }
    for (const course of weekCourses) {
      const start = course.startPeriod ?? course.weeklyPeriods?.[0] ?? 1;
      const end = course.endPeriod ?? course.weeklyPeriods?.at(-1) ?? start;
      const key = `${course.weekday}-${start}-${end}`;
      slots.set(key, [...(slots.get(key) ?? []), course]);
    }
    return [...slots.entries()].map(([key, items]) => {
      const [weekday, start, end] = key.split("-").map(Number);
      return { key, weekday, start, end, items };
    });
  }, [courses, customizations, semesterSelection, week]);

  const visibleTotalWeeks = semesterSelection
    ? Math.max(1, ...courses.flatMap((course) => course.weeks ?? []))
    : customizations.semester.totalWeeks;

  function openEditor(mode: "edit" | "recurring" | "date", course?: ScheduleCourse) {
    setEditor({ mode, course });
    setDraft(course ? {
      courseName: course.courseName, teacherName: course.teacherName ?? "", classroom: course.classroom ?? "",
      weekday: course.weekday, startPeriod: course.startPeriod ?? 1, endPeriod: course.endPeriod ?? 1,
      weeks: formatWeeks(course.weeks), date: course.occurrenceDate ?? "",
    } : { ...blankCourseDraft, weeks: `1-${customizations.semester.totalWeeks}` });
  }

  async function persist(next: ScheduleCustomizations) {
    setSaving(true); setError("");
    try {
      const response = await saveScheduleCustomizations(next);
      setCourses(response.data?.courses ?? []);
      setCustomizations(response.data?.customizations ?? next);
      setEditor(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "课表保存失败"); }
    finally { setSaving(false); }
  }

  async function saveCourse() {
    const weeks = parseWeeks(draft.weeks);
    const base = {
      courseName: draft.courseName.trim(), teacherName: draft.teacherName.trim(), classroom: draft.classroom.trim(),
      weekday: draft.weekday, startPeriod: draft.startPeriod, endPeriod: draft.endPeriod,
      weeklyPeriods: Array.from({ length: draft.endPeriod - draft.startPeriod + 1 }, (_, index) => draft.startPeriod + index), weeks,
      courseCode: editor?.course?.courseCode ?? "", sourceKey: editor?.course?.sourceKey ?? "", scheduleId: editor?.course?.scheduleId ?? "",
    };
    if (!base.courseName || draft.endPeriod < draft.startPeriod) { setError("请填写课程名，并检查起止节次。"); return; }
    const next: ScheduleCustomizations = structuredClone(customizations);
    if (editor?.mode === "edit" && editor.course?.source === "remote") {
      next.overrides[editor.course.sourceKey] = { ...next.overrides[editor.course.sourceKey], ...base };
    } else if (editor?.mode === "edit" && editor.course?.customId) {
      if (next.customCourses.some((item) => item.customId === editor.course!.customId)) {
        next.customCourses = next.customCourses.map((item) => item.customId === editor.course!.customId ? { ...item, ...base } : item);
      } else {
        next.dateOverrides = next.dateOverrides.map((item) => item.id === editor.course!.customId && item.course ? { ...item, date: draft.date || item.date, course: { ...item.course, ...base } } : item);
      }
    } else if (editor?.mode === "date") {
      if (!draft.date) { setError("请选择自定义课程日期。"); return; }
      const id = crypto.randomUUID();
      next.dateOverrides.push({ id, date: draft.date, action: "add", course: { ...base, customId: id } });
    } else {
      const customId = crypto.randomUUID();
      next.customCourses.push({ ...base, customId, scheduleId: `custom-${customId}`, sourceKey: `custom-${customId}`, source: "custom" });
    }
    await persist(next);
  }

  async function login() {
    setLoading(true); setError("");
    try { await authorizeSchedule(); setSemesterOptions([]); setSemestersPrefetched(false); setSemesterError(""); await load(true, semesterSelection); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "课表认证失败"); setLoading(false); }
  }

  return <div className="workspace-page">
    <PageHeader title="课表" description={`${selectedSemesterLabel || customizations.semester.name || "当前学期"}${fetchedAt ? ` · 上次同步：${new Date(fetchedAt).toLocaleString("zh-CN")}` : ""}${semesterSelection ? "" : ` · 当前第 ${academicWeek(customizations.semester.startDate, customizations.semester.totalWeeks)} 周`}`} action={<div className="schedule-actions"><label className="schedule-semester-picker" title={semesterError}><span>查看学期</span><select value={semesterSelection} disabled={loading || loadingSemesters} onFocus={() => void loadSemesterOptions()} onChange={(event) => void switchSemester(event.target.value)}><option value="">{currentSemesterLabel || (!semesterSelection && selectedSemesterLabel) || "当前学期"}</option>{semesterOptions.filter((item) => item.value !== currentSemester).map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select>{loadingSemesters && <LoaderCircle className="spin" size={14} />}</label>{semesterError && <button className="page-action" onClick={() => void login()}><KeyRound size={14} />课表登录</button>}<button className="page-action" disabled={Boolean(semesterSelection)} title={semesterSelection ? "往年课表仅供查看" : "添加课程"} onClick={() => openEditor("recurring")}><Plus size={15} />添加课程</button><button className="page-action" disabled={Boolean(semesterSelection)} title={semesterSelection ? "往年课表仅供查看" : "添加单日课程"} onClick={() => openEditor("date")}><CalendarPlus size={15} />单日课程</button><div className="week-picker"><button disabled={week <= 1} onClick={() => setWeek((value) => value - 1)}><ChevronLeft size={15} /></button><select value={week} onChange={(event) => setWeek(Number(event.target.value))}>{Array.from({ length: visibleTotalWeeks }, (_, index) => <option key={index + 1} value={index + 1}>第 {index + 1} 周 · {(index + 1) % 2 ? "单周" : "双周"}</option>)}</select><button disabled={week >= visibleTotalWeeks} onClick={() => setWeek((value) => value + 1)}><ChevronRight size={15} /></button></div><button className="page-action" disabled={loading} onClick={() => void load(true, semesterSelection)}><RefreshCw size={15} />重新抓取</button></div>} />
    {semesterError && <div className="schedule-refresh-error"><TriangleAlert size={17} /><span>{semesterError} 当前显示的是上次成功同步的缓存课表。</span><button className="page-action" onClick={() => void login()}><KeyRound size={14} />重新登录并抓取</button></div>}
    <div className="semester-settings"><label><span>学期名称</span><input value={customizations.semester.name} onChange={(event) => setCustomizations((value) => ({ ...value, semester: { ...value.semester, name: event.target.value } }))} placeholder="2026-2027 秋季" /></label><label><span>学期起始日期</span><input type="date" value={customizations.semester.startDate} onChange={(event) => setCustomizations((value) => ({ ...value, semester: { ...value.semester, startDate: event.target.value } }))} /></label><label><span>总周数</span><input type="number" min={1} max={30} value={customizations.semester.totalWeeks} onChange={(event) => setCustomizations((value) => ({ ...value, semester: { ...value.semester, totalWeeks: Number(event.target.value) } }))} /></label><button className="page-action" disabled={saving} onClick={() => void persist(customizations)}><Save size={14} />保存学期</button></div>
    <PageState loading={loading} error={error}>
      {courses.length || (!semesterSelection && customizations.dateOverrides.length) ? <Timetable slots={grouped} onEdit={semesterSelection ? undefined : (course) => openEditor("edit", course)} /> : <div className="page-empty"><CalendarDays size={28} /><h2>还没有课表数据</h2><p>先连接东南大学课表系统，完成认证后会保存到本地。</p><button className="page-action primary" onClick={() => void login()}>{status === "auth_required" ? "登录并获取课表" : "获取课表"}</button></div>}
    </PageState>
    {editor && <div className="confirm-overlay"><div className="course-editor"><button className="confirm-close" onClick={() => setEditor(null)}><X size={16} /></button><h2>{editor.mode === "edit" ? "修改课程" : editor.mode === "date" ? "添加单日课程" : "添加自定义课程"}</h2><div className="course-editor-grid"><label><span>课程名</span><input value={draft.courseName} onChange={(event) => setDraft((value) => ({ ...value, courseName: event.target.value }))} /></label><label><span>教师</span><input value={draft.teacherName} onChange={(event) => setDraft((value) => ({ ...value, teacherName: event.target.value }))} /></label><label><span>教室</span><input value={draft.classroom} onChange={(event) => setDraft((value) => ({ ...value, classroom: event.target.value }))} /></label>{(editor.mode === "date" || editor.course?.occurrenceDate) && <label><span>日期</span><input type="date" value={draft.date} onChange={(event) => setDraft((value) => ({ ...value, date: event.target.value }))} /></label>}<label><span>星期</span><select value={draft.weekday} disabled={editor.mode === "date" || Boolean(editor.course?.occurrenceDate)} onChange={(event) => setDraft((value) => ({ ...value, weekday: Number(event.target.value) }))}>{weekdays.slice(1).map((day, index) => <option value={index + 1} key={day}>{day}</option>)}</select></label><label><span>起始节</span><input type="number" min={1} max={13} value={draft.startPeriod} onChange={(event) => setDraft((value) => ({ ...value, startPeriod: Number(event.target.value) }))} /></label><label><span>结束节</span><input type="number" min={1} max={13} value={draft.endPeriod} onChange={(event) => setDraft((value) => ({ ...value, endPeriod: Number(event.target.value) }))} /></label>{editor.mode !== "date" && !editor.course?.occurrenceDate && <label className="wide"><span>周次（如 1-16 或 1,3,5）</span><input value={draft.weeks} onChange={(event) => setDraft((value) => ({ ...value, weeks: event.target.value }))} /></label>}</div><div className="confirm-actions"><button onClick={() => setEditor(null)}>取消</button><button className="primary" disabled={saving} onClick={() => void saveCourse()}><Save size={14} />保存</button></div></div></div>}
  </div>;
}

const periodTimes = ["", "08:00–08:45", "08:50–09:35", "09:50–10:35", "10:40–11:25", "11:30–12:15", "14:00–14:45", "14:50–15:35", "15:50–16:35", "16:40–17:25", "17:30–18:15", "19:00–19:45", "19:50–20:35", "20:40–21:25"];

function Timetable({ slots, onEdit }: { slots: Array<{ key: string; weekday: number; start: number; end: number; items: ScheduleCourse[] }>; onEdit?: (course: ScheduleCourse) => void }) {
  return <div className="timetable-wrap"><div className="timetable">
    <div className="timetable-corner">节次 / 时间</div>
    {weekdays.slice(1).map((day, index) => <div className="timetable-day-head" key={day} style={{ gridColumn: index + 2, gridRow: 1 }}>{day}</div>)}
    {periodTimes.slice(1).map((time, index) => <div className="timetable-time" key={time} style={{ gridColumn: 1, gridRow: index + 2 }}><strong>{index + 1}</strong><span>{time}</span></div>)}
    {weekdays.slice(1).flatMap((_, day) => periodTimes.slice(1).map((__, period) => <div className="timetable-cell" key={`${day}-${period}`} style={{ gridColumn: day + 2, gridRow: period + 2 }} />))}
    {slots.map((slot) => <div className="timetable-slot" key={slot.key} style={{ gridColumn: slot.weekday + 1, gridRow: `${slot.start + 1} / span ${slot.end - slot.start + 1}` }}>
      {slot.items.map((course) => <button className="course-card" key={course.scheduleId} disabled={!onEdit} onClick={() => onEdit?.(course)} title={onEdit ? "修改课程" : "往年课表课程"}><strong>{course.courseName}</strong><span>{[course.teacherName, course.classroom].filter(Boolean).join(" · ")}</span>{onEdit && <Pencil size={11} />}</button>)}
    </div>)}
  </div></div>;
}

function updateFocusTool(tools: ToolRun[] = [], next: ToolRun) {
  const found = tools.findIndex((tool) => tool.id === next.id);
  if (found < 0) return [...tools, next];
  return tools.map((tool, index) => index === found ? { ...tool, ...next } : tool);
}

function applyFocusStreamEvent(message: ChatMessage, event: StreamEvent): ChatMessage {
  const payload = event.payload ?? {};
  if (event.type === "reasoning-start") {
    const text = typeof payload.text === "string" ? payload.text : "";
    return { ...appendProcessText(message, "reasoning", text, true, String(payload.id ?? crypto.randomUUID())), reasoningActive: true, reasoningDone: true };
  }
  if (event.type === "reasoning-delta") {
    const text = typeof payload.text === "string" ? payload.text : typeof payload.delta === "string" ? payload.delta : "";
    return { ...appendProcessText(message, "reasoning", text), reasoningActive: true, reasoningDone: true };
  }
  if (event.type === "reasoning-end") {
    return { ...message, reasoningActive: false, reasoningDone: true };
  }
  if (event.type === "text-delta" && typeof payload.text === "string") {
    return { ...appendProcessText(message, "narration", payload.text), reasoningActive: false };
  }
  if (event.type === "tool-call-input-streaming-start" || event.type === "tool-call") {
    const id = String(payload.toolCallId ?? crypto.randomUUID());
    const next = addProcessTool(message, id);
    return { ...next, reasoningActive: false, reasoningDone: true, tools: updateFocusTool(next.tools, { id, name: String(payload.toolName ?? "工具调用"), state: "running", args: payload.args as Record<string, unknown> | undefined }) };
  }
  if (event.type === "tool-result" || event.type === "tool-output") {
    const id = String(payload.toolCallId ?? crypto.randomUUID());
    const rawResult = payload.result ?? payload.output;
    const result = (rawResult && typeof rawResult === "object" && "value" in rawResult ? (rawResult as { value: unknown }).value : rawResult) as ToolResult;
    const next = addProcessTool(message, id);
    return { ...next, tools: updateFocusTool(next.tools, { id, name: String(payload.toolName ?? "工具调用"), state: result?.status === "failed" ? "failed" : "completed", args: payload.args as Record<string, unknown> | undefined, result }) };
  }
  if (event.type === "tool-error" || event.type === "tool-output-denied") {
    const id = String(payload.toolCallId ?? crypto.randomUUID());
    const result: ToolResult = { status: "failed", taskId: id, summary: typeof payload.error === "string" ? payload.error : "工具执行失败或未获授权。", artifacts: [], citations: [], warnings: [], metrics: {} };
    const next = addProcessTool(message, id);
    return { ...next, tools: updateFocusTool(next.tools, { id, name: String(payload.toolName ?? "工具调用"), state: "failed", result }) };
  }
  return message;
}

export function FocusPage({
  renderMessage,
  selectedFocusId = "",
  onSelectedFocusChange,
  onHistoryChange,
}: {
  renderMessage?: (message: ChatMessage) => ReactNode;
  selectedFocusId?: string;
  onSelectedFocusChange?: (focusId: string) => void;
  onHistoryChange?: () => void;
}) {
  const [items, setItems] = useState<FocusItem[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [conversationLoading, setConversationLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState<"notice" | "course" | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const messageEndRef = useRef<HTMLDivElement | null>(null);
  const externalFocusRef = useRef("");

  const load = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true);
    setError("");
    try {
      const focus = await fetchFocus();
      const nextItems = focus.data?.items ?? [];
      setItems(nextItems);
      setSelectedId((current) => current && nextItems.some((item) => item.id === current) ? current : "");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "关注读取失败"); }
    finally { if (showLoading) setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { messageEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [messages]);
  useEffect(() => {
    if (!selectedFocusId) {
      if (externalFocusRef.current) {
        externalFocusRef.current = "";
        setSelectedId("");
        setMessages([]);
      }
      return;
    }
    if (loading || externalFocusRef.current === selectedFocusId) return;
    const item = items.find((candidate) => candidate.id === selectedFocusId);
    if (!item) return;
    externalFocusRef.current = selectedFocusId;
    void openFocus(item);
  }, [items, loading, selectedFocusId]);

  const selected = items.find((item) => item.id === selectedId);

  function mutateMessage(messageId: string, updater: (message: ChatMessage) => ChatMessage) {
    setMessages((current) => current.map((message) => message.id === messageId ? updater(message) : message));
  }

  async function openFocus(item: FocusItem) {
    if (streaming) return;
    externalFocusRef.current = item.id;
    onSelectedFocusChange?.(item.id);
    setSelectedId(item.id);
    setMessages([]);
    setConversationLoading(true);
    setError("");
    try { setMessages(await fetchFocusMessages(item)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "关注会话读取失败"); }
    finally { setConversationLoading(false); }
  }

  async function executeFocusStream(item: FocusItem, prompt: string, assistantId: string, options: { force?: boolean; respectInterval: boolean }) {
    setStreaming(true);
    setError("");
    const controller = new AbortController();
    abortRef.current = controller;
    let runId = "";
    let responseText = "";
    try {
      const claim = await claimFocusRun(item.id, options);
      const claimed = claim.data;
      if (!claimed?.claimed || !claimed.runId || !claimed.item) {
        throw new Error(claimed?.reason === "running" ? "这项关注正在执行，请稍后再发送。" : "当前尚未到检查时间。可稍后再试。" );
      }
      runId = claimed.runId;
      await streamAgent({
        message: prompt,
        threadId: claimed.item.threadId || item.threadId || item.id,
        resourceId: claimed.item.resourceId || item.resourceId,
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === "text-delta" && typeof event.payload?.text === "string") responseText += event.payload.text;
          if (event.type === "reasoning-start" || event.type === "tool-call-input-streaming-start" || event.type === "tool-call") responseText = "";
          mutateMessage(assistantId, (message) => applyFocusStreamEvent(message, event));
        },
      });
      mutateMessage(assistantId, (message) => ({ ...finalizeProcessAnswer(message), streaming: false, reasoningActive: false, tools: message.tools?.map((tool) => tool.state === "running" ? { ...tool, state: "completed" as const } : tool) }));
      await recordFocusRun(item.id, runId, "completed", responseText);
      void load(false);
    } catch (reason) {
      const aborted = controller.signal.aborted;
      const message = aborted ? "已停止本次回答。" : reason instanceof Error ? reason.message : "请求失败，请稍后重试。";
      mutateMessage(assistantId, (current) => ({ ...current, streaming: false, reasoningActive: false, error: message, tools: current.tools?.map((tool) => tool.state === "running" ? { ...tool, state: "failed" as const } : tool) }));
      if (runId) await recordFocusRun(item.id, runId, "failed", message).catch(() => undefined);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setStreaming(false);
      onHistoryChange?.();
    }
  }

  async function create() {
    const kind = adding;
    const nextTitle = title.trim();
    const prompt = description.trim();
    if (!kind || !nextTitle || !prompt || creating) { setError("请填写关注名称和持续关注要求。"); return; }
    const id = `focus-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const optimistic: FocusItem = { id, kind, title: nextTitle, description: prompt, enabled: true, createdAt: now, updatedAt: now, threadId: id, resourceId: "seudaily-focus-local" };
    const assistantId = crypto.randomUUID();
    setCreating(true);
    setStreaming(true);
    setItems((current) => [...current, optimistic]);
    externalFocusRef.current = id;
    onSelectedFocusChange?.(id);
    setSelectedId(id);
    setMessages([
      { id: crypto.randomUUID(), role: "user", content: prompt, createdAt: Date.now() },
      { id: assistantId, role: "assistant", content: "", createdAt: Date.now(), tools: [], streaming: true },
    ]);
    setAdding(null); setTitle(""); setDescription(""); setError("");
    try {
      const saved = await saveFocus(optimistic);
      const created = saved.data?.item;
      if (!created) throw new Error("关注已提交，但服务端没有返回会话信息。");
      setItems((current) => current.map((item) => item.id === id ? created : item));
      await executeFocusStream(created, prompt, assistantId, { force: true, respectInterval: true });
    } catch (reason) {
      setStreaming(false);
      mutateMessage(assistantId, (message) => ({ ...message, streaming: false, error: reason instanceof Error ? reason.message : "关注创建失败，请稍后重试。" }));
    } finally { setCreating(false); }
  }

  async function sendFollowup() {
    const prompt = draft.trim();
    if (!selected || !prompt || streaming) return;
    const assistantId = crypto.randomUUID();
    setDraft("");
    setMessages((current) => [...current,
      { id: crypto.randomUUID(), role: "user", content: prompt, createdAt: Date.now() },
      { id: assistantId, role: "assistant", content: "", createdAt: Date.now(), tools: [], streaming: true },
    ]);
    await executeFocusStream(selected, prompt, assistantId, { respectInterval: false });
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendFollowup(); }
  }

  function onSubmit(event: FormEvent) { event.preventDefault(); void sendFollowup(); }

  async function toggle(item: FocusItem) {
    try { await saveFocus({ ...item, enabled: !item.enabled }); await load(false); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "关注更新失败"); }
  }

  async function remove(id: string) {
    try { await deleteFocus(id); setItems((current) => current.filter((item) => item.id !== id)); if (selectedId === id) setSelectedId(""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "关注删除失败"); }
  }

  async function checkNow() {
    setRunning(true); setError("");
    try { await runFocus(); await load(false); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "关注检查失败"); }
    finally { setRunning(false); }
  }

  if (selected) return <div className="focus-chat-panel">
    <header className="topbar focus-chat-topbar"><button className="icon-button" aria-label="返回关注列表" title="返回关注列表" onClick={() => { externalFocusRef.current = ""; setSelectedId(""); setMessages([]); onSelectedFocusChange?.(""); }}><ArrowLeft size={20} /></button><h1>{selected.title}</h1><span className={`focus-chat-state ${streaming ? "running" : selected.enabled ? "enabled" : "paused"}`}>{streaming ? "执行中" : selected.enabled ? "已启用" : "已暂停"}</span></header>
    <section className="chat-scroll focus-chat-scroll">{conversationLoading ? <div className="page-state"><LoaderCircle className="spin" size={20} /><span>正在读取会话…</span></div> : <div className="message-list">{messages.length ? messages.map((message) => <div key={message.id}>{renderMessage ? renderMessage(message) : <article className={`focus-message ${message.role}`}><ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>{normalizeMathMarkdown(message.content)}</ReactMarkdown></article>}</div>) : <div className="focus-empty-chat">还没有会话内容，可以在下方补充任务要求。</div>}<div ref={messageEndRef} /></div>}</section>
    <form className="composer-wrap focus-chat-composer" onSubmit={onSubmit}><div className="composer"><textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={onComposerKeyDown} placeholder="补充或修正这项关注的要求" rows={1} disabled={streaming} />{streaming ? <button type="button" className="send-button stop" onClick={() => abortRef.current?.abort()} aria-label="停止回答"><CircleStop size={19} /></button> : <button type="submit" className="send-button" disabled={!draft.trim()} aria-label="发送消息"><ArrowUp size={20} /></button>}</div><div className="composer-hint"><span>Enter 发送 · Shift + Enter 换行</span><span>消息会追加到这项关注的独立会话</span></div></form>
  </div>;

  return <div className="workspace-page focus-page focus-list-page">
    <PageHeader title="关注" description="" action={<div className="schedule-actions focus-actions"><button className="page-action" onClick={() => setAdding("notice")}>关注通知</button><button className="page-action" onClick={() => setAdding("course")}>关注课程</button><button className="page-action primary" disabled={running} onClick={() => void checkNow()}>立即检查</button></div>} />
    {error && <div className="page-state error">{error}</div>}
    <PageState loading={loading} error="">{items.length ? <div className="focus-list">{items.map((item) => <article className="focus-card" key={item.id} onClick={() => void openFocus(item)}><div className="focus-card-copy"><strong>{item.title}</strong><small>{item.lastCheckedAt ? `上次执行 ${new Date(item.lastCheckedAt).toLocaleString("zh-CN")}` : "尚未执行"}</small></div><button className={`focus-toggle ${item.enabled ? "on" : ""}`} onClick={(event) => { event.stopPropagation(); void toggle(item); }}>{item.enabled ? "已启用" : "已暂停"}</button><button className="focus-delete" onClick={(event) => { event.stopPropagation(); void remove(item.id); }}>删除</button></article>)}</div> : <div className="page-empty compact focus-empty"><h2>还没有关注</h2></div>}</PageState>
    {adding && <div className="confirm-overlay"><div className="course-editor focus-editor"><button className="confirm-close focus-close" aria-label="关闭" disabled={creating} onClick={() => setAdding(null)}>关闭</button><h2>{adding === "notice" ? "新建通知关注" : "新建课程关注"}</h2><div className="course-editor-grid"><label className="wide"><span>关注名称</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder={adding === "notice" ? "例如：推免信息" : "例如：课程转写跟进"} /></label><label className="wide"><span>交给 Agent 的持续任务</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder={adding === "notice" ? "例如：持续关注本校推免政策、报名节点和夏令营，普通成绩公示不用提醒" : "例如：关注张老师的编译原理，即使不在我的课表；发现新课次一天后抓取转写并总结"} /></label></div><div className="confirm-actions"><button disabled={creating} onClick={() => setAdding(null)}>取消</button><button className="primary" disabled={creating || !title.trim() || !description.trim()} onClick={() => void create()}>{creating ? "正在创建…" : "创建并启动会话"}</button></div></div></div>}
  </div>;
}

export function LibraryPage() {
  const [files, setFiles] = useState<LibraryFile[]>([]);
  const [category, setCategory] = useState("");
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
  const load = useCallback(async () => { setLoading(true); setError(""); try { setFiles((await fetchLibrary()).files); } catch (reason) { setError(reason instanceof Error ? reason.message : "资料读取失败"); } finally { setLoading(false); } }, []);
  useEffect(() => { void load(); }, [load]);
  const categories = [{ id: "knowledge", label: "课程笔记" }, { id: "subtitle", label: "课程字幕" }, { id: "media", label: "课程媒体" }, { id: "images", label: "临时图片" }];
  const visible = files.filter((file) => file.category === category);
  const courses = useMemo(() => [...new Set(visible.map((file) => file.course))].sort((a, b) => a.localeCompare(b, "zh-CN")), [visible]);
  const teachers = useMemo(() => [...new Set(visible.filter((file) => file.course === course).map((file) => file.teacher))].sort((a, b) => a.localeCompare(b, "zh-CN")), [visible, course]);
  const selectedFiles = visible.filter((file) => file.course === course && file.teacher === teacher);
  const columnCount = 1 + (category ? 1 : 0) + (course ? 1 : 0) + (teacher ? 1 : 0);

  function chooseCategory(next: string) { setCategory(next); setCourse(""); setTeacher(""); setSelectedFilePath(""); }
  function chooseCourse(next: string) { setCourse(next); setTeacher(""); setSelectedFilePath(""); }
  function chooseTeacher(next: string) { setTeacher(next); setSelectedFilePath(""); }
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
    <PageHeader title="资料库" description="" action={<button className="page-action" disabled={loading} onClick={() => void load()}><RefreshCw size={15} />刷新</button>} />
    <PageState loading={loading} error={error}>
      <div className={`column-browser columns-${columnCount}`} onKeyDown={(event) => { const selectedFile = selectedFiles.find((file) => file.path === selectedFilePath); if (!selectedFile) return; if (event.key === " ") { event.preventDefault(); void openPreview(selectedFile); } else if (event.key === "Delete") { event.preventDefault(); setDeleteTarget(selectedFile); } }}>
        <div className="browser-column">
          <div className="browser-column-list">{categories.map((item) => <button key={item.id} className={category === item.id ? "selected" : ""} onClick={() => chooseCategory(item.id)}><Folder size={17} /><span>{item.label}</span><ChevronRight size={15} /></button>)}</div>
        </div>
        {category && <div className="browser-column">
          <div className="browser-column-list">{courses.length ? courses.map((item) => <button key={item} className={course === item ? "selected" : ""} onClick={() => chooseCourse(item)}><Folder size={17} /><span>{item}</span><ChevronRight size={15} /></button>) : <div className="browser-column-empty">暂无课程资料</div>}</div>
        </div>}
        {course && <div className="browser-column">
          <div className="browser-column-list">{teachers.length ? teachers.map((item) => <button key={item} className={teacher === item ? "selected" : ""} onClick={() => chooseTeacher(item)}><UserRound size={17} /><span>{item || "未分类"}</span><ChevronRight size={15} /></button>) : <div className="browser-column-empty">暂无教师信息</div>}</div>
        </div>}
        {course && teacher && <div className="browser-column browser-file-column">
          <div className="browser-column-list">{selectedFiles.length ? selectedFiles.map((file) => <button key={file.path} className={selectedFilePath === file.path ? "selected" : ""} aria-selected={selectedFilePath === file.path} onClick={() => setSelectedFilePath(file.path)} onDoubleClick={() => void openPreview(file)}>{file.category === "images" ? <FileImage size={17} /> : <FileText size={17} />}<span>{friendlyFileName(file)}</span></button>) : <div className="browser-column-empty">暂无文件</div>}</div>
        </div>}
      </div>
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
  const [settings, setSettings] = useState<SettingsPayload | null>(null); const [values, setValues] = useState<Record<string, string>>({}); const [agentInstructions, setAgentInstructions] = useState(""); const [loading, setLoading] = useState(true); const [saving, setSaving] = useState(false); const [message, setMessage] = useState(""); const [error, setError] = useState("");
  useEffect(() => { fetchSettings().then((data) => { setSettings(data); setValues(Object.fromEntries(data.fields.filter((field) => field.name !== "CVSTREAM_FULL_ACCESS").map((field) => [field.name, field.value]))); setAgentInstructions(data.agentInstructions ?? ""); }).catch((reason) => setError(reason instanceof Error ? reason.message : "设置读取失败")).finally(() => setLoading(false)); }, []);
  async function save() {
    setSaving(true);
    setMessage("");
    setError("");
    try {
      const result = await saveSettings(values, agentInstructions);
      setMessage((result.saved.length || result.agentInstructionsSaved)
        ? result.restartRequired
          ? "设置已保存，环境变量将在服务重启后生效。"
          : "设置已保存，将在下一轮对话生效。"
        : "没有需要保存的新内容。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "设置保存失败");
    } finally {
      setSaving(false);
    }
  }
  return <div className="workspace-page settings-page"><PageHeader title="设置" description="" /><PageState loading={loading} error={error}>{settings && <div className="settings-sections"><section className="settings-card"><div className="settings-title"><Settings2 size={20} /><div><h2>模型提供商</h2></div></div><label><span>Provider</span><input value={settings.provider.name} disabled /></label><label><span>API 地址</span><input value={settings.provider.baseUrl} disabled /></label></section><section className="settings-card"><div className="settings-title"><KeyRound size={20} /><div><h2>环境变量</h2></div></div>{settings.fields.filter((field) => field.name !== "CVSTREAM_FULL_ACCESS").map((field) => <label key={field.name}><span>{fieldLabels[field.name] ?? field.name}<small>{field.configured ? "已配置" : "未配置"}</small></span><input type={field.secret ? "password" : "text"} value={values[field.name] ?? ""} placeholder={field.secret && field.configured ? "••••••••（留空保持不变）" : field.name} onChange={(event) => setValues((current) => ({ ...current, [field.name]: event.target.value }))} /></label>)}<div className="settings-save"><div>{message && <span className="success-text">{message}</span>}</div><button className="page-action primary" disabled={saving} onClick={() => void save()}>{saving ? "正在保存…" : "保存设置"}</button></div></section><section className="settings-card"><div className="settings-title"><FileText size={20} /><div><h2>AGENTS.md</h2></div></div><textarea className="agent-instructions-editor" value={agentInstructions} onChange={(event) => setAgentInstructions(event.target.value)} placeholder="在这里输入本项目的全局对话规则…" rows={14} /><div className="settings-save"><div /><button className="page-action primary" disabled={saving} onClick={() => void save()}>{saving ? "正在保存…" : "保存 AGENTS.md"}</button></div></section></div>}</PageState></div>;
}

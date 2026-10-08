export {FocusPage} from "./workspace/focus-page";
export {LibraryPage} from "./workspace/library-page";
import { PageHeader, PageState } from "./workspace/page-ui";

import { CalendarDays, CalendarPlus, ChevronLeft, ChevronRight, ExternalLink, FileText, KeyRound, LoaderCircle, Pencil, Plus, RefreshCw, Save, Settings2, TriangleAlert, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { authorizeSchedule, fetchNotices, fetchSchedule, fetchSettings, saveSettings, saveScheduleCustomizations, saveTrainingPlanCourseStatus, fetchTrainingPlans, type NoticeItem, type ScheduleCourse, type ScheduleCustomizations, type ScheduleSemesterOption, type SettingsPayload, type TrainingPlan, type TrainingPlanSource } from "./api";

const weekdays = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];

function academicWeek(startDate: string, totalWeeks: number, date = new Date()) {
  if (!startDate) return 1;
  const semesterStart = new Date(`${startDate}T00:00:00`);
  return Math.max(1, Math.min(totalWeeks, Math.floor((date.getTime() - semesterStart.getTime()) / 604_800_000) + 1));
}

const emptyCustomizations: ScheduleCustomizations = {
  version: 1,
  semester: { name: "", startDate: "", totalWeeks: 16 },
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

const noticeLabels:Record<string,string>={news:"最新动态",academic:"教务信息",student_status:"学籍管理",practice:"实践教学",lectures:"文化素质教育"};
export function NoticesPage() {
  const [category,setCategory]=useState('');
  const [items, setItems] = useState<NoticeItem[]>([]); const [loading, setLoading] = useState(true); const [error, setError] = useState("");
  const load = useCallback(async (refresh = true) => { setLoading(true); setError(""); try { const response = await fetchNotices(refresh,category); setItems(response.data?.results ?? []); if (response.status === "failed") setError(response.summary); } catch (reason) { setError(reason instanceof Error ? reason.message : "通知读取失败"); } finally { setLoading(false); } }, [category]);
  useEffect(() => { void load(true); }, [load]);
  return <div className="workspace-page"><PageHeader title="教务通知" description="最新动态、教务信息、学籍管理、实践教学与文化素质教育。" action={<div className="schedule-actions"><select aria-label="教务栏目" value={category} onChange={event=>setCategory(event.target.value)}><option value="">全部栏目</option>{Object.entries(noticeLabels).map(([id,label])=><option value={id} key={id}>{label}</option>)}</select><button className="page-action" disabled={loading} onClick={() => void load(true)}><RefreshCw size={15} />刷新</button></div>} /><PageState loading={loading} error={error}>{items.length ? <div className="notice-list">{items.map((item) => <a href={item.url} target="_blank" rel="noreferrer" className="notice-row" key={item.id}><div><strong>{item.title}</strong><span>{noticeLabels[item.category ?? ""] ?? "教务处"}</span></div><time>{item.publishedAt ?? ""}</time><ExternalLink size={15} /></a>)}</div> : <div className="page-empty"><FileText size={28} /><h2>暂时没有通知</h2><p>可以稍后刷新，或检查网络连接。</p></div>}</PageState></div>;
}

const fieldLabels: Record<string, string> = { DASHSCOPE_API_KEY: "阿里云 API Key", SEUDAILY_EMBEDDING_MODEL: "向量嵌入模型（默认 qwen3.7-text-embedding）", SEUDAILY_RERANK_MODEL: "重排模型（默认 qwen3.7-text-rerank）", SEUDAILY_EMBEDDING_BASE_URL: "向量服务地址（默认阿里云百炼）",  DEEPSEEK_API_KEY: "DeepSeek API Key", DEEPSEEK_MODEL: "模型", TAVILY_API_KEY: "Tavily API Key", SEUDAILY_USERNAME: "统一身份认证账号", SEUDAILY_PASSWORD: "统一身份认证密码", SEUDAILY_ASR_API_KEY: "语音转写 API Key", SEUDAILY_WHISPER_MODEL: "本地 Whisper 模型" };

export function SettingsPage() {
  const [settings, setSettings] = useState<SettingsPayload | null>(null); const [values, setValues] = useState<Record<string, string>>({}); const [agentInstructions, setAgentInstructions] = useState(""); const [loading, setLoading] = useState(true); const [saving, setSaving] = useState(false); const [message, setMessage] = useState(""); const [error, setError] = useState("");
  useEffect(() => { fetchSettings().then((data) => { setSettings(data); setValues(Object.fromEntries(data.fields.filter((field) => field.name !== "SEUDAILY_FULL_ACCESS").map((field) => [field.name, field.value]))); setAgentInstructions(data.agentInstructions ?? ""); }).catch((reason) => setError(reason instanceof Error ? reason.message : "设置读取失败")).finally(() => setLoading(false)); }, []);
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
  return <div className="workspace-page settings-page"><PageHeader title="设置" description="" /><PageState loading={loading} error={error}>{settings && <div className="settings-sections"><section className="settings-card"><div className="settings-title"><Settings2 size={20} /><div><h2>模型提供商</h2></div></div><label><span>Provider</span><input value={settings.provider.name} disabled /></label><label><span>API 地址</span><input value={settings.provider.baseUrl} disabled /></label></section><section className="settings-card"><div className="settings-title"><KeyRound size={20} /><div><h2>环境变量</h2></div></div>{settings.fields.filter((field) => field.name !== "SEUDAILY_FULL_ACCESS").map((field) => <label key={field.name}><span>{fieldLabels[field.name] ?? field.name}<small>{field.configured ? "已配置" : "未配置"}</small></span><input type={field.secret ? "password" : "text"} value={values[field.name] ?? ""} placeholder={field.secret && field.configured ? "••••••••（留空保持不变）" : field.name} onChange={(event) => setValues((current) => ({ ...current, [field.name]: event.target.value }))} /></label>)}<div className="settings-save"><div>{message && <span className="success-text">{message}</span>}</div><button className="page-action primary" disabled={saving} onClick={() => void save()}>{saving ? "正在保存…" : "保存设置"}</button></div></section><section className="settings-card"><div className="settings-title"><FileText size={20} /><div><h2>AGENT.md</h2></div></div><textarea className="agent-instructions-editor" value={agentInstructions} onChange={(event) => setAgentInstructions(event.target.value)} placeholder="在这里输入本项目的全局对话规则…" rows={14} /><div className="settings-save"><div /><button className="page-action primary" disabled={saving} onClick={() => void save()}>{saving ? "正在保存…" : "保存 AGENT.md"}</button></div></section></div>}</PageState></div>;
}

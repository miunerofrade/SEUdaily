import stringWidth from "string-width";
import { clean } from "./client.js";
export const periodTimes = [
  "",
  "08:00–08:45",
  "08:50–09:35",
  "09:50–10:35",
  "10:40–11:25",
  "11:30–12:15",
  "14:00–14:45",
  "14:50–15:35",
  "15:50–16:35",
  "16:40–17:25",
  "17:30–18:15",
  "19:00–19:45",
  "19:50–20:35",
  "20:40–21:25",
];
export function fit(value: unknown, width: number) {
  const text = clean(value).replace(/\n/g, " ");
  if (stringWidth(text) <= width)
    return text + " ".repeat(Math.max(0, width - stringWidth(text)));
  let result = "",
    used = 0;
  for (const char of text) {
    const size = stringWidth(char);
    if (used + size > width - 1) break;
    result += char;
    used += size;
  }
  return result + "…" + " ".repeat(Math.max(0, width - used - 1));
}
export function wrap(text: string, width: number): string[] {
  return clean(text)
    .split("\n")
    .flatMap((line) => {
      const rows: string[] = [];
      let row = "",
        used = 0;
      for (const char of line) {
        const size = stringWidth(char);
        if (used && used + size > width) {
          rows.push(row);
          row = "";
          used = 0;
        }
        row += char;
        used += size;
      }
      rows.push(row);
      return rows;
    });
}
export type DocumentRow = {
  text: string;
  kind?: "title" | "muted" | "course" | "border" | "group";
  course?: any;
  index?: number;
};
export function semesterOptions(course: any) {
  if (course.semesterOptions?.length) return course.semesterOptions;
  const values = (course.semester ?? "").split(/[,，]/).filter(Boolean),
    labels = (course.semesterLabel ?? "").split(/[,，]/);
  return values.length
    ? values.map((value: string, i: number) => ({
        value,
        label: labels[i] || value,
        status: course.status,
      }))
    : [{ value: "unassigned", label: "未安排学期", status: "unscheduled" }];
}
const states: Record<string, string> = {
  completed: "已完成",
  studying: "学习中",
  not_taken: "未修读",
  upcoming: "未开始",
  unscheduled: "未安排",
  unknown: "待确认",
};
export function programDocument(
  plan: any,
  courses: any[],
  width: number,
  semester = "all",
  state = "all",
) {
  const rows: DocumentRow[] = [],
    entries: any[] = [];
  const add = (text: string, kind?: DocumentRow["kind"]) =>
    wrap(text, width).forEach((text) => rows.push({ text, kind }));
  add(plan.title ?? "暂无培养方案", "title");
  add(
    [plan.department, plan.grade, plan.major, plan.track]
      .filter(Boolean)
      .join(" · "),
    "muted",
  );
  const completed = plan.completedCredits,
    required = plan.requiredCredits;
  const metrics = [
    ["最低修读", required],
    ["已完成", completed],
    ["在修", plan.creditSummary?.studying],
    ["尚需", plan.creditSummary?.remaining],
    ["已修通选", plan.creditSummary?.generalElectiveCompleted],
    ["进度", plan.progress === undefined ? "—" : plan.progress + "%"],
  ];
  add(
    metrics.map(([label, value]) => `${label} ${value ?? "—"}`).join("  │  "),
  );
  const progress = Math.min(100, Math.max(0, Number(plan.progress) || 0)),
    bar = Math.min(60, width - 8),
    filled = Math.round((bar * progress) / 100);
  add("━".repeat(filled) + "─".repeat(bar - filled), "muted");
  add("");
  if (plan.studyRequirements?.length) {
    add("修读要求", "title");
    for (const req of plan.studyRequirements) {
      add(
        `${req.name}${req.nature ? " · " + req.nature : ""}${req.requiredCredits > 0 ? "  │ 要求 " + req.requiredCredits + " 学分" : ""}`,
        "group",
      );
      if (req.note)
        wrap(req.note, width - 2).forEach((text) =>
          rows.push({ text: "  " + text, kind: "muted" }),
        );
      add("");
    }
  }
  add("指导计划课程", "title");
  const cols =
    width >= 110
      ? [
          Math.floor(width * 0.36),
          Math.floor(width * 0.24),
          8,
          6,
          width - Math.floor(width * 0.36) - Math.floor(width * 0.24) - 30,
        ]
      : [Math.max(12, width - 34), 8, 6, 7];
  const border = (left: string, join: string, right: string) =>
    left + cols.map((n) => "─".repeat(n + 2)).join(join) + right;
  const row = (values: any[]) =>
    "│ " + values.map((v, i) => fit(v, cols[i])).join(" │ ") + " │";
  const header =
    width >= 110
      ? ["课程 / 代码", "课程组", "性质", "学分", "状态"]
      : ["课程 / 代码", "性质", "学分", "状态"];
  add(border("┌", "┬", "┐"), "border");
  add(row(header), "muted");
  add(border("├", "┼", "┤"), "border");
  const groups = new Map<string, { label: string; courses: any[] }>();
  for (const course of courses)
    for (const opt of semesterOptions(course)) {
      if (semester !== "all" && opt.value !== semester) continue;
      if (state !== "all" && (opt.status ?? course.status) !== state) continue;
      const group: { label: string; courses: any[] } = groups.get(
        opt.value,
      ) ?? { label: opt.label, courses: [] };
      group.courses.push({
        ...course,
        status: opt.status ?? course.status,
        displaySemester: opt.label,
        semester: opt.value,
        manualStatus: opt.manualStatus ?? course.manualStatus,
      });
      groups.set(opt.value, group);
    }
  for (const [key, group] of [...groups].sort(([a], [b]) =>
    a === "unassigned" ? 1 : b === "unassigned" ? -1 : a.localeCompare(b),
  )) {
    const groupState = group.courses.some((c) => c.status === "studying")
      ? "studying"
      : group.courses.some((c) => c.status === "not_taken")
        ? "not_taken"
        : group.courses.every((c) => c.status === "completed")
          ? "completed"
          : group.courses.every((c) => c.status === "unscheduled")
            ? "unscheduled"
            : "upcoming";
    add(
      `${group.label}  · ${group.courses.length} 门 · ${states[groupState]}`,
      "group",
    );
    for (const course of group.courses) {
      const index = entries.length;
      entries.push(course);
      const state =
        (course.manualStatus ? "手动·" : "自动·") +
        (states[course.status] ?? course.status ?? "待确认");
      const values =
        width >= 110
          ? [
              course.name,
              course.group || "—",
              course.nature || "—",
              course.credits,
              state,
            ]
          : [
              course.name,
              course.nature || "—",
              course.credits,
              states[course.status] ?? "待确认",
            ];
      rows.push({ text: row(values), kind: "course", course, index });
      if (course.code || course.choiceNote)
        rows.push({
          text: row([
            course.code || course.choiceNote,
            ...cols.slice(1).map(() => ""),
          ]),
          kind: "muted",
          course,
          index,
        });
    }
    add(border("├", "┼", "┤"), "border");
  }
  rows[rows.length - 1] = { text: border("└", "┴", "┘"), kind: "border" };
  if (!entries.length) add("没有匹配课程。", "muted");
  if (plan.objective) {
    add("");
    add("培养目标", "title");
    add(plan.objective, "muted");
  }
  if (plan.requirements) {
    add("");
    add("毕业要求", "title");
    add(plan.requirements, "muted");
  }
  return { rows, entries };
}
export function currentWeek(schedule: any, date = new Date()) {
  const start = schedule.customizations?.semester?.startDate;
  if (!start) return "all";
  const startMs = new Date(start + "T00:00:00+08:00").getTime();
  return Number.isFinite(startMs)
    ? String(
        Math.max(
          1,
          Math.min(
            schedule.customizations.semester.totalWeeks || 16,
            Math.floor((date.getTime() - startMs) / 604800000) + 1,
          ),
        ),
      )
    : "all";
}

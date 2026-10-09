import { z } from "zod";
import { requireNoticeSource } from "../shared/notice-sources.js";

import contract from "../seudaily/local_operations.json" with { type: "json" };

export const localOperations = contract.operations;
export type FocusAction = {
  kind: "notice" | "course";
  title: string;
  description: string;
  source?: string;
  categories?: string[];
  courseName?: string;
  teacherNames?: string[];
  sourceKeys?: string[];
  semester?: string;
  summary: boolean;
  summaryInstructions?: string;
};
type CourseFields = {
  courseName: string;
  teacherName: string;
  weekday?: number;
  startPeriod: number;
  endPeriod: number;
  weeks: number[];
  classroom: string;
  courseCode: string;
};
export type ScheduleAction = {
  semester?: { name?: string; startDate?: string; totalWeeks?: number };
  date?: string;
  course?: CourseFields;
  sourceKey?: string;
  changes?: Partial<CourseFields>;
  fromDate?: string;
  toDate?: string;
};

function normalizeFields(value: any): any {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(normalizeFields);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        key === "weeks" && Array.isArray(entry)
          ? [...new Set(entry)].sort((a, b) => Number(a) - Number(b))
          : normalizeFields(entry),
      ]),
    );
  return value;
}
function checkTrimmedStrings(
  value: unknown,
  schema: any,
  context: z.RefinementCtx,
  path: (string | number)[] = [],
) {
  if (typeof value === "string" && value.length < (schema.minLength ?? 0))
    context.addIssue({ code: "custom", path, message: "不能为空" });
  else if (Array.isArray(value))
    value.forEach((entry, index) =>
      checkTrimmedStrings(entry, schema.items ?? {}, context, [...path, index]),
    );
  else if (value && typeof value === "object")
    Object.entries(value).forEach(([key, entry]) =>
      checkTrimmedStrings(entry, schema.properties?.[key] ?? {}, context, [
        ...path,
        key,
      ]),
    );
}

function validDate(value: string): boolean {
  const date = new Date(value + "T00:00:00Z");
  return (
    Number(value.slice(0, 4)) >= 1 &&
    !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
  );
}
export const focusActionSchema = (
  z.fromJSONSchema(
    contract.schemas.focus as Parameters<typeof z.fromJSONSchema>[0],
  ) as z.ZodType<FocusAction>
)
  .transform((value) => normalizeFields(value) as FocusAction)
  .superRefine((value: FocusAction, context) => {
    checkTrimmedStrings(value, contract.schemas.focus, context);
    if (!value.title || !value.description)
      context.addIssue({ code: "custom", message: "关注名称和描述不能为空" });
    if (value.kind === "notice") {
      const source = requireNoticeSource(value.source ?? "jwc");
      if (value.categories?.some((category) => !source.categories[category]))
        context.addIssue({
          code: "custom",
          path: ["categories"],
          message: "不支持的通知栏目",
        });
    }
    if (value.kind === "course" && !value.courseName)
      context.addIssue({
        code: "custom",
        path: ["courseName"],
        message: "课程关注必须提供课程名称",
      });
  });
export const scheduleActionSchema = (
  z.fromJSONSchema(
    contract.schemas.schedule as Parameters<typeof z.fromJSONSchema>[0],
  ) as z.ZodType<ScheduleAction>
)
  .transform((value) => normalizeFields(value) as ScheduleAction)
  .superRefine((value: ScheduleAction, context) => {
    checkTrimmedStrings(value, contract.schemas.schedule, context);
    for (const [key, entry] of Object.entries({
      ...value,
      startDate: value.semester?.startDate,
    })) {
      if (
        ["date", "fromDate", "toDate", "startDate"].includes(key) &&
        typeof entry === "string" &&
        !validDate(entry)
      )
        context.addIssue({
          code: "custom",
          path: [key],
          message: "日期不存在",
        });
    }
    for (const key of ["semester", "changes"] as const) {
      if (value[key] && !Object.keys(value[key]!).length)
        context.addIssue({
          code: "custom",
          path: [key],
          message: "至少提供一项修改",
        });
    }
    for (const [key, course] of [
      ["course", value.course],
      ["changes", value.changes],
    ] as const) {
      if (course?.courseName !== undefined && !course.courseName)
        context.addIssue({
          code: "custom",
          path: [key, "courseName"],
          message: "课程名称不能为空",
        });
      if (
        course?.startPeriod !== undefined &&
        course.endPeriod !== undefined &&
        course.endPeriod < course.startPeriod
      )
        context.addIssue({
          code: "custom",
          path: [key, "endPeriod"],
          message: "endPeriod 不能早于 startPeriod",
        });
    }
  });

export const localActionProposalSchema = z
  .object({
    kind: z.enum(
      Object.keys(localOperations) as [
        keyof typeof localOperations,
        ...(keyof typeof localOperations)[],
      ],
    ),
    mode: z.enum(["preview", "apply"]).default("preview"),
    focus: focusActionSchema.optional(),
    schedule: scheduleActionSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.kind === "create_focus") {
      if (!value.focus)
        context.addIssue({
          code: "custom",
          path: ["focus"],
          message: "create_focus 必须提供 focus",
        });
      if (value.schedule)
        context.addIssue({
          code: "custom",
          path: ["schedule"],
          message: "create_focus 不允许 schedule",
        });
      return;
    }
    if (!value.schedule) {
      context.addIssue({
        code: "custom",
        path: ["schedule"],
        message: `${value.kind} 必须提供 schedule`,
      });
      return;
    }
    if (value.focus)
      context.addIssue({
        code: "custom",
        path: ["focus"],
        message: `${value.kind} 不允许 focus`,
      });
    for (const field of localOperations[value.kind].required) {
      if (value.schedule[field as keyof ScheduleAction] === undefined)
        context.addIssue({
          code: "custom",
          path: ["schedule", field],
          message: `缺少 ${field}`,
        });
    }
    if (
      value.kind === "add_schedule" &&
      (!value.schedule.course?.weekday || !value.schedule.course.weeks.length)
    )
      context.addIssue({
        code: "custom",
        path: ["schedule", "course"],
        message: "周期课程需提供 weekday 和 weeks",
      });
    const changes = value.schedule.changes;
    if (
      changes?.startPeriod !== undefined &&
      changes.endPeriod !== undefined &&
      changes.endPeriod < changes.startPeriod
    ) {
      context.addIssue({
        code: "custom",
        path: ["schedule", "changes", "endPeriod"],
        message: "endPeriod 不能早于 startPeriod",
      });
    }
  });

export type LocalActionProposal = z.infer<typeof localActionProposalSchema>;

export function localActionExecutionPayload(proposal: LocalActionProposal) {
  if (proposal.kind === "create_focus") return proposal.focus!;
  const operation = localOperations[proposal.kind].operation;
  return { ...proposal.schedule!, operation };
}

import { z } from "zod";

export const focusActionSchema = z.object({
  kind: z.enum(["notice", "course"]),
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(2_000),
  categories: z.array(z.enum(["news", "academic", "lectures", "student_status", "practice", "teaching_research", "downloads"])).min(1).max(7).optional(),
  courseName: z.string().trim().max(200).optional(),
  teacherNames: z.array(z.string().trim().min(1).max(100)).max(10).optional(),
  sourceKeys: z.array(z.string().trim().min(1)).max(20).optional(),
  semester: z.string().trim().max(100).optional(),
  summary: z.boolean().default(true),
  summaryInstructions: z.string().trim().max(2_000).optional(),
}).strict().superRefine((value, context) => {
  if (value.kind === "course" && !value.courseName) {
    context.addIssue({ code: "custom", path: ["courseName"], message: "课程关注必须提供课程名称" });
  }
});

const scheduleCourseSchema = z.object({
  courseName: z.string().trim().min(1).max(200),
  teacherName: z.string().trim().max(100).default(""),
  weekday: z.number().int().min(1).max(7),
  startPeriod: z.number().int().min(1).max(13),
  endPeriod: z.number().int().min(1).max(13),
  weeks: z.array(z.number().int().min(1).max(30)).min(1).max(30).transform((weeks) => [...new Set(weeks)].sort((a, b) => a - b)),
  classroom: z.string().trim().max(200).default(""),
  courseCode: z.string().trim().max(100).default(""),
}).strict().refine((value) => value.endPeriod >= value.startPeriod, {
  path: ["endPeriod"], message: "endPeriod 不能早于 startPeriod",
});

const scheduleChangesSchema = z.object({
  courseName: z.string().trim().min(1).max(200).optional(),
  teacherName: z.string().trim().max(100).optional(),
  weekday: z.number().int().min(1).max(7).optional(),
  startPeriod: z.number().int().min(1).max(13).optional(),
  endPeriod: z.number().int().min(1).max(13).optional(),
  weeks: z.array(z.number().int().min(1).max(30)).min(1).max(30).transform((weeks) => [...new Set(weeks)].sort((a, b) => a - b)).optional(),
  classroom: z.string().trim().max(200).optional(),
  courseCode: z.string().trim().max(100).optional(),
}).strict();

export const scheduleActionSchema = z.object({
  course: scheduleCourseSchema.optional(),
  sourceKey: z.string().trim().min(1).optional(),
  changes: scheduleChangesSchema.optional(),
  fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).strict();

export const localActionProposalSchema = z.object({
  kind: z.enum(["create_focus", "add_schedule", "update_schedule", "move_schedule"]),
  focus: focusActionSchema.optional(),
  schedule: scheduleActionSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.kind === "create_focus") {
    if (!value.focus) context.addIssue({ code: "custom", path: ["focus"], message: "create_focus 必须提供 focus" });
    if (value.schedule) context.addIssue({ code: "custom", path: ["schedule"], message: "create_focus 不允许 schedule" });
    return;
  }
  if (!value.schedule) {
    context.addIssue({ code: "custom", path: ["schedule"], message: `${value.kind} 必须提供 schedule` });
    return;
  }
  if (value.focus) context.addIssue({ code: "custom", path: ["focus"], message: `${value.kind} 不允许 focus` });
  if (value.kind === "add_schedule" && !value.schedule.course) {
    context.addIssue({ code: "custom", path: ["schedule", "course"], message: "add_schedule 必须提供完整 course" });
  }
  if (value.kind === "update_schedule") {
    if (!value.schedule.sourceKey) context.addIssue({ code: "custom", path: ["schedule", "sourceKey"], message: "update_schedule 必须提供 sourceKey" });
    if (!value.schedule.changes || !Object.keys(value.schedule.changes).length) context.addIssue({ code: "custom", path: ["schedule", "changes"], message: "update_schedule 必须至少修改一个字段" });
  }
  if (value.kind === "move_schedule") {
    if (!value.schedule.sourceKey) context.addIssue({ code: "custom", path: ["schedule", "sourceKey"], message: "move_schedule 必须提供 sourceKey" });
    if (!value.schedule.fromDate) context.addIssue({ code: "custom", path: ["schedule", "fromDate"], message: "move_schedule 必须提供 fromDate" });
    if (!value.schedule.toDate) context.addIssue({ code: "custom", path: ["schedule", "toDate"], message: "move_schedule 必须提供 toDate" });
  }
  const changes = value.schedule.changes;
  if (changes?.startPeriod !== undefined && changes.endPeriod !== undefined && changes.endPeriod < changes.startPeriod) {
    context.addIssue({ code: "custom", path: ["schedule", "changes", "endPeriod"], message: "endPeriod 不能早于 startPeriod" });
  }
});

export type LocalActionProposal = z.infer<typeof localActionProposalSchema>;

export function localActionExecutionPayload(proposal: LocalActionProposal) {
  if (proposal.kind === "create_focus") return proposal.focus!;
  const operation = proposal.kind === "add_schedule" ? "add" : proposal.kind === "update_schedule" ? "update" : "move";
  return { ...proposal.schedule!, operation };
}

import { useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { Session } from "./session.js";
import { semesterOptions } from "./course-layout.js";
import { states } from "./theme.js";

export type Page = "chat" | "schedule" | "programs" | "focus" | "notices";

export function useAppDialogs(
  resumePickerRequested: Session["resumePickerRequested"],
) {
  const [modal, setModal] = useState<string | null>(
    resumePickerRequested ? "resume" : null,
  );
  const [detail, setDetail] = useState<any>(null);
  useEffect(() => {
    if (resumePickerRequested) setModal("resume");
  }, [resumePickerRequested]);
  return { modal, setModal, detail, setDetail };
}

export function dialogOptions(
  modal: string | null,
  {
    plan,
    schedule,
    programs,
    gridOptions,
  }: {
    plan: any;
    schedule: Session["schedule"];
    programs: Session["programs"];
    gridOptions: { current: any[] };
  },
) {
  return modal === "program-semester"
    ? [
        { label: "全部学期", value: "all" },
        ...Array.from(
          new Map(
            (plan.courses ?? []).flatMap((course: any) =>
              semesterOptions(course).map((option: any) => [
                option.value,
                option.label,
              ]),
            ),
          ).entries(),
        )
          .sort(([a], [b]) => String(a).localeCompare(String(b)))
          .map(([value, label]) => ({
            value: String(value),
            label: String(label),
          })),
      ]
    : modal === "grid-courses"
      ? gridOptions.current.map((c: any, i: number) => ({
          label: c.courseName + " · " + c.teacherName,
          value: String(i),
        }))
      : modal === "semester"
        ? (schedule.availableSemesters ?? []).map((s: any) => ({
            label: s.label,
            value: s.value,
          }))
        : modal === "week"
          ? [
              { label: "全部周次", value: "all" },
              ...Array.from({ length: 20 }, (_, i) => ({
                label: `第 ${i + 1} 周`,
                value: String(i + 1),
              })),
            ]
          : modal === "plan"
            ? (programs.plans ?? []).map((p: any, i: number) => ({
                label: p.title,
                value: String(i),
              }))
            : [
                { label: "全部状态", value: "all" },
                ...Object.entries(states).map(([value, label]) => ({
                  value,
                  label,
                })),
              ];
}

type DialogActions = {
  setModal: Dispatch<SetStateAction<string | null>>;
  setSelected: Dispatch<SetStateAction<number>>;
  setTableTop: Dispatch<SetStateAction<number>>;
  setDetail: Dispatch<SetStateAction<any>>;
  setWeek: Dispatch<SetStateAction<string>>;
  setCourseState: Dispatch<SetStateAction<string>>;
  setPlanIndex: Dispatch<SetStateAction<number>>;
  setProgramSemester: Dispatch<SetStateAction<string>>;
  run: (text: string) => Promise<void>;
  gridOptions: { current: any[] };
};
export async function selectDialogValue(
  modal: string | null,
  value: string,
  actions: DialogActions,
) {
  const {
    setModal,
    setSelected,
    setTableTop,
    setDetail,
    setWeek,
    setCourseState,
    setPlanIndex,
    setProgramSemester,
    run,
    gridOptions,
  } = actions;
  const kind = modal;
  setModal(null);
  setSelected(0);
  setTableTop(0);
  if (kind === "semester") await run(`/schedule --semester "${value}"`);
  if (kind === "grid-courses") setDetail(gridOptions.current[Number(value)]);
  if (kind === "week") setWeek(value);
  if (kind === "state") setCourseState(value);
  if (kind === "plan") {
    setPlanIndex(Number(value));
    setProgramSemester("all");
  }
  if (kind === "program-semester") setProgramSemester(value);
}

import React from "react";
import { Box, Text, type DOMElement } from "ink";
import { Timetable } from "./timetable.js";
import { fit, periodTimes, type DocumentRow } from "./course-layout.js";
import { color, weekdays, states } from "./theme.js";
import type { Span } from "./markdown.js";

export function CourseDetail({
  detail,
  page,
  term,
  currentSemester,
}: {
  detail: any;
  page: string;
  term: string;
  currentSemester: string;
}) {
  return (
    <Box
      borderStyle="round"
      borderColor={color.accent}
      flexDirection="column"
      paddingX={2}
    >
      <Text bold color={color.accent}>
        {detail.courseName ?? detail.name}
      </Text>
      <Text>课程代码：{detail.courseCode ?? detail.code}</Text>
      {page === "schedule" ? (
        <>
          <Text>教师：{detail.teacherName}</Text>
          <Text>地点：{detail.classroom}</Text>
          <Text>
            时间：周{weekdays[detail.weekday - 1]} · 第 {detail.startPeriod}–
            {detail.endPeriod} 节
            {" · " +
              (periodTimes[detail.startPeriod]?.split("–")[0] ?? "—") +
              "–" +
              (periodTimes[detail.endPeriod]?.split("–")[1] ?? "—")}
          </Text>
          <Text wrap="wrap">周次：{detail.weeks?.join("、")}</Text>
        </>
      ) : (
        <>
          <Text>
            学分：{detail.credits} · {states[detail.status]}
          </Text>
          <Text>
            分类：{detail.group} · {detail.nature}
          </Text>
          <Text>
            学期：
            {detail.displaySemester ?? detail.semesterLabel ?? detail.semester}
          </Text>
          <Text wrap="wrap">
            备注：
            {[detail.choiceNote, detail.note].filter(Boolean).join(" · ") ||
              "暂无"}
          </Text>
        </>
      )}
      <Text color={color.muted}>
        {page === "schedule"
          ? !term || term === currentSemester
            ? "e 编辑课程 · Esc 返回列表"
            : "历史课表只读 · Esc 返回列表"
          : "s 修改修读状态 · Esc 返回列表"}
      </Text>
    </Box>
  );
}

export function TranscriptLines({ lines }: { lines: Span[][] }) {
  return (
    <>
      {lines.map((line, i) => (
        <Text key={i} backgroundColor={line[0]?.user ? "#394858" : undefined}>
          {line.map((span, j) => (
            <Text
              key={j}
              color={
                span.user
                  ? "#dde7f1"
                  : (span.color ??
                    (span.role === "你"
                      ? color.accent
                      : span.role === "SEUdaily"
                        ? color.strong
                        : span.code
                          ? "#e5c07b"
                          : span.muted
                            ? color.muted
                            : color.text))
              }
              backgroundColor={span.backgroundColor}
              bold={span.bold}
            >
              {span.text}
            </Text>
          ))}
        </Text>
      ))}
    </>
  );
}

export function CourseResults({
  page,
  isGrid,
  choices,
  width,
  height,
  tableTop,
  gridCount,
  dayStart,
  gridSelection,
  selected,
  programRows,
  cells,
  headers,
  visibleCount,
  row,
  registerGrid,
  registerRow,
}: {
  page: string;
  isGrid: boolean;
  choices: any[];
  width: number;
  height: number;
  tableTop: number;
  gridCount: number;
  dayStart: number;
  gridSelection: { day: number; period: number } | null;
  selected: number;
  programRows: DocumentRow[];
  cells: number[];
  headers: string[];
  visibleCount: number;
  row: (course: any) => any[];
  registerGrid: (
    index: number,
    element: DOMElement | null,
    items: any[],
  ) => void;
  registerRow: (index: number, element: DOMElement | null) => void;
}) {
  return (
    <>
      {isGrid ? (
        <Timetable
          courses={choices}
          width={width}
          start={tableTop}
          count={gridCount}
          dayStart={dayStart}
          selection={gridSelection}
          register={(index, element, items) => {
            registerGrid(index, element, items);
          }}
        />
      ) : page === "programs" ? (
        <Box
          flexDirection="column"
          height={Math.max(1, height - 4)}
          overflow="hidden"
        >
          {programRows
            .slice(tableTop, tableTop + height - 4)
            .map((row, index) => (
              <Box
                key={index}
                height={1}
                flexShrink={0}
                ref={(element) => {
                  registerRow(index, element);
                }}
              >
                <Text
                  bold={row.kind === "title" || row.kind === "group"}
                  color={
                    row.index === selected
                      ? "#20242c"
                      : row.kind === "title"
                        ? color.accent
                        : row.kind === "border" || row.kind === "muted"
                          ? color.muted
                          : color.text
                  }
                  backgroundColor={
                    row.index === selected ? "#80cbc4" : undefined
                  }
                >
                  {row.text}
                </Text>
              </Box>
            ))}
        </Box>
      ) : (
        <>
          <Text bold color={color.muted}>
            {" "}
            {headers
              .slice(0, cells.length)
              .map((h, i) => fit(h, cells[i]))
              .join(" ")}
          </Text>
          {choices
            .slice(tableTop, tableTop + visibleCount)
            .map((c: any, i: number) => (
              <Box
                key={i}
                ref={(element) => {
                  registerRow(i, element);
                }}
                height={1}
                flexShrink={0}
              >
                <Text
                  backgroundColor={
                    tableTop + i === selected ? "#80cbc4" : undefined
                  }
                  color={tableTop + i === selected ? "#20242c" : color.text}
                >
                  {tableTop + i === selected ? "› " : "  "}
                  {row(c)
                    .slice(0, cells.length)
                    .map((v, i) => fit(v, cells[i]))
                    .join(" ")}
                </Text>
              </Box>
            ))}
          {!choices.length && <Text color={color.muted}>没有匹配课程。</Text>}
        </>
      )}
    </>
  );
}

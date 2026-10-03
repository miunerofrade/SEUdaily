import React from "react";
import { Box, Text, type DOMElement } from "ink";
import { fit, wrap, periodTimes } from "./course-layout.js";
export function gridGeometry(width: number) {
  const days = Math.max(1, Math.min(7, Math.floor((width - 15) / 15)));
  return {
    days,
    timeWidth: 11,
    cellWidth: Math.max(
      5,
      Math.floor((width - 11 - 3 * (days + 1) - 1) / days),
    ),
  };
}
export function Timetable({
  courses,
  width,
  start,
  count,
  dayStart,
  selection,
  register,
}: {
  courses: any[];
  width: number;
  start: number;
  count: number;
  dayStart: number;
  selection: { day: number; period: number } | null;
  register: (index: number, element: DOMElement | null, items: any[]) => void;
}) {
  const { days, timeWidth, cellWidth } = gridGeometry(width),
    labels = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
  const at = (period: number, day: number) =>
    courses.filter(
      (c) =>
        c.weekday === day + 1 &&
        c.startPeriod <= period &&
        c.endPeriod >= period,
    );
  const selectedItems = selection ? at(selection.period, selection.day) : [];
  const line = (
    left: string,
    middle: string,
    right: string,
    period?: number,
  ) => {
    const continuous = Array.from({ length: days }, (_, i) => {
      const before = period ? at(period, dayStart + i) : [],
        after = period ? at(period + 1, dayStart + i) : [];
      return (
        before.length === 1 && after.length === 1 && before[0] === after[0]
      );
    });
    if (!period)
      return (
        left +
        "─".repeat(timeWidth + 2) +
        middle +
        Array.from({ length: days }, () => "─".repeat(cellWidth + 2)).join(
          middle,
        ) +
        right
      );
    let result = left + "─".repeat(timeWidth + 2) + (continuous[0] ? "┤" : "┼");
    for (let i = 0; i < days; i++) {
      result += (continuous[i] ? " " : "─").repeat(cellWidth + 2);
      result +=
        i === days - 1
          ? continuous[i]
            ? "│"
            : right
          : continuous[i]
            ? continuous[i + 1]
              ? "│"
              : "├"
            : continuous[i + 1]
              ? "┤"
              : "┼";
    }
    return result;
  };
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text color="#64738a">{line("┌", "┬", "┐")}</Text>
      <Text bold color="#80cbc4">
        {"│ " +
          fit("节次 / 时间", timeWidth) +
          " │ " +
          labels
            .slice(dayStart, dayStart + days)
            .map((day) => fit(day, cellWidth))
            .join(" │ ") +
          " │"}
      </Text>
      <Text color="#64738a">{line("├", "┼", "┤")}</Text>
      {Array.from({ length: 13 }, (_, i) => i + 1)
        .slice(start, start + count)
        .map((period) => (
          <React.Fragment key={period}>
            <Box height={2} flexShrink={0}>
              <Text color="#64738a">{"│ \n│ "}</Text>
              <Box width={timeWidth} flexDirection="column">
                <Text bold>{fit(String(period), timeWidth)}</Text>
                <Text color="#8993a4">{periodTimes[period]}</Text>
              </Box>
              <Text color="#64738a">{" │ \n │ "}</Text>
              {Array.from({ length: days }, (_, i) => {
                const day = dayStart + i,
                  items = at(period, day),
                  course = items[0];
                const active = selection?.day === day && items.some(item => selectedItems.includes(item));
                const lines = course
                  ? wrap(course.courseName, cellWidth).concat(
                      wrap(course.classroom || "未提供地点", cellWidth),
                      wrap(course.teacherName || "", cellWidth),
                    )
                  : [];
                const position = course
                  ? Math.max(0, (period - course.startPeriod) * 2)
                  : 0;
                const texts =
                  items.length > 1
                    ? [course?.courseName, `+${items.length - 1} 个安排`]
                    : lines.slice(position, position + 2);
                return (
                  <React.Fragment key={day}>
                    <Box
                      width={cellWidth}
                      flexDirection="column"
                      ref={(element) =>
                        register((period - 1) * 7 + day, element, items)
                      }
                    >
                      <Text backgroundColor={active ? "#394858" : undefined} bold={active} color={course ? "#80cbc4" : "#dce1ea"}>
                        {fit(texts[0] || "", cellWidth)}
                      </Text>
                      <Text backgroundColor={active ? "#394858" : undefined} color={active ? "#dce1ea" : "#8993a4"}>
                        {fit(texts[1] || "", cellWidth)}
                      </Text>
                    </Box>
                    <Text color="#64738a">{" │ \n │ "}</Text>
                  </React.Fragment>
                );
              })}
            </Box>
            <Text color="#64738a">
              {line(
                period === 13 ? "└" : "├",
                period === 13 ? "┴" : "┼",
                period === 13 ? "┘" : "┤",
                period === 13 ? undefined : period,
              )}
            </Text>
          </React.Fragment>
        ))}
    </Box>
  );
}

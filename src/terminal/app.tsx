import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  Box,
  Text,
  useInput,
  usePaste,
  useApp,
  useStdin,
  useStdout,
  useWindowSize,
  measureElement,
  type DOMElement,
} from "ink";
import { Select } from "@inkjs/ui";
import { editorRows } from "./editor.js";
import { messageLines } from "./markdown.js";
import { Session } from "./session.js";
import { commandSuggestions, attachmentSuggestions } from "./completion.js";
import { clean } from "./client.js";
import stringWidth from "string-width";

const color = {
  accent: "#80cbc4",
  muted: "#8993a4",
  strong: "#a8bfff",
  text: "#dce1ea",
  border: "#64738a",
};
const fit = (value: any, width: number) => {
  let text = clean(String(value ?? "")).replace(/\n/g, " "),
    out = "";
  if (stringWidth(text) > width) {
    for (const char of text) {
      if (stringWidth(out + char) > width - 1) break;
      out += char;
    }
    text = out + "…";
  }
  return text + " ".repeat(Math.max(0, width - stringWidth(text)));
};
const wrap = (text: string, width: number) =>
  text.split("\n").flatMap((line) => {
    const result: string[] = [];
    let value = "",
      used = 0;
    for (const char of line) {
      const size = stringWidth(char);
      if (value && used + size > width) {
        result.push(value);
        value = "";
        used = 0;
      }
      value += char;
      used += size;
    }
    result.push(value);
    return result;
  });
const weekdays = ["一", "二", "三", "四", "五", "六", "日"];
const states: Record<string, string> = {
  completed: "已修读",
  studying: "修读中",
  not_taken: "未修读",
  upcoming: "待开课",
  unscheduled: "未排定",
};
type Page = "chat" | "schedule" | "programs";

export function App({ session }: { session: Session }) {
  const [, refresh] = useState(0);
  const schedule = session.schedule,
    programs = session.programs;
  const { exit } = useApp();
  const { stdin } = useStdin();
  const { stdout } = useStdout();
  const { columns, rows } = useWindowSize();
  const width = Math.max(20, columns - 4);
  const [page, setPage] = useState<Page>("chat");
  const [input, setInput] = useState("");
  const [caret, setCaret] = useState(0);
  const editor = useRef({ text: "", cursor: 0 });
  const historyIndex = useRef(-1);
  const historyDraft = useRef("");
  const edit = (text: string, cursor: number) => {
    editor.current = { text, cursor };
    setInput(text);
    setCaret(cursor);
  };
  const messages = session.messages;
  const status = session.status,
    busy = session.busy;
  const [offset, setOffset] = useState<number | null>(null);
  const [field, setField] = useState(0);
  const [modal, setModal] = useState<string | null>(null);
  const [detail, setDetail] = useState<any>(null);
  const [term, setTerm] = useState(schedule.selectedSemester);
  const [courses, setCourses] = useState<any[]>(schedule.courses);
  const [week, setWeek] = useState("all");
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState(0);
  const [tableTop, setTableTop] = useState(0);
  const [planIndex, setPlanIndex] = useState(0);
  const [courseState, setCourseState] = useState("all");
  const [grid, setGrid] = useState(false);
  const inputHeight =
    page === "chat"
      ? Math.min(
          8,
          Math.max(
            4,
            wrap(input, width - 4).length + 3 + (input.startsWith("/") ? 1 : 0),
          ),
        )
      : 4;
  const height = Math.max(3, rows - inputHeight - 8);
  const inputLayout = editorRows(input, caret, width - 4);
  const inputCapacity = inputHeight - 3 - (input.startsWith("/") ? 1 : 0);
  const inputTop = Math.max(
    0,
    inputLayout.cursorRow - Math.max(1, inputCapacity) + 1,
  );
  const fields = useRef<(DOMElement | null)[]>([]),
    tableRows = useRef<(DOMElement | null)[]>([]);
  const gridCells = useRef<{ element: DOMElement | null; items: any[] }[]>([]),
    gridOptions = useRef<any[]>([]);
  const previous = useRef({
    schedule: session.schedule,
    programs: session.programs,
    options: session.viewOptions,
  });
  useEffect(() => {
    const changed = () => {
      refresh((n) => n + 1);
      setPage(session.page as Page);
      if (
        previous.current.schedule !== session.schedule ||
        previous.current.programs !== session.programs ||
        previous.current.options !== session.viewOptions
      ) {
        setCourses(session.schedule.courses ?? []);
        setTerm(session.schedule.selectedSemester);
        setFilter(session.viewOptions.filter ?? "");
        setPlanIndex(
          Math.max(
            0,
            session.programs.plans?.findIndex(
              (p: any) => p.id === session.viewOptions.plan,
            ) ?? 0,
          ),
        );
        setSelected(0);
        setTableTop(
          Math.max(
            0,
            (Number(session.viewOptions.page ?? 1) - 1) *
              Number(session.viewOptions.limit ?? 20),
          ),
        );
        previous.current = {
          schedule: session.schedule,
          programs: session.programs,
          options: session.viewOptions,
        };
      }
    };
    session.on("change", changed);
    return () => {
      session.off("change", changed);
    };
  }, [session]);
  const run = async (text: string) => {
    try {
      await session.submit(text);
    } catch (error) {
      session.page = "chat";
      session.status =
        "错误：" + (error instanceof Error ? error.message : String(error));
      session.show(
        error instanceof Error ? error.message : String(error),
        "错误",
      );
    }
  };
  const viMode = useRef(false);
  const decisions = session.pending || session.confirmation;
  const [decisionOffset, setDecisionOffset] = useState(0);
  const decisionLines = useMemo(
    () =>
      wrap(
        clean(
          session.pending
            ? `${session.pending.toolName}\n${JSON.stringify(session.pending.args ?? {}, null, 2)}`
            : (session.confirmation?.text ?? ""),
        ),
        Math.max(1, width - 6),
      ),
    [session.pending, session.confirmation, width],
  );
  const decisionCapacity = Math.max(1, height - 6);
  const decisionMaxOffset = Math.max(
    0,
    decisionLines.length - decisionCapacity,
  );
  useEffect(
    () => setDecisionOffset(0),
    [session.pending?.approvalId, session.confirmation],
  );
  const plan = programs.plans?.[planIndex] ?? {
    title: "暂无培养方案",
    courses: [],
  };
  const termLabel =
    (schedule.availableSemesters ?? []).find((s: any) => s.value === term)
      ?.label ?? term;
  const choices = useMemo(
    () =>
      page === "schedule"
        ? courses.filter(
            (c) =>
              (week === "all" || c.weeks?.includes(Number(week))) &&
              c.courseName.includes(filter),
          )
        : (plan?.courses ?? []).filter(
            (c: any) =>
              (courseState === "all" || c.status === courseState) &&
              (c.name.includes(filter) || c.code?.includes(filter)),
          ),
    [page, courses, week, filter, courseState, plan],
  );
  const displayLines = useMemo(
    () => messages.flatMap((message) => messageLines(message, width)),
    [messages, width],
  );
  const maxOffset = Math.max(0, displayLines.length - height);
  const top = offset === null ? maxOffset : Math.min(maxOffset, offset);
  const visibleCount = Math.max(2, height - (page === "programs" ? 6 : 5));
  const gridCount = Math.max(1, Math.floor((height - 5) / 2));
  const isGrid = grid && page === "schedule" && columns >= 110;
  const [pathSuggestions, setPathSuggestions] = useState<{
    input: string;
    values: string[];
  }>({ input: "", values: [] });
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      if (input.startsWith("/attach "))
        void attachmentSuggestions(input, session.root).then((values) => {
          if (active) setPathSuggestions({ input, values });
        });
    }, 80);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [input, session.root]);
  const suggestions = input.startsWith("/attach ")
    ? pathSuggestions.input === input
      ? pathSuggestions.values
      : []
    : commandSuggestions(
        input,
        session.catalog.map((s) => s.name),
      );
  const changePage = (next: Page) => {
    if (next === "chat") {
      session.page = "chat";
      session.changed();
    } else void run("/" + next);
    setPage(next);
    edit("", 0);
    setModal(null);
    setDetail(null);
    setFilter("");
    setSelected(0);
    setTableTop(0);
    setField(0);
  };
  const insert = (value: string) => {
    value = clean(value);
    const { text, cursor } = editor.current;
    edit(
      text.slice(0, cursor) + value + text.slice(cursor),
      cursor + value.length,
    );
  };
  const cancel = () => void session.cancel();
  const wheel = (amount: number) => {
    if (decisions) {
      setDecisionOffset((current) =>
        Math.max(0, Math.min(decisionMaxOffset, current + amount)),
      );
      return;
    }
    if (modal || detail) return;
    if (page === "chat")
      setOffset((current) => {
        const n = Math.max(
          0,
          Math.min(maxOffset, (current ?? maxOffset) + amount),
        );
        return n === maxOffset ? null : n;
      });
    else
      setTableTop((current) =>
        Math.max(
          0,
          Math.min(
            Math.max(
              0,
              isGrid ? 13 - gridCount : choices.length - visibleCount,
            ),
            current + amount,
          ),
        ),
      );
  };
  const wheelRef = useRef(wheel);
  wheelRef.current = wheel;
  const clickRef = useRef((x: number, y: number) => {});
  clickRef.current = (x, y) => {
    if (modal || detail || decisions || page === "chat") return;
    for (let index = 0; index < fields.current.length; index++) {
      const element = fields.current[index];
      if (!element) continue;
      const box = measureElement(element);
      if (
        x >= box.x &&
        x < box.x + box.width &&
        y >= box.y &&
        y < box.y + box.height
      ) {
        setField(index);
        if (index === 0) setModal(page === "schedule" ? "semester" : "plan");
        if (index === 1) setModal(page === "schedule" ? "week" : "state");
        if (index === 3) setDetail(choices[selected]);
        return;
      }
    }
    if (isGrid) {
      for (const cell of gridCells.current) {
        if (!cell?.element) continue;
        const box = measureElement(cell.element);
        if (
          x >= box.x &&
          x < box.x + box.width &&
          y >= box.y &&
          y < box.y + box.height &&
          cell.items.length
        ) {
          if (cell.items.length === 1) setDetail(cell.items[0]);
          else {
            gridOptions.current = cell.items;
            setModal("grid-courses");
          }
          return;
        }
      }
      return;
    }
    for (let index = 0; index < tableRows.current.length; index++) {
      const element = tableRows.current[index];
      if (!element) continue;
      const box = measureElement(element);
      if (
        x >= box.x &&
        x < box.x + box.width &&
        y >= box.y &&
        y < box.y + box.height
      ) {
        setSelected(tableTop + index);
        setDetail(choices[tableTop + index]);
        return;
      }
    }
  };
  useEffect(() => {
    stdout.write("\x1b[?1000h\x1b[?1006h");
    let pending = "";
    const handler = (data: Buffer | string) => {
      pending += String(data);
      const events = [...pending.matchAll(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g)];
      for (const event of events) {
        const button = Number(event[1]);
        if (button === 64 || button === 65)
          wheelRef.current(button === 64 ? -3 : 3);
        else if (button === 0 && event[4] === "M")
          clickRef.current(Number(event[2]) - 1, Number(event[3]) - 1);
      }
      const marker = pending.lastIndexOf("\x1b[<");
      pending =
        marker >= 0 && !/^[\s\S]*\x1b\[<\d+;\d+;\d+[Mm]$/.test(pending)
          ? pending.slice(marker)
          : "";
      if (pending.length > 100) pending = "";
    };
    stdin.on("data", handler);
    return () => {
      stdin.off("data", handler);
      stdout.write("\x1b[?1000l\x1b[?1006l");
      cancel();
    };
  }, []);
  const newSelection = (index: number) => {
    index = Math.max(0, Math.min(choices.length - 1, index));
    setSelected(index);
    setTableTop((current) =>
      index < current
        ? index
        : index >= current + visibleCount
          ? index - visibleCount + 1
          : current,
    );
  };
  usePaste((text) => {
    if (page === "chat" && !modal && !detail && !decisions) insert(text);
  });
  useInput((value, key) => {
    if (value.includes("[<") || /^<?\d+;\d+;\d+[Mm]$/.test(value)) return;
    if (key.ctrl && value === "d") {
      if (editor.current.text && !decisions) {
        const { text, cursor } = editor.current;
        const length = [...text.slice(cursor)][0]?.length ?? 0;
        edit(text.slice(0, cursor) + text.slice(cursor + length), cursor);
        return;
      }
      cancel();
      exit();
      return;
    }
    if (key.ctrl && value === "c") {
      if (busy) cancel();
      else {
        edit("", 0);
        setModal(null);
        setDetail(null);
      }
      return;
    }
    if (key.escape) {
      if (
        session.options.vi &&
        page === "chat" &&
        !decisions &&
        !modal &&
        !detail
      ) {
        viMode.current = true;
        session.changed();
        return;
      }
      if (modal) setModal(null);
      else if (detail) setDetail(null);
      else if (page !== "chat") changePage("chat");
      return;
    }
    if (modal) return;
    if (key.pageUp) {
      wheel(-Math.max(1, height - 1));
      return;
    }
    if (key.pageDown) {
      wheel(Math.max(1, height - 1));
      return;
    }
    if (decisions) return;
    if (key.ctrl && key.end) {
      setOffset(null);
      return;
    }
    if (key.ctrl && key.home) {
      setOffset(0);
      return;
    }
    if (detail) return;
    if (page !== "chat") {
      if (key.tab) {
        setField((old) => (old + (key.shift ? 3 : 1)) % 4);
        return;
      }
      if (field === 2) {
        if (key.return) {
          setField(3);
          return;
        }
        if (key.backspace || key.delete) {
          setFilter((old) => Array.from(old).slice(0, -1).join(""));
          setSelected(0);
          setTableTop(0);
          return;
        }
        if (value && !key.ctrl && !key.meta) {
          setFilter((old) => old + clean(value));
          setSelected(0);
          setTableTop(0);
          return;
        }
      }
      if (key.upArrow) {
        newSelection(selected - 1);
        return;
      }
      if (key.downArrow) {
        newSelection(selected + 1);
        return;
      }
      if (key.return) {
        if (field === 0) setModal(page === "schedule" ? "semester" : "plan");
        else if (field === 1) setModal(page === "schedule" ? "week" : "state");
        else if (field === 3) setDetail(choices[selected]);
        return;
      }
      if (value === "r") {
        void run("/" + page + " --sync");
        return;
      }
      if (value === "g" && page === "schedule") {
        setGrid((old) => !old);
        setTableTop(0);
        return;
      }
      return;
    }
    if (key.tab && suggestions.length) {
      edit(suggestions[0], suggestions[0].length);
      return;
    }
    if (session.options.vi && viMode.current) {
      const { text, cursor } = editor.current;
      if (value === "i") viMode.current = false;
      else if (value === "a") {
        viMode.current = false;
        edit(
          text,
          Math.min(
            text.length,
            cursor + ([...text.slice(cursor)][0]?.length ?? 0),
          ),
        );
      } else if (value === "h")
        edit(
          text,
          Math.max(
            0,
            cursor - ([...text.slice(0, cursor)].at(-1)?.length ?? 0),
          ),
        );
      else if (value === "l")
        edit(
          text,
          Math.min(
            text.length,
            cursor + ([...text.slice(cursor)][0]?.length ?? 0),
          ),
        );
      else if (value === "0") edit(text, 0);
      else if (value === "$") edit(text, text.length);
      else if (value === "x")
        edit(
          text.slice(0, cursor) +
            text.slice(cursor + ([...text.slice(cursor)][0]?.length ?? 0)),
          cursor,
        );
      else if (!key.return) return;
      session.changed();
      if (!key.return) return;
    }
    if (key.return) {
      if (key.meta || key.shift) {
        insert("\n");
        return;
      }
      const text = editor.current.text.trim();
      if (!text) return;
      if (busy && text !== "/cancel") return;
      if (text === "/quit" || text === "/exit") {
        cancel();
        exit();
        return;
      }
      if (text === "/chat") {
        changePage("chat");
        return;
      }
      edit("", 0);
      historyIndex.current = -1;
      setOffset(null);
      setModal(null);
      setDetail(null);
      void run(text);
      return;
    }
    if (key.upArrow || key.downArrow) {
      if (historyIndex.current < 0) {
        historyDraft.current = editor.current.text;
        historyIndex.current = session.inputHistory.length;
      }
      historyIndex.current = Math.max(
        0,
        Math.min(
          session.inputHistory.length,
          historyIndex.current + (key.upArrow ? -1 : 1),
        ),
      );
      const value =
        historyIndex.current === session.inputHistory.length
          ? historyDraft.current
          : (session.inputHistory[historyIndex.current] ?? "");
      edit(value, value.length);
      return;
    }
    const { text, cursor } = editor.current;
    const before = Array.from(text.slice(0, cursor));
    const previous = before[before.length - 1]?.length ?? 0;
    const next = Array.from(text.slice(cursor))[0]?.length ?? 0;
    if (key.leftArrow) {
      edit(text, Math.max(0, cursor - previous));
      return;
    }
    if (key.rightArrow) {
      edit(text, Math.min(text.length, cursor + next));
      return;
    }
    if (key.home) {
      edit(text, 0);
      return;
    }
    if (key.end) {
      edit(text, text.length);
      return;
    }
    if (key.backspace) {
      edit(
        text.slice(0, cursor - previous) + text.slice(cursor),
        cursor - previous,
      );
      return;
    }
    if (key.delete) {
      edit(text.slice(0, cursor) + text.slice(cursor + next), cursor);
      return;
    }
    if (value && !key.ctrl && !key.meta) insert(value);
  });
  const choose = async (value: string) => {
    const kind = modal;
    setModal(null);
    setSelected(0);
    setTableTop(0);
    if (kind === "semester") await run(`/schedule --semester "${value}"`);
    if (kind === "grid-courses") setDetail(gridOptions.current[Number(value)]);
    if (kind === "week") setWeek(value);
    if (kind === "state") setCourseState(value);
    if (kind === "plan") setPlanIndex(Number(value));
  };
  const options =
    modal === "grid-courses"
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
  const fieldBox = (index: number, label: string, value: string) => (
    <Box
      key={index}
      ref={(element) => {
        fields.current[index] = element;
      }}
      width={Math.floor(width * [0.34, 0.17, 0.28, 0.16][index])}
      height={4}
      flexShrink={0}
      flexDirection="column"
      borderStyle="round"
      borderColor={field === index ? color.accent : color.border}
      paddingX={1}
      marginRight={1}
    >
      <Text color={color.muted}>{label}</Text>
      <Text wrap="truncate" color={field === index ? color.accent : color.text}>
        {value}
      </Text>
    </Box>
  );
  const cells =
    page === "schedule"
      ? [
          Math.max(12, Math.floor(width * 0.29)),
          7,
          9,
          Math.max(10, Math.floor(width * 0.19)),
          Math.max(8, Math.floor(width * 0.17)),
        ]
      : [
          Math.max(12, Math.floor(width * 0.36)),
          12,
          9,
          10,
          Math.max(8, Math.floor(width * 0.16)),
        ];
  if (page === "programs" && width < 90) {
    cells.splice(4);
    cells[1] = 10;
    cells[2] = 5;
    cells[3] = 8;
  }
  const row = (c: any) =>
    page === "schedule"
      ? [
          c.courseName,
          "周" + weekdays[c.weekday - 1],
          `${c.startPeriod}–${c.endPeriod}`,
          c.classroom,
          c.teacherName,
        ]
      : [c.name, c.code, c.credits, states[c.status] ?? c.status, c.group];
  const headers =
    page === "schedule"
      ? ["课程", "星期", "节次", "地点", "教师"]
      : ["课程", "代码", "学分", "修读状态", "分类"];
  return (
    <Box width={columns} height={rows} flexDirection="column" paddingX={1}>
      <Box height={2} flexShrink={0}>
        <Text bold color={color.accent}>
          SEUdaily
        </Text>
        <Text color={color.muted}>
          {" "}
          / 终端助手 · 会话 {session.threadId.slice(0, 8)} ·{" "}
          {session.skills.join(", ") || "自动 Skill"}
        </Text>
      </Box>
      <Box height={1} flexShrink={0}>
        <Text color={page === "chat" ? color.accent : color.muted}>聊天</Text>
        <Text> </Text>
        <Text color={page === "schedule" ? color.accent : color.muted}>
          课表
        </Text>
        <Text> </Text>
        <Text color={page === "programs" ? color.accent : color.muted}>
          培养方案
        </Text>
      </Box>
      <Box
        flexDirection="column"
        height={height}
        flexShrink={0}
        overflow="hidden"
        marginTop={1}
      >
        {decisions ? (
          <Box
            borderStyle="round"
            borderColor={color.accent}
            flexDirection="column"
            paddingX={2}
          >
            <Text bold>{session.pending ? "工具审批" : "确认操作"}</Text>
            <Box
              flexDirection="column"
              height={Math.min(decisionCapacity, decisionLines.length)}
              overflow="hidden"
            >
              {decisionLines
                .slice(
                  Math.min(decisionOffset, decisionMaxOffset),
                  Math.min(decisionOffset, decisionMaxOffset) +
                    decisionCapacity,
                )
                .map((line, index) => (
                  <Text key={index}>{line}</Text>
                ))}
            </Box>
            {decisionMaxOffset > 0 && (
              <Text color={color.muted}>PgUp/PgDn / 滚轮查看参数</Text>
            )}
            <Select
              key={session.pending?.approvalId ?? session.confirmation?.kind}
              isDisabled={busy}
              options={[
                { label: "拒绝 / 取消", value: "no" },
                { label: "批准 / 确认", value: "yes" },
              ]}
              onChange={(value) => {
                if (session.pending)
                  void run(value === "yes" ? "/approve" : "/reject");
                else void run(value === "yes" ? "y" : "n");
              }}
            />
          </Box>
        ) : modal ? (
          <Box
            borderStyle="round"
            borderColor={color.accent}
            flexDirection="column"
            paddingX={2}
          >
            <Text bold>
              选择
              {modal === "semester"
                ? "学期"
                : modal === "week"
                  ? "周次"
                  : modal === "plan"
                    ? "培养方案"
                    : "修读状态"}{" "}
              · ↑↓ 选择 · Enter 确认 · Esc 取消
            </Text>
            <Select
              key={modal}
              options={options}
              visibleOptionCount={Math.min(10, height - 3)}
              onChange={(value) => void choose(value)}
            />
          </Box>
        ) : detail ? (
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
                  时间：周{weekdays[detail.weekday - 1]} · 第{" "}
                  {detail.startPeriod}–{detail.endPeriod} 节
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
                <Text>学期：{detail.semesterLabel ?? detail.semester}</Text>
                <Text wrap="wrap">备注：{detail.note || "暂无"}</Text>
              </>
            )}
            <Text color={color.muted}>Esc 返回列表</Text>
          </Box>
        ) : page === "chat" ? (
          displayLines.slice(top, top + height).map((line, i) => (
            <Text key={i}>
              {line.map((span, j) => (
                <Text
                  key={j}
                  color={
                    span.role === "你"
                      ? color.accent
                      : span.role === "SEUdaily"
                        ? color.strong
                        : span.code
                          ? "#e5c07b"
                          : span.muted
                            ? color.muted
                            : color.text
                  }
                  bold={span.bold}
                >
                  {span.text}
                </Text>
              ))}
            </Text>
          ))
        ) : (
          <>
            <Box flexShrink={0}>
              {fieldBox(
                0,
                page === "schedule" ? "学期" : "方案",
                fit(
                  page === "schedule" ? termLabel : plan.title,
                  Math.max(8, Math.floor(width * 0.3)),
                ).trim(),
              )}
              {fieldBox(
                1,
                page === "schedule" ? "周次" : "状态",
                page === "schedule"
                  ? week === "all"
                    ? "全部"
                    : `第${week}周`
                  : (states[courseState] ?? "全部"),
              )}
              {fieldBox(2, "搜索", filter || "输入课程名")}
              {fieldBox(3, "课程详情", "Enter")}
            </Box>
            {page === "programs" && (
              <Text color={color.accent}>
                已修{" "}
                {plan.officialCompletedCredits ??
                  plan.completedCredits ??
                  "未知"}{" "}
                / 要求 {plan.requiredCredits ?? "未知"} 学分 · {choices.length}{" "}
                门课程
              </Text>
            )}
            {isGrid ? (
              <Box flexDirection="column">
                <Box height={1}>
                  <Box width={5}>
                    <Text color={color.muted}>节次</Text>
                  </Box>
                  {weekdays.map((day) => (
                    <Box key={day} width={Math.floor((width - 5) / 7)}>
                      <Text bold color={color.accent}>
                        周{day}
                      </Text>
                    </Box>
                  ))}
                </Box>
                {Array.from({ length: 13 }, (_, i) => i + 1)
                  .slice(tableTop, tableTop + gridCount)
                  .map((period) => (
                    <Box key={period} height={2} flexShrink={0}>
                      <Box width={5}>
                        <Text color={color.muted}>{period}</Text>
                      </Box>
                      {weekdays.map((day, index) => {
                        const items = choices.filter(
                          (c: any) =>
                            c.weekday === index + 1 &&
                            c.startPeriod <= period &&
                            c.endPeriod >= period,
                        );
                        const course = items[0];
                        const cellWidth = Math.floor((width - 5) / 7);
                        return (
                          <Box
                            key={day}
                            width={cellWidth}
                            height={2}
                            flexDirection="column"
                            ref={(element) => {
                              gridCells.current[(period - 1) * 7 + index] = {
                                element,
                                items,
                              };
                            }}
                          >
                            <Text
                              color={
                                course?.startPeriod === period
                                  ? color.accent
                                  : color.text
                              }
                              wrap="truncate"
                            >
                              {course
                                ? (course.startPeriod === period ? "" : "↳ ") +
                                  course.courseName
                                : " "}
                            </Text>
                            <Text color={color.muted} wrap="truncate">
                              {items.length > 1
                                ? `含 ${items.length} 个安排，点击选择`
                                : (course?.classroom ?? " ")}
                            </Text>
                          </Box>
                        );
                      })}
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
                        tableRows.current[i] = element;
                      }}
                      height={1}
                      flexShrink={0}
                    >
                      <Text
                        inverse={tableTop + i === selected}
                        color={
                          tableTop + i === selected ? color.accent : color.text
                        }
                      >
                        {tableTop + i === selected ? "› " : "  "}
                        {row(c)
                          .slice(0, cells.length)
                          .map((v, i) => fit(v, cells[i]))
                          .join(" ")}
                      </Text>
                    </Box>
                  ))}
                {!choices.length && (
                  <Text color={color.muted}>没有匹配课程。</Text>
                )}
              </>
            )}
          </>
        )}
      </Box>
      <Box height={1} flexShrink={0} marginTop={1}>
        <Text color={color.strong}>{status}</Text>
        <Text color={color.muted}>
          {" "}
          ·{" "}
          {page === "chat"
            ? `${Math.min(displayLines.length, top + height)}/${displayLines.length} 行`
            : `${choices.length} 门课程 · Tab 切换控件`}{" "}
          {offset !== null && page === "chat" ? "· 查看历史中" : ""}
        </Text>
      </Box>
      {page === "chat" ? (
        <Box
          borderStyle="round"
          borderColor={color.border}
          flexDirection="column"
          paddingX={1}
          height={inputHeight}
          flexShrink={0}
        >
          <Text color={color.muted}>
            消息
            {session.options.vi
              ? viMode.current
                ? " · Vi 普通模式"
                : " · Vi 插入模式"
              : ""}{" "}
            · Enter 发送 · Alt+Enter 换行
          </Text>
          {inputLayout.rows
            .slice(inputTop, inputTop + Math.max(1, inputCapacity))
            .map((row, index) => (
              <Text key={index}>
                {index === 0 ? "› " : "  "}
                {row.map((span, i) => (
                  <Text key={i} inverse={span.inverse}>
                    {span.text}
                  </Text>
                ))}
              </Text>
            ))}
          {suggestions.length > 0 && (
            <Text color={color.accent}>{suggestions.join("  ")}</Text>
          )}
        </Box>
      ) : (
        <Box height={4} flexShrink={0} alignItems="center">
          <Text color={color.muted}>
            Tab 控件 · ↑↓ 选行 · Enter 选项/详情 · r 同步 · Esc 返回聊天
            {page === "schedule" ? " · g 周视图" : ""}
          </Text>
        </Box>
      )}
      <Text color={color.muted}>
        PgUp/PgDn / 滚轮 · Ctrl+End 最新 · Ctrl+C 取消 · Ctrl+D 退出
      </Text>
    </Box>
  );
}

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
  type Key,
} from "ink";
import { Select, Spinner } from "@inkjs/ui";
import { editorRows } from "./editor.js";
import { messageLines } from "./markdown.js";
import { welcomeLines } from "./welcome.js";
import { Composer } from "./composer.js";
import { telemetryLabel } from "./telemetry.js";
import {
  programDocument,
  semesterOptions,
  currentWeek,
  periodTimes,
} from "./course-layout.js";
import { Timetable, gridGeometry } from "./timetable.js";
import { Session, commands, type TerminalMessage } from "./session.js";
import { commandSuggestions, attachmentSuggestions } from "./completion.js";
import { clean } from "./client.js";
import stringWidth from "string-width";
import { screenText, selectionRows, selectedText, type Selection } from "./selection.js";
import { committedInput, InterruptHold, restoreTextInput, TerminalReplyFilter } from "./keyboard.js";
import { InputCursor } from "./cursor.js";
import { SessionPicker, type SessionPickerHandle } from "./session-picker.js";
import { copySelection } from "./clipboard.js";

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

export function App({ session, copy = copySelection }: {
  session: Session;
  copy?: (text: string) => Promise<void | string>;
}) {
  const [, refresh] = useState(0);
  const schedule = session.schedule,
    programs = session.programs;
  const { exit } = useApp();
  const { stdin } = useStdin();
  const { stdout } = useStdout();
  const resumePicker = useRef<SessionPickerHandle | null>(null);
  const { columns, rows } = useWindowSize();
  const width = Math.max(20, columns - 4);
  const rootRef = useRef<DOMElement | null>(null);
  const selectionRef = useRef<Selection | null>(null);
  const selectionMessages = useRef<TerminalMessage[]>([]);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [copyNotice, setCopyNotice] = useState("");
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const interruptHold = useRef(new InterruptHold());
  const terminalReplies = useRef(new TerminalReplyFilter());
  const clearSelection = () => {
    selectionRef.current = null;
    setSelection(null);
    refresh((n) => n + 1);
  };
  const copyCurrent = () => {
    const current = selectionRef.current;
    if (!current?.moved) return;
    void copy(selectedText(current)).then((notice) => {
      setCopyNotice(notice || "已复制");
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopyNotice(""), 1500);
    }).catch(() => setCopyNotice("复制失败，请重新拖选"));
  };
  useEffect(() => { clearSelection(); }, [columns, rows]);
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);
  const [page, setPage] = useState<Page>("chat");
  const [input, setInput] = useState("");
  const [caret, setCaret] = useState(0);
  const editor = useRef(new Composer());
  const historyIndex = useRef(-1);
  const historyDraft = useRef("");
  const edit = (text: string, cursor: number) => {
    editor.current.set(text, cursor);
    setInput(editor.current.text);
    setCaret(editor.current.cursor);
  };
  const messages = selectionRef.current?.moved ? selectionMessages.current : session.messages;
  const busy = session.busy;
  const [offset, setOffset] = useState<number | null>(null);
  const [field, setField] = useState(0);
  const [modal, setModal] = useState<string | null>(session.resumePickerRequested ? "resume" : null);
  useEffect(() => { if (session.resumePickerRequested) setModal("resume"); }, [session.resumePickerRequested]);
  const [detail, setDetail] = useState<any>(null);
  const [term, setTerm] = useState(schedule.selectedSemester);
  const [courses, setCourses] = useState<any[]>(schedule.courses);
  const [week, setWeek] = useState(currentWeek(schedule));
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState(0);
  const [tableTop, setTableTop] = useState(0);
  const [planIndex, setPlanIndex] = useState(0);
  const [courseState, setCourseState] = useState("all");
  const [grid, setGrid] = useState(true);
  const [dayStart, setDayStart] = useState(0);
  const [programSemester, setProgramSemester] = useState("all");
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const inputLayout = editorRows(input, caret, width - 4);
  const inputCapacity = Math.min(7, Math.max(1, inputLayout.rows.length));
  const inputHeight = page === "chat" ? inputCapacity + 2 : 0;
  const hasSuggestions =
    page === "chat" && input.startsWith("/") && !input.includes("\n");
  const suggestionHeight = hasSuggestions ? 9 : 0;
  const showThinking =
    page === "chat" &&
    session.busy &&
    session.thinking &&
    !session.pending &&
    !session.confirmation;
  const latestAnswer = [...messages].reverse().find(
    (message) => message.role === "SEUdaily",
  );
  const reasoning = latestAnswer?.reasoning ?? "";
  const reasoningLines = useMemo(
    () => wrap(reasoning, width - 2), [reasoning, width],
  );
  const [reasoningOffset, setReasoningOffset] = useState<number | null>(null);
  const reasoningRef = useRef<DOMElement | null>(null);
  const showReasoning = page === "chat" && !session.pending &&
    !session.confirmation && (showThinking || !!reasoning);
  const reasoningCapacity = Math.min(
    reasoningLines.length, Math.max(1, Math.min(8, Math.floor(rows / 3))),
  );
  const reasoningHeight = showReasoning
    ? 1 + (session.reasoningExpanded && reasoning ? reasoningCapacity : 0)
    : 0;
  const reasoningMaxOffset = Math.max(0, reasoningLines.length - reasoningCapacity);
  const reasoningTop = Math.min(reasoningMaxOffset, reasoningOffset ?? reasoningMaxOffset);
  const toggleReasoning = () => {
    setReasoningOffset(session.busy ? null : 0);
    session.reasoningExpanded = !session.reasoningExpanded;
    session.changed();
  };
  useEffect(() => {
    setReasoningOffset(session.busy ? null : 0);
  }, [session.runToken, session.threadId, session.reasoningExpanded]);
  const inReasoning = (x?: number, y?: number) => {
    if (!reasoningRef.current || x === undefined || y === undefined) return false;
    const box = measureElement(reasoningRef.current);
    return x >= box.x && x < box.x + box.width &&
      y >= box.y && y < box.y + box.height;
  };
  const height = Math.max(
    3,
    rows - inputHeight - suggestionHeight - 2 - reasoningHeight,
  );
  const inputTop = Math.max(0, inputLayout.cursorRow - inputCapacity + 1);
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
      if (selectionRef.current?.moved) return;
      refresh((n) => n + 1);
      setPage(session.page as Page);
      if (
        previous.current.schedule !== session.schedule ||
        previous.current.programs !== session.programs ||
        previous.current.options !== session.viewOptions
      ) {
        setCourses(session.schedule.courses ?? []);
        setTerm(session.schedule.selectedSemester);
        setWeek(currentWeek(session.schedule));
        setDayStart(0);
        setProgramSemester("all");
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
  const filteredCourses = useMemo(
    () =>
      page === "schedule"
        ? courses.filter(
            (c) =>
              (week === "all" || c.weeks?.includes(Number(week))) &&
              c.courseName.includes(filter),
          )
        : (plan?.courses ?? []).filter(
            (c: any) => c.name.includes(filter) || c.code?.includes(filter),
          ),
    [page, courses, week, filter, courseState, plan],
  );
  const programView = useMemo(
    () =>
      programDocument(
        plan,
        filteredCourses,
        width,
        programSemester,
        courseState,
      ),
    [plan, filteredCourses, width, programSemester, courseState],
  );
  const choices = page === "programs" ? programView.entries : filteredCourses;
  const displayLines = useMemo(
    () => messages.flatMap((message) => message.welcome
      ? welcomeLines(message.text, width) : messageLines(message, width)),
    [messages, width],
  );
  const maxOffset = Math.max(0, displayLines.length - height);
  const top = offset === null ? maxOffset : Math.min(maxOffset, offset);
  const visibleCount = Math.max(2, height - (page === "programs" ? 6 : 5));
  const gridCount = Math.max(1, Math.floor((height - 8) / 3));
  const isGrid = grid && page === "schedule";
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
  useEffect(() => setSuggestionIndex(0), [input]);
  const selectedSuggestion =
    suggestions[Math.min(suggestionIndex, Math.max(0, suggestions.length - 1))];
  const suggestionTop = Math.max(
    0,
    Math.min(suggestionIndex - 4, suggestions.length - 5),
  );
  const suggestionDescription = (value: string) => {
    const parts = value.trim().split(/\s+/),
      name = parts[0].slice(1);
    if (parts.length > 1) {
      const last = parts.at(-1)!;
      return (
        (
          {
            "--sync": "重新同步校园数据",
            "--semester": "选择学期",
            "--date": "筛选日期",
            "--start-date": "设置学期起始日期",
            "--semesters": "查看学期列表",
            "--plan": "选择培养方案",
            "--page": "跳转页码",
            "--limit": "设置每页数量",
            "--filter": "按课程名筛选",
            "--help": "查看命令帮助",
            off: "清除 Skill",
            normal: "普通权限",
            full: "完整权限",
            extra: "工作区权限",
            latest: "最近会话",
            schedule: "登录教务系统",
          } as Record<string, string>
        )[last] ?? (name === "attach" ? "添加文档" : "调用项目 Skill")
      );
    }
    const alias =
      (
        {
          课表: "schedule",
          培养方案: "programs",
          技能: "skills",
          exit: "quit",
        } as Record<string, string>
      )[name] ?? name;
    return (
      commands[alias]?.split(" [")[0] ??
      session.catalog.find((s) => s.name === name)?.description ??
      "返回聊天"
    );
  };
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
  const wheel = (amount: number, x?: number, y?: number) => {
    if (selectionRef.current) clearSelection();
    if (modal === "resume") { resumePicker.current?.scroll(amount); return; }
    if (session.reasoningExpanded && inReasoning(x, y)) {
      setReasoningOffset((current) => Math.max(
        0, Math.min(reasoningMaxOffset, (current ?? reasoningMaxOffset) + amount),
      ));
      return;
    }
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
              isGrid
                ? 13 - gridCount
                : page === "programs"
                  ? programView.rows.length - (height - 4)
                  : choices.length - visibleCount,
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
    if (modal === "resume") { resumePicker.current?.click(x, y); return; }
    if (modal || detail || decisions) return;
    if (page === "chat") {
      if (inReasoning(x, y)) toggleReasoning();
      return;
    }
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
        if (index === 4) setModal("program-semester");
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
        const selectedIndex =
          page === "programs"
            ? programView.rows[tableTop + index]?.index
            : tableTop + index;
        if (selectedIndex === undefined) return;
        setSelected(selectedIndex);
        setDetail(choices[selectedIndex]);
        return;
      }
    }
  };
  const copyRef = useRef(copyCurrent);
  copyRef.current = copyCurrent;
  useEffect(() => {
    restoreTextInput(stdout);
    stdout.write("\x1b[?1002h\x1b[?1006h");
    let pending = "";
    const handler = (data: Buffer | string) => {
      pending += String(data);
      const events = [...pending.matchAll(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g)];
      for (const event of events) {
        const button = Number(event[1]);
        if (button === 64 || button === 65)
          wheelRef.current(
            button === 64 ? -3 : 3, Number(event[2]) - 1, Number(event[3]) - 1,
          );
        else {
          const point = { x: Math.max(0, Number(event[2]) - 1), y: Math.max(0, Number(event[3]) - 1) };
          if ((button & 3) !== 0) continue;
          if ((button & 32) && event[4] === "M") {
            const current = selectionRef.current;
            if (!current) continue;
            const moved = current.moved || point.x !== current.start.x || point.y !== current.start.y;
            selectionRef.current = { ...current, end: point, moved };
            if (moved) setSelection(selectionRef.current);
          } else if (event[4] === "M") {
            selectionRef.current = null;
            setSelection(null);
            selectionMessages.current = session.messages.map((message) => ({ ...message }));
            if (rootRef.current) selectionRef.current = { start: point, end: point, moved: false,
              screen: screenText(rootRef.current, stdout.columns ?? 80, stdout.rows ?? 24) };
          } else {
            const current = selectionRef.current;
            if (current?.moved) {
              selectionRef.current = { ...current, end: point };
              setSelection(selectionRef.current);
              if (session.copyOnSelect) copyRef.current();
            } else {
              selectionRef.current = null;
              clickRef.current(point.x, point.y);
            }
          }
        }
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
      stdout.write("\x1b[?1002l\x1b[?1000l\x1b[?1006l");
    };
  }, [stdin, stdout]);
  useEffect(() => () => { void session.cancel(); }, [session]);
  const newSelection = (index: number) => {
    index = Math.max(0, Math.min(choices.length - 1, index));
    setSelected(index);
    if (page === "programs") {
      const line = programView.rows.findIndex((row) => row.index === index);
      setTableTop((current) =>
        line < current
          ? line
          : line >= current + height - 4
            ? line - height + 5
            : current,
      );
      return;
    }
    if (isGrid) {
      setTableTop(
        Math.max(
          0,
          Math.min(13 - gridCount, (choices[index]?.startPeriod ?? 1) - 1),
        ),
      );
      return;
    }
    setTableTop((current) =>
      index < current
        ? index
        : index >= current + visibleCount
          ? index - visibleCount + 1
          : current,
    );
  };
  usePaste((text) => {
    if (page === "chat" && !modal && !detail && !decisions) {
      editor.current.paste(clean(text));
      setInput(editor.current.text);
      setCaret(editor.current.cursor);
    }
  });
  const handleInput = (value: string, key: Key) => {
    if (value.includes("[<") || /^<?\d+;\d+;\d+[Mm]$/.test(value)) return;
    if (terminalReplies.current.consume(value)) return;
    if (key.eventType === "release") {
      if (key.ctrl && value.toLowerCase() === "c") interruptHold.current.reset();
      return;
    }
    const interrupt = () => {
      const action = interruptHold.current.press();
      if (action === "exit") { cancel(); exit(); return; }
      if (action === "repeat") return;
      if (selectionRef.current?.moved) copyCurrent();
      else if (busy) cancel();
      else { edit("", 0); setModal(null); setDetail(null); }
    };
    if (key.ctrl && value.toLowerCase() === "c") { interrupt(); return; }
    if (/^\x03+$/.test(value)) { for (const _ of value) interrupt(); return; }
    interruptHold.current.reset();
    if (process.platform === "darwin" && key.super && value.toLowerCase() === "c" && selectionRef.current?.moved) {
      copyCurrent();
      return;
    }
    if (selectionRef.current?.moved) {
      clearSelection();
      if (key.escape) return;
    }
    if (key.ctrl && value === "t" && page === "chat" && !modal && !detail && !decisions) {
      toggleReasoning();
      return;
    }
    if (key.ctrl && value === "d") {
      cancel();
      exit();
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
      if (
        page === "schedule" &&
        isGrid &&
        field !== 2 &&
        (key.leftArrow || key.rightArrow)
      ) {
        setDayStart((start) =>
          Math.max(
            0,
            Math.min(
              7 - gridGeometry(width).days,
              start + (key.rightArrow ? 1 : -1),
            ),
          ),
        );
        return;
      }
      if (key.tab) {
        setField(
          (old) =>
            (old + (key.shift ? (page === "programs" ? 4 : 3) : 1)) %
            (page === "programs" ? 5 : 4),
        );
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
          setFilter((old) => old + clean(committedInput(value)));
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
        else if (field === 4) setModal("program-semester");
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
    if (
      suggestions.length &&
      !key.ctrl &&
      (key.tab ||
        (key.return && !key.meta && !key.shift &&
          selectedSuggestion !== editor.current.text) ||
        (key.rightArrow &&
          editor.current.cursor === editor.current.text.length))
    ) {
      edit(selectedSuggestion, selectedSuggestion.length);
      return;
    }
    if (suggestions.length && (key.upArrow || key.downArrow)) {
      setSuggestionIndex((index) =>
        Math.max(
          0,
          Math.min(suggestions.length - 1, index + (key.upArrow ? -1 : 1)),
        ),
      );
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
      const text = editor.current.expanded().trim();
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
        historyDraft.current = editor.current.expanded();
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
      edit("", 0);
      editor.current.paste(value);
      setInput(editor.current.text);
      setCaret(editor.current.cursor);
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
    if (value && !key.ctrl && !key.meta) insert(committedInput(value));
  };
  // Keep state-dependent decisions current even when Ink retains the original callback.
  const inputHandler = useRef(handleInput);
  inputHandler.current = handleInput;
  useInput((value, key) => inputHandler.current(value, key));
  const choose = async (value: string) => {
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
  };
  const options =
    modal === "program-semester"
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
  const fieldBox = (index: number, label: string, value: string) => (
    <Box
      key={index}
      ref={(element) => {
        fields.current[index] = element;
      }}
      width={Math.floor(
        width *
          (page === "programs"
            ? [0.3, 0.13, 0.22, 0.13, 0.17]
            : [0.34, 0.17, 0.28, 0.16])[index],
      )}
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
  const caretLine = inputLayout.rows[inputLayout.cursorRow] ?? [];
  let caretColumn = 0;
  for (const span of caretLine) { if (span.inverse) break; caretColumn += stringWidth(span.text); }
  let nativeCursor: { x: number; y: number } | undefined;
  if (page === "chat" && !modal && !detail && !decisions && !selectionRef.current?.moved) {
    nativeCursor = { x: Math.min(columns - 2, 5 + caretColumn),
      y: height + reasoningHeight + suggestionHeight + 1 + inputLayout.cursorRow - inputTop };
  } else if (page !== "chat" && field === 2 && !modal && !detail && fields.current[2]) {
    const box = measureElement(fields.current[2]);
    nativeCursor = { x: box.x + 2 + Math.min(stringWidth(filter), Math.max(0, box.width - 5)), y: box.y + 2 };
  }
  gridCells.current = [];
  tableRows.current = [];
  return (
    <Box ref={rootRef} width={columns} height={rows} flexDirection="column" paddingX={1}>
      <Box
        flexDirection="column"
        height={height}
        flexShrink={0}
        overflow="hidden"
      >
        {modal === "resume" ? (
          <SessionPicker ref={resumePicker} threads={session.threads} currentId={session.threadId}
            width={width} height={height}
            onSelect={(id) => { setModal(null); setOffset(null); void run(`/resume ${id}`); }} />
        ) : decisions ? (
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
              {modal === "semester" || modal === "program-semester"
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
                  {detail.displaySemester ??
                    detail.semesterLabel ??
                    detail.semester}
                </Text>
                <Text wrap="wrap">
                  备注：
                  {[detail.choiceNote, detail.note]
                    .filter(Boolean)
                    .join(" · ") || "暂无"}
                </Text>
              </>
            )}
            <Text color={color.muted}>Esc 返回列表</Text>
          </Box>
        ) : page === "chat" ? (
          displayLines.slice(top, top + height).map((line, i) => (
            <Text key={i} backgroundColor={line[0]?.user ? "#9ebba9" : undefined}>
              {line.map((span, j) => (
                <Text
                  key={j}
                  color={
                    span.user
                      ? "#203a2b"
                      : span.color ?? (span.role === "你"
                      ? color.accent
                      : span.role === "SEUdaily"
                        ? color.strong
                        : span.code
                          ? "#e5c07b"
                          : span.muted
                            ? color.muted
                            : color.text)
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
              {page === "programs" &&
                fieldBox(
                  4,
                  "查看学期",
                  programSemester === "all" ? "全部学期" : programSemester,
                )}
            </Box>
            {isGrid ? (
              <Timetable
                courses={choices}
                width={width}
                start={tableTop}
                count={gridCount}
                dayStart={dayStart}
                register={(index, element, items) => {
                  gridCells.current[index] = { element, items };
                }}
              />
            ) : page === "programs" ? (
              <Box
                flexDirection="column"
                height={Math.max(1, height - 4)}
                overflow="hidden"
              >
                {programView.rows
                  .slice(tableTop, tableTop + height - 4)
                  .map((row, index) => (
                    <Box
                      key={index}
                      height={1}
                      flexShrink={0}
                      ref={(element) => {
                        tableRows.current[index] = element;
                      }}
                    >
                      <Text
                        bold={row.kind === "title" || row.kind === "group"}
                        color={
                          row.kind === "title"
                            ? color.accent
                            : row.kind === "border" || row.kind === "muted"
                              ? color.muted
                              : color.text
                        }
                        inverse={row.index === selected}
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
      {showReasoning && (
        <Box
          ref={reasoningRef}
          height={reasoningHeight}
          flexShrink={0}
          flexDirection="column"
          overflow="hidden"
        >
          <Box height={1}>
            {showThinking && !selectionRef.current?.moved
              ? <Spinner label="Thinking…" type="dots" />
              : <Text color={color.muted}>模型思考</Text>}
            <Text color={color.muted} wrap="truncate">
              {session.reasoningExpanded ? " ▾ " : " ▸ "}
              {session.reasoningExpanded ? "点击折叠 · Ctrl+T" : fit(
                reasoningLines.at(-1) || "等待模型返回思考内容",
                Math.max(1, width - 30),
              )}
              {!session.reasoningExpanded && " · Ctrl+T 展开"}
            </Text>
          </Box>
          {session.reasoningExpanded && reasoning && reasoningLines
            .slice(reasoningTop, reasoningTop + reasoningCapacity)
            .map((line, index) => (
              <Text key={index} color={color.muted}>{"  " + line}</Text>
            ))}
        </Box>
      )}
      {page === "chat" && (
        <>
          {hasSuggestions && (
            <Box
              flexDirection="column"
              height={suggestionHeight}
              flexShrink={0}
              overflow="hidden"
            >
              <Text color={color.border}>
                {"┌" + "─".repeat(width - 2) + "┐"}
              </Text>
              <Text color={color.muted}>
                {"│ " +
                  fit("命令", Math.floor(width * 0.38)) +
                  " │ " +
                  fit("说明", width - Math.floor(width * 0.38) - 7) +
                  " │"}
              </Text>
              <Text color={color.border}>
                {"├" + "─".repeat(width - 2) + "┤"}
              </Text>
              {suggestions
                .slice(suggestionTop, suggestionTop + 5)
                .map((suggestion, index) => (
                  <Text
                    key={suggestion}
                    inverse={suggestion === selectedSuggestion}
                    color={color.accent}
                  >
                    {"│ " +
                      fit(suggestion, Math.floor(width * 0.38)) +
                      " │ " +
                      fit(
                        suggestionDescription(suggestion),
                        width - Math.floor(width * 0.38) - 7,
                      ) +
                      " │"}
                  </Text>
                ))}
              {!suggestions.length && (
                <Text color={color.muted}>没有匹配的补全命令。</Text>
              )}
              <Text color={color.border}>
                {"└" + "─".repeat(width - 2) + "┘"}
              </Text>
            </Box>
          )}
          <Box
            borderStyle="round"
            borderColor={color.border}
            flexDirection="column"
            paddingX={1}
            height={inputHeight}
            flexShrink={0}
          >
            {inputLayout.rows
              .slice(inputTop, inputTop + inputCapacity)
              .map((row, index) => (
                <Text key={index}>
                  {index === 0 ? "› " : "  "}
                  {row.map((span, i) => (
                    <Text key={i}>
                      {span.text}
                    </Text>
                  ))}
                </Text>
              ))}
          </Box>
        </>
      )}
      <Box height={1} flexShrink={0} justifyContent="center">
        <Text color={color.muted} wrap="truncate">
          {copyNotice || (selection?.moved
            ? (process.platform === "darwin"
                ? "已选中 · ⌘C / Ctrl+C 复制 · Esc 取消"
                : "已选中 · Ctrl+C 复制 · Esc 取消")
            : telemetryLabel(session.model, session.effort, session.usage, width < 105))}
        </Text>
      </Box>
      {modal !== "resume" && <InputCursor position={nativeCursor} />}
      {selection?.moved && selectionRows(selection).map((row) => (
        <Box key={row.y} position="absolute" left={row.x} top={row.y} height={1}>
          <Text backgroundColor={color.accent} color="#20242c">{row.text}</Text>
        </Box>
      ))}
    </Box>
  );
}

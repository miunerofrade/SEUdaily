import { NoticesManager } from './notices.js';
import { followSelection } from "./viewport.js";
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
import { processLines } from "./process.js";
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
import { isClipboardPaste, enterKey, committedInput, InterruptHold, restoreTextInput, TerminalReplyFilter } from "./keyboard.js";
import { InputCursor } from "./cursor.js";
import { SessionPicker, type SessionPickerHandle } from "./session-picker.js";
import { readClipboard, copySelection } from "./clipboard.js";
import { ManagementForm } from "./form.js";
import { FocusManager } from "./focus.js";
import { courseForm, semesterForm, programStatusForm } from "./management.js";

import { color, weekdays, states } from './theme.js';
import { fit, wrap } from './course-layout.js';
import { CourseDetail, TranscriptLines, CourseResults } from './panels.js';

type Page = "chat" | "schedule" | "programs" | "focus" | "notices";

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
  const pendingPastes = useRef(0);
  const pasteQueue = useRef<Promise<void>>(Promise.resolve());
  editor.current.onAttachmentRemoved = id => session.removeAttachment(id);
  const historyIndex = useRef(-1);
  const historyDraft = useRef("");
  const edit = (text: string, cursor: number) => {
    editor.current.set(text, cursor);
    setInput(editor.current.text);
    setCaret(editor.current.cursor);
  };
  const messages: import("./session.js").TerminalMessage[] = selectionRef.current?.moved ? selectionMessages.current : [...session.messages, ...session.queueItems.map(item => ({role:item.state === 'running' ? '队列 · 发送中' : item.state === 'pending' ? '队列 · 待发送' : '队列 · 已暂停',text:item.text + (item.error ? `\n${item.error}` : '')})), ...(session.queueProgress ? [{role:'SEUdaily · 队列',text:session.queueProgress}] : [])];
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
  const [gridSelection, setGridSelection] = useState<{ day: number; period: number } | null>(null);
  const [programSemester, setProgramSemester] = useState("all");
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [suggestionTop, setSuggestionTop] = useState(0);
  const inputLayout = editorRows(input, caret, width - 4);
  const inputCapacity = Math.min(7, Math.max(1, inputLayout.rows.length));
  const inputHeight = page === "chat" ? inputCapacity + 2 : 0;
  const hasSuggestions =
    page === "chat" && input.startsWith("/") && !input.includes("\n") &&
    (!input.includes(" ") || input.startsWith("/attach ") ||
      commandSuggestions(input, session.catalog.map(s => s.name)).some(value => value !== input));
  const suggestionHeight = hasSuggestions ? 9 : 0;
  const showThinking =
    page === "chat" &&
    session.busy &&
    session.thinking &&
    !session.pending &&
    !session.confirmation;
  const reasoningRef = useRef<DOMElement | null>(null);
  const transcriptRef = useRef<DOMElement | null>(null);
  const lastReasoningTarget = useRef<{ text: string; expanded?: boolean } | null>(null);
  const [reasoningOffset, setReasoningOffset] = useState<number | null>(null);
  useEffect(() => { lastReasoningTarget.current = null; setReasoningOffset(null); }, [session.runToken, session.threadId]);
  const latestAnswer = [...messages].reverse().find(message => message.role === "SEUdaily");
  const activeReasoning = ([...(latestAnswer?.process ?? [])].reverse().find(part => part.type === "reasoning")?.text
    ?? latestAnswer?.reasoning ?? "");
  const reasoningLines = wrap(activeReasoning, Math.max(1, width - 20));
  const reasoningCapacity = Math.min(8, Math.max(1, Math.floor(rows / 3)));
  const reasoningMaxOffset = Math.max(0, reasoningLines.length - reasoningCapacity);
  const reasoningTop = Math.min(reasoningMaxOffset, reasoningOffset ?? reasoningMaxOffset);
  const showReasoning = page === "chat" && !session.pending &&
    !session.confirmation && session.busy && (showThinking || !!activeReasoning);
  const reasoningHeight = showReasoning ? 1 + (session.reasoningExpanded ? Math.min(reasoningCapacity, reasoningLines.length) : 0) : 0;
  const toggleInlineReasoning = (part: { text: string; expanded?: boolean }, index: number) => {
    part.expanded = !part.expanded;
    lastReasoningTarget.current = part;
    // Preserve the visible header when the block changes height instead of following the bottom.
    setOffset(Math.min(top, index));
    session.changed();
  };
  const toggleReasoning = () => {
    if (session.busy) {
      setReasoningOffset(null);
      session.reasoningExpanded = !session.reasoningExpanded;
      session.changed();
      return;
    }
    const visible = displayLines.slice(top, top + height).map(line => line[0]?.reasoningPart).filter(Boolean);
    const target = lastReasoningTarget.current ?? visible.at(-1) ??
      [...displayLines].reverse().find(line => line[0]?.reasoningPart)?.[0].reasoningPart;
    if (target) toggleInlineReasoning(target, displayLines.findIndex(line => line[0]?.reasoningPart === target));
  };
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
  useEffect(() => {
    const poll = () => { void session.pollQueue().catch(() => {}); void session.pollPreparation().catch(() => {}); void session.pollVpn().catch(() => {}); };
    poll(); const timer = setInterval(poll, 1000);
    return () => clearInterval(timer);
  }, [session]);
  const run = async (text: string) => {
    try {
      await session.submit(text);
    } catch (error) {
      if (!editor.current.expanded() && !text.startsWith("/")) edit(text,text.length);
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
  const selectedGridItems = gridSelection ? filteredCourses.filter((course: any) =>
    course.weekday === gridSelection.day + 1 && course.startPeriod <= gridSelection.period && course.endPeriod >= gridSelection.period) : [];
  useEffect(() => { setGridSelection(null); }, [courses, term, week, filter, page, grid]);
  const openCourseDetail = () => {
    if (!isGrid) { setDetail(choices[selected]); return; }
    if (selectedGridItems.length === 1) setDetail(selectedGridItems[0]);
    else if (selectedGridItems.length > 1) { gridOptions.current = selectedGridItems; setModal("grid-courses"); }
  };
  const displayLines = useMemo(
    () => messages.flatMap((message) => message.welcome
      ? welcomeLines(message.text, width) : processLines(message, width, session.reasoningExpanded)),
    [messages, width, session.reasoningExpanded],
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
        void attachmentSuggestions(input, session.options.cwd ?? session.root).then((values) => {
          if (active) setPathSuggestions({ input, values });
        });
    }, 80);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [input, session.root, session.options.cwd]);
  const suggestions = input.startsWith("/attach ")
    ? pathSuggestions.input === input
      ? pathSuggestions.values
      : []
    : commandSuggestions(
        input,
        session.catalog.map((s) => s.name),
      );
  useEffect(() => { setSuggestionIndex(0); setSuggestionTop(0); }, [input]);
  const selectedSuggestion =
    suggestions[Math.min(suggestionIndex, Math.max(0, suggestions.length - 1))];
  useEffect(() => {
    setSuggestionTop(current => followSelection(current, suggestionIndex, 5, suggestions.length));
  }, [suggestionIndex, suggestions.length]);
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
            connect: "连接校园 VPN；可追加代理端口",
            disconnect: "断开校园 VPN",
            status: "查看状态",
            verify: "输入短信验证码",
            resend: "重新发送验证码",
            unmount: "卸载内存盘",
            reveal: "打开内存盘目录",
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
  const wheel = (amount: number, x?: number, y?: number, horizontal = false) => {
    if (selectionRef.current) clearSelection();
    if (horizontal) {
      if (isGrid && !modal && !detail && !decisions)
        setDayStart(current => Math.max(0, Math.min(7 - gridGeometry(width).days, current + amount)));
      return;
    }
    if (modal === "resume") { resumePicker.current?.scroll(amount); return; }
    if (session.reasoningExpanded && inReasoning(x, y)) {
      setReasoningOffset(current => Math.max(0, Math.min(reasoningMaxOffset, (current ?? reasoningMaxOffset) + amount)));
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
    if (session.form || page === 'focus' || page === 'notices') return;
    if (modal === "resume") { resumePicker.current?.click(x, y); return; }
    if (modal || detail || decisions) return;
    if (page === "chat") {
      if (inReasoning(x, y)) { toggleReasoning(); return; }
      if (transcriptRef.current) {
        const box = measureElement(transcriptRef.current);
        const line = displayLines[top + y - box.y];
        const marker = line?.[0];
        if (y >= box.y && y < box.y + box.height && x >= box.x &&
          x < box.x + stringWidth(marker?.text ?? "") && marker?.reasoningPart !== undefined) {
          toggleInlineReasoning(marker.reasoningPart, top + y - box.y);
        }
      }
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
        if (index === 3) openCourseDetail();
        if (index === 4) setModal("program-semester");
        return;
      }
    }
    if (isGrid) {
      for (const [cellIndex, cell] of gridCells.current.entries()) {
        if (!cell?.element) continue;
        const box = measureElement(cell.element);
        const period = Math.floor(cellIndex / 7) + 1;
        const nextItems = filteredCourses.filter((course: any) => course.weekday === cellIndex % 7 + 1 &&
          course.startPeriod <= period + 1 && course.endPeriod >= period + 1);
        const mergedBelow = cell.items.length === 1 && nextItems.length === 1 && cell.items[0] === nextItems[0];
        if (
          x >= box.x &&
          x < box.x + box.width &&
          y >= box.y &&
          y < box.y + box.height + (mergedBelow ? 1 : 0) &&
          cell.items.length
        ) {
          setGridSelection({ day: cellIndex % 7, period: Math.floor(cellIndex / 7) + 1 });
          setField(3);
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
        setField(3);
        return;
      }
    }
  };
  const textSelectionEnabled = useRef(page === "chat");
  textSelectionEnabled.current = page === "chat";
  const copyRef = useRef(copyCurrent);
  copyRef.current = copyCurrent;
  useEffect(() => {
    restoreTextInput(stdout);
    stdout.write("\x1b[?1002h\x1b[?1006h");
    let pending = "";
    let uiPress: { x: number; y: number } | null = null;
    const handler = (data: Buffer | string) => {
      pending += String(data);
      const events = [...pending.matchAll(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g)];
      for (const event of events) {
        const button = Number(event[1]);
        if (button & 64) {
          // SGR reports horizontal wheels as 66/67. Some terminals use Shift+64/65.
          const direction = button & ~(4 | 8 | 16);
          const horizontal = direction === 66 || direction === 67 || Boolean(button & 4);
          if (event[4] === "M" && direction >= 64 && direction <= 67)
            wheelRef.current(
              (direction % 2 === 0 ? -1 : 1) * (horizontal ? 1 : 3),
              Number(event[2]) - 1, Number(event[3]) - 1, horizontal,
            );
        }
        else {
          const point = { x: Math.max(0, Number(event[2]) - 1), y: Math.max(0, Number(event[3]) - 1) };
          if ((button & 3) !== 0) continue;
          if (!textSelectionEnabled.current) {
            if (!(button & 32) && event[4] === "M") uiPress = point;
            else if (event[4] === "m" && uiPress) {
              const target = uiPress;
              uiPress = null;
              clickRef.current(target.x, target.y);
            }
            continue;
          }
          uiPress = null;
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
  const pasteText = async (text: string) => {
    const attachments = await session.attachPastedFiles(clean(text));
    if (attachments) {
      for (const attachment of attachments) editor.current.attachment(attachment.id, clean(attachment.name), attachment.kind);
    } else editor.current.paste(clean(text));
    setInput(editor.current.text);
    setCaret(editor.current.cursor);
  };
  const pasteClipboard = () => {
    if (pendingPastes.current) return;
    pendingPastes.current++;
    pasteQueue.current = pasteQueue.current.then(async () => {
      const content = await readClipboard();
      if ('image' in content) {
        const attachment = await session.attachClipboardImage(content.image, content.mediaType);
        editor.current.attachment(attachment.id, attachment.name, attachment.kind);
        setInput(editor.current.text);
        setCaret(editor.current.cursor);
      } else if (content.text) await pasteText(content.text);
      else session.show('剪贴板为空');
    }).catch(error => session.show(error.message, '粘贴错误'))
      .finally(() => { pendingPastes.current--; });
  };
  usePaste((text) => {
    if (page === "chat" && !modal && !detail && !decisions) {
      pendingPastes.current++;
      // Serialize attachment uploads so consecutive paste events keep their order.
      pasteQueue.current = pasteQueue.current.then(() => pasteText(text))
        .catch(error => session.show(error.message, '附件错误'))
        .finally(() => { pendingPastes.current--; });
    }
  });
  const handleInput = (value: string, key: Key) => {
    if (session.form || page === 'focus' || page === 'notices') return;
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
      else if (session.busy || session.queueActive) cancel();
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
    if (isClipboardPaste(value, key) && page === 'chat' && !modal && !detail && !decisions) {
      void pasteClipboard(); return;
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
    if (decisions || session.confirmation) return;
    if (key.ctrl && key.end) {
      setOffset(null);
      return;
    }
    if (key.ctrl && key.home) {
      setOffset(0);
      return;
    }
    if (detail) {
      if (value === 'e' && page === 'schedule' && (!term || term === schedule.currentSemester)) session.openForm(courseForm(session, detail));
      if (value === 's' && page === 'programs') session.openForm(programStatusForm(session, plan.id, detail));
      return;
    }
    if (page !== "chat") {
      if (page === 'schedule' && field !== 2 && (!term || term === schedule.currentSemester)) {
        if (value === 'a') { session.openForm(courseForm(session)); return; }
        if (value === 'o') { session.openForm(courseForm(session, undefined, true)); return; }
        if (value === 'm') { session.openForm(semesterForm(session)); return; }
      }
      if (
        page === "schedule" &&
        isGrid &&
        field !== 2 &&
        (key.leftArrow || key.rightArrow || key.upArrow || key.downArrow)
      ) {
        if (key.upArrow || key.downArrow) { wheel(key.upArrow ? -1 : 1); return; }
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
        else if (field === 3) openCourseDetail();
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
      if (!text && !session.images.length && !session.documents.length) return;
      if (pendingPastes.current || session.attachmentLoading) { session.show('附件仍在处理，请稍候再发送'); return; }

      if (text === "/quit" || text === "/exit") {
        cancel();
        exit();
        return;
      }
      if (text === "/chat") {
        changePage("chat");
        return;
      }
      editor.current.clearAfterSubmit();
      setInput('');
      setCaret(0);
      historyIndex.current = -1;
      setOffset(null);
      setModal(null);
      setDetail(null);
      void run(text);
      return;
    }
    if (key.upArrow && !editor.current.expanded() && session.queueItems.some(item => item.state !== 'running')) {
      void session.takeQueued().then(text => {
        if (text === null) return;
        edit(text, text.length);
        for (const image of session.images) editor.current.attachment(image.ref, clean(image.name), '图片');
        for (const document of session.documents) editor.current.attachment(document.contextRef, clean(document.name), '文档');
        setInput(editor.current.text); setCaret(editor.current.cursor);
      }).catch(error => session.show(error.message, '错误'));
      return;
    }
    if (key.upArrow || key.downArrow) {
      const userHistory = session.inputHistory.filter(text => !text.startsWith('/'));
      if (key.downArrow) { historyIndex.current = -1; edit('', 0); return; }
      if (historyIndex.current < 0) {
        historyDraft.current = editor.current.expanded();
        historyIndex.current = userHistory.length;
      }
      historyIndex.current = Math.max(
        0,
        Math.min(
          userHistory.length,
          historyIndex.current + (key.upArrow ? -1 : 1),
        ),
      );
      const value =
        historyIndex.current === userHistory.length
          ? historyDraft.current
          : (userHistory[historyIndex.current] ?? "");
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
  useInput((value, key) => inputHandler.current(value, enterKey(value, key)));
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
  // Ref callbacks clear unmounted cells; keep mounted hit targets across React rerenders.
  if (session.form) return <ManagementForm key={session.form.title} form={session.form} width={columns} height={rows}
    onClose={() => { session.form = null; setDetail(null); session.changed(); }} />;
  if (page === 'notices') return <NoticesManager session={session} width={columns} height={rows} />;
  if (page === 'focus') return <FocusManager session={session} width={columns} height={rows} />;
  return (
    <Box ref={rootRef} width={columns} height={rows} flexDirection="column" paddingX={1}>
      <Box
        ref={transcriptRef}
        flexDirection="column"
        height={height}
        flexShrink={0}
        overflow="hidden"
      >
        {modal === "resume" ? (
          <SessionPicker ref={resumePicker} threads={session.threads} currentId={session.threadId}
            width={width} height={height}
            onDelete={(id) => { setModal(null); session.requestDeleteThread(id); }}
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
                else void session.decide(value === 'yes').catch(error => {
                  session.status = error instanceof Error ? error.message : String(error);
                  session.show(session.status, '错误');
                });
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
                    : modal === "grid-courses" ? "课程" : "修读状态"}{" "}
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
          <CourseDetail detail={detail} page={page} term={term} currentSemester={schedule.currentSemester} />
        ) : page === "chat" ? (
          <TranscriptLines lines={displayLines.slice(top, top + height)} />
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
              {fieldBox(3, "课程详情", isGrid ? selectedGridItems.length ? "已选中 · Enter 查看" : "先点击课程" : "Enter")}
              {page === "programs" &&
                fieldBox(
                  4,
                  "查看学期",
                  programSemester === "all" ? "全部学期" : programSemester,
                )}
            </Box>
            <CourseResults page={page} isGrid={isGrid} choices={choices} width={width} height={height}
              tableTop={tableTop} gridCount={gridCount} dayStart={dayStart} gridSelection={gridSelection}
              selected={selected} programRows={programView.rows} cells={cells} headers={headers}
              visibleCount={visibleCount} row={row}
              registerGrid={(index, element, items) => { gridCells.current[index] = { element, items }; }}
              registerRow={(index, element) => { tableRows.current[index] = element; }} />
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
              {session.reasoningExpanded ? "点击折叠 · Ctrl+T" : `${reasoningLines.at(-1) || "等待模型返回思考内容"} · Ctrl+T 展开`}
            </Text>
          </Box>
          {session.reasoningExpanded && reasoningLines.slice(reasoningTop, reasoningTop + reasoningCapacity).map((line, index) => (
            <Text key={index} color={color.muted}>{line}</Text>
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
          {session.preparationMessage ? `${session.preparationMessage} · ` : session.vpnState ? `${session.vpnState} · ` : ''}
          {copyNotice || (selection?.moved
            ? (process.platform === "darwin"
                ? "已选中 · ⌘C / Ctrl+C 复制 · Esc 取消"
                : "已选中 · Ctrl+C 复制 · Esc 取消")
            : session.queueItems.length
              ? `队列 ${session.queueItems.length} · ↑ 取回编辑 · /queue resume 继续${session.queueItems.some(item => item.state === 'failed' || item.state === 'paused') ? ' · 已暂停' : ''}`
              : (session.busy || session.queueActive) ? `${session.status} · Enter 加入队列 · Ctrl+C 停止`
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

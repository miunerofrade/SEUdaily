import { useRef } from "react";
import type { Dispatch, SetStateAction, RefObject } from "react";
import { useInput, type Key } from "ink";
import type { Session } from "./session.js";
import type { Page } from "./app-dialogs.js";
import type { Selection } from "./selection.js";
import type { Composer } from "./composer.js";
import {
  isClipboardPaste,
  enterKey,
  committedInput,
  type InterruptHold,
  type TerminalReplyFilter,
} from "./keyboard.js";
import { courseForm, programStatusForm, semesterForm } from "./management.js";
import { gridGeometry } from "./timetable.js";
import { clean } from "./client.js";

export type AppInputContext = {
  session: Session;
  view: {
    page: Page;
    modal: string | null;
    detail: any;
    decisions: unknown;
    term: string;
    schedule: Session["schedule"];
    plan: any;
    height: number;
    width: number;
    field: number;
    selected: number;
    isGrid: boolean;
    suggestions: string[];
    selectedSuggestion: string;
  };
  refs: {
    terminalReplies: RefObject<TerminalReplyFilter>;
    interruptHold: RefObject<InterruptHold>;
    selectionRef: RefObject<Selection | null>;
    viMode: RefObject<boolean>;
    editor: RefObject<Composer>;
    pendingPastes: RefObject<number>;
    historyIndex: RefObject<number>;
    historyDraft: RefObject<string>;
  };
  actions: {
    cancel: () => void;
    exit: () => void;
    copyCurrent: () => void;
    edit: (text: string, cursor: number) => void;
    setModal: Dispatch<SetStateAction<string | null>>;
    setDetail: Dispatch<SetStateAction<any>>;
    clearSelection: () => void;
    pasteClipboard: () => void;
    toggleReasoning: () => void;
    changePage: (page: Page) => void;
    wheel: (delta: number) => void;
    setOffset: Dispatch<SetStateAction<number | null>>;
    setDayStart: Dispatch<SetStateAction<number>>;
    setField: Dispatch<SetStateAction<number>>;
    setFilter: Dispatch<SetStateAction<string>>;
    setSelected: Dispatch<SetStateAction<number>>;
    setTableTop: Dispatch<SetStateAction<number>>;
    newSelection: (index: number) => void;
    openCourseDetail: () => void;
    run: (text: string) => Promise<void>;
    setGrid: Dispatch<SetStateAction<boolean>>;
    setSuggestionIndex: Dispatch<SetStateAction<number>>;
    insert: (text: string) => void;
    setInput: Dispatch<SetStateAction<string>>;
    setCaret: Dispatch<SetStateAction<number>>;
  };
};

export function createAppInputHandler({
  session,
  view,
  refs,
  actions,
}: AppInputContext) {
  const {
    page,
    modal,
    detail,
    decisions,
    term,
    schedule,
    plan,
    height,
    width,
    field,
    selected,
    isGrid,
    suggestions,
    selectedSuggestion,
  } = view;
  const {
    terminalReplies,
    interruptHold,
    selectionRef,
    viMode,
    editor,
    pendingPastes,
    historyIndex,
    historyDraft,
  } = refs;
  const {
    cancel,
    exit,
    copyCurrent,
    edit,
    setModal,
    setDetail,
    clearSelection,
    pasteClipboard,
    toggleReasoning,
    changePage,
    wheel,
    setOffset,
    setDayStart,
    setField,
    setFilter,
    setSelected,
    setTableTop,
    newSelection,
    openCourseDetail,
    run,
    setGrid,
    setSuggestionIndex,
    insert,
    setInput,
    setCaret,
  } = actions;
  return (value: string, key: Key) => {
    if (session.form || page === "focus" || page === "notices") return;
    if (value.includes("[<") || /^<?\d+;\d+;\d+[Mm]$/.test(value)) return;
    if (terminalReplies.current.consume(value)) return;
    if (key.eventType === "release") {
      if (key.ctrl && value.toLowerCase() === "c")
        interruptHold.current.reset();
      return;
    }
    const interrupt = () => {
      const action = interruptHold.current.press();
      if (action === "exit") {
        cancel();
        exit();
        return;
      }
      if (action === "repeat") return;
      if (selectionRef.current?.moved) copyCurrent();
      else if (session.busy || session.queueActive) cancel();
      else {
        edit("", 0);
        setModal(null);
        setDetail(null);
      }
    };
    if (key.ctrl && value.toLowerCase() === "c") {
      interrupt();
      return;
    }
    if (/^\x03+$/.test(value)) {
      for (const _ of value) interrupt();
      return;
    }
    interruptHold.current.reset();
    if (
      process.platform === "darwin" &&
      key.super &&
      value.toLowerCase() === "c" &&
      selectionRef.current?.moved
    ) {
      copyCurrent();
      return;
    }
    if (selectionRef.current?.moved) {
      clearSelection();
      if (key.escape) return;
    }
    if (
      isClipboardPaste(value, key) &&
      page === "chat" &&
      !modal &&
      !detail &&
      !decisions
    ) {
      void pasteClipboard();
      return;
    }
    if (
      key.ctrl &&
      value === "t" &&
      page === "chat" &&
      !modal &&
      !detail &&
      !decisions
    ) {
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
      if (
        value === "e" &&
        page === "schedule" &&
        (!term || term === schedule.currentSemester)
      )
        session.openForm(courseForm(session, detail));
      if (value === "s" && page === "programs")
        session.openForm(programStatusForm(session, plan.id, detail));
      return;
    }
    if (page !== "chat") {
      if (
        page === "schedule" &&
        field !== 2 &&
        (!term || term === schedule.currentSemester)
      ) {
        if (value === "a") {
          session.openForm(courseForm(session));
          return;
        }
        if (value === "o") {
          session.openForm(courseForm(session, undefined, true));
          return;
        }
        if (value === "m") {
          session.openForm(semesterForm(session));
          return;
        }
      }
      if (
        page === "schedule" &&
        isGrid &&
        field !== 2 &&
        (key.leftArrow || key.rightArrow || key.upArrow || key.downArrow)
      ) {
        if (key.upArrow || key.downArrow) {
          wheel(key.upArrow ? -1 : 1);
          return;
        }
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
        (key.return &&
          !key.meta &&
          !key.shift &&
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
      if (pendingPastes.current || session.attachmentLoading) {
        session.show("附件仍在处理，请稍候再发送");
        return;
      }

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
      setInput("");
      setCaret(0);
      historyIndex.current = -1;
      setOffset(null);
      setModal(null);
      setDetail(null);
      void run(text);
      return;
    }
    if (
      key.upArrow &&
      !editor.current.expanded() &&
      session.queueItems.some((item) => item.state !== "running")
    ) {
      void session
        .takeQueued()
        .then((text) => {
          if (text === null) return;
          edit(text, text.length);
          for (const image of session.images)
            editor.current.attachment(image.ref, clean(image.name), "图片");
          for (const document of session.documents)
            editor.current.attachment(
              document.contextRef,
              clean(document.name),
              "文档",
            );
          setInput(editor.current.text);
          setCaret(editor.current.cursor);
        })
        .catch((error) => session.show(error.message, "错误"));
      return;
    }
    if (key.upArrow || key.downArrow) {
      const userHistory = session.inputHistory.filter(
        (text) => !text.startsWith("/"),
      );
      if (key.downArrow) {
        historyIndex.current = -1;
        edit("", 0);
        return;
      }
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
}

/** Ink retains callbacks: every event must see the current render's state. */
export function useAppInput(context: AppInputContext) {
  const handler = useRef(createAppInputHandler(context));
  handler.current = createAppInputHandler(context);
  useInput((value, key) => handler.current(value, enterKey(value, key)));
}

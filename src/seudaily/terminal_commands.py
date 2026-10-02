from __future__ import annotations

import argparse
import shlex
import os
import shutil
from datetime import date
from typing import Any

from prompt_toolkit.completion import Completer, Completion
from prompt_toolkit.utils import get_cwidth

from .terminal_client import ClientError, terminal_text

COMMANDS = {
    "help": "显示斜杠命令帮助", "new": "新会话", "sessions": "列出历史会话",
    "resume": "恢复会话（ID 或最近列表中的序号）", "history": "查看当前会话原记录",
    "schedule": "本地课表；--sync 同步，--date 日期，--semester 学期",
    "programs": "培养方案；--sync 刷新，--plan ID，--page 页码",
    "audit": "使用培养方案 Skill 分析学分与毕业要求",
    "notices": "查询校园通知", "focus": "查看关注；附带文字可创建或修改关注",
    "skills": "列出项目 Skill", "skill": "选择 Skill：/skill NAME [问题]；off 取消选择",
    "approve": "批准当前待审批工具", "reject": "拒绝当前待审批工具",
    "login": "登录续接；schedule 主动登录，或使用工具返回的登录 ID",
    "apply": "确认并执行工具提出的本地操作", "mode": "查看或修改权限：normal/full/extra",
    "attach": "添加 PDF、DOCX、XLSX、PPTX 文档路径", "detach": "清空待发送附件",
    "cancel": "取消当前任务", "quit": "退出（不会关闭连接的已有服务）",
}
ALIASES = {"课表": "schedule", "培养方案": "programs", "技能": "skills", "exit": "quit"}


class CommandParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise ClientError(f"{self.prog}：{message}；使用 /help 查看用法")

    def exit(self, status: int = 0, message: str | None = None) -> None:
        raise ClientError(message or self.format_help())


def split_command(text: str) -> tuple[str, list[str]]:
    lexer = shlex.shlex(text[1:], posix=True)
    lexer.whitespace_split = True
    lexer.commenters = ""
    if os.name == "nt":
        lexer.escape = ""
    try:
        parts = list(lexer)
    except ValueError as error:
        raise ClientError(f"命令引号未闭合：{error}") from error
    if not parts:
        return "help", []
    return ALIASES.get(parts[0], parts[0]), parts[1:]


def parser_for(command: str) -> CommandParser:
    parser = CommandParser(prog=f"/{command}", add_help=False, allow_abbrev=False)
    if command == "schedule":
        parser.add_argument('-h', '--help', action='store_true')
        parser.add_argument("--sync", action="store_true")
        parser.add_argument("--semester", default="")
        parser.add_argument("--date", type=iso_date)
        parser.add_argument("--start-date", type=iso_date)
        parser.add_argument("--semesters", action="store_true")
    elif command == "programs":
        parser.add_argument('-h', '--help', action='store_true')
        parser.add_argument("--sync", action="store_true")
        parser.add_argument("--plan", default="")
        parser.add_argument("--page", type=int, default=1)
        parser.add_argument("--limit", type=int, default=20)
        parser.add_argument("--filter", default="")
    return parser


def iso_date(value: str) -> str:
    try:
        if date.fromisoformat(value).isoformat() != value:
            raise ValueError()
        return value
    except ValueError as error:
        raise argparse.ArgumentTypeError("日期必须是 YYYY-MM-DD") from error


class SlashCompleter(Completer):
    def __init__(self, skill_names: list[str]):
        self.skill_names = skill_names

    def get_completions(self, document, complete_event):
        text = document.text_before_cursor
        if not text.startswith("/"):
            return
        words = text.split()
        if len(words) == 1 and not text.endswith(" "):
            prefix = text[1:]
            choices = {**COMMANDS, **{name: "调用项目 Skill" for name in self.skill_names}, **{name: COMMANDS[target] for name, target in ALIASES.items()}}
            for name, description in choices.items():
                if name.startswith(prefix):
                    yield Completion("/" + name, start_position=-len(text), display_meta=description)
            return
        command = ALIASES.get(words[0][1:], words[0][1:])
        choices = {
            "skill": [*self.skill_names, "off"], "mode": ["normal", "full", "extra"],
            "login": ["schedule"], "schedule": ["--sync", "--semester", "--date", "--start-date", "--semesters"],
            "programs": ["--sync", "--plan", "--page", "--limit", "--filter"],
        }.get(command, [])
        word = document.get_word_before_cursor(WORD=True)
        for choice in choices:
            if choice.startswith(word):
                yield Completion(choice, start_position=-len(word))
        if command == "attach":
            from prompt_toolkit.completion import PathCompleter
            from prompt_toolkit.document import Document
            path = text[len(words[0]):].lstrip().lstrip('"\'')
            yield from PathCompleter(expanduser=True).get_completions(Document(path, len(path)), complete_event)


def table(headers: list[str], rows: list[list[Any]]) -> str:
    cells = [[terminal_text(value).replace("\n", " ") for value in row] for row in [headers, *rows]]
    widths = [min(80 if header == 'ID' else 34, max(get_cwidth(row[column]) for row in cells)) for column, header in enumerate(headers)]
    available = max(30, shutil.get_terminal_size(fallback=(120, 24)).columns) - 2 * (len(headers) - 1)
    while sum(widths) > available and max(widths) > 5:
        index = widths.index(max(widths))
        widths[index] -= 1
    def cell(value: str, width: int) -> str:
        if get_cwidth(value) > width:
            shortened = ""
            for char in value:
                if get_cwidth(shortened + char) > width - 1:
                    break
                shortened += char
            value = shortened + "…"
        return value + " " * max(0, width - get_cwidth(value))
    return "\n".join("  ".join(cell(value, width) for value, width in zip(row, widths)).rstrip() for row in cells)


def week_ranges(weeks: list) -> str:
    values = sorted({int(value) for value in weeks})
    groups = []
    for value in values:
        if groups and value == groups[-1][-1] + 1:
            groups[-1].append(value)
        else:
            groups.append([value])
    return ",".join(str(group[0]) if len(group) == 1 else f"{group[0]}–{group[-1]}" for group in groups)


def schedule_text(response: dict, *, show_semesters: bool = False) -> str:
    data = response.get("data") or {}
    if data.get("dateFilter", {}).get("reason") == "missing_semester_start_date":
        return "未配置学期起始日期，请使用 /schedule --start-date YYYY-MM-DD；不能据此判断当天无课。"
    courses = data.get("courses") or []
    rows = []
    for course in courses:
        weekday = course.get("weekday")
        day = ["", "一", "二", "三", "四", "五", "六", "日"][weekday] if isinstance(weekday, int) and 1 <= weekday <= 7 else str(weekday or "")
        rows.append([course.get("courseName", ""), "周" + day, f"{course.get('startPeriod', '')}–{course.get('endPeriod', '')}", course.get("teacherName", ""), course.get("location") or course.get("classroom") or "", week_ranges(course.get("weeks") or [])])
    title = data.get("selectedSemesterLabel") or data.get("semesterLabel") or data.get("selectedSemester") or "课表"
    lines = [str(title), table(["课程", "星期", "节次", "教师", "地点", "周次"], rows) if rows else data.get("message") or "没有课程记录。"]
    if show_semesters and data.get("availableSemesters"):
        lines.append("可选学期：" + ", ".join(str(item.get("value") or item.get("semester") or item) if isinstance(item, dict) else str(item) for item in data["availableSemesters"]))
    return "\n".join(lines)


def programs_text(response: dict, *, plan_id: str = "", page: int = 1, limit: int = 20, query: str = "") -> str:
    if page < 1 or not 1 <= limit <= 100:
        raise ClientError("--page 至少为 1，--limit 必须在 1–100 之间")
    plans = (response.get("data") or {}).get("plans") or []
    if plan_id:
        plans = [plan for plan in plans if plan.get("id") == plan_id]
    if not plans:
        return "没有匹配的培养方案。"
    states = {"completed": "已修读", "studying": "在修", "not_taken": "未修读", "planned": "计划中", "unknown": "待确认", "unscheduled": "未排课"}
    lines = []
    for plan in plans:
        courses = [course for course in plan.get("courses") or [] if not query or query.lower() in str(course.get("name") or course.get("courseName") or "").lower()]
        summary = plan.get("creditSummary") or {}
        lines += [f"{plan.get('title', '培养方案')}（{plan.get('id', '')}）", f"要求 {plan.get('requiredCredits', '待确认')} · 已修 {plan.get('completedCredits', '待确认')} · 在修 {summary.get('studying', '待确认')} · 缺口 {summary.get('remaining', '待确认')} 学分"]
        rows = [[course.get("name") or course.get("courseName") or "", course.get("code") or course.get("courseCode") or "", course.get("nature", ""), course.get("credits", ""), states.get(course.get("status"), course.get("status", "待确认")), course.get("semesterLabel") or course.get("semester") or ""] for course in courses[(page-1)*limit:page*limit]]
        lines.append(table(["课程", "课程号", "性质", "学分", "状态", "学期"], rows))
        lines.append(f"第 {page} 页，共 {len(courses)} 门；/programs --plan {plan.get('id', '')} --page {page+1} 查看下一页。")
    return "\n".join(lines)

"""Timetable row normalization and date calculations."""
from __future__ import annotations

import hashlib
import json
import re
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Any

def week_for_date(start_date: str, target: date) -> int:
    start = date.fromisoformat(start_date)
    return ((target - start).days // 7) + 1


def date_for_weekday(start_date: str, week: int, weekday: int) -> date:
    return date.fromisoformat(start_date) + timedelta(days=(week - 1) * 7 + weekday - 1)


def _schedule_id(course: dict[str, Any]) -> str:
    identity = {
        key: course.get(key)
        for key in (
            "courseName",
            "teacherName",
            "weekday",
            "weeklyPeriods",
            "weeks",
            "classroom",
            "courseCode",
        )
    }
    encoded = json.dumps(
        identity, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return f"seu-{hashlib.sha256(encoded).hexdigest()[:16]}"


def _integer(value: Any) -> int | None:
    if value is None:
        return None
    match = re.search(r"\d+", str(value))
    return int(match.group()) if match else None


def _weeks(value: Any) -> list[int]:
    text = str(value or "").strip()
    if text and set(text) <= {"0", "1"}:
        return [index + 1 for index, flag in enumerate(text) if flag == "1"]
    weeks: set[int] = set()
    for start, end in re.findall(r"(\d+)(?:-(\d+))?", text):
        first = int(start)
        last = int(end) if end else first
        weeks.update(range(first, last + 1))
    if "(单)" in text or "（单）" in text:
        weeks = {week for week in weeks if week % 2 == 1}
    if "(双)" in text or "（双）" in text:
        weeks = {week for week in weeks if week % 2 == 0}
    return sorted(weeks)


def _normalize_rows(cls, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    courses: list[dict[str, Any]] = []
    seen: set[tuple[Any, ...]] = set()
    for row in rows:
        course_name = str(row.get("KCM") or row.get("XSKCM") or "").strip()
        teacher_name = str(
            row.get("SKJS") or row.get("JSXM") or row.get("RKJS") or ""
        ).strip()
        weekday = cls._integer(row.get("SKXQ") or row.get("XQJ"))
        start_period = cls._integer(row.get("KSJC") or row.get("JCQZ"))
        end_period = cls._integer(row.get("JSJC") or row.get("JCZZ"))
        if not course_name or start_period is None or end_period is None:
            continue
        periods = list(range(start_period, end_period + 1))
        classroom = str(
            row.get("JASMC") or row.get("SKDD") or row.get("CDMC") or ""
        ).strip()
        weeks = cls._weeks(row.get("SKZC") or row.get("ZC") or row.get("ZCMC"))
        key = (
            course_name,
            teacher_name,
            weekday,
            start_period,
            end_period,
            classroom,
            tuple(weeks),
        )
        if key in seen:
            continue
        seen.add(key)
        course = {
            "courseName": course_name,
            "teacherName": teacher_name,
            "weekday": weekday,
            "startPeriod": start_period,
            "endPeriod": end_period,
            "weeklyPeriods": periods,
            "weeks": weeks,
            "classroom": classroom,
            "courseCode": str(row.get("KCH") or row.get("XSKCH") or "").strip(),
        }
        optional_fields = {
            "courseNature": row.get("KCXZDM_DISPLAY") or row.get("KCXZMC"),
            "courseGroup": row.get("KZM") or row.get("KCLBMC"),
            "credits": row.get("XF"),
            "hours": row.get("XS"),
            "department": row.get("KKDWDM_DISPLAY") or row.get("KKDWMC"),
            "assessment": row.get("KSLXDM_DISPLAY") or row.get("KSLXMC"),
        }
        course.update(
            {
                key: value.strip() if isinstance(value, str) else value
                for key, value in optional_fields.items()
                if value not in (None, "")
            }
        )
        course["scheduleId"] = cls._schedule_id(course)
        courses.append(course)
    return sorted(
        courses,
        key=lambda item: (
            item["weekday"] is None,
            item["weekday"] or 0,
            item["startPeriod"],
            item["courseName"],
        ),
    )


def _rows_from_payload(payload: Any) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []

    def walk(value: Any) -> None:
        if isinstance(value, dict):
            rows = value.get("rows")
            if isinstance(rows, list):
                found.extend(row for row in rows if isinstance(row, dict))
            for nested in value.values():
                walk(nested)
        elif isinstance(value, list):
            for nested in value:
                walk(nested)

    walk(payload)
    return found


def _normalize_dom_records(
    cls, records: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    weekdays = {
        "星期一": 1,
        "星期二": 2,
        "星期三": 3,
        "星期四": 4,
        "星期五": 5,
        "星期六": 6,
        "星期日": 7,
        "星期天": 7,
    }
    for record in records:
        details = [part.strip() for part in record.get("details", "").split(",")]
        period_index = next(
            (
                index
                for index, part in enumerate(details)
                if re.fullmatch(r"\d+-\d+", part)
            ),
            None,
        )
        weekday_text = next(
            (part for part in details if part in weekdays), ""
        )
        if period_index is None:
            continue
        start_period, end_period = details[period_index].split("-", 1)
        classroom = details[period_index + 1] if len(details) > period_index + 1 else ""
        rows.append(
            {
                "KCM": record.get("courseName", ""),
                "SKJS": record.get("teacherName", ""),
                "SKXQ": weekdays.get(weekday_text),
                "KSJC": start_period,
                "JSJC": end_period,
                "SKZC": details[0] if details else "",
                "JASMC": classroom,
            }
        )
    return cls._normalize_rows(rows)


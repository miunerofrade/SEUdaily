"""Local timetable evidence and credit/status calculations."""

from __future__ import annotations
import json
import re
from pathlib import Path
from typing import Any
from .campus_api import CampusAPIError


def _normalize_course_name(value: Any) -> str:
    return (
        re.sub(r"\s+", "", str(value or "").strip())
        .replace("（", "(")
        .replace("）", ")")
        .casefold()
    )


def _schedule_index(self) -> tuple[str, str, dict[str, dict[str, Any]]]:
    evidence: dict[str, dict[str, Any]] = {}
    current_semester = ""
    current_label = ""
    paths = [self.schedule_cache_file]
    paths.extend(
        path
        for path in sorted(self.schedule_cache_file.parent.glob("schedule.*.json"))
        if path != self.schedule_cache_file and path.name != "schedule-user.json"
    )
    seen_paths: set[Path] = set()
    for path in paths:
        resolved = path.resolve()
        if resolved in seen_paths:
            continue
        seen_paths.add(resolved)
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if path == self.schedule_cache_file:
            current_semester = str(
                payload.get("currentSemester") or payload.get("selectedSemester") or ""
            ).strip()
            current_label = str(
                payload.get("currentSemesterLabel")
                or payload.get("selectedSemesterLabel")
                or ""
            ).strip()
        selected_semester = str(payload.get("selectedSemester") or "").strip()
        selected_label = str(payload.get("selectedSemesterLabel") or "").strip()
        for raw_course in payload.get("courses") or []:
            if not isinstance(raw_course, dict):
                continue
            semester = str(raw_course.get("semester") or selected_semester).strip()
            if not semester:
                continue
            bucket = evidence.setdefault(
                semester,
                {
                    "label": selected_label,
                    "codes": set(),
                    "names": set(),
                    "courses": [],
                    "courseKeys": set(),
                },
            )
            if selected_label and not bucket["label"]:
                bucket["label"] = selected_label
            code = str(raw_course.get("courseCode") or "").strip()
            name = str(raw_course.get("courseName") or "").strip()
            normalized_name = self._normalize_course_name(name)
            if code:
                bucket["codes"].add(code)
            if normalized_name:
                bucket["names"].add(normalized_name)
            identity = (code, normalized_name)
            if identity not in bucket["courseKeys"]:
                bucket["courseKeys"].add(identity)
                bucket["courses"].append(dict(raw_course))
    for bucket in evidence.values():
        bucket.pop("courseKeys", None)
    if not current_semester and evidence:
        current_semester = max(evidence)
        current_label = str(evidence[current_semester].get("label") or "")
    return current_semester, current_label, evidence


def _schedule_context(self) -> tuple[str, str, set[str], set[str]]:
    semester, label, evidence = self._schedule_index()
    current = evidence.get(semester, {})
    return (
        semester,
        label,
        set(current.get("codes") or set()),
        set(current.get("names") or set()),
    )


def _current_semester(self) -> tuple[str, str]:
    semester, label, _, _ = self._schedule_context()
    return semester, label


def _semester_values(value: str) -> list[str]:
    return [part.strip() for part in re.split(r"[,，]", value) if part.strip()]


def _display_semester_label(cls, semester: str, label: str) -> str:
    semester_values = cls._semester_values(semester)
    label_values = cls._semester_values(label)
    if len(semester_values) <= 1 and len(label_values) <= 1:
        return label
    if len(label_values) != len(semester_values):
        return f"{' 或 '.join(label_values or semester_values)}可选"
    parsed = [re.fullmatch(r"(\d{4}-\d{4})学年\s*(.+)", item) for item in label_values]
    if parsed and all(
        match and match.group(1) == parsed[0].group(1) for match in parsed
    ):
        year = parsed[0].group(1)
        terms = [match.group(2).strip() for match in parsed if match]
        return f"{year}学年 {'或'.join(terms)}可选"
    return f"{' 或 '.join(label_values)}可选"


def _semester_options(cls, semester: str, label: str) -> list[dict[str, Any]]:
    semester_values = cls._semester_values(semester)
    label_values = cls._semester_values(label)

    def fallback_label(value: str) -> str:
        match = re.fullmatch(r"(\d{4}-\d{4})-(\d+)", value)
        if not match:
            return value
        term = {"1": "暑期学校", "2": "秋季学期", "3": "三学期"}.get(
            match.group(2), f"第{match.group(2)}学期"
        )
        return f"{match.group(1)}学年{term}"

    aligned_labels = label_values if len(label_values) == len(semester_values) else []
    return [
        {
            "value": value,
            "label": aligned_labels[index]
            if index < len(aligned_labels)
            else fallback_label(value),
        }
        for index, value in enumerate(semester_values)
    ]


def _course_matches_schedule(
    cls,
    course: dict[str, Any],
    scheduled_codes: set[str],
    scheduled_names: set[str],
) -> bool:
    codes = {
        str(course.get("code") or "").strip(),
        *{
            str(option.get("code") or "").strip()
            for option in course.get("options") or []
            if isinstance(option, dict)
        },
    }
    expanded_codes = {
        part.strip() for code in codes for part in code.split("/") if part.strip()
    }
    names = {
        cls._normalize_course_name(course.get("name")),
        *{
            cls._normalize_course_name(option.get("name"))
            for option in course.get("options") or []
            if isinstance(option, dict)
        },
    }
    return bool(expanded_codes & scheduled_codes or names & scheduled_names)


def _course_status(
    cls, semester: str, current_semester: str, *, is_scheduled: bool = False
) -> str:
    if not semester:
        return "unscheduled"
    if not current_semester:
        return "unknown"
    semesters = cls._semester_values(semester)
    if current_semester in semesters:
        return "studying" if is_scheduled else "not_taken"
    if semesters and all(value < current_semester for value in semesters):
        return "completed" if is_scheduled else "not_taken"
    return "upcoming"


def _apply_course_evidence(
    cls,
    course: dict[str, Any],
    current_semester: str,
    schedule_evidence: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    semester_values = cls._semester_values(str(course.get("semester") or ""))
    existing_options = [
        dict(option)
        for option in course.get("semesterOptions") or []
        if isinstance(option, dict) and option.get("value")
    ]
    semester_options = (
        existing_options
        if [str(option["value"]) for option in existing_options] == semester_values
        else cls._semester_options(
            str(course.get("semester") or ""),
            str(course.get("semesterLabel") or ""),
        )
    )
    for option in semester_options:
        option.pop("manualStatus", None)
        bucket = schedule_evidence.get(option["value"], {})
        option["status"] = cls._course_status(
            option["value"],
            current_semester,
            is_scheduled=cls._course_matches_schedule(
                course,
                set(bucket.get("codes") or set()),
                set(bucket.get("names") or set()),
            ),
        )
    course["semesterOptions"] = semester_options
    statuses = [option["status"] for option in semester_options]
    course["status"] = next(
        (
            status
            for status in (
                "studying",
                "completed",
                "not_taken",
                "upcoming",
                "unscheduled",
                "unknown",
            )
            if status in statuses
        ),
        "unscheduled" if not course.get("semester") else "unknown",
    )
    return course


def _course_override_key(cls, course: dict[str, Any], semester: str) -> str:
    identity = str(course.get("id") or course.get("code") or "").strip()
    if not identity:
        identity = cls._normalize_course_name(course.get("name"))
    return f"{identity}::{semester or 'unassigned'}"


def _aggregate_course_status(cls, course: dict[str, Any]) -> str:
    statuses = [
        str(option.get("status") or "unknown")
        for option in course.get("semesterOptions") or []
        if isinstance(option, dict)
    ]
    return next(
        (
            status
            for status in (
                "studying",
                "completed",
                "not_taken",
                "upcoming",
                "unscheduled",
                "unknown",
            )
            if status in statuses
        ),
        str(course.get("status") or "unknown"),
    )


def _apply_default_credits(cls, course: dict[str, Any]) -> None:
    is_general_choice = "通选" in (
        f"{course.get('group') or ''} {course.get('nature') or ''}"
    )
    if is_general_choice and cls._number(course.get("credits")) <= 0:
        course["credits"] = 2


def _recompute_plan_credits(cls, plan: dict[str, Any]) -> None:
    counted_completed = 0.0
    studying = 0.0
    general_elective = 0.0
    manual_adjustment = 0.0
    for course in plan.get("courses") or []:
        if not isinstance(course, dict):
            continue
        cls._apply_default_credits(course)
        credits = cls._number(course.get("credits"))
        status = str(course.get("status") or "unknown")
        manual_options = [
            option
            for option in course.get("semesterOptions") or []
            if isinstance(option, dict) and option.get("manualStatus")
        ]
        if manual_options:
            has_manual_completion = any(
                option.get("status") == "completed"
                and option.get("autoStatus") != "completed"
                for option in manual_options
            )
            has_manual_removal = any(
                option.get("status") != "completed"
                and option.get("autoStatus") == "completed"
                for option in manual_options
            )
            if has_manual_completion:
                manual_adjustment += credits
            elif has_manual_removal:
                manual_adjustment -= credits
        if status == "completed":
            counted_completed += credits
            if course.get("isGeneralElective"):
                general_elective += credits
        elif status == "studying":
            studying += credits
    official = cls._number(
        plan.get("officialCompletedCredits", plan.get("completedCredits"))
    )
    required = cls._number(plan.get("requiredCredits"))
    completed = max(counted_completed, official + manual_adjustment, 0.0)
    plan["officialCompletedCredits"] = cls._display_number(official)
    plan["completedCredits"] = cls._display_number(completed)
    plan["progress"] = (
        round(min(100.0, completed / required * 100), 1) if required else 0
    )
    plan["creditSummary"] = {
        "countedCompleted": cls._display_number(counted_completed),
        "studying": cls._display_number(studying),
        "remaining": cls._display_number(max(0.0, required - completed)),
        "generalElectiveCompleted": cls._display_number(general_elective),
        "manualAdjustment": cls._display_number(manual_adjustment),
    }

"""Official school field normalization and course choices."""

from __future__ import annotations
import json
import re
from pathlib import Path
from typing import Any
from .campus_api import CampusAPIError
from .training_plan_evidence import _semester_values


def _number(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def _display_number(value: float) -> int | float:
    return int(value) if float(value).is_integer() else round(value, 2)


def _normalize_course(
    cls,
    row: dict[str, Any],
    group_info: dict[str, dict[str, Any]],
    current_semester: str,
    schedule_evidence: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    credits = cls._number(row.get("XF"))
    hours = cls._number(row.get("XS"))
    semester = str(row.get("XNXQ") or "").strip()
    group_id = str(row.get("KZH") or "").strip()
    group = group_info.get(group_id, {})
    code = str(row.get("KCH") or "").strip()
    name = str(row.get("KCM") or "").strip()
    if not name:
        raise CampusAPIError("培养方案课程记录缺少 KCM，学校接口可能发生变化")
    course = {
        "id": str(row.get("WID") or ""),
        "code": code,
        "name": name,
        "group": str(row.get("KZM") or group.get("name") or "").strip(),
        "nature": str(row.get("KCXZDM_DISPLAY") or "").strip(),
        "credits": cls._display_number(credits),
        "hours": cls._display_number(hours),
        "semester": semester,
        "semesterLabel": cls._display_semester_label(
            semester, str(row.get("XNXQ_DISPLAY") or "").strip()
        ),
        "semesterOptions": cls._semester_options(
            semester, str(row.get("XNXQ_DISPLAY") or "").strip()
        ),
        "department": str(row.get("KKDWDM_DISPLAY") or "").strip(),
        "assessment": str(row.get("KSLXDM_DISPLAY") or "").strip(),
        "note": str(row.get("BZ") or "").strip(),
        "status": "unknown",
        "options": [],
        "choiceNote": "",
        "source": "plan",
        "classificationSource": "ehall",
        "isGeneralElective": cls._is_general_elective(
            str(row.get("KZM") or group.get("name") or "").strip(),
            str(row.get("KCXZDM_DISPLAY") or "").strip(),
            name,
        ),
        "_groupId": group_id,
        "_groupNote": str(group.get("note") or "").strip(),
    }
    return cls._apply_course_evidence(course, current_semester, schedule_evidence)


def _is_general_elective(group: str, nature: str, name: str = "") -> bool:
    text = f"{group} {nature} {name}"
    return any(token in text for token in ("通识选修", "通选", "跨学科选修"))


def _merge_semester_options(cls, courses: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged: dict[str, dict[str, Any]] = {}
    for course in courses:
        for option in course.get("semesterOptions") or []:
            value = str(option.get("value") or "")
            if not value:
                continue
            current = merged.setdefault(
                value,
                {
                    "value": value,
                    "label": str(option.get("label") or value),
                    "status": "unknown",
                },
            )
            statuses = {
                current["status"],
                str(option.get("status") or "unknown"),
            }
            current["status"] = next(
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
                "unknown",
            )
    return [merged[key] for key in sorted(merged)]


def _merge_course_options(
    cls, courses: list[dict[str, Any]], *, ab_base: str = ""
) -> dict[str, Any]:
    first = courses[0]
    names = list(dict.fromkeys(course["name"] for course in courses))
    codes = list(dict.fromkeys(course["code"] for course in courses if course["code"]))
    groups = list(
        dict.fromkeys(course["group"] for course in courses if course["group"])
    )
    if ab_base:
        name = f"{ab_base} A / B"
        group_bases = {
            re.sub(r"[（(][AB]层次[）)]", "", group).strip() for group in groups
        }
        group_name = (
            f"{next(iter(group_bases))}（A/B 层次）"
            if len(group_bases) == 1
            else " / ".join(groups)
        )
    else:
        name = " / ".join(names)
        group_name = groups[0] if len(groups) == 1 else " / ".join(groups)
    merged = {
        **first,
        "id": "choice:" + "|".join(course["id"] for course in courses),
        "name": name,
        "code": " / ".join(codes),
        "group": group_name,
        "options": [
            {"name": course["name"], "code": course["code"]} for course in courses
        ],
        "choiceNote": next(
            (course["_groupNote"] for course in courses if course["_groupNote"]),
            "二选一",
        ),
        "semesterOptions": cls._merge_semester_options(courses),
        "isGeneralElective": any(course.get("isGeneralElective") for course in courses),
    }
    statuses = [option["status"] for option in merged["semesterOptions"]]
    merged["status"] = next(
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
        first["status"],
    )
    return merged


def _merge_choices(cls, courses: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped_choices: dict[tuple[str, str], list[dict[str, Any]]] = {}
    remaining: list[dict[str, Any]] = []
    for course in courses:
        if (
            re.search(r"(?:任|[一二三四五六七八九十百\d]+)选一", course["_groupNote"])
            and course["_groupId"]
        ):
            grouped_choices.setdefault(
                (course["_groupId"], course["semester"]), []
            ).append(course)
        else:
            remaining.append(course)

    merged: list[dict[str, Any]] = []
    for options in grouped_choices.values():
        if len(options) > 1:
            merged.append(cls._merge_course_options(options))
        else:
            remaining.extend(options)

    ab_groups: dict[tuple[str, str, str, int | float], list[dict[str, Any]]] = {}
    still_remaining: list[dict[str, Any]] = []
    for course in remaining:
        match = re.fullmatch(r"(.+?)([AB])", course["name"])
        if not match:
            still_remaining.append(course)
            continue
        ab_groups.setdefault(
            (
                match.group(1).strip(),
                course["semester"],
                course["nature"],
                course["credits"],
            ),
            [],
        ).append(course)
    for (base, _, _, _), options in ab_groups.items():
        variants = {course["name"][-1] for course in options}
        if variants == {"A", "B"}:
            merged.append(cls._merge_course_options(options, ab_base=base))
        else:
            still_remaining.extend(options)
    return still_remaining + merged


def _study_requirements(cls, group_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    requirements: list[dict[str, Any]] = []
    seen: set[tuple[str, str, int | float, str]] = set()
    for row in group_rows:
        name = str(row.get("KZM") or "").strip()
        note = str(row.get("BZ") or "").strip()
        required = cls._number(row.get("ZSXDXF"))
        available = cls._number(row.get("KCZXF"))
        nature = str(row.get("KCXZDM_DISPLAY") or "").strip()
        relevant_note = note and any(
            token in note for token in ("任选", "跨学科", "全英文", "通识", "通选")
        )
        explicit_general_requirement = required > 0 and any(
            token in name for token in ("通识选修", "通选")
        )
        if not relevant_note and not explicit_general_requirement:
            continue
        display_note = (
            note or f"培养方案要求至少修读 {cls._display_number(required)} 学分"
        )
        key = (
            name,
            nature,
            cls._display_number(required),
            display_note,
        )
        if key in seen:
            continue
        seen.add(key)
        requirements.append(
            {
                "name": name,
                "nature": nature,
                "requiredCredits": cls._display_number(required),
                "availableCredits": cls._display_number(available),
                "note": display_note,
            }
        )
    requirements.sort(
        key=lambda item: (
            "专业方向及跨学科" not in item["name"],
            "跨学科" not in item["name"],
            "专题实践" not in item["name"],
            item["name"],
        )
    )
    return requirements


def _schedule_course_classification(
    cls, course: dict[str, Any]
) -> tuple[str, str, str, bool]:
    nature = str(
        course.get("courseNature")
        or course.get("nature")
        or course.get("KCXZDM_DISPLAY")
        or ""
    ).strip()
    group = str(
        course.get("courseGroup")
        or course.get("group")
        or course.get("category")
        or course.get("KZM")
        or ""
    ).strip()
    name = str(course.get("courseName") or "").strip()
    code = str(course.get("courseCode") or "").strip().upper()
    if nature or group:
        is_general = cls._is_general_elective(group, nature, name)
        return (
            group or "方案外课表课程",
            nature or "课表课程",
            "schedule_explicit",
            is_general,
        )
    if re.fullmatch(r"B00(?:ZR|MY|RW)\d+", code):
        return "通选课", "通选", "course_code", True
    if code.startswith("B00XL"):
        return "心理健康教育", "通识课程", "course_code", True
    return "方案外课表课程", "课表课程", "unknown", False


def _append_schedule_only_courses(
    cls,
    plan: dict[str, Any],
    schedule_evidence: dict[str, dict[str, Any]],
    current_semester: str,
) -> None:
    plan_courses = [
        course
        for course in plan.get("courses") or []
        if isinstance(course, dict) and course.get("source") != "schedule"
    ]
    additions: list[dict[str, Any]] = []
    for semester, bucket in schedule_evidence.items():
        codes = set(bucket.get("codes") or set())
        names = set(bucket.get("names") or set())
        for raw in bucket.get("courses") or []:
            code = str(raw.get("courseCode") or "").strip()
            name = str(raw.get("courseName") or "").strip()
            if not name:
                continue
            singleton_codes = {code} if code else set()
            singleton_names = {cls._normalize_course_name(name)}
            if any(
                cls._course_matches_schedule(course, singleton_codes, singleton_names)
                for course in plan_courses
            ):
                continue
            group, nature, classification_source, is_general = (
                cls._schedule_course_classification(raw)
            )
            label = str(bucket.get("label") or "").strip()
            course = {
                "id": f"schedule:{semester}:{code or cls._normalize_course_name(name)}",
                "code": code,
                "name": name,
                "group": group,
                "nature": nature,
                "credits": cls._display_number(
                    cls._number(raw.get("credits") or raw.get("XF"))
                    or (2.0 if is_general else 0.0)
                ),
                "hours": cls._display_number(
                    cls._number(raw.get("hours") or raw.get("XS"))
                ),
                "semester": semester,
                "semesterLabel": cls._display_semester_label(semester, label),
                "semesterOptions": cls._semester_options(semester, label),
                "department": str(raw.get("department") or "").strip(),
                "assessment": str(raw.get("assessment") or "").strip(),
                "note": "",
                "status": cls._course_status(
                    semester, current_semester, is_scheduled=True
                ),
                "options": [],
                "choiceNote": "",
                "source": "schedule",
                "classificationSource": classification_source,
                "isGeneralElective": is_general,
            }
            cls._apply_course_evidence(
                course,
                current_semester,
                {
                    semester: {
                        "codes": codes,
                        "names": names,
                    }
                },
            )
            additions.append(course)
    plan["courses"] = plan_courses + additions


def _sort_courses(courses: list[dict[str, Any]]) -> None:
    nature_rank = {
        "必修": 0,
        "限选": 1,
        "任选": 2,
        "通识课程": 3,
        "通选": 3,
        "课表课程": 4,
    }
    courses.sort(
        key=lambda course: (
            not bool(course.get("semester")),
            (_semester_values(str(course.get("semester") or "")) or [""])[0],
            nature_rank.get(str(course.get("nature") or ""), 5),
            bool(course.get("isGeneralElective")),
            course.get("source") == "schedule",
            str(course.get("group") or ""),
            str(course.get("code") or ""),
            str(course.get("name") or ""),
        )
    )


def _normalize_plan(
    cls,
    summary: dict[str, Any],
    detail: dict[str, Any],
    group_rows: list[dict[str, Any]],
    course_rows: list[dict[str, Any]],
    current_semester: str = "",
    current_semester_label: str = "",
    scheduled_codes: set[str] | None = None,
    scheduled_names: set[str] | None = None,
    schedule_evidence: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    required = cls._number(
        detail.get("ZSYQXFXSZ") or detail.get("ZSYQXF") or summary.get("ZSYQXF")
    )
    completed = cls._number(summary.get("YWCXF"))
    group_info = {
        str(row.get("KZH") or ""): {
            "name": str(row.get("KZM") or "").strip(),
            "note": str(row.get("BZ") or "").strip(),
        }
        for row in group_rows
        if row.get("KZH")
    }
    courses: list[dict[str, Any]] = []
    evidence = schedule_evidence or {}
    if current_semester and current_semester not in evidence:
        evidence[current_semester] = {
            "codes": scheduled_codes or set(),
            "names": scheduled_names or set(),
            "courses": [],
            "label": current_semester_label,
        }
    seen: set[tuple[str, str, str]] = set()
    for row in course_rows:
        course = cls._normalize_course(
            row,
            group_info,
            current_semester,
            evidence,
        )
        if not course["name"]:
            continue
        key = (
            course["code"],
            course["name"],
            course["semester"],
        )
        if key in seen:
            continue
        seen.add(key)
        courses.append(course)

    courses = cls._merge_choices(courses)
    plan_shell = {"courses": courses}
    cls._append_schedule_only_courses(plan_shell, evidence, current_semester)
    courses = plan_shell["courses"]
    cls._sort_courses(courses)
    for course in courses:
        course.pop("_groupId", None)
        course.pop("_groupNote", None)
    plan = {
        "id": str(summary.get("PYFADM") or detail.get("PYFADM") or ""),
        "title": str(
            detail.get("PYFAMC") or summary.get("PYFAMC") or "个人培养方案"
        ).strip(),
        "major": str(
            detail.get("ZYDM_DISPLAY") or summary.get("ZYDM_DISPLAY") or ""
        ).strip(),
        "grade": str(
            detail.get("NJDM_DISPLAY") or summary.get("XZNJ_DISPLAY") or ""
        ).strip(),
        "department": str(
            detail.get("DWDM_DISPLAY") or summary.get("YXDM_DISPLAY") or ""
        ).strip(),
        "track": str(
            detail.get("XDLXDM_DISPLAY") or summary.get("XDLXDM_DISPLAY") or ""
        ).strip(),
        "degree": str(detail.get("XWDM_DISPLAY") or "").strip(),
        "startSemester": str(detail.get("KSXQDM_DISPLAY") or "").strip(),
        "requiredCredits": cls._display_number(required),
        "officialCompletedCredits": cls._display_number(completed),
        "completedCredits": cls._display_number(completed),
        "progress": round(min(100.0, completed / required * 100), 1) if required else 0,
        "objective": str(detail.get("PYMB") or "").strip(),
        "requirements": str(detail.get("XDYQ") or "").strip(),
        "mainCourses": str(detail.get("ZGKC") or "").strip(),
        "currentSemester": current_semester,
        "currentSemesterLabel": current_semester_label,
        "studyRequirements": cls._study_requirements(group_rows),
        "courseGroupCount": len(group_rows),
        "courseCount": len(courses),
        "courses": courses,
    }
    cls._recompute_plan_credits(plan)
    return plan

from __future__ import annotations

import json
import os
import re
import tempfile
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError

from .browser_runtime import browser_runtime
from .schedule import DEFAULT_USER_AGENT


DEFAULT_PLAN_APP_ID = "4766859113956613"
DEFAULT_PLAN_LAUNCH_URL = (
    f"https://ehall.seu.edu.cn/appShow?appId={DEFAULT_PLAN_APP_ID}"
)
PLAN_APP_PATH = "/jwapp/sys/xsfacx/"
PLAN_API_ROOT = "https://ehall.seu.edu.cn/jwapp/sys"


class TrainingPlanService:
    """Read the signed-in student's official undergraduate plan from eHall."""

    def __init__(
        self,
        *,
        cookie_file: str | Path = ".cvstream/ehall-cookies.json",
        cache_file: str | Path = ".cvstream/training-plan.json",
        schedule_cache_file: str | Path = ".cvstream/schedule.json",
        launch_url: str = DEFAULT_PLAN_LAUNCH_URL,
    ) -> None:
        self.cookie_file = Path(cookie_file)
        self.cache_file = Path(cache_file)
        self.schedule_cache_file = Path(schedule_cache_file)
        self.launch_url = launch_url

    @staticmethod
    def _source() -> dict[str, Any]:
        return {
            "title": "eHall 个人方案查询",
            "url": DEFAULT_PLAN_LAUNCH_URL,
            "path": ["办事服务", "教务处", "方案中心", "个人方案查询"],
            "source": "东南大学网上办事服务大厅",
        }

    @contextmanager
    def _page(self):
        with browser_runtime().page(
            "training-plan-portal",
            visible=False,
            context_options={
                "viewport": {"width": 1920, "height": 1080},
                "user_agent": DEFAULT_USER_AGENT,
                "locale": "zh-CN",
                "timezone_id": "Asia/Shanghai",
            },
        ) as page:
            if self.cookie_file.exists():
                try:
                    cookies = json.loads(self.cookie_file.read_text(encoding="utf-8"))
                    page.context.add_cookies(cookies)
                except (OSError, ValueError):
                    pass
            page.add_init_script(
                "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"
            )
            yield page

    @staticmethod
    def _is_auth_page(url: str) -> bool:
        lowered = url.lower()
        return any(
            marker in lowered
            for marker in (
                "/controller/v1/public/verify",
                "auth.seu.edu.cn/dist/",
                "vpn.seu.edu.cn/portal/shortcut",
                "authserver/login",
                "/login",
                "cas/login",
            )
        )

    @staticmethod
    def _write_json_atomic(path: Path, payload: Any) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as temp_file:
            json.dump(payload, temp_file, ensure_ascii=False, indent=2)
            temp_name = temp_file.name
        os.replace(temp_name, path)

    def _save_cookies(self, page) -> None:
        self._write_json_atomic(self.cookie_file, page.context.cookies())

    @staticmethod
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
                    payload.get("currentSemester")
                    or payload.get("selectedSemester")
                    or ""
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

    @staticmethod
    def _semester_values(value: str) -> list[str]:
        return [part.strip() for part in re.split(r"[,，]", value) if part.strip()]

    @classmethod
    def _display_semester_label(cls, semester: str, label: str) -> str:
        semester_values = cls._semester_values(semester)
        label_values = cls._semester_values(label)
        if len(semester_values) <= 1 and len(label_values) <= 1:
            return label
        if len(label_values) != len(semester_values):
            return f"{' 或 '.join(label_values or semester_values)}可选"
        parsed = [re.fullmatch(r"(\d{4}-\d{4})学年\s*(.+)", item) for item in label_values]
        if parsed and all(match and match.group(1) == parsed[0].group(1) for match in parsed):
            year = parsed[0].group(1)
            terms = [match.group(2).strip() for match in parsed if match]
            return f"{year}学年 {'或'.join(terms)}可选"
        return f"{' 或 '.join(label_values)}可选"

    @classmethod
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

    @classmethod
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
            part.strip()
            for code in codes
            for part in code.split("/")
            if part.strip()
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

    @classmethod
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

    @classmethod
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

    def _load_cache(self) -> dict[str, Any] | None:
        try:
            cached = json.loads(self.cache_file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        if cached.get("version") != 1 or not isinstance(cached.get("plans"), list):
            return None

        current_semester, current_semester_label, schedule_evidence = (
            self._schedule_index()
        )
        for plan in cached["plans"]:
            if not isinstance(plan, dict):
                continue
            plan["currentSemester"] = current_semester
            plan["currentSemesterLabel"] = current_semester_label
            plan["courses"] = [
                course
                for course in plan.get("courses") or []
                if isinstance(course, dict) and course.get("source") != "schedule"
            ]
            for course in plan.get("courses") or []:
                if isinstance(course, dict):
                    raw_label = str(course.get("semesterLabel") or "").strip()
                    course["semesterLabel"] = self._display_semester_label(
                        str(course.get("semester") or "").strip(),
                        raw_label,
                    )
                    course.setdefault("source", "plan")
                    course.setdefault("classificationSource", "ehall")
                    course.setdefault(
                        "isGeneralElective",
                        self._is_general_elective(
                            str(course.get("group") or ""),
                            str(course.get("nature") or ""),
                            str(course.get("name") or ""),
                        ),
                    )
                    self._apply_course_evidence(
                        course, current_semester, schedule_evidence
                    )
            self._append_schedule_only_courses(
                plan, schedule_evidence, current_semester
            )
            self._sort_courses(plan.get("courses") or [])
            plan["courseCount"] = len(plan.get("courses") or [])
        return cached

    @staticmethod
    def _number(value: Any) -> float:
        try:
            return float(value or 0)
        except (TypeError, ValueError):
            return 0.0

    @staticmethod
    def _display_number(value: float) -> int | float:
        return int(value) if value.is_integer() else round(value, 2)

    @staticmethod
    def _rows(payload: dict[str, Any], dataset: str) -> list[dict[str, Any]]:
        rows = payload.get("datas", {}).get(dataset, {}).get("rows", [])
        if not isinstance(rows, list):
            raise RuntimeError(f"eHall 返回的 {dataset} 数据格式无效")
        return [row for row in rows if isinstance(row, dict)]

    @classmethod
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
        return cls._apply_course_evidence(
            course, current_semester, schedule_evidence
        )

    @staticmethod
    def _is_general_elective(group: str, nature: str, name: str = "") -> bool:
        text = f"{group} {nature} {name}"
        return any(token in text for token in ("通识选修", "通选", "跨学科选修"))

    @classmethod
    def _merge_semester_options(
        cls, courses: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
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

    @classmethod
    def _merge_course_options(
        cls, courses: list[dict[str, Any]], *, ab_base: str = ""
    ) -> dict[str, Any]:
        first = courses[0]
        names = list(dict.fromkeys(course["name"] for course in courses))
        codes = list(dict.fromkeys(course["code"] for course in courses if course["code"]))
        groups = list(dict.fromkeys(course["group"] for course in courses if course["group"]))
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
                {"name": course["name"], "code": course["code"]}
                for course in courses
            ],
            "choiceNote": next(
                (
                    course["_groupNote"]
                    for course in courses
                    if course["_groupNote"]
                ),
                "二选一",
            ),
            "semesterOptions": cls._merge_semester_options(courses),
            "isGeneralElective": any(
                course.get("isGeneralElective") for course in courses
            ),
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

    @classmethod
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

    @classmethod
    def _study_requirements(
        cls, group_rows: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
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
            display_note = note or f"培养方案要求至少修读 {cls._display_number(required)} 学分"
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

    @classmethod
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
            return group or "方案外课表课程", nature or "课表课程", "schedule_explicit", is_general
        if re.fullmatch(r"B00(?:ZR|MY|RW)\d+", code):
            return "通选课", "通选", "course_code", True
        if code.startswith("B00XL"):
            return "心理健康教育", "通识课程", "course_code", True
        return "方案外课表课程", "课表课程", "unknown", False

    @classmethod
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
                    cls._course_matches_schedule(
                        course, singleton_codes, singleton_names
                    )
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
                    "credits": cls._display_number(cls._number(raw.get("credits") or raw.get("XF"))),
                    "hours": cls._display_number(cls._number(raw.get("hours") or raw.get("XS"))),
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

    @staticmethod
    def _sort_courses(courses: list[dict[str, Any]]) -> None:
        nature_rank = {"必修": 0, "限选": 1, "任选": 2, "通识课程": 3, "通选": 3, "课表课程": 4}
        courses.sort(
            key=lambda course: (
                not bool(course.get("semester")),
                (
                    TrainingPlanService._semester_values(
                        str(course.get("semester") or "")
                    )
                    or [""]
                )[0],
                nature_rank.get(str(course.get("nature") or ""), 5),
                bool(course.get("isGeneralElective")),
                course.get("source") == "schedule",
                str(course.get("group") or ""),
                str(course.get("code") or ""),
                str(course.get("name") or ""),
            )
        )

    @classmethod
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
            detail.get("ZSYQXFXSZ")
            or detail.get("ZSYQXF")
            or summary.get("ZSYQXF")
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
        return {
            "id": str(summary.get("PYFADM") or detail.get("PYFADM") or ""),
            "title": str(
                detail.get("PYFAMC") or summary.get("PYFAMC") or "个人培养方案"
            ).strip(),
            "major": str(
                detail.get("ZYDM_DISPLAY") or summary.get("ZYDM_DISPLAY") or ""
            ).strip(),
            "grade": str(
                detail.get("NJDM_DISPLAY")
                or summary.get("XZNJ_DISPLAY")
                or ""
            ).strip(),
            "department": str(
                detail.get("DWDM_DISPLAY") or summary.get("YXDM_DISPLAY") or ""
            ).strip(),
            "track": str(
                detail.get("XDLXDM_DISPLAY")
                or summary.get("XDLXDM_DISPLAY")
                or ""
            ).strip(),
            "degree": str(detail.get("XWDM_DISPLAY") or "").strip(),
            "startSemester": str(detail.get("KSXQDM_DISPLAY") or "").strip(),
            "requiredCredits": cls._display_number(required),
            "completedCredits": cls._display_number(completed),
            "progress": round(min(100.0, completed / required * 100), 1)
            if required
            else 0,
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

    @staticmethod
    def _post_rows(
        page, path: str, dataset: str, form: dict[str, str]
    ) -> list[dict[str, Any]]:
        response = page.request.post(
            f"{PLAN_API_ROOT}{path}",
            form=form,
            headers={
                "Referer": page.url,
                "X-Requested-With": "XMLHttpRequest",
            },
            timeout=30000,
        )
        if not response.ok:
            raise RuntimeError(f"eHall 接口请求失败（{response.status}）")
        return TrainingPlanService._rows(response.json(), dataset)

    def _fetch_remote(self) -> dict[str, Any]:
        with self._page() as page:
            try:
                page.goto(
                    self.launch_url,
                    wait_until="domcontentloaded",
                    timeout=30000,
                )
                try:
                    page.wait_for_url(f"**{PLAN_APP_PATH}**", timeout=15000)
                except PlaywrightTimeoutError:
                    pass
                page.wait_for_timeout(1500)
            except PlaywrightTimeoutError:
                pass

            if self._is_auth_page(page.url) or PLAN_APP_PATH not in page.url:
                return {
                    "status": "auth_required",
                    "message": "eHall 登录会话不存在或已失效，请重新授权。",
                    "source": self._source(),
                    "plans": [],
                }
            if page.title().strip() == "403":
                return {
                    "status": "launch_failed",
                    "message": "eHall 个人方案查询应用启动失败，请重新授权后再试。",
                    "source": self._source(),
                    "plans": [],
                }

            plan_rows = self._post_rows(
                page,
                "/xsfacx/modules/pyfacxepg/grpyfacx.do",
                "grpyfacx",
                {},
            )
            (
                current_semester,
                current_semester_label,
                schedule_evidence,
            ) = self._schedule_index()
            plans: list[dict[str, Any]] = []
            for summary in plan_rows:
                plan_id = str(summary.get("PYFADM") or "").strip()
                if not plan_id:
                    continue
                form = {"PYFADM": plan_id}
                details = self._post_rows(
                    page,
                    "/jwpubapp/modules/pyfa/qxpyfacx.do",
                    "qxpyfacx",
                    form,
                )
                groups = self._post_rows(
                    page,
                    "/jwpubapp/modules/pyfa/kzcx.do",
                    "kzcx",
                    form,
                )
                courses = self._post_rows(
                    page,
                    "/jwpubapp/modules/pyfa/kzkccx.do",
                    "kzkccx",
                    form,
                )
                plans.append(
                    self._normalize_plan(
                        summary,
                        details[0] if details else {},
                        groups,
                        courses,
                        current_semester,
                        current_semester_label,
                        schedule_evidence=schedule_evidence,
                    )
                )

            self._save_cookies(page)
            result = {
                "status": "completed" if plans else "empty",
                "message": "已从 eHall 同步个人培养方案。"
                if plans
                else "eHall 当前账号没有可用的个人培养方案。",
                "source": self._source(),
                "fetchedAt": datetime.now(timezone.utc).isoformat(),
                "plans": plans,
            }
            if plans:
                self._write_json_atomic(self.cache_file, {"version": 1, **result})
            return result

    def get(self, *, refresh: bool = False) -> dict[str, Any]:
        cached = self._load_cache()
        if cached is not None and not refresh:
            return {
                **cached,
                "status": "cached",
                "message": "已从本地缓存读取个人培养方案。",
                "cacheFile": str(self.cache_file.resolve()),
            }

        result = self._fetch_remote()
        if result.get("status") == "auth_required" and cached is not None:
            return {
                **cached,
                "status": "cached",
                "message": "eHall 登录已失效，当前显示上次同步的培养方案。",
                "cacheFallback": True,
                "cacheFile": str(self.cache_file.resolve()),
            }
        return result

    @staticmethod
    def _audit_course_item(
        course: dict[str, Any], *, semester: str = "", status: str = ""
    ) -> dict[str, Any]:
        return {
            "id": str(course.get("id") or ""),
            "code": str(course.get("code") or ""),
            "name": str(course.get("name") or ""),
            "group": str(course.get("group") or ""),
            "nature": str(course.get("nature") or ""),
            "credits": course.get("credits", 0),
            "semester": semester or str(course.get("semester") or ""),
            "status": status or str(course.get("status") or "unknown"),
            "choiceNote": str(course.get("choiceNote") or ""),
            "source": str(course.get("source") or "plan"),
            "classificationSource": str(
                course.get("classificationSource") or "ehall"
            ),
            "isGeneralElective": bool(course.get("isGeneralElective")),
        }

    def audit(
        self, *, refresh: bool = False, plan_id: str = ""
    ) -> dict[str, Any]:
        result = self.get(refresh=refresh)
        plans = [plan for plan in result.get("plans") or [] if isinstance(plan, dict)]
        if not plans:
            return {
                "status": result.get("status", "empty"),
                "message": result.get("message") or "没有可审计的个人培养方案。",
                "source": result.get("source") or self._source(),
                "plans": [],
            }
        plan = next(
            (item for item in plans if str(item.get("id") or "") == plan_id),
            plans[0],
        )
        current_semester = str(plan.get("currentSemester") or "")
        completed: list[dict[str, Any]] = []
        studying: list[dict[str, Any]] = []
        missing_past: list[dict[str, Any]] = []
        missing_current: list[dict[str, Any]] = []
        future: list[dict[str, Any]] = []
        schedule_only: list[dict[str, Any]] = []
        choice_groups: list[dict[str, Any]] = []
        for course in plan.get("courses") or []:
            if not isinstance(course, dict):
                continue
            if course.get("source") == "schedule":
                schedule_only.append(self._audit_course_item(course))
                continue
            if course.get("options"):
                choice_groups.append(
                    {
                        **self._audit_course_item(course),
                        "options": course.get("options") or [],
                    }
                )
            options = course.get("semesterOptions") or [
                {
                    "value": str(course.get("semester") or ""),
                    "status": str(course.get("status") or "unknown"),
                }
            ]
            for option in options:
                semester = str(option.get("value") or "")
                status = str(option.get("status") or course.get("status") or "unknown")
                item = self._audit_course_item(
                    course, semester=semester, status=status
                )
                if status == "completed":
                    completed.append(item)
                elif status == "studying":
                    studying.append(item)
                elif status == "not_taken" and semester < current_semester:
                    missing_past.append(item)
                elif status == "not_taken" and semester == current_semester:
                    missing_current.append(item)
                elif status == "upcoming":
                    future.append(item)

        def credit_total(items: list[dict[str, Any]]) -> int | float:
            return self._display_number(
                sum(self._number(item.get("credits")) for item in items)
            )

        evidence_courses = completed + studying + schedule_only
        plan_status_courses = (
            completed + studying + missing_past + missing_current + future
        )
        credits_by_status = {
            "completedByScheduleEvidence": credit_total(completed),
            "studying": credit_total(studying),
            "missingPast": credit_total(missing_past),
            "missingCurrent": credit_total(missing_current),
            "future": credit_total(future),
            "scheduleOnly": credit_total(schedule_only),
            "allVisiblePlanItems": credit_total(plan_status_courses),
            "allScheduleEvidence": credit_total(evidence_courses),
        }
        credits_by_nature: dict[str, int | float] = {}
        for item in evidence_courses:
            nature = str(item.get("nature") or "未标注")
            credits_by_nature[nature] = self._display_number(
                self._number(credits_by_nature.get(nature))
                + self._number(item.get("credits"))
            )

        attention_points: list[dict[str, Any]] = []
        past_required = [item for item in missing_past if item["nature"] == "必修"]
        current_required = [
            item for item in missing_current if item["nature"] == "必修"
        ]
        if past_required:
            attention_points.append(
                {
                    "type": "past_required_without_schedule_evidence",
                    "title": f"{len(past_required)} 门往期必修课没有匹配到课表记录",
                    "courses": past_required,
                    "meaning": "仅表示本地历年课表中未找到匹配记录，不等同于确定未通过。",
                }
            )
        if current_required:
            attention_points.append(
                {
                    "type": "current_required_without_schedule_evidence",
                    "title": f"{len(current_required)} 门本学期必修课未出现在当前课表",
                    "courses": current_required,
                    "meaning": "可能是未选、免修、替代或课表缓存差异，需要结合成绩单和选课结果判断。",
                }
            )
        if choice_groups:
            attention_points.append(
                {
                    "type": "choice_groups",
                    "title": f"培养方案中有 {len(choice_groups)} 个选择组",
                    "count": len(choice_groups),
                    "meaning": "A/B 分层、二选一或四选一应按组判断，不能把每个备选项都当作必须修读。",
                }
            )
        if schedule_only:
            attention_points.append(
                {
                    "type": "schedule_only_courses",
                    "title": f"课表中有 {len(schedule_only)} 门课程未直接匹配培养方案条目",
                    "courses": schedule_only,
                    "meaning": "其学分归属需要结合 eHall 显式性质、课程认定或教务处规则判断。",
                }
            )

        evidence_semesters = sorted(
            {
                item["semester"]
                for item in completed + studying + schedule_only
                if item["semester"]
            }
        )
        return {
            "status": "completed",
            "message": "已依据 eHall 个人培养方案与本地历年课表缓存完成检查。",
            "source": result.get("source") or self._source(),
            "plan": {
                key: plan.get(key)
                for key in (
                    "id",
                    "title",
                    "major",
                    "grade",
                    "department",
                    "track",
                    "requiredCredits",
                    "completedCredits",
                    "progress",
                    "currentSemester",
                    "currentSemesterLabel",
                )
            },
            "counts": {
                "completedByScheduleEvidence": len(completed),
                "studying": len(studying),
                "missingPast": len(missing_past),
                "missingCurrent": len(missing_current),
                "future": len(future),
                "scheduleOnly": len(schedule_only),
                "choiceGroups": len(choice_groups),
            },
            "creditTotals": {
                "officialRequired": plan.get("requiredCredits"),
                "officialCompleted": plan.get("completedCredits"),
                "byStatus": credits_by_status,
                "byNatureInScheduleEvidence": credits_by_nature,
            },
            "attentionPoints": attention_points,
            "studyRequirements": plan.get("studyRequirements") or [],
            "evidence": {
                "scheduleSemesters": evidence_semesters,
                "completionMeaning": "课程曾出现在对应历史课表中",
            },
            "limitations": [
                "课表记录不能证明课程已通过或学分已经获得。",
                "最终毕业资格必须以成绩单、学分认定结果和教务处审核为准。",
                "课表未提供显式性质时，方案外课程分类会标明识别来源，不将推断伪装成官方结论。",
            ],
            "completedCourses": completed,
            "studyingCourses": studying,
            "missingPastCourses": missing_past,
            "missingCurrentCourses": missing_current,
            "futureCourses": future,
            "scheduleOnlyCourses": schedule_only,
            "choiceGroups": choice_groups,
        }

    def search(self, _major: str = "") -> dict[str, Any]:
        """Compatibility wrapper for the original CLI action name."""
        return self.get()

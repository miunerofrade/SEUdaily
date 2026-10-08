from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .campus_auth import CampusAuthError, CampusSession
from . import training_plan_normalize, training_plan_evidence
from .campus_api import CampusAPIError, dataset_rows, post_rows
from .json_store import write_json_atomic
from .cancellation import TaskCancelledError


from .campus_endpoints import (
    DEFAULT_PLAN_APP_ID,
    DEFAULT_PLAN_LAUNCH_URL,
    PLAN_APP_PATH,
    PLAN_API_ROOT,
    PLAN_ENDPOINTS,
)


class TrainingPlanService:
    """Read the signed-in student's official undergraduate plan from eHall."""

    def __init__(
        self,
        *,
        cookie_file: str | Path = ".seudaily/ehall-cookies.json",
        cache_file: str | Path = ".seudaily/training-plan.json",
        schedule_cache_file: str | Path = ".seudaily/schedule.json",
        override_file: str | Path = ".seudaily/training-plan-user.json",
        launch_url: str = DEFAULT_PLAN_LAUNCH_URL,
    ) -> None:
        self.cookie_file = Path(cookie_file)
        self.cache_file = Path(cache_file)
        self.schedule_cache_file = Path(schedule_cache_file)
        self.override_file = Path(override_file)
        self.launch_url = launch_url

    @staticmethod
    def _source() -> dict[str, Any]:
        return {
            "title": "eHall 个人方案查询",
            "url": DEFAULT_PLAN_LAUNCH_URL,
            "path": ["办事服务", "教务处", "方案中心", "个人方案查询"],
            "source": "东南大学网上办事服务大厅",
        }

    _write_json_atomic = staticmethod(write_json_atomic)

    _normalize_course_name = staticmethod(training_plan_evidence._normalize_course_name)

    _schedule_index = training_plan_evidence._schedule_index

    _schedule_context = training_plan_evidence._schedule_context

    _current_semester = training_plan_evidence._current_semester

    _semester_values = staticmethod(training_plan_evidence._semester_values)

    _display_semester_label = classmethod(
        training_plan_evidence._display_semester_label
    )

    _semester_options = classmethod(training_plan_evidence._semester_options)

    _course_matches_schedule = classmethod(
        training_plan_evidence._course_matches_schedule
    )

    _course_status = classmethod(training_plan_evidence._course_status)

    _apply_course_evidence = classmethod(training_plan_evidence._apply_course_evidence)

    def _load_overrides(self) -> dict[str, Any]:
        try:
            payload = json.loads(self.override_file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {"version": 1, "courseOverrides": {}}
        if payload.get("version") != 1 or not isinstance(
            payload.get("courseOverrides"), dict
        ):
            return {"version": 1, "courseOverrides": {}}
        return payload

    _course_override_key = classmethod(training_plan_evidence._course_override_key)

    _aggregate_course_status = classmethod(
        training_plan_evidence._aggregate_course_status
    )

    _apply_default_credits = classmethod(training_plan_evidence._apply_default_credits)

    def _apply_user_overrides(self, plan: dict[str, Any]) -> None:
        plan_overrides = (
            self._load_overrides()
            .get("courseOverrides", {})
            .get(str(plan.get("id") or ""), {})
        )
        if not isinstance(plan_overrides, dict):
            plan_overrides = {}
        for course in plan.get("courses") or []:
            if not isinstance(course, dict):
                continue
            self._apply_default_credits(course)
            course.pop("manualStatus", None)
            options = course.get("semesterOptions") or []
            if not options:
                options = [
                    {
                        "value": "unassigned",
                        "label": "未安排学期",
                        "status": str(course.get("status") or "unscheduled"),
                    }
                ]
                course["semesterOptions"] = options
            manually_changed = False
            for option in options:
                if not isinstance(option, dict):
                    continue
                option.pop("manualStatus", None)
                option["autoStatus"] = str(option.get("status") or "unknown")
                override = plan_overrides.get(
                    self._course_override_key(
                        course, str(option.get("value") or "unassigned")
                    )
                )
                if override in {"completed", "studying", "not_taken"}:
                    option["status"] = override
                    option["manualStatus"] = True
                    manually_changed = True
            course["status"] = self._aggregate_course_status(course)
            if manually_changed:
                course["manualStatus"] = True

    _recompute_plan_credits = classmethod(
        training_plan_evidence._recompute_plan_credits
    )

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
            self._apply_user_overrides(plan)
            self._recompute_plan_credits(plan)
            self._sort_courses(plan.get("courses") or [])
            plan["courseCount"] = len(plan.get("courses") or [])
        return cached

    _number = staticmethod(training_plan_normalize._number)

    _display_number = staticmethod(training_plan_normalize._display_number)

    _rows = staticmethod(dataset_rows)

    _normalize_course = classmethod(training_plan_normalize._normalize_course)

    _is_general_elective = staticmethod(training_plan_normalize._is_general_elective)

    _merge_semester_options = classmethod(
        training_plan_normalize._merge_semester_options
    )

    _merge_course_options = classmethod(training_plan_normalize._merge_course_options)

    _merge_choices = classmethod(training_plan_normalize._merge_choices)

    _study_requirements = classmethod(training_plan_normalize._study_requirements)

    _schedule_course_classification = classmethod(
        training_plan_normalize._schedule_course_classification
    )

    _append_schedule_only_courses = classmethod(
        training_plan_normalize._append_schedule_only_courses
    )

    _sort_courses = staticmethod(training_plan_normalize._sort_courses)

    _normalize_plan = classmethod(training_plan_normalize._normalize_plan)

    @staticmethod
    def _post_rows(
        page, path: str, dataset: str, form: dict[str, str]
    ) -> list[dict[str, Any]]:
        return post_rows(
            page,
            f"{PLAN_API_ROOT}{path}",
            dataset,
            form,
            headers={"Referer": page.url, "X-Requested-With": "XMLHttpRequest"},
        )

    def _fetch_remote(self) -> dict[str, Any]:
        with CampusSession(self.cookie_file) as session:
            try:
                session.ensure_authenticated(self.launch_url)
                return self._fetch_authenticated(session)
            except CampusAuthError as error:
                return {**error.result(), "source": self._source(), "plans": []}

    def _fetch_authenticated(self, page) -> dict[str, Any]:
        plan_rows = self._post_rows(
            page,
            PLAN_ENDPOINTS["grpyfacx"],
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
                raise CampusAPIError("个人方案记录缺少 PYFADM，学校接口可能发生变化")
            form = {"PYFADM": plan_id}
            details = self._post_rows(
                page,
                PLAN_ENDPOINTS["qxpyfacx"],
                "qxpyfacx",
                form,
            )
            groups = self._post_rows(
                page,
                PLAN_ENDPOINTS["kzcx"],
                "kzcx",
                form,
            )
            courses = self._post_rows(
                page,
                PLAN_ENDPOINTS["kzkccx"],
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

        for plan in plans:
            self._apply_user_overrides(plan)
            self._recompute_plan_credits(plan)

        page.save()
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

        try:
            result = self._fetch_remote()
        except TaskCancelledError:
            raise
        except Exception as error:
            if cached is None:
                raise
            return {
                **cached,
                "status": "cached",
                "cacheFallback": True,
                "syncFailure": str(error),
                "message": "培养方案同步失败，已保留上次缓存。",
            }
        if result.get("status") == "auth_required" and cached is not None:
            return {
                **cached,
                "status": "cached",
                "message": "eHall 登录已失效，当前显示上次同步的培养方案。",
                "cacheFallback": True,
                "cacheFile": str(self.cache_file.resolve()),
            }
        return result

    def save_course_override(
        self,
        *,
        plan_id: str,
        course_id: str,
        semester: str,
        status: str,
    ) -> dict[str, Any]:
        allowed = {"auto", "completed", "studying", "not_taken"}
        if status not in allowed:
            raise ValueError("课程状态只能设为自动、已完成、学习中或未修读")
        current = self.get(refresh=False)
        plans = [plan for plan in current.get("plans") or [] if isinstance(plan, dict)]
        plan = next(
            (item for item in plans if str(item.get("id") or "") == plan_id),
            None,
        )
        if plan is None:
            raise ValueError("培养方案不存在")
        course = next(
            (
                item
                for item in plan.get("courses") or []
                if isinstance(item, dict)
                and course_id
                in {
                    str(item.get("id") or ""),
                    str(item.get("code") or ""),
                    str(item.get("name") or ""),
                }
            ),
            None,
        )
        if course is None:
            raise ValueError("课程不存在")
        normalized_semester = semester or "unassigned"
        valid_semesters = {
            str(option.get("value") or "unassigned")
            for option in course.get("semesterOptions") or []
            if isinstance(option, dict)
        } or {"unassigned"}
        if normalized_semester not in valid_semesters:
            raise ValueError("课程学期不存在")

        payload = self._load_overrides()
        all_overrides = payload.setdefault("courseOverrides", {})
        plan_overrides = all_overrides.setdefault(plan_id, {})
        key = self._course_override_key(course, normalized_semester)
        if status == "auto":
            plan_overrides.pop(key, None)
        else:
            plan_overrides[key] = status
        if not plan_overrides:
            all_overrides.pop(plan_id, None)
        self._write_json_atomic(self.override_file, payload)

        updated = self.get(refresh=False)
        return {
            **updated,
            "status": "completed",
            "message": "课程修读状态已恢复自动判断。"
            if status == "auto"
            else "课程修读状态已保存。",
            "overrideFile": str(self.override_file.resolve()),
        }

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
            "classificationSource": str(course.get("classificationSource") or "ehall"),
            "isGeneralElective": bool(course.get("isGeneralElective")),
        }

    def audit(self, *, refresh: bool = False, plan_id: str = "") -> dict[str, Any]:
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
                item = self._audit_course_item(course, semester=semester, status=status)
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

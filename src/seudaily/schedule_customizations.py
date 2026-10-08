"""Local timetable edits and overlays."""
from __future__ import annotations

import hashlib
import json
import re
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Any

def _source_key(course: dict[str, Any]) -> str:
    """Identity for user overlays that excludes mutable room/week metadata."""
    identity = {
        key: course.get(key)
        for key in (
            "courseCode",
            "courseName",
            "teacherName",
            "weekday",
            "startPeriod",
            "endPeriod",
        )
    }
    encoded = json.dumps(
        identity, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return f"source-{hashlib.sha256(encoded).hexdigest()[:16]}"


def _default_customizations() -> dict[str, Any]:
    return {
        "version": 1,
        "semester": {"name": "", "startDate": "", "totalWeeks": 16},
        "overrides": {},
        "customCourses": [],
        "dateOverrides": [],
    }


def _load_customizations(self) -> dict[str, Any]:
    defaults = self._default_customizations()
    if not self.customization_file.exists():
        return defaults
    try:
        saved = json.loads(self.customization_file.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return defaults
    if not isinstance(saved, dict) or saved.get("version") != 1:
        return defaults
    return {
        **defaults,
        **saved,
        "semester": {**defaults["semester"], **(saved.get("semester") or {})},
        "overrides": saved.get("overrides") if isinstance(saved.get("overrides"), dict) else {},
        "customCourses": saved.get("customCourses") if isinstance(saved.get("customCourses"), list) else [],
        "dateOverrides": saved.get("dateOverrides") if isinstance(saved.get("dateOverrides"), list) else [],
    }


def _valid_iso_date(value: Any, field: str, *, optional: bool = False) -> str:
    text = str(value or "").strip()
    if optional and not text:
        return ""
    try:
        date.fromisoformat(text)
    except ValueError as exc:
        raise ValueError(f"{field} 必须是 YYYY-MM-DD 日期") from exc
    return text


def _normalize_editable_course(course: dict[str, Any], *, custom: bool) -> dict[str, Any]:
    name = str(course.get("courseName") or "").strip()
    if not name:
        raise ValueError("courseName 不能为空")
    weekday = int(course.get("weekday") or 0)
    start = int(course.get("startPeriod") or 0)
    end = int(course.get("endPeriod") or start)
    if not 1 <= weekday <= 7:
        raise ValueError("weekday 必须在 1 到 7 之间")
    if not 1 <= start <= end <= 13:
        raise ValueError("课程节次必须在 1 到 13 之间")
    weeks = sorted({int(item) for item in course.get("weeks") or [] if int(item) > 0})
    normalized = {
        "courseName": name,
        "teacherName": str(course.get("teacherName") or "").strip(),
        "weekday": weekday,
        "startPeriod": start,
        "endPeriod": end,
        "weeklyPeriods": list(range(start, end + 1)),
        "weeks": weeks,
        "classroom": str(course.get("classroom") or "").strip(),
        "courseCode": str(course.get("courseCode") or "").strip(),
    }
    if custom:
        custom_id = str(course.get("customId") or "").strip()
        if not re.fullmatch(r"[A-Za-z0-9._-]{1,128}", custom_id):
            raise ValueError("customId 缺失或格式无效")
        normalized["customId"] = custom_id
    return normalized


def save_customizations(self, payload: dict[str, Any]) -> dict[str, Any]:
    current = self._load_customizations()
    semester_input = payload.get("semester", current["semester"])
    if not isinstance(semester_input, dict):
        raise ValueError("semester 必须是对象")
    total_weeks = int(semester_input.get("totalWeeks", 16))
    if not 1 <= total_weeks <= 30:
        raise ValueError("totalWeeks 必须在 1 到 30 之间")
    semester = {
        "name": str(semester_input.get("name") or "").strip(),
        "startDate": self._valid_iso_date(
            semester_input.get("startDate"), "semester.startDate", optional=True
        ),
        "totalWeeks": total_weeks,
    }

    overrides_input = payload.get("overrides", current["overrides"])
    if not isinstance(overrides_input, dict):
        raise ValueError("overrides 必须是对象")
    overrides: dict[str, Any] = {}
    allowed = {
        "courseName", "teacherName", "weekday", "startPeriod", "endPeriod",
        "weeks", "classroom", "courseCode", "hidden",
    }
    for source_key, raw in overrides_input.items():
        if not str(source_key).startswith("source-") or not isinstance(raw, dict):
            raise ValueError("overrides 包含无效的课程标识")
        overrides[str(source_key)] = {key: value for key, value in raw.items() if key in allowed}

    custom_input = payload.get("customCourses", current["customCourses"])
    if not isinstance(custom_input, list):
        raise ValueError("customCourses 必须是数组")
    custom_courses = [
        self._normalize_editable_course(item, custom=True)
        for item in custom_input if isinstance(item, dict)
    ]

    date_input = payload.get("dateOverrides", current["dateOverrides"])
    if not isinstance(date_input, list):
        raise ValueError("dateOverrides 必须是数组")
    date_overrides: list[dict[str, Any]] = []
    for raw in date_input:
        if not isinstance(raw, dict):
            continue
        entry_id = str(raw.get("id") or "").strip()
        action = str(raw.get("action") or "add")
        if not re.fullmatch(r"[A-Za-z0-9._-]{1,128}", entry_id):
            raise ValueError("dateOverrides.id 缺失或格式无效")
        if action not in {"add", "replace", "cancel"}:
            raise ValueError("dateOverrides.action 无效")
        entry: dict[str, Any] = {
            "id": entry_id,
            "date": self._valid_iso_date(raw.get("date"), "dateOverrides.date"),
            "action": action,
        }
        if raw.get("targetSourceKey"):
            entry["targetSourceKey"] = str(raw["targetSourceKey"])
        if action in {"add", "replace"}:
            entry["course"] = self._normalize_editable_course(
                {**(raw.get("course") or {}), "customId": entry_id}, custom=True
            )
        date_overrides.append(entry)

    saved = {
        "version": 1,
        "semester": semester,
        "overrides": overrides,
        "customCourses": custom_courses,
        "dateOverrides": date_overrides,
        "updatedAt": datetime.now(timezone.utc).isoformat(),
    }
    self._write_json_atomic(self.customization_file, saved)
    return {"status": "completed", "customizations": saved}


def apply_agent_change(self, payload: dict[str, Any]) -> dict[str, Any]:
    operation = str(payload.get("operation") or "").strip()
    current = self._load_customizations()
    if operation == "semester":
        changes = payload.get("semester")
        if not isinstance(changes, dict) or not changes or set(changes) - {"name", "startDate", "totalWeeks"}:
            raise ValueError("学期设置需提供 name、startDate 或 totalWeeks")
        result = self.save_customizations({**current, "semester": {**current["semester"], **changes}})
        return {**result, "message": "学期设置已更新。", "change": {"operation": operation, "semester": changes}}
    if operation in {"add_once", "cancel_once"}:
        target_date = self._valid_iso_date(payload.get("date"), "date")
        identity = f"agent-{uuid.uuid4()}"
        if operation == "add_once":
            raw = payload.get("course")
            if not isinstance(raw, dict):
                raise ValueError("单日增课缺少 course")
            course = self._normalize_editable_course({**raw, "customId":identity,"weekday":date.fromisoformat(target_date).isoweekday(),"weeks":[]}, custom=True)
            override = {"id":identity,"date":target_date,"action":"add","course":course}
        else:
            key = str(payload.get("sourceKey") or "")
            visible = self._filter_by_date(self._apply_customizations(self._load_cache() or {"courses": []}), target_date)
            if not key or not any(course.get("sourceKey") == key for course in visible.get("courses", [])):
                raise ValueError("要停课的课程不存在，请先读取本地课表")
            override = {"id":identity,"date":target_date,"action":"cancel","targetSourceKey":key}
        result = self.save_customizations({**current,"dateOverrides":[*current["dateOverrides"],override]})
        return {**result,"message":f"已更新 {target_date} 的单次课程。","change":{"operation":operation,"date":target_date}}
    if operation == "add":
        raw_course = payload.get("course")
        if not isinstance(raw_course, dict):
            raise ValueError("新增课表课程缺少 course 参数")
        custom_id = f"agent-{uuid.uuid4()}"
        normalized = self._normalize_editable_course(
            {**raw_course, "customId": custom_id}, custom=True
        )
        current["customCourses"] = [*current["customCourses"], normalized]
        result = self.save_customizations(current)
        return {
            **result,
            "message": f"已新增课表课程：{normalized['courseName']}",
            "change": {"operation": "add", "sourceKey": f"custom-{custom_id}", "course": normalized},
        }

    if operation == "update":
        source_key = str(payload.get("sourceKey") or "").strip()
        changes = payload.get("changes")
        if not source_key or not isinstance(changes, dict) or not changes:
            raise ValueError("修改课表课程需要 sourceKey 和 changes")
        allowed = {
            "courseName", "teacherName", "weekday", "startPeriod", "endPeriod",
            "weeks", "classroom", "courseCode",
        }
        unknown = set(changes) - allowed
        if unknown:
            raise ValueError(f"课表修改包含不支持的字段: {', '.join(sorted(unknown))}")
        if source_key.startswith("custom-"):
            custom_id = source_key.removeprefix("custom-")
            found = False
            updated_courses: list[dict[str, Any]] = []
            for course in current["customCourses"]:
                if str(course.get("customId") or "") != custom_id:
                    updated_courses.append(course)
                    continue
                updated_courses.append(
                    self._normalize_editable_course(
                        {**course, **changes, "customId": custom_id}, custom=True
                    )
                )
                found = True
            if not found:
                raise ValueError("要修改的自定义课程不存在")
            current["customCourses"] = updated_courses
        else:
            if not source_key.startswith("source-"):
                raise ValueError("sourceKey 格式无效")
            cached = self._load_cache()
            if cached is None:
                raise ValueError("当前课表缓存不存在，请先读取课表")
            visible = self._apply_customizations(cached)
            target = next(
                (
                    course
                    for course in visible.get("courses") or []
                    if course.get("sourceKey") == source_key
                ),
                None,
            )
            if target is None:
                raise ValueError("要修改的课表课程不存在，请重新读取课表")
            normalized = self._normalize_editable_course(
                {**target, **changes}, custom=False
            )
            changes = {key: normalized[key] for key in changes}
            current["overrides"] = {
                **current["overrides"],
                source_key: {**current["overrides"].get(source_key, {}), **changes},
            }
        result = self.save_customizations(current)
        return {
            **result,
            "message": "课表课程信息已修改。",
            "change": {"operation": "update", "sourceKey": source_key, "changes": changes},
        }

    if operation == "move":
        source_key = str(payload.get("sourceKey") or "").strip()
        from_date = self._valid_iso_date(payload.get("fromDate"), "fromDate")
        to_date = self._valid_iso_date(payload.get("toDate"), "toDate")
        changes = payload.get("changes") or {}
        if not source_key or not isinstance(changes, dict):
            raise ValueError("移动单次课程需要 sourceKey、fromDate 和 toDate")
        cached = self._load_cache()
        visible = self._filter_by_date(self._apply_customizations(cached or {"courses": []}), from_date)
        target = next(
            (
                course
                for course in visible.get("courses") or []
                if course.get("sourceKey") == source_key
            ),
            None,
        )
        if target is None:
            raise ValueError("要移动的课表课程不存在，请重新读取课表")
        moved_id = f"agent-{uuid.uuid4()}"
        moved = self._normalize_editable_course(
            {
                **target,
                **changes,
                "weekday": date.fromisoformat(to_date).isoweekday(),
                "weeks": [],
                "customId": moved_id,
            },
            custom=True,
        )
        current["dateOverrides"] = [
            *current["dateOverrides"],
            {
                "id": f"{moved_id}-cancel",
                "date": from_date,
                "action": "cancel",
                "targetSourceKey": source_key,
            },
            {
                "id": moved_id,
                "date": to_date,
                "action": "add",
                "course": moved,
            },
        ]
        result = self.save_customizations(current)
        return {
            **result,
            "message": f"已将 {target.get('courseName') or '课程'} 从 {from_date} 移至 {to_date}。",
            "change": {
                "operation": "move",
                "sourceKey": source_key,
                "fromDate": from_date,
                "toDate": to_date,
                "course": moved,
            },
        }

    raise ValueError("课表操作仅支持 semester、add、update、move、add_once 或 cancel_once")


def _apply_customizations(self, result: dict[str, Any]) -> dict[str, Any]:
    customizations = self._load_customizations()
    merged: list[dict[str, Any]] = []
    for raw in result.get("courses") or []:
        course = dict(raw)
        source_key = self._source_key(course)
        override = customizations["overrides"].get(source_key, {})
        if override.get("hidden"):
            continue
        course.update({key: value for key, value in override.items() if key != "hidden"})
        start = int(course.get("startPeriod") or (course.get("weeklyPeriods") or [1])[0])
        end = int(course.get("endPeriod") or (course.get("weeklyPeriods") or [start])[-1])
        course["startPeriod"] = start
        course["endPeriod"] = end
        course["weeklyPeriods"] = list(range(start, end + 1))
        course["sourceKey"] = source_key
        course["source"] = "remote"
        merged.append(course)
    for raw in customizations["customCourses"]:
        course = dict(raw)
        course["scheduleId"] = f"custom-{course['customId']}"
        course["sourceKey"] = course["scheduleId"]
        course["source"] = "custom"
        merged.append(course)
    return {
        **result,
        "count": len(merged),
        "courses": sorted(
            merged,
            key=lambda item: (
                item.get("weekday") is None,
                item.get("weekday") or 0,
                item.get("startPeriod") or 0,
                item.get("courseName") or "",
            ),
        ),
        "customizations": customizations,
    }


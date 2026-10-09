"""Local operation contract shared with TypeScript; business rules remain explicit."""
from __future__ import annotations

import copy
import json
from datetime import date
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator
from .notice_sources import source_config

CONTRACT = json.loads(Path(__file__).with_name("local_operations.json").read_text(encoding="utf-8"))
OPERATIONS = CONTRACT["operations"]
VALIDATORS = {key: Draft202012Validator(schema) for key, schema in CONTRACT["schemas"].items()}


def _normalize(value: Any, schema: dict) -> Any:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, list):
        return [_normalize(entry, schema.get("items", {})) for entry in value]
    if isinstance(value, dict):
        properties = schema.get("properties", {})
        result = {key: _normalize(entry, properties.get(key, {})) for key, entry in value.items()}
        for key, definition in properties.items():
            if key not in result and "default" in definition:
                result[key] = copy.deepcopy(definition["default"])
        if "weeks" in result:
            result["weeks"] = sorted(set(result["weeks"]))
        return result
    return value


def validate_parameters(payload_kind: str, value: Any, *, require_course: bool = True) -> dict:
    error = next(VALIDATORS[payload_kind].iter_errors(value), None)
    if error:
        field = ".".join(str(part) for part in error.path) or payload_kind
        # Do not include user text or credentials in diagnostic messages.
        raise ValueError(f"{field} 不符合本地操作参数约束（{error.validator}）")
    normalized = _normalize(value, CONTRACT["schemas"][payload_kind])
    if payload_kind == "focus":
        if not normalized["title"] or not normalized["description"]:
            raise ValueError("关注名称和描述不能为空")
        if normalized["kind"] == "notice":
            config = source_config(normalized.get("source", "jwc"))
            if any(category not in config.categories for category in normalized.get("categories", [])):
                raise ValueError("不支持的通知栏目")
        elif require_course and not normalized.get("courseName"):
            raise ValueError("课程关注必须提供课程名称")
    else:
        dates = {key: normalized[key] for key in ("date", "fromDate", "toDate") if key in normalized}
        if "startDate" in normalized.get("semester", {}):
            dates["semester.startDate"] = normalized["semester"]["startDate"]
        for field, value in dates.items():
            try:
                if date.fromisoformat(value).isoformat() != value:
                    raise ValueError()
            except ValueError as error:
                raise ValueError(f"{field} 日期不存在") from error
        for key in ("course", "changes"):
            course = normalized.get(key, {})
            if "courseName" in course and not course["courseName"]:
                raise ValueError("课程名称不能为空")
            if "startPeriod" in course and "endPeriod" in course and course["endPeriod"] < course["startPeriod"]:
                raise ValueError("endPeriod 不能早于 startPeriod")
    return normalized


def validate_proposal(value: Any) -> dict:
    if not isinstance(value, dict) or set(value) - {"kind", "mode", "focus", "schedule"}:
        raise ValueError("本地操作格式无效")
    kind = value.get("kind")
    if not isinstance(kind, str) or kind not in OPERATIONS:
        raise ValueError("未知本地操作")
    mode = value.get("mode", "preview")
    if mode not in {"preview", "apply"}:
        raise ValueError("本地操作模式无效")
    definition = OPERATIONS[kind]
    payload_kind = definition["payload"]
    if payload_kind not in value or any(key in value for key in {"focus", "schedule"} - {payload_kind}):
        raise ValueError("本地操作参数不匹配")
    payload = validate_parameters(payload_kind, value[payload_kind])
    for key in definition["required"]:
        if key not in payload:
            raise ValueError(f"缺少 {key}")
    if kind == "add_schedule" and (not payload["course"].get("weekday") or not payload["course"]["weeks"]):
        raise ValueError("周期课程需提供 weekday 和 weeks")
    return {"kind": kind, "mode": mode, payload_kind: payload}


def schedule_payload(value: dict) -> dict:
    operation = value.get("operation")
    kind = next((key for key, definition in OPERATIONS.items() if definition.get("operation") == operation), None)
    if not kind:
        raise ValueError("未知课表操作")
    # Transport configuration belongs to the service factory, never to editable fields.
    proposal = validate_proposal({"kind": kind, "mode": "apply", "schedule": {key: entry for key, entry in value.items() if key != "operation"}})
    return {**proposal["schedule"], "operation": operation}


def default_summary(action: str, operation: str | None = None) -> str | None:
    return next((entry["summary"] for entry in OPERATIONS.values() if entry["action"] == action and (not operation or entry.get("operation") == operation)), None)

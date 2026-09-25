from __future__ import annotations

import json
import os
import re
import uuid
from pathlib import Path
from typing import Any


_SUCCESS_STATUSES = {
    "authorized",
    "cached",
    "completed",
    "completed_without_artifact",
    "empty",
    "found",
    "fresh",
    "scheduled",
}
_WAITING_STATUSES = {"captcha_required", "credentials_missing"}
_AUTH_STATUSES = {"auth_required"}


def _runtime_root() -> Path:
    project_root = Path(os.getenv("CVSTREAM_PROJECT_ROOT") or os.getcwd()).resolve()
    return project_root / ".cvstream"


def _safe_task_id(value: str | None) -> str:
    if value and re.fullmatch(r"[A-Za-z0-9._-]{1,128}", value):
        return value
    return f"task-{uuid.uuid4()}"


def _artifact_type(path: str, kind: str | None = None) -> str:
    lowered = path.lower()
    if kind == "transcript" or lowered.endswith(".txt"):
        return "subtitle"
    if kind == "slides" or lowered.endswith(".pdf"):
        return "slides"
    if lowered.endswith((".wav", ".mp3", ".m4a")):
        return "audio"
    if lowered.endswith((".mp4", ".mkv", ".webm")):
        return "video"
    if lowered.endswith(".md"):
        return "note"
    return "snapshot"


def _artifact(path: str, *, kind: str | None = None, size: int | None = None) -> dict[str, Any]:
    resolved = str(Path(path).resolve())
    item: dict[str, Any] = {
        "id": f"artifact:{uuid.uuid5(uuid.NAMESPACE_URL, resolved)}",
        "type": _artifact_type(resolved, kind),
        "path": resolved,
    }
    if size is not None:
        item["sizeBytes"] = size
    return item


def _collect_artifacts(result: dict[str, Any]) -> list[dict[str, Any]]:
    collected: list[dict[str, Any]] = []
    for raw in result.get("artifacts") or []:
        if isinstance(raw, dict) and raw.get("path"):
            collected.append(
                _artifact(raw["path"], kind=raw.get("kind"), size=raw.get("size"))
            )
    for key in ("transcriptPath", "pdfPath", "notePath"):
        value = result.get(key)
        if isinstance(value, str) and value:
            collected.append(_artifact(value))
    unique: dict[str, dict[str, Any]] = {item["path"]: item for item in collected}
    return list(unique.values())


def _web_citation(article: dict[str, Any]) -> dict[str, Any] | None:
    article_id = article.get("id")
    title = article.get("title")
    if not article_id or not title:
        return None
    citation: dict[str, Any] = {
        "id": str(article_id),
        "type": "web",
        "title": str(title),
    }
    for source, target in (
        ("url", "url"),
        ("publishedAt", "publishedAt"),
        ("contentHash", "contentHash"),
    ):
        if article.get(source):
            citation[target] = article[source]
    return citation


def _collect_citations(
    action: str, result: dict[str, Any], artifacts: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    citations: list[dict[str, Any]] = []
    candidates: list[dict[str, Any]] = []
    if isinstance(result.get("article"), dict):
        candidates.append(result["article"])
    candidates.extend(item for item in result.get("results") or [] if isinstance(item, dict))
    for candidate in candidates:
        citation = _web_citation(candidate)
        if citation:
            citations.append(citation)

    source_paths = result.get("sources") or []
    for index, path in enumerate(source_paths, start=1):
        if not isinstance(path, str):
            continue
        citation = {
            "id": f"S{index}",
            "type": "file" if path != "direct-content" else "snapshot",
            "title": Path(path).name if path != "direct-content" else "用户提供的内容",
        }
        if path != "direct-content":
            citation["localPath"] = str(Path(path).resolve())
        citations.append(citation)

    for artifact in artifacts:
        if artifact["type"] not in {"subtitle", "video", "slides", "note"}:
            continue
        citation_id = artifact["id"]
        if any(item["id"] == citation_id for item in citations):
            continue
        citations.append(
            {
                "id": citation_id,
                "type": "subtitle" if artifact["type"] == "subtitle" else "file",
                "title": Path(artifact["path"]).name,
                "localPath": artifact["path"],
            }
        )
    return citations


def _normalize_status(raw_status: Any) -> str:
    status = str(raw_status or "completed")
    if status in _AUTH_STATUSES:
        return "auth_required"
    if status in _WAITING_STATUSES:
        return "waiting_for_user"
    if status in {"partial"}:
        return "partial"
    if status in {"auth_cancelled", "cancelled"}:
        return "cancelled"
    if status in _SUCCESS_STATUSES or status.startswith("completed"):
        return "completed"
    return "failed"


def _summary(action: str, result: dict[str, Any], status: str, artifacts: list[dict[str, Any]]) -> str:
    message = result.get("message")
    if isinstance(message, str) and message.strip():
        return message.strip()
    if action.startswith("search-"):
        count = result.get("count")
        if not isinstance(count, int):
            count = len(result.get("results") or [])
        suffix = f" {result['hint']}" if result.get("hint") else ""
        return f"查询完成，返回 {count} 条结果。{suffix}"
    if action == "get-schedule":
        return f"课表读取完成，共 {result.get('count', len(result.get('courses') or []))} 门课程。"
    if action == "get-current-date":
        return f"当前日期为 {result.get('date', '')}（{result.get('weekdayName', '')}）。"
    if action.startswith("capture-"):
        return f"课程处理{('完成' if status == 'completed' else '未完成')}，生成 {len(artifacts)} 个产物。"
    if action == "summarize-course":
        return "课程总结已生成。" if status == "completed" else "课程总结生成失败。"
    return f"{action}：{status}。"


def _write_diagnostics(task_id: str, logs: list[Any], events: list[Any]) -> str | None:
    if not logs and not events:
        return None
    task_dir = _runtime_root() / "tasks" / task_id
    task_dir.mkdir(parents=True, exist_ok=True)
    target = task_dir / "diagnostics.json"
    target.write_text(
        json.dumps({"logs": logs, "events": events}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return str(target.resolve())


def _write_full_result(task_id: str, result: dict[str, Any]) -> str:
    task_dir = _runtime_root() / "tasks" / task_id
    task_dir.mkdir(parents=True, exist_ok=True)
    target = task_dir / "result.json"
    temporary = task_dir / "result.json.tmp"
    temporary.write_text(
        json.dumps(result, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    temporary.replace(target)
    return str(target.resolve())


def _compact_runtime_data(
    value: Any,
    depth: int = 0,
    *,
    preserve_list: bool = False,
    preserve_course_lists: bool = False,
) -> tuple[Any, bool]:
    if depth > 5:
        return "[内容层级过深，完整内容见 resultRef]", True
    if isinstance(value, str):
        if len(value) <= 6000:
            return value, False
        return value[:6000] + "…[已截断，完整内容见 resultRef]", True
    if isinstance(value, list):
        compacted: list[Any] = []
        items = value if preserve_list else value[:12]
        changed = not preserve_list and len(value) > 12
        for item in items:
            compact_item, item_changed = _compact_runtime_data(
                item,
                depth + 1,
                preserve_list=preserve_list,
                preserve_course_lists=preserve_course_lists,
            )
            compacted.append(compact_item)
            changed = changed or item_changed
        return compacted, changed
    if isinstance(value, dict):
        compacted_dict: dict[str, Any] = {}
        changed = False
        for key, item in value.items():
            compact_item, item_changed = _compact_runtime_data(
                item,
                depth + 1,
                preserve_list=preserve_list or (preserve_course_lists and key == "courses"),
                preserve_course_lists=preserve_course_lists,
            )
            compacted_dict[key] = compact_item
            changed = changed or item_changed
        return compacted_dict, changed
    return value, False


def _extract_diagnostics(value: Any, logs: list[Any], events: list[Any]) -> Any:
    if isinstance(value, list):
        return [_extract_diagnostics(item, logs, events) for item in value]
    if not isinstance(value, dict):
        return value
    cleaned: dict[str, Any] = {}
    for key, item in value.items():
        lowered = key.lower()
        if lowered in {"log", "logs"}:
            logs.extend(item if isinstance(item, list) else [item])
            continue
        if lowered in {"event", "events"}:
            events.extend(item if isinstance(item, list) else [item])
            continue
        if re.search(r"password|passwd|secret|api[_-]?key|cookie|authorization", key, re.I):
            cleaned[key] = "[REDACTED]"
            continue
        cleaned[key] = _extract_diagnostics(item, logs, events)
    return cleaned


def normalize_tool_result(
    action: str, raw_result: Any, *, requested_task_id: str | None = None
) -> dict[str, Any]:
    result = raw_result if isinstance(raw_result, dict) else {"value": raw_result}
    task_id = _safe_task_id(requested_task_id)
    logs: list[Any] = []
    events: list[Any] = []
    cleaned_result = _extract_diagnostics(result, logs, events)
    diagnostics_ref = _write_diagnostics(task_id, logs, events)

    data = {
        key: value
        for key, value in cleaned_result.items()
        if key not in {"artifacts", "warnings"}
    }
    artifacts = _collect_artifacts(result)
    citations = _collect_citations(action, result, artifacts)
    status = _normalize_status(result.get("status"))
    warnings = [str(item) for item in result.get("warnings") or []]
    full_result: dict[str, Any] = {
        "status": status,
        "taskId": task_id,
        "summary": _summary(action, result, status, artifacts),
        "data": data,
        "artifacts": artifacts,
        "citations": citations,
        "warnings": warnings,
        "metrics": {},
    }
    if diagnostics_ref:
        full_result["diagnosticsRef"] = diagnostics_ref

    result_ref = _write_full_result(task_id, full_result)
    compacted_data, was_compacted = _compact_runtime_data(
        data, preserve_course_lists=action == "get-schedule"
    )
    normalized = {
        **full_result,
        "data": compacted_data,
        "resultRef": result_ref,
    }
    if was_compacted:
        normalized["warnings"] = [
            *warnings,
            "工具结果已为对话上下文精简，完整清洗结果见 resultRef。",
        ]
    return normalized

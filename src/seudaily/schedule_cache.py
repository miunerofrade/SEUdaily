"""Timetable cache loading and compatibility migrations."""

from __future__ import annotations
from typing import Any
from pathlib import Path
import json
import re

SEMESTER_CODE_PATTERN = re.compile(r"^\d{4}-\d{4}-\d+$")


def _cache_file_for_semester(self, semester: str | None = None) -> Path:
    code = str(semester or "").strip()
    if not SEMESTER_CODE_PATTERN.fullmatch(code):
        return self.cache_file
    suffix = self.cache_file.suffix
    stem = self.cache_file.name[: -len(suffix)] if suffix else self.cache_file.name
    return self.cache_file.with_name(f"{stem}.{code}{suffix}")


def _write_schedule_cache(self, cache_file: Path, result: dict[str, Any]) -> None:
    """Every fetched semester has a named snapshot; primary remains current entry."""
    self._write_json_atomic(cache_file, result)
    semester = str(result.get("selectedSemester") or "").strip()
    if SEMESTER_CODE_PATTERN.fullmatch(semester):
        snapshot = self._cache_file_for_semester(semester)
        if snapshot != cache_file:
            self._write_json_atomic(snapshot, result)


def _load_cache_file(self, cache_file: Path) -> dict[str, Any] | None:
    if not cache_file.exists():
        return None
    try:
        cached = json.loads(cache_file.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if cached.get("version") not in {1, 2} or not isinstance(
        cached.get("courses"), list
    ):
        return None
    changed = cached.get("version") != 2
    if cache_file == self.cache_file and cached.get("selectedSemester"):
        if not cached.get("currentSemester"):
            cached["currentSemester"] = cached["selectedSemester"]
            changed = True
        if not cached.get("currentSemesterLabel") and cached.get(
            "selectedSemesterLabel"
        ):
            cached["currentSemesterLabel"] = cached["selectedSemesterLabel"]
            changed = True
    available = cached.get("availableSemesters")
    if isinstance(available, list):
        filtered_available = [
            {
                "value": str(item.get("value") or "").strip(),
                "label": str(item.get("label") or "").strip(),
            }
            for item in available
            if isinstance(item, dict)
            and SEMESTER_CODE_PATTERN.fullmatch(str(item.get("value") or "").strip())
        ]
        if filtered_available != available:
            cached["availableSemesters"] = filtered_available
            changed = True
    for course in cached["courses"]:
        if not course.get("scheduleId"):
            course["scheduleId"] = self._schedule_id(course)
            changed = True
    if changed:
        cached["version"] = 2
        self._write_json_atomic(cache_file, cached)
    return cached


def _load_cache(self, semester: str | None = None) -> dict[str, Any] | None:
    path = self._cache_file_for_semester(semester)
    cached = self._load_cache_file(path)
    if path != self.cache_file:
        current = self._load_cache_file(self.cache_file)
        # Current-semester syncs write the primary cache. It remains authoritative
        # after refresh, even when a prior read created a semester-specific copy.
        if current is not None and current.get("selectedSemester") == str(semester or "").strip():
            if cached != current:
                self._write_json_atomic(path, current)
            cached = current
    return cached


def _semester_cache_files(self) -> list[Path]:
    suffix = self.cache_file.suffix
    stem = self.cache_file.name[: -len(suffix)] if suffix else self.cache_file.name
    prefix = f"{stem}."
    files: list[Path] = []
    for path in self.cache_file.parent.glob(f"{prefix}*{suffix}"):
        name = path.name
        code = name[len(prefix) : -len(suffix) if suffix else None]
        if SEMESTER_CODE_PATTERN.fullmatch(code):
            files.append(path)
    return sorted(files)

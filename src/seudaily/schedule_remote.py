"""Remote timetable retrieval and semester selection."""

from __future__ import annotations
from typing import Any
from pathlib import Path
import json
from datetime import datetime, timezone
from .campus_auth import CampusAuthError, CampusSession
from .campus_api import CampusAPIError, post_rows
from .campus_endpoints import (
    DEFAULT_SCHEDULE_URL,
    SCHEDULE_DATA_URL,
    SCHEDULE_METADATA_ROOT,
)
from .campus_network import network_category
from .cancellation import TaskCancelledError
from .schedule_cache import SEMESTER_CODE_PATTERN


class _SchedulePageLoadTimeout(TimeoutError):
    """The timetable has not initialized its current semester yet."""


def _select_remote_semester(
    cls,
    page,
    semester: str | None,
    *,
    include_available_semesters: bool = False,
) -> dict[str, Any]:
    from playwright.sync_api import TimeoutError as PlaywrightTimeoutError

    label = page.locator("#dqxnxq2")
    try:
        page.wait_for_function(
            """
            () => /^\\d{4}-\\d{4}-\\d+$/.test(
              document.querySelector('#dqxnxq2')?.getAttribute('value') || ''
            )
            """,
            timeout=30000,
        )
        current_value = str(label.get_attribute("value") or "").strip()
        current_label = label.inner_text().strip()
    except PlaywrightTimeoutError as exc:
        raise _SchedulePageLoadTimeout("课表当前学期信息尚未加载完成") from exc
    requested = str(semester or "").strip()
    selection_is_current = not requested or cls._semester_matches(
        requested, value=current_value, label=current_label
    )
    if selection_is_current and not include_available_semesters:
        return {
            "found": True,
            "requestedSemester": semester,
            "currentSemester": current_value,
            "currentSemesterLabel": current_label,
            "selectedSemester": current_value,
            "selectedSemesterLabel": current_label,
            "availableSemesters": [],
        }

    page.locator("a[data-action='更改2']").click()
    dropdown = page.locator(".dropdowm-xnxqList2")
    dropdown.wait_for(state="visible", timeout=5000)
    items = dropdown.evaluate(
        """
        el => window.jQuery(el).jqxDropDownList('getItems')
          .map(item => ({label: item.label, value: item.value}))
          .filter(item => item.value)
        """
    )
    available = [
        {
            "value": str(item.get("value") or "").strip(),
            "label": str(item.get("label") or "").strip(),
        }
        for item in items
        if isinstance(item, dict)
        and SEMESTER_CODE_PATTERN.fullmatch(str(item.get("value") or "").strip())
    ]
    dialog = page.get_by_role("dialog").filter(has_text="更改学年学期").last
    if selection_is_current:
        dialog.get_by_text("取消", exact=True).click()
        return {
            "found": True,
            "requestedSemester": semester,
            "currentSemester": current_value,
            "currentSemesterLabel": current_label,
            "selectedSemester": current_value,
            "selectedSemesterLabel": current_label,
            "availableSemesters": available,
        }
    matches = [
        item
        for item in available
        if cls._semester_matches(requested, value=item["value"], label=item["label"])
    ]
    if len(matches) != 1:
        dialog.get_by_text("取消", exact=True).click()
        return {
            "found": False,
            "requestedSemester": semester,
            "currentSemester": current_value,
            "currentSemesterLabel": current_label,
            "selectedSemester": current_value,
            "selectedSemesterLabel": current_label,
            "availableSemesters": available,
        }

    selected = matches[0]
    did_select = dropdown.evaluate(
        """
        (el, value) => {
          const widget = window.jQuery(el);
          const item = widget.jqxDropDownList('getItemByValue', value);
          if (!item) return false;
          widget.jqxDropDownList('selectItem', item);
          return true;
        }
        """,
        selected["value"],
    )
    if not did_select:
        dialog.get_by_text("取消", exact=True).click()
        return {
            "found": False,
            "requestedSemester": semester,
            "currentSemester": current_value,
            "currentSemesterLabel": current_label,
            "selectedSemester": current_value,
            "selectedSemesterLabel": current_label,
            "availableSemesters": available,
        }
    dialog.get_by_text("确定", exact=True).click()
    page.wait_for_function(
        """
        value => document.querySelector('#dqxnxq2')?.getAttribute('value') === value
        """,
        arg=selected["value"],
        timeout=15000,
    )
    page.wait_for_timeout(2500)
    return {
        "found": True,
        "requestedSemester": semester,
        "currentSemester": current_value,
        "currentSemesterLabel": current_label,
        "selectedSemester": selected["value"],
        "selectedSemesterLabel": label.inner_text().strip() or selected["label"],
        "availableSemesters": available,
    }


def _prefetch_remote_semesters(
    self,
    page,
    *,
    available_semesters: list[dict[str, str]],
    current_semester: str,
    current_semester_label: str,
    clock=datetime,
    request_rows=post_rows,
) -> dict[str, Any]:
    datetime = clock
    post_rows = request_rows
    prefetched: list[dict[str, Any]] = []
    failures: list[dict[str, str]] = []
    seen: set[str] = set()
    fetched_at = datetime.now(timezone.utc).isoformat()

    for option in available_semesters:
        value = str(option.get("value") or "").strip()
        label = str(option.get("label") or value).strip()
        if (
            not SEMESTER_CODE_PATTERN.fullmatch(value)
            or int(value[:4]) < self._earliest_sync_year()
            or value in seen
        ):
            continue
        seen.add(value)
        try:
            rows = post_rows(
                page,
                SCHEDULE_DATA_URL,
                "xskcb",
                {
                    "*order": "+KSJC",
                    "XNXQDM": value,
                    "pageSize": 10000,
                    "pageNumber": 1,
                },
            )
            courses = self._normalize_rows(rows)
            for course in courses:
                course["semester"] = value
            result = {
                "version": 2,
                "status": "fresh" if courses else "empty",
                "fetchedAt": fetched_at,
                "source": "api",
                "count": len(courses),
                "courses": courses,
                "requestedSemester": value,
                "currentSemester": current_semester,
                "currentSemesterLabel": current_semester_label,
                "selectedSemester": value,
                "selectedSemesterLabel": label,
                "availableSemesters": available_semesters,
            }
            cache_file = (
                self.cache_file
                if value == current_semester
                else self._cache_file_for_semester(value)
            )
            self._write_schedule_cache(cache_file, result)
            prefetched.append(
                {
                    "value": value,
                    "label": label,
                    "count": len(courses),
                    "cacheFile": str(cache_file.resolve()),
                }
            )
        except Exception as exc:
            if isinstance(exc, (CampusAuthError, TaskCancelledError)):
                raise
            if network_category("get-schedule", {"targetUrl": self.target_url}, exc):
                raise
            failures.append(
                {
                    "value": value,
                    "label": label,
                    "message": str(exc),
                }
            )

    return {
        "prefetchedSemesters": prefetched,
        "prefetchFailures": failures,
        "prefetchCounts": {item["value"]: item["count"] for item in prefetched},
    }


def _fetch_api_schedule(
    self,
    page,
    semester,
    *,
    include_available_semesters,
    prefetch_available_semesters,
    request_rows=post_rows,
) -> dict[str, Any] | None:
    """Use the same authenticated endpoints as the portal, without UI switching."""
    post_rows = request_rows
    base = SCHEDULE_METADATA_ROOT
    metadata = {}
    for name in ("dqxnxq", "xnxqcx"):
        rows = post_rows(
            page, base + name + ".do", name, {"*order": "+DM", "pageSize": 10000}
        )
        if not rows or any(
            not SEMESTER_CODE_PATTERN.fullmatch(str(row.get("DM") or ""))
            for row in rows
        ):
            raise CampusAPIError(f"课表学期接口 {name} 返回的数据无效")
        metadata[name] = rows
    current = str(metadata["dqxnxq"][0].get("DM") or "").strip()
    current_label = str(metadata["dqxnxq"][0].get("MC") or current).strip()
    if not SEMESTER_CODE_PATTERN.fullmatch(current):
        return None
    available = [
        {
            "value": str(row.get("DM") or "").strip(),
            "label": str(row.get("MC") or "").strip(),
        }
        for row in metadata["xnxqcx"]
        if isinstance(row, dict)
        and SEMESTER_CODE_PATTERN.fullmatch(str(row.get("DM") or "").strip())
        and int(str(row["DM"]).strip()[:4]) >= self._earliest_sync_year()
    ]
    selected = str(semester or current).strip()
    info = {
        "requestedSemester": semester,
        "currentSemester": current,
        "currentSemesterLabel": current_label,
        "selectedSemester": selected,
        "selectedSemesterLabel": next(
            (item["label"] for item in available if item["value"] == selected),
            current_label,
        ),
        "availableSemesters": available
        if include_available_semesters or prefetch_available_semesters
        else [],
    }
    if selected not in {item["value"] for item in available}:
        return {
            "status": "semester_not_found",
            "found": False,
            **info,
            "message": "请求的学期不在课表系统可选列表中。",
        }
    batch = self._prefetch_remote_semesters(
        page,
        available_semesters=available
        if prefetch_available_semesters
        else [item for item in available if item["value"] == selected],
        current_semester=current,
        current_semester_label=current_label,
    )
    cache_file = (
        self.cache_file
        if selected == current
        else self._cache_file_for_semester(selected)
    )
    cached = self._load_cache_file(cache_file) or {"courses": [], "count": 0}
    result = {
        **cached,
        **info,
        **batch,
        "found": True,
        "source": "api",
        "cacheFile": str(cache_file.resolve()),
        "status": "partial"
        if batch["prefetchFailures"]
        else "fresh"
        if cached["courses"]
        else "empty",
    }
    if batch["prefetchFailures"]:
        result["message"] = "部分学期同步失败，已保留原有缓存；请查看失败学期后重试。"
    if selected in batch["prefetchCounts"]:
        self._write_schedule_cache(cache_file, result)
    self._save_cookies(page)
    return result


def _fetch_remote(
    self,
    semester: str | None = None,
    *,
    include_available_semesters: bool = False,
    prefetch_available_semesters: bool = False,
    session_factory=CampusSession,
    clock=datetime,
) -> dict[str, Any]:
    CampusSession = session_factory
    datetime = clock
    if self.target_url == DEFAULT_SCHEDULE_URL:
        try:
            with CampusSession(
                self.cookie_file, username=self.username, password=self.password
            ) as session:
                session.ensure_authenticated(self.entry_url)
                api_result = self._fetch_api_schedule(
                    session,
                    semester,
                    include_available_semesters=include_available_semesters,
                    prefetch_available_semesters=prefetch_available_semesters,
                )
                if api_result is not None:
                    return api_result
        except CampusAuthError as error:
            return error.result()
    from .optional_runtime import ensure_dependencies

    ensure_dependencies("browser")
    from playwright.sync_api import TimeoutError as PlaywrightTimeoutError

    payloads: list[tuple[str, Any]] = []
    with self._page(visible=False) as page:

        def collect(response) -> None:
            if not response.url.endswith("/modules/xskcb/xskcb.do") or not response.ok:
                return
            try:
                payload = response.json()
            except Exception:
                return
            if isinstance(payload, dict) and "datas" in payload:
                payloads.append((response.request.post_data or "", payload))

        page.on("response", collect)
        page.goto(self.entry_url, wait_until="domcontentloaded", timeout=30000)
        try:
            page.locator(".wut_table, #kcb_container").first.wait_for(
                state="attached", timeout=15000
            )
        except PlaywrightTimeoutError:
            pass
        page.wait_for_timeout(3000)
        if self._is_auth_page(page.url) or "ehall.seu.edu.cn" not in page.url:
            return {
                "status": "auth_required",
                "message": "课表登录会话不存在或已失效，请调用课表授权工具。",
            }
        if page.title().strip() == "403":
            return {
                "status": "launch_failed",
                "message": "课表应用启动失败，请重新执行课表授权。",
            }

        try:
            semester_info = self._select_remote_semester(
                page,
                semester,
                include_available_semesters=(
                    include_available_semesters or prefetch_available_semesters
                ),
            )
        except _SchedulePageLoadTimeout:
            return {
                "status": "page_load_failed",
                "requestedSemester": semester,
                "message": "课表页面加载未完成，请稍后重试。",
            }
        except PlaywrightTimeoutError:
            return {
                "status": "semester_switch_failed",
                "requestedSemester": semester,
                "message": "课表页面未能完成学期切换，请稍后重试。",
            }
        if not semester_info["found"]:
            return {
                "status": "semester_not_found",
                **semester_info,
                "message": "请求的学期不在课表系统可选列表中。",
            }

        rows: list[dict[str, Any]] = []
        selected_semester = semester_info["selectedSemester"]
        matching_payloads = [
            payload
            for post_data, payload in payloads
            if f"XNXQDM={selected_semester}" in post_data
        ]
        for payload in matching_payloads:
            rows.extend(self._rows_from_payload(payload))
        courses = self._normalize_rows(rows)
        source = "api"

        if not courses:
            try:
                records = page.evaluate(
                    """
                    () => Array.from(document.querySelectorAll('.mtt_item_kcmc')).map(el => {
                      const nodes = Array.from(el.childNodes);
                      const courseName = (nodes.find(node => node.nodeType === Node.TEXT_NODE)?.textContent || '').trim();
                      const teacherName = (nodes.find(node => node.nodeType === Node.ELEMENT_NODE && !node.classList?.contains('mtt_item_room'))?.textContent || '').trim();
                      const details = (el.querySelector('.mtt_item_room')?.textContent || nodes[3]?.textContent || '').trim();
                      return { courseName, teacherName, details };
                    })
                    """
                )
            except Exception:
                records = []
            courses = self._normalize_dom_records(records)
            source = "dom"

        for course in courses:
            course["semester"] = selected_semester
        prefetch_result: dict[str, Any] = {}
        if prefetch_available_semesters:
            prefetch_result = self._prefetch_remote_semesters(
                page,
                available_semesters=semester_info["availableSemesters"],
                current_semester=semester_info["currentSemester"],
                current_semester_label=semester_info["currentSemesterLabel"],
            )
            if selected_semester in prefetch_result["prefetchCounts"]:
                selected_cache = (
                    self.cache_file
                    if selected_semester == semester_info["currentSemester"]
                    else self._cache_file_for_semester(selected_semester)
                )
                courses = json.loads(selected_cache.read_text(encoding="utf-8"))[
                    "courses"
                ]
                source = "api"
        self._save_cookies(page)

    result = {
        "version": 2,
        "status": "fresh" if courses else "empty",
        "fetchedAt": datetime.now(timezone.utc).isoformat(),
        "source": source,
        "count": len(courses),
        "courses": courses,
        **semester_info,
        **prefetch_result,
    }
    if not courses:
        result["message"] = "页面已通过认证，但这个学期没有课表数据。"
    if prefetch_result.get("prefetchFailures"):
        result["status"] = "partial"
        result["message"] = "部分学期同步失败，已保留原有缓存；请查看失败学期后重试。"
    cache_file = (
        self.cache_file
        if selected_semester == semester_info["currentSemester"]
        else self._cache_file_for_semester(selected_semester)
    )
    self._write_schedule_cache(cache_file, result)
    return {**result, "cacheFile": str(cache_file.resolve())}

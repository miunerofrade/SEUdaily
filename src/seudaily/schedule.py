from __future__ import annotations

import json
import os
import re
import time
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .browser_runtime import browser_runtime
from .campus_auth import CampusAuthError, CampusSession
from .campus_api import CampusAPIError, dataset_rows, post_rows
from .json_store import write_json_atomic
from .cancellation import TaskCancelledError
from .campus_network import network_category
from .runtime_paths import env_value
from .academic_calendar import AcademicCalendar
from . import schedule_customizations, schedule_rows


from .campus_endpoints import (
    DEFAULT_SCHEDULE_URL,
    DEFAULT_SCHEDULE_APP_ID,
    DEFAULT_SCHEDULE_LAUNCH_URL,
    SCHEDULE_DATA_URL,
    SCHEDULE_METADATA_ROOT,
    USER_AGENT as DEFAULT_USER_AGENT,
)
from .browser_auth import login_fields

SEMESTER_CODE_PATTERN = re.compile(r"^\d{4}-\d{4}-\d+$")


class _SchedulePageLoadTimeout(TimeoutError):
    """The timetable has not initialized its current semester yet."""


class ScheduleService:
    """Fetch and cache a normalized timetable without retaining raw private data."""

    @staticmethod
    def _earliest_sync_year() -> int:
        return datetime.now(timezone(timedelta(hours=8))).year - 4

    def __init__(
        self,
        *,
        target_url: str = DEFAULT_SCHEDULE_URL,
        cookie_file: str | Path = ".seudaily/ehall-cookies.json",
        cache_file: str | Path = ".seudaily/schedule.json",
        customization_file: str | Path = ".seudaily/schedule-user.json",
        username: str | None = None,
        password: str | None = None,
    ) -> None:
        self.target_url = target_url
        self.cookie_file = Path(cookie_file)
        self.cache_file = Path(cache_file)
        self.customization_file = Path(customization_file)
        self.username = username or env_value("SEUDAILY_USERNAME", "")
        self.password = password or env_value("SEUDAILY_PASSWORD", "")

    @property
    def entry_url(self) -> str:
        if "ehall.seu.edu.cn/jwapp/sys/wdkb/" in self.target_url:
            return DEFAULT_SCHEDULE_LAUNCH_URL
        return self.target_url

    @contextmanager
    def _page(self, *, visible: bool, load_saved_cookies: bool = True):
        with browser_runtime().page(
            "schedule-portal",
            visible=visible,
            context_options={
                "no_viewport": visible,
                "viewport": None if visible else {"width": 1920, "height": 1080},
                "user_agent": DEFAULT_USER_AGENT,
                "locale": "zh-CN",
                "timezone_id": "Asia/Shanghai",
            },
        ) as page:
            context = page.context
            if load_saved_cookies and self.cookie_file.exists():
                try:
                    cookies = json.loads(self.cookie_file.read_text(encoding="utf-8"))
                    context.add_cookies(cookies)
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

    def _try_fill_login(self, page) -> str | None:
        username_field, password_field, login_button = login_fields(page)

        if username_field.count() == 0 or not username_field.is_visible():
            return None
        if not self.username or not self.password:
            return "credentials_missing"

        username_field.fill(self.username)
        password_field.fill(self.password)
        captcha = page.locator("input[placeholder*='验证码']").first
        if captcha.count() and captcha.is_visible():
            return "captcha_required"

        login_button.click()
        return "submitted"

    _write_json_atomic = staticmethod(write_json_atomic)

    def _save_cookies(self, page) -> None:
        self._write_json_atomic(self.cookie_file, page.context.cookies())

    def _clear_saved_session(self) -> bool:
        try:
            self.cookie_file.unlink(missing_ok=True)
            return True
        except OSError:
            return False

    def authorize(
        self, timeout_seconds: int = 300, *, reset_session: bool = True
    ) -> dict[str, Any]:
        timeout_seconds = max(30, min(timeout_seconds, 600))
        session_reset = False
        if reset_session:
            session_reset = self._clear_saved_session()
        if self.target_url == DEFAULT_SCHEDULE_URL:
            try:
                with CampusSession(
                    self.cookie_file,
                    username=self.username,
                    password=self.password,
                    load_saved_cookies=not reset_session,
                ) as session:
                    session.ensure_authenticated(self.entry_url)
                return {
                    "status": "authorized",
                    "cookieFile": str(self.cookie_file.resolve()),
                    "sessionReset": session_reset,
                    "authenticationMethod": "http",
                }
            except CampusAuthError as error:
                if error.status == "sms_required":
                    return error.result()
                # Keep the visible login entry for CAPTCHA and other interactive checks.
                pass
        from .optional_runtime import ensure_dependencies

        ensure_dependencies("browser")
        from playwright.sync_api import (
            Error as PlaywrightError,
            TimeoutError as PlaywrightTimeoutError,
        )

        with self._page(visible=True, load_saved_cookies=not reset_session) as page:
            try:
                page.goto(self.entry_url, wait_until="domcontentloaded", timeout=30000)
                deadline = time.monotonic() + timeout_seconds
                login_attempted = False
                manual_reason: str | None = None
                while time.monotonic() < deadline:
                    if (
                        "ehall.seu.edu.cn/jwapp/sys/wdkb/" in page.url
                        and not self._is_auth_page(page.url)
                    ):
                        try:
                            page.locator(".wut_table, #kcb_container").first.wait_for(
                                state="attached", timeout=10000
                            )
                        except PlaywrightTimeoutError:
                            if page.title().strip() == "403":
                                return {
                                    "status": "launch_failed",
                                    "message": "统一认证已完成，但课表应用启动链接无效。",
                                }
                        else:
                            self._save_cookies(page)
                            return {
                                "status": "authorized",
                                "cookieFile": str(self.cookie_file.resolve()),
                                "sessionReset": session_reset,
                            }

                    if not login_attempted:
                        login_state = self._try_fill_login(page)
                        if login_state == "credentials_missing":
                            return {
                                "status": "credentials_missing",
                                "message": "请在 .env 配置 SEUDAILY_USERNAME 和 SEUDAILY_PASSWORD。",
                            }
                        if login_state in {"submitted", "captcha_required"}:
                            login_attempted = True
                            manual_reason = (
                                "captcha" if login_state == "captcha_required" else None
                            )
                    page.wait_for_timeout(1000)

                self._save_cookies(page)
                return {
                    "status": "auth_timeout",
                    "manualReason": manual_reason,
                    "sessionReset": session_reset,
                    "message": "认证窗口等待超时，请重新调用授权工具。",
                }
            except PlaywrightError as exc:
                if "closed" in str(exc).lower():
                    return {
                        "status": "auth_cancelled",
                        "message": "认证窗口已关闭。",
                    }
                raise

    def _cache_file_for_semester(self, semester: str | None = None) -> Path:
        code = str(semester or "").strip()
        if not SEMESTER_CODE_PATTERN.fullmatch(code):
            return self.cache_file
        suffix = self.cache_file.suffix
        stem = self.cache_file.name[: -len(suffix)] if suffix else self.cache_file.name
        return self.cache_file.with_name(f"{stem}.{code}{suffix}")

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
                and SEMESTER_CODE_PATTERN.fullmatch(
                    str(item.get("value") or "").strip()
                )
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
        return self._load_cache_file(self._cache_file_for_semester(semester))

    @staticmethod
    def _normalize_semester_label(value: Any) -> str:
        return re.sub(r"[\s_-]+", "", str(value or "").strip().casefold())

    @classmethod
    def _semester_matches(cls, requested: str, *, value: str, label: str) -> bool:
        requested = requested.strip()
        return requested == value or cls._normalize_semester_label(
            requested
        ) == cls._normalize_semester_label(label)

    @classmethod
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
            if cls._semester_matches(
                requested, value=item["value"], label=item["label"]
            )
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

    _source_key = staticmethod(schedule_customizations._source_key)

    _default_customizations = staticmethod(
        schedule_customizations._default_customizations
    )

    def _load_customizations(self) -> dict[str, Any]:
        return schedule_customizations._load_customizations(self)

    _valid_iso_date = staticmethod(schedule_customizations._valid_iso_date)

    _normalize_editable_course = staticmethod(
        schedule_customizations._normalize_editable_course
    )

    def save_customizations(self, payload: dict[str, Any]) -> dict[str, Any]:
        return schedule_customizations.save_customizations(self, payload)

    def apply_agent_change(self, payload: dict[str, Any]) -> dict[str, Any]:
        return schedule_customizations.apply_agent_change(self, payload)

    def _apply_customizations(self, result: dict[str, Any]) -> dict[str, Any]:
        return schedule_customizations._apply_customizations(self, result)

    week_for_date = staticmethod(schedule_rows.week_for_date)

    date_for_weekday = staticmethod(schedule_rows.date_for_weekday)

    _schedule_id = staticmethod(schedule_rows._schedule_id)

    _integer = staticmethod(schedule_rows._integer)

    _weeks = staticmethod(schedule_rows._weeks)

    _normalize_rows = classmethod(schedule_rows._normalize_rows)

    _rows_from_payload = staticmethod(schedule_rows._rows_from_payload)

    _normalize_dom_records = classmethod(schedule_rows._normalize_dom_records)

    def _prefetch_remote_semesters(
        self,
        page,
        *,
        available_semesters: list[dict[str, str]],
        current_semester: str,
        current_semester_label: str,
    ) -> dict[str, Any]:
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
                self._write_json_atomic(cache_file, result)
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
                if network_category(
                    "get-schedule", {"targetUrl": self.target_url}, exc
                ):
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
    ) -> dict[str, Any] | None:
        """Use the same authenticated endpoints as the portal, without UI switching."""
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
            result["message"] = (
                "部分学期同步失败，已保留原有缓存；请查看失败学期后重试。"
            )
        if selected in batch["prefetchCounts"]:
            self._write_json_atomic(cache_file, result)
        self._save_cookies(page)
        return result

    def _fetch_remote(
        self,
        semester: str | None = None,
        *,
        include_available_semesters: bool = False,
        prefetch_available_semesters: bool = False,
    ) -> dict[str, Any]:
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
                if (
                    not response.url.endswith("/modules/xskcb/xskcb.do")
                    or not response.ok
                ):
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
            result["message"] = (
                "部分学期同步失败，已保留原有缓存；请查看失败学期后重试。"
            )
        cache_file = (
            self.cache_file
            if selected_semester == semester_info["currentSemester"]
            else self._cache_file_for_semester(selected_semester)
        )
        self._write_json_atomic(cache_file, result)
        return {**result, "cacheFile": str(cache_file.resolve())}

    @property
    def calendar(self) -> AcademicCalendar:
        return AcademicCalendar(self.cache_file.parent / "calendar")

    def get_calendar(
        self, *, refresh: bool = False, local_only: bool = False
    ) -> dict[str, Any]:
        cached = self.calendar.view()
        if not local_only and (refresh or not cached.get("attachments")):
            cached = self.calendar.sync(self._write_json_atomic)
        return {
            **cached,
            "status": "completed" if cached.get("attachments") else "partial",
            "message": "学校校历与节假日调课通知"
            if cached.get("attachments")
            else "校历暂不可用",
        }

    def get_schedule(
        self,
        *,
        refresh: bool = False,
        local_only: bool = False,
        semester: str | None = None,
        include_available_semesters: bool = False,
        prefetch_available_semesters: bool = True,
        target_date: str | None = None,
    ) -> dict[str, Any]:
        requested = str(semester or "").strip()
        cached = (
            self._load_cache(requested)
            if not requested or SEMESTER_CODE_PATTERN.fullmatch(requested)
            else None
        )
        if local_only:
            if cached is None:
                result = {
                    "status": "empty",
                    "message": "本地没有可用的课表缓存。",
                    "count": 0,
                    "courses": [],
                    "localOnly": True,
                }
                customizations = self._load_customizations()
                if not requested and (
                    customizations["customCourses"] or customizations["dateOverrides"]
                ):
                    return self._filter_by_date(
                        self._apply_customizations(result), target_date
                    )
                return result
            result = {
                **cached,
                "status": "cached",
                "cacheFile": str(self._cache_file_for_semester(requested).resolve()),
                "localOnly": True,
            }
            view = result if requested else self._apply_customizations(result)
            return self._filter_by_date(view, target_date)
        if cached is not None and not refresh:
            result = {
                **cached,
                "status": "cached",
                "cacheFile": str(self._cache_file_for_semester(requested).resolve()),
            }
            view = result if requested else self._apply_customizations(result)
            return self._filter_by_date(view, target_date)

        try:
            result = self._fetch_remote(
                semester=semester,
                include_available_semesters=include_available_semesters,
                prefetch_available_semesters=prefetch_available_semesters,
            )
        except TaskCancelledError:
            raise
        except Exception as error:
            if cached is None:
                raise
            result = {
                **cached,
                "status": "cached",
                "stale": True,
                "syncFailure": str(error),
                "message": "课表同步暂时失败，使用上次缓存；数据可能已过期。",
            }
        if cached is not None and result.get("status") not in {
            "fresh",
            "cached",
            "completed",
            "empty",
            "partial",
            "auth_required",
        }:
            result = {
                **cached,
                "status": "cached",
                "stale": True,
                "syncFailure": result.get("status"),
                "message": "课表同步失败，使用上次缓存；数据可能已过期。",
            }
        if result.get("status") in {"fresh", "cached", "completed", "empty", "partial"}:
            result["calendar"] = self.calendar.sync(self._write_json_atomic)
        if result.get("status") == "auth_required" and cached is not None:
            fallback = {
                **result,
                "cacheAvailable": True,
                "cachedFetchedAt": cached.get("fetchedAt"),
                "courses": cached.get("courses", []),
            }
            view = fallback if requested else self._apply_customizations(fallback)
            return self._filter_by_date(view, target_date)
        view = result if requested else self._apply_customizations(result)
        return self._filter_by_date(view, target_date)

    def _filter_by_date(
        self, result: dict[str, Any], target_date: str | None
    ) -> dict[str, Any]:
        result = {"calendar": self.calendar.view(), **result}
        requested = str(target_date or "").strip()
        if not requested:
            return result
        requested_date = self._valid_iso_date(requested, "date")
        target = date.fromisoformat(requested_date)
        customizations = result.get("customizations")
        if not isinstance(customizations, dict):
            customizations = self._load_customizations()
        semester = customizations.get("semester")
        semester = semester if isinstance(semester, dict) else {}
        start_text = str(semester.get("startDate") or "").strip()
        filter_info: dict[str, Any] = {
            "requestedDate": requested_date,
            "weekday": target.isoweekday(),
            "applied": False,
        }
        week = self.week_for_date(start_text, target) if start_text else None
        if start_text:
            filter_info.update(
                {"applied": True, "semesterStartDate": start_text, "week": week}
            )
        else:
            filter_info["reason"] = "missing_semester_start_date"
        courses = [
            dict(course)
            for course in result.get("courses") or []
            if start_text
            and int(course.get("weekday") or 0) == target.isoweekday()
            and (
                not course.get("weeks")
                or week in {int(item) for item in course.get("weeks") or []}
            )
        ]
        course_by_source = {
            str(
                course.get("sourceKey") or course.get("scheduleId") or f"course-{index}"
            ): course
            for index, course in enumerate(courses)
        }
        for override in customizations.get("dateOverrides") or []:
            if not isinstance(override, dict) or override.get("date") != requested_date:
                continue
            source_key = str(override.get("targetSourceKey") or "")
            if source_key:
                course_by_source.pop(source_key, None)
            if override.get("action") in {"add", "replace"}:
                raw_course = override.get("course")
                if isinstance(raw_course, dict):
                    course = dict(raw_course)
                    custom_id = str(course.get("customId") or override.get("id") or "")
                    course["scheduleId"] = f"custom-{custom_id}"
                    course["sourceKey"] = course["scheduleId"]
                    course["source"] = "custom"
                    course_by_source[course["sourceKey"]] = course
        filtered = sorted(
            course_by_source.values(),
            key=lambda item: (
                item.get("startPeriod") or 0,
                item.get("courseName") or "",
            ),
        )
        return {
            **result,
            "status": ("completed" if filtered else "empty")
            if start_text
            else "partial",
            **(
                {
                    "message": "未配置学期起始日期，仅展示明确指定日期的课程，周期课程无法按日期筛选。"
                }
                if not start_text
                else {}
            ),
            "count": len(filtered),
            "courses": filtered,
            "dateFilter": {**filter_info, "matchedCount": len(filtered)},
        }

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

    def resolve_course(
        self, schedule_id: str, *, semester: str | None = None
    ) -> dict[str, Any]:
        requested = str(semester or "").strip()
        cached = self._load_cache()
        customizations = self._load_customizations()
        if not requested and (cached is not None or customizations["customCourses"]):
            view = self._apply_customizations(cached or {"courses": []})
            current_matches = [
                course
                for course in view["courses"]
                if course.get("scheduleId") == schedule_id
            ]
            if len(current_matches) == 1:
                return current_matches[0]
            if len(current_matches) > 1:
                raise ValueError("scheduleId 对应多条排课，请刷新课表后重试。")

        cache_files = self._semester_cache_files()
        if SEMESTER_CODE_PATTERN.fullmatch(requested):
            cache_files = [self._cache_file_for_semester(requested)]
        matches: list[dict[str, Any]] = []
        for cache_file in cache_files:
            term_cache = self._load_cache_file(cache_file)
            if term_cache is None:
                continue
            selected_value = str(term_cache.get("selectedSemester") or "")
            selected_label = str(term_cache.get("selectedSemesterLabel") or "")
            if requested and not self._semester_matches(
                requested, value=selected_value, label=selected_label
            ):
                continue
            matches.extend(
                course
                for course in term_cache.get("courses") or []
                if course.get("scheduleId") == schedule_id
            )

        if cached is None and not customizations["customCourses"] and not matches:
            raise ValueError("本地课表缓存不存在，请先调用 get-course-schedule。")
        if not matches:
            raise ValueError("scheduleId 不存在或课表已经更新，请重新读取课表。")
        if len(matches) > 1:
            raise ValueError("scheduleId 在多个学期中重复，请同时提供 semester。")
        return matches[0]

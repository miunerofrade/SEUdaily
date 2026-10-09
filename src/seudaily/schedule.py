from __future__ import annotations
from . import schedule_cache, schedule_remote

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

SEMESTER_CODE_PATTERN = schedule_cache.SEMESTER_CODE_PATTERN


_SchedulePageLoadTimeout = schedule_remote._SchedulePageLoadTimeout


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
        return schedule_cache._cache_file_for_semester(self, semester)

    def _load_cache_file(self, cache_file: Path) -> dict[str, Any] | None:
        return schedule_cache._load_cache_file(self, cache_file)

    def _load_cache(self, semester: str | None = None) -> dict[str, Any] | None:
        return schedule_cache._load_cache(self, semester)

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
        return schedule_remote._select_remote_semester(
            cls, page, semester, include_available_semesters=include_available_semesters
        )

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
        return schedule_remote._prefetch_remote_semesters(
            self,
            page,
            available_semesters=available_semesters,
            current_semester=current_semester,
            current_semester_label=current_semester_label,
            clock=datetime,
            request_rows=post_rows,
        )

    def _fetch_api_schedule(
        self,
        page,
        semester,
        *,
        include_available_semesters,
        prefetch_available_semesters,
    ) -> dict[str, Any] | None:
        return schedule_remote._fetch_api_schedule(
            self,
            page,
            semester,
            include_available_semesters=include_available_semesters,
            prefetch_available_semesters=prefetch_available_semesters,
            request_rows=post_rows,
        )

    def _fetch_remote(
        self,
        semester: str | None = None,
        *,
        include_available_semesters: bool = False,
        prefetch_available_semesters: bool = False,
    ) -> dict[str, Any]:
        return schedule_remote._fetch_remote(
            self,
            semester,
            include_available_semesters=include_available_semesters,
            prefetch_available_semesters=prefetch_available_semesters,
            session_factory=CampusSession,
            clock=datetime,
        )

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
        return schedule_cache._semester_cache_files(self)

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

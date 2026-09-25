from __future__ import annotations

import json
import hashlib
import os
import re
import tempfile
import time
import uuid
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError

from .browser_runtime import browser_runtime


DEFAULT_SCHEDULE_URL = (
    "https://ehall.seu.edu.cn/jwapp/sys/wdkb/*default/index.do"
)
DEFAULT_SCHEDULE_APP_ID = "4770397878132218"
DEFAULT_SCHEDULE_LAUNCH_URL = (
    f"https://ehall.seu.edu.cn/appShow?appId={DEFAULT_SCHEDULE_APP_ID}"
)
DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)
SEMESTER_CODE_PATTERN = re.compile(r"^\d{4}-\d{4}-\d+$")
SCHEDULE_DATA_URL = (
    "https://ehall.seu.edu.cn/jwapp/sys/wdkb/modules/xskcb/xskcb.do"
)


class ScheduleService:
    """Fetch and cache a normalized timetable without retaining raw private data."""

    def __init__(
        self,
        *,
        target_url: str = DEFAULT_SCHEDULE_URL,
        cookie_file: str | Path = ".cvstream/ehall-cookies.json",
        cache_file: str | Path = ".cvstream/schedule.json",
        customization_file: str | Path = ".cvstream/schedule-user.json",
        username: str | None = None,
        password: str | None = None,
    ) -> None:
        self.target_url = target_url
        self.cookie_file = Path(cookie_file)
        self.cache_file = Path(cache_file)
        self.customization_file = Path(customization_file)
        self.username = username or os.getenv("CVSTREAM_USERNAME", "")
        self.password = password or os.getenv("CVSTREAM_PASSWORD", "")

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
        username_field = page.locator(
            "input[placeholder*='一卡通'], input[placeholder*='唯一ID'], .input-username-pc"
        ).first
        password_field = page.locator(
            "input[type='password'], input[placeholder*='密码']"
        ).first
        if username_field.count() == 0 or not username_field.is_visible():
            return None
        if not self.username or not self.password:
            return "credentials_missing"

        username_field.fill(self.username)
        password_field.fill(self.password)
        captcha = page.locator("input[placeholder*='验证码']").first
        if captcha.count() and captcha.is_visible():
            return "captcha_required"

        page.locator("button:has-text('登 录'), .login-button-pc").first.click()
        return "submitted"

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
        with self._page(
            visible=True, load_saved_cookies=not reset_session
        ) as page:
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
                                "message": "请在 .env 配置 CVSTREAM_USERNAME 和 CVSTREAM_PASSWORD。",
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
            if (
                not cached.get("currentSemesterLabel")
                and cached.get("selectedSemesterLabel")
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
        label = page.locator("#dqxnxq2")
        label.wait_for(state="attached", timeout=15000)
        current_value = str(label.get_attribute("value") or "").strip()
        current_label = label.inner_text().strip()
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
            and SEMESTER_CODE_PATTERN.fullmatch(
                str(item.get("value") or "").strip()
            )
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

    @staticmethod
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

    @staticmethod
    def _default_customizations() -> dict[str, Any]:
        return {
            "version": 1,
            "semester": {"name": "", "startDate": "", "totalWeeks": 20},
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

    @staticmethod
    def _valid_iso_date(value: Any, field: str, *, optional: bool = False) -> str:
        text = str(value or "").strip()
        if optional and not text:
            return ""
        try:
            date.fromisoformat(text)
        except ValueError as exc:
            raise ValueError(f"{field} 必须是 YYYY-MM-DD 日期") from exc
        return text

    @staticmethod
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
        total_weeks = int(semester_input.get("totalWeeks", 20))
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

        raise ValueError("课表操作仅支持 add、update 或 move")

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

    @staticmethod
    def week_for_date(start_date: str, target: date) -> int:
        start = date.fromisoformat(start_date)
        return ((target - start).days // 7) + 1

    @staticmethod
    def date_for_weekday(start_date: str, week: int, weekday: int) -> date:
        return date.fromisoformat(start_date) + timedelta(days=(week - 1) * 7 + weekday - 1)

    @staticmethod
    def _schedule_id(course: dict[str, Any]) -> str:
        identity = {
            key: course.get(key)
            for key in (
                "courseName",
                "teacherName",
                "weekday",
                "weeklyPeriods",
                "weeks",
                "classroom",
                "courseCode",
            )
        }
        encoded = json.dumps(
            identity, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode("utf-8")
        return f"seu-{hashlib.sha256(encoded).hexdigest()[:16]}"

    @staticmethod
    def _integer(value: Any) -> int | None:
        if value is None:
            return None
        match = re.search(r"\d+", str(value))
        return int(match.group()) if match else None

    @staticmethod
    def _weeks(value: Any) -> list[int]:
        text = str(value or "").strip()
        if text and set(text) <= {"0", "1"}:
            return [index + 1 for index, flag in enumerate(text) if flag == "1"]
        weeks: set[int] = set()
        for start, end in re.findall(r"(\d+)(?:-(\d+))?", text):
            first = int(start)
            last = int(end) if end else first
            weeks.update(range(first, last + 1))
        if "(单)" in text or "（单）" in text:
            weeks = {week for week in weeks if week % 2 == 1}
        if "(双)" in text or "（双）" in text:
            weeks = {week for week in weeks if week % 2 == 0}
        return sorted(weeks)

    @classmethod
    def _normalize_rows(cls, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        courses: list[dict[str, Any]] = []
        seen: set[tuple[Any, ...]] = set()
        for row in rows:
            course_name = str(row.get("KCM") or row.get("XSKCM") or "").strip()
            teacher_name = str(
                row.get("SKJS") or row.get("JSXM") or row.get("RKJS") or ""
            ).strip()
            weekday = cls._integer(row.get("SKXQ") or row.get("XQJ"))
            start_period = cls._integer(row.get("KSJC") or row.get("JCQZ"))
            end_period = cls._integer(row.get("JSJC") or row.get("JCZZ"))
            if not course_name or start_period is None or end_period is None:
                continue
            periods = list(range(start_period, end_period + 1))
            classroom = str(
                row.get("JASMC") or row.get("SKDD") or row.get("CDMC") or ""
            ).strip()
            weeks = cls._weeks(row.get("SKZC") or row.get("ZC") or row.get("ZCMC"))
            key = (
                course_name,
                teacher_name,
                weekday,
                start_period,
                end_period,
                classroom,
                tuple(weeks),
            )
            if key in seen:
                continue
            seen.add(key)
            course = {
                "courseName": course_name,
                "teacherName": teacher_name,
                "weekday": weekday,
                "startPeriod": start_period,
                "endPeriod": end_period,
                "weeklyPeriods": periods,
                "weeks": weeks,
                "classroom": classroom,
                "courseCode": str(row.get("KCH") or row.get("XSKCH") or "").strip(),
            }
            optional_fields = {
                "courseNature": row.get("KCXZDM_DISPLAY") or row.get("KCXZMC"),
                "courseGroup": row.get("KZM") or row.get("KCLBMC"),
                "credits": row.get("XF"),
                "hours": row.get("XS"),
                "department": row.get("KKDWDM_DISPLAY") or row.get("KKDWMC"),
                "assessment": row.get("KSLXDM_DISPLAY") or row.get("KSLXMC"),
            }
            course.update(
                {
                    key: value.strip() if isinstance(value, str) else value
                    for key, value in optional_fields.items()
                    if value not in (None, "")
                }
            )
            course["scheduleId"] = cls._schedule_id(course)
            courses.append(course)
        return sorted(
            courses,
            key=lambda item: (
                item["weekday"] is None,
                item["weekday"] or 0,
                item["startPeriod"],
                item["courseName"],
            ),
        )

    @staticmethod
    def _rows_from_payload(payload: Any) -> list[dict[str, Any]]:
        found: list[dict[str, Any]] = []

        def walk(value: Any) -> None:
            if isinstance(value, dict):
                rows = value.get("rows")
                if isinstance(rows, list):
                    found.extend(row for row in rows if isinstance(row, dict))
                for nested in value.values():
                    walk(nested)
            elif isinstance(value, list):
                for nested in value:
                    walk(nested)

        walk(payload)
        return found

    @classmethod
    def _normalize_dom_records(
        cls, records: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        weekdays = {
            "星期一": 1,
            "星期二": 2,
            "星期三": 3,
            "星期四": 4,
            "星期五": 5,
            "星期六": 6,
            "星期日": 7,
            "星期天": 7,
        }
        for record in records:
            details = [part.strip() for part in record.get("details", "").split(",")]
            period_index = next(
                (
                    index
                    for index, part in enumerate(details)
                    if re.fullmatch(r"\d+-\d+", part)
                ),
                None,
            )
            weekday_text = next(
                (part for part in details if part in weekdays), ""
            )
            if period_index is None:
                continue
            start_period, end_period = details[period_index].split("-", 1)
            classroom = details[period_index + 1] if len(details) > period_index + 1 else ""
            rows.append(
                {
                    "KCM": record.get("courseName", ""),
                    "SKJS": record.get("teacherName", ""),
                    "SKXQ": weekdays.get(weekday_text),
                    "KSJC": start_period,
                    "JSJC": end_period,
                    "SKZC": details[0] if details else "",
                    "JASMC": classroom,
                }
            )
        return cls._normalize_rows(rows)

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
            if not SEMESTER_CODE_PATTERN.fullmatch(value) or value in seen:
                continue
            seen.add(value)
            try:
                response = page.request.post(
                    SCHEDULE_DATA_URL,
                    form={"*order": "+KSJC", "XNXQDM": value},
                    timeout=30000,
                )
                if not response.ok:
                    failures.append(
                        {
                            "value": value,
                            "label": label,
                            "message": f"HTTP {response.status}",
                        }
                    )
                    continue
                payload = response.json()
                courses = self._normalize_rows(self._rows_from_payload(payload))
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
            "prefetchCounts": {
                item["value"]: item["count"] for item in prefetched
            },
        }

    def _fetch_remote(
        self,
        semester: str | None = None,
        *,
        include_available_semesters: bool = False,
        prefetch_available_semesters: bool = False,
    ) -> dict[str, Any]:
        payloads: list[tuple[str, Any]] = []
        with self._page(visible=False) as page:
            def collect(response) -> None:
                if not response.url.endswith(
                    "/modules/xskcb/xskcb.do"
                ) or not response.ok:
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
                        include_available_semesters
                        or prefetch_available_semesters
                    ),
                )
            except PlaywrightTimeoutError:
                return {
                    "status": "semester_switch_failed",
                    "requestedSemester": semester,
                    "message": "课表页面未能完成学期切换，请重新登录后再试。",
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
        cache_file = (
            self.cache_file
            if selected_semester == semester_info["currentSemester"]
            else self._cache_file_for_semester(selected_semester)
        )
        self._write_json_atomic(cache_file, result)
        return {**result, "cacheFile": str(cache_file.resolve())}

    def get_schedule(
        self,
        *,
        refresh: bool = False,
        local_only: bool = False,
        semester: str | None = None,
        include_available_semesters: bool = False,
        prefetch_available_semesters: bool = False,
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
                return {
                    "status": "empty",
                    "message": "本地没有可用的课表缓存。",
                    "count": 0,
                    "courses": [],
                    "localOnly": True,
                }
            result = {
                **cached,
                "status": "cached",
                "cacheFile": str(self._cache_file_for_semester(requested).resolve()),
                "localOnly": True,
            }
            view = result if requested else self._apply_customizations(result)
            return self._filter_by_date(view, target_date)
        if (
            cached is not None
            and not refresh
            and not include_available_semesters
            and not prefetch_available_semesters
        ):
            result = {
                **cached,
                "status": "cached",
                "cacheFile": str(
                    self._cache_file_for_semester(requested).resolve()
                ),
            }
            view = result if requested else self._apply_customizations(result)
            return self._filter_by_date(view, target_date)

        result = self._fetch_remote(
            semester=semester,
            include_available_semesters=include_available_semesters,
            prefetch_available_semesters=prefetch_available_semesters,
        )
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
        if not start_text:
            return {
                **result,
                "status": "partial",
                "message": "课表已读取，但未配置学期起始日期，无法按日期筛选。",
                "count": 0,
                "courses": [],
                "dateFilter": {
                    **filter_info,
                    "reason": "missing_semester_start_date",
                },
            }

        week = self.week_for_date(start_text, target)
        filter_info.update({
            "applied": True,
            "semesterStartDate": start_text,
            "week": week,
        })
        courses = [
            dict(course)
            for course in result.get("courses") or []
            if int(course.get("weekday") or 0) == target.isoweekday()
            and (
                not course.get("weeks")
                or week in {int(item) for item in course.get("weeks") or []}
            )
        ]
        course_by_source = {
            str(course.get("sourceKey") or course.get("scheduleId") or f"course-{index}"): course
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
            "status": "completed" if filtered else "empty",
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

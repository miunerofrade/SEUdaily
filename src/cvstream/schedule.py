from __future__ import annotations

import json
import hashlib
import os
import re
import tempfile
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright


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


class ScheduleService:
    """Fetch and cache a normalized timetable without retaining raw private data."""

    def __init__(
        self,
        *,
        target_url: str = DEFAULT_SCHEDULE_URL,
        cookie_file: str | Path = ".cvstream/ehall-cookies.json",
        cache_file: str | Path = ".cvstream/schedule.json",
        username: str | None = None,
        password: str | None = None,
    ) -> None:
        self.target_url = target_url
        self.cookie_file = Path(cookie_file)
        self.cache_file = Path(cache_file)
        self.username = username or os.getenv("CVSTREAM_USERNAME", "")
        self.password = password or os.getenv("CVSTREAM_PASSWORD", "")

    @property
    def entry_url(self) -> str:
        if "ehall.seu.edu.cn/jwapp/sys/wdkb/" in self.target_url:
            return DEFAULT_SCHEDULE_LAUNCH_URL
        return self.target_url

    @contextmanager
    def _page(self, *, visible: bool, load_saved_cookies: bool = True):
        with sync_playwright() as playwright:
            args = ["--disable-blink-features=AutomationControlled"]
            if visible:
                args.extend(["--window-position=0,0", "--start-maximized"])
            else:
                args.extend(
                    ["--window-position=-32000,-32000", "--window-size=1920,1080"]
                )
            browser = playwright.chromium.launch(headless=False, args=args)
            context = browser.new_context(
                no_viewport=visible,
                viewport=None if visible else {"width": 1920, "height": 1080},
                user_agent=DEFAULT_USER_AGENT,
                locale="zh-CN",
                timezone_id="Asia/Shanghai",
            )
            if load_saved_cookies and self.cookie_file.exists():
                try:
                    cookies = json.loads(self.cookie_file.read_text(encoding="utf-8"))
                    context.add_cookies(cookies)
                except (OSError, ValueError):
                    pass
            page = context.new_page()
            page.add_init_script(
                "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"
            )
            try:
                yield page
            finally:
                context.close()
                browser.close()

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

    def _load_cache(self) -> dict[str, Any] | None:
        if not self.cache_file.exists():
            return None
        try:
            cached = json.loads(self.cache_file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        if cached.get("version") not in {1, 2} or not isinstance(
            cached.get("courses"), list
        ):
            return None
        changed = cached.get("version") != 2
        for course in cached["courses"]:
            if not course.get("scheduleId"):
                course["scheduleId"] = self._schedule_id(course)
                changed = True
        if changed:
            cached["version"] = 2
            self._write_json_atomic(self.cache_file, cached)
        return cached

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

    def _fetch_remote(self) -> dict[str, Any]:
        payloads: list[Any] = []
        with self._page(visible=False) as page:
            def collect(response) -> None:
                if "/jwapp/sys/wdkb/" not in response.url or not response.ok:
                    return
                try:
                    payload = response.json()
                except Exception:
                    return
                if isinstance(payload, dict) and "datas" in payload:
                    payloads.append(payload)

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

            rows: list[dict[str, Any]] = []
            for payload in payloads:
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

            if not courses:
                return {
                    "status": "empty",
                    "message": "页面已通过认证，但没有解析到课表数据。",
                }
            self._save_cookies(page)

        result = {
            "version": 2,
            "status": "fresh",
            "fetchedAt": datetime.now(timezone.utc).isoformat(),
            "source": source,
            "count": len(courses),
            "courses": courses,
        }
        self._write_json_atomic(self.cache_file, result)
        return {**result, "cacheFile": str(self.cache_file.resolve())}

    def get_schedule(self, *, refresh: bool = False) -> dict[str, Any]:
        cached = self._load_cache()
        if cached is not None and not refresh:
            return {
                **cached,
                "status": "cached",
                "cacheFile": str(self.cache_file.resolve()),
            }

        result = self._fetch_remote()
        if result.get("status") == "auth_required" and cached is not None:
            return {
                **result,
                "cacheAvailable": True,
                "cachedFetchedAt": cached.get("fetchedAt"),
            }
        return result

    def resolve_course(self, schedule_id: str) -> dict[str, Any]:
        cached = self._load_cache()
        if cached is None:
            raise ValueError("本地课表缓存不存在，请先调用 get-course-schedule。")
        matches = [
            course
            for course in cached["courses"]
            if course.get("scheduleId") == schedule_id
        ]
        if not matches:
            raise ValueError("scheduleId 不存在或课表已经更新，请重新读取课表。")
        if len(matches) > 1:
            raise ValueError("scheduleId 对应多条排课，请刷新课表后重试。")
        return matches[0]

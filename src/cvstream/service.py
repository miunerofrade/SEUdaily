from __future__ import annotations

import os
import re
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
from datetime import date
from pathlib import Path
from typing import Any

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError

from .asr import CloudASRWorker, LocalASRWorker
from .auth import execute_login
from .browser_runtime import browser_runtime
from .cancellation import current_cancel_event
from .capture import execute_video_task, fetch_dates_only, sanitize_filename
from .ppt import PPTExtractor
from .summary import AISummarizer


DEFAULT_PORTAL_URL = "https://cvs.seu.edu.cn"
DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)


def _required(value: str | None, name: str) -> str:
    if value and value.strip():
        return value.strip()
    raise ValueError(f"缺少必需配置: {name}")


class CourseService:
    """UI-independent facade for SEUdaily course and media capabilities."""

    def __init__(
        self,
        *,
        target_url: str = DEFAULT_PORTAL_URL,
        username: str | None = None,
        password: str | None = None,
        cookie_file: str | Path = "cookies.json",
        export_dir: str | Path = "exports",
    ) -> None:
        self.target_url = target_url
        self.username = username or os.getenv("CVSTREAM_USERNAME", "")
        self.password = password or os.getenv("CVSTREAM_PASSWORD", "")
        self.cookie_file = Path(cookie_file)
        self.export_dir = Path(export_dir)

    @contextmanager
    def _page(self, *, visible: bool = False):
        with browser_runtime().page(
            "course-portal",
            visible=visible,
            context_options={
                "no_viewport": visible,
                "viewport": None if visible else {"width": 1920, "height": 1080},
                "user_agent": DEFAULT_USER_AGENT,
                "locale": "zh-CN",
                "timezone_id": "Asia/Shanghai",
                "permissions": ["geolocation"],
            },
        ) as page:
            page.add_init_script(
                "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"
            )
            yield page

    def _login(self, page) -> list[str]:
        return list(
            execute_login(
                page,
                self.target_url,
                self.username,
                self.password,
                self.cookie_file,
            )
        )

    def authorize(self) -> dict[str, Any]:
        with self._page(visible=True) as page:
            logs = self._login(page)
        return {"cookieFile": str(self.cookie_file.resolve()), "logs": logs}

    def list_dates(self) -> dict[str, Any]:
        with self._page() as page:
            logs = self._login(page)
            page.wait_for_load_state("load", timeout=15000)
            dates = fetch_dates_only(page)
        return {"dates": dates, "logs": logs}

    def _open_course_catalog(self, portal_page):
        """Navigate from the unified portal to the course replay catalog."""
        if "jy-application-resourcemanage-ui" in portal_page.url:
            catalog_page = portal_page
        else:
            entry = portal_page.locator(".app-item-hover-link").first
            entry.wait_for(state="attached", timeout=15000)
            try:
                with portal_page.context.expect_page(timeout=10000) as page_info:
                    entry.evaluate("element => element.click()")
                catalog_page = page_info.value
            except PlaywrightTimeoutError:
                pages = portal_page.context.pages
                catalog_page = pages[-1]
                if catalog_page is portal_page:
                    raise RuntimeError("云课堂入口未打开课程平台")

        catalog_page.wait_for_load_state("domcontentloaded", timeout=15000)
        replay_menu = catalog_page.locator(".el-menu-item", has_text="课程点播")
        replay_menu.first.wait_for(state="visible", timeout=15000)
        replay_menu.first.click()
        catalog_page.wait_for_url("**/#/list-video", timeout=15000)
        catalog_page.locator("input[placeholder*='课程名称']").wait_for(
            state="visible", timeout=15000
        )
        return catalog_page

    @staticmethod
    def _read_course_cards(page) -> list[dict[str, Any]]:
        cards = page.locator(".lesson-card.card-item")
        courses: list[dict[str, Any]] = []
        for index in range(cards.count()):
            card = cards.nth(index)
            lines = [line.strip() for line in card.inner_text().splitlines() if line.strip()]
            title_node = card.locator(".course-title").first
            title = title_node.get_attribute("title") or title_node.inner_text().strip()
            courses.append(
                {
                    "index": index,
                    "title": title,
                    "semester": lines[2] if len(lines) > 2 else "",
                    "teacher": lines[3] if len(lines) > 3 else "",
                    "lessonCount": lines[4] if len(lines) > 4 else "",
                    "playCount": lines[5] if len(lines) > 5 else "",
                }
            )
        return courses

    @staticmethod
    def _normalize_semester(value: str) -> str:
        normalized = value.strip().casefold()
        aliases = (
            ("暑期学校", "第1学期"),
            ("暑校", "第1学期"),
            ("暑期", "第1学期"),
            ("秋季学期", "第2学期"),
            ("秋季", "第2学期"),
            ("春季学期", "第3学期"),
            ("春季", "第3学期"),
            ("第一学期", "第1学期"),
            ("第二学期", "第2学期"),
            ("第三学期", "第3学期"),
        )
        for alias, canonical in aliases:
            normalized = normalized.replace(alias, canonical)
        return re.sub(r"[\s_\-学年第期]+", "", normalized)

    @classmethod
    def _filter_courses_by_semester(
        cls, courses: list[dict[str, Any]], semester: str | None
    ) -> list[dict[str, Any]]:
        requested = (semester or "").strip()
        if not requested or requested.casefold() in {"current", "当前", "当前学期"}:
            return courses
        normalized_requested = cls._normalize_semester(requested)
        return [
            course
            for course in courses
            if cls._normalize_semester(str(course.get("semester") or ""))
            == normalized_requested
        ]

    @classmethod
    def _match_semester_option(
        cls, options: list[str], semester: str
    ) -> str | None:
        normalized = cls._normalize_semester(semester)
        matches = [
            option
            for option in options
            if cls._normalize_semester(option) == normalized
        ]
        return matches[0] if len(matches) == 1 else None

    @classmethod
    def _select_search_filters(
        cls, page, semester: str | None
    ) -> dict[str, Any]:
        status_group = page.locator(".search-bar-item").filter(
            has_text="课程状态"
        ).first
        on_demand = status_group.locator(".options-item").filter(
            has_text="点播课程"
        ).first
        if on_demand.count() and "active" not in (on_demand.get_attribute("class") or ""):
            on_demand.click()
            page.wait_for_timeout(1000)

        semester_group = page.locator(".search-bar-item.xmxq").first
        options = semester_group.locator(".options-item")
        available = [
            options.nth(index).inner_text().strip()
            for index in range(options.count())
            if options.nth(index).inner_text().strip()
        ]
        active = semester_group.locator(".options-item.active").first
        selected = active.inner_text().strip() if active.count() else None
        requested = (semester or "").strip()
        if not requested or requested.casefold() in {"current", "当前", "当前学期"}:
            return {
                "found": True,
                "requestedSemester": semester,
                "selectedSemester": selected,
                "availableSemesters": available,
            }

        matched = cls._match_semester_option(available, requested)
        if matched is None:
            return {
                "found": False,
                "requestedSemester": semester,
                "selectedSemester": selected,
                "availableSemesters": available,
            }

        target = semester_group.locator(".options-item").filter(
            has_text=matched
        ).first
        if not target.is_visible():
            show_all = semester_group.locator(".show-all").first
            if show_all.count():
                show_all.click()
        if "active" not in (target.get_attribute("class") or ""):
            cards = page.locator(".lesson-card.card-item")
            previous_signature = "\n---\n".join(
                cards.nth(index).inner_text() for index in range(cards.count())
            )
            target.click()
            try:
                page.wait_for_function(
                    """
                    previous => {
                      const cards = [...document.querySelectorAll('.lesson-card.card-item')];
                      const separator = String.fromCharCode(10) + '---' + String.fromCharCode(10);
                      const signature = cards.map(card => card.innerText).join(separator);
                      const body = document.body.innerText || '';
                      return (signature.length > 0 && signature !== previous)
                        || body.includes('当前没有课程点播');
                    }
                    """,
                    arg=previous_signature,
                    timeout=15000,
                )
            except PlaywrightTimeoutError:
                pass
            page.wait_for_timeout(500)
        return {
            "found": True,
            "requestedSemester": semester,
            "selectedSemester": matched,
            "availableSemesters": available,
        }

    @staticmethod
    def _available_semesters(courses: list[dict[str, Any]]) -> list[str]:
        return list(
            dict.fromkeys(
                str(course.get("semester") or "").strip()
                for course in courses
                if str(course.get("semester") or "").strip()
            )
        )

    @staticmethod
    def _course_not_found_hint() -> str:
        return (
            "课程可能位于其他学期；也可能用户并不要求抓取课表内课程，"
            "此时应改用 source=manual，并根据用户描述填写课程名、教师、节次和可选学期。"
        )

    def list_courses(self) -> dict[str, Any]:
        with self._page() as page:
            logs = self._login(page)
            catalog = self._open_course_catalog(page)
            catalog.wait_for_timeout(2500)
            courses = self._read_course_cards(catalog)
        result = {
            "status": "completed" if courses else "empty",
            "availableSemesters": self._available_semesters(courses),
            "count": len(courses),
            "courses": courses,
            "logs": logs,
        }
        if not courses:
            result["hint"] = self._course_not_found_hint()
        return result

    def search_courses(
        self, query: str, semester: str | None = None
    ) -> dict[str, Any]:
        query = _required(query, "query")
        with self._page() as page:
            logs = self._login(page)
            catalog = self._open_course_catalog(page)
            search_box = catalog.locator("input[placeholder*='课程名称']").first
            search_box.fill(query)
            catalog.locator("button.el-button--primary").first.click()
            catalog.wait_for_url("**/#/advance-search", timeout=15000)
            catalog.wait_for_timeout(2500)
            semester_info = self._select_search_filters(catalog, semester)
            if semester_info["found"]:
                courses = self._read_course_cards(catalog)
                if semester:
                    courses = self._filter_courses_by_semester(courses, semester)
            else:
                courses = []
        result = {
            "status": "completed" if courses else "empty",
            "query": query,
            **semester_info,
            "count": len(courses),
            "courses": courses,
            "logs": logs,
        }
        if not courses:
            result["hint"] = self._course_not_found_hint()
        return result

    @staticmethod
    def _read_lessons(page) -> list[dict[str, Any]]:
        lesson_nodes = page.locator(".list-item.student")
        lessons: list[dict[str, Any]] = []
        for index in range(lesson_nodes.count()):
            node = lesson_nodes.nth(index)
            sequence_text = node.locator(".index").first.inner_text().strip()
            title = node.locator(".title.sle").first.inner_text().strip()
            detail = node.locator(".bottom-left.sle").first.inner_text().strip()
            detail_parts = detail.split(maxsplit=2)
            period_match = re.search(r"第(\d+)节", title)
            lessons.append(
                {
                    "sequence": int(sequence_text),
                    "title": title,
                    "periodNumber": int(period_match.group(1)) if period_match else None,
                    "date": detail_parts[0] if detail_parts else "",
                    "time": detail_parts[1] if len(detail_parts) > 1 else "",
                    "classroom": detail_parts[2] if len(detail_parts) > 2 else "",
                    "hasAiContent": "AI" in node.inner_text(),
                }
            )
        return lessons

    @staticmethod
    def _normalize_periods(weekly_periods: list[int]) -> list[int]:
        periods = sorted(set(weekly_periods))
        if not periods or any(period < 1 for period in periods):
            raise ValueError("weeklyPeriods 必须包含至少一个大于 0 的节次")
        return periods

    @staticmethod
    def _sessions_from_lessons(lessons: list[dict[str, Any]]) -> list[dict[str, Any]]:
        grouped: dict[str, list[dict[str, Any]]] = {}
        for lesson in lessons:
            lesson_date = lesson.get("date", "")
            if lesson_date:
                grouped.setdefault(lesson_date, []).append(lesson)

        sessions = []
        for lesson_date, date_lessons in grouped.items():
            ordered_lessons = sorted(
                date_lessons,
                key=lambda item: (
                    item.get("periodNumber") is None,
                    item.get("periodNumber") or 0,
                    item.get("time", ""),
                ),
            )
            sessions.append(
                {
                    "date": lesson_date,
                    "periodNumbers": sorted(
                        {
                            item["periodNumber"]
                            for item in ordered_lessons
                            if item.get("periodNumber") is not None
                        }
                    ),
                    "lessons": ordered_lessons,
                }
            )
        return sorted(sessions, key=lambda item: item["date"], reverse=True)

    @classmethod
    def _select_session(
        cls,
        lessons: list[dict[str, Any]],
        weekly_periods: list[int],
        course_date: str | None = None,
    ) -> dict[str, Any]:
        periods = cls._normalize_periods(weekly_periods)
        if course_date:
            try:
                date.fromisoformat(course_date)
            except ValueError as exc:
                raise ValueError("courseDate 必须使用 YYYY-MM-DD 格式") from exc

        sessions = cls._sessions_from_lessons(lessons)
        if course_date:
            dated = next(
                (session for session in sessions if session["date"] == course_date),
                None,
            )
            if dated is None:
                return {
                    "status": "date_not_found",
                    "requestedDate": course_date,
                    "weeklyPeriods": periods,
                    "availableSessions": sessions,
                }
            if dated["periodNumbers"] != periods:
                return {
                    "status": "period_mismatch",
                    "requestedDate": course_date,
                    "weeklyPeriods": periods,
                    "availableSession": dated,
                    "availableSessions": sessions,
                }
            return {"status": "found", "session": dated}

        matching = [
            session for session in sessions if session["periodNumbers"] == periods
        ]
        if not matching:
            return {
                "status": "period_not_found",
                "weeklyPeriods": periods,
                "availableSessions": sessions,
            }
        return {"status": "found", "session": matching[0]}

    @classmethod
    def _exact_course_matches(
        cls,
        courses: list[dict[str, Any]],
        course_name: str,
        teacher_name: str,
    ) -> list[dict[str, Any]]:
        normalized_course = course_name.casefold()
        normalized_teacher = teacher_name.casefold()
        matches = [
            course
            for course in courses
            if course["title"].strip().casefold() == normalized_course
            and normalized_teacher
            in [
                part.strip().casefold()
                for part in re.split(r"[,，、]", course["teacher"])
            ]
        ]
        return matches

    @staticmethod
    def _open_course_detail(catalog, course: dict[str, Any]):
        card = catalog.locator(".lesson-card.card-item").nth(course["index"])
        previous_pages = set(catalog.context.pages)
        try:
            with catalog.context.expect_page(timeout=10000) as page_info:
                card.locator(".img-top").click(no_wait_after=True)
            detail_page = page_info.value
        except PlaywrightTimeoutError:
            new_pages = [
                page for page in catalog.context.pages if page not in previous_pages
            ]
            if not new_pages:
                raise RuntimeError("课程详情页未打开")
            detail_page = new_pages[-1]
        detail_page.locator(".list-item.student").first.wait_for(
            state="visible", timeout=15000
        )
        return detail_page

    def _resolve_course_session(
        self,
        catalog,
        *,
        course_name: str,
        teacher_name: str,
        weekly_periods: list[int],
        course_date: str | None,
        semester: str | None = None,
    ) -> dict[str, Any]:
        search_box = catalog.locator("input[placeholder*='课程名称']").first
        search_box.fill(course_name)
        catalog.locator("button.el-button--primary").first.click()
        catalog.wait_for_url("**/#/advance-search", timeout=15000)
        catalog.wait_for_timeout(2500)
        semester_info = self._select_search_filters(catalog, semester)
        if not semester_info["found"]:
            return {
                "status": "course_not_found",
                "courseName": course_name,
                "teacherName": teacher_name,
                "semester": semester,
                "weeklyPeriods": weekly_periods,
                **semester_info,
                "candidates": [],
                "hint": self._course_not_found_hint(),
            }
        courses = self._read_course_cards(catalog)
        if semester:
            courses = self._filter_courses_by_semester(courses, semester)
        matches = self._exact_course_matches(courses, course_name, teacher_name)

        if not matches:
            return {
                "status": "course_not_found",
                "courseName": course_name,
                "teacherName": teacher_name,
                "semester": semester,
                "weeklyPeriods": weekly_periods,
                "candidates": courses,
                **semester_info,
                "hint": self._course_not_found_hint(),
            }

        resolved: list[dict[str, Any]] = []
        rejected: list[dict[str, Any]] = []
        for course in matches:
            detail_page = self._open_course_detail(catalog, course)
            lessons = self._read_lessons(detail_page)
            selection = self._select_session(
                lessons, weekly_periods, course_date=course_date
            )
            if selection["status"] == "found":
                resolved.append(
                    {
                        "course": course,
                        "session": selection["session"],
                        "detailPage": detail_page,
                    }
                )
            else:
                rejected.append({"course": course, **selection})
                detail_page.close()

        if not resolved:
            return {
                "status": rejected[0]["status"] if len(rejected) == 1 else "session_not_found",
                "courseName": course_name,
                "teacherName": teacher_name,
                "weeklyPeriods": self._normalize_periods(weekly_periods),
                "requestedDate": course_date,
                "candidates": rejected,
                **semester_info,
                "hint": self._course_not_found_hint(),
            }
        if len(resolved) > 1:
            for item in resolved:
                item["detailPage"].close()
            return {
                "status": "ambiguous",
                "courseName": course_name,
                "teacherName": teacher_name,
                "weeklyPeriods": self._normalize_periods(weekly_periods),
                "requestedDate": course_date,
                "candidates": [
                    {"course": item["course"], "session": item["session"]}
                    for item in resolved
                ],
            }
        return {"status": "found", **resolved[0]}

    def find_course_session(
        self,
        *,
        course_name: str,
        teacher_name: str,
        weekly_periods: list[int],
        course_date: str | None = None,
        semester: str | None = None,
    ) -> dict[str, Any]:
        course_name = _required(course_name, "courseName")
        teacher_name = _required(teacher_name, "teacherName")
        periods = self._normalize_periods(weekly_periods)

        with self._page() as page:
            logs = self._login(page)
            catalog = self._open_course_catalog(page)
            result = self._resolve_course_session(
                catalog,
                course_name=course_name,
                teacher_name=teacher_name,
                weekly_periods=periods,
                course_date=course_date,
                semester=semester,
            )
            result.pop("detailPage", None)
        return {**result, "logs": logs}

    def capture_course_session(
        self,
        *,
        course_name: str,
        teacher_name: str,
        weekly_periods: list[int],
        course_date: str | None = None,
        semester: str | None = None,
        need_subtitle: bool = True,
        need_ppt: bool = False,
        keep_media: bool = False,
        asr_engine: str = "local",
        model_path: str | None = None,
        asr_api_key: str | None = None,
        asr_model: str = "paraformer-realtime-v2",
    ) -> dict[str, Any]:
        course_name = _required(course_name, "courseName")
        teacher_name = _required(teacher_name, "teacherName")
        periods = self._normalize_periods(weekly_periods)
        worker = self._build_asr_worker(
            engine=asr_engine,
            model_path=model_path,
            api_key=asr_api_key,
            model=asr_model,
        )

        with self._page() as page:
            logs = self._login(page)
            catalog = self._open_course_catalog(page)
            result = self._resolve_course_session(
                catalog,
                course_name=course_name,
                teacher_name=teacher_name,
                weekly_periods=periods,
                course_date=course_date,
                semester=semester,
            )
            if result["status"] != "found":
                return {**result, "logs": logs}

            course = result["course"]
            session = result["session"]
            detail_page = result["detailPage"]
            logs.extend(
                execute_video_task(
                    detail_page,
                    detail_page.url,
                    worker,
                    self.export_dir,
                    current_cancel_event(),
                    target_date=session["date"],
                    need_subtitle=need_subtitle,
                    need_ppt=need_ppt,
                    keep_media=keep_media,
                )
            )

        artifacts = self._collect_session_artifacts(course, session)
        return {
            "status": "completed" if artifacts else "completed_without_artifact",
            "course": course,
            "session": session,
            "artifacts": artifacts,
            "logs": logs,
        }

    def _collect_session_artifacts(
        self, course: dict[str, Any], session: dict[str, Any]
    ) -> list[dict[str, Any]]:
        date_key = session["date"].replace("-", "")
        safe_course = sanitize_filename(course["title"])
        safe_teacher = sanitize_filename(course["teacher"])
        batch_name = f"{date_key}-{safe_teacher}"
        paths: list[Path] = []
        for lesson in session["lessons"]:
            period_number = lesson.get("periodNumber") or lesson["sequence"]
            task_name = f"{date_key}-{period_number}"
            paths.extend(
                [
                    self.export_dir / "subtitle" / safe_course / batch_name / f"{task_name}_transcript.txt",
                    self.export_dir / "media" / safe_course / batch_name / f"{task_name}.mp4",
                    self.export_dir / "media" / safe_course / batch_name / f"{task_name}.m4a",
                    self.export_dir / "media" / safe_course / batch_name / f"{task_name}_PPT.pdf",
                ]
            )
        return [
            {
                "path": str(path.resolve()),
                "size": path.stat().st_size,
                "kind": (
                    "transcript" if path.name.endswith("_transcript.txt")
                    else "slides" if path.name.endswith("_PPT.pdf")
                    else "media"
                ),
            }
            for path in paths
            if path.exists()
        ]

    def capture_course_sessions(
        self,
        *,
        sessions: list[dict[str, Any]],
        max_concurrency: int = 2,
        **capture_options: Any,
    ) -> dict[str, Any]:
        if not sessions:
            raise ValueError("sessions 至少需要一个课程")
        if not 1 <= max_concurrency <= 2:
            raise ValueError("maxConcurrency 必须在 1 到 2 之间")

        subtitle_only = (
            capture_options.get("need_subtitle", True)
            and not capture_options.get("need_ppt", False)
            and not capture_options.get("keep_media", False)
        )
        effective_concurrency = min(max_concurrency, 2 if subtitle_only else 1)
        if os.getenv("CVSTREAM_SHARED_BROWSER") == "1":
            effective_concurrency = 1

        results: list[dict[str, Any] | None] = [None] * len(sessions)

        def run_one(index: int, session: dict[str, Any]):
            return index, self.capture_course_session(
                course_name=session["courseName"],
                teacher_name=session["teacherName"],
                weekly_periods=session["weeklyPeriods"],
                course_date=session.get("courseDate"),
                **capture_options,
            )

        if effective_concurrency == 1:
            for index, session in enumerate(sessions):
                try:
                    _, result = run_one(index, session)
                except Exception as exc:
                    result = {
                        "status": "failed",
                        "error": str(exc),
                        "errorType": type(exc).__name__,
                    }
                results[index] = result
        else:
            with ThreadPoolExecutor(max_workers=effective_concurrency) as executor:
                futures = [
                    executor.submit(run_one, index, session)
                    for index, session in enumerate(sessions)
                ]
                for future in as_completed(futures):
                    try:
                        index, result = future.result()
                    except Exception as exc:
                        index = futures.index(future)
                        result = {
                            "status": "failed",
                            "error": str(exc),
                            "errorType": type(exc).__name__,
                        }
                    results[index] = result

        completed = sum(
            result is not None and result.get("status", "").startswith("completed")
            for result in results
        )
        warnings: list[str] = []
        if effective_concurrency < max_concurrency:
            warnings.append(
                "常驻共享浏览器使用同步 Playwright，本批次已自动串行执行以保证线程安全。"
            )
        return {
            "status": "completed" if completed == len(results) else "partial",
            "count": len(results),
            "completed": completed,
            "requestedConcurrency": max_concurrency,
            "effectiveConcurrency": effective_concurrency,
            "results": results,
            "warnings": warnings,
        }

    def find_course_lesson(
        self, *, course_name: str, teacher_name: str, lesson_number: int
    ) -> dict[str, Any]:
        course_name = _required(course_name, "courseName")
        teacher_name = _required(teacher_name, "teacherName")
        if lesson_number < 1:
            raise ValueError("lessonNumber 必须大于 0")

        with self._page() as page:
            logs = self._login(page)
            catalog = self._open_course_catalog(page)
            search_box = catalog.locator("input[placeholder*='课程名称']").first
            search_box.fill(course_name)
            catalog.locator("button.el-button--primary").first.click()
            catalog.wait_for_url("**/#/advance-search", timeout=15000)
            catalog.wait_for_timeout(2500)
            courses = self._read_course_cards(catalog)

            normalized_course = course_name.strip().casefold()
            normalized_teacher = teacher_name.strip().casefold()
            matches = [
                course
                for course in courses
                if course["title"].strip().casefold() == normalized_course
                and normalized_teacher
                in [part.strip().casefold() for part in course["teacher"].split(",")]
            ]

            if not matches:
                return {
                    "status": "not_found",
                    "courseName": course_name,
                    "teacherName": teacher_name,
                    "lessonNumber": lesson_number,
                    "candidates": courses,
                    "logs": logs,
                }
            if len(matches) > 1:
                return {
                    "status": "ambiguous",
                    "courseName": course_name,
                    "teacherName": teacher_name,
                    "lessonNumber": lesson_number,
                    "candidates": matches,
                    "logs": logs,
                }

            course = matches[0]
            card = catalog.locator(".lesson-card.card-item").nth(course["index"])
            try:
                with catalog.context.expect_page(timeout=10000) as page_info:
                    card.locator(".img-top").click(no_wait_after=True)
                detail_page = page_info.value
            except PlaywrightTimeoutError:
                detail_page = catalog.context.pages[-1]
                if detail_page is catalog:
                    raise RuntimeError("课程详情页未打开")

            detail_page.locator(".list-item.student").first.wait_for(
                state="visible", timeout=15000
            )
            lessons = self._read_lessons(detail_page)
            lesson = next(
                (item for item in lessons if item["sequence"] == lesson_number), None
            )
            if lesson is None:
                return {
                    "status": "lesson_not_found",
                    "course": course,
                    "lessonNumber": lesson_number,
                    "availableLessons": lessons,
                    "logs": logs,
                }

        return {
            "status": "found",
            "course": course,
            "lesson": lesson,
            "logs": logs,
        }

    def capture_course_lesson(
        self,
        *,
        course_name: str,
        teacher_name: str,
        lesson_number: int,
        need_subtitle: bool = True,
        need_ppt: bool = False,
        keep_media: bool = False,
        asr_engine: str = "local",
        model_path: str | None = None,
        asr_api_key: str | None = None,
        asr_model: str = "paraformer-realtime-v2",
    ) -> dict[str, Any]:
        course_name = _required(course_name, "courseName")
        teacher_name = _required(teacher_name, "teacherName")
        if lesson_number < 1:
            raise ValueError("lessonNumber 必须大于 0")

        worker = self._build_asr_worker(
            engine=asr_engine,
            model_path=model_path,
            api_key=asr_api_key,
            model=asr_model,
        )
        stop_event = current_cancel_event()

        with self._page() as page:
            logs = self._login(page)
            catalog = self._open_course_catalog(page)
            search_box = catalog.locator("input[placeholder*='课程名称']").first
            search_box.fill(course_name)
            catalog.locator("button.el-button--primary").first.click()
            catalog.wait_for_url("**/#/advance-search", timeout=15000)
            catalog.wait_for_timeout(2500)
            courses = self._read_course_cards(catalog)

            normalized_course = course_name.strip().casefold()
            normalized_teacher = teacher_name.strip().casefold()
            matches = [
                course
                for course in courses
                if course["title"].strip().casefold() == normalized_course
                and normalized_teacher
                in [part.strip().casefold() for part in course["teacher"].split(",")]
            ]
            if not matches:
                return {"status": "not_found", "candidates": courses, "logs": logs}
            if len(matches) > 1:
                return {"status": "ambiguous", "candidates": matches, "logs": logs}

            course = matches[0]
            card = catalog.locator(".lesson-card.card-item").nth(course["index"])
            try:
                with catalog.context.expect_page(timeout=10000) as page_info:
                    card.locator(".img-top").click(no_wait_after=True)
                detail_page = page_info.value
            except PlaywrightTimeoutError:
                detail_page = catalog.context.pages[-1]
                if detail_page is catalog:
                    raise RuntimeError("课程详情页未打开")

            detail_page.locator(".list-item.student").first.wait_for(
                state="visible", timeout=15000
            )
            lessons = self._read_lessons(detail_page)
            lesson = next(
                (item for item in lessons if item["sequence"] == lesson_number), None
            )
            if lesson is None:
                return {
                    "status": "lesson_not_found",
                    "course": course,
                    "lessonNumber": lesson_number,
                    "availableLessons": lessons,
                    "logs": logs,
                }

            logs.extend(
                execute_video_task(
                    detail_page,
                    detail_page.url,
                    worker,
                    self.export_dir,
                    stop_event,
                    target_sequence=lesson_number,
                    need_subtitle=need_subtitle,
                    need_ppt=need_ppt,
                    keep_media=keep_media,
                )
            )

        date_key = lesson["date"].replace("-", "")
        period_number = lesson["periodNumber"] or lesson_number
        safe_course = sanitize_filename(course["title"])
        safe_teacher = sanitize_filename(course["teacher"])
        batch_name = f"{date_key}-{safe_teacher}"
        task_name = f"{date_key}-{period_number}"
        candidate_paths = [
            self.export_dir / "subtitle" / safe_course / batch_name / f"{task_name}_transcript.txt",
            self.export_dir / "media" / safe_course / batch_name / f"{task_name}.mp4",
            self.export_dir / "media" / safe_course / batch_name / f"{task_name}.m4a",
            self.export_dir / "media" / safe_course / batch_name / f"{task_name}_PPT.pdf",
        ]
        artifacts = [
            {
                "path": str(path.resolve()),
                "size": path.stat().st_size,
                "kind": (
                    "transcript" if path.name.endswith("_transcript.txt")
                    else "slides" if path.name.endswith("_PPT.pdf")
                    else "media"
                ),
            }
            for path in candidate_paths
            if path.exists()
        ]
        return {
            "status": "completed" if artifacts else "completed_without_artifact",
            "course": course,
            "lesson": lesson,
            "artifacts": artifacts,
            "logs": logs,
        }

    def capture_course(
        self,
        *,
        target_date: str = "自动获取最新",
        need_subtitle: bool = True,
        need_ppt: bool = False,
        keep_media: bool = False,
        asr_engine: str = "local",
        model_path: str | None = None,
        asr_api_key: str | None = None,
        asr_model: str = "paraformer-realtime-v2",
    ) -> dict[str, Any]:
        worker = self._build_asr_worker(
            engine=asr_engine,
            model_path=model_path,
            api_key=asr_api_key,
            model=asr_model,
        )
        stop_event = current_cancel_event()
        with self._page() as page:
            logs = self._login(page)
            page.wait_for_load_state("load", timeout=15000)
            logs.extend(
                execute_video_task(
                    page,
                    self.target_url,
                    worker,
                    self.export_dir,
                    stop_event,
                    target_date=target_date,
                    need_subtitle=need_subtitle,
                    need_ppt=need_ppt,
                    keep_media=keep_media,
                )
            )
        return {"exportDir": str(self.export_dir.resolve()), "logs": logs}

    def _build_asr_worker(
        self,
        *,
        engine: str,
        model_path: str | None,
        api_key: str | None,
        model: str,
    ):
        if engine == "cloud":
            key = api_key or os.getenv("CVSTREAM_ASR_API_KEY", "")
            return CloudASRWorker(
                {"asr_api_key": key, "asr_model_version": model}, self.export_dir
            )
        selected_model = model_path or os.getenv("CVSTREAM_WHISPER_MODEL", "")
        if not selected_model:
            return UnavailableASRWorker(
                "未配置本地 ASR 模型；官方字幕缺失时请设置 CVSTREAM_WHISPER_MODEL"
            )
        return LocalASRWorker(
            selected_model, str(self.export_dir)
        )


class UnavailableASRWorker:
    """Defers missing-ASR errors until a subtitle fallback is actually needed."""

    def __init__(self, message: str) -> None:
        self.message = message
        self.export_base_dir = Path("exports")

    def extract_media(self, *_args, **_kwargs):
        raise RuntimeError(self.message)

    def transcribe_and_export(self, *_args, **_kwargs):
        raise RuntimeError(self.message)

    def abort(self) -> None:
        return None

    def _cleanup(self) -> None:
        return None


def transcribe_local(
    *, media_path: str, model_path: str, output_dir: str, task_name: str
) -> dict[str, Any]:
    worker = LocalASRWorker(model_path, output_dir)
    worker.temp_video_path = str(Path(media_path).resolve())
    worker.cleanup_temp_media = False
    events = list(worker.transcribe_and_export(task_name))
    final = events[-1] if events else {}
    return {"events": events, "transcriptPath": final.get("txt_path")}


def transcribe_cloud(
    *,
    audio_path: str,
    output_dir: str,
    task_name: str,
    api_key: str | None = None,
    model: str = "paraformer-realtime-v2",
) -> dict[str, Any]:
    worker = CloudASRWorker(
        {
            "asr_api_key": api_key or os.getenv("CVSTREAM_ASR_API_KEY", ""),
            "asr_model_version": model,
        },
        output_dir,
    )
    worker.temp_audio_path = str(Path(audio_path).resolve())
    events = list(worker.transcribe_and_export(task_name))
    final = events[-1] if events else {}
    return {"events": events, "transcriptPath": final.get("txt_path")}


def extract_slides(
    *, video_path: str, output_dir: str, task_name: str, interval_sec: int = 10
) -> dict[str, Any]:
    extractor = PPTExtractor(video_path, output_dir, task_name, interval_sec=interval_sec)
    logs = list(extractor.extract_and_build_pdf())
    pdf_path = Path(output_dir) / f"{task_name}_PPT.pdf"
    return {"pdfPath": str(pdf_path.resolve()) if pdf_path.exists() else None, "logs": logs}


def summarize_course(
    *,
    export_dir: str,
    course_name: str,
    source_type: str = "batch",
    date_teacher: str | None = None,
    transcript_paths: list[str] | None = None,
    content: str | None = None,
    summary_instructions: str | None = None,
    output_name: str | None = None,
    api_key: str | None = None,
    llm_engine: str = "DeepSeek (api.deepseek.com)",
    base_url: str | None = None,
    model: str | None = None,
) -> dict[str, Any]:
    config: dict[str, Any] = {
        "api_key": (
            api_key
            or os.getenv("DEEPSEEK_API_KEY", "")
            or os.getenv("CVSTREAM_LLM_API_KEY", "")
        ),
        "llm_engine": llm_engine,
        "model": model or os.getenv("DEEPSEEK_MODEL", "deepseek-flash"),
    }
    if base_url:
        config["custom_llm_endpoints"] = {llm_engine: base_url}
    summarizer = AISummarizer(config)
    output_path, sources = summarizer.generate_and_save(
        export_base_dir=export_dir,
        course_name=course_name,
        source_type=source_type,
        date_teacher=date_teacher,
        transcript_paths=transcript_paths,
        content=content,
        summary_instructions=summary_instructions,
        output_name=output_name,
    )
    return {
        "status": "completed",
        "sourceType": source_type,
        "sources": sources,
        "model": summarizer.model_name,
        "notePath": str(output_path.resolve()),
        "warnings": summarizer.last_warnings,
    }

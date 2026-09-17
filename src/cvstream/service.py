from __future__ import annotations

import os
import re
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from playwright.sync_api import sync_playwright
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError

from .asr import CloudASRWorker, LocalASRWorker
from .auth import execute_login
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
    """UI-independent facade over the original CVStream capabilities."""

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
        with sync_playwright() as playwright:
            args = ["--disable-blink-features=AutomationControlled"]
            if visible:
                args.extend(["--window-position=0,0", "--start-maximized"])
            else:
                # The target portal has historically rejected Chromium's true
                # headless mode, so use an off-screen normal window.
                args.extend(["--window-position=-32000,-32000", "--window-size=1920,1080"])

            browser = playwright.chromium.launch(headless=False, args=args)
            context = browser.new_context(
                no_viewport=visible,
                viewport=None if visible else {"width": 1920, "height": 1080},
                user_agent=DEFAULT_USER_AGENT,
                locale="zh-CN",
                timezone_id="Asia/Shanghai",
                permissions=["geolocation"],
            )
            page = context.new_page()
            page.add_init_script(
                "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"
            )
            try:
                yield page
            finally:
                context.close()
                browser.close()

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

    def list_courses(self) -> dict[str, Any]:
        with self._page() as page:
            logs = self._login(page)
            catalog = self._open_course_catalog(page)
            catalog.wait_for_timeout(2500)
            courses = self._read_course_cards(catalog)
        return {"count": len(courses), "courses": courses, "logs": logs}

    def search_courses(self, query: str) -> dict[str, Any]:
        query = _required(query, "query")
        with self._page() as page:
            logs = self._login(page)
            catalog = self._open_course_catalog(page)
            search_box = catalog.locator("input[placeholder*='课程名称']").first
            search_box.fill(query)
            catalog.locator("button.el-button--primary").first.click()
            catalog.wait_for_url("**/#/advance-search", timeout=15000)
            catalog.wait_for_timeout(2500)
            courses = self._read_course_cards(catalog)
        return {
            "query": query,
            "count": len(courses),
            "courses": courses,
            "logs": logs,
        }

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
        stop_event = threading.Event()

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
        stop_event = threading.Event()
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
    date_teacher: str,
    api_key: str | None = None,
    llm_engine: str = "DeepSeek (api.deepseek.com)",
    base_url: str | None = None,
) -> dict[str, Any]:
    config: dict[str, Any] = {
        "api_key": (
            api_key
            or os.getenv("DEEPSEEK_API_KEY", "")
            or os.getenv("CVSTREAM_LLM_API_KEY", "")
        ),
        "llm_engine": llm_engine,
    }
    if base_url:
        config["custom_llm_endpoints"] = {llm_engine: base_url}
    summarizer = AISummarizer(config)
    output_path = summarizer.generate_and_save(export_dir, course_name, date_teacher)
    return {"notePath": str(output_path.resolve())}

from __future__ import annotations

import os
import math
import re
from contextlib import contextmanager
from datetime import date
from functools import wraps
from urllib.parse import parse_qs, urlsplit
from pathlib import Path
from typing import Any

from .asr.cloud import MediaWorker
from .cancellation import TaskCancelledError, current_cancel_event, raise_if_cancelled
from .capture import sanitize_filename, _write_text_atomic
from .capture_http import capture_lessons
from .course_http import CourseHTTPClient, CourseAPIError, ENTRY_URL
from .campus_auth import CampusAuthError
from .summary import AISummarizer
from .runtime_paths import env_value


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


def course_result(function):
    @wraps(function)
    def call(*args, **kwargs):
        try:
            return function(*args, **kwargs)
        except CampusAuthError as error:
            return error.result()
        except CourseAPIError as error:
            return {"status": "permission_denied" if error.forbidden else "failed", "message": str(error)}
    return call


class CourseService:
    """Shared HTTP facade for CLI and Web course capabilities."""

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
        self.username = username or env_value("SEUDAILY_USERNAME", "")
        self.password = password or env_value("SEUDAILY_PASSWORD", "")
        self.cookie_file = Path(cookie_file)
        self.export_dir = Path(export_dir)

    @contextmanager
    def _page(self, *, visible: bool = False):
        from .browser_runtime import browser_runtime
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
        requested_teachers = {
            part.strip().casefold()
            for part in re.split(r"[,，、]", teacher_name)
            if part.strip()
        }
        matches = [
            course
            for course in courses
            if course["title"].strip().casefold() == normalized_course
            and (
                requested_teachers
                == {
                    part.strip().casefold()
                    for part in re.split(r"[,，、]", course["teacher"])
                    if part.strip()
                }
                or requested_teachers.intersection(
                    {
                        part.strip().casefold()
                        for part in re.split(r"[,，、]", course["teacher"])
                        if part.strip()
                    }
                )
            )
        ]
        return matches

    @staticmethod
    def _merge_capture_status(session: dict[str, Any], statuses: list[dict[str, Any]]) -> None:
        by_period = {item.get("periodNumber"): item for item in statuses}
        for lesson in session.get("lessons", []):
            status = by_period.get(lesson.get("periodNumber"))
            if status:
                lesson.update({key: value for key, value in status.items() if key != "periodNumber"})

    @staticmethod
    def _capture_summary(statuses: list[dict[str, Any]], artifacts: list[dict[str, Any]]) -> dict[str, Any]:
        failures = [item["failure"] for item in statuses if item.get("failure")]
        return {
            "videoAvailable": sum(1 for item in statuses if item.get("videoAvailable")),
            "officialSubtitleAvailable": sum(1 for item in statuses if item.get("officialSubtitleAvailable")),
            "mediaSaved": sum(1 for item in statuses if item.get("mediaSaved")),
            "asrAttempted": sum(1 for item in statuses if item.get("asrAttempted")),
            "asrCompleted": sum(1 for item in statuses if item.get("asrCompleted")),
            "artifactCount": len(artifacts),
            "failures": failures,
        }

    @staticmethod
    def _capture_message(capture: dict[str, Any]) -> str:
        video = capture["videoAvailable"]
        official = capture["officialSubtitleAvailable"]
        saved = capture["mediaSaved"]
        asr_attempted = capture["asrAttempted"]
        asr_completed = capture["asrCompleted"]
        artifact_count = capture["artifactCount"]
        failures = capture["failures"]
        if artifact_count and not video:
            return f"已复用课程资料，返回 {artifact_count} 个产物，无需重新下载。"
        if video and artifact_count:
            message = f"课程处理完成：定位到 {video} 节录像，官方字幕 {official} 节，生成 {artifact_count} 个产物。"
            return message + (f" 部分资源未完成：{failures[0]}" if failures else "")
        if video and failures:
            reason = failures[0]
            asr_status = "已完成" if asr_completed else "已尝试但失败" if asr_attempted else "未执行"
            return f"已定位到 {video} 节录像，但未生成字幕产物。官方字幕 {official} 节；ASR {asr_status}。原因：{reason}。媒体{'已保存' if saved else '未保存（keepMedia=false）'}。"
        if video:
            return f"已定位到 {video} 节录像，但没有官方字幕；ASR {'已完成' if asr_completed else '未执行'}，生成 0 个产物。媒体{'已保存' if saved else '未保存（keepMedia=false）'}。"
        return f"未定位到可播放录像，生成 {artifact_count} 个产物。"

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

    def _build_asr_worker(
        self,
        *,
        engine: str,
        model_path: str | None,
        api_key: str | None,
        model: str,
    ):
        if engine == "cloud":
            from .asr.cloud import CloudASRWorker

            key = api_key or env_value("SEUDAILY_ASR_API_KEY", "")
            return CloudASRWorker(
                {"asr_api_key": key, "asr_model_version": model}, self.export_dir
            )
        return UnavailableASRWorker(
            "本地 ASR 暂未支持；官方字幕缺失时请配置云 ASR 并选择 cloud 引擎"
        )

    def _http(self):
        return CourseHTTPClient(self.cookie_file, username=self.username, password=self.password)

    @course_result
    def authorize(self):
        try:
            with self._http() as client:
                client.authenticate()
        except CampusAuthError as error:
            if error.status not in {"auth_required", "captcha_required", "credentials_missing"}:
                raise
            # Only an explicit login action may open a visible browser.
            with self._page(visible=True) as page:
                page.goto(ENTRY_URL, wait_until="domcontentloaded", timeout=30000)
                if urlsplit(page.url).hostname == "auth.seu.edu.cn" and self.username and self.password:
                    user = page.locator("input[placeholder*='一卡通'], .input-username-pc").first
                    user.wait_for(state="visible", timeout=10000)
                    user.fill(self.username)
                    page.locator("input[type='password']").first.fill(self.password)
                    page.locator("button:has-text('登 录'), .login-button-pc, .ant-btn-primary").first.click()
                page.wait_for_url(lambda url: urlsplit(url).hostname == "cvs.seu.edu.cn" and
                    urlsplit(url).path.startswith("/jy-application-resourcemanage-ui/"), timeout=120000)
                # Interactive verification may issue new SSO cookies after the first submit.
                import json
                self.cookie_file.parent.mkdir(parents=True, exist_ok=True)
                _write_text_atomic(self.cookie_file, json.dumps(page.context.cookies()))
            with self._http() as client:
                client.authenticate()
        return {"status": "authorized", "cookieFile": str(self.cookie_file.resolve()),
                "logs": ["课程应用登录态已建立。"]}

    def _semester_info(self, client, semester=None):
        terms = client.get("/v1/list/termYear")
        names = [f"{term['acyeCode']}学年第{term['acteTerm']}学期" for term in terms]
        requested = (semester or "").strip()
        if requested.casefold() in {"all", "全部", "全部学期"}:
            return None, {"found": True, "requestedSemester": semester,
                          "selectedSemester": "全部学期", "availableSemesters": names}
        if not requested or requested.casefold() in {"current", "当前", "当前学期"}:
            selected = next((i for i, term in enumerate(terms) if term.get("currentTerm") is True), None)
        else:
            matched = self._match_semester_option(names, requested)
            selected = names.index(matched) if matched is not None else None
        return (terms[selected]["id"] if selected is not None else None), {
            "found": selected is not None, "requestedSemester": semester,
            "selectedSemester": names[selected] if selected is not None else None,
            "availableSemesters": names}

    @staticmethod
    def _courses(rows):
        courses = []
        for index, row in enumerate(rows):
            semester = str(row.get("acteName") or "")
            if row.get("acyeBeginYear") is not None:
                semester = f"{row['acyeBeginYear']}-{row['acyeEndYear']}学年第{semester}学期"
            teacher = row.get("teacNames") or []
            if isinstance(teacher, list):
                teacher = ",".join(teacher)
            courses.append({"index": index, "title": row["subjName"], "teacher": teacher,
                "semester": semester, "lessonCount": str(row.get("courTimes") or row.get("vodCourseNum") or 0),
                "playCount": str(row.get("courPlayCount") or 0), "teclId": row["teclId"]})
        return courses

    def _search(self, client, query=None, semester=None):
        term, info = self._semester_info(client, semester)
        if not info["found"]:
            return [], info
        params = {"page.orders[0].asc": "false", "page.orders[0].field": "updateTime"}
        if term is not None:
            params["acteId"] = term
        path = "/v1/group_subject_vod_list/t-1"
        if query:
            path = "/v1/union/vod_live_new"
            params.update({"unionName": query, "courStatus": 1})
        courses = self._courses(client.records(path, params))
        return courses, info

    @course_result
    def list_courses(self):
        with self._http() as client:
            courses, info = self._search(client)
        result = {"status": "completed" if courses else "empty", "availableSemesters": info["availableSemesters"],
                  "count": len(courses), "courses": courses, "logs": []}
        if not courses:
            result["hint"] = self._course_not_found_hint()
        return result

    @course_result
    def search_courses(self, query, semester=None):
        query = _required(query, "query")
        with self._http() as client:
            courses, info = self._search(client, query, semester)
        result = {"status": "completed" if courses else "empty", "query": query, **info,
                  "count": len(courses), "courses": courses, "logs": []}
        if not courses:
            result["hint"] = self._course_not_found_hint()
        return result

    def _lessons(self, client, course):
        rows = client.records("/v1/subject_vod_list_new", {"teclIds": course["teclId"],
            "page.orders[0].asc": "false", "page.orders[0].field": "courBeginTime"})
        lessons = []
        for index, row in enumerate(rows):
            stamp = str(row["courBeginTime"])
            period = row.get("letiNumber")
            lessons.append({"sequence": index + 1, "title": f"第{period}节", "periodNumber": period,
                "date": stamp[:10], "time": stamp[11:16], "classroom": row.get("clroName") or "",
                "hasAiContent": bool(row.get("courTransferFlag")), "courseId": row["id"]})
        return lessons

    @course_result
    def list_course_sessions(self, *, course_name, teacher_name, semester=None):
        course_name = _required(course_name, "courseName")
        teacher_name = _required(teacher_name, "teacherName")
        with self._http() as client:
            courses, info = self._search(client, course_name, semester)
            matches = self._exact_course_matches(courses, course_name, teacher_name)
            grouped = {}
            for course in matches:
                for session in self._sessions_from_lessons(self._lessons(client, course)):
                    row = grouped.setdefault(session["date"], {"date": session["date"], "periodNumbers": [], "teachers": []})
                    row["periodNumbers"] = sorted(set(row["periodNumbers"]) | set(session["periodNumbers"]))
                    if teacher_name not in row["teachers"]:
                        row["teachers"].append(teacher_name)
        return {"status": "completed" if matches else "course_not_found", "courseName": course_name,
                "teacherName": teacher_name, "semester": semester, **info, "courses": matches,
                "sessions": sorted(grouped.values(), key=lambda row: row["date"]), "logs": []}

    def _resolve(self, client, *, course_name, teacher_name, weekly_periods, course_date=None, semester=None):
        course_name = _required(course_name, "courseName")
        teacher_name = _required(teacher_name, "teacherName")
        weekly_periods = self._normalize_periods(weekly_periods)
        courses, info = self._search(client, course_name, semester)
        matches = self._exact_course_matches(courses, course_name, teacher_name)
        common = {"courseName": course_name, "teacherName": teacher_name, "weeklyPeriods": weekly_periods,
                  "requestedDate": course_date, **info}
        if not matches:
            return {"status": "course_not_found", **common, "semester": semester, "candidates": courses,
                    "hint": self._course_not_found_hint()}
        resolved, rejected = [], []
        for course in matches:
            selection = self._select_session(self._lessons(client, course), weekly_periods, course_date)
            if selection["status"] == "found":
                resolved.append({"course": course, "session": selection["session"]})
            else:
                rejected.append({"course": course, **selection})
        if not resolved:
            return {"status": rejected[0]["status"] if len(rejected) == 1 else "session_not_found",
                    **common, "candidates": rejected, "hint": self._course_not_found_hint()}
        if len(resolved) > 1:
            return {"status": "ambiguous", **common, "candidates": resolved}
        return {"status": "found", **resolved[0]}

    @course_result
    def find_course_session(self, *, course_name, teacher_name, weekly_periods, course_date=None, semester=None):
        with self._http() as client:
            return {**self._resolve(client, course_name=course_name, teacher_name=teacher_name,
                weekly_periods=weekly_periods, course_date=course_date, semester=semester), "logs": []}

    def _capture(self, client, course, session, *, need_subtitle=True, need_ppt=False, keep_media=False,
                 asr_engine="local", model_path=None, asr_api_key=None, asr_model="paraformer-realtime-v2",
                 official_only=False):
        worker = self._build_asr_worker(engine=asr_engine, model_path=model_path, api_key=asr_api_key, model=asr_model)
        statuses, logs = capture_lessons(client, course, session["lessons"], worker, self.export_dir,
            current_cancel_event(), need_subtitle=need_subtitle, need_ppt=need_ppt, keep_media=keep_media,
            official_only=official_only)
        self._merge_capture_status(session, statuses)
        artifacts = self._collect_session_artifacts(course, session)
        capture = self._capture_summary(statuses, artifacts)
        return {"status": "completed" if artifacts else "completed_without_artifact",
                "message": self._capture_message(capture), "course": course, "session": session,
                "capture": capture, "artifacts": artifacts, "logs": logs}

    @course_result
    def capture_course_session(self, *, course_name, teacher_name, weekly_periods, course_date=None,
                               semester=None, **options):
        with self._http() as client:
            result = self._resolve(client, course_name=course_name, teacher_name=teacher_name,
                weekly_periods=weekly_periods, course_date=course_date, semester=semester)
            if result["status"] != "found":
                return {**result, "logs": []}
            return self._capture(client, result["course"], result["session"], **options)

    def capture_course_sessions(self, *, sessions, max_concurrency=2, **options):
        if not sessions:
            raise ValueError("sessions 至少需要一个课程")
        if not 1 <= max_concurrency <= 2:
            raise ValueError("maxConcurrency 必须在 1 到 2 之间")
        results = []
        for session in sessions:
            raise_if_cancelled()
            try:
                result = self.capture_course_session(course_name=session["courseName"],
                    teacher_name=session["teacherName"], weekly_periods=session["weeklyPeriods"],
                    course_date=session.get("courseDate"), semester=session.get("semester"), **options)
            except TaskCancelledError:
                raise
            except Exception as error:
                result = {"status": "failed", "error": "课程处理失败。", "errorType": type(error).__name__}
            results.append(result)
        completed = sum(row.get("status", "").startswith("completed") for row in results)
        video = sum(row.get("capture", {}).get("videoAvailable", 0) for row in results)
        artifacts = sum(len(row.get("artifacts", [])) for row in results)
        return {"status": "completed" if completed == len(results) else "partial",
                "message": f"批量处理完成：定位到 {video} 节录像，生成 {artifacts} 个产物。",
                "count": len(results), "completed": completed, "requestedConcurrency": max_concurrency,
                "effectiveConcurrency": 1, "results": results,
                "warnings": ["批次串行处理以限制媒体与 ASR 的峰值资源使用。"] if max_concurrency > 1 else []}

    def _lesson_target(self, client, course_name, teacher_name, lesson_number):
        if lesson_number < 1:
            raise ValueError("lessonNumber 必须大于 0")
        course_name = _required(course_name, "courseName")
        teacher_name = _required(teacher_name, "teacherName")
        courses, _info = self._search(client, course_name)
        matches = self._exact_course_matches(courses, course_name, teacher_name)
        if len(matches) != 1:
            return {"status": "ambiguous" if matches else "not_found", "courseName": course_name,
                    "teacherName": teacher_name, "lessonNumber": lesson_number, "candidates": matches or courses}
        course = matches[0]
        lessons = self._lessons(client, course)
        lesson = next((row for row in lessons if row["sequence"] == lesson_number), None)
        if lesson is None:
            return {"status": "lesson_not_found", "course": course, "lessonNumber": lesson_number,
                    "availableLessons": lessons}
        return {"status": "found", "course": course, "lesson": lesson}

    @course_result
    def find_course_lesson(self, *, course_name, teacher_name, lesson_number):
        with self._http() as client:
            return {**self._lesson_target(client, course_name, teacher_name, lesson_number), "logs": []}

    @course_result
    def capture_course_lesson(self, *, course_name, teacher_name, lesson_number, **options):
        with self._http() as client:
            result = self._lesson_target(client, course_name, teacher_name, lesson_number)
            if result["status"] != "found":
                return {**result, "logs": []}
            lesson = result["lesson"]
            session = {"date": lesson["date"], "lessons": [lesson]}
            captured = self._capture(client, result["course"], session, **options)
            captured.pop("session")
            return {**captured, "lesson": lesson}

    def _url_target(self, client):
        parsed = urlsplit(self.target_url)
        if parsed.hostname != "cvs.seu.edu.cn":
            raise ValueError("课程链接必须属于 cvs.seu.edu.cn")
        params = parse_qs(parsed.query or parsed.fragment.partition("?")[2])
        course_id = params.get("courseId", params.get("courId", []))
        tecl_id = params.get("teclId", [])
        if course_id:
            play = client.play(int(course_id[0]))
        elif tecl_id:
            meta = client.get("/v1/getVodCourseVideo", {"teclId": int(tecl_id[0])}).get("data") or {}
            if not meta.get("courId"):
                raise CourseAPIError("课程链接没有可用课次。")
            play = client.play(meta["courId"])
        else:
            raise ValueError("请提供含 courseId 或 teclId 的课程详情链接，或使用按课程目标抓取工具。")
        teachers = [row["teacherName"] for row in play.get("tecList", []) if row.get("teacherName")]
        course = {"title": play["courName"], "teacher": play.get("tecName") or ",".join(teachers),
                  "teclId": play["teclId"]}
        return course, self._lessons(client, course)

    @course_result
    def list_dates(self):
        with self._http() as client:
            _course, lessons = self._url_target(client)
        return {"dates": sorted({row["date"] for row in lessons}, reverse=True), "logs": []}

    @course_result
    def capture_course(self, *, target_date="自动获取最新", **options):
        with self._http() as client:
            course, lessons = self._url_target(client)
            sessions = self._sessions_from_lessons(lessons)
            if target_date == "全部日期":
                selected = sessions
            elif target_date == "自动获取最新" or not target_date:
                selected = sessions[:1]
            else:
                selected = [row for row in sessions if row["date"] == target_date]
            if not selected:
                return {"status": "date_not_found", "availableSessions": sessions, "logs": []}
            results = [self._capture(client, course, row, official_only=target_date == "全部日期", **options)
                       for row in selected]
        return {"exportDir": str(self.export_dir.resolve()), "results": results,
                "logs": [log for row in results for log in row["logs"]]}


class UnavailableASRWorker(MediaWorker):
    """Defers missing-ASR errors until a subtitle fallback is actually needed."""

    can_transcribe = False

    def __init__(self, message: str) -> None:
        super().__init__({}, "exports")
        self.message = message

    def transcribe_and_export(self, *_args, **_kwargs):
        raise RuntimeError(self.message)


def transcribe_local(
    *, media_path: str, model_path: str, output_dir: str, task_name: str
) -> dict[str, Any]:
    raise RuntimeError("本地 ASR 暂未支持；请使用官方字幕或云 ASR")


def transcribe_cloud(
    *,
    audio_path: str,
    output_dir: str,
    task_name: str,
    api_key: str | None = None,
    model: str = "paraformer-realtime-v2",
) -> dict[str, Any]:
    from .asr.cloud import CloudASRWorker

    worker = CloudASRWorker(
        {
            "asr_api_key": api_key or env_value("SEUDAILY_ASR_API_KEY", ""),
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
    if not math.isfinite(interval_sec) or interval_sec <= 0:
        raise ValueError("intervalSec 必须为有限正数")
    try:
        from .ppt import PPTExtractor
    except ModuleNotFoundError as error:
        raise RuntimeError("未安装 PPT 可选依赖；请运行 uv sync --frozen --extra ppt") from error

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
            or env_value("SEUDAILY_LLM_API_KEY", "")
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

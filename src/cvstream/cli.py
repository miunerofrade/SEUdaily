from __future__ import annotations

import json
import sys
import traceback
from typing import Any

from .service import (
    CourseService,
    extract_slides,
    summarize_course,
    transcribe_cloud,
    transcribe_local,
)
from .schedule import ScheduleService
from .jwc import CseService, JwcService


def _course_service(payload: dict[str, Any]) -> CourseService:
    return CourseService(
        target_url=payload.get("targetUrl", "https://cvs.seu.edu.cn"),
        username=payload.get("username"),
        password=payload.get("password"),
        cookie_file=payload.get("cookieFile", "cookies.json"),
        export_dir=payload.get("exportDir", "exports"),
    )


def _schedule_service(payload: dict[str, Any]) -> ScheduleService:
    return ScheduleService(
        target_url=payload.get(
            "targetUrl",
            "https://ehall.seu.edu.cn/jwapp/sys/wdkb/*default/index.do",
        ),
        cookie_file=payload.get("cookieFile", ".cvstream/ehall-cookies.json"),
        cache_file=payload.get("cacheFile", ".cvstream/schedule.json"),
        username=payload.get("username"),
        password=payload.get("password"),
    )


def _jwc_service(payload: dict[str, Any]) -> JwcService:
    if payload.get("site") == "cse":
        return CseService(
            base_url=payload.get("baseUrl", "https://cse.seu.edu.cn"),
            cache_dir=payload.get("cacheDir", ".cvstream/cse"),
            timeout_seconds=payload.get("timeoutSeconds", 15),
            background_sync=payload.get("backgroundSync", True),
        )
    return JwcService(
        base_url=payload.get("baseUrl", "https://jwc.seu.edu.cn"),
        cache_dir=payload.get("cacheDir", ".cvstream/jwc"),
        timeout_seconds=payload.get("timeoutSeconds", 15),
        background_sync=payload.get("backgroundSync", True),
    )


def _resolve_course_target(
    payload: dict[str, Any], target: dict[str, Any]
) -> dict[str, Any]:
    source = target.get("source", "manual")
    course_date = target.get("courseDate")
    if source == "schedule":
        schedule_id = target.get("scheduleId")
        if not schedule_id:
            raise ValueError("schedule 目标必须提供 scheduleId")
        course = ScheduleService(
            cache_file=payload.get("scheduleCacheFile", ".cvstream/schedule.json")
        ).resolve_course(schedule_id)
        return {
            "courseName": course["courseName"],
            "teacherName": course["teacherName"],
            "weeklyPeriods": course["weeklyPeriods"],
            "courseDate": course_date,
            "scheduleId": schedule_id,
        }
    if source == "manual":
        missing = [
            name
            for name in ("courseName", "teacherName", "weeklyPeriods")
            if not target.get(name)
        ]
        if missing:
            raise ValueError(f"manual 目标缺少字段: {', '.join(missing)}")
        return {
            "courseName": target["courseName"],
            "teacherName": target["teacherName"],
            "weeklyPeriods": target["weeklyPeriods"],
            "courseDate": course_date,
        }
    raise ValueError("target.source 必须是 schedule 或 manual")


def dispatch(request: dict[str, Any]) -> dict[str, Any]:
    action = request.get("action")
    payload = request.get("payload") or {}

    if action == "health":
        return {"version": "0.3.0", "tools": [
            "authorize", "authorize-schedule", "get-schedule", "list-courses", "search-courses", "find-course-session", "capture-course-session", "capture-course-sessions", "transcribe-local", "transcribe-cloud",
            "extract-slides", "summarize-course", "search-jwc", "get-jwc-article", "search-cse", "get-cse-article",
        ]}
    if action == "authorize":
        return _course_service(payload).authorize()
    if action == "authorize-schedule":
        return _schedule_service(payload).authorize(
            timeout_seconds=payload.get("timeoutSeconds", 300)
        )
    if action == "get-schedule":
        return _schedule_service(payload).get_schedule(
            refresh=payload.get("refresh", False)
        )
    if action in {"search-jwc", "search-cse"}:
        if action == "search-cse":
            payload["site"] = "cse"
        return _jwc_service(payload).search(
            payload["query"],
            keywords=payload.get("keywords"),
            categories=payload.get("categories"),
            freshness=payload.get("freshness", "balanced"),
            time_scope=payload.get("timeScope", "any"),
            recent_days=payload.get("recentDays", 7),
            limit=payload.get("limit", 5),
        )
    if action in {"get-jwc-article", "get-cse-article"}:
        if action == "get-cse-article":
            payload["site"] = "cse"
        return _jwc_service(payload).get_article(
            payload["articleId"], refresh=payload.get("refresh", True)
        )
    if action == "list-courses":
        return _course_service(payload).list_courses()
    if action == "search-courses":
        return _course_service(payload).search_courses(payload["query"])
    if action == "find-course-session":
        target = _resolve_course_target(payload, payload.get("target", payload))
        return _course_service(payload).find_course_session(
            course_name=target["courseName"],
            teacher_name=target["teacherName"],
            weekly_periods=target["weeklyPeriods"],
            course_date=target.get("courseDate"),
        )
    if action == "capture-course-session":
        target = _resolve_course_target(payload, payload.get("target", payload))
        return _course_service(payload).capture_course_session(
            course_name=target["courseName"],
            teacher_name=target["teacherName"],
            weekly_periods=target["weeklyPeriods"],
            course_date=target.get("courseDate"),
            need_subtitle=payload.get("needSubtitle", True),
            need_ppt=payload.get("needPpt", False),
            keep_media=payload.get("keepMedia", False),
            asr_engine=payload.get("asrEngine", "local"),
            model_path=payload.get("modelPath"),
            asr_api_key=payload.get("asrApiKey"),
            asr_model=payload.get("asrModel", "paraformer-realtime-v2"),
        )
    if action == "capture-course-sessions":
        raw_targets = payload.get("targets", payload.get("sessions", []))
        sessions = [
            _resolve_course_target(payload, target) for target in raw_targets
        ]
        return _course_service(payload).capture_course_sessions(
            sessions=sessions,
            max_concurrency=payload.get("maxConcurrency", 2),
            need_subtitle=payload.get("needSubtitle", True),
            need_ppt=payload.get("needPpt", False),
            keep_media=payload.get("keepMedia", False),
            asr_engine=payload.get("asrEngine", "local"),
            model_path=payload.get("modelPath"),
            asr_api_key=payload.get("asrApiKey"),
            asr_model=payload.get("asrModel", "paraformer-realtime-v2"),
        )
    if action == "list-dates":
        return _course_service(payload).list_dates()
    if action == "capture-course":
        return _course_service(payload).capture_course(
            target_date=payload.get("targetDate", "自动获取最新"),
            need_subtitle=payload.get("needSubtitle", True),
            need_ppt=payload.get("needPpt", False),
            keep_media=payload.get("keepMedia", False),
            asr_engine=payload.get("asrEngine", "local"),
            model_path=payload.get("modelPath"),
            asr_api_key=payload.get("asrApiKey"),
            asr_model=payload.get("asrModel", "paraformer-realtime-v2"),
        )
    if action == "transcribe-local":
        return transcribe_local(
            media_path=payload["mediaPath"],
            model_path=payload["modelPath"],
            output_dir=payload.get("outputDir", "exports/subtitle"),
            task_name=payload["taskName"],
        )
    if action == "transcribe-cloud":
        return transcribe_cloud(
            audio_path=payload["audioPath"],
            output_dir=payload.get("outputDir", "exports/subtitle"),
            task_name=payload["taskName"],
            api_key=payload.get("apiKey"),
            model=payload.get("model", "paraformer-realtime-v2"),
        )
    if action == "extract-slides":
        return extract_slides(
            video_path=payload["videoPath"],
            output_dir=payload.get("outputDir", "exports/media"),
            task_name=payload["taskName"],
            interval_sec=payload.get("intervalSec", 10),
        )
    if action == "summarize-course":
        return summarize_course(
            export_dir=payload.get("exportDir", "exports"),
            course_name=payload["courseName"],
            source_type=payload.get("sourceType", "batch"),
            date_teacher=payload.get("dateTeacher"),
            transcript_paths=payload.get("transcriptPaths"),
            content=payload.get("content"),
            summary_instructions=payload.get("summaryInstructions"),
            output_name=payload.get("outputName"),
            api_key=payload.get("apiKey"),
            llm_engine=payload.get("llmEngine", "DeepSeek (api.deepseek.com)"),
            base_url=payload.get("baseUrl"),
            model=payload.get("model"),
        )
    raise ValueError(f"未知工具动作: {action}")


def main() -> None:
    try:
        if len(sys.argv) >= 3 and sys.argv[1] == "jwc-worker":
            payload = json.loads(sys.argv[2])
            payload["backgroundSync"] = False
            _jwc_service(payload).sync_pending()
            return
        request = json.load(sys.stdin)
        result = dispatch(request)
        print(json.dumps({"ok": True, "data": result}, ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({
            "ok": False,
            "error": str(exc),
            "type": type(exc).__name__,
        }, ensure_ascii=False))
        traceback.print_exc(file=sys.stderr)
        raise SystemExit(1) from exc


if __name__ == "__main__":
    main()

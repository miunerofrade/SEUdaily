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


def _course_service(payload: dict[str, Any]) -> CourseService:
    return CourseService(
        target_url=payload.get("targetUrl", "https://cvs.seu.edu.cn"),
        username=payload.get("username"),
        password=payload.get("password"),
        cookie_file=payload.get("cookieFile", "cookies.json"),
        export_dir=payload.get("exportDir", "exports"),
    )


def dispatch(request: dict[str, Any]) -> dict[str, Any]:
    action = request.get("action")
    payload = request.get("payload") or {}

    if action == "health":
        return {"version": "0.3.0", "tools": [
            "authorize", "list-courses", "search-courses", "find-course-session", "capture-course-session", "capture-course-sessions", "transcribe-local", "transcribe-cloud",
            "extract-slides", "summarize-course",
        ]}
    if action == "authorize":
        return _course_service(payload).authorize()
    if action == "list-courses":
        return _course_service(payload).list_courses()
    if action == "search-courses":
        return _course_service(payload).search_courses(payload["query"])
    if action == "find-course-session":
        return _course_service(payload).find_course_session(
            course_name=payload["courseName"],
            teacher_name=payload["teacherName"],
            weekly_periods=payload["weeklyPeriods"],
            course_date=payload.get("courseDate"),
        )
    if action == "capture-course-session":
        return _course_service(payload).capture_course_session(
            course_name=payload["courseName"],
            teacher_name=payload["teacherName"],
            weekly_periods=payload["weeklyPeriods"],
            course_date=payload.get("courseDate"),
            need_subtitle=payload.get("needSubtitle", True),
            need_ppt=payload.get("needPpt", False),
            keep_media=payload.get("keepMedia", False),
            asr_engine=payload.get("asrEngine", "local"),
            model_path=payload.get("modelPath"),
            asr_api_key=payload.get("asrApiKey"),
            asr_model=payload.get("asrModel", "paraformer-realtime-v2"),
        )
    if action == "capture-course-sessions":
        return _course_service(payload).capture_course_sessions(
            sessions=payload["sessions"],
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

from __future__ import annotations

import json
import sys
import traceback
from typing import Any

from . import __version__
from .document_parser import parse_document
from .service import (
    CourseService,
    extract_slides,
    summarize_course,
    transcribe_cloud,
    transcribe_local,
)
from .schedule import ScheduleService
from .focus import FocusService
from .jwc import CseService, JwcService
from .protocol import normalize_tool_result
from .training_plan import TrainingPlanService
from .web_reader import read_web_page


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
        customization_file=payload.get(
            "customizationFile", ".cvstream/schedule-user.json"
        ),
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


def _focus_service(payload: dict[str, Any]) -> FocusService:
    return FocusService(
        state_file=payload.get("stateFile", ".cvstream/focus.json"),
        schedule_cache_file=payload.get("scheduleCacheFile", ".cvstream/schedule.json"),
        schedule_customization_file=payload.get(
            "scheduleCustomizationFile", ".cvstream/schedule-user.json"
        ),
        export_dir=payload.get("exportDir", "exports"),
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
        ).resolve_course(schedule_id, semester=target.get("semester"))
        resolved = {
            "courseName": course["courseName"],
            "teacherName": course["teacherName"],
            "weeklyPeriods": course["weeklyPeriods"],
            "courseDate": course_date,
            "scheduleId": schedule_id,
        }
        resolved_semester = target.get("semester") or course.get("semester")
        if resolved_semester:
            resolved["semester"] = resolved_semester
        return resolved
    if source == "manual":
        missing = [
            name
            for name in ("courseName", "teacherName", "weeklyPeriods")
            if not target.get(name)
        ]
        if missing:
            raise ValueError(f"manual 目标缺少字段: {', '.join(missing)}")
        resolved = {
            "courseName": target["courseName"],
            "teacherName": target["teacherName"],
            "weeklyPeriods": target["weeklyPeriods"],
            "courseDate": course_date,
        }
        if target.get("semester"):
            resolved["semester"] = target["semester"]
        return resolved
    raise ValueError("target.source 必须是 schedule 或 manual")


def dispatch(request: dict[str, Any]) -> dict[str, Any]:
    action = request.get("action")
    payload = request.get("payload") or {}

    if action == "health":
        return {"version": __version__, "tools": [
            "authorize", "authorize-schedule", "get-schedule", "save-schedule-customizations", "list-courses", "search-courses", "list-course-sessions", "find-course-session", "capture-course-session", "capture-course-sessions", "transcribe-local", "transcribe-cloud",
            "extract-slides", "summarize-course", "read-web-page", "list-jwc", "search-jwc", "get-jwc-article", "search-cse", "get-cse-article", "get-training-plan", "analyze-training-plan", "list-focus", "upsert-focus", "delete-focus", "claim-focus-agent-run", "record-focus-agent-run", "run-focus-cycle", "run-course-focus-queue", "acknowledge-course-focus-alert",
        ]}
    if action == "authorize":
        return _course_service(payload).authorize()
    if action == "authorize-schedule":
        return _schedule_service(payload).authorize(
            timeout_seconds=payload.get("timeoutSeconds", 300),
            reset_session=payload.get("resetSession", True),
        )
    if action == "get-schedule":
        return _schedule_service(payload).get_schedule(
            refresh=payload.get("refresh", False),
            semester=payload.get("semester"),
            include_available_semesters=payload.get(
                "includeAvailableSemesters", False
            ),
            prefetch_available_semesters=payload.get(
                "prefetchAvailableSemesters", False
            ),
        )
    if action == "save-schedule-customizations":
        return _schedule_service(payload).save_customizations(payload)
    if action == "list-focus":
        return _focus_service(payload).list()
    if action == "upsert-focus":
        return _focus_service(payload).upsert(payload.get("item", payload))
    if action == "delete-focus":
        return _focus_service(payload).delete(payload["focusId"])
    if action == "claim-focus-agent-run":
        return _focus_service(payload).claim_agent_run(
            payload["focusId"],
            force=bool(payload.get("force", False)),
            respect_interval=bool(payload.get("respectInterval", True)),
        )
    if action == "record-focus-agent-run":
        return _focus_service(payload).record_agent_run(
            payload["focusId"],
            status=str(payload.get("runStatus") or "completed"),
            message=str(payload.get("message") or ""),
            run_id=str(payload.get("runId") or ""),
        )
    if action == "run-focus-cycle":
        return _focus_service(payload).run_cycle(
            respect_interval=bool(payload.get("respectInterval", False))
        )
    if action == "run-course-focus-queue":
        return _focus_service(payload).run_course_queue()
    if action == "acknowledge-course-focus-alert":
        return _focus_service(payload).acknowledge_course_alert(payload["jobKey"])
    if action in {"get-training-plan", "search-training-plans"}:
        return TrainingPlanService(
            cookie_file=payload.get("cookieFile", ".cvstream/ehall-cookies.json"),
            cache_file=payload.get("cacheFile", ".cvstream/training-plan.json"),
            schedule_cache_file=payload.get(
                "scheduleCacheFile", ".cvstream/schedule.json"
            ),
        ).get(refresh=bool(payload.get("refresh", False)))
    if action == "analyze-training-plan":
        return TrainingPlanService(
            cookie_file=payload.get("cookieFile", ".cvstream/ehall-cookies.json"),
            cache_file=payload.get("cacheFile", ".cvstream/training-plan.json"),
            schedule_cache_file=payload.get(
                "scheduleCacheFile", ".cvstream/schedule.json"
            ),
        ).audit(
            refresh=bool(payload.get("refresh", False)),
            plan_id=str(payload.get("planId") or ""),
        )
    if action in {"list-jwc", "search-jwc", "search-cse"}:
        if action == "search-cse":
            payload["site"] = "cse"
        if action == "list-jwc":
            return _jwc_service(payload).list_articles(
                categories=payload.get("categories"),
                paths=payload.get("paths"),
                freshness=payload.get("freshness", "latest"),
                time_scope=payload.get("timeScope", "any"),
                recent_days=payload.get("recentDays", 7),
                limit=payload.get("limit", 5),
            )
        return _jwc_service(payload).search(
            payload["query"],
            categories=payload.get("categories"),
            paths=payload.get("paths"),
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
    if action == "read-web-page":
        return read_web_page(
            payload["url"],
            query=payload.get("query", ""),
            include_attachments=payload.get("includeAttachments", "auto"),
            max_attachments=payload.get("maxAttachments", 3),
            timeout_seconds=payload.get("timeoutSeconds", 20),
        )
    if action == "list-courses":
        return _course_service(payload).list_courses()
    if action == "search-courses":
        return _course_service(payload).search_courses(
            payload["query"], semester=payload.get("semester")
        )
    if action == "list-course-sessions":
        return _course_service(payload).list_course_sessions(
            course_name=payload["courseName"],
            teacher_name=payload["teacherName"],
            semester=payload.get("semester"),
        )
    if action == "find-course-session":
        target = _resolve_course_target(payload, payload.get("target", payload))
        return _course_service(payload).find_course_session(
            course_name=target["courseName"],
            teacher_name=target["teacherName"],
            weekly_periods=target["weeklyPeriods"],
            course_date=target.get("courseDate"),
            semester=target.get("semester"),
        )
    if action == "capture-course-session":
        target = _resolve_course_target(payload, payload.get("target", payload))
        return _course_service(payload).capture_course_session(
            course_name=target["courseName"],
            teacher_name=target["teacherName"],
            weekly_periods=target["weeklyPeriods"],
            course_date=target.get("courseDate"),
            semester=target.get("semester"),
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
    if action == "parse-document":
        return parse_document(path=payload["path"], filename=payload.get("filename"))
    raise ValueError(f"未知工具动作: {action}")


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8")
    try:
        if len(sys.argv) >= 3 and sys.argv[1] == "jwc-worker":
            payload = json.loads(sys.argv[2])
            payload["backgroundSync"] = False
            _jwc_service(payload).sync_pending()
            return
        request = json.load(sys.stdin)
        result = dispatch(request)
        result = normalize_tool_result(
            request.get("action", "unknown"),
            result,
            requested_task_id=(request.get("payload") or {}).get("taskId"),
        )
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

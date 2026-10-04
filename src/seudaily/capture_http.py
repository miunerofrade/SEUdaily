"""Course resources obtained from APIs; media processing remains an explicit fallback."""
from pathlib import Path

from .campus_auth import CampusAuthError
from .cancellation import TaskCancelledError, raise_if_cancelled
from .capture import _copy_atomic, _valid_artifact, process_official_json, sanitize_filename
from .course_http import CourseAPIError, UI_URL


def capture_lessons(client, course, lessons, worker, export_dir, stop_event, *,
                    need_subtitle=True, need_ppt=False, keep_media=False,
                    official_only=False):
    statuses, logs = [], []
    for lesson in lessons:
        raise_if_cancelled()
        day = lesson["date"].replace("-", "")
        period = lesson.get("periodNumber") or lesson["sequence"]
        task = f"{day}-{period}"
        batch = f"{day}-{sanitize_filename(course['teacher'])}"
        subtitle_dir = Path(export_dir) / "subtitle" / sanitize_filename(course["title"]) / batch
        media_dir = Path(export_dir) / "media" / sanitize_filename(course["title"]) / batch
        transcript = subtitle_dir / f"{task}_transcript.txt"
        video = media_dir / f"{task}.mp4"
        slides = media_dir / f"{task}_PPT.pdf"
        status = {"date": lesson["date"], "periodNumber": period, "videoAvailable": False,
                  "officialSubtitleAvailable": False, "mediaSaved": keep_media and _valid_artifact(video),
                  "asrAttempted": False, "asrCompleted": False}
        statuses.append(status)
        subtitle_missing = need_subtitle and not _valid_artifact(transcript)
        slides_missing = need_ppt and not _valid_artifact(slides)
        media_missing = keep_media and not _valid_artifact(video)
        if not (subtitle_missing or slides_missing or media_missing):
            logs.append(f"第 {period} 节请求的产物已存在，跳过处理。")
            continue
        try:
            play = client.play(lesson["courseId"])
            # The normal API returns signed URLs. Never synthesize a signature.
            streams = play.get("courseVodViewList") or []
            url = next((item["url"] for item in streams if item.get("url")), None)
            status["videoAvailable"] = bool(url) or _valid_artifact(video)
            if subtitle_missing:
                payload = client.subtitle(lesson["courseId"])
                data = payload.get("data") or {}
                if any(str(item.get("res") or "").strip() for item in data.get("afterAssemblyList", [])):
                    subtitle_dir.mkdir(parents=True, exist_ok=True)
                    process_official_json(payload, subtitle_dir, task)
                    status["officialSubtitleAvailable"] = True
                    subtitle_missing = False
                    logs.append(f"第 {period} 节官方字幕已通过 HTTP 保存。")
            if slides_missing:
                data = client.get("/v1/course/ai/ppt", {"courseId": lesson["courseId"]}).get("data") or {}
                if data.get("docList"):
                    client.save_slides(lesson["courseId"], slides)
                    slides_missing = False
                    status["slidesSource"] = "official"
                    logs.append(f"第 {period} 节课件已通过学校 PDF 导出接口保存。")
            if official_only:
                continue
            # An unavailable local ASR must not cause a pointless media download.
            if subtitle_missing and not getattr(worker, "can_transcribe", True):
                status["failure"] = worker.message
                subtitle_missing = False
            if not (subtitle_missing or slides_missing or media_missing):
                continue
            if not url and not _valid_artifact(video):
                status["failure"] = "该课次没有可用媒体，无法执行媒体处理。"
                continue
            try:
                worker.export_base_dir = subtitle_dir
                source = video
                if _valid_artifact(video):
                    if subtitle_missing:
                        worker.extract_media(str(video), UI_URL, audio_only=True)
                else:
                    worker.extract_media(url, UI_URL, audio_only=not (slides_missing or media_missing))
                    source = Path(worker.temp_video_path)
                if media_missing:
                    media_dir.mkdir(parents=True, exist_ok=True)
                    _copy_atomic(worker.temp_video_path, video, stop_event)
                    status["mediaSaved"] = True
                if subtitle_missing:
                    subtitle_dir.mkdir(parents=True, exist_ok=True)
                    status["asrAttempted"] = True
                    try:
                        for _event in worker.transcribe_and_export(task):
                            raise_if_cancelled()
                        status["asrCompleted"] = _valid_artifact(transcript)
                        if not status["asrCompleted"]:
                            status["failure"] = "ASR 未生成有效字幕文件。"
                    except (TaskCancelledError, CampusAuthError):
                        raise
                    except Exception:
                        status["failure"] = "ASR 转写失败，请检查服务配置。"
                if slides_missing:
                    try:
                        from .ppt import PPTExtractor
                    except ImportError as exc:
                        raise RuntimeError("未安装 PPT 可选依赖；请运行 uv sync --extra ppt") from exc
                    yield_logs = PPTExtractor(str(source), str(media_dir), task,
                                              interval_sec=10, diff_threshold=1.0).extract_and_build_pdf()
                    logs.extend(yield_logs)
                    status["slidesSource"] = "frames"
            finally:
                worker._cleanup()
        except (TaskCancelledError, CampusAuthError):
            raise
        except CourseAPIError as error:
            status["failure"] = str(error)
            status["permissionDenied"] = error.forbidden
        except Exception as error:
            # Media/provider exceptions can include signed URLs or credentials.
            status["failure"] = "课程资源处理失败（" + type(error).__name__ + "）。"
        raise_if_cancelled()
    return statuses, logs

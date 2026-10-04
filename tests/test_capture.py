from pathlib import Path

import pytest

from seudaily.capture import find_mp4_url, process_official_json, sanitize_filename
from seudaily.cli import dispatch
from seudaily.service import CourseService
from seudaily.summary import AISummarizer


def test_local_asr_is_deferred_without_loading_optional_dependencies(tmp_path):
    from seudaily.service import transcribe_local

    with pytest.raises(RuntimeError, match="本地 ASR 暂未支持"):
        transcribe_local(media_path="unused.wav", model_path="unused", output_dir=str(tmp_path), task_name="test")


def test_cloud_transcription_loads_its_worker_lazily(monkeypatch, tmp_path):
    from seudaily.asr import cloud
    from seudaily.service import transcribe_cloud

    class FakeWorker:
        def __init__(self, config, output_dir):
            self.config = config
            self.output_dir = output_dir

        def transcribe_and_export(self, task_name):
            assert self.temp_audio_path == str((tmp_path / "audio.wav").resolve())
            yield {"txt_path": str(tmp_path / "transcript.txt"), "done": True}

    monkeypatch.setattr(cloud, "CloudASRWorker", FakeWorker)
    result = transcribe_cloud(audio_path=str(tmp_path / "audio.wav"), output_dir=str(tmp_path), task_name="test")
    assert result["transcriptPath"] == str(tmp_path / "transcript.txt")


def test_sanitize_filename_removes_windows_reserved_characters():
    assert sanitize_filename(' 课程: 第一讲 / 导论 ') == "课程- 第一讲 - 导论"


def test_find_mp4_url_walks_nested_payload():
    payload = {"data": [{"url": "https://example.test/a.mp4?auth_key=ok"}]}
    assert find_mp4_url(payload) == payload["data"][0]["url"]


def test_process_official_json_writes_transcript(tmp_path: Path):
    payload = {"data": {"afterAssemblyList": [{"res": "第一段"}, {"res": "第二段"}]}}
    output = process_official_json(payload, tmp_path, "lesson-1")
    assert Path(output).read_text(encoding="utf-8") == "第一段\n\n第二段"


def test_cli_health_lists_agent_tools():
    result = dispatch({"action": "health", "payload": {}})
    assert "transcribe-cloud" in result["tools"]
    assert "search-courses" in result["tools"]
    assert "find-course-session" in result["tools"]
    assert "capture-course-session" in result["tools"]
    assert "capture-course-sessions" in result["tools"]


def test_select_session_uses_latest_matching_date_and_keeps_all_periods():
    lessons = [
        {"date": "2026-09-02", "periodNumber": 5, "time": "12:00", "sequence": 1},
        {"date": "2026-09-02", "periodNumber": 3, "time": "10:00", "sequence": 3},
        {"date": "2026-09-02", "periodNumber": 4, "time": "11:00", "sequence": 2},
        {"date": "2026-08-26", "periodNumber": 3, "time": "10:00", "sequence": 4},
        {"date": "2026-08-26", "periodNumber": 4, "time": "11:00", "sequence": 5},
        {"date": "2026-08-26", "periodNumber": 5, "time": "12:00", "sequence": 6},
    ]

    result = CourseService._select_session(lessons, [5, 3, 4])

    assert result["status"] == "found"
    assert result["session"]["date"] == "2026-09-02"
    assert result["session"]["periodNumbers"] == [3, 4, 5]
    assert len(result["session"]["lessons"]) == 3


def test_select_session_requires_requested_date_to_match_weekly_periods():
    lessons = [
        {"date": "2026-09-02", "periodNumber": 3, "time": "10:00", "sequence": 1},
        {"date": "2026-09-02", "periodNumber": 4, "time": "11:00", "sequence": 2},
    ]

    result = CourseService._select_session(
        lessons, [3, 4, 5], course_date="2026-09-02"
    )

    assert result["status"] == "period_mismatch"
    assert result["availableSession"]["periodNumbers"] == [3, 4]


def test_course_search_matches_real_academic_semester_format():
    options = [
        "2025-2026学年第1学期",
        "2025-2026学年第2学期",
        "2025-2026学年第3学期",
    ]

    assert (
        CourseService._match_semester_option(options, "2025-2026-3")
        == "2025-2026学年第3学期"
    )
    assert (
        CourseService._match_semester_option(options, "2025-2026学年暑期学校")
        == "2025-2026学年第1学期"
    )
    assert CourseService._match_semester_option(options, "暑校") is None


def test_course_not_found_hint_mentions_other_semesters_and_manual_target():
    hint = CourseService._course_not_found_hint()

    assert "其他学期" in hint
    assert "source=manual" in hint


def test_batch_capture_serializes_all_shared_browser_work(monkeypatch):
    service = CourseService()
    monkeypatch.setattr(
        service,
        "capture_course_session",
        lambda **_kwargs: {"status": "completed"},
    )
    sessions = [
        {"courseName": "课程 A", "teacherName": "教师 A", "weeklyPeriods": [1, 2]},
        {"courseName": "课程 B", "teacherName": "教师 B", "weeklyPeriods": [3, 4]},
    ]

    subtitle_result = service.capture_course_sessions(
        sessions=sessions,
        max_concurrency=2,
        need_subtitle=True,
        need_ppt=False,
        keep_media=False,
    )
    heavy_result = service.capture_course_sessions(
        sessions=sessions,
        max_concurrency=2,
        need_subtitle=True,
        need_ppt=True,
        keep_media=False,
    )

    assert subtitle_result["effectiveConcurrency"] == 1
    assert heavy_result["effectiveConcurrency"] == 1


def test_summary_can_read_only_selected_transcript_files(tmp_path: Path):
    export_dir = tmp_path / "exports"
    batch_dir = export_dir / "subtitle" / "测试课程" / "20260902-教师"
    batch_dir.mkdir(parents=True)
    first = batch_dir / "20260902-3_transcript.txt"
    second = batch_dir / "20260902-4_transcript.txt"
    first.write_text("第一段课程内容" * 20, encoding="utf-8")
    second.write_text("第二段课程内容" * 20, encoding="utf-8")
    summarizer = AISummarizer({"api_key": "test", "llm_engine": "DeepSeek (api.deepseek.com)"})

    text, sources, output_name = summarizer.prepare_source(
        export_base_dir=export_dir,
        course_name="测试课程",
        source_type="files",
        transcript_paths=[str(first)],
    )

    assert "第一段课程内容" in text
    assert "第二段课程内容" not in text
    assert sources == [str(first.resolve())]
    assert output_name == "selected-transcripts"


def test_summary_rejects_files_outside_subtitle_directory(tmp_path: Path):
    export_dir = tmp_path / "exports"
    outside = tmp_path / "outside_transcript.txt"
    outside.write_text("不应读取的内容" * 20, encoding="utf-8")
    summarizer = AISummarizer({"api_key": "test", "llm_engine": "DeepSeek (api.deepseek.com)"})

    with pytest.raises(ValueError, match="只能读取"):
        summarizer.prepare_source(
            export_base_dir=export_dir,
            course_name="测试课程",
            source_type="files",
            transcript_paths=[str(outside)],
        )

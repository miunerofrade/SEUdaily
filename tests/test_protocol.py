import json
from pathlib import Path

from cvstream.protocol import normalize_tool_result


def test_protocol_moves_nested_diagnostics_and_redacts_secrets(tmp_path, monkeypatch):
    monkeypatch.setenv("CVSTREAM_PROJECT_ROOT", str(tmp_path))
    result = normalize_tool_result(
        "capture-course-sessions",
        {
            "status": "completed",
            "results": [{"logs": ["nested log"], "apiKey": "secret", "value": 1}],
            "events": [{"stage": "done"}],
        },
        requested_task_id="task-test",
    )

    assert result["data"]["results"][0]["apiKey"] == "[REDACTED]"
    diagnostics = Path(result["diagnosticsRef"])
    payload = json.loads(diagnostics.read_text(encoding="utf-8"))
    assert payload["logs"] == ["nested log"]
    assert payload["events"] == [{"stage": "done"}]
    assert Path(result["resultRef"]).exists()


def test_protocol_builds_artifact_and_source_citations(tmp_path, monkeypatch):
    monkeypatch.setenv("CVSTREAM_PROJECT_ROOT", str(tmp_path))
    transcript = tmp_path / "lecture.txt"
    transcript.write_text("content", encoding="utf-8")
    result = normalize_tool_result(
        "summarize-course",
        {
            "status": "completed",
            "sources": [str(transcript)],
            "notePath": str(tmp_path / "note.md"),
        },
        requested_task_id="task-citations",
    )

    assert any(item["type"] == "note" for item in result["artifacts"])
    assert any(item["id"] == "S1" and item["localPath"] == str(transcript.resolve()) for item in result["citations"])


def test_protocol_preserves_web_article_ids_as_citations(tmp_path, monkeypatch):
    monkeypatch.setenv("CVSTREAM_PROJECT_ROOT", str(tmp_path))
    result = normalize_tool_result(
        "search-jwc",
        {
            "status": "completed",
            "results": [
                {
                    "id": "seu-jwc-576338",
                    "title": "测试通知",
                    "url": "https://jwc.seu.edu.cn/example/page.htm",
                }
            ],
        },
        requested_task_id="task-web",
    )

    assert result["citations"] == [
        {
            "id": "seu-jwc-576338",
            "type": "web",
            "title": "测试通知",
            "url": "https://jwc.seu.edu.cn/example/page.htm",
        }
    ]


def test_protocol_keeps_full_result_on_disk_and_compacts_conversation_data(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("CVSTREAM_PROJECT_ROOT", str(tmp_path))
    courses = [{"title": f"课程 {index}"} for index in range(20)]

    result = normalize_tool_result(
        "search-courses",
        {"status": "completed", "count": 20, "courses": courses},
        requested_task_id="task-large",
    )

    assert len(result["data"]["courses"]) == 12
    assert any("resultRef" in warning for warning in result["warnings"])
    full = json.loads(Path(result["resultRef"]).read_text(encoding="utf-8"))
    assert len(full["data"]["courses"]) == 20


def test_protocol_keeps_all_schedule_courses_in_model_data(tmp_path, monkeypatch):
    monkeypatch.setenv("CVSTREAM_PROJECT_ROOT", str(tmp_path))
    courses = [{"courseName": f"课程 {index}"} for index in range(20)]

    result = normalize_tool_result(
        "get-schedule",
        {"status": "completed", "count": 20, "courses": courses},
        requested_task_id="task-schedule-large",
    )

    assert len(result["data"]["courses"]) == 20
    assert not any("resultRef" in warning for warning in result["warnings"])

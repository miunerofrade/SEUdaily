from pathlib import Path

from cvstream.capture import find_mp4_url, process_official_json, sanitize_filename
from cvstream.cli import dispatch


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
    assert "capture-course" in result["tools"]
    assert "transcribe-cloud" in result["tools"]
    assert "search-courses" in result["tools"]
    assert "find-course-lesson" in result["tools"]

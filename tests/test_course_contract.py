"""Fixed public-result cases, run before and after the course HTTP migration.

Only I/O is replaced: browser-era DOM readers or HTTP-era response JSON. The
assertions and input records stay identical across the migration.
"""
from contextlib import contextmanager
from copy import deepcopy
from unittest.mock import MagicMock

import pytest

from seudaily import service as module


COURSES = [{"index": 0, "title": "测试课程", "teacher": "测试教师",
            "semester": "2025-2026学年第3学期", "lessonCount": "4", "playCount": "10"}]
LESSONS = [{"sequence": i + 1, "title": f"第{period}节", "periodNumber": period,
            "date": day, "time": clock, "classroom": "测试教室", "hasAiContent": True}
           for i, (day, period, clock) in enumerate([
               ("2026-03-02", 3, "10:00"), ("2026-03-02", 4, "11:00"),
               ("2026-03-09", 3, "10:00"), ("2026-03-09", 4, "11:00")])]
RAW_COURSES = [{"id": 10, "teclId": 10, "subjName": "测试课程", "teacNames": "测试教师",
                "acteName": "2025-2026学年第3学期", "acteId": 7,
                "vodCourseNum": 4, "courPlayCount": 10}]
RAW_LESSONS = [{"id": 100 + i, "letiNumber": row["periodNumber"],
                "courBeginTime": row["date"] + " " + row["time"] + ":00",
                "courEndTime": row["date"] + " " + row["time"] + ":45",
                "clroName": "测试教室", "courTransferFlag": True, "vodEnable": 1}
               for i, row in enumerate(LESSONS)]
TERMS = [{"id": 7, "acyeCode": "2025-2026", "acteTerm": "3", "currentTerm": True}]


@pytest.fixture
def course_service(monkeypatch, tmp_path):
    service = module.CourseService(cookie_file=tmp_path / "cookies.json", export_dir=tmp_path)
    if hasattr(module, "CourseHTTPClient"):
        def get(client, path, params=None):
            if path == "/v1/list/termYear":
                return deepcopy(TERMS)
            rows = RAW_LESSONS if path == "/v1/subject_vod_list_new" else RAW_COURSES
            return {"status": 200, "data": {"records": deepcopy(rows), "rowCount": len(rows)}}
        monkeypatch.setattr(module.CourseHTTPClient, "get", get)
        monkeypatch.setattr(module.CourseHTTPClient, "authenticate", lambda _self: None)
    else:
        page = MagicMock()
        @contextmanager
        def browser(**_kwargs):
            yield page
        monkeypatch.setattr(service, "_page", browser)
        monkeypatch.setattr(service, "_login", lambda _page: [])
        monkeypatch.setattr(service, "_open_course_catalog", lambda _page: page)
        monkeypatch.setattr(service, "_open_course_detail", lambda *_args: page)
        monkeypatch.setattr(service, "_read_course_cards", lambda _page: deepcopy(COURSES))
        monkeypatch.setattr(service, "_read_lessons", lambda _page: deepcopy(LESSONS))
        def filters(_page, semester):
            selected = COURSES[0]["semester"]
            return {"found": not semester or service._match_semester_option([selected], semester) is not None,
                    "requestedSemester": semester, "selectedSemester": selected,
                    "availableSemesters": [selected]}
        monkeypatch.setattr(service, "_select_search_filters", filters)
    return service


def test_list_course_fields(course_service):
    result = course_service.list_courses()
    assert result["status"] == "completed"
    assert result["count"] == 1
    assert {k: result["courses"][0][k] for k in COURSES[0]} == COURSES[0]


@pytest.mark.parametrize("semester,expected", [("2025-2026-3", "completed"), ("2099-2100-1", "empty")])
def test_search_semester_contract(course_service, semester, expected):
    result = course_service.search_courses("测试课程", semester)
    assert result["status"] == expected
    assert result["query"] == "测试课程"
    assert result["count"] == (1 if expected == "completed" else 0)


def test_sessions_preserve_dates_and_periods(course_service):
    result = course_service.list_course_sessions(course_name="测试课程", teacher_name="测试教师")
    assert result["status"] == "completed"
    assert result["sessions"] == [
        {"date": "2026-03-02", "periodNumbers": [3, 4], "teachers": ["测试教师"]},
        {"date": "2026-03-09", "periodNumbers": [3, 4], "teachers": ["测试教师"]}]


@pytest.mark.parametrize("periods,day,status", [([3, 4], None, "found"),
    ([3, 4], "2026-03-02", "found"), ([3], "2026-03-02", "period_mismatch"),
    ([3, 4], "2026-03-16", "date_not_found")])
def test_session_resolution_contract(course_service, periods, day, status):
    result = course_service.find_course_session(course_name="测试课程", teacher_name="测试教师",
        weekly_periods=periods, course_date=day)
    assert result["status"] == status
    if status == "found":
        assert result["session"]["date"] == (day or "2026-03-09")
        assert result["session"]["periodNumbers"] == [3, 4]
        assert [{k: row[k] for k in LESSONS[0]} for row in result["session"]["lessons"]] == (
            LESSONS[:2] if day else LESSONS[2:])


def test_teacher_mismatch_contract(course_service):
    result = course_service.find_course_session(course_name="测试课程", teacher_name="其他教师",
                                                 weekly_periods=[3, 4])
    assert result["status"] == "course_not_found"

import json
from datetime import date
from pathlib import Path

from cvstream.cli import _resolve_course_target
from cvstream.schedule import DEFAULT_SCHEDULE_LAUNCH_URL, ScheduleService


def test_normalize_schedule_rows_exposes_capture_identity():
    rows = [
        {
            "KCM": "科学研究方法",
            "SKJS": "单冯",
            "SKXQ": "3",
            "KSJC": "3",
            "JSJC": "5",
            "SKZC": "0011110000000000",
            "JASMC": "教一-202",
            "KCH": "TEST001",
        }
    ]

    courses = ScheduleService._normalize_rows(rows)

    assert courses[0]["scheduleId"].startswith("seu-")
    assert {key: value for key, value in courses[0].items() if key != "scheduleId"} == {
        "courseName": "科学研究方法",
        "teacherName": "单冯",
        "weekday": 3,
        "startPeriod": 3,
        "endPeriod": 5,
        "weeklyPeriods": [3, 4, 5],
        "weeks": [3, 4, 5, 6],
        "classroom": "教一-202",
        "courseCode": "TEST001",
    }


def test_schedule_cache_is_used_until_refresh_is_requested(tmp_path: Path):
    cache_file = tmp_path / "schedule.json"
    service = ScheduleService(cache_file=cache_file)
    ScheduleService._write_json_atomic(
        cache_file,
        {
            "version": 1,
            "status": "fresh",
            "fetchedAt": "2026-09-17T00:00:00+00:00",
            "source": "api",
            "count": 1,
            "courses": [{"courseName": "测试课程"}],
        },
    )

    result = service.get_schedule(refresh=False)

    assert result["status"] == "cached"
    assert result["version"] == 2
    assert result["courses"][0]["scheduleId"].startswith("seu-")
    assert result["courses"][0]["courseName"] == "测试课程"
    assert result["cacheFile"] == str(cache_file.resolve())


def test_semester_cache_is_isolated_from_current_schedule(tmp_path: Path):
    cache_file = tmp_path / "schedule.json"
    service = ScheduleService(cache_file=cache_file)
    semester_file = tmp_path / "schedule.2025-2026-2.json"
    ScheduleService._write_json_atomic(
        semester_file,
        {
            "version": 2,
            "selectedSemester": "2025-2026-2",
            "selectedSemesterLabel": "2025-2026学年秋季学期",
            "courses": [{"courseName": "往年课程"}],
        },
    )

    result = service.get_schedule(semester="2025-2026-2")

    assert result["status"] == "cached"
    assert result["selectedSemester"] == "2025-2026-2"
    assert result["courses"][0]["courseName"] == "往年课程"
    assert result["cacheFile"] == str(semester_file.resolve())
    assert not cache_file.exists()


def test_dynamic_semester_codes_are_cached_and_discovered(tmp_path: Path):
    cache_file = tmp_path / "schedule.json"
    service = ScheduleService(cache_file=cache_file)
    dynamic_file = service._cache_file_for_semester("2020-2021-4")
    ScheduleService._write_json_atomic(
        dynamic_file,
        {
            "version": 2,
            "courses": [],
            "availableSemesters": [
                {"value": "2020-2021-4", "label": "2020-2021学年第4学期"},
                {"value": "invalid", "label": "无效"},
            ],
        },
    )

    cached = service._load_cache_file(dynamic_file)

    assert dynamic_file.name == "schedule.2020-2021-4.json"
    assert service._semester_cache_files() == [dynamic_file]
    assert cached["availableSemesters"] == [
        {"value": "2020-2021-4", "label": "2020-2021学年第4学期"}
    ]


def test_prefetch_available_semesters_uses_authenticated_request_context(tmp_path: Path):
    cache_file = tmp_path / "schedule.json"
    service = ScheduleService(cache_file=cache_file)

    class Response:
        ok = True
        status = 200

        def __init__(self, semester: str):
            self.semester = semester

        def json(self):
            return {
                "datas": {
                    "xskcb": {
                        "rows": [
                            {
                                "KCM": f"课程-{self.semester}",
                                "SKXQ": "1",
                                "KSJC": "1",
                                "JSJC": "2",
                                "SKZC": "11",
                            }
                        ]
                    }
                }
            }

    class Request:
        def __init__(self):
            self.forms = []

        def post(self, _url, *, form, timeout):
            self.forms.append((form, timeout))
            return Response(form["XNXQDM"])

    class Page:
        request = Request()

    options = [
        {"value": "2026-2027-2", "label": "2026-2027学年秋季学期"},
        {"value": "2020-2021-4", "label": "2020-2021学年第4学期"},
    ]
    result = service._prefetch_remote_semesters(
        Page(),
        available_semesters=options,
        current_semester="2026-2027-2",
        current_semester_label="2026-2027学年秋季学期",
    )

    assert [form["XNXQDM"] for form, _ in Page.request.forms] == [
        "2026-2027-2",
        "2020-2021-4",
    ]
    assert result["prefetchCounts"] == {
        "2026-2027-2": 1,
        "2020-2021-4": 1,
    }
    assert result["prefetchFailures"] == []
    assert json.loads(cache_file.read_text(encoding="utf-8"))["selectedSemester"] == "2026-2027-2"
    historical = json.loads(
        (tmp_path / "schedule.2020-2021-4.json").read_text(encoding="utf-8")
    )
    assert historical["courses"][0]["semester"] == "2020-2021-4"


def test_dom_schedule_records_are_normalized():
    records = [
        {
            "courseName": "大学物理",
            "teacherName": "张老师",
            "details": "1-16周,星期二,6-7,教三-101",
        }
    ]

    courses = ScheduleService._normalize_dom_records(records)

    assert courses[0]["weekday"] == 2
    assert courses[0]["weeklyPeriods"] == [6, 7]
    assert courses[0]["weeks"] == list(range(1, 17))


def test_seu_auth_and_vpn_pages_are_detected():
    assert ScheduleService._is_auth_page("https://auth.seu.edu.cn/dist/#/login")
    assert ScheduleService._is_auth_page("https://vpn.seu.edu.cn/portal/shortcut.html")


def test_seu_schedule_uses_portal_launch_url():
    service = ScheduleService()
    assert service.entry_url == DEFAULT_SCHEDULE_LAUNCH_URL


def test_course_target_can_resolve_schedule_or_manual_source(tmp_path: Path):
    cache_file = tmp_path / "schedule.json"
    service = ScheduleService(cache_file=cache_file)
    course = {
        "courseName": "科学研究方法",
        "teacherName": "单冯",
        "weekday": 3,
        "weeklyPeriods": [3, 4, 5],
        "weeks": [1, 2, 3],
        "classroom": "教一-202",
        "courseCode": "TEST001",
    }
    course["scheduleId"] = service._schedule_id(course)
    service._write_json_atomic(
        cache_file,
        {"version": 2, "courses": [course]},
    )
    payload = {"scheduleCacheFile": str(cache_file)}

    scheduled = _resolve_course_target(
        payload,
        {"source": "schedule", "scheduleId": course["scheduleId"]},
    )
    manual = _resolve_course_target(
        payload,
        {
            "source": "manual",
            "courseName": "课表外课程",
            "teacherName": "李老师",
            "weeklyPeriods": [8, 9],
        },
    )

    assert scheduled["weeklyPeriods"] == [3, 4, 5]
    assert manual == {
        "courseName": "课表外课程",
        "teacherName": "李老师",
        "weeklyPeriods": [8, 9],
        "courseDate": None,
    }


def test_course_target_resolves_from_historical_semester_cache(tmp_path: Path):
    cache_file = tmp_path / "schedule.json"
    service = ScheduleService(cache_file=cache_file)
    course = {
        "courseName": "离散数学",
        "teacherName": "陈老师",
        "weekday": 2,
        "weeklyPeriods": [3, 4],
        "weeks": [1, 2],
        "classroom": "教一-101",
        "courseCode": "MATH002",
        "semester": "2025-2026-2",
    }
    course["scheduleId"] = service._schedule_id(course)
    service._write_json_atomic(
        service._cache_file_for_semester("2025-2026-2"),
        {
            "version": 2,
            "selectedSemester": "2025-2026-2",
            "selectedSemesterLabel": "2025-2026学年秋季学期",
            "courses": [course],
        },
    )

    resolved = _resolve_course_target(
        {"scheduleCacheFile": str(cache_file)},
        {
            "source": "schedule",
            "scheduleId": course["scheduleId"],
            "semester": "2025-2026-2",
        },
    )

    assert resolved["courseName"] == "离散数学"
    assert resolved["semester"] == "2025-2026-2"


def test_user_schedule_overlay_is_separate_from_remote_cache(tmp_path: Path):
    cache_file = tmp_path / "schedule.json"
    user_file = tmp_path / "schedule-user.json"
    service = ScheduleService(cache_file=cache_file, customization_file=user_file)
    course = {
        "courseName": "高等数学",
        "teacherName": "张老师",
        "weekday": 1,
        "startPeriod": 1,
        "endPeriod": 2,
        "weeklyPeriods": [1, 2],
        "weeks": [1, 2, 3],
        "classroom": "",
        "courseCode": "MATH001",
    }
    course["scheduleId"] = service._schedule_id(course)
    service._write_json_atomic(cache_file, {"version": 2, "courses": [course]})
    source_key = service._source_key(course)

    service.save_customizations(
        {
            "semester": {
                "name": "2026-2027 秋季",
                "startDate": "2026-09-07",
                "totalWeeks": 18,
            },
            "overrides": {source_key: {"classroom": "教一-101", "weekday": 2}},
            "customCourses": [],
            "dateOverrides": [],
        }
    )

    result = service.get_schedule()
    raw = json.loads(cache_file.read_text(encoding="utf-8"))

    assert result["courses"][0]["classroom"] == "教一-101"
    assert result["courses"][0]["weekday"] == 2
    assert result["courses"][0]["sourceKey"] == source_key
    assert result["customizations"]["semester"]["startDate"] == "2026-09-07"
    assert raw["courses"][0]["classroom"] == ""
    assert raw["courses"][0]["weekday"] == 1


def test_semester_date_and_week_conversion():
    assert ScheduleService.week_for_date("2026-09-07", date(2026, 9, 20)) == 2
    assert ScheduleService.date_for_weekday("2026-09-07", 3, 4).isoformat() == "2026-09-24"

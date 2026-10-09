import json
from contextlib import nullcontext
from datetime import date, datetime
from pathlib import Path

import pytest
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError

from seudaily.cli import _resolve_course_target
from seudaily.schedule import DEFAULT_SCHEDULE_LAUNCH_URL, ScheduleService
import seudaily.schedule as schedule_module


@pytest.fixture(autouse=True)
def offline_calendar(monkeypatch):
    # Timetable fixtures never access the public web. Calendar IO has separate tests.
    monkeypatch.setattr(schedule_module.AcademicCalendar, "sync", lambda self, write_json: self.view())


@pytest.mark.parametrize("year,earliest", [(2026, 2022), (2027, 2023)])
def test_sync_year_window_moves_with_shanghai_calendar_year(monkeypatch, year, earliest):
    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            assert tz.utcoffset(None).total_seconds() == 8 * 3600
            return cls(year, 1, 1, tzinfo=tz)

    monkeypatch.setattr(schedule_module, "datetime", Clock)
    assert ScheduleService._earliest_sync_year() == earliest


class _TimetableLoadingPage:
    url = "https://ehall.seu.edu.cn/jwapp/sys/wdkb/*default/index.do"

    def __init__(self, *, initialized):
        self.initialized = initialized
        class Response:
            ok = True
            status = 200
            def json(self):
                return {}
        class Request:
            def post(self, *_args, **_kwargs):
                return Response()
        self.request = Request()

    @property
    def first(self):
        return self

    def locator(self, _selector):
        return self

    def on(self, *_args):
        pass

    def goto(self, *_args, **_kwargs):
        pass

    def wait_for(self, **_kwargs):
        pass

    def wait_for_timeout(self, _milliseconds):
        pass

    def title(self):
        return "我的课表"

    def wait_for_function(self, _script, **_kwargs):
        if not self.initialized:
            raise PlaywrightTimeoutError("current semester has not initialized")

    def get_attribute(self, _name):
        return "2026-2027-2"

    def inner_text(self):
        return "2026-2027学年秋季学期"

    def click(self):
        raise PlaywrightTimeoutError("semester switch control is unavailable")


@pytest.mark.parametrize("semester", [None, "2025-2026-2"])
def test_initial_semester_loading_timeout_is_not_reported_as_switch_failure(
    tmp_path: Path, monkeypatch, semester
):
    service = ScheduleService(target_url="https://ehall.seu.edu.cn/custom-timetable", cache_file=tmp_path / "schedule.json")
    page = _TimetableLoadingPage(initialized=False)
    monkeypatch.setattr(service, "_page", lambda **_kwargs: nullcontext(page))

    result = service.get_schedule(refresh=True, semester=semester)

    assert result["status"] == "page_load_failed"
    assert result["message"] == "课表页面加载未完成，请稍后重试。"
    assert not service.cache_file.exists()


def test_actual_semester_switch_timeout_does_not_request_reauthentication(
    tmp_path: Path, monkeypatch
):
    service = ScheduleService(target_url="https://ehall.seu.edu.cn/custom-timetable", cache_file=tmp_path / "schedule.json")
    page = _TimetableLoadingPage(initialized=True)
    monkeypatch.setattr(service, "_page", lambda **_kwargs: nullcontext(page))

    result = service.get_schedule(refresh=True, semester="2025-2026-2")

    assert result["status"] == "semester_switch_failed"
    assert result["message"] == "课表页面未能完成学期切换，请稍后重试。"
    assert not service.cache_file.exists()


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
        {"value": "2021-2022-3", "label": "早于同步范围"},
        {"value": "2026-2027-2", "label": "2026-2027学年秋季学期"},
        {"value": "2022-2023-4", "label": "2022-2023学年第4学期"},
    ]
    result = service._prefetch_remote_semesters(
        Page(),
        available_semesters=options,
        current_semester="2026-2027-2",
        current_semester_label="2026-2027学年秋季学期",
    )

    assert [form["XNXQDM"] for form, _ in Page.request.forms] == [
        "2026-2027-2",
        "2022-2023-4",
    ]
    assert result["prefetchCounts"] == {
        "2026-2027-2": 1,
        "2022-2023-4": 1,
    }
    assert result["prefetchFailures"] == []
    assert json.loads(cache_file.read_text(encoding="utf-8"))["selectedSemester"] == "2026-2027-2"
    historical = json.loads(
        (tmp_path / "schedule.2022-2023-4.json").read_text(encoding="utf-8")
    )
    assert historical["courses"][0]["semester"] == "2022-2023-4"


def test_remote_sync_defaults_to_all_semesters_but_cached_reads_stay_offline(tmp_path, monkeypatch):
    service = ScheduleService(cache_file=tmp_path / "schedule.json")
    calls = []

    def fetch(**kwargs):
        calls.append(kwargs)
        result = {"version": 2, "status": "fresh", "courses": [], "count": 0}
        service._write_json_atomic(service.cache_file, result)
        return result

    monkeypatch.setattr(service, "_fetch_remote", fetch)
    service.get_schedule(refresh=True)
    assert calls[0]["prefetch_available_semesters"] is True
    service.get_schedule()
    service.get_schedule(local_only=True)
    assert len(calls) == 1
    service.get_schedule(refresh=True, prefetch_available_semesters=False)
    assert calls[-1]["prefetch_available_semesters"] is False


def test_invalid_semester_api_response_preserves_existing_cache(tmp_path):
    service = ScheduleService(cache_file=tmp_path / "schedule.json")
    old = {"version": 2, "courses": [{"courseName": "旧缓存"}]}
    service._write_json_atomic(service.cache_file, old)

    class Response:
        ok = True
        status = 200

        def json(self):
            return {"success": False, "message": "authentication expired"}

    class Request:
        def post(self, *_args, **_kwargs):
            return Response()

    class Page:
        request = Request()

    result = service._prefetch_remote_semesters(
        Page(),
        available_semesters=[{"value": "2026-2027-2", "label": "秋季"}],
        current_semester="2026-2027-2",
        current_semester_label="秋季",
    )
    assert result["prefetchedSemesters"] == []
    assert len(result["prefetchFailures"]) == 1
    assert json.loads(service.cache_file.read_text()) == old


def test_default_full_sync_uses_portal_api_without_navigation_or_clicks(tmp_path, monkeypatch):
    service = ScheduleService(cache_file=tmp_path / "schedule.json", cookie_file=tmp_path / "cookies.json")
    calls = []

    class Response:
        ok = True
        status = 200

        def __init__(self, name):
            self.name = name

        def json(self):
            if self.name == "dqxnxq":
                rows = [{"DM": "2026-2027-2", "MC": "秋季"}]
            elif self.name == "xnxqcx":
                rows = [{"DM": "2025-2026-2", "MC": "往年秋季"}, {"DM": "2026-2027-2", "MC": "秋季"}]
            else:
                rows = [{"KCM": "测试课程", "SKXQ": "1", "KSJC": "1", "JSJC": "2", "SKZC": "11"}]
            return {"datas": {self.name: {"rows": rows}}}

    class Request:
        def post(self, url, *, form, timeout):
            calls.append((url, form))
            return Response(url.rsplit("/", 1)[-1].removesuffix(".do"))

    class Context:
        def cookies(self):
            return []

    class Page:
        request = Request()
        context = Context()

        def ensure_authenticated(self, _url):
            pass

        def goto(self, *_args, **_kwargs):
            raise AssertionError("API synchronization must not navigate the portal")

    monkeypatch.setattr(schedule_module, "CampusSession", lambda *_args, **_kwargs: nullcontext(Page()))
    monkeypatch.setattr(service, "_page", lambda **_kwargs: (_ for _ in ()).throw(AssertionError("HTTP sync must not start a browser")))
    result = service.get_schedule(refresh=True)
    assert result["status"] == "fresh"
    assert result["prefetchCounts"] == {"2025-2026-2": 1, "2026-2027-2": 1}
    assert len(calls) == 4
    assert result["selectedSemester"] == "2026-2027-2"
    assert json.loads((tmp_path / "schedule.2025-2026-2.json").read_text())["count"] == 1


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


def test_schedule_date_filter_keeps_full_schedule_when_date_is_empty(tmp_path: Path):
    cache_file = tmp_path / "schedule.json"
    service = ScheduleService(cache_file=cache_file, customization_file=tmp_path / "user.json")
    courses = [
        {
            "courseName": "周一课程",
            "teacherName": "教师一",
            "weekday": 1,
            "startPeriod": 1,
            "endPeriod": 2,
            "weeklyPeriods": [1, 2],
            "weeks": [1],
            "classroom": "教一-101",
        },
        {
            "courseName": "周二课程",
            "teacherName": "教师二",
            "weekday": 2,
            "startPeriod": 3,
            "endPeriod": 4,
            "weeklyPeriods": [3, 4],
            "weeks": [1],
            "classroom": "教二-202",
        },
        {
            "courseName": "下一周课程",
            "teacherName": "教师三",
            "weekday": 2,
            "startPeriod": 5,
            "endPeriod": 6,
            "weeklyPeriods": [5, 6],
            "weeks": [2],
            "classroom": "教三-303",
        },
    ]
    ScheduleService._write_json_atomic(
        cache_file,
        {"version": 2, "status": "fresh", "count": len(courses), "courses": courses},
    )
    service.save_customizations(
        {
            "semester": {"name": "测试学期", "startDate": "2026-09-21", "totalWeeks": 18},
            "overrides": {},
            "customCourses": [],
            "dateOverrides": [],
        }
    )

    full = service.get_schedule()
    filtered = service.get_schedule(target_date="2026-09-22")

    assert len(full["courses"]) == 3
    assert full["count"] == 3
    assert [item["courseName"] for item in filtered["courses"]] == ["周二课程"]
    assert filtered["dateFilter"] == {
        "requestedDate": "2026-09-22",
        "weekday": 2,
        "applied": True,
        "semesterStartDate": "2026-09-21",
        "week": 1,
        "matchedCount": 1,
    }


def test_schedule_date_filter_reports_missing_semester_start_date(tmp_path: Path):
    cache_file = tmp_path / "schedule.json"
    service = ScheduleService(cache_file=cache_file, customization_file=tmp_path / "user.json")
    ScheduleService._write_json_atomic(
        cache_file,
        {"version": 2, "status": "fresh", "count": 1, "courses": [{"courseName": "课程"}]},
    )

    result = service.get_schedule(target_date="2026-09-22")

    assert result["status"] == "partial"
    assert result["courses"] == []
    assert result["dateFilter"]["reason"] == "missing_semester_start_date"


def test_agent_schedule_change_adds_then_updates_custom_course(tmp_path: Path):
    customization_file = tmp_path / "schedule-user.json"
    service = ScheduleService(
        cache_file=tmp_path / "schedule.json",
        customization_file=customization_file,
    )

    added = service.apply_agent_change(
        {
            "operation": "add",
            "course": {
                "courseName": "测试课程",
                "teacherName": "张老师",
                "weekday": 3,
                "startPeriod": 3,
                "endPeriod": 4,
                "weeks": [1, 2, 3],
                "classroom": "教一-101",
            },
        }
    )
    source_key = added["change"]["sourceKey"]
    updated = service.apply_agent_change(
        {
            "operation": "update",
            "sourceKey": source_key,
            "changes": {"classroom": "教二-202", "startPeriod": 5, "endPeriod": 6},
        }
    )

    course = updated["customizations"]["customCourses"][0]
    assert course["courseName"] == "测试课程"
    assert course["classroom"] == "教二-202"
    assert course["weeklyPeriods"] == [5, 6]


def test_agent_schedule_change_moves_one_occurrence(tmp_path: Path):
    cache_file = tmp_path / "schedule.json"
    customization_file = tmp_path / "schedule-user.json"
    service = ScheduleService(cache_file=cache_file, customization_file=customization_file)
    ScheduleService._write_json_atomic(
        cache_file,
        {
            "version": 2,
            "courses": [
                {
                    "courseName": "计算机组成原理",
                    "teacherName": "张老师",
                    "weekday": 4,
                    "startPeriod": 3,
                    "endPeriod": 5,
                    "weeklyPeriods": [3, 4, 5],
                    "weeks": [1, 2, 3, 4, 5, 6, 7, 8],
                    "classroom": "教一-201",
                    "courseCode": "TEST001",
                }
            ],
        },
    )
    service.save_customizations(
        {
            "semester": {"name": "测试学期", "startDate": "2026-09-21", "totalWeeks": 16},
            "overrides": {},
            "customCourses": [],
            "dateOverrides": [],
        }
    )
    source_key = service.get_schedule()["courses"][0]["sourceKey"]

    result = service.apply_agent_change(
        {
            "operation": "move",
            "sourceKey": source_key,
            "fromDate": "2026-09-24",
            "toDate": "2026-11-14",
            "changes": {"startPeriod": 6, "endPeriod": 8},
        }
    )

    overrides = result["customizations"]["dateOverrides"]
    assert overrides[0]["action"] == "cancel"
    assert overrides[0]["targetSourceKey"] == source_key
    assert overrides[1]["action"] == "add"
    assert overrides[1]["date"] == "2026-11-14"
    assert overrides[1]["course"]["weeklyPeriods"] == [6, 7, 8]


def test_get_schedule_local_only_never_fetches_remote(tmp_path: Path, monkeypatch):
    service = ScheduleService(cache_file=tmp_path / "schedule.json")

    def fail_remote(**_kwargs):
        raise AssertionError("local_only must not access the remote timetable")

    monkeypatch.setattr(service, "_fetch_remote", fail_remote)

    result = service.get_schedule(local_only=True)

    assert result["status"] == "empty"
    assert result["courses"] == []
    assert result["localOnly"] is True


def test_missing_cache_syncs_automatically_but_old_cache_requires_explicit_refresh(tmp_path, monkeypatch):
    service = ScheduleService(cache_file=tmp_path / 'schedule.json', customization_file=tmp_path / 'user.json')
    calls = []
    def fetch(**kwargs):
        calls.append(kwargs)
        result = {'version':2,'status':'fresh','courses':[{'courseName':'已同步课程'}], 'fetchedAt':'2020-01-01T00:00:00+00:00'}
        service._write_json_atomic(service.cache_file, result)
        return result
    monkeypatch.setattr(service, '_fetch_remote', fetch)
    assert service.get_schedule()['courses'][0]['courseName'] == '已同步课程'
    assert len(calls) == 1
    assert service.get_schedule()['status'] == 'cached'
    assert service.get_schedule(include_available_semesters=True)['status'] == 'cached'
    assert service.get_schedule(local_only=True, refresh=True)['status'] == 'cached'
    assert len(calls) == 1
    service.get_schedule(refresh=True)
    assert len(calls) == 2
    monkeypatch.setattr(service, '_fetch_remote', lambda **kw: (_ for _ in ()).throw(ConnectionError('offline')))
    fallback = service.get_schedule(refresh=True)
    assert fallback['stale'] is True
    assert fallback['courses'][0]['courseName'] == '已同步课程'
    assert service.cache_file.exists()


def test_agent_semester_patch_preserves_other_settings_and_rejects_invalid_dates(tmp_path):
    service = ScheduleService(cache_file=tmp_path / 'schedule.json', customization_file=tmp_path / 'user.json')
    service.apply_agent_change({'operation':'semester','semester':{'name':'秋季','totalWeeks':18}})
    saved = service.apply_agent_change({'operation':'semester','semester':{'startDate':'2026-09-21'}})['customizations']['semester']
    assert saved == {'name':'秋季','startDate':'2026-09-21','totalWeeks':18}
    before = service.customization_file.read_bytes()
    for patch in [{'startDate':'2026-02-30'}, {'totalWeeks':31}, {'unknown':True}]:
        with pytest.raises(ValueError):
            service.apply_agent_change({'operation':'semester','semester':patch})
        assert service.customization_file.read_bytes() == before


def test_agent_one_day_course_can_be_edited_and_cancelled_without_semester_or_remote_cache(tmp_path, monkeypatch):
    service = ScheduleService(cache_file=tmp_path / 'schedule.json', customization_file=tmp_path / 'user.json')
    monkeypatch.setattr(service, '_fetch_remote', lambda **kw: pytest.fail('local edit must not access campus'))
    service.apply_agent_change({'operation':'add_once','date':'2026-10-07','course':{'courseName':'临时课程','startPeriod':3,'endPeriod':4}})
    def day(value):
        return service.get_schedule(local_only=True, target_date=value)
    first = day('2026-10-07')
    assert first['status'] == 'partial' and first['count'] == 1
    assert day('2026-10-08')['count'] == 0
    service.apply_agent_change({'operation':'move','sourceKey':first['courses'][0]['sourceKey'],'fromDate':'2026-10-07','toDate':'2026-10-07','changes':{'classroom':'教一101','startPeriod':5,'endPeriod':6}})
    changed = day('2026-10-07')['courses']
    assert len(changed) == 1 and changed[0]['classroom'] == '教一101'
    assert changed[0]['weeklyPeriods'] == [5,6]
    service.apply_agent_change({'operation':'cancel_once','sourceKey':changed[0]['sourceKey'],'date':'2026-10-07'})
    assert day('2026-10-07')['count'] == 0
    assert not service.cache_file.exists()
    before = service.customization_file.read_bytes()
    with pytest.raises(ValueError):
        service.apply_agent_change({'operation':'cancel_once','sourceKey':changed[0]['sourceKey'],'date':'2026-10-08'})
    assert service.customization_file.read_bytes() == before


def test_agent_cancelling_recurring_course_only_changes_requested_day(tmp_path):
    service = ScheduleService(cache_file=tmp_path / 'schedule.json', customization_file=tmp_path / 'user.json')
    service._write_json_atomic(service.cache_file, {'version':2,'courses':[{'courseName':'原课程','weekday':3,'startPeriod':1,'endPeriod':2,'weeks':[1,2,3,4]}]})
    service._load_cache()  # Initialize stable course IDs before checking edit isolation.
    before = service.cache_file.read_bytes()
    service.apply_agent_change({'operation':'semester','semester':{'startDate':'2026-09-21'}})
    source = service.get_schedule(local_only=True, target_date='2026-10-07')['courses'][0]['sourceKey']
    service.apply_agent_change({'operation':'cancel_once','sourceKey':source,'date':'2026-10-07'})
    assert service.get_schedule(local_only=True, target_date='2026-10-07')['count'] == 0
    assert service.get_schedule(local_only=True, target_date='2026-10-14')['count'] == 1
    assert service.cache_file.read_bytes() == before


def test_semester_default_is_sixteen_weeks_and_start_date_patch_does_not_invent_fields(tmp_path):
    service = ScheduleService(cache_file=tmp_path / 'schedule.json', customization_file=tmp_path / 'user.json')
    assert service._load_customizations()['semester']['totalWeeks'] == 16
    saved = service.apply_agent_change({'operation':'semester','semester':{'startDate':'2026-09-20'}})['customizations']['semester']
    assert saved == {'name':'','startDate':'2026-09-20','totalWeeks':16}
    service.apply_agent_change({'operation':'semester','semester':{'totalWeeks':18}})
    assert service.apply_agent_change({'operation':'semester','semester':{'startDate':'2026-09-21'}})['customizations']['semester']['totalWeeks'] == 18


@pytest.mark.parametrize("weeks", [[31], ["2"], [True], [0]])
def test_direct_course_save_rejects_invalid_week_values(tmp_path, weeks):
    service = ScheduleService(customization_file=tmp_path / "user.json")
    with pytest.raises(ValueError):
        service.save_customizations({"customCourses": [{"customId": "test", "courseName": "课程", "weekday": 1, "startPeriod": 1, "endPeriod": 2, "weeks": weeks}]})
    assert not service.customization_file.exists()


def test_legacy_course_data_is_not_rewritten_when_loaded(tmp_path):
    service = ScheduleService(customization_file=tmp_path / "user.json")
    original = '{"version":1,"customCourses":[{"weeks":[31]}]}'
    service.customization_file.write_text(original)
    assert service._load_customizations()["customCourses"][0]["weeks"] == [31]
    assert service.customization_file.read_text() == original

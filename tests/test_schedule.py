from pathlib import Path

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

    assert courses == [
        {
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
    ]


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
    assert result["courses"][0]["courseName"] == "测试课程"
    assert result["cacheFile"] == str(cache_file.resolve())


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

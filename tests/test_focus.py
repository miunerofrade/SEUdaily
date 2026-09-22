from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import cvstream.focus as focus_module
from cvstream.focus import FocusSemanticModel, FocusService
from cvstream.jwc import JwcService
from cvstream.schedule import ScheduleService
from cvstream.service import CourseService


SHANGHAI = ZoneInfo("Asia/Shanghai")


def course_focus_service(
    tmp_path: Path,
    courses: list[dict],
) -> tuple[FocusService, dict]:
    schedule_file = tmp_path / "schedule.json"
    customization_file = tmp_path / "schedule-user.json"
    ScheduleService._write_json_atomic(
        schedule_file,
        {"version": 2, "status": "cached", "courses": courses},
    )
    ScheduleService._write_json_atomic(
        customization_file,
        {
            "version": 1,
            "semester": {
                "name": "2026 秋季",
                "startDate": "2026-09-21",
                "totalWeeks": 16,
            },
            "overrides": {},
            "customCourses": [],
            "dateOverrides": [],
        },
    )
    service = FocusService(
        state_file=tmp_path / "focus.json",
        schedule_cache_file=schedule_file,
        schedule_customization_file=customization_file,
        export_dir=tmp_path,
    )
    source_keys = [ScheduleService._source_key(course) for course in courses]
    saved = service.upsert(
        {
            "kind": "course",
            "title": "数据结构",
            "courseSource": "schedule",
            "sourceKeys": source_keys,
            "courseName": "数据结构",
            "teacherNames": ["汪芸", "方效林"],
            "summary": False,
        }
    )["item"]
    state = service._load()
    state["items"][0]["createdAt"] = "2026-09-20T08:00:00+08:00"
    service._save(state)
    return service, saved


def scheduled_course(*, weekday: int, periods: list[int]) -> dict:
    return {
        "courseName": "数据结构",
        "teacherName": "汪芸,方效林",
        "weekday": weekday,
        "startPeriod": periods[0],
        "endPeriod": periods[-1],
        "weeklyPeriods": periods,
        "weeks": list(range(1, 15)),
        "classroom": "教室",
        "courseCode": f"DS-{weekday}",
    }


def test_focus_notice_rule_persists_and_only_emits_unseen_matches(
    tmp_path: Path, monkeypatch
) -> None:
    service = FocusService(state_file=tmp_path / "focus.json")
    saved = service.upsert(
        {
            "kind": "notice",
            "title": "推免信息",
            "description": "关注推免政策、报名节点和夏令营通知，不要普通成绩公示",
            "categories": ["news", "academic"],
        }
    )["item"]

    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")
    monkeypatch.setattr(
        FocusSemanticModel,
        "generate_queries",
        lambda self, description: ["推荐免试", "保研 夏令营"],
    )
    monkeypatch.setattr(
        FocusSemanticModel,
        "judge",
        lambda self, description, candidates: {"notice-1": "属于推免报名通知"},
    )
    searched: list[str] = []

    def search(self, query: str, **kwargs):
        searched.append(query)
        return {
            "results": [
                {
                    "id": "notice-1",
                    "title": "关于 2027 届推免工作的通知",
                    "url": "https://jwc.seu.edu.cn/example",
                    "publishedAt": "2026-09-20",
                    "category": "academic",
                },
                {
                    "id": "notice-2",
                    "title": "日常教学安排",
                    "url": "https://jwc.seu.edu.cn/other",
                    "publishedAt": "2026-09-20",
                    "category": "academic",
                },
            ]
        }

    monkeypatch.setattr(
        JwcService,
        "search",
        search,
    )

    first = service.run_cycle()
    second = service.run_cycle()
    listed = service.list()

    assert first["activity"][0]["article"]["id"] == "notice-1"
    assert first["activity"][0]["reason"] == "属于推免报名通知"
    assert second["activity"] == []
    assert searched == ["推荐免试", "保研 夏令营"] * 2
    assert listed["items"][0]["id"] == saved["id"]
    assert listed["items"][0]["seenArticleIds"] == ["notice-1"]
    assert listed["items"][0]["reviewedArticleIds"] == ["notice-1", "notice-2"]
    assert listed["items"][0]["generatedQueries"] == ["推荐免试", "保研 夏令营"]


def test_focus_runtime_respects_persisted_two_hour_interval(tmp_path: Path) -> None:
    service = FocusService(state_file=tmp_path / "focus.json")
    service.upsert(
        {
            "kind": "course",
            "title": "高等数学",
            "sourceKeys": ["schedule-a", "schedule-b"],
            "courseName": "高等数学",
            "teacherNames": ["张老师", "李老师"],
        }
    )
    first = service.run_cycle()
    second = service.run_cycle(respect_interval=True)

    assert first["lastRunAt"]
    assert second["skipped"] is True
    assert 0 < second["remainingSeconds"] <= 7200


def test_focus_runtime_runs_immediately_when_persisted_time_is_overdue(
    tmp_path: Path,
) -> None:
    service = FocusService(state_file=tmp_path / "focus.json")
    old_time = (datetime.now(timezone.utc) - timedelta(hours=3)).isoformat()
    state = service._default_state()
    state["lastRunAt"] = old_time
    service._save(state)

    result = service.run_cycle(respect_interval=True)

    assert result.get("skipped") is not True
    assert result["lastRunAt"] != old_time
    assert result["remainingSeconds"] == 7200


def test_agent_run_claim_is_persisted_and_force_cannot_overlap(
    tmp_path: Path,
) -> None:
    state_file = tmp_path / "focus.json"
    service = FocusService(state_file=state_file)
    saved = service.upsert(
        {
            "kind": "notice",
            "title": "推免信息",
            "description": "关注推免政策和报名节点",
            "categories": ["academic"],
        }
    )["item"]

    first = service.claim_agent_run(saved["id"], force=True)
    second = FocusService(state_file=state_file).claim_agent_run(
        saved["id"], force=True
    )

    assert first["claimed"] is True
    assert first["runId"].startswith("focus-run-")
    assert second["claimed"] is False
    assert second["reason"] == "running"

    stale = service.record_agent_run(
        saved["id"],
        status="completed",
        run_id="focus-run-stale",
    )
    still_running = service.claim_agent_run(saved["id"], force=True)
    assert stale["recorded"] is False
    assert still_running["reason"] == "running"

    recorded = service.record_agent_run(
        saved["id"],
        status="completed",
        run_id=first["runId"],
    )
    third = FocusService(state_file=state_file).claim_agent_run(
        saved["id"], force=True
    )
    assert recorded["recorded"] is True
    assert third["claimed"] is True
    assert not state_file.with_name("focus.json.lock").exists()


def test_followup_claim_does_not_consume_the_scheduled_interval(
    tmp_path: Path,
) -> None:
    service = FocusService(state_file=tmp_path / "focus.json")
    saved = service.upsert(
        {
            "kind": "course",
            "title": "编译原理",
            "description": "持续关注张老师的编译原理课程",
        }
    )["item"]

    followup = service.claim_agent_run(
        saved["id"],
        respect_interval=False,
    )
    assert followup["claimed"] is True
    assert "lastAgentRunAt" not in service.list()["items"][0]

    service.record_agent_run(
        saved["id"],
        status="completed",
        run_id=followup["runId"],
    )
    scheduled = service.claim_agent_run(saved["id"])
    assert scheduled["claimed"] is True


def test_portal_course_focus_discovers_and_captures_new_session(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setattr(
        focus_module,
        "_now_iso",
        lambda: "2026-09-20T08:00:00+08:00",
    )
    service = FocusService(state_file=tmp_path / "focus.json", export_dir=tmp_path)
    saved = service.upsert(
        {
            "kind": "course",
            "courseSource": "portal",
            "title": "旁听编译原理",
            "sourceKeys": [],
            "courseName": "编译原理",
            "teacherNames": ["张老师", "李老师"],
            "semester": "2026-2027学年第2学期",
            "summary": False,
        }
    )["item"]
    completed_course_date = "2026-09-21"
    queue_now = datetime(2026, 9, 22, 12, 16, tzinfo=SHANGHAI)
    discovered: list[str] = []
    captured: list[str] = []

    def list_sessions(self, *, course_name, teacher_name, semester=None):
        discovered.append(teacher_name)
        return {
            "status": "completed",
            "sessions": [
                {
                    "date": completed_course_date,
                    "periodNumbers": [3, 4],
                    "teachers": [teacher_name],
                }
            ],
        }

    def capture(self, *, teacher_name, **kwargs):
        captured.append(teacher_name)
        return {
            "status": "completed",
            "artifacts": [{"kind": "transcript", "path": str(tmp_path / "lesson.txt")}],
        }

    monkeypatch.setattr(CourseService, "list_course_sessions", list_sessions)
    monkeypatch.setattr(CourseService, "capture_course_session", capture)

    result = service.run_course_queue(now=queue_now)
    second = service.run_course_queue(now=queue_now)

    assert discovered == ["张老师", "李老师"]
    assert captured == ["张老师"]
    assert result["activity"][0]["type"] == "course_completed"
    assert result["activity"][0]["courseDate"] == completed_course_date
    assert second["activity"] == []
    assert service.list()["items"][0]["lastCourseRunAt"]
    assert service.list()["items"][0]["lastPortalSearchAt"]
    assert service.list()["items"][0]["portalSessions"][0]["date"] == completed_course_date
    assert service.list()["jobs"][f"{saved['id']}:{completed_course_date}"]["status"] == "completed"


def test_course_queue_waits_until_exactly_24_hours_after_final_period(
    tmp_path: Path, monkeypatch
) -> None:
    service, saved = course_focus_service(
        tmp_path,
        [scheduled_course(weekday=1, periods=[3, 4, 5])],
    )
    captured: list[str] = []

    def capture(self, *, course_date, **kwargs):
        captured.append(course_date)
        return {
            "status": "completed",
            "artifacts": [{"kind": "transcript", "path": str(tmp_path / "lesson.txt")}],
        }

    monkeypatch.setattr(CourseService, "capture_course_session", capture)
    before = service.run_course_queue(
        now=datetime(2026, 9, 22, 12, 14, 59, tzinfo=SHANGHAI)
    )
    job_key = f"{saved['id']}:2026-09-21"
    queued = service.list()["jobs"][job_key]

    assert before["attempted"] == 0
    assert captured == []
    assert queued["courseEndAt"] == "2026-09-21T12:15:00+08:00"
    assert queued["nextRunAt"] == "2026-09-22T12:15:00+08:00"

    exact = service.run_course_queue(
        now=datetime(2026, 9, 22, 12, 15, 0, tzinfo=SHANGHAI)
    )

    assert exact["attempted"] == 1
    assert captured == ["2026-09-21"]
    assert service.list()["jobs"][job_key]["status"] == "completed"


def test_course_queue_uses_tuesday_final_period_end_time(
    tmp_path: Path, monkeypatch
) -> None:
    service, saved = course_focus_service(
        tmp_path,
        [scheduled_course(weekday=2, periods=[6, 7])],
    )
    captured: list[str] = []

    def capture(self, *, course_date, **kwargs):
        captured.append(course_date)
        return {
            "status": "completed",
            "artifacts": [{"kind": "transcript", "path": str(tmp_path / "lesson.txt")}],
        }

    monkeypatch.setattr(CourseService, "capture_course_session", capture)
    service.run_course_queue(
        now=datetime(2026, 9, 23, 15, 34, 59, tzinfo=SHANGHAI)
    )
    job_key = f"{saved['id']}:2026-09-22"
    queued = service.list()["jobs"][job_key]
    assert queued["courseEndAt"] == "2026-09-22T15:35:00+08:00"
    assert queued["nextRunAt"] == "2026-09-23T15:35:00+08:00"
    assert captured == []

    service.run_course_queue(
        now=datetime(2026, 9, 23, 15, 35, 0, tzinfo=SHANGHAI)
    )
    assert captured == ["2026-09-22"]


def test_course_queue_retries_24_hours_after_failed_attempt(
    tmp_path: Path, monkeypatch
) -> None:
    service, saved = course_focus_service(
        tmp_path,
        [scheduled_course(weekday=1, periods=[3, 4, 5])],
    )
    attempts: list[str] = []

    def no_transcript(self, *, course_date, **kwargs):
        attempts.append(course_date)
        return {"status": "completed", "artifacts": []}

    monkeypatch.setattr(CourseService, "capture_course_session", no_transcript)
    first_attempt = datetime(2026, 9, 22, 13, 0, 0, tzinfo=SHANGHAI)
    service.run_course_queue(now=first_attempt)
    job_key = f"{saved['id']}:2026-09-21"
    failed_once = service.list()["jobs"][job_key]

    assert failed_once["status"] == "retrying"
    assert failed_once["attempts"] == 1
    assert failed_once["nextRunAt"] == "2026-09-23T13:00:00+08:00"

    service.run_course_queue(
        now=datetime(2026, 9, 23, 12, 59, 59, tzinfo=SHANGHAI)
    )
    assert attempts == ["2026-09-21", "2026-09-21"]

    service.run_course_queue(
        now=datetime(2026, 9, 23, 13, 0, 0, tzinfo=SHANGHAI)
    )
    assert attempts == ["2026-09-21"] * 4


def test_course_queue_runs_due_jobs_in_time_order_and_never_repeats_completed(
    tmp_path: Path, monkeypatch
) -> None:
    service, _ = course_focus_service(
        tmp_path,
        [
            scheduled_course(weekday=1, periods=[3, 4, 5]),
            scheduled_course(weekday=2, periods=[6, 7]),
        ],
    )
    captured: list[str] = []

    def capture(self, *, course_date, **kwargs):
        captured.append(course_date)
        return {
            "status": "completed",
            "artifacts": [{"kind": "transcript", "path": str(tmp_path / "lesson.txt")}],
        }

    monkeypatch.setattr(CourseService, "capture_course_session", capture)
    now = datetime(2026, 9, 23, 15, 35, 0, tzinfo=SHANGHAI)
    first = service.run_course_queue(now=now)
    second = service.run_course_queue(now=now + timedelta(days=1))

    assert first["attempted"] == 2
    assert captured == ["2026-09-21", "2026-09-22"]
    assert second["attempted"] == 0


def test_course_queue_pauses_focus_and_alerts_agent_after_three_failures(
    tmp_path: Path, monkeypatch
) -> None:
    service, saved = course_focus_service(
        tmp_path,
        [scheduled_course(weekday=1, periods=[3, 4, 5])],
    )
    attempts: list[str] = []

    def fail(self, *, course_date, **kwargs):
        attempts.append(course_date)
        raise RuntimeError("登录已失效")

    monkeypatch.setattr(CourseService, "capture_course_session", fail)
    first = datetime(2026, 9, 22, 12, 15, 0, tzinfo=SHANGHAI)
    service.run_course_queue(now=first)
    service.run_course_queue(now=first + timedelta(hours=24))
    third = service.run_course_queue(now=first + timedelta(hours=48))
    listed = service.list()
    job_key = f"{saved['id']}:2026-09-21"
    job = listed["jobs"][job_key]
    focus = listed["items"][0]

    assert len(attempts) == 6
    assert job["attempts"] == 3
    assert job["status"] == "failed"
    assert job["nextRunAt"] is None
    assert job["agentAlertPending"] is True
    assert focus["enabled"] is False
    assert "连续 3 次" in focus["pauseReason"]
    assert third["agentAlerts"][0]["jobKey"] == job_key

    after_pause = service.run_course_queue(now=first + timedelta(hours=72))
    assert after_pause["attempted"] == 0
    assert len(attempts) == 6

    service.acknowledge_course_alert(job_key)
    assert service.run_course_queue(
        now=first + timedelta(hours=96)
    )["agentAlerts"] == []


def test_focus_rejects_generic_non_school_kind(tmp_path: Path) -> None:
    service = FocusService(state_file=tmp_path / "focus.json")

    try:
        service.upsert({"kind": "web", "title": "任意网页"})
    except ValueError as exc:
        assert "notice" in str(exc) and "course" in str(exc)
    else:
        raise AssertionError("generic web Focus should be rejected")

from cvstream.training_plan import TrainingPlanService


def test_training_plan_normalizes_ehall_personal_plan() -> None:
    plan = TrainingPlanService._normalize_plan(
        {
            "PYFADM": "plan-1",
            "PYFAMC": "东南大学2025级软件工程专业培养方案",
            "ZYDM_DISPLAY": "软件工程",
            "XZNJ_DISPLAY": "2025级",
            "YXDM_DISPLAY": "71-软件学院",
            "XDLXDM_DISPLAY": "主修",
            "ZSYQXF": 150,
            "YWCXF": 30,
            "XM": "不应返回的姓名",
            "XH": "不应返回的学号",
        },
        {
            "PYFADM": "plan-1",
            "PYFAMC": "东南大学2025级软件工程专业培养方案",
            "ZYDM_DISPLAY": "软件工程",
            "NJDM_DISPLAY": "2025级",
            "DWDM_DISPLAY": "71-软件学院",
            "XWDM_DISPLAY": "工学",
            "ZSYQXFXSZ": 150,
            "PYMB": "培养目标",
        },
        [{"KZH": "group-1"}],
        [
            {
                "WID": "course-1",
                "KCH": "B71M1010",
                "KCM": "数据结构",
                "KZM": "大类学科基础课",
                "KCXZDM_DISPLAY": "必修",
                "XF": "4.0",
                "XS": "64.0",
                "XNXQ": "2026-2027-2",
                "XNXQ_DISPLAY": "2026-2027学年秋季学期",
                "KKDWDM_DISPLAY": "71-软件学院",
                "KSLXDM_DISPLAY": "考试",
                "KZH": "group-1",
            }
        ],
    )

    assert plan["major"] == "软件工程"
    assert plan["requiredCredits"] == 150
    assert plan["completedCredits"] == 30
    assert plan["progress"] == 20
    assert plan["courseCount"] == 1
    assert plan["courses"][0]["name"] == "数据结构"
    assert "XM" not in plan
    assert "XH" not in plan


def test_training_plan_deduplicates_identical_ehall_courses() -> None:
    course = {
        "WID": "course-1",
        "KCH": "B71M1010",
        "KCM": "数据结构",
        "KZM": "大类学科基础课",
        "XF": 4,
        "XNXQ": "2026-2027-2",
        "KZH": "group-1",
    }
    plan = TrainingPlanService._normalize_plan(
        {"PYFADM": "plan-1", "ZSYQXF": 150},
        {},
        [],
        [course, dict(course)],
    )

    assert plan["courseCount"] == 1


def test_training_plan_source_is_ehall_only() -> None:
    source = TrainingPlanService._source()

    assert source["url"].startswith("https://ehall.seu.edu.cn/")
    assert source["path"] == [
        "办事服务",
        "教务处",
        "方案中心",
        "个人方案查询",
    ]


def test_training_plan_marks_courses_from_schedule_semester() -> None:
    rows = [
        {"WID": "past", "KCM": "高等数学", "XNXQ": "2025-2026-3", "KCXZDM_DISPLAY": "必修"},
        {"WID": "now", "KCM": "数据结构", "XNXQ": "2026-2027-2", "KCXZDM_DISPLAY": "限选"},
        {"WID": "future", "KCM": "编译原理", "XNXQ": "2026-2027-3", "KCXZDM_DISPLAY": "任选"},
    ]
    plan = TrainingPlanService._normalize_plan(
        {"PYFADM": "plan-1"},
        {},
        [],
        rows,
        current_semester="2026-2027-2",
        schedule_evidence={
            "2025-2026-3": {"codes": set(), "names": {"高等数学"}, "courses": []},
            "2026-2027-2": {"codes": set(), "names": {"数据结构"}, "courses": []},
        },
    )

    assert [course["status"] for course in plan["courses"]] == [
        "completed",
        "studying",
        "upcoming",
    ]


def test_training_plan_reads_cache_and_recomputes_status(tmp_path, monkeypatch) -> None:
    cache_file = tmp_path / "training-plan.json"
    schedule_file = tmp_path / "schedule.json"
    schedule_file.write_text(
        '{"currentSemester":"2026-2027-2","currentSemesterLabel":"当前学期","courses":[{"courseName":"数据结构","courseCode":"BJSL0061","semester":"2026-2027-2"}]}',
        encoding="utf-8",
    )
    (tmp_path / "schedule.2025-2026-3.json").write_text(
        '{"selectedSemester":"2025-2026-3","selectedSemesterLabel":"往年学期","courses":[{"courseName":"高等数学","semester":"2025-2026-3"}]}',
        encoding="utf-8",
    )
    TrainingPlanService._write_json_atomic(
        cache_file,
        {
            "version": 1,
            "status": "completed",
            "plans": [
                {
                    "id": "plan-1",
                    "courses": [
                        {"name": "高等数学", "semester": "2025-2026-3", "status": "unknown"},
                        {"name": "数据结构", "code": "BJSL0061", "semester": "2026-2027-2", "status": "unknown"},
                    ],
                }
            ],
        },
    )
    service = TrainingPlanService(
        cache_file=cache_file,
        schedule_cache_file=schedule_file,
    )
    monkeypatch.setattr(
        service,
        "_fetch_remote",
        lambda: (_ for _ in ()).throw(AssertionError("不应请求 eHall")),
    )

    result = service.get()

    assert result["status"] == "cached"
    assert result["plans"][0]["currentSemester"] == "2026-2027-2"
    assert [course["status"] for course in result["plans"][0]["courses"]] == [
        "completed",
        "studying",
    ]


def test_current_semester_course_is_not_studying_without_schedule_match() -> None:
    plan = TrainingPlanService._normalize_plan(
        {"PYFADM": "plan-1"},
        {},
        [],
        [
            {"WID": "selected", "KCH": "A1", "KCM": "已选课程", "XNXQ": "2026-2027-2"},
            {"WID": "not-selected", "KCH": "A2", "KCM": "未选任选课", "XNXQ": "2026-2027-2"},
        ],
        current_semester="2026-2027-2",
        scheduled_codes={"A1"},
    )

    assert {course["code"]: course["status"] for course in plan["courses"]} == {
        "A1": "studying",
        "A2": "not_taken",
    }


def test_multi_semester_course_keeps_each_semester_option() -> None:
    plan = TrainingPlanService._normalize_plan(
        {"PYFADM": "plan-1"},
        {},
        [],
        [
            {
                "WID": "history",
                "KCH": "H1",
                "KCM": "新中国史",
                "XNXQ": "2026-2027-2,2026-2027-3",
                "XNXQ_DISPLAY": "2026-2027学年秋季学期, 2026-2027学年 三学期",
            }
        ],
        current_semester="2026-2027-2",
    )

    assert plan["courses"][0]["semesterOptions"] == [
        {"value": "2026-2027-2", "label": "2026-2027学年秋季学期", "status": "not_taken"},
        {"value": "2026-2027-3", "label": "2026-2027学年 三学期", "status": "upcoming"},
    ]


def test_training_plan_merges_explicit_four_choose_one_group() -> None:
    group = {
        "KZH": "history-group",
        "KZM": "四史教育（2023起）",
        "BZ": "四选一",
        "ZSXDXF": 1,
    }
    rows = [
        {
            "WID": f"history-{index}",
            "KCH": code,
            "KCM": name,
            "KZH": "history-group",
            "KZM": "四史教育（2023起）",
            "KCXZDM_DISPLAY": "限选",
            "XF": 1,
            "XNXQ": "2026-2027-2,2026-2027-3",
            "XNXQ_DISPLAY": "2026-2027学年秋季学期, 2026-2027学年 三学期",
        }
        for index, (code, name) in enumerate(
            [
                ("B13M0020", "新中国史"),
                ("B13M0030", "社会主义发展史"),
                ("B15M1001", "中共党史"),
                ("B15M1002", "改革开放史"),
            ]
        )
    ]

    plan = TrainingPlanService._normalize_plan(
        {"PYFADM": "plan-1"}, {}, [group], rows
    )

    assert plan["courseCount"] == 1
    assert plan["courses"][0]["choiceNote"] == "四选一"
    assert len(plan["courses"][0]["options"]) == 4


def test_past_course_without_schedule_evidence_is_not_taken() -> None:
    plan = TrainingPlanService._normalize_plan(
        {"PYFADM": "plan-1"},
        {},
        [],
        [{"WID": "past", "KCH": "A1", "KCM": "未修必修课", "XNXQ": "2025-2026-3", "KCXZDM_DISPLAY": "必修"}],
        current_semester="2026-2027-2",
    )

    assert plan["courses"][0]["status"] == "not_taken"
    assert plan["courses"][0]["semesterOptions"][0]["status"] == "not_taken"


def test_schedule_only_general_elective_is_appended_last() -> None:
    plan = TrainingPlanService._normalize_plan(
        {"PYFADM": "plan-1"},
        {},
        [],
        [
            {"WID": "required", "KCH": "A1", "KCM": "程序设计", "XNXQ": "2025-2026-2", "KCXZDM_DISPLAY": "必修"},
        ],
        current_semester="2026-2027-2",
        schedule_evidence={
            "2025-2026-2": {
                "codes": {"A1", "B00ZR078"},
                "names": {"程序设计", "自动驾驶与社会发展"},
                "label": "2025-2026学年秋季学期",
                "courses": [
                    {"courseCode": "A1", "courseName": "程序设计", "semester": "2025-2026-2"},
                    {"courseCode": "B00ZR078", "courseName": "自动驾驶与社会发展", "semester": "2025-2026-2"},
                ],
            }
        },
    )

    assert [course["name"] for course in plan["courses"]] == [
        "程序设计",
        "自动驾驶与社会发展",
    ]
    extra = plan["courses"][-1]
    assert extra["source"] == "schedule"
    assert extra["group"] == "通选课"
    assert extra["nature"] == "通选"
    assert extra["classificationSource"] == "course_code"


def test_general_elective_credit_requirement_without_note_is_kept() -> None:
    requirements = TrainingPlanService._study_requirements(
        [
            {"KZM": "通识选修课", "ZSXDXF": 10, "KCZXF": 30},
            {"KZM": "通识选修课", "ZSXDXF": 10, "KCZXF": 30},
        ]
    )

    assert requirements == [
        {
            "name": "通识选修课",
            "nature": "",
            "requiredCredits": 10,
            "availableCredits": 30,
            "note": "培养方案要求至少修读 10 学分",
        }
    ]


def test_schedule_course_code_classifies_common_general_elective_prefixes() -> None:
    assert TrainingPlanService._schedule_course_classification(
        {"courseCode": "B00MY004", "courseName": "艺术导论"}
    ) == ("通选课", "通选", "course_code", True)
    assert TrainingPlanService._schedule_course_classification(
        {"courseCode": "B00RW036", "courseName": "刑法的观念"}
    ) == ("通选课", "通选", "course_code", True)
    assert TrainingPlanService._schedule_course_classification(
        {"courseCode": "B00XL008", "courseName": "心理健康与生命成长"}
    ) == ("心理健康教育", "通识课程", "course_code", True)


def test_training_plan_audit_returns_evidence_without_deciding_risk(monkeypatch) -> None:
    service = TrainingPlanService()
    monkeypatch.setattr(
        service,
        "get",
        lambda refresh=False: {
            "status": "cached",
            "source": service._source(),
            "plans": [
                {
                    "id": "plan-1",
                    "title": "测试方案",
                    "currentSemester": "2026-2027-2",
                    "studyRequirements": [{"name": "通识选修课", "requiredCredits": 10, "note": "至少10学分"}],
                    "courses": [
                        {
                            "id": "required",
                            "code": "A1",
                            "name": "往期必修",
                            "nature": "必修",
                            "credits": 3,
                            "semester": "2025-2026-3",
                            "status": "not_taken",
                            "semesterOptions": [{"value": "2025-2026-3", "status": "not_taken"}],
                        },
                        {
                            "id": "extra",
                            "code": "B00ZR078",
                            "name": "自动驾驶与社会发展",
                            "nature": "通选",
                            "credits": 2,
                            "semester": "2025-2026-2",
                            "status": "completed",
                            "source": "schedule",
                            "classificationSource": "course_code",
                        },
                    ],
                }
            ],
        },
    )

    audit = service.audit()

    assert audit["counts"]["missingPast"] == 1
    assert audit["counts"]["scheduleOnly"] == 1
    assert audit["attentionPoints"][0]["type"] == "past_required_without_schedule_evidence"
    assert audit["studyRequirements"] == [
        {"name": "通识选修课", "requiredCredits": 10, "note": "至少10学分"}
    ]
    assert audit["creditTotals"]["byStatus"]["missingPast"] == 3
    assert audit["creditTotals"]["byStatus"]["scheduleOnly"] == 2
    assert audit["creditTotals"]["byNatureInScheduleEvidence"]["通选"] == 2
    assert "severity" not in audit["attentionPoints"][0]
    assert "action" not in audit["attentionPoints"][0]

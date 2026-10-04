from contextlib import contextmanager
from unittest.mock import MagicMock
import threading

import httpx
import pytest

from seudaily.campus_auth import CampusAuthError
from seudaily.course_http import CourseHTTPClient, CourseAPIError
from seudaily.capture_http import capture_lessons
from seudaily.service import CourseService


def client(tmp_path, handler):
    result = CourseHTTPClient(tmp_path / "cookies.json")
    result.session.client.close()
    result.session.client = httpx.Client(transport=httpx.MockTransport(handler))
    result.token = "initial"
    return result


def test_business_token_expiry_reauthenticates_once(tmp_path):
    calls = []
    def handler(request):
        calls.append(request.headers["jwt-token"])
        return httpx.Response(200, json={"status": 401} if len(calls) == 1 else {"status": 200, "data": []})
    with client(tmp_path, handler) as api:
        api.authenticate = MagicMock(side_effect=lambda: setattr(api, "token", "fresh"))
        assert api.get("/v1/currentuser")["status"] == 200
        assert calls == ["initial", "fresh"]
        api.authenticate.assert_called_once()


def test_repeated_expiry_stops_after_one_retry(tmp_path):
    with client(tmp_path, lambda _r: httpx.Response(401, json={"status": 401})) as api:
        api.authenticate = MagicMock()
        with pytest.raises(CampusAuthError):
            api.get("/v1/currentuser")
        api.authenticate.assert_called_once()


def test_permissions_are_not_password_retries(tmp_path):
    with client(tmp_path, lambda _r: httpx.Response(200, json={"status": 403})) as api:
        api.authenticate = MagicMock()
        with pytest.raises(CourseAPIError) as exc:
            api.get("/v1/currentuser")
        assert exc.value.forbidden
        api.authenticate.assert_not_called()


def test_pdf_business_permission_error_is_not_expired_auth(tmp_path):
    with client(tmp_path, lambda _r: httpx.Response(200, json={
            "status": 500, "code": "-1", "message": "当前用户无下载权限"})) as api:
        api.authenticate = MagicMock()
        with pytest.raises(CourseAPIError) as exc:
            api.save_slides(100, tmp_path / "slides.pdf")
        assert exc.value.forbidden
        api.authenticate.assert_not_called()
    assert not (tmp_path / "slides.pdf").exists()


def test_denied_slides_never_trigger_media_fallback(tmp_path):
    api, worker = fake_api(), MagicMock()
    api.get.return_value = {"data": {"docList": [{}]}}
    api.save_slides.side_effect = CourseAPIError("无下载权限", forbidden=True)
    statuses, _logs = run_capture(api, tmp_path, worker, need_ppt=True)
    assert statuses[0]["permissionDenied"]
    worker.extract_media.assert_not_called()


def test_course_pagination_keeps_records_beyond_first_page(tmp_path):
    def handler(request):
        page = int(request.url.params["page.pageIndex"])
        rows = list(range(100)) if page == 1 else [100]
        return httpx.Response(200, json={"data": {"records": rows, "rowCount": 101}})
    with client(tmp_path, handler) as api:
        assert api.records("/v1/group_subject_vod_list/t-1") == list(range(101))


COURSE = {"title": "测试课程", "teacher": "测试教师"}
LESSON = {"courseId": 100, "date": "2026-03-02", "periodNumber": 3, "sequence": 1}


def fake_api(subtitle=True):
    api = MagicMock()
    api.play.return_value = {"lvcrVodStatus": 1, "courseVodViewList": [{"url": "https://media.seu.edu.cn/a.mp4?auth_key=test"}]}
    api.subtitle.return_value = {"data": {"afterAssemblyList": [{"res": "第一段"}, {"res": "第二段"}]}} if subtitle else {"data": None}
    return api


def run_capture(api, tmp_path, worker=None, **options):
    return capture_lessons(api, COURSE, [LESSON], worker or MagicMock(), tmp_path,
                          threading.Event(), **options)


def test_official_subtitle_matches_original_golden_without_media(tmp_path):
    api, worker = fake_api(), MagicMock()
    status, _logs = run_capture(api, tmp_path, worker)
    assert status[0]["officialSubtitleAvailable"]
    assert (tmp_path / "subtitle/测试课程/20260302-测试教师/20260302-3_transcript.txt").read_text() == "第一段\n\n第二段"
    worker.extract_media.assert_not_called()
    api.play.assert_called_once_with(100)
    api.subtitle.assert_called_once_with(100)


def test_unavailable_asr_does_not_download_media(tmp_path):
    worker = MagicMock(can_transcribe=False, message="本地 ASR 暂未支持")
    status, _logs = run_capture(fake_api(False), tmp_path, worker)
    assert status[0]["failure"] == "本地 ASR 暂未支持"
    assert not status[0]["asrAttempted"]
    worker.extract_media.assert_not_called()


def test_official_slides_do_not_download_video(tmp_path):
    api, worker = fake_api(), MagicMock()
    api.get.return_value = {"data": {"docList": [{"imageUrl": "unused"}]}}
    def save(_id, path):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"%PDF-fixture")
    api.save_slides.side_effect = save
    status, _logs = run_capture(api, tmp_path, worker, need_ppt=True)
    assert status[0]["slidesSource"] == "official"
    worker.extract_media.assert_not_called()


def test_slide_export_reauthenticates_and_writes_atomically(tmp_path):
    attempts = []
    def handler(request):
        attempts.append(request.headers["jwt-token"])
        if len(attempts) == 1:
            return httpx.Response(200, json={"status": 401})
        return httpx.Response(200, content=b"%PDF-fixture", headers={"content-type": "application/pdf"})
    with client(tmp_path, handler) as api:
        api.authenticate = MagicMock(side_effect=lambda: setattr(api, "token", "fresh"))
        api.save_slides(100, tmp_path / "slides.pdf")
    assert attempts == ["initial", "fresh"]
    assert (tmp_path / "slides.pdf").read_bytes() == b"%PDF-fixture"


def test_invalid_pdf_does_not_replace_existing_artifact(tmp_path):
    path = tmp_path / "slides.pdf"
    path.write_bytes(b"%PDF-existing")
    with client(tmp_path, lambda _r: httpx.Response(200, content=b"login HTML")) as api:
        with pytest.raises(CourseAPIError):
            api.save_slides(100, path)
    assert path.read_bytes() == b"%PDF-existing"
    assert sorted(p.name for p in tmp_path.iterdir()) == ["slides.pdf"]


def test_normal_queries_return_manual_auth_reason_without_launching_browser(monkeypatch, tmp_path):
    service = CourseService(cookie_file=tmp_path / "cookies.json")
    def captcha(_self, _path, _params=None):
        raise CampusAuthError("captcha_required", "需要验证码")
    monkeypatch.setattr(CourseHTTPClient, "get", captcha)
    browser = MagicMock(side_effect=AssertionError("normal query must not launch browser"))
    monkeypatch.setattr(service, "_page", browser)
    result = service.search_courses("测试课程")
    assert result["status"] == "auth_required"
    assert result["authenticationReason"] == "captcha_required"
    browser.assert_not_called()


def test_explicit_manual_login_waits_for_app_and_saves_final_cookies(monkeypatch, tmp_path):
    service = CourseService(cookie_file=tmp_path / "cookies.json")
    page = MagicMock(url="https://auth.seu.edu.cn/dist/#/secondary-verification")
    page.context.cookies.return_value = [{"name": "test", "value": "final", "domain": "auth.seu.edu.cn"}]
    @contextmanager
    def browser(**_kwargs):
        yield page
    monkeypatch.setattr(service, "_page", browser)
    authenticate = MagicMock(side_effect=[CampusAuthError("captcha_required", "需交互验证"), None])
    monkeypatch.setattr(CourseHTTPClient, "authenticate", authenticate)
    result = service.authorize()
    assert result["status"] == "authorized"
    predicate = page.wait_for_url.call_args.args[0]
    assert not predicate("https://auth.seu.edu.cn/dist/#/secondary-verification")
    assert predicate("https://cvs.seu.edu.cn/jy-application-resourcemanage-ui/#/login?type=cas")
    assert '"value": "final"' in service.cookie_file.read_text()
    assert service.cookie_file.stat().st_mode & 0o777 == 0o600

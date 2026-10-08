"""Upstream changes must fail visibly without erasing previously useful data."""
import json
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import MagicMock

import httpx
import pytest

from seudaily.campus_api import CampusAPIError, dataset_rows, post_rows
from seudaily.campus_auth import CampusSession
from seudaily.course_http import CourseHTTPClient, CourseAPIError
from seudaily.schedule import ScheduleService
from seudaily.training_plan import TrainingPlanService
from seudaily.web_attachments import read_attachment
from seudaily import saved_web_files
from seudaily.json_store import write_json_atomic


@pytest.mark.parametrize('payload', [{}, {'datas': {}}, {'datas': {'x': {}}}, {'datas': {'x': {'rows': [None]}}}])
def test_missing_or_malformed_dataset_is_not_empty(payload):
    with pytest.raises(CampusAPIError, match='数据格式无效'):
        dataset_rows(payload, 'x')
    assert dataset_rows({'datas': {'x': {'rows': []}}}, 'x') == []


@pytest.mark.parametrize('status,body', [(403, '{}'), (503, '<html>maintenance</html>'), (200, '<html>maintenance</html>')])
def test_forbidden_or_maintenance_is_not_a_password_retry(tmp_path, status, body):
    with CampusSession(tmp_path/'cookies.json') as session:
        session.client.close()
        session.client = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(status, text=body, headers={'content-type': 'text/html'})))
        session.entry_url = 'https://ehall.seu.edu.cn/appShow'
        session.ensure_authenticated = MagicMock(side_effect=AssertionError('must not retry login'))
        response = session.post('https://ehall.seu.edu.cn/api', form={})
        assert response.status == status
        session.ensure_authenticated.assert_not_called()
        with pytest.raises(CampusAPIError):
            post_rows(SimpleNamespace(request=SimpleNamespace(post=lambda *a, **k: response)), 'url', 'x', {})


def test_bad_timetable_row_does_not_replace_cache(tmp_path):
    service = ScheduleService(cache_file=tmp_path/'schedule.json')
    old = {'version': 2, 'courses': [{'courseName': '原课程'}]}
    write_json_atomic(service.cache_file, old)
    response = SimpleNamespace(status=200, ok=True, json=lambda: {'datas': {'xskcb': {'rows': [{'renamedCourse': '新课程'}]}}})
    page = SimpleNamespace(request=SimpleNamespace(post=lambda *a, **k: response))
    result = service._prefetch_remote_semesters(page, available_semesters=[{'value':'2026-2027-2','label':'秋季'}], current_semester='2026-2027-2', current_semester_label='秋季')
    assert result['prefetchFailures']
    assert json.loads(service.cache_file.read_text()) == old


def test_bad_plan_schema_keeps_last_successful_plan(tmp_path, monkeypatch):
    service = TrainingPlanService(cache_file=tmp_path/'plan.json')
    cached = {'plans': [{'id':'original'}]}
    monkeypatch.setattr(service, '_load_cache', lambda: cached)
    monkeypatch.setattr(service, '_fetch_remote', lambda: dataset_rows({}, 'grpyfacx'))
    result = service.get(refresh=True)
    assert result['plans'] == cached['plans']
    assert result['cacheFallback'] and 'grpyfacx' in result['syncFailure']


@pytest.mark.parametrize('data', [{}, {'data': {'records': [], 'rowCount': '3'}}, {'data': {'records': [], 'rowCount': 3}}])
def test_bad_course_pagination_cannot_look_complete(tmp_path, data):
    with CourseHTTPClient(tmp_path/'cookies') as client:
        client.get = lambda *a, **k: data
        with pytest.raises(CourseAPIError):
            client.records('/fixture')


def test_repeated_course_page_stops_before_unbounded_requests(tmp_path):
    with CourseHTTPClient(tmp_path/'cookies') as client:
        client.get = MagicMock(return_value={'data': {'records': [1,2], 'rowCount':100}})
        with pytest.raises(CourseAPIError, match='重复'):
            client.records('/fixture')
        assert client.get.call_count == 2


def test_unparsed_original_is_reused_by_attachment_reader(tmp_path, monkeypatch):
    monkeypatch.setattr(saved_web_files, 'root', lambda: tmp_path)
    url = 'https://jwc.seu.edu.cn/a.pdf'
    saved_web_files.save(url, 'a.pdf', b'%PDF-fixture', '.pdf')
    opener = MagicMock()
    parser = MagicMock(return_value={'markdown':'已解析文本'})
    result = read_attachment(opener, url, 'a.pdf', '.pdf', referer=url, timeout=15, max_bytes=1024, validate_url=lambda u:u, parse_document=parser)
    assert result['markdown'] == '已解析文本'
    opener.open.assert_not_called()
    assert not Path(parser.call_args.args[0]).exists()


def test_changed_notice_template_does_not_erase_body(tmp_path):
    from seudaily.jwc import JwcService
    service = JwcService(cache_dir=tmp_path/'jwc', background_sync=False)
    article = {'url': 'https://jwc.seu.edu.cn/2026/1007/c1a2/page.htm',
               'title': '原通知', 'content': '重要正文', 'contentHash': 'original'}
    with pytest.raises(ValueError, match='正文结构未识别'):
        service._apply_article_response(article, {'url': article['url'], 'html': '<html>维护中</html>'})
    assert article['content'] == '重要正文'
    assert article['contentHash'] == 'original'


def test_non_login_redirect_does_not_retry_password(tmp_path):
    with CampusSession(tmp_path/'cookies.json') as session:
        session.client.close()
        session.client = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(302, headers={'location':'/maintenance'})))
        session.entry_url = 'https://ehall.seu.edu.cn/appShow'
        session.ensure_authenticated = MagicMock(side_effect=AssertionError('must not retry login'))
        assert session.post('https://ehall.seu.edu.cn/api', form={}).status == 302
        session.ensure_authenticated.assert_not_called()

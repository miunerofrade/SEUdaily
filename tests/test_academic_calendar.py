import json
from pathlib import Path

import httpx

from seudaily.academic_calendar import AcademicCalendar, CALENDAR_URL, CalendarLinks
from seudaily.schedule import ScheduleService


def test_calendar_downloads_only_missing_or_changed_urls(tmp_path, monkeypatch):
    calls = []
    version = [1]
    parsed = []
    def request(req):
        calls.append(str(req.url))
        if str(req.url) == CALENDAR_URL:
            return httpx.Response(200, text=f'<a href="/_upload/article/images/cal.jpg">校历.jpg</a><a href="/_upload/article/files/holiday{version[0]}.pdf">关于2026年部分节假日安排的通知.pdf</a>')
        return httpx.Response(200, content=b'\xff\xd8\xff image' if req.url.path.endswith('.jpg') else b'%PDF-1.7 fixture')
    client = httpx.Client
    monkeypatch.setattr(httpx, 'Client', lambda **kw: client(transport=httpx.MockTransport(request), **kw))
    monkeypatch.setattr(AcademicCalendar, '_pdf_text', staticmethod(lambda path: parsed.append(path) or '国庆节学校调课通知'))
    calendar = AcademicCalendar(tmp_path)
    first = calendar.sync(ScheduleService._write_json_atomic)
    assert len(first['attachments']) == 2
    assert len(calls) == 3 and len(parsed) == 1
    # Fresh instance simulates a backend restart; explicit sync must still reuse files.
    second = AcademicCalendar(tmp_path).sync(ScheduleService._write_json_atomic)
    assert len(calls) == 4 and len(parsed) == 1
    assert second['attachments'] == first['attachments']
    version[0] = 2
    third = calendar.sync(ScheduleService._write_json_atomic)
    assert len(calls) == 6 and len(parsed) == 2
    assert third['attachments'][1]['url'].endswith('holiday2.pdf')
    (tmp_path / third['attachments'][0]['file']).unlink()
    calendar.sync(ScheduleService._write_json_atomic)
    assert len(calls) == 8 and len(parsed) == 2


def test_calendar_failure_keeps_cached_documents_and_rejects_foreign_links(tmp_path, monkeypatch):
    parser = CalendarLinks()
    parser.feed('<a href="https://evil.example/_upload/article/a.pdf">校历.pdf</a><a href="http://127.0.0.1/_upload/article/a.pdf">校历.pdf</a>')
    assert parser.links == []
    calendar = AcademicCalendar(tmp_path)
    content = b'%PDF-1.7 valid'
    import hashlib
    (tmp_path / 'cached.pdf').write_bytes(content)
    saved = {'sourceUrl': CALENDAR_URL, 'attachments': [{'url':'https://jwc.seu.edu.cn/_upload/article/files/a.pdf','file':'cached.pdf','sha256':hashlib.sha256(content).hexdigest(),'text':'旧通知'}]}
    ScheduleService._write_json_atomic(calendar.manifest, saved)
    before = calendar.manifest.read_bytes()
    client = httpx.Client
    monkeypatch.setattr(httpx, 'Client', lambda **kw: client(transport=httpx.MockTransport(lambda req: httpx.Response(503)), **kw))
    result = calendar.sync(ScheduleService._write_json_atomic)
    assert result['attachments'] == saved['attachments']
    assert result['warnings']
    assert calendar.manifest.read_bytes() == before
    assert calendar.view()['attachments'][0]['text'] == '旧通知'


def test_concurrent_calendar_sync_reuses_cache_without_starting_download(tmp_path, monkeypatch):
    calendar = AcademicCalendar(tmp_path)
    monkeypatch.setattr(calendar, '_sync_locked', lambda write_json: (_ for _ in ()).throw(AssertionError('must not acquire a second download lock')))
    with calendar._lock() as acquired:
        assert acquired
        result = AcademicCalendar(tmp_path).sync(ScheduleService._write_json_atomic)
        assert result['warnings'] == ['校历正在同步，暂时使用已有缓存。']
    # Lock is available again after the first worker closes it.
    with calendar._lock() as acquired:
        assert acquired

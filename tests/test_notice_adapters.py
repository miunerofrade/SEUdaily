import json
from pathlib import Path
from datetime import datetime, timezone
import pytest
from seudaily import jwc, saved_web_files, cli
from seudaily.notice_sources import _load_notice_sources, source_config
from seudaily.notice_adapters import create_notice_adapter


def test_existing_adapters_preserve_list_and_search_results(tmp_path, monkeypatch):
    monkeypatch.setattr(jwc, "_now", lambda: datetime(2026, 10, 8, tzinfo=timezone.utc))
    monkeypatch.setattr(saved_web_files, "root", lambda: tmp_path / "web-files")
    for key, legacy_type in [("jwc", jwc.JwcService), ("cse", jwc.CseService)]:
        root = tmp_path / key
        new = create_notice_adapter(
            {"source": key, "cacheDir": str(root), "backgroundSync": False}
        )
        old = legacy_type(cache_dir=str(root), background_sync=False)
        category = next(iter(new.config.categories))
        article_url = f"https://{new.config.host}/2026/1007/c1a2/page.htm"
        fixture = {
            "notModified": False,
            "url": article_url,
            "html": f'<a href="{article_url}">通知</a>',
        }
        for service in [new, old]:
            monkeypatch.setattr(service, "_fetch", lambda *a, **k: fixture)
        listed = new.list_articles(categories=[category])
        assert listed == old.list_articles(categories=[category])
        for service in [new, old]:
            monkeypatch.setattr(
                service,
                "_search_remote",
                lambda *a: [
                    {
                        "id": new.config.id_prefix + "-2",
                        "url": article_url,
                        "title": "通知",
                        "publishedAt": "2026-10-07",
                    }
                ],
            )
            monkeypatch.setattr(
                service,
                "_fetch",
                lambda *a, **k: {
                    **fixture,
                    "html": '<div class="wp_articlecontent">通知正文</div>',
                },
            )
        result = new.search("通知", categories=[category])
        assert result == old.search("通知", categories=[category])
        assert new.config.search_type == ("1" if key == "cse" else "")


def test_third_webplus_source_works_without_site_specific_service(
    tmp_path, monkeypatch
):
    path = tmp_path / "sources.json"
    path.write_text(
        json.dumps(
            {
                "civil": {
                    "name": "土木工程学院",
                    "host": "civil.seu.edu.cn",
                    "adapter": "webplus",
                    "categories": {"announcements": ["学院通知", "/notice/list.htm"]},
                    "selectors": {
                        "title": ["notice_title"],
                        "content": ["notice_body"],
                        "date": ["notice_date"],
                    },
                    "searchType": "1",
                }
            }
        )
    )
    sources = _load_notice_sources(path)
    adapter = create_notice_adapter(
        {
            "source": "civil",
            "cacheDir": str(tmp_path / "civil"),
            "backgroundSync": False,
        },
        sources=sources,
    )
    monkeypatch.setattr(saved_web_files, "root", lambda: tmp_path / "web-files")
    url = "https://civil.seu.edu.cn/2026/1007/c1a9/page.htm"

    def fetch(request, *args):
        html = (
            f'<a href="{url}">测试通知</a>'
            if request.endswith("list.htm")
            else '<h1 class="notice_title">测试通知</h1><div class="notice_body">通知正文<a href="/files/a.pdf">附件.pdf</a></div>'
        )
        return {"url": request, "html": html, "notModified": False}

    monkeypatch.setattr(adapter, "_fetch", fetch)
    listed = adapter.list_articles(categories=["announcements"])
    assert listed["results"][0]["id"] == "seu-civil-9"
    detail = adapter.get_article("seu-civil-9")["article"]
    assert detail["title"] == "测试通知" and detail["categoryLabel"] == "学院通知"
    assert detail["attachments"] == [
        {"name": "附件.pdf", "url": "https://civil.seu.edu.cn/files/a.pdf"}
    ]
    assert (tmp_path / "civil/articles/seu-civil-9.json").exists()
    monkeypatch.setattr(cli, "_jwc_service", lambda payload: adapter)
    assert (
        cli.dispatch(
            {
                "action": "get-notice",
                "payload": {
                    "source": "civil",
                    "articleId": "seu-civil-9",
                    "refresh": False,
                },
            }
        )["article"]["id"]
        == "seu-civil-9"
    )


def test_unknown_source_and_adapter_fail_instead_of_using_jwc(tmp_path):
    with pytest.raises(ValueError, match="未知通知来源"):
        create_notice_adapter({"source": "typo"})
    path = tmp_path / "sources.json"
    path.write_text(
        json.dumps(
            {
                "civil": {
                    "name": "土木",
                    "host": "civil.seu.edu.cn",
                    "adapter": "unknown",
                    "categories": {"news": ["通知", "/notice/list.htm"]},
                }
            }
        )
    )
    with pytest.raises(ValueError, match="adapter"):
        _load_notice_sources(path)


@pytest.mark.parametrize("key", ["jwc", "cse", "civil"])
@pytest.mark.parametrize("scoped", [False, True])
def test_site_search_uses_configured_form_and_search_type(
    tmp_path, monkeypatch, key, scoped
):
    import base64
    from email.message import Message
    from urllib.parse import parse_qs

    raw = json.loads(Path(jwc.__file__).with_name("notice_categories.json").read_text())
    raw["civil"] = {
        "name": "土木工程学院",
        "host": "civil.seu.edu.cn",
        "adapter": "webplus",
        "searchType": "1",
        "categories": {"announcements": ["学院通知", "/notice/list.htm"]},
    }
    path = tmp_path / "sources.json"
    path.write_text(json.dumps(raw))
    sources = _load_notice_sources(path)
    service = create_notice_adapter(
        {"source": key, "cacheDir": str(tmp_path / key)}, sources=sources
    )
    calls = []

    class Response:
        def __init__(self, content):
            self.content = content.encode()
            self.headers = Message()

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def read(self):
            return self.content

    class Opener:
        def open(self, request, **kwargs):
            calls.append(request)
            if len(calls) == 1:
                return Response('<form action="/search/new.rst?site=1"></form>')
            if len(calls) == 2:
                return Response("url:'/search/searchCon/create.rst?site=1'")
            return Response(
                json.dumps(
                    {
                        "data": '<div class="result_item clearfix"><input name="id" value="12"><h3 class="item_title"><a href="/2026/1007/c1a12/page.htm">奖学金通知</a></h3>发布时间：2026-10-07</div>'
                    }
                )
            )

    monkeypatch.setattr(jwc, "public_opener", lambda *args: Opener())
    category = next(iter(service.config.categories)) if scoped else None
    results = service._search_remote("奖学金", category)
    expected = f"https://{service.config.host}" + (
        service.config.categories[category][1] if scoped else "/"
    )
    assert calls[0].full_url == expected
    fields = json.loads(
        base64.b64decode(parse_qs(calls[-1].data.decode())["searchInfo"][0])
    )
    assert (
        next(item["value"] for item in fields if item["field"] == "searchType")
        == service.config.search_type
    )
    assert (
        next(item["value"] for item in fields if item["field"] == "keyword") == "奖学金"
    )
    assert results[0]["id"] == service.config.id_prefix + "-12"
    assert results[0]["title"] == "奖学金通知"


def test_third_source_attachment_and_focus_lifecycle(tmp_path, monkeypatch):
    from seudaily import focus, notice_sources, notice_adapters, web_attachments
    from types import SimpleNamespace

    config = {"civil": {"name": "土木工程学院", "host": "civil.seu.edu.cn",
                         "categories": {"announcements": ["学院通知", "/notice/list.htm"]}}}
    path = tmp_path / "sources.json"
    path.write_text(json.dumps(config))
    sources = _load_notice_sources(path)
    monkeypatch.setattr(notice_sources, "_NOTICE_SOURCES", sources)
    monkeypatch.setattr(notice_adapters, "_NOTICE_SOURCES", sources)
    monkeypatch.setattr(saved_web_files, "root", lambda: tmp_path / "web-files")
    article = {"id": "seu-civil-9", "title": "学院通知", "category": "announcements",
               "url": "https://civil.seu.edu.cn/2026/1007/c1a9/page.htm"}
    url = "https://civil.seu.edu.cn/files/a.pdf"
    downloads = []
    monkeypatch.setattr(web_attachments, "download", lambda *a, **k: downloads.append(url) or b"%PDF-fixture")
    stored = web_attachments.read_attachment(None, url, "规则.pdf", ".pdf", referer=article["url"],
            timeout=1, max_bytes=1000, validate_url=lambda u: u,
            parse_document=lambda *a, **k: {"markdown": "通知正文"}, source_name="土木工程学院", notice=article)
    assert "civil.seu.edu.cn/announcements/seu-civil-9/" in Path(stored["path"]).as_posix()
    again = web_attachments.read_attachment(None, url, "规则.pdf", ".pdf", referer=article["url"],
            timeout=1, max_bytes=1000, validate_url=lambda u: u,
            parse_document=lambda *a, **k: pytest.fail("cached PDF should not be parsed"), notice=article)
    assert downloads == [url] and again["sha256"] == stored["sha256"]
    requests = []
    monkeypatch.setattr(focus, "create_notice_adapter", lambda payload: requests.append(payload) or SimpleNamespace(search=lambda *a, **k: {"results": [article]}))
    monkeypatch.setattr(focus, "FocusSemanticModel", lambda: SimpleNamespace(generate_queries=lambda _: ["学院"], judge=lambda *a: {article["id"]: "符合要求"}))
    service = focus.FocusService(state_file=tmp_path / "focus.json")
    item = service.upsert({"kind": "notice", "title": "学院消息", "description": "关注学院通知", "source": "civil"})["item"]
    assert item["categories"] == ["announcements"]
    events = service._check_notice(item)
    assert requests[0]["source"] == "civil" and events[0]["article"]["id"] == article["id"]


def test_old_attachment_call_resolves_registry_cache(tmp_path, monkeypatch):
    from seudaily import notice_sources
    source = {"civil": {"host": "civil.seu.edu.cn", "idPrefix": "school-civil"}}
    monkeypatch.setattr(notice_sources, "_NOTICE_SOURCES", source)
    monkeypatch.setattr(saved_web_files, "root", lambda: tmp_path / "web-files")
    directory = tmp_path / "civil/articles"
    directory.mkdir(parents=True)
    (directory / "school-civil-9.json").write_text(json.dumps({"id": "school-civil-9", "category": "announcements", "title": "学院通知"}))
    result = saved_web_files.save("https://civil.seu.edu.cn/files/a.pdf", "规则.pdf", b"pdf", ".pdf", source_url="https://civil.seu.edu.cn/c1a9/page.htm")
    assert "/announcements/school-civil-9/" in Path(result["path"]).as_posix()

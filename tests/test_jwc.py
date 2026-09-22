from __future__ import annotations

import io
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

import cvstream.jwc as jwc_module
from cvstream.document_parser import parse_document as real_parse_document
from cvstream.jwc import JWC_CATEGORIES, CseService, JwcService, _article_id


def _list_html(items: list[tuple[str, str]]) -> str:
    links = "".join(f'<a href="{url}">{title}</a>' for url, title in items)
    return f"<html><body>{links}</body></html>"


def _detail_html(title: str, date: str, body: str) -> str:
    return f"""
    <html><body>
      <span class="Article_Title">{title}</span>
      <span class="Article_PublishDate">{date}</span>
      <div class="wp_articlecontent Article_Content">
        <p>{body}</p>
        <a href="/_upload/demo.xlsx">附件.xlsx</a>
      </div>
    </body></html>
    """


def _text_pdf_bytes(text: str) -> bytes:
    content = f"BT /F1 18 Tf 72 720 Td ({text}) Tj ET".encode("ascii")
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Length " + str(len(content)).encode("ascii") + b" >>\nstream\n" + content + b"\nendstream",
    ]
    output = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets: list[int] = []
    for index, obj in enumerate(objects, start=1):
        offsets.append(len(output))
        output.extend(f"{index} 0 obj\n".encode("ascii"))
        output.extend(obj)
        output.extend(b"\nendobj\n")
    xref_offset = len(output)
    output.extend(f"xref\n0 {len(objects) + 1}\n".encode("ascii"))
    output.extend(b"0000000000 65535 f \n")
    for offset in offsets:
        output.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
    output.extend(
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref_offset}\n%%EOF\n".encode("ascii")
    )
    return bytes(output)


class _FakeDownload(io.BytesIO):
    def __init__(self, payload: bytes, url: str) -> None:
        super().__init__(payload)
        self._url = url
        self.headers = {"Content-Length": str(len(payload))}

    def geturl(self) -> str:
        return self._url

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback) -> None:
        self.close()


def test_article_id_ignores_column_alias() -> None:
    first = "https://jwc.seu.edu.cn/2026/0710/c23285a576338/page.htm"
    second = "https://jwc.seu.edu.cn/2026/0710/c21676a576338/page.htm"
    assert _article_id(first) == _article_id(second) == "seu-jwc-576338"


def test_article_id_supports_webplus_psp_detail_url() -> None:
    url = "https://jwc.seu.edu.cn/2026/0921/c21680a583969/page.psp"

    assert _article_id(url) == "seu-jwc-583969"


def test_lecture_column_requires_explicit_selection() -> None:
    service = JwcService(background_sync=False)

    assert JWC_CATEGORIES["lectures"] == (
        "文化素质教育（讲座预告）",
        "/cbxx/list.htm",
    )
    assert service._categories(["lectures"], None) == ["lectures"]


def test_automatic_column_routing_is_rejected() -> None:
    service = JwcService(background_sync=False)

    try:
        service._categories(["auto"], None)
    except ValueError as exc:
        assert "未知栏目" in str(exc)
    else:
        raise AssertionError("automatic routing should be rejected")


def test_search_without_column_uses_site_scope() -> None:
    service = JwcService(background_sync=False)

    assert service._categories(None, None, allow_all=True) == []


def test_site_search_preserves_webplus_label(tmp_path: Path) -> None:
    service = JwcService(cache_dir=str(tmp_path / "jwc"), background_sync=False)
    calls: list[tuple[str, str | None]] = []

    def fake_search(query: str, category: str | None):
        calls.append((query, category))
        return [{
            "id": "seu-jwc-1",
            "url": "https://jwc.seu.edu.cn/2026/0918/c21677a1/page.htm",
            "title": "全站通知",
            "publishedAt": "2026-09-18",
            "categoryLabel": "教务信息",
        }]

    service._search_remote = fake_search  # type: ignore[method-assign]
    result = service.search("通知")

    assert calls == [("通知", None)]
    assert result["searchScope"] == "site"
    assert result["categories"] == []
    assert result["paths"] == []
    assert result["results"][0]["category"] == "教务信息"


def test_same_site_http_url_is_normalized_to_https() -> None:
    service = JwcService(background_sync=False)

    assert service._normalize_url(
        "http://jwc.seu.edu.cn/2026/0918/c53663a583607/page.htm"
    ) == "https://jwc.seu.edu.cn/2026/0918/c53663a583607/page.htm"


def test_failed_pending_details_are_removed_and_recorded(tmp_path: Path) -> None:
    service = JwcService(cache_dir=str(tmp_path / "jwc"), background_sync=False)
    service._write_queue([{
        "id": "seu-jwc-1",
        "url": "http://jwc.seu.edu.cn/missing/page.htm",
        "title": "missing",
    }])

    def fail_refresh(article):
        raise RuntimeError("HTTP Error 404: Not Found")

    service._refresh_article = fail_refresh  # type: ignore[method-assign]
    result = service.sync_pending(max_workers=1)

    assert result["status"] == "partial"
    assert result["failed"] == 1
    assert service._read_queue() == []
    failures = __import__("json").loads(service.failures_file.read_text(encoding="utf-8"))
    assert failures[0]["id"] == "seu-jwc-1"
    assert failures[0]["url"] == "https://jwc.seu.edu.cn/missing/page.htm"


def test_lecture_search_uses_paginated_column_path(tmp_path: Path) -> None:
    service = JwcService(cache_dir=str(tmp_path / "jwc"), background_sync=False)
    article_url = "https://jwc.seu.edu.cn/2026/0907/c21677a581934/page.htm"
    calls: list[str] = []

    def fake_fetch(url: str, validators=None):
        calls.append(url)
        return {
            "notModified": False,
            "url": url,
            "html": _list_html([(article_url, "【讲座预告】信念与责任")]),
            "etag": None,
            "lastModified": None,
        }

    service._fetch = fake_fetch  # type: ignore[method-assign]
    state = {"version": 1, "categories": {}, "articles": []}
    service._refresh_index(state, ["lectures"], pages=2)

    assert state["articles"][0]["category"] == "lectures"
    assert calls[:2] == [
        "https://jwc.seu.edu.cn/cbxx/list.htm",
        "https://jwc.seu.edu.cn/cbxx/list2.htm",
    ]


def test_balanced_search_refreshes_on_miss_and_saves_snapshot(tmp_path: Path) -> None:
    service = JwcService(cache_dir=str(tmp_path / "jwc"), background_sync=False)
    article_url = "https://jwc.seu.edu.cn/2026/0917/c21678a583507/page.htm"
    calls: list[str] = []

    def fake_fetch(url: str, validators=None):
        calls.append(url)
        if url.endswith("/jwxx/list.htm"):
            return {
                "notModified": False,
                "url": url,
                "html": _list_html([(article_url, "秋季学期课程停开通知")]),
                "etag": "list-v1",
                "lastModified": None,
            }
        return {
            "notModified": False,
            "url": url,
            "html": _detail_html("秋季学期课程停开通知", "2026-09-17", "请及时改选其它课程。"),
            "etag": "article-v1",
            "lastModified": None,
        }

    service._fetch = fake_fetch  # type: ignore[method-assign]
    result = service.list_articles(categories=["academic"], freshness="balanced")
    sync = service.sync_pending()
    detail = service.get_article(result["results"][0]["id"], refresh=False)

    assert result["source"] == "network_validated"
    assert result["results"][0]["detailStatus"] == "queued"
    assert sync["completed"] == 1
    assert detail["article"]["content"] == "请及时改选其它课程。 附件.xlsx"
    assert detail["article"]["attachments"][0]["name"] == "附件.xlsx"
    assert len(list((tmp_path / "jwc" / "versions").rglob("*.json"))) == 1
    assert calls == ["https://jwc.seu.edu.cn/jwxx/list.htm", article_url]


def test_latest_always_validates_but_hash_deduplicates_snapshot(tmp_path: Path) -> None:
    service = JwcService(cache_dir=str(tmp_path / "jwc"), background_sync=False)
    article_url = "https://jwc.seu.edu.cn/2026/0917/c21678a583507/page.htm"

    def fake_fetch(url: str, validators=None):
        if url.endswith("list.htm"):
            return {
                "notModified": bool(validators),
                "url": url,
                "html": "" if validators else _list_html([(article_url, "最新选课通知")]),
                "etag": "list-v1",
                "lastModified": None,
            }
        return {
            "notModified": bool(validators),
            "url": url,
            "html": "" if validators else _detail_html("最新选课通知", "2026-09-17", "正文"),
            "etag": "article-v1",
            "lastModified": None,
        }

    service._fetch = fake_fetch  # type: ignore[method-assign]
    first = service.list_articles(categories=["academic"], freshness="latest", time_scope="latest")
    service.sync_pending()
    second = service.list_articles(categories=["academic"], freshness="latest", time_scope="latest")
    service.sync_pending()

    assert first["networkChecked"] is True
    assert second["networkChecked"] is True
    assert second["freshnessGuaranteed"] is True
    assert len(second["results"]) == 1
    assert len(list((tmp_path / "jwc" / "versions").rglob("*.json"))) == 1


def test_recent_scope_filters_old_results(tmp_path: Path) -> None:
    service = JwcService(cache_dir=str(tmp_path / "jwc"), background_sync=False)
    today = datetime.now(timezone.utc).date()
    recent = today.isoformat()
    old = (today - timedelta(days=30)).isoformat()
    state = {
        "version": 1,
        "categories": {"academic": {"lastCheckedAt": datetime.now(timezone.utc).isoformat()}},
        "articles": [
            {"id": "new", "url": "https://jwc.seu.edu.cn/2026/0917/c1a100/page.htm", "title": "选课通知", "publishedAt": recent, "category": "academic"},
            {"id": "old", "url": "https://jwc.seu.edu.cn/2026/0817/c1a101/page.htm", "title": "选课通知", "publishedAt": old, "category": "academic"},
        ],
    }
    service.cache_dir.mkdir(parents=True)
    service.index_file.write_text(__import__("json").dumps(state), encoding="utf-8")

    result = service.list_articles(
        categories=["academic"], freshness="cache_only", time_scope="recent", recent_days=7
    )

    assert [item["id"] for item in result["results"]] == ["seu-jwc-100"]
    assert result["networkChecked"] is False


def test_pdf_viewer_is_unwrapped_as_attachment(tmp_path: Path) -> None:
    service = JwcService(cache_dir=str(tmp_path / "jwc"), background_sync=False)
    article_url = "https://jwc.seu.edu.cn/2026/0710/c23285a576338/page.htm"
    pdf_path = "/_upload/article/files/demo/uuid-file.pdf"

    def fake_fetch(url: str, validators=None):
        if url.endswith("/jwxx/list.htm"):
            return {
                "notModified": False,
                "url": url,
                "html": _list_html([(article_url, "暑期工作安排")]),
                "etag": None,
                "lastModified": None,
            }
        return {
            "notModified": False,
            "url": url,
            "html": f"""
              <span class="Article_Title">暑期工作安排</span>
              <div class="wp_articlecontent">
                <span class="wp_pdf_player" pdfsrc="{pdf_path}"
                  sudyfile-attr="{{'title':'暑期工作安排.pdf'}}"></span>
              </div>
            """,
            "etag": None,
            "lastModified": None,
        }

    service._fetch = fake_fetch  # type: ignore[method-assign]
    service._search_remote = lambda query, category: [{
        "id": "seu-jwc-576338",
        "url": article_url,
        "title": "暑期工作安排",
        "publishedAt": "2026-07-10",
        "categoryLabel": "教务信息",
    }]  # type: ignore[method-assign]
    result = service.search("暑期工作安排", categories=["academic"])
    service.sync_pending()
    detail = service.get_article(result["results"][0]["id"], refresh=False)

    attachment = detail["article"]["attachments"][0]
    assert attachment["url"] == f"https://jwc.seu.edu.cn{pdf_path}"
    assert attachment["name"] == "暑期工作安排.pdf"


@pytest.mark.parametrize("site", ["jwc", "cse"])
def test_read_confirmed_attachment_uses_temp_and_cleans_up(
    monkeypatch: pytest.MonkeyPatch, site: str
) -> None:
    if site == "cse":
        service = CseService(background_sync=False)
        base_url = "https://cse.seu.edu.cn"
        article_id = "seu-cse-123"
        expected_label = "计软智网站"
    else:
        service = JwcService(background_sync=False)
        base_url = "https://jwc.seu.edu.cn"
        article_id = "seu-jwc-123"
        expected_label = "教务处"
    article_url = f"{base_url}/2026/0921/c1a123/page.htm"
    attachment_url = f"{base_url}/_upload/article/files/demo/notice.pdf"
    article = {
        "id": article_id,
        "title": "附件通知",
        "url": article_url,
        "contentHash": "hash",
        "attachments": [{"name": "notice.pdf", "url": attachment_url}],
    }
    service.get_article = lambda *_args, **_kwargs: {  # type: ignore[method-assign]
        "status": "completed",
        "article": article,
    }
    pdf_bytes = _text_pdf_bytes("Attachment parser works")
    requests = []

    def fake_urlopen(request, timeout):
        requests.append((request, timeout))
        return _FakeDownload(pdf_bytes, attachment_url)

    parsed_paths: list[Path] = []

    def tracking_parse(path: str, filename: str | None = None):
        parsed_path = Path(path)
        parsed_paths.append(parsed_path)
        assert parsed_path.is_file()
        assert str(parsed_path.resolve()).lower().startswith(
            str(Path(tempfile.gettempdir()).resolve()).lower()
        )
        return real_parse_document(path, filename)

    monkeypatch.setattr(jwc_module, "urlopen", fake_urlopen)
    monkeypatch.setattr(jwc_module, "parse_document", tracking_parse)

    result = service.read_attachment(article_id)

    assert result["message"] == f"已读取{expected_label}附件：notice.pdf"
    assert "Attachment parser works" in result["attachment"]["markdown"]
    assert result["attachment"]["sizeBytes"] == len(pdf_bytes)
    assert requests[0][0].full_url == attachment_url
    assert requests[0][0].get_header("Referer") == article_url
    assert parsed_paths and not parsed_paths[0].exists()


def test_read_attachment_rejects_unconfirmed_cross_origin_url() -> None:
    service = JwcService(background_sync=False)
    service.get_article = lambda *_args, **_kwargs: {  # type: ignore[method-assign]
        "status": "completed",
        "article": {
            "id": "seu-jwc-123",
            "title": "附件通知",
            "url": "https://jwc.seu.edu.cn/2026/0921/c1a123/page.htm",
            "attachments": [{
                "name": "notice.pdf",
                "url": "https://example.com/notice.pdf",
            }],
        },
    }

    with pytest.raises(ValueError, match="同源"):
        service.read_attachment("seu-jwc-123")


@pytest.mark.parametrize("site", ["jwc", "cse"])
def test_read_attachment_directly_from_notice_url(
    monkeypatch: pytest.MonkeyPatch, site: str
) -> None:
    if site == "cse":
        service = CseService(background_sync=False)
        base_url = "https://cse.seu.edu.cn"
        expected_id = "seu-cse-583969"
        title_class = "arti_title"
    else:
        service = JwcService(background_sync=False)
        base_url = "https://jwc.seu.edu.cn"
        expected_id = "seu-jwc-583969"
        title_class = "Article_Title"
    article_url = f"{base_url}/2026/0921/c21680a583969/page.psp"
    pdf_path = "/_upload/article/files/demo/direct.pdf"
    attachment_url = f"{base_url}{pdf_path}"
    pdf_bytes = _text_pdf_bytes("Direct URL parser works")

    service._fetch = lambda url, validators=None: {  # type: ignore[method-assign]
        "notModified": False,
        "url": url,
        "html": f"""
          <span class="{title_class}">直接链接通知</span>
          <div class="wp_articlecontent">
            <span class="wp_pdf_player" pdfsrc="{pdf_path}"
              sudyfile-attr="{{'title':'直接链接附件.pdf'}}"></span>
          </div>
        """,
        "etag": None,
        "lastModified": None,
    }
    monkeypatch.setattr(
        jwc_module,
        "urlopen",
        lambda request, timeout: _FakeDownload(pdf_bytes, attachment_url),
    )

    result = service.read_attachment(notice_url=article_url)

    assert result["article"]["id"] == expected_id
    assert result["article"]["url"] == article_url
    assert result["attachment"]["name"] == "直接链接附件.pdf"
    assert "Direct URL parser works" in result["attachment"]["markdown"]


def test_read_attachment_notice_url_is_restricted_to_matching_site() -> None:
    service = JwcService(background_sync=False)

    with pytest.raises(ValueError, match="通知详情页"):
        service.read_attachment(
            notice_url="https://example.com/2026/0921/c21680a583969/page.psp"
        )

    with pytest.raises(ValueError, match="只能提供"):
        service.read_attachment(
            "seu-jwc-583969",
            notice_url="https://jwc.seu.edu.cn/2026/0921/c21680a583969/page.psp",
        )


def test_search_queries_each_explicit_category_and_deduplicates(tmp_path: Path) -> None:
    service = JwcService(cache_dir=str(tmp_path / "jwc"), background_sync=False)
    calls: list[str] = []

    def fake_search(query: str, category: str):
        calls.append(category)
        return [{
            "id": "seu-jwc-1",
            "url": "https://jwc.seu.edu.cn/2026/0918/c21677a1/page.htm",
            "title": "same notice",
            "publishedAt": "2026-09-18",
            "categoryLabel": "unmapped column",
        }]

    service._search_remote = fake_search  # type: ignore[method-assign]
    result = service.search(
        "notice", categories=["academic", "lectures"], limit=10
    )

    assert calls == ["academic", "lectures"]
    assert [item["id"] for item in result["results"]] == ["seu-jwc-1"]
    assert result["results"][0]["category"] == "academic"

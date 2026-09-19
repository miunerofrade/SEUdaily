from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

from cvstream.jwc import JWC_CATEGORIES, JwcService, _article_id


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


def test_article_id_ignores_column_alias() -> None:
    first = "https://jwc.seu.edu.cn/2026/0710/c23285a576338/page.htm"
    second = "https://jwc.seu.edu.cn/2026/0710/c21676a576338/page.htm"
    assert _article_id(first) == _article_id(second) == "seu-jwc-576338"


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

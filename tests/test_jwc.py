from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

from cvstream.jwc import JwcService, _article_id


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
    result = service.search("课程停开", freshness="balanced")
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
    first = service.search("选课", freshness="latest", time_scope="latest")
    service.sync_pending()
    second = service.search("选课", freshness="latest", time_scope="latest")
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

    result = service.search(
        "选课", freshness="cache_only", time_scope="recent", recent_days=7
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
    result = service.search("暑期工作安排", categories=["academic"])
    service.sync_pending()
    detail = service.get_article(result["results"][0]["id"], refresh=False)

    attachment = detail["article"]["attachments"][0]
    assert attachment["url"] == f"https://jwc.seu.edu.cn{pdf_path}"
    assert attachment["name"] == "暑期工作安排.pdf"

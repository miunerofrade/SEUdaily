from __future__ import annotations

from pathlib import Path

from cvstream.jwc import CseService, _article_id


def test_cse_uses_site_specific_stable_id() -> None:
    url = "https://cse.seu.edu.cn/2026/0912/c49469a582946/page.htm"
    assert _article_id(url, "seu-cse") == "seu-cse-582946"


def test_cse_adapter_routes_and_parses_article(tmp_path: Path) -> None:
    service = CseService(cache_dir=str(tmp_path / "cse"), background_sync=False)
    article_url = "https://cse.seu.edu.cn/2026/0912/c49469a582946/page.htm"
    pdf_path = "/_upload/article/files/demo/recommendation.pdf"

    def fake_fetch(url: str, validators=None):
        if url.endswith("/49469/list.htm"):
            return {
                "notModified": False,
                "url": url,
                "html": f'<a href="{article_url}">关于学院拟推荐免试攻读研究生名单的公示</a>',
                "etag": "list-v1",
                "lastModified": None,
            }
        return {
            "notModified": False,
            "url": url,
            "html": f"""
              <h1 class="arti_title">关于学院拟推荐免试攻读研究生名单的公示</h1>
              <span class="arti_update">发布时间：2026-09-12</span>
              <div class="wp_articlecontent">
                <p>现将拟推荐名单进行公示。</p>
                <span class="wp_pdf_player" pdfsrc="{pdf_path}"
                  sudyfile-attr="{{'title':'拟推荐名单.pdf'}}"></span>
              </div>
            """,
            "etag": "detail-v1",
            "lastModified": None,
        }

    service._fetch = fake_fetch  # type: ignore[method-assign]
    service._search_remote = lambda query, category: [{
        "id": "seu-cse-582946",
        "url": article_url,
        "title": "关于学院拟推荐免试攻读研究生名单的公示",
        "publishedAt": "2026-09-12",
        "categoryLabel": "本科生通知公告",
    }]  # type: ignore[method-assign]
    result = service.search(
        "本科推免名单", categories=["undergraduate_notices"]
    )
    synced = service.sync_pending()
    detail = service.get_article(result["results"][0]["id"], refresh=False)["article"]

    assert result["categories"] == ["undergraduate_notices"]
    assert result["results"][0]["id"] == "seu-cse-582946"
    assert synced["completed"] == 1
    assert detail["publishedAt"] == "2026-09-12"
    assert detail["content"] == "现将拟推荐名单进行公示。"
    assert detail["attachments"] == [{
        "name": "拟推荐名单.pdf",
        "url": "https://cse.seu.edu.cn/_upload/article/files/demo/recommendation.pdf",
    }]

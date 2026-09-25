from __future__ import annotations

from pathlib import Path

import cvstream.jwc as jwc_module
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


def test_cse_search_without_scope_uses_site_search(tmp_path: Path) -> None:
    service = CseService(cache_dir=str(tmp_path / "cse"), background_sync=False)
    calls: list[str | None] = []
    service._search_remote = lambda query, category: calls.append(category) or [{
        "id": "seu-cse-582946",
        "url": "https://cse.seu.edu.cn/2026/0912/c49469a582946/page.htm",
        "title": "关于学院拟推荐免试攻读研究生名单的公示",
        "publishedAt": "2026-09-12",
        "categoryLabel": "本科生通知公告",
    }]  # type: ignore[method-assign]

    result = service.search("推免名单")

    assert calls == [None]
    assert result["categories"] == []
    assert result["paths"] == []
    assert result["searchScope"] == "site"


def test_cse_site_search_uses_search_form_and_endpoint(monkeypatch, tmp_path: Path) -> None:
    listing_html = """
      <form action="/_web/_search/api/search/new.rst?_p=site-context" method="post">
        <input name="keyword" />
      </form>
    """
    search_html = """
      <script>
        url:'../searchCon/create.rst?_p=site-context'+'&tt='+Math.random(),
      </script>
    """
    result_payload = {
        "data": """
          <div class="result_item clearfix">
            <input name="id" value="582946">
            <h3 class="item_title"><a href="/2026/0912/c49469a582946/page.htm">通知标题</a></h3>
            <span>发布时间:2026-09-12</span>
            <span>目录:本科生通知公告</span>
          </div>
        """,
    }
    requests: list[tuple[str, bytes | None]] = []

    class FakeResponse:
        def __init__(self, body: str) -> None:
            self.body = body
            self.headers = type("Headers", (), {"get_content_charset": lambda self: "utf-8"})()

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def read(self) -> bytes:
            return self.body.encode()

    class FakeOpener:
        def open(self, request, timeout):
            requests.append((request.full_url, request.data))
            if len(requests) == 1:
                return FakeResponse(listing_html)
            if len(requests) == 2:
                return FakeResponse(search_html)
            return FakeResponse(__import__("json").dumps(result_payload))

    monkeypatch.setattr(jwc_module, "build_opener", lambda *args: FakeOpener())
    service = CseService(cache_dir=str(tmp_path / "cse"), background_sync=False)

    result = service._search_remote("推免名单", None)

    assert len(result) == 1
    assert result[0]["id"] == "seu-cse-582946"
    assert requests[0][0] == "https://cse.seu.edu.cn/"
    assert requests[1][0].startswith("https://cse.seu.edu.cn/_web/_search/api/search/new.rst")
    assert requests[2][0].startswith("https://cse.seu.edu.cn/_web/_search/api/searchCon/create.rst")

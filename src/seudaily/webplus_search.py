"""WebPlus search request protocol and result parsing."""

from __future__ import annotations
from typing import Any
import base64
import json
import re
import time
from html import unescape
from urllib.parse import urlencode, urljoin
from urllib.request import HTTPCookieProcessor, Request
from .webplus_page import _clean


def _search_remote(
    self, query: str, category: str | None, *, opener_factory
) -> list[dict[str, Any]]:
    list_url = (
        urljoin(self.base_url, self.config.categories[category][1])
        if category is not None
        else f"{self.base_url}/"
    )
    opener = opener_factory(HTTPCookieProcessor())
    headers = {"User-Agent": "Mozilla/5.0 (SEUdaily)", "Referer": list_url}
    with opener.open(
        Request(list_url, headers=headers), timeout=self.timeout_seconds
    ) as response:
        encoding = response.headers.get_content_charset() or "utf-8"
        listing_html = response.read().decode(encoding, errors="replace")
    search_form_match = re.search(
        r"<form\b[^>]+action=['\"]([^'\"]*?/search/new\.rst\?[^'\"]*)['\"]",
        listing_html,
        re.I,
    )
    if search_form_match:
        search_page = urljoin(list_url, unescape(search_form_match.group(1)))
        form_request = Request(
            search_page,
            data=urlencode({"keyword": query, "submit": ""}).encode(),
            headers={
                **headers,
                "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
            },
            method="POST",
        )
        with opener.open(form_request, timeout=self.timeout_seconds) as response:
            encoding = response.headers.get_content_charset() or "utf-8"
            search_html = response.read().decode(encoding, errors="replace")
    else:
        search_path_match = re.search(r'id="securl" value="([^"]+)"', listing_html)
        if not search_path_match:
            raise RuntimeError(f"栏目没有可用的站内搜索入口: {list_url}")
        search_page = urljoin(list_url, search_path_match.group(1))
        with opener.open(
            Request(search_page, headers=headers), timeout=self.timeout_seconds
        ) as response:
            encoding = response.headers.get_content_charset() or "utf-8"
            search_html = response.read().decode(encoding, errors="replace")
    endpoint_match = re.search(
        r"url:'([^']*searchCon/create\.rst\?[^']+)'", search_html
    )
    if not endpoint_match:
        raise RuntimeError(f"无法解析站内搜索接口: {search_page}")
    endpoint = urljoin(search_page, endpoint_match.group(1))
    infos = [
        {"field": "pageIndex", "value": 1},
        {"field": "group", "value": 0},
        {"field": "searchType", "value": self.config.search_type},
        {"field": "keyword", "value": query},
        {"field": "recommend", "value": 1},
        *({"field": field, "value": ""} for field in (4, 5, 6, 7)),
    ]
    encoded = base64.b64encode(
        json.dumps(infos, ensure_ascii=False, separators=(",", ":")).encode()
    ).decode()
    request = Request(
        f"{endpoint}&tt={time.time()}",
        data=urlencode({"searchInfo": encoded}).encode(),
        headers={
            **headers,
            "X-Requested-With": "XMLHttpRequest",
            "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
        },
        method="POST",
    )
    with opener.open(request, timeout=self.timeout_seconds) as response:
        encoding = response.headers.get_content_charset() or "utf-8"
        payload = json.loads(response.read().decode(encoding, errors="replace"))
    return self._parse_search_results(payload.get("data", ""))


def _parse_search_results(self, html: str, *, now_iso) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    blocks = re.findall(
        r'<div class="result_item clearfix">(.*?)(?=<div class="result_item clearfix">|$)',
        html,
        re.S,
    )
    for block in blocks:
        article_id = re.search(r'name="id" value="(\d+)"', block)
        link = re.search(r'<h3 class="item_title">\s*<a href=[\'\"]([^\'\"]+)', block)
        title = re.search(r'<h3 class="item_title">.*?>(.*?)</a>', block, re.S)
        date = re.search(r"发布时间\s*[:：]\s*(\d{4}-\d{2}-\d{2})", block)
        category = re.search(r"目录\s*[:：]\s*([^<]+)", block)
        if not article_id or not link or not title:
            continue
        result_url = self._normalize_url(urljoin(self.base_url, link.group(1)))
        results.append(
            {
                "id": f"{self.config.id_prefix}-{article_id.group(1)}",
                "url": result_url,
                "title": _clean(re.sub(r"<[^>]+>", "", title.group(1))),
                "publishedAt": date.group(1) if date else "",
                "categoryLabel": _clean(category.group(1)) if category else "",
                "firstSeenAt": now_iso(),
                "lastSeenAt": now_iso(),
            }
        )
    return results

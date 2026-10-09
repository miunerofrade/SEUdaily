from __future__ import annotations
from . import webplus_search, notice_sync

import base64
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from html import unescape
from html.parser import HTMLParser
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, unquote, urlencode, urljoin, urlparse
from urllib.request import HTTPCookieProcessor, ProxyHandler, Request, build_opener

from .json_store import write_json_atomic
from .web_download import read_chunks
from .document_parser import SUPPORTED_DOCUMENT_EXTENSIONS, parse_document
from .vpn import CampusProxyHandler, campus_proxy


_CAMPUS_ACCESS_NOTICE = re.compile(
    r"(?:当前\s*ip并非校内地址|仅允许校内地址访问|仅限(?:校园网|校内)(?:用户|地址)?访问|"
    r"(?:请|需要|必须)[^。\n]{0,30}(?:校园网|VPN)[^。\n]{0,20}访问)",
    re.I,
)


class _NoticeResponse:
    """Preserve the inspected prefix when streaming an attachment."""

    def __init__(self, response, prefix):
        self.response = response
        self.prefix = prefix

    def __getattr__(self, name):
        return getattr(self.response, name)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return self.response.__exit__(*args)

    def read(self, size=-1):
        if size < 0:
            prefix, self.prefix = self.prefix, b""
            return prefix + self.response.read()
        prefix, self.prefix = self.prefix[:size], self.prefix[size:]
        return prefix + self.response.read(size - len(prefix))


class _NoticeOpener:
    def __init__(self, handlers):
        self.handlers = handlers

    def _open(self, request, timeout, proxy=None):
        proxy_handler = (
            CampusProxyHandler({"http": proxy, "https": proxy})
            if proxy
            else ProxyHandler({})
        )
        # Search requests share their cookie jar across direct and VPN requests.
        handlers = [
            HTTPCookieProcessor(h.cookiejar)
            if isinstance(h, HTTPCookieProcessor)
            else h
            for h in self.handlers
        ]
        opener = build_opener(proxy_handler, *handlers)
        # urllib mutates requests for proxy transport; each attempt gets a fresh copy.
        fresh = Request(
            request.full_url,
            data=request.data,
            headers=dict(request.header_items()),
            method=request.get_method(),
        )
        response = opener.open(fresh, timeout=timeout)
        try:
            prefix = response.read(8192)
            text = prefix.decode("utf-8", errors="replace")
            gate = re.search(
                r'<div[^>]*class=[\'"]wp_error_msg[\'"][^>]*>(.*?)</div>', text, re.S
            )
            if gate and _CAMPUS_ACCESS_NOTICE.search(
                unescape(re.sub(r"<[^>]*>", " ", gate[1]))
            ):
                raise PermissionError("该通知仅限校园网或校园 VPN 访问")
            return _NoticeResponse(response, prefix)
        except BaseException:
            response.close()
            raise

    def open(self, request, timeout):
        try:
            return self._open(request, timeout)
        except (HTTPError, URLError, TimeoutError, OSError) as error:
            if isinstance(error, HTTPError) and error.code != 403:
                raise
            proxy = campus_proxy()
            if proxy:
                if isinstance(error, HTTPError):
                    error.close()
                return self._open(request, timeout, proxy)
            raise


def public_opener(*handlers):
    """Try public access first; use a connected VPN only for restricted/failed access."""
    return _NoticeOpener(handlers)


from .webplus_page import (
    _ARTICLE_PATH,
    _SPACE,
    _VOID_TAGS,
    _load_notice_sources,
    _load_notice_categories,
    _NOTICE_SOURCES,
    _NOTICE_CATEGORIES,
    JWC_CATEGORIES,
    CSE_CATEGORIES,
    WebplusSiteConfig,
    JWC_CONFIG,
    CSE_CONFIG,
    _clean,
    _article_id,
    _PageParser,
)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso_now() -> str:
    return _now().isoformat()


class WebplusNoticeAdapter:
    """WebPlus list/search/detail adapter with shared local-first persistence."""

    def __init__(
        self,
        base_url: str = "https://jwc.seu.edu.cn",
        cache_dir: str = ".seudaily/jwc",
        timeout_seconds: int = 15,
        background_sync: bool = True,
        config: WebplusSiteConfig = JWC_CONFIG,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.cache_dir = Path(cache_dir)
        self.timeout_seconds = timeout_seconds
        self.background_sync = background_sync
        self.config = config
        self.index_file = self.cache_dir / "index.json"
        self.articles_dir = self.cache_dir / "articles"
        self.versions_dir = self.cache_dir / "versions"
        self.queue_file = self.cache_dir / "pending-details.json"
        self.failures_file = self.cache_dir / "detail-failures.json"
        self.queue_lock_file = self.cache_dir / "pending-details.lock"
        self.worker_lock_file = self.cache_dir / "detail-worker.lock"

    def search(
        self,
        query: str,
        *,
        categories: list[str] | None = None,
        paths: list[str] | None = None,
        freshness: str = "balanced",
        time_scope: str = "any",
        recent_days: int = 7,
        limit: int = 5,
    ) -> dict[str, Any]:
        selected = self._categories(categories, paths, allow_all=True)
        remote_by_url: dict[str, dict[str, Any]] = {}
        for category in selected or [None]:
            for item in self._search_remote(query, category):
                if category is not None:
                    item.setdefault("_sourceCategory", category)
                remote_by_url.setdefault(item["url"], item)
        state = self._load_index()
        articles = {item["url"]: item for item in state["articles"]}
        chosen: list[dict[str, Any]] = []
        for item in list(remote_by_url.values())[:limit]:
            source_category = item.get("_sourceCategory")
            stored_item = {
                key: value for key, value in item.items() if not key.startswith("_")
            }
            article = articles.setdefault(
                item["url"],
                {"id": item["id"], "url": item["url"], "firstSeenAt": _iso_now()},
            )
            article.update(stored_item)
            article["category"] = self._category_for_label(
                item.get("categoryLabel", ""), selected, fallback=source_category
            )
            chosen.append(article)
        state["articles"] = list(articles.values())
        self._save_index(state)
        warnings: list[str] = []
        queued_ids: list[str] = []
        if chosen:
            queued_ids = self._enqueue_details(chosen)
            if self.background_sync:
                try:
                    self._start_worker()
                except Exception as exc:
                    warnings.append(f"后台详情同步启动失败: {exc}")

        results = []
        for article in chosen:
            public = self._public_article(article)
            public["detailStatus"] = (
                "cached" if article.get("contentHash") else "queued"
            )
            results.append(public)
        return {
            "status": "completed",
            "query": query,
            "freshness": "remote_search",
            "timeScope": "any",
            "recentDays": None,
            "freshnessGuaranteed": True,
            "source": "site_search",
            "networkChecked": True,
            "refreshReasons": ["site_search_api"],
            "categories": selected,
            "paths": [self.config.categories[key][1] for key in selected],
            "searchScope": "site" if not selected else "categories",
            "results": results,
            "backgroundSync": {
                "queuedIds": queued_ids,
                "status": "scheduled" if queued_ids else "not_needed",
            },
            "warnings": warnings,
            "cache": {
                "path": str(self.index_file),
                "lastRefreshAt": {
                    key: state["categories"].get(key, {}).get("lastCheckedAt")
                    for key in selected
                },
            },
        }

    def list_articles(
        self,
        *,
        categories: list[str] | None = None,
        paths: list[str] | None = None,
        freshness: str = "latest",
        time_scope: str = "any",
        recent_days: int = 7,
        limit: int = 5,
    ) -> dict[str, Any]:
        if freshness not in {"latest", "balanced", "archive", "cache_only"}:
            raise ValueError("freshness 必须是 latest、balanced、archive 或 cache_only")
        if time_scope not in {"latest", "recent", "any"}:
            raise ValueError("timeScope 必须是 latest、recent 或 any")
        if not 1 <= recent_days <= 3650:
            raise ValueError("recentDays 必须在 1 到 3650 之间")
        selected = self._categories(categories, paths)
        state = self._load_index()
        network_checked = False
        warnings: list[str] = []
        if freshness != "cache_only":
            try:
                self._refresh_index(
                    state, selected, pages=3 if freshness == "archive" else 1
                )
                network_checked = True
            except Exception as exc:
                warnings.append(f"远端刷新失败，返回本地结果: {exc}")
        cutoff = (_now() - timedelta(days=recent_days)).date().isoformat()
        articles = [
            item
            for item in state["articles"]
            if item.get("category") in selected
            and (time_scope != "recent" or item.get("publishedAt", "") >= cutoff)
        ]
        articles.sort(key=lambda item: item.get("publishedAt", ""), reverse=True)
        chosen = articles[:limit]
        self._save_index(state)
        queued_ids: list[str] = []
        if freshness != "cache_only" and chosen:
            queued_ids = self._enqueue_details(chosen)
            if self.background_sync:
                try:
                    self._start_worker()
                except Exception as exc:
                    warnings.append(f"后台详情同步启动失败: {exc}")
        return {
            "status": "completed",
            "freshness": freshness,
            "timeScope": time_scope,
            "recentDays": recent_days if time_scope == "recent" else None,
            "freshnessGuaranteed": network_checked and not warnings,
            "source": "network_validated" if network_checked else "local_cache",
            "networkChecked": network_checked,
            "categories": selected,
            "paths": [self.config.categories[key][1] for key in selected],
            "results": [
                {
                    **self._public_article(item),
                    "detailStatus": "cached" if item.get("contentHash") else "queued",
                }
                for item in chosen
            ],
            "backgroundSync": {
                "queuedIds": queued_ids,
                "status": "scheduled" if queued_ids else "not_needed",
            },
            "warnings": warnings,
        }

    def get_article(self, article_id: str, *, refresh: bool = True) -> dict[str, Any]:
        state = self._load_index()
        article = next(
            (item for item in state["articles"] if item.get("id") == article_id),
            None,
        )
        if article is None:
            raise ValueError(f"本地列表中不存在公告 id: {article_id}")
        changed = False
        if refresh or not article.get("contentHash"):
            changed = self._refresh_article(article)
        result = self._public_article(article)
        result["detailChanged"] = changed
        result["detailStatus"] = "ready"
        return {"status": "completed", "article": result}

    def read_attachment(
        self,
        article_id: str | None = None,
        *,
        notice_url: str | None = None,
        attachment_number: int = 1,
        refresh: bool = False,
        max_bytes: int = 50 * 1024 * 1024,
    ) -> dict[str, Any]:
        """Download and parse an attachment already discovered on an article page."""
        site_label = self.config.attachment_label or self.config.name
        if bool(article_id) == bool(notice_url):
            raise ValueError("必须且只能提供 articleId 或 noticeUrl 其中一个")
        if notice_url:
            normalized_url = self._validated_notice_url(notice_url)
            response = self._fetch(normalized_url)
            final_url = self._validated_notice_url(response["url"])
            match = _ARTICLE_PATH.search(urlparse(final_url).path)
            article = {
                "id": _article_id(final_url, self.config.id_prefix),
                "url": final_url,
                "publishedAt": (
                    f"{match.group(1)}-{match.group(2)}-{match.group(3)}"
                    if match
                    else ""
                ),
            }
            self._apply_article_response(article, response)
        else:
            detail = self.get_article(str(article_id), refresh=refresh)
            article = detail["article"]
        attachments = article.get("attachments") or []
        if not attachments:
            raise ValueError(f"该{site_label}通知没有已确认的附件")
        if not 1 <= attachment_number <= len(attachments):
            raise ValueError(f"附件序号超出范围：该通知共有 {len(attachments)} 个附件")

        attachment = attachments[attachment_number - 1]
        name = str(attachment.get("name") or f"附件 {attachment_number}")
        url = str(attachment.get("url") or "")
        base_host = (urlparse(self.base_url).hostname or "").lower()
        parsed_url = urlparse(url)
        if (
            parsed_url.scheme not in {"http", "https"}
            or not parsed_url.hostname
            or parsed_url.hostname.lower() != base_host
            or parsed_url.username
            or parsed_url.password
        ):
            raise ValueError(f"附件地址不是{site_label}同源的 HTTP(S) 资源")

        name_extension = Path(name).suffix.lower()
        url_extension = Path(parsed_url.path).suffix.lower()
        extension = (
            name_extension
            if name_extension in SUPPORTED_DOCUMENT_EXTENSIONS
            else url_extension
        )
        if extension not in SUPPORTED_DOCUMENT_EXTENSIONS:
            supported = "、".join(sorted(SUPPORTED_DOCUMENT_EXTENSIONS))
            raise ValueError(f"暂不支持解析该附件格式；支持：{supported}")

        def validate_attachment_url(value):
            parsed = urlparse(value)
            if (
                parsed.scheme not in {"http", "https"}
                or parsed.hostname != base_host
                or parsed.username
                or parsed.password
            ):
                raise ValueError(f"附件下载被重定向到了非{site_label}域名")
            return value

        from .web_attachments import read_attachment

        stored = read_attachment(
            public_opener(),
            url,
            name,
            extension,
            referer=str(article.get("url") or self.base_url),
            timeout=self.timeout_seconds,
            max_bytes=max_bytes,
            validate_url=validate_attachment_url,
            parse_document=parse_document,
            refresh=refresh,
            source_name=self.config.name,
            notice=article,
        )
        warnings = (
            []
            if stored.get("markdown", "").strip()
            else ["附件没有可提取的文本层，可能是扫描版文档，需要 OCR。"]
        )
        return {
            "status": "completed",
            "message": f"已读取{site_label}附件：{name}",
            "article": {
                key: article[key]
                for key in ("id", "title", "publishedAt", "url", "contentHash")
                if article.get(key) is not None
            },
            "attachment": {
                **stored,
                "number": attachment_number,
                "extension": extension,
                "extractionMode": "text_layer"
                if extension == ".pdf"
                else "document_structure",
            },
            "warnings": warnings,
        }

    def _validated_notice_url(self, url: str) -> str:
        normalized = self._normalize_url(url)
        parsed = urlparse(normalized)
        base_host = (urlparse(self.base_url).hostname or "").lower()
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.hostname.lower() != base_host
            or parsed.username
            or parsed.password
            or not _ARTICLE_PATH.search(parsed.path)
        ):
            raise ValueError("noticeUrl 必须是对应校内站点的通知详情页地址")
        return normalized

    def sync_pending(self, *, max_workers: int = 4) -> dict[str, Any]:
        return notice_sync.sync_pending(self, max_workers=max_workers, now_iso=_iso_now)

    def _enqueue_details(self, articles: list[dict[str, Any]]) -> list[str]:
        return notice_sync._enqueue_details(self, articles)

    def _start_worker(self) -> None:
        return notice_sync._start_worker(self)

    def _queue_lock(self):
        return notice_sync._queue_lock(self)

    def _read_queue(self) -> list[dict[str, Any]]:
        return notice_sync._read_queue(self)

    def _write_queue(self, jobs: list[dict[str, Any]]) -> None:
        return notice_sync._write_queue(self, jobs)

    def _update_failures(
        self,
        completed: set[str],
        failures: list[dict[str, str]],
    ) -> None:
        return notice_sync._update_failures(self, completed, failures)

    def _load_index(self) -> dict[str, Any]:
        if not self.index_file.exists():
            return {"version": 1, "categories": {}, "articles": []}
        data = json.loads(self.index_file.read_text(encoding="utf-8"))
        if data.get("version") != 1:
            raise ValueError("不支持的教务处缓存版本")
        data.setdefault("categories", {})
        data.setdefault("articles", [])
        normalized: dict[str, dict[str, Any]] = {}
        for article in data["articles"]:
            article["url"] = self._normalize_url(article["url"])
            old_id = article.get("id", "")
            new_id = _article_id(article["url"], self.config.id_prefix)
            article["id"] = new_id
            if old_id and old_id != new_id:
                old_detail = self.articles_dir / f"{old_id}.json"
                new_detail = self.articles_dir / f"{new_id}.json"
                if old_detail.exists() and not new_detail.exists():
                    old_detail.replace(new_detail)
                old_versions = self.versions_dir / old_id
                new_versions = self.versions_dir / new_id
                if old_versions.exists() and not new_versions.exists():
                    new_versions.parent.mkdir(parents=True, exist_ok=True)
                    shutil.move(str(old_versions), str(new_versions))
            normalized[new_id] = {**normalized.get(new_id, {}), **article}
        data["articles"] = list(normalized.values())
        for article in data["articles"]:
            detail_file = self.articles_dir / f"{article.get('id', '')}.json"
            if detail_file.exists():
                detail = json.loads(detail_file.read_text(encoding="utf-8"))
                for key in (
                    "content",
                    "attachments",
                    "contentHash",
                    "validators",
                    "lastCheckedAt",
                ):
                    if detail.get(key) is not None:
                        article[key] = detail[key]
        return data

    def _save_index(self, state: dict[str, Any]) -> None:
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        stored = {
            **state,
            "articles": [
                {
                    key: value
                    for key, value in article.items()
                    if key not in {"content", "attachments", "detailChanged"}
                }
                for article in state["articles"]
            ],
        }
        write_json_atomic(self.index_file, stored)

    def _fetch(
        self, url: str, validators: dict[str, str] | None = None
    ) -> dict[str, Any]:
        headers = {"User-Agent": "SEUdaily/1.0 (+local academic search)"}
        validators = validators or {}
        if validators.get("etag"):
            headers["If-None-Match"] = validators["etag"]
        if validators.get("lastModified"):
            headers["If-Modified-Since"] = validators["lastModified"]
        request = Request(url, headers=headers)
        try:
            with public_opener().open(
                request, timeout=self.timeout_seconds
            ) as response:
                raw = read_chunks(
                    iter(lambda: response.read(65536), b""), max_bytes=5 * 1024 * 1024
                )
                encoding = response.headers.get_content_charset() or "utf-8"
                return {
                    "notModified": False,
                    "url": response.geturl(),
                    "html": raw.decode(encoding, errors="replace"),
                    "etag": response.headers.get("ETag"),
                    "lastModified": response.headers.get("Last-Modified"),
                }
        except HTTPError as exc:
            if exc.code == 304:
                return {"notModified": True, "url": url, "html": ""}
            raise

    def _refresh_index(
        self, state: dict[str, Any], categories: list[str], *, pages: int
    ) -> None:
        articles = {item["url"]: item for item in state["articles"]}
        for category in categories:
            label, path = self.config.categories[category]
            category_state = state["categories"].setdefault(category, {})
            for page in range(1, pages + 1):
                page_path = (
                    path if page == 1 else path.replace("list.htm", f"list{page}.htm")
                )
                url = urljoin(self.base_url, page_path)
                validator_key = f"page{page}"
                validators = category_state.get("validators", {}).get(validator_key, {})
                response = self._fetch(url, validators)
                category_state.setdefault("validators", {})[validator_key] = {
                    "etag": response.get("etag") or validators.get("etag"),
                    "lastModified": response.get("lastModified")
                    or validators.get("lastModified"),
                }
                if response["notModified"]:
                    continue
                parser = _PageParser(response["url"], self.config)
                parser.feed(response["html"])
                for link in parser.anchors:
                    link_url = self._normalize_url(link["href"])
                    match = _ARTICLE_PATH.search(urlparse(link_url).path)
                    title = link["text"]
                    if not match or not title:
                        continue
                    item = articles.setdefault(
                        link_url,
                        {
                            "id": _article_id(link_url, self.config.id_prefix),
                            "url": link_url,
                            "firstSeenAt": _iso_now(),
                        },
                    )
                    item.update(
                        {
                            "title": title,
                            "publishedAt": f"{match.group(1)}-{match.group(2)}-{match.group(3)}",
                            "category": category,
                            "categoryLabel": label,
                            "lastSeenAt": _iso_now(),
                        }
                    )
            category_state["lastCheckedAt"] = _iso_now()
        state["articles"] = list(articles.values())

    def _apply_article_response(
        self, article: dict[str, Any], response: dict[str, Any]
    ) -> bool:
        parser = _PageParser(response["url"], self.config)
        parser.feed(response["html"])
        if not parser.content_seen and not parser.embedded_files:
            raise ValueError("通知正文结构未识别，学校页面可能已变更；保留已有缓存")
        title = parser.title or article.get("title", "")
        content = parser.content
        attachments = [
            {"name": link["text"], "url": link["href"]}
            for link in parser.anchors
            if link["inContent"] == "True"
            and link["href"].startswith(("http://", "https://"))
        ]
        for embedded in parser.embedded_files:
            embedded_url = embedded["url"]
            filename = Path(urlparse(embedded_url).path).name
            if filename.lower().endswith(".pdf") and re.fullmatch(
                r"[0-9a-f-]{20,}\.pdf", filename, re.IGNORECASE
            ):
                filename = f"{title}.pdf"
            attachments.append(
                {
                    "name": embedded.get("name") or filename or "嵌入附件",
                    "url": embedded_url,
                }
            )
        attachments = list({item["url"]: item for item in attachments}.values())
        digest_source = json.dumps(
            {"title": title, "content": content, "attachments": attachments},
            ensure_ascii=False,
            sort_keys=True,
        )
        digest = hashlib.sha256(digest_source.encode("utf-8")).hexdigest()
        changed = digest != article.get("contentHash")
        article.update(
            {
                "title": title,
                "publishedAt": parser.published_at or article.get("publishedAt"),
                "content": content,
                "attachments": attachments,
                "contentHash": digest,
                "validators": {
                    "etag": response.get("etag"),
                    "lastModified": response.get("lastModified"),
                },
            }
        )
        from .saved_web_files import body

        links = (
            "\n\n## 附件\n\n"
            + "\n".join(
                f"- [{item['name']}]({item['url']})"
                for item in attachments
                if not item["url"].endswith(".gif")
            )
            if attachments
            else ""
        )
        body(
            str(article["url"]),
            str(article.get("title") or "通知正文"),
            str(article.get("content") or "") + links,
            source_name=self.config.name,
            notice=article,
        )
        article["lastCheckedAt"] = _iso_now()
        return changed

    def _refresh_article(self, article: dict[str, Any]) -> bool:
        article["url"] = self._normalize_url(article["url"])
        detail_file = self.articles_dir / f"{article['id']}.json"
        if detail_file.exists():
            cached = json.loads(detail_file.read_text(encoding="utf-8"))
            for key in ("content", "attachments", "contentHash", "validators"):
                if cached.get(key) is not None:
                    article[key] = cached[key]
        response = self._fetch(article["url"], article.get("validators"))
        article["lastCheckedAt"] = _iso_now()
        if response["notModified"]:
            return False
        changed = self._apply_article_response(article, response)
        self.articles_dir.mkdir(parents=True, exist_ok=True)
        write_json_atomic(
            detail_file,
            {
                **self._public_article(article),
                "validators": article.get("validators", {}),
            },
        )
        if changed:
            version_dir = self.versions_dir / article["id"]
            version_dir.mkdir(parents=True, exist_ok=True)
            version_file = version_dir / f"{article['contentHash']}.json"
            if not version_file.exists():
                write_json_atomic(
                    version_file,
                    {
                        "capturedAt": _iso_now(),
                        **self._public_article(article),
                    },
                )
        return changed

    def _categories(
        self,
        categories: list[str] | None,
        paths: list[str] | None,
        *,
        allow_all: bool = False,
    ) -> list[str]:
        requested = list(categories or [])
        invalid = set(requested) - set(self.config.categories)
        if invalid:
            raise ValueError(f"未知栏目: {', '.join(sorted(invalid))}")
        if paths:
            path_to_category = {
                path: category for category, (_, path) in self.config.categories.items()
            }
            unknown_paths = [path for path in paths if path not in path_to_category]
            if unknown_paths:
                raise ValueError(f"未知栏目路径: {', '.join(unknown_paths)}")
            requested.extend(path_to_category[path] for path in paths)
        if not requested and allow_all:
            return []
        if not requested:
            raise ValueError("必须显式提供 categories 或 paths，禁止自动栏目路由")
        return list(dict.fromkeys(requested))

    def _category_for_label(
        self,
        label: str,
        selected: list[str],
        *,
        fallback: str | None = None,
    ) -> str:
        if not selected:
            return label or "site_search"
        for category in selected:
            if self.config.categories[category][0] == label:
                return category
        return fallback if fallback in selected else selected[0]

    def _normalize_url(self, url: str) -> str:
        parsed = urlparse(url)
        base = urlparse(self.base_url)
        if (
            parsed.scheme == "http"
            and parsed.hostname == base.hostname
            and base.scheme == "https"
        ):
            return parsed._replace(scheme="https", netloc=base.netloc).geturl()
        return url

    def _search_remote(self, query: str, category: str | None) -> list[dict[str, Any]]:
        return webplus_search._search_remote(self, query, category, opener_factory=public_opener)

    def _parse_search_results(self, html: str) -> list[dict[str, Any]]:
        return webplus_search._parse_search_results(self, html, now_iso=_iso_now)

    @staticmethod
    def _public_article(article: dict[str, Any]) -> dict[str, Any]:
        return {
            key: article.get(key)
            for key in (
                "id",
                "title",
                "publishedAt",
                "category",
                "categoryLabel",
                "url",
                "content",
                "attachments",
                "contentHash",
                "firstSeenAt",
                "lastSeenAt",
                "lastCheckedAt",
                "detailChanged",
            )
            if article.get(key) is not None
        }


class JwcService(WebplusNoticeAdapter):
    """Compatibility entry for existing teaching-affairs callers."""


class CseService(JwcService):
    """SEU Computer Science, Software and AI school WebPlus adapter."""

    def __init__(
        self,
        base_url: str = "https://cse.seu.edu.cn",
        cache_dir: str = ".seudaily/cse",
        timeout_seconds: int = 15,
        background_sync: bool = True,
    ) -> None:
        super().__init__(
            base_url=base_url,
            cache_dir=cache_dir,
            timeout_seconds=timeout_seconds,
            background_sync=background_sync,
            config=CSE_CONFIG,
        )

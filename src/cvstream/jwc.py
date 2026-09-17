from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Any
from urllib.error import HTTPError
from urllib.parse import parse_qs, unquote, urljoin, urlparse
from urllib.request import Request, urlopen


_ARTICLE_PATH = re.compile(r"/(\d{4})/(\d{2})(\d{2})/c\d+a(\d+)/page\.htm$")
_SPACE = re.compile(r"\s+")
_VOID_TAGS = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}

JWC_CATEGORIES = {
    "news": ("最新动态", "/zxdt/list.htm"),
    "academic": ("教务信息", "/jwxx/list.htm"),
    "student_status": ("学籍管理", "/xjgl/list.htm"),
    "practice": ("实践教学", "/sjjx/list.htm"),
    "teaching_research": ("教学研究", "/jxyj/list.htm"),
    "downloads": ("下载专区", "/xzzq/list.htm"),
}

CSE_CATEGORIES = {
    "undergraduate_notices": ("本科生通知公告", "/49469/list.htm"),
    "teaching": ("教学动态", "/49470/list.htm"),
    "student_affairs": ("学生工作通知公告", "/49447/list.htm"),
    "employment": ("就业信息", "/jyxx/list.htm"),
    "research": ("科研动态", "/49441/list.htm"),
    "academic_events": ("学术活动", "/xshd_53564/list.htm"),
    "recruitment": ("人才招聘", "/rczp/list.htm"),
    "undergraduate_downloads": ("本科生下载专区", "/xzzq_53939/list.htm"),
    "graduate_downloads": ("研究生下载专区", "/xzzq_52683/list.htm"),
}


@dataclass(frozen=True)
class WebplusSiteConfig:
    key: str
    id_prefix: str
    categories: dict[str, tuple[str, str]]
    title_classes: frozenset[str]
    date_classes: frozenset[str]
    content_classes: frozenset[str]
    route_rules: tuple[tuple[str, str], ...]
    default_categories: tuple[str, ...]


JWC_CONFIG = WebplusSiteConfig(
    key="jwc",
    id_prefix="seu-jwc",
    categories=JWC_CATEGORIES,
    title_classes=frozenset({"Article_Title"}),
    date_classes=frozenset({"Article_PublishDate"}),
    content_classes=frozenset({"wp_articlecontent", "Article_Content"}),
    route_rules=(
        ("news", "新闻 动态 工作安排 暑期 教务处"),
        ("student_status", "学籍 转专业 推免 毕业 学位 降级 选拔"),
        ("practice", "实践 实习 实验 竞赛 毕设"),
        ("teaching_research", "教研 教材 教改 课程建设 教学成果"),
        ("downloads", "下载 表格 模板 申请表"),
    ),
    default_categories=("academic",),
)

CSE_CONFIG = WebplusSiteConfig(
    key="cse",
    id_prefix="seu-cse",
    categories=CSE_CATEGORIES,
    title_classes=frozenset({"arti_title", "Article_Title"}),
    date_classes=frozenset({"arti_update", "Article_PublishDate"}),
    content_classes=frozenset({"wp_articlecontent", "Article_Content"}),
    route_rules=(
        ("undergraduate_notices", "本科 推免 保研 转专业 分流 选课 公示 免试"),
        ("teaching", "教学 课程 培养 教务 考试"),
        ("student_affairs", "学生 奖学金 助学 活动 评优 党建"),
        ("employment", "就业 招聘 实习 宣讲"),
        ("research", "科研 项目 基金 成果"),
        ("academic_events", "学术 讲座 报告 论坛 会议"),
        ("recruitment", "教师招聘 人才招聘 博士后"),
        ("undergraduate_downloads", "本科下载 本科表格 本科模板 本科申请表"),
        ("graduate_downloads", "研究生下载 研究生表格 研究生模板 研究生申请表"),
    ),
    default_categories=("undergraduate_notices", "student_affairs"),
)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso_now() -> str:
    return _now().isoformat()


def _clean(text: str) -> str:
    return _SPACE.sub(" ", text).strip()


def _article_id(url: str, prefix: str = "seu-jwc") -> str:
    match = _ARTICLE_PATH.search(urlparse(url).path)
    if match:
        return f"{prefix}-{match.group(4)}"
    return f"{prefix}-{hashlib.sha256(url.encode('utf-8')).hexdigest()[:20]}"


class _PageParser(HTMLParser):
    def __init__(self, base_url: str, config: WebplusSiteConfig = JWC_CONFIG) -> None:
        super().__init__(convert_charrefs=True)
        self.base_url = base_url
        self.config = config
        self.anchors: list[dict[str, str]] = []
        self._anchor: dict[str, Any] | None = None
        self._capture_stack: list[set[str]] = []
        self._title_parts: list[str] = []
        self._date_parts: list[str] = []
        self._content_parts: list[str] = []
        self._content_depth = 0
        self.embedded_files: list[dict[str, str]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        classes = set((values.get("class") or "").split())
        if tag not in _VOID_TAGS:
            self._capture_stack.append(classes)
        if classes & self.config.content_classes:
            self._content_depth += 1
        elif self._content_depth and tag not in _VOID_TAGS:
            self._content_depth += 1
        if tag == "a" and values.get("href"):
            self._anchor = {
                "href": urljoin(self.base_url, values["href"] or ""),
                "parts": [],
                "inContent": self._content_depth > 0,
            }
        if self._content_depth or "wp_pdf_player" in classes:
            source = values.get("pdfsrc") or values.get("src") or values.get("data")
            if source:
                metadata = values.get("sudyfile-attr") or ""
                title_match = re.search(r"['\"]title['\"]\s*:\s*['\"]([^'\"]+)", metadata)
                self.embedded_files.append({
                    "url": self._unwrap_file_url(urljoin(self.base_url, source)),
                    "name": _clean(title_match.group(1)) if title_match else "",
                })

    @staticmethod
    def _unwrap_file_url(url: str) -> str:
        parsed = urlparse(url)
        file_values = parse_qs(parsed.query).get("file")
        if file_values:
            return urljoin(url, unquote(file_values[0]))
        return url

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag: str) -> None:
        classes = self._capture_stack.pop() if self._capture_stack else set()
        if tag == "a" and self._anchor is not None:
            self.anchors.append({
                "href": self._anchor["href"],
                "text": _clean("".join(self._anchor["parts"])),
                "inContent": str(self._anchor["inContent"]),
            })
            self._anchor = None
        if self._content_depth:
            self._content_depth -= 1
        if classes & self.config.content_classes:
            self._content_depth = 0

    def handle_data(self, data: str) -> None:
        if self._anchor is not None:
            self._anchor["parts"].append(data)
        active = set().union(*self._capture_stack) if self._capture_stack else set()
        if active & self.config.title_classes:
            self._title_parts.append(data)
        if active & self.config.date_classes:
            self._date_parts.append(data)
        if self._content_depth:
            self._content_parts.append(data)

    @property
    def title(self) -> str:
        return _clean("".join(self._title_parts))

    @property
    def published_at(self) -> str:
        value = _clean("".join(self._date_parts))
        match = re.search(r"\d{4}-\d{2}-\d{2}", value)
        return match.group(0) if match else value

    @property
    def content(self) -> str:
        return _clean(" ".join(self._content_parts))


class JwcService:
    """Layered local-first search for the public SEU academic-affairs site."""

    def __init__(
        self,
        base_url: str = "https://jwc.seu.edu.cn",
        cache_dir: str = ".cvstream/jwc",
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
        self.queue_lock_file = self.cache_dir / "pending-details.lock"
        self.worker_lock_file = self.cache_dir / "detail-worker.lock"

    def search(
        self,
        query: str,
        *,
        keywords: list[str] | None = None,
        categories: list[str] | None = None,
        freshness: str = "balanced",
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
        terms = self._terms(query, keywords)
        selected = self._categories(categories, terms)
        state = self._load_index()
        hits = self._rank(state["articles"], terms, selected, time_scope=time_scope, recent_days=recent_days)
        refresh_reasons: list[str] = []

        warnings: list[str] = []
        network_checked = False
        if freshness != "cache_only":
            refresh_reasons.append("validate_relevant_lists")
            try:
                self._refresh_index(state, selected, pages=1)
                network_checked = True
                hits = self._rank(
                    state["articles"], terms, selected,
                    time_scope=time_scope, recent_days=recent_days,
                )
                if freshness == "archive" and not hits:
                    refresh_reasons.append("archive_expand_after_miss")
                    self._refresh_index(state, selected, pages=3)
                    hits = self._rank(
                        state["articles"], terms, selected,
                        time_scope=time_scope, recent_days=recent_days,
                    )
            except Exception as exc:  # Keep stale cache useful during site outages.
                warnings.append(f"远端刷新失败，返回本地结果: {exc}")

        chosen = hits[:1] if time_scope == "latest" else hits[:limit]
        self._save_index(state)
        queued_ids: list[str] = []
        if freshness != "cache_only" and chosen:
            queued_ids = self._enqueue_details(chosen)
            if self.background_sync:
                try:
                    self._start_worker()
                except Exception as exc:
                    warnings.append(f"后台详情同步启动失败: {exc}")

        results = []
        for article in chosen:
            public = self._public_article(article)
            public["detailStatus"] = "cached" if article.get("contentHash") else "queued"
            results.append(public)
        return {
            "status": "completed",
            "query": query,
            "freshness": freshness,
            "timeScope": time_scope,
            "recentDays": recent_days if time_scope == "recent" else None,
            "freshnessGuaranteed": network_checked and not warnings,
            "source": "network_validated" if network_checked else "local_cache",
            "networkChecked": network_checked,
            "refreshReasons": refresh_reasons,
            "categories": selected,
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

    def sync_pending(self, *, max_workers: int = 4) -> dict[str, Any]:
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        try:
            worker_lock = self.worker_lock_file.open("x", encoding="utf-8")
        except FileExistsError:
            if time.time() - self.worker_lock_file.stat().st_mtime < 600:
                return {"status": "already_running", "completed": 0}
            self.worker_lock_file.unlink(missing_ok=True)
            worker_lock = self.worker_lock_file.open("x", encoding="utf-8")
        try:
            worker_lock.write(str(os.getpid()))
            worker_lock.close()
            with self._queue_lock():
                jobs = self._read_queue()
            if not jobs:
                return {"status": "empty", "completed": 0}
            completed: set[str] = set()
            errors: list[str] = []
            with ThreadPoolExecutor(max_workers=min(max_workers, len(jobs))) as executor:
                futures = {
                    executor.submit(self._refresh_article, dict(job)): job
                    for job in jobs
                }
                for future in as_completed(futures):
                    job = futures[future]
                    try:
                        future.result()
                        completed.add(job["id"])
                    except Exception as exc:
                        errors.append(f"{job['id']}: {exc}")
            with self._queue_lock():
                current = self._read_queue()
                self._write_queue([job for job in current if job.get("id") not in completed])
            return {
                "status": "completed" if not errors else "partial",
                "completed": len(completed),
                "errors": errors,
            }
        finally:
            self.worker_lock_file.unlink(missing_ok=True)

    def _enqueue_details(self, articles: list[dict[str, Any]]) -> list[str]:
        queued_ids = [article["id"] for article in articles]
        with self._queue_lock():
            existing = {job["id"]: job for job in self._read_queue()}
            for article in articles:
                existing[article["id"]] = {
                    key: article.get(key)
                    for key in ("id", "url", "title", "publishedAt", "category", "categoryLabel")
                }
            self._write_queue(list(existing.values()))
        return queued_ids

    def _start_worker(self) -> None:
        command = [
            sys.executable,
            "-m",
            "cvstream.cli",
            "jwc-worker",
            json.dumps({
                "site": self.config.key,
                "baseUrl": self.base_url,
                "cacheDir": str(self.cache_dir),
                "timeoutSeconds": self.timeout_seconds,
            }),
        ]
        creationflags = 0
        if os.name == "nt":
            creationflags = (
                subprocess.CREATE_NEW_PROCESS_GROUP
                | subprocess.DETACHED_PROCESS
                | subprocess.CREATE_NO_WINDOW
            )
        subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
            creationflags=creationflags,
        )

    @contextmanager
    def _queue_lock(self):
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        deadline = time.monotonic() + 3
        while True:
            try:
                handle = self.queue_lock_file.open("x", encoding="utf-8")
                break
            except FileExistsError:
                if time.time() - self.queue_lock_file.stat().st_mtime > 30:
                    self.queue_lock_file.unlink(missing_ok=True)
                    continue
                if time.monotonic() >= deadline:
                    raise TimeoutError("教务处详情队列正在被占用")
                time.sleep(0.05)
        try:
            handle.write(str(os.getpid()))
            handle.close()
            yield
        finally:
            self.queue_lock_file.unlink(missing_ok=True)

    def _read_queue(self) -> list[dict[str, Any]]:
        if not self.queue_file.exists():
            return []
        return json.loads(self.queue_file.read_text(encoding="utf-8"))

    def _write_queue(self, jobs: list[dict[str, Any]]) -> None:
        temp = self.queue_file.with_suffix(".tmp")
        temp.write_text(json.dumps(jobs, ensure_ascii=False, indent=2), encoding="utf-8")
        temp.replace(self.queue_file)

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
                for key in ("content", "attachments", "contentHash", "validators", "lastCheckedAt"):
                    if detail.get(key) is not None:
                        article[key] = detail[key]
        return data

    def _save_index(self, state: dict[str, Any]) -> None:
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        temp = self.index_file.with_suffix(".tmp")
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
        temp.write_text(json.dumps(stored, ensure_ascii=False, indent=2), encoding="utf-8")
        temp.replace(self.index_file)

    def _fetch(self, url: str, validators: dict[str, str] | None = None) -> dict[str, Any]:
        headers = {"User-Agent": "CVStream/0.3 (+local academic search)"}
        validators = validators or {}
        if validators.get("etag"):
            headers["If-None-Match"] = validators["etag"]
        if validators.get("lastModified"):
            headers["If-Modified-Since"] = validators["lastModified"]
        request = Request(url, headers=headers)
        try:
            with urlopen(request, timeout=self.timeout_seconds) as response:
                raw = response.read()
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
                page_path = path if page == 1 else path.replace("list.htm", f"list{page}.htm")
                url = urljoin(self.base_url, page_path)
                validator_key = f"page{page}"
                validators = category_state.get("validators", {}).get(validator_key, {})
                response = self._fetch(url, validators)
                category_state.setdefault("validators", {})[validator_key] = {
                    "etag": response.get("etag") or validators.get("etag"),
                    "lastModified": response.get("lastModified") or validators.get("lastModified"),
                }
                if response["notModified"]:
                    continue
                parser = _PageParser(response["url"], self.config)
                parser.feed(response["html"])
                for link in parser.anchors:
                    match = _ARTICLE_PATH.search(urlparse(link["href"]).path)
                    title = link["text"]
                    if not match or not title:
                        continue
                    item = articles.setdefault(link["href"], {
                        "id": _article_id(link["href"], self.config.id_prefix),
                        "url": link["href"],
                        "firstSeenAt": _iso_now(),
                    })
                    item.update({
                        "title": title,
                        "publishedAt": f"{match.group(1)}-{match.group(2)}-{match.group(3)}",
                        "category": category,
                        "categoryLabel": label,
                        "lastSeenAt": _iso_now(),
                    })
            category_state["lastCheckedAt"] = _iso_now()
        state["articles"] = list(articles.values())

    def _refresh_article(self, article: dict[str, Any]) -> bool:
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
        parser = _PageParser(response["url"], self.config)
        parser.feed(response["html"])
        title = parser.title or article.get("title", "")
        content = parser.content
        attachments = [
            {"name": link["text"], "url": link["href"]}
            for link in parser.anchors
            if link["inContent"] == "True" and link["href"].startswith(("http://", "https://"))
        ]
        for embedded in parser.embedded_files:
            embedded_url = embedded["url"]
            filename = Path(urlparse(embedded_url).path).name
            if filename.lower().endswith(".pdf") and re.fullmatch(
                r"[0-9a-f-]{20,}\.pdf", filename, re.IGNORECASE
            ):
                filename = f"{title}.pdf"
            attachments.append({
                "name": embedded.get("name") or filename or "嵌入附件",
                "url": embedded_url,
            })
        attachments = list({item["url"]: item for item in attachments}.values())
        digest_source = json.dumps(
            {"title": title, "content": content, "attachments": attachments},
            ensure_ascii=False,
            sort_keys=True,
        )
        digest = hashlib.sha256(digest_source.encode("utf-8")).hexdigest()
        changed = digest != article.get("contentHash")
        article.update({
            "title": title,
            "publishedAt": parser.published_at or article.get("publishedAt"),
            "content": content,
            "attachments": attachments,
            "contentHash": digest,
            "validators": {
                "etag": response.get("etag"),
                "lastModified": response.get("lastModified"),
            },
        })
        self.articles_dir.mkdir(parents=True, exist_ok=True)
        detail_file.write_text(
            json.dumps({
                **self._public_article(article),
                "validators": article.get("validators", {}),
            }, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        if changed:
            version_dir = self.versions_dir / article["id"]
            version_dir.mkdir(parents=True, exist_ok=True)
            version_file = version_dir / f"{digest}.json"
            if not version_file.exists():
                version_file.write_text(
                    json.dumps({
                        "capturedAt": _iso_now(),
                        **self._public_article(article),
                    }, ensure_ascii=False, indent=2),
                    encoding="utf-8",
                )
        return changed

    @staticmethod
    def _terms(query: str, keywords: list[str] | None) -> list[str]:
        terms = [_clean(query), *[_clean(item) for item in keywords or []]]
        return list(dict.fromkeys(item.casefold() for item in terms if item))

    def _categories(self, categories: list[str] | None, terms: list[str]) -> list[str]:
        requested = categories or ["auto"]
        invalid = set(requested) - {*self.config.categories, "auto"}
        if invalid:
            raise ValueError(f"未知教务处栏目: {', '.join(sorted(invalid))}")
        if "auto" not in requested:
            return list(dict.fromkeys(requested))
        text = " ".join(terms)
        routed: list[str] = []
        for category, words in self.config.route_rules:
            if any(word in text for word in words.split()):
                routed.append(category)
        return routed[:2] or list(self.config.default_categories)

    @staticmethod
    def _rank(
        articles: list[dict[str, Any]], terms: list[str], categories: list[str],
        *, time_scope: str, recent_days: int,
    ) -> list[dict[str, Any]]:
        ranked: list[tuple[int, str, dict[str, Any]]] = []
        cutoff = (_now() - timedelta(days=recent_days)).date().isoformat()
        for article in articles:
            if article.get("category") not in categories:
                continue
            if time_scope == "recent" and article.get("publishedAt", "") < cutoff:
                continue
            title = article.get("title", "").casefold()
            content = article.get("content", "").casefold()
            score = 0
            for term in terms:
                if term in title:
                    score += 20
                elif term in content:
                    score += 6
                else:
                    parts = [part for part in re.split(r"[\s，。；、]+", term) if len(part) >= 2]
                    score += sum(4 for part in parts if part in title)
                    score += sum(1 for part in parts if part in content)
            if score:
                ranked.append((score, article.get("publishedAt", ""), article))
        if time_scope == "latest":
            ranked.sort(key=lambda item: (item[1], item[0]), reverse=True)
        else:
            ranked.sort(key=lambda item: (item[0], item[1]), reverse=True)
        return [item[2] for item in ranked]

    @staticmethod
    def _public_article(article: dict[str, Any]) -> dict[str, Any]:
        return {
            key: article.get(key)
            for key in (
                "id", "title", "publishedAt", "category", "categoryLabel", "url",
                "content", "attachments", "contentHash", "firstSeenAt", "lastSeenAt",
                "lastCheckedAt", "detailChanged",
            )
            if article.get(key) is not None
        }


class CseService(JwcService):
    """SEU Computer Science, Software and AI school WebPlus adapter."""

    def __init__(
        self,
        base_url: str = "https://cse.seu.edu.cn",
        cache_dir: str = ".cvstream/cse",
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

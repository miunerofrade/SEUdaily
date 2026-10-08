"""School WebPlus configuration and HTML parsing, separate from synchronization."""

from __future__ import annotations
import json
import re
import hashlib
from dataclasses import dataclass
from html import unescape
from html.parser import HTMLParser
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlparse, parse_qs, unquote

_ARTICLE_PATH = re.compile(r"/(\d{4})/(\d{2})(\d{2})/c\d+a(\d+)/page\.(?:htm|psp)$")
_SPACE = re.compile(r"\s+")
_VOID_TAGS = {
    "area",
    "base",
    "br",
    "col",
    "embed",
    "hr",
    "img",
    "input",
    "link",
    "meta",
    "param",
    "source",
    "track",
    "wbr",
}


def _load_notice_sources(path: Path) -> dict:
    """Only known sites and public WebPlus list paths; no extraction DSL."""
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or not {"jwc", "cse"}.issubset(data):
        raise ValueError("通知栏目配置需要 jwc/cse")
    result = {}
    for site, source in data.items():
        if (
            not isinstance(source, dict)
            or not isinstance(source.get("name"), str)
            or not source["name"].strip()
            or source.get("host") != site + ".seu.edu.cn"
        ):
            raise ValueError(f"无效通知机构配置：{site}")
        if site not in {"jwc", "cse"}:
            if "categories" in source:
                raise ValueError("额外来源仅支持机构名称，不支持抓取栏目")
            continue
        categories = source.get("categories")
        if not isinstance(categories, dict) or not categories:
            raise ValueError("通知栏目配置不能为空")
        result[site] = {
            "name": source["name"],
            "host": source["host"],
            "categories": {},
        }
        for key, entry in categories.items():
            if (
                not re.fullmatch(r"[a-z][a-z0-9_]*", key)
                or not isinstance(entry, list)
                or len(entry) != 2
                or not all(isinstance(value, str) for value in entry)
                or not entry[0].strip()
                or not re.fullmatch(r"/[A-Za-z0-9_]+/list\.htm", entry[1])
            ):
                raise ValueError(f"无效通知栏目配置：{site}/{key}")
            result[site]["categories"][key] = (entry[0], entry[1])
        paths = [entry[1] for entry in result[site]["categories"].values()]
        if len(paths) != len(set(paths)):
            raise ValueError(f"通知栏目路径重复：{site}")
    return result


def _load_notice_categories(path: Path) -> dict[str, dict[str, tuple[str, str]]]:
    return {
        key: source["categories"] for key, source in _load_notice_sources(path).items()
    }


_NOTICE_SOURCES = _load_notice_sources(
    Path(__file__).with_name("notice_categories.json")
)
_NOTICE_CATEGORIES = {
    key: source["categories"] for key, source in _NOTICE_SOURCES.items()
}
JWC_CATEGORIES = _NOTICE_CATEGORIES["jwc"]
CSE_CATEGORIES = _NOTICE_CATEGORIES["cse"]


@dataclass(frozen=True)
class WebplusSiteConfig:
    key: str
    name: str
    id_prefix: str
    categories: dict[str, tuple[str, str]]
    title_classes: frozenset[str]
    date_classes: frozenset[str]
    content_classes: frozenset[str]


JWC_CONFIG = WebplusSiteConfig(
    key="jwc",
    name=_NOTICE_SOURCES["jwc"]["name"],
    id_prefix="seu-jwc",
    categories=JWC_CATEGORIES,
    title_classes=frozenset({"Article_Title"}),
    date_classes=frozenset({"Article_PublishDate"}),
    content_classes=frozenset({"wp_articlecontent", "Article_Content"}),
)

CSE_CONFIG = WebplusSiteConfig(
    key="cse",
    name=_NOTICE_SOURCES["cse"]["name"],
    id_prefix="seu-cse",
    categories=CSE_CATEGORIES,
    title_classes=frozenset({"arti_title", "Article_Title"}),
    date_classes=frozenset({"arti_update", "Article_PublishDate"}),
    content_classes=frozenset({"wp_articlecontent", "Article_Content"}),
)


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
        self.content_seen = False
        self.embedded_files: list[dict[str, str]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        classes = set((values.get("class") or "").split())
        if tag not in _VOID_TAGS:
            self._capture_stack.append(classes)
        if classes & self.config.content_classes:
            self.content_seen = True
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
                title_match = re.search(
                    r"['\"]title['\"]\s*:\s*['\"]([^'\"]+)", metadata
                )
                self.embedded_files.append(
                    {
                        "url": self._unwrap_file_url(urljoin(self.base_url, source)),
                        "name": _clean(title_match.group(1)) if title_match else "",
                    }
                )

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
            self.anchors.append(
                {
                    "href": self._anchor["href"],
                    "text": _clean("".join(self._anchor["parts"])),
                    "inContent": str(self._anchor["inContent"]),
                }
            )
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

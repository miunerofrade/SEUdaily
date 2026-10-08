"""The school notice registry shared with Node through notice_categories.json."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class WebplusSiteConfig:
    key: str
    name: str
    id_prefix: str
    categories: dict[str, tuple[str, str]]
    title_classes: frozenset[str]
    date_classes: frozenset[str]
    content_classes: frozenset[str]
    host: str = ""
    search_type: str = ""
    attachment_label: str = ""


def _load_notice_sources(path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or not data:
        raise ValueError("通知来源配置不能为空")
    result = {}
    prefixes, hosts = set(), set()
    for site, source in data.items():
        if (
            not re.fullmatch(r"[a-z][a-z0-9_]*", site)
            or not isinstance(source, dict)
            or not isinstance(source.get("name"), str)
            or not source["name"].strip()
            or not isinstance(source.get("host"), str)
            or not re.fullmatch(
                r"[a-z0-9]+(?:[.-][a-z0-9]+)*\.seu\.edu\.cn", source["host"]
            )
        ):
            raise ValueError(f"无效通知机构配置：{site}")
        if source["host"] in hosts:
            raise ValueError("通知来源域名重复")
        hosts.add(source["host"])
        if "categories" not in source:
            if "adapter" in source:
                raise ValueError("通知 adapter 必须配置栏目")
            continue  # Display-only institutions, e.g. the news site.
        if source.get("adapter", "webplus") != "webplus":
            raise ValueError(f"不支持的通知 adapter：{site}")
        categories = source["categories"]
        if not isinstance(categories, dict) or not categories:
            raise ValueError("通知栏目配置不能为空")
        prefix = source.get("idPrefix", f"seu-{site}")
        if not isinstance(prefix, str) or not re.fullmatch(r"[a-z][a-z0-9-]*", prefix):
            raise ValueError("通知 ID 前缀无效")
        if any(
            prefix == old
            or prefix.startswith(old + "-")
            or old.startswith(prefix + "-")
            for old in prefixes
        ):
            raise ValueError("通知 ID 前缀冲突")
        prefixes.add(prefix)
        selectors = source.get("selectors", {})
        if not isinstance(selectors, dict) or set(selectors) - {
            "title",
            "date",
            "content",
        }:
            raise ValueError("通知选择器配置无效")
        defaults = {
            "title": ["Article_Title"],
            "date": ["Article_PublishDate"],
            "content": ["wp_articlecontent", "Article_Content"],
        }
        for key, default in defaults.items():
            values = selectors.get(key, default)
            if (
                not isinstance(values, list)
                or not values
                or any(
                    not isinstance(v, str)
                    or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_-]*", v)
                    for v in values
                )
            ):
                raise ValueError("通知选择器配置无效")
            defaults[key] = values
        label = source.get("attachmentLabel", source["name"])
        if not isinstance(label, str) or not label.strip():
            raise ValueError("通知附件标签无效")
        search_type = source.get("searchType", "")
        if search_type not in {"", "1"}:
            raise ValueError("通知搜索类型无效")
        normalized = {
            **source,
            "adapter": "webplus",
            "idPrefix": prefix,
            "selectors": defaults,
            "searchType": search_type,
            "categories": {},
        }
        for key, entry in categories.items():
            if (
                not re.fullmatch(r"[a-z][a-z0-9_]*", key)
                or not isinstance(entry, list)
                or len(entry) != 2
                or not all(isinstance(v, str) for v in entry)
                or not entry[0].strip()
                or not re.fullmatch(r"/[A-Za-z0-9_]+/list\.htm", entry[1])
            ):
                raise ValueError(f"无效通知栏目配置：{site}/{key}")
            normalized["categories"][key] = tuple(entry)
        display = source.get("displayCategories")
        if display is not None and (
            not isinstance(display, list)
            or not display
            or any(
                not isinstance(key, str) or key not in normalized["categories"]
                for key in display
            )
        ):
            raise ValueError("通知展示栏目无效")
        paths = [entry[1] for entry in normalized["categories"].values()]
        if len(paths) != len(set(paths)):
            raise ValueError(f"通知栏目路径重复：{site}")
        result[site] = normalized
    return result


def _load_notice_categories(path: Path) -> dict:
    return {
        key: source["categories"] for key, source in _load_notice_sources(path).items()
    }


_NOTICE_SOURCES = _load_notice_sources(
    Path(__file__).with_name("notice_categories.json")
)
_NOTICE_CATEGORIES = {
    key: source["categories"] for key, source in _NOTICE_SOURCES.items()
}


def source_config(key: str, sources: dict | None = None) -> WebplusSiteConfig:
    registry = _NOTICE_SOURCES if sources is None else sources
    if key not in registry:
        raise ValueError(f"未知通知来源：{key}")
    source = registry[key]
    return WebplusSiteConfig(
        key=key,
        name=source["name"],
        host=source["host"],
        id_prefix=source["idPrefix"],
        categories=source["categories"],
        title_classes=frozenset(source["selectors"]["title"]),
        date_classes=frozenset(source["selectors"]["date"]),
        content_classes=frozenset(source["selectors"]["content"]),
        search_type=source["searchType"],
        attachment_label=source.get("attachmentLabel", source["name"]),
    )


JWC_CONFIG = source_config("jwc")
CSE_CONFIG = source_config("cse")
JWC_CATEGORIES = JWC_CONFIG.categories
CSE_CATEGORIES = CSE_CONFIG.categories

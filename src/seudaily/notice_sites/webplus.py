"""Default site policy: configured HTML boundaries and standard WebPlus search."""
from __future__ import annotations

import hashlib
import json
from urllib.parse import urljoin

from ..notice_html import PARSER_VERSION, parse_list, validate_page
from ..notice_readers import read_page, reader_settings
from ..notice_sources import WebplusSiteConfig


class SearchEntryMissing(ValueError):
    pass


class WebplusSite:
    list_revision = 1
    detail_revision = 1

    def __init__(self, config: WebplusSiteConfig, *, base_url: str = ""):
        self.config = config
        self.base_url = base_url or f'https://{config.host}'

    def cache_version(self, part: str, url: str = "", *, category: str | None = None) -> str:
        """A site/config change invalidates only that site's relevant validators."""
        if part == 'list':
            revision = self.list_revision
            rules = [self.config.list_classes, self.config.list_item_classes,
                     self.config.list_title_classes, self.config.list_date_classes,
                     self.config.single_page_categories]
            if category in self.config.single_page_categories:
                rules.append(self.config.content_classes)
        elif part == 'detail':
            revision = self.detail_revision
            config, content_ids, title_ids = reader_settings(url, self.config, origin=self.base_url) if url else (self.config, frozenset(), frozenset())
            rules = [config.title_classes, config.date_classes, config.content_classes, content_ids, title_ids]
        else:
            raise ValueError(f'未知通知解析阶段：{part}')
        encoded = json.dumps([sorted(rule) for rule in rules], ensure_ascii=False)
        digest = hashlib.sha256(encoded.encode()).hexdigest()[:16]
        return f'{self.config.key}:{part}:{PARSER_VERSION}:{revision}:{digest}'

    def parse_list(self, html: str, url: str, category: str):
        try:
            return parse_list(html, url, self.config,
                              single_page=category in self.config.single_page_categories)
        except (ValueError, PermissionError) as error:
            raise type(error)(f'{self.config.key}/{category} 列表解析失败：{error}') from error

    def parse_detail(self, html: str, url: str):
        try:
            return read_page(html, url, self.config, origin=self.base_url)
        except (ValueError, PermissionError) as error:
            raise type(error)(f'{self.config.key} 正文解析失败：{error}') from error

    def discover_search(self, html: str, url: str, category: str | None) -> tuple[str, bool]:
        """Return the entry URL and whether its form requires a keyword POST."""
        nodes = list(validate_page(html, recognized_classes=self.config.list_classes | self.config.content_classes).root.walk())
        form = next((n for n in nodes if n.tag == 'form'
                     and '/search/new.rst?' in n.attrs.get('action', '')), None)
        if form:
            return urljoin(url, form.attrs['action'].strip()), True
        hidden = next((n.attrs.get('value') for n in nodes if n.attrs.get('id') == 'securl'), None)
        if hidden:
            return urljoin(url, hidden.strip()), False
        raise SearchEntryMissing(f'站点没有可识别的站内搜索入口：{url}')

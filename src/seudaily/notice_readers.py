"""Select article rules by destination host, independently of the listing source."""
from dataclasses import replace
from urllib.parse import urlsplit

from .notice_sources import DEFAULT_WEBPLUS_CONFIG, WebplusSiteConfig, _NOTICE_SOURCES, source_config
from .webplus_page import _PageParser


def reader_settings(url: str, source: WebplusSiteConfig, *, origin: str = ""):
    host = urlsplit(url).hostname
    if host == 'mp.weixin.qq.com':
        config = replace(source, key='wechat', title_classes=frozenset(),
                         content_classes=frozenset(), date_classes=frozenset())
        return config, frozenset({'js_content'}), frozenset({'activity-name'})
    if host == source.host or (origin and host == urlsplit(origin).hostname):
        return source, frozenset(), frozenset()
    for key, entry in _NOTICE_SOURCES.items():
        if host == entry['host']:
            return source_config(key), frozenset(), frozenset()
    # External WebPlus articles use the platform's default body selectors.
    config = replace(DEFAULT_WEBPLUS_CONFIG, host=host or '')
    return config, frozenset(), frozenset()


def read_page(html: str, url: str, source: WebplusSiteConfig, *, origin: str = "") -> _PageParser:
    config, content_ids, title_ids = reader_settings(url, source, origin=origin)
    parser = _PageParser(url, config, content_ids=content_ids, title_ids=title_ids)
    parser.feed(html)
    return parser

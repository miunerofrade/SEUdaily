"""School WebPlus configuration and HTML parsing, separate from synchronization."""

from __future__ import annotations
import re
import hashlib
from html.parser import HTMLParser
from urllib.parse import urljoin, urlparse, parse_qs

_ARTICLE_PATH = re.compile(r"/(\d{4})/(\d{2})(\d{2})/c\d+a(\d+)/page\.(?:htm|psp)$")
_SPACE = re.compile(r"\s+")

from .notice_html import _VOID_TAGS, editor_resource, link_url, validate_page


from .notice_sources import (
    _load_notice_sources,
    _load_notice_categories,
    _NOTICE_SOURCES,
    _NOTICE_CATEGORIES,
    JWC_CATEGORIES,
    CSE_CATEGORIES,
    WebplusSiteConfig,
    JWC_CONFIG,
    CSE_CONFIG,
)


def _clean(text: str) -> str:
    return _SPACE.sub(" ", text).strip()


def _article_id(url: str, prefix: str = "seu-jwc") -> str:
    match = _ARTICLE_PATH.search(urlparse(url).path)
    if match:
        return f"{prefix}-{match.group(4)}"
    return f"{prefix}-{hashlib.sha256(url.encode('utf-8')).hexdigest()[:20]}"


class _PageParser(HTMLParser):
    """Parse article boundaries and resources without relying on nesting depth."""

    def __init__(self, base_url: str, config: WebplusSiteConfig = JWC_CONFIG) -> None:
        super().__init__(convert_charrefs=True)
        self.base_url = base_url
        self.config = config
        self.anchors: list[dict[str, str]] = []
        self.embedded_files: list[dict[str, str]] = []
        self.content_seen = False
        self.title = ''
        self.published_at = ''
        self.content = ''

    @staticmethod
    def _unwrap_file_url(url: str) -> str:
        values = parse_qs(urlparse(url).query).get('file')
        return urljoin(url, values[0].strip()) if values else url

    def feed(self, html: str) -> None:
        doc = validate_page(html)
        nodes = list(doc.root.walk())
        wechat = urlparse(self.base_url).hostname == 'mp.weixin.qq.com'
        contents = [n for n in nodes if n.classes & self.config.content_classes
                    or (wechat and n.attrs.get('id') == 'js_content')]
        inside = {id(n) for root in contents for n in root.walk()}
        self.content_seen = bool(contents)
        self.title = next((
            _clean(n.text) for n in nodes if n.classes & self.config.title_classes
            or (wechat and n.attrs.get('id') == 'activity-name')
        ), '')
        date = next((_clean(n.text) for n in nodes if n.classes & self.config.date_classes), '')
        match = re.search(r'\d{4}-\d{2}-\d{2}', date)
        self.published_at = match[0] if match else ''
        self.content = _clean(contents[0].text) if contents else ''
        self.anchors = []
        self.embedded_files = []
        for node in nodes:
            if node.tag == 'a':
                href = link_url(self.base_url, node.attrs.get('href', ''))
                if href and not editor_resource(href, node.attrs):
                    self.anchors.append({
                        'href': href,
                        'text': _clean(node.attrs.get('title', '').strip() or node.text),
                        'inContent': str(id(node) in inside),
                    })
            embedded = id(node) in inside and node.tag in {'img', 'iframe', 'embed', 'object'}
            if not embedded and 'wp_pdf_player' not in node.classes:
                continue
            source = (node.attrs.get('pdfsrc') or node.attrs.get('data-src')
                      or node.attrs.get('src') or node.attrs.get('data'))
            if not source:
                continue
            url = link_url(self.base_url, source)
            if not url:
                continue
            url = self._unwrap_file_url(url)
            if editor_resource(url, node.attrs):
                continue
            metadata = node.attrs.get('sudyfile-attr', '')
            title = re.search(r"['\"]title['\"]\s*:\s*['\"]([^'\"]+)", metadata)
            self.embedded_files.append({
                'url': url,
                'name': _clean(title[1] if title else node.attrs.get('alt', '')
                               or node.attrs.get('title', '')),
            })

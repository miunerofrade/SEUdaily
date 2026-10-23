"""Teaching affairs overrides: search context in the template without a form."""
from __future__ import annotations

import base64
import re
from html import unescape
from urllib.parse import urlencode, urljoin

from .webplus import WebplusSite, SearchEntryMissing
from ..notice_html import validate_page


class JwcSite(WebplusSite):
    def discover_search(self, html: str, url: str, category: str | None) -> tuple[str, bool]:
        try:
            return super().discover_search(html, url, category)
        except SearchEntryMissing:
            # Only the absent-entry case may use the site's public context.
            # validate_page still rejects maintenance and access-gate pages.
            nodes = list(validate_page(html, recognized_classes=self.config.list_classes | self.config.content_classes).root.walk())
        site = next((n.attrs['sudy-wp-siteid'] for n in nodes if 'sudy-wp-siteid' in n.attrs), '')
        template = re.search(r'/template(\d+)/', html)
        column = re.search(r'[?&]columnId=(\d+)', unescape(html))
        if not site.isdigit() or not template or (category is not None and not column):
            raise ValueError(f'教务处页面缺少搜索上下文：{url}')
        context = f'as={site}&t={template[1]}&p=2&'
        if category is not None:
            context += f'f={column[1]}&m=SN&|bnnColumnVirtualName={column[1]}&'
        else:
            context += 'm=SN&'
        encoded = base64.b64encode(context.encode()).decode().replace('=', '_')
        entry = urljoin(url, '/_web/_search/api/search/new.rst') + '?' + urlencode({
            'locale': 'zh_CN', 'request_locale': 'zh_CN', 'context': '', '_p': encoded,
        })
        return entry, True

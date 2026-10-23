"""WebPlus HTML boundaries shared by notice list and detail adapters."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from html.parser import HTMLParser
from urllib.parse import urljoin, urlsplit

from .notice_sources import WebplusSiteConfig

PARSER_VERSION = 2

_VOID_TAGS = frozenset({
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
    'meta', 'param', 'source', 'track', 'wbr',
})
_BLOCK_TAGS = frozenset({'div', 'p', 'br', 'li', 'tr', 'td', 'section', 'article', 'h1', 'h2', 'h3'})
_DATE = re.compile(r'\b(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?')
_ERROR = re.compile(
    r'当前\s*ip并非校内|仅(?:允许|限).{0,15}(?:校内|校园网)|'
    r'(?:请|需要|必须).{0,30}(?:VPN|校园网).{0,20}访问|'
    r'访问地址无效|找不到对应的栏目|系统维护|网站维护|暂停访问|'
    r'访问受限|拒绝访问|无权访问|访问被拒绝|服务不可用|登录后.{0,10}访问|'
    r'当前环境异常|完成验证后.{0,10}访问', re.I,
)


@dataclass
class Node:
    tag: str
    attrs: dict[str, str] = field(default_factory=dict)
    children: list[Node | str] = field(default_factory=list)
    comments: list[str] = field(default_factory=list)

    def walk(self):
        yield self
        for child in self.children:
            if isinstance(child, Node):
                yield from child.walk()

    @property
    def classes(self) -> set[str]:
        return set(self.attrs.get('class', '').split())

    @property
    def text(self) -> str:
        if self.tag in {'script', 'style', 'noscript'}:
            return ''
        text = ''.join(
            child.text if isinstance(child, Node) else child
            for child in self.children
        )
        return text + '\n' if self.tag in _BLOCK_TAGS else text


class Document(HTMLParser):
    def __init__(self, html: str):
        super().__init__(convert_charrefs=True)
        self.root = Node('root')
        self.stack = [self.root]
        self.feed(html)
        self.close()

    def handle_starttag(self, tag, attrs):
        node = Node(tag, {key: value or '' for key, value in attrs})
        self.stack[-1].children.append(node)
        if tag not in _VOID_TAGS:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in _VOID_TAGS:
            self.stack.pop()

    def handle_endtag(self, tag):
        # Match the actual tag, rather than counting void tags as nesting levels.
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index].tag == tag:
                del self.stack[index:]
                break

    def handle_data(self, data):
        self.stack[-1].children.append(data)

    def handle_comment(self, data):
        self.stack[-1].comments.append(data)


def validate_page(html: str, *, recognized_classes=frozenset(), recognized_ids=frozenset(), check_text: bool = True) -> Document:
    doc = Document(html)
    nodes = list(doc.root.walk())
    errors = [node for node in nodes if 'wp_error_msg' in node.classes]
    title = next((node.text for node in nodes if node.tag == 'title'), '')
    text = ' '.join(node.text for node in errors) if errors else doc.root.text
    recognized = any(
        node.classes & (recognized_classes | {'wp_articlecontent', 'Article_Content'})
        or node.attrs.get('id') in recognized_ids
        for node in nodes
    )
    error_title = re.fullmatch(
        r'\s*(提示信息|系统提示|访问限制|访问受限|系统维护(?:中)?|网站维护(?:中)?|Access Denied|Service Unavailable)\s*',
        title, re.I,
    )
    if errors or error_title or (check_text and not recognized and _ERROR.search(text)):
        message = re.sub(r'\s+', ' ', text).strip()[:180]
        if re.search('校内|校园网|VPN|登录|无权|拒绝|受限|验证|环境异常', message, re.I):
            raise PermissionError('通知访问受限，需要校园网、校园 VPN 或网页验证：' + message)
        raise ValueError('通知站点返回提示或维护页：' + message)
    return doc


def link_url(base: str, href: str) -> str:
    # Strip before resolution: trailing spaces otherwise become literal URL bytes.
    url = urljoin(base, href.strip()) if href.strip() else ''
    parsed = urlsplit(url)
    if href.strip().startswith('#') or parsed.scheme not in {'http', 'https'}:
        return ''
    if parsed.port == (443 if parsed.scheme == 'https' else 80):
        url = parsed._replace(netloc=parsed.netloc.rsplit(':', 1)[0]).geturl()
    return url


def parse_list(html: str, base: str, config: WebplusSiteConfig, *, single_page: bool = False) -> list[dict[str, str]]:
    """Unknown layouts fail explicitly; only scoped notice links are returned."""
    doc = validate_page(html, recognized_classes=config.list_classes | config.content_classes)
    containers = [node for node in doc.root.walk() if node.classes & config.list_classes]
    if not containers:
        raise ValueError('通知列表结构未识别，学校页面可能已变更；不能当作空栏目')
    result = []
    seen = set()
    for container in containers:
        static = next((n for n in container.walk() if n.classes & config.content_classes), None)
        # Some registered columns (downloads/recruitment) are single article pages.
        if single_page and static is not None:
            if not static.text.strip() and not any(
                n.tag in {'img', 'iframe', 'embed', 'object', 'a'} or 'wp_pdf_player' in n.classes
                for n in static.walk()
            ):
                raise ValueError('栏目正文为空；保留已有缓存')
            if base not in seen:
                title = next((n.text.strip() for n in doc.root.walk() if n.tag == 'title'), '栏目正文')
                result.append({'url': base, 'title': title, 'publishedAt': ''})
                seen.add(base)
            continue
        rows = [n for n in container.walk() if n.classes & config.list_item_classes] if config.list_item_classes else [
            n for n in container.walk() if n.tag in {'li', 'tr'}
        ]
        for row in rows:
            title_nodes = [n for n in row.walk() if n.classes & config.list_title_classes]
            if config.list_item_classes and not title_nodes:
                raise ValueError('通知条目的标题结构未识别；保留已有缓存')
            anchors = [a for node in (title_nodes or [row]) for a in node.walk() if a.tag == 'a']
            dates = [n for n in row.walk() if n.classes & config.list_date_classes]
            date = _DATE.search(' '.join(n.text for n in dates) or row.text)
            row_items = 0
            for anchor in anchors:
                url = link_url(base, anchor.attrs.get('href', ''))
                title = re.sub(r'\s+', ' ', anchor.attrs.get('title', '').strip() or anchor.text).strip()
                if not url or not title:
                    continue
                if not title_nodes and not config.list_item_classes and not re.search(r'/c\d+a\d+/page\.', url):
                    continue
                item_date = date or re.search(r'/(\d{4})/(\d{2})(\d{2})/', url)
                if not item_date:
                    raise ValueError('通知列表条目缺少可识别日期：' + title)
                row_items += 1
                if url not in seen:
                    seen.add(url)
                    result.append({
                        'url': url, 'title': title,
                        'publishedAt': f'{int(item_date[1]):04}-{int(item_date[2]):02}-{int(item_date[3]):02}',
                    })
            if config.list_item_classes and not row_items:
                raise ValueError('通知列表条目缺少有效标题或链接；保留已有缓存')
        if config.list_item_classes and not rows and any(n.tag == 'a' for n in container.walk()):
            raise ValueError('通知列表容器存在但条目结构未识别')
    if single_page and not result:
        raise ValueError('单页栏目正文结构未识别；保留已有缓存')
    if not result:
        text = ' '.join(n.text for n in containers)
        empty_widget = any(
            n.attrs.get('portletmode') == 'simpleList' and not n.text.strip()
            and not any(c.tag == 'a' for c in n.walk())
            and any(re.fullmatch(r'\s*No Data\s*', comment, re.I)
                    for child in n.walk() for comment in child.comments)
            for root in containers for n in root.walk()
        )
        has_links = any(n.tag == 'a' for root in containers for n in root.walk())
        explicit = bool(re.search(r'暂无|没有.{0,8}(?:信息|记录|内容)|无相关|共\s*0\s*条', text))
        zero_total = bool(re.search(r'(?:total|allCount|totalCount)\s*[:=]\s*["\']?0\b', html, re.I))
        if has_links or not (empty_widget or explicit or zero_total):
            raise ValueError('通知列表未解析出条目，且没有可信空栏目标记；保留缓存')
    return result


def editor_resource(url: str, attrs: dict[str, str]) -> bool:
    path = urlsplit(url).path.lower()
    editor_path = re.search(r'/(?:_?ueditor|editor|ueditorplus)/(?:themes|dialogs|images?)/', path)
    artifact = re.search(r'/(?:spacer|localimage|icon_[a-z0-9]+)\.(?:gif|png)$', path)
    purpose = 'sudy-attachment-icon' in attrs.get('class', '').split()
    return bool(editor_path and (artifact or purpose)) or attrs.get('data-placeholder') == 'true'

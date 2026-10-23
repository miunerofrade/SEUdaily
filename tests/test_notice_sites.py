"""Behavioral contracts for site boundaries, configuration and cache isolation."""
from dataclasses import replace
import json
from pathlib import Path

import pytest

from seudaily.notice_adapters import create_notice_adapter
from seudaily.notice_sources import JWC_CONFIG, CSE_CONFIG, _load_notice_sources
from seudaily.notice_sites import create_site
from seudaily.notice_sites.jwc import JwcSite
from seudaily.notice_sites.webplus import WebplusSite
from seudaily.notice_service import JwcService, CseService

FIXTURES = Path(__file__).parent / 'fixtures' / 'notices'
JWC_URL = 'https://jwc.seu.edu.cn/jwxx/list.htm'
CSE_URL = 'https://cse.seu.edu.cn/49469/list.htm'


@pytest.fixture(autouse=True)
def isolate_originals(monkeypatch, tmp_path):
    monkeypatch.setattr('seudaily.saved_web_files.root', lambda: tmp_path / 'originals')


def test_real_site_fixtures_are_isolated_in_both_directions():
    jwc = create_site(JWC_CONFIG)
    cse = create_site(CSE_CONFIG)
    modern = (FIXTURES / 'jwc-academic.html').read_text()
    legacy = (FIXTURES / 'cse-undergraduate.html').read_text()
    assert isinstance(jwc, JwcSite) and type(cse) is WebplusSite
    assert len(jwc.parse_list(modern, JWC_URL, 'academic')) == 15
    assert len(cse.parse_list(legacy, CSE_URL, 'undergraduate_notices')) == 14
    with pytest.raises(ValueError, match='jwc/academic.*未识别'):
        jwc.parse_list(legacy, JWC_URL, 'academic')
    with pytest.raises(ValueError, match='cse/undergraduate_notices.*未识别'):
        cse.parse_list(modern, CSE_URL, 'undergraduate_notices')


def test_single_page_is_explicit_column_configuration():
    html = (FIXTURES / 'jwc-static.html').read_text()
    jwc = create_site(JWC_CONFIG)
    assert len(jwc.parse_list(html, 'https://jwc.seu.edu.cn/xzzq/list.htm', 'downloads')) == 1
    with pytest.raises(ValueError, match='列表'):
        jwc.parse_list(html, JWC_URL, 'academic')
    disabled = create_site(replace(JWC_CONFIG, single_page_categories=frozenset()))
    with pytest.raises(ValueError):
        disabled.parse_list(html, JWC_URL, 'downloads')


def test_new_layout_uses_source_config_without_a_new_python_site(tmp_path, monkeypatch):
    source = {'name': '测试学院', 'host': 'civil.seu.edu.cn',
              'categories': {'announcements': ['学院通知', '/notice/list.htm']},
              'selectors': {'list': ['bulletins'], 'listItem': ['bulletin'],
                            'listTitle': ['headline'], 'listDate': ['published'],
                            'title': ['heading'], 'date': ['when'], 'content': ['body_text']}}
    path = tmp_path / 'sources.json'
    path.write_text(json.dumps({'civil': source}))
    adapter = create_notice_adapter({'source': 'civil', 'cacheDir': str(tmp_path / 'civil'),
                                     'backgroundSync': False}, sources=_load_notice_sources(path))
    assert type(adapter.site) is WebplusSite
    url = 'https://civil.seu.edu.cn/2026/1024/c1a123/page.htm'
    def fetch(request, validators=None):
        html = (f'<div class="bulletins"><div class="bulletin"><span class="headline"><a href=" {url} ">系统维护通知</a></span>'
                '<span class="published">2026-10-24</span></div></div>' if request.endswith('/list.htm') else
                '<h1 class="heading">系统维护通知</h1><div class="body_text">因系统维护，今晚暂停访问。</div>')
        return {'url': request, 'html': html, 'notModified': False}
    monkeypatch.setattr(adapter, '_fetch', fetch)
    result = adapter.list_articles(categories=['announcements'])
    assert result['status'] == 'completed'
    assert result['results'][0]['id'] == 'seu-civil-123'
    assert result['results'][0]['publishedAt'] == '2026-10-24'
    detail = adapter.get_article('seu-civil-123')['article']
    assert detail['content'] == '因系统维护，今晚暂停访问。'
    assert detail['category'] == 'announcements'
    assert (tmp_path / 'civil/articles/seu-civil-123.json').exists()


def test_jwc_search_context_override_does_not_leak_to_other_sites():
    html = ('<script sudy-wp-siteId="63"></script><link href="/template3454/css/index.css">'
            '<img src="/_visitcount?columnId=21678">')
    entry, post = create_site(JWC_CONFIG).discover_search(html, JWC_URL, 'academic')
    assert '/search/new.rst?' in entry and post
    with pytest.raises(ValueError, match='搜索入口'):
        create_site(CSE_CONFIG).discover_search(html, CSE_URL, 'undergraduate_notices')
    for site, url in [(create_site(JWC_CONFIG), JWC_URL), (create_site(CSE_CONFIG), CSE_URL)]:
        with pytest.raises(ValueError, match='维护页'):
            site.discover_search('<title>系统维护</title>' + html, url, None)


def test_reposts_use_destination_body_rules_instead_of_listing_selectors():
    source = replace(JWC_CONFIG, content_classes=frozenset({'jwc_only'}))
    site = create_site(source)
    html = '<h1 class="arti_title">计软智通知</h1><div class="wp_articlecontent">学院正文</div>'
    page = site.parse_detail(html, 'https://cse.seu.edu.cn/2026/1024/c1a2/page.htm')
    assert page.title == '计软智通知' and page.content == '学院正文'
    wechat = site.parse_detail('<h1 id="activity-name">微信文章</h1><div id="js_content">微信正文</div>',
                              'https://mp.weixin.qq.com/s/example')
    assert wechat.title == '微信文章' and wechat.content == '微信正文'
    with pytest.raises(PermissionError, match='网页验证'):
        site.parse_detail('<html>当前环境异常，完成验证后即可继续访问。</html>',
                          'https://mp.weixin.qq.com/s/example')


def test_list_revision_only_invalidates_its_site_and_stage(tmp_path, monkeypatch):
    # Exercise actual conditional refresh, not just equality of computed strings.
    jwc = JwcService(cache_dir=str(tmp_path / 'jwc'), background_sync=False)
    cse = CseService(cache_dir=str(tmp_path / 'cse'), background_sync=False)
    calls = []
    def refresh(service, fixture, category):
        state = {'articles': [], 'categories': {}}
        def fetch(url, validators):
            calls.append((service.config.key, bool(validators)))
            return ({'url': url, 'notModified': True} if validators else
                    {'url': url, 'notModified': False, 'html': (FIXTURES / fixture).read_text(), 'etag': 'v1'})
        monkeypatch.setattr(service, '_fetch', fetch)
        service._refresh_index(state, [category], pages=1)
        return state
    a = refresh(jwc, 'jwc-academic.html', 'academic')
    b = refresh(cse, 'cse-undergraduate.html', 'undergraduate_notices')
    detail_version = jwc.site.cache_version('detail', JWC_URL)
    monkeypatch.setattr(JwcSite, 'list_revision', JwcSite.list_revision + 1)
    jwc._refresh_index(a, ['academic'], pages=1)
    cse._refresh_index(b, ['undergraduate_notices'], pages=1)
    assert calls == [('jwc', False), ('cse', False), ('jwc', False), ('cse', True)]
    assert jwc.site.cache_version('detail', JWC_URL) == detail_version
    assert len(a['articles']) == 15 and len(b['articles']) == 14


def test_selector_changes_invalidate_only_the_affected_stage():
    site = create_site(JWC_CONFIG)
    changed_list = create_site(replace(JWC_CONFIG, list_classes=frozenset({'new_list'})))
    assert changed_list.cache_version('list') != site.cache_version('list')
    assert changed_list.cache_version('detail') == site.cache_version('detail')
    changed_body = create_site(replace(JWC_CONFIG, content_classes=frozenset({'new_body'})))
    assert changed_body.cache_version('detail') != site.cache_version('detail')
    assert changed_body.cache_version('list') == site.cache_version('list')
    assert changed_body.cache_version('list', category='downloads') != site.cache_version('list', category='downloads')


@pytest.mark.parametrize('field,value', [
    ('singlePageCategories', ['unknown']), ('singlePageCategories', [{}]),
    ('selectors', {'list': []}), ('selectors', {'listItem': []}),
    ('selectors', {'listTitle': ['a[href]']}), ('selectors', {'listDate': 'date'}),
])
def test_new_source_options_are_validated(tmp_path, field, value):
    source = {'name': '测试学院', 'host': 'civil.seu.edu.cn',
              'categories': {'news': ['通知', '/news/list.htm']}, field: value}
    path = tmp_path / 'sources.json';path.write_text(json.dumps({'civil': source}))
    with pytest.raises(ValueError):
        _load_notice_sources(path)


def test_configured_third_site_over_real_http_preserves_body_and_conditional_cache(tmp_path):
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from threading import Thread

    requests = []
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            requests.append((self.path, self.headers.get('If-None-Match')))
            if self.headers.get('If-None-Match') == 'list-v1':
                self.send_response(304);self.end_headers();return
            if self.path == '/news/list.htm':
                body = ('<html><div class="bulletins"><div class="bulletin">'
                        '<span class="headline"><a href=" /2026/1024/c1a88/page.htm ">系统维护通知</a></span>'
                        '<span class="published">2026-10-24</span></div></div></html>')
            else:
                body = '<html><h1 class="heading">系统维护通知</h1><div class="body_text">今晚因系统维护暂停访问。</div></html>'
            self.send_response(200);self.send_header('Content-Type', 'text/html; charset=utf-8')
            if self.path.endswith('/list.htm'):self.send_header('ETag', 'list-v1')
            self.end_headers();self.wfile.write(body.encode())
        def log_message(self, *args):pass
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True);thread.start()
    try:
        path = tmp_path / 'sources.json'
        path.write_text(json.dumps({'civil': {
            'name': '测试学院', 'host': 'civil.seu.edu.cn',
            'categories': {'news': ['通知', '/news/list.htm']},
            'selectors': {'list': ['bulletins'], 'listItem': ['bulletin'],
                          'listTitle': ['headline'], 'listDate': ['published'],
                          'title': ['heading'], 'content': ['body_text']},
        }}))
        service = create_notice_adapter({'source': 'civil', 'baseUrl': f'http://127.0.0.1:{server.server_port}',
                                         'cacheDir': str(tmp_path / 'civil'), 'backgroundSync': False},
                                        sources=_load_notice_sources(path))
        first = service.list_articles(categories=['news'])
        assert first['status'] == 'completed' and first['networkChecked']
        article = service.get_article(first['results'][0]['id'])['article']
        assert article['title'] == '系统维护通知' and article['content'] == '今晚因系统维护暂停访问。'
        second = service.list_articles(categories=['news'])
        assert second['results'][0]['id'] == article['id'] == 'seu-civil-88'
        assert second['results'][0]['contentHash'] == article['contentHash']
        assert requests == [('/news/list.htm', None), ('/2026/1024/c1a88/page.htm', None), ('/news/list.htm', 'list-v1')]
    finally:
        server.shutdown();server.server_close();thread.join(timeout=2)


@pytest.mark.parametrize('url,expected', [
    ('https://jwc.seu.edu.cn:443/files/a.pdf', 'https://jwc.seu.edu.cn/files/a.pdf'),
    ('http://cse.seu.edu.cn:80/files/a.pdf', 'http://cse.seu.edu.cn/files/a.pdf'),
    ('https://cse.seu.edu.cn:8443/files/a.pdf', 'https://cse.seu.edu.cn:8443/files/a.pdf'),
    ('https://[::1]:443/a.pdf', 'https://[::1]/a.pdf'),
])
def test_resource_urls_normalize_only_the_default_port(url, expected):
    from seudaily.notice_html import link_url
    assert link_url(JWC_URL, url) == expected


def test_linked_and_embedded_pdf_use_the_same_canonical_resource_url():
    site = create_site(JWC_CONFIG)
    page = site.parse_detail('<div class="wp_articlecontent">'
                             '<a href="https://jwc.seu.edu.cn:443/files/a.pdf">附件</a>'
                             '<span class="wp_pdf_player" pdfsrc="https://jwc.seu.edu.cn:443/files/a.pdf"></span></div>', JWC_URL)
    assert page.anchors[0]['href'] == page.embedded_files[0]['url'] == 'https://jwc.seu.edu.cn/files/a.pdf'


def test_configured_title_boundary_does_not_fall_back_to_unrelated_row_links():
    html = ('<div class="news-list-wrap"><div class="news-list-item">'
            '<div class="new-title"><a href="/2026/1024/c1a8/page.htm">改版后的标题</a></div>'
            '<div class="news-item-date-ym">2026-10-24</div></div></div>')
    with pytest.raises(ValueError, match='标题结构未识别'):
        create_site(JWC_CONFIG).parse_list(html, JWC_URL, 'academic')
    fixed = create_site(replace(JWC_CONFIG, list_title_classes=frozenset({'new-title'})))
    assert fixed.parse_list(html, JWC_URL, 'academic')[0]['title'] == '改版后的标题'


def test_notice_worker_subprocess_uses_site_policy_and_drains_persisted_queue(tmp_path, monkeypatch):
    import os
    import subprocess
    import seudaily.notice_sync as sync
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from threading import Thread

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200);self.send_header('Content-Type', 'text/html; charset=utf-8');self.end_headers()
            self.wfile.write('<h1 class="Article_Title">后台通知</h1><div class="wp_articlecontent">后台正文</div>'.encode())
        def log_message(self, *args):pass
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True);thread.start()
    children = []
    original_popen = subprocess.Popen
    def spawn(command, **kwargs):
        child = original_popen(command, cwd=tmp_path,
                               env={**os.environ, 'SEUDAILY_PROJECT_ROOT': str(tmp_path)}, **kwargs)
        children.append(child)
        return child
    monkeypatch.setattr(sync.subprocess, 'Popen', spawn)
    try:
        service = create_notice_adapter({'source': 'jwc', 'baseUrl': f'http://127.0.0.1:{server.server_port}',
                                         'cacheDir': str(tmp_path / 'cache'), 'backgroundSync': False})
        service._enqueue_details([{'id': 'seu-jwc-88', 'title': '后台通知', 'category': 'academic',
                                   'url': f'http://127.0.0.1:{server.server_port}/2026/1024/c1a88/page.htm'}])
        service._start_worker()
        assert children[0].wait(timeout=10) == 0
        assert service._read_queue() == []
        detail = json.loads((tmp_path / 'cache/articles/seu-jwc-88.json').read_text())
        assert detail['content'] == '后台正文' and detail['category'] == 'academic'
        assert detail['validators']['parserVersion'] == service.site.cache_version('detail', detail['url'])
        assert list((tmp_path / '.seudaily/web-files').rglob('*.md'))
    finally:
        for child in children:
            if child.poll() is None:child.terminate();child.wait(timeout=5)
        server.shutdown();server.server_close();thread.join(timeout=2)


def test_unknown_webplus_repost_uses_platform_defaults_not_jwc_defaults():
    source = replace(JWC_CONFIG, title_classes=frozenset({'jwc_heading'}),
                     content_classes=frozenset({'jwc_body'}))
    site = create_site(source)
    page = site.parse_detail('<h1 class="Article_Title">新闻网通知</h1>'
                             '<div class="wp_articlecontent">独立的转载正文</div>',
                             'https://news.seu.edu.cn/2026/1024/c1a88/page.htm')
    assert page.title == '新闻网通知' and page.content == '独立的转载正文'

"""Live markup regressions plus adapter persistence and failure boundaries."""
from __future__ import annotations

import io
import json
from email.message import Message
from pathlib import Path

import pytest

import seudaily.notice_service as jwc
from seudaily.notice_service import CseService, JwcService, _article_id
from functools import partial
from seudaily.notice_sites import create_site
from seudaily.notice_sources import JWC_CONFIG, CSE_CONFIG
from seudaily.notice_readers import read_page

list_items = partial(create_site(JWC_CONFIG).parse_list, category='academic')
from seudaily.webplus_page import _PageParser

FIXTURES = Path(__file__).parent / 'fixtures' / 'notices'
BASE = 'https://jwc.seu.edu.cn'
OLD_URL = BASE + '/2026/1014/c21678a586035/page.htm'
NEW_URL = BASE + '/_t3454/2026/1014/c21678a586035/page.htm'


@pytest.fixture(autouse=True)
def isolate_originals(monkeypatch, tmp_path):
    monkeypatch.setattr('seudaily.saved_web_files.root', lambda: tmp_path / 'originals')


def fixture(name):
    return (FIXTURES / name).read_text()


def response(html, url=BASE + '/jwxx/list.htm', **extra):
    return {'notModified': False, 'url': url, 'html': html, **extra}


def row(url=NEW_URL, title='通知', date='2026-10-15'):
    return (f'<div class="news-list-wrap"><div class="news-list-item">'
            f'<div class="news-item-title"><a href="{url}">{title}</a></div>'
            f'<div class="news-item-date-ym">{date}</div></div></div>')


def test_live_jwc_div_list_uses_display_date_and_ignores_navigation():
    html = '<nav><a href="/2026/1014/c1a999/page.htm">导航</a></nav>' + fixture('jwc-academic.html')
    items = list_items(html, BASE)
    assert len(items) == 15
    assert items[0] == {
        'title': '关于2026-2027学年秋季学期期中考试安排的通知',
        'url': NEW_URL, 'publishedAt': '2026-10-15',
    }
    assert _article_id(items[0]['url']) == 'seu-jwc-586035'
    assert all(item['title'] != '导航' for item in items)


def test_live_cse_list_and_true_empty_column():
    items = create_site(CSE_CONFIG).parse_list(fixture('cse-undergraduate.html'), 'https://cse.seu.edu.cn', 'undergraduate_notices')
    assert len(items) == 14
    assert items[0]['title'] == '关于公示计算机科学与工程学院、软件学院、人工智能学院课程选用教材审核结果的通知'
    assert items[0]['publishedAt'] == '2026-09-24'
    assert items[0]['url'] == 'https://cse.seu.edu.cn/2026/0924/c49469a584397/page.htm'
    assert create_site(CSE_CONFIG).parse_list(fixture('cse-empty.html'), 'https://cse.seu.edu.cn', 'employment') == []


@pytest.mark.parametrize('url', [
    ' /2026/1014/c21678a586035/page.htm  ',
    ' https://news.seu.edu.cn/2026/0923/c55947a584220/page.htm ',
    ' https://mp.weixin.qq.com/s/public-article ',
    ' https://cse.seu.edu.cn/_upload/article/files/form.doc ',
])
def test_title_text_fallback_and_trimmed_mixed_links(url):
    item = list_items(row(url), BASE)[0]
    assert item['title'] == '通知'
    assert item['url'] == (BASE + url.strip() if url.strip().startswith('/') else url.strip())
    assert '%20' not in item['url']


@pytest.mark.parametrize('html', [
    '<table><tr><td><a href="/2026/1014/c1a1/page.htm">导航而非列表</a></td></tr></table>',
    '<div class="news-list-wrap"></div>',
    '<div class="col_news_list"><div portletmode="simpleList"></div></div>',
    '<div class="news-list-wrap"><a href="/changed">新版未知结构</a></div>',
    row('javascript:void(0)'),
    row() + row('', title='损坏条目'),
    '<div class="col_news_list"><div portletmode="simpleList"></div><a href="/new">未知结构</a></div>',
])
def test_unknown_or_partially_broken_layout_never_becomes_empty(html):
    with pytest.raises(ValueError):
        list_items(html, BASE)


@pytest.mark.parametrize('html,error', [
    ('<html><title>系统维护</title><body>网站维护，稍后重试</body></html>', ValueError),
    ('<html><div class="wp_error_msg">当前 IP并非校内地址，仅限校园网访问</div></html>', PermissionError),
    ('<div class="wp_error_msg">访问地址无效，找不到对应的栏目</div>', ValueError),
    ('<html><h2>环境异常</h2><p>当前环境异常，完成验证后即可继续访问。</p></html>', PermissionError),
])
def test_200_error_pages_preserve_body_and_archives(tmp_path, html, error):
    service = JwcService(cache_dir=str(tmp_path / 'cache'), background_sync=False)
    article = {'id': 'seu-jwc-1', 'url': OLD_URL, 'title': '缓存标题', 'content': '缓存正文', 'contentHash': 'old'}
    original = dict(article)
    with pytest.raises(error):
        service._apply_article_response(article, response(html, OLD_URL))
    assert article == original
    assert not (tmp_path / 'originals').exists()


def test_live_pdf_body_includes_embedded_and_linked_files():
    parser = _PageParser(BASE)
    parser.feed(fixture('jwc-pdf-body.html'))
    assert parser.content_seen
    assert len(parser.embedded_files) == 1
    assert parser.embedded_files[0]['name'] == '第6周课外研学讲座预告-修改.pdf'
    assert parser.embedded_files[0]['url'].endswith('01960382-8453-4cca-8fac-d41b1bf4ca81.pdf')
    assert len([a for a in parser.anchors if a['inContent'] == 'True']) == 1
    assert all('icon_pdf' not in f['url'] for f in parser.embedded_files)


def test_live_cse_editor_xls_icon_is_not_an_attachment():
    parser = _PageParser('https://cse.seu.edu.cn')
    parser.feed(fixture('cse-attachment-body.html'))
    assert parser.content_seen and '各位老师' in parser.content
    assert parser.embedded_files == []
    assert [a['href'].rsplit('.', 1)[-1] for a in parser.anchors] == ['xlsx']


def test_image_only_pdf_only_and_real_icon_filename_are_kept(tmp_path):
    service = JwcService(cache_dir=str(tmp_path / 'cache'), background_sync=False)
    article = {'id': 'seu-jwc-1', 'url': OLD_URL, 'title': '图片通知'}
    html = '''<div class="wp_articlecontent"><img src="/_upload/images/icon_pdf.gif">
      <img src="/_ueditor/dialogs/image/images/localimage.png">
      <span class="wp_pdf_player" pdfsrc=" /files/a.pdf "></span>
      <iframe src="/viewer.html?file=%2Ffiles%2Fb.pdf"></iframe></div>
      <img src="/footer-logo.png">'''
    assert service._apply_article_response(article, response(html, OLD_URL))
    assert article['content'] == ''
    assert [a['url'] for a in article['attachments']] == [
        BASE + '/_upload/images/icon_pdf.gif', BASE + '/files/a.pdf', BASE + '/files/b.pdf',
    ]
    saved = list((tmp_path / 'originals').rglob('*.md'))
    assert len(saved) == 1
    assert 'icon_pdf.gif' in saved[0].read_text()


def test_empty_body_rejected_but_normal_maintenance_notice_allowed(tmp_path):
    service = JwcService(cache_dir=str(tmp_path), background_sync=False)
    article = {'id': 'seu-jwc-1', 'url': OLD_URL}
    with pytest.raises(ValueError, match='为空'):
        service._apply_article_response(article, response('<div class="wp_articlecontent"><br/></div>'))
    assert service._apply_article_response(article, response(
        '<h1 class="Article_Title">教务系统维护安排通知</h1>'
        '<div class="wp_articlecontent">因系统维护，周末暂停访问，周一恢复服务。</div>', OLD_URL))


def test_static_column_is_one_article_not_an_empty_list():
    items = create_site(JWC_CONFIG).parse_list(fixture('jwc-static.html'), BASE + '/xzzq/list.htm', 'downloads')
    assert len(items) == 1 and items[0]['url'] == BASE + '/xzzq/list.htm'
    assert items[0]['publishedAt'] == ''


def test_refresh_isolates_columns_retains_bad_page_validator_and_reports_all_failed(tmp_path, monkeypatch):
    service = JwcService(cache_dir=str(tmp_path), background_sync=False)
    state = {'version': 1, 'categories': {'news': {'validators': {'page1': {'etag': 'good-old'}}}}, 'articles': []}
    service._save_index(state)
    monkeypatch.setattr(service, '_fetch', lambda url, validators=None: response(
        row() if '/jwxx/' in url else '<html>unrecognized layout</html>', url, etag='bad-new'))
    result = service.list_articles(categories=['news', 'academic'])
    assert result['status'] == 'completed' and result['networkChecked']
    assert not result['freshnessGuaranteed'] and len(result['warnings']) == 1
    assert result['results'][0]['id'] == 'seu-jwc-586035'
    assert service._load_index()['categories']['news']['validators']['page1']['etag'] == 'good-old'
    result = service.list_articles(categories=['news'])
    assert result['status'] == 'failed' and not result['networkChecked']
    assert '所有通知栏目刷新失败' in result['warnings'][0]


def test_template_prefix_does_not_duplicate_existing_cache_or_archive(tmp_path, monkeypatch):
    service = JwcService(cache_dir=str(tmp_path / 'cache'), background_sync=False)
    ident = _article_id(OLD_URL)
    old = {'id': ident, 'url': OLD_URL, 'title': '旧标题', 'category': 'academic',
           'firstSeenAt': '2026-10-15T00:00:00Z', 'contentHash': 'old-hash'}
    service._save_index({'version': 1, 'categories': {}, 'articles': [old]})
    service.articles_dir.mkdir()
    (service.articles_dir / f'{ident}.json').write_text(json.dumps({'content': '旧正文', 'contentHash': 'old-hash'}))
    version = service.versions_dir / ident / 'old-hash.json'
    version.parent.mkdir(parents=True)
    version.write_text('old archive')
    monkeypatch.setattr(service, '_fetch', lambda url, validators=None: response(row(), url))
    result = service.list_articles(categories=['academic'])
    article = result['results'][0]
    assert len(result['results']) == len(service._load_index()['articles']) == 1
    assert article['id'] == ident and article['url'] == OLD_URL
    assert article['firstSeenAt'] == old['firstSeenAt']
    assert article['content'] == '旧正文' and article['contentHash'] == 'old-hash'
    assert version.read_text() == 'old archive'
    assert _article_id(NEW_URL) == _article_id(OLD_URL)


def test_unchanged_seen_notice_is_not_pushed_again_with_template_prefix(tmp_path, monkeypatch):
    import seudaily.focus as focus
    monkeypatch.setenv('DEEPSEEK_API_KEY', 'test-only-key')
    service = JwcService(cache_dir=str(tmp_path / 'cache'), background_sync=False)
    ident = _article_id(NEW_URL)
    article = {**list_items(row(), BASE)[0], 'id': ident, 'categoryLabel': '教务信息'}
    monkeypatch.setattr(service, '_search_remote', lambda *a: [article])
    monkeypatch.setattr(focus, 'create_notice_adapter', lambda *a: service)
    monkeypatch.setattr(focus.FocusSemanticModel, 'judge', lambda *a: pytest.fail('已审阅通知不应重新判断'))
    state = {'id': 'test', 'title': '关注', 'kind': 'notice', 'source': 'jwc',
             'description': '考试', 'generatedQueries': ['考试'], 'categories': ['academic'],
             'seenArticleIds': [ident], 'reviewedArticleIds': [ident]}
    assert focus.FocusService(state_file=tmp_path / 'focus.json')._check_notice(state) == []
    assert state['seenArticleIds'] == state['reviewedArticleIds'] == [ident]


def test_one_detail_failure_does_not_block_other_notices(tmp_path, monkeypatch):
    service = JwcService(cache_dir=str(tmp_path), background_sync=False)
    good_url = BASE + '/2026/1014/c1a2/page.htm'
    service._enqueue_details([{'id': 'seu-jwc-1', 'url': OLD_URL, 'title': '受限通知', 'category': 'academic'},
                              {'id': 'seu-jwc-2', 'url': good_url, 'title': '正常通知', 'category': 'academic'}])
    monkeypatch.setattr(service, '_fetch', lambda url, validators=None: response(
        '<div class="wp_error_msg">仅限校园网访问</div>' if url == OLD_URL
        else '<div class="wp_articlecontent">正常通知正文</div>', url))
    result = service.sync_pending(max_workers=2)
    assert result['status'] == 'partial' and result['completed'] == result['failed'] == 1
    assert (service.articles_dir / 'seu-jwc-2.json').exists()
    assert not (service.articles_dir / 'seu-jwc-1.json').exists()
    assert service._read_queue() == []


def test_search_isolates_columns_and_deduplicates_stable_ids(tmp_path, monkeypatch):
    service = JwcService(cache_dir=str(tmp_path), background_sync=False)
    service._save_index({'version': 1, 'categories': {}, 'articles': [{
        'id': _article_id(OLD_URL), 'url': OLD_URL, 'firstSeenAt': 'old', 'category': 'academic',
    }]})
    def search(query, category):
        if category == 'news':
            raise TimeoutError('timeout')
        return [{'id': _article_id(NEW_URL), 'url': OLD_URL, 'title': '考试'}]
    monkeypatch.setattr(service, '_search_remote', search)
    result = service.search('考试', categories=['news', 'academic'])
    assert len(result['warnings']) == 1 and not result['freshnessGuaranteed']
    assert len(service._load_index()['articles']) == 1
    assert result['results'][0]['firstSeenAt'] == 'old'
    with pytest.raises(RuntimeError, match='所有通知栏目搜索失败'):
        service.search('考试', categories=['news'])


@pytest.mark.parametrize('payload,extension,accepted', [
    (b'\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1' + b'binary', '.doc', True),
    (b'%PDF-1.7', '.pdf', True),
    (b'PK\x03\x04file', '.xlsx', True),
    (b'<html>access restricted</html>', '.pdf', False),
])
def test_direct_file_listing_is_validated_before_becoming_attachment(monkeypatch, payload, extension, accepted):
    class FileResponse(io.BytesIO):
        headers = Message()
        def geturl(self):
            return 'https://cse.seu.edu.cn/_upload/forms/file' + extension
        def __enter__(self): return self
        def __exit__(self, *a): self.close()
    monkeypatch.setattr(jwc, 'public_opener', lambda: type('Opener', (), {
        'open': lambda *a, **kw: FileResponse(payload),
    })())
    service = CseService(background_sync=False)
    if not accepted:
        with pytest.raises(ValueError, match='扩展名不匹配'):
            service._fetch('https://cse.seu.edu.cn/_upload/forms/file' + extension)
        return
    fetched = service._fetch('https://cse.seu.edu.cn/_upload/forms/file' + extension)
    assert fetched['html'] == '' and fetched['attachment']['url'].endswith(extension)
    article = {'id': 'seu-cse-doc', 'url': fetched['url'], 'title': '下载表格'}
    service._apply_article_response(article, fetched)
    assert article['attachments'] == [{'url': fetched['url'], 'name': '下载表格' + extension}]
    assert article['content'] == ''


def test_parser_upgrade_revalidates_old_empty_cache_once(tmp_path, monkeypatch):
    service = JwcService(cache_dir=str(tmp_path), background_sync=False)
    state = {'version': 1, 'categories': {'academic': {
        'validators': {'page1': {'etag': 'old-empty-page'}}}}, 'articles': []}
    requests = []
    def fetch(url, validators=None):
        requests.append(validators)
        return response(row(), url, etag='fresh') if not validators else {'notModified': True, 'url': url}
    monkeypatch.setattr(service, '_fetch', fetch)
    service._refresh_index(state, ['academic'], pages=1)
    service._refresh_index(state, ['academic'], pages=1)
    assert requests[0] == {}
    assert requests[1]['etag'] == 'fresh' and requests[1]['parserVersion'] == service.site.cache_version('list')
    assert len(state['articles']) == 1


def test_upgrade_refetches_old_body_instead_of_trusting_old_validator(tmp_path, monkeypatch):
    service = JwcService(cache_dir=str(tmp_path / 'cache'), background_sync=False)
    article = {'id': 'seu-jwc-1', 'url': OLD_URL, 'title': '通知', 'category': 'academic',
               'contentHash': 'old-hash', 'validators': {'etag': 'old-body'}}
    requests = []
    def fetch(url, validators=None):
        requests.append(validators)
        return response('<div class="wp_articlecontent">已重新验证的正文</div>', url, etag='new-body')
    monkeypatch.setattr(service, '_fetch', fetch)
    service._refresh_article(article)
    assert requests == [{}]
    assert article['content'] == '已重新验证的正文'
    assert article['validators']['parserVersion'] == service.site.cache_version('detail', article['url'])


def test_nested_inline_title_and_body_scope_after_void_tags():
    parser = _PageParser(BASE)
    parser.feed('<h1 class="Article_Title">图<span>书</span>馆</h1>'
                '<div class="wp_articlecontent"><p>第一段<br/>换行</p><p>第二段</p></div>'
                '<footer><a href="/not-attachment.pdf">页脚附件</a></footer>')
    assert parser.title == '图书馆'
    assert parser.content == '第一段 换行 第二段'
    assert parser.anchors[0]['inContent'] == 'False'


def test_wechat_public_body_uses_its_own_container_and_lazy_images():
    parser = read_page('<h1 id="activity-name">微信通知</h1><div id="js_content">'
                '<p>公众号正文</p><img data-src="https://mmbiz.qpic.cn/example.jpg"></div>'
                '<div>推荐阅读</div>', 'https://mp.weixin.qq.com/s/example', JWC_CONFIG)
    assert parser.title == '微信通知' and parser.content == '公众号正文'
    assert parser.embedded_files == [{'url': 'https://mmbiz.qpic.cn/example.jpg', 'name': ''}]


@pytest.mark.parametrize('category', ['academic', None])
def test_new_template_search_discovers_public_context_without_a_form(monkeypatch, category):
    import base64
    from urllib.parse import parse_qs, urlsplit
    service = JwcService(background_sync=False)
    requests = []
    class Reply(io.BytesIO):
        headers = Message()
        def __enter__(self): return self
        def __exit__(self, *a): self.close()
    def open_request(self, request, **kw):
        requests.append(request)
        if len(requests) == 1:
            return Reply(b'<script sudy-wp-siteId="63"></script>'
                         b'<link href="/_upload/tpl/0d/7e/3454/template3454/css/index.css">'
                         b'<img src="/_visitcount?siteId=63&amp;columnId=21678">')
        if len(requests) == 2:
            parsed = urlsplit(request.full_url)
            assert parsed.path == '/_web/_search/api/search/new.rst'
            encoded = parse_qs(parsed.query)['_p'][0].replace('_', '=')
            context = base64.b64decode(encoded).decode()
            assert 'as=63&t=3454&' in context
            assert ('f=21678&' in context) == (category is not None)
            assert request.get_method() == 'POST'
            return Reply(b"<script>url:'../searchCon/create.rst?_p=context'</script>")
        assert '/searchCon/create.rst?' in request.full_url
        return Reply(json.dumps({'data': '<div class="result_item clearfix">'
            '<input name="id" value="586035"><h3 class="item_title">'
            '<a href=" /_t3454/2026/1014/c21678a586035/page.htm ">考试</a></h3>'
            '<div>发布时间：2026-10-15</div></div>'}, ensure_ascii=False).encode())
    monkeypatch.setattr(jwc, 'public_opener', lambda *a: type('Opener', (), {'open': open_request})())
    result = service._search_remote('考试', category)
    assert result[0]['id'] == 'seu-jwc-586035' and result[0]['url'] == OLD_URL
    assert len(requests) == 3


def test_unknown_search_results_do_not_look_like_zero_matches():
    service = JwcService(background_sync=False)
    with pytest.raises(ValueError, match='结构未识别'):
        service._parse_search_results('<html>站点改版后的未知结果结构</html>')
    assert service._parse_search_results('') == []

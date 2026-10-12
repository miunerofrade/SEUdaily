import json
import zipfile
from pathlib import Path

import httpx
import pytest

from seudaily.anyshare import AnyShareClient, AnyShareError, validate_docid
from seudaily.anyshare_backup import operate, selected_files, snapshot
from seudaily import cli


def mocked_client(tmp_path, handler):
    client = AnyShareClient(tmp_path)
    client.session.client.close()
    client.session.client = httpx.Client(transport=httpx.MockTransport(handler))
    client.session.client.cookies.set("client.oauth2_token", "old", domain="pan.seu.edu.cn", path="/")
    return client


def test_cas_oauth_login_supplies_redirect_and_challenge(tmp_path, monkeypatch):
    client = AnyShareClient(tmp_path)
    client.session.client.close()
    calls = []
    def handler(request):
        calls.append(request)
        if request.url.path == "/anyshare/oauth2/login":
            assert request.url.params['redirect'] == '/anyshare/zh-cn/homepage'
            props = {"challenge":"challenge", "authconfig":{"thirdauth":{"config":{"authServer":"https://auth.seu.edu.cn/login?service=pan"}}}}
            return httpx.Response(200, text='<script id="__NEXT_DATA__" type="application/json">'+json.dumps({"props":{"pageProps":props}})+'</script>')
        assert request.url.path == '/oauth2/signin'
        return httpx.Response(200, headers={'set-cookie':'client.oauth2_token=fresh; Path=/; Secure'})
    client.session.client = httpx.Client(transport=httpx.MockTransport(handler))
    def authenticate(entry):
        assert client.session.client.cookies.get('login_challenge') == 'challenge'
        callback='https://pan.seu.edu.cn/oauth2/signin?ticket=one-use-ticket'
        assert entry.startswith('https://auth.seu.edu.cn/')
        client.session.get(callback)
    monkeypatch.setattr(client.session, 'ensure_authenticated', authenticate)
    with client:
        client.login()
        assert client.token() == 'fresh'
    cookie_file=tmp_path/'.seudaily/anyshare/cookies.json'
    assert cookie_file.stat().st_mode & 0o777 == 0o600
    assert 'one-use-ticket' not in cookie_file.read_text()


def test_expired_token_refreshes_once_and_retries(tmp_path):
    requests = []
    def handler(request):
        requests.append(request)
        if request.url.path.endswith('/refreshToken'):
            return httpx.Response(200, headers={'set-cookie':'client.oauth2_token=fresh; Path=/; Secure'})
        if request.headers['authorization'] == 'Bearer old':
            return httpx.Response(401)
        return httpx.Response(200, json=[{'id':'gns://root','type':'user_doc_lib'}])
    with mocked_client(tmp_path, handler) as client:
        assert len(client.roots()) == 1
    assert len(requests) == 3
    assert 'authorization' not in requests[1].headers


def test_provider_error_is_sanitized_and_does_not_relogin(tmp_path):
    calls=[]
    def handler(request):
        calls.append(request)
        return httpx.Response(403, text='token=private-secret')
    with mocked_client(tmp_path, handler) as client:
        with pytest.raises(AnyShareError, match='HTTP 403') as error:
            client.roots()
    assert 'private-secret' not in str(error.value)
    assert len(calls)==1


def test_archive_preserves_selected_paths_and_excludes_state(tmp_path):
    (tmp_path/'exports').mkdir()
    (tmp_path/'exports/a.md').write_text('资料')
    (tmp_path/'exports/.secret.md').write_text('private')
    (tmp_path/'exports/config.json').write_text('private')
    (tmp_path/'.env').write_text('password=private')
    scratch=tmp_path/'scratch';scratch.mkdir()
    archive,names=snapshot(tmp_path,['exports','exports/a.md'],scratch)
    assert names==['exports/a.md']
    with zipfile.ZipFile(archive) as output:
        assert output.read(names[0]).decode()=='资料'
    for path in ['.env','exports/../.env','../outside.md']:
        with pytest.raises(ValueError):selected_files(tmp_path,[path])


def test_symlinks_and_size_limit_rejected_before_upload(tmp_path, monkeypatch):
    (tmp_path/'exports').mkdir()
    (tmp_path/'outside.md').write_text('private')
    (tmp_path/'exports/link.md').symlink_to(tmp_path/'outside.md')
    with pytest.raises(ValueError):selected_files(tmp_path,['exports'])
    (tmp_path/'exports/link.md').unlink()
    (tmp_path/'exports/a.md').write_text('large')
    monkeypatch.setattr('seudaily.anyshare_backup.MAX_BYTES', 2)
    with pytest.raises(ValueError,match='100 MB'): selected_files(tmp_path,['exports'])


def test_feature_gate_and_dispatch_without_network(tmp_path, monkeypatch):
    monkeypatch.delenv('SEUDAILY_EXPERIMENTAL_ANYSHARE',raising=False)
    monkeypatch.delenv('CVSTREAM_EXPERIMENTAL_ANYSHARE',raising=False)
    with pytest.raises(ValueError,match='启用'):operate({'mode':'browse'})
    monkeypatch.setenv('SEUDAILY_EXPERIMENTAL_ANYSHARE','true')
    monkeypatch.setenv('SEUDAILY_PROJECT_ROOT',str(tmp_path))
    (tmp_path/'exports').mkdir();(tmp_path/'exports/a.md').write_text('backup')
    result=cli.dispatch({'action':'anyshare-backup','payload':{'mode':'plan','paths':['exports']}})
    assert result['count']==1
    assert not (tmp_path/'.seudaily').exists()


def test_signed_requests_and_docids_validate():
    assert validate_docid('gns://root/file')=='gns://root/file'
    for value in ['https://example.com','gns://root/../file','gns://root?token=x']:
        with pytest.raises(ValueError):validate_docid(value)
    url,headers=AnyShareClient.signed_request(['PUT','https://store.seu.edu.cn/file','Date: a:b','Authorization: signed'], 'PUT')
    assert headers['Date']=='a:b'
    assert headers['Authorization']=='signed'
    for request in [['GET','https://store.seu.edu.cn/file'],['PUT','http://example.com/file'],['PUT','https://a:b@example.com/file']]:
        with pytest.raises(AnyShareError):AnyShareClient.signed_request(request,'PUT')


def test_upload_finalizes_only_after_transfer_and_download_cleans_partial(tmp_path, monkeypatch):
    source=tmp_path/'source.zip';source.write_bytes(b'zip-bytes')
    client=AnyShareClient(tmp_path)
    calls=[]
    def api(endpoint,payload):
        calls.append((endpoint,payload))
        if endpoint=='file/osbeginupload':
            assert payload['ondup']==1
            return {'docid':'gns://root/file','rev':'revision','authrequest':['PUT','https://store.seu.edu.cn/file','Authorization: signed-upload']}
        if endpoint=='file/osendupload':return {'name':'backup.zip'}
        if endpoint=='file/osdownload':return {'authrequest':['GET','https://store.seu.edu.cn/file','Authorization: signed-download']}
        pytest.fail(endpoint)
    monkeypatch.setattr(client,'api',api)
    original=httpx.Client
    def transfer(request):
        assert 'cookie' not in request.headers
        assert request.headers['authorization'].startswith('signed-')
        if request.method=='PUT':assert request.read()==source.read_bytes()
        return httpx.Response(200,content=source.read_bytes())
    monkeypatch.setattr('seudaily.anyshare.httpx.Client',lambda **kwargs:original(transport=httpx.MockTransport(transfer)))
    with client:
        uploaded=client.upload('gns://root',source,'backup.zip')
        assert uploaded['size']==9
        assert [c[0] for c in calls]==['file/osbeginupload','file/osendupload']
        destination=tmp_path/'downloads/a.zip'
        client.download(uploaded['docid'],destination)
        assert destination.read_bytes()==source.read_bytes()
        assert sorted(p.name for p in destination.parent.iterdir())==['a.zip']
        with pytest.raises(ValueError):client.download(uploaded['docid'],destination)


def test_failed_download_leaves_no_temporary_file(tmp_path,monkeypatch):
    client=AnyShareClient(tmp_path)
    monkeypatch.setattr(client,'api',lambda *a:{'authrequest':['GET','https://store.seu.edu.cn/file']})
    original=httpx.Client
    monkeypatch.setattr('seudaily.anyshare.httpx.Client',lambda **kwargs:original(transport=httpx.MockTransport(lambda r:httpx.Response(500))))
    destination=tmp_path/'downloads/a.zip'
    with client,pytest.raises(AnyShareError):client.download('gns://root/file',destination)
    assert list(destination.parent.iterdir())==[]


def test_backup_snapshot_scratch_is_removed_and_download_stays_outside_library(tmp_path,monkeypatch):
    monkeypatch.setenv('SEUDAILY_EXPERIMENTAL_ANYSHARE','true')
    monkeypatch.setenv('SEUDAILY_PROJECT_ROOT',str(tmp_path))
    (tmp_path/'exports').mkdir();(tmp_path/'exports/a.md').write_text('reference')
    scratch=[]
    class FakeClient:
        def __init__(self,root):pass
        def __enter__(self):return self
        def __exit__(self,*args):pass
        def backup_directory(self,parent,**kwargs):return 'gns://root/backups'
        def upload(self,parent,path,name):
            scratch.append(path.parent)
            with zipfile.ZipFile(path) as z:assert z.namelist()==['exports/a.md']
            return {'docid':'gns://root/backups/file','name':name}
    monkeypatch.setattr('seudaily.anyshare_backup.AnyShareClient',FakeClient)
    result=operate({'mode':'backup','paths':['exports'],'parentDocid':'gns://root'})
    assert result['count']==1
    assert all(not p.exists() for p in scratch)
    assert not (tmp_path/'.seudaily/knowledge').exists()

from __future__ import annotations

import errno
import socket
from urllib.error import HTTPError, URLError

import pytest

from seudaily import cli
from seudaily.campus_network import CODE, MESSAGE, network_category, sanitize_campus_result
from seudaily.protocol import normalize_tool_result


@pytest.mark.parametrize("error", [
    socket.gaierror(-2, "Name or service not known"),
    ConnectionRefusedError(errno.ECONNREFUSED, "Connection refused"),
    OSError(errno.ENETUNREACH, "Network is unreachable"),
    URLError(socket.timeout("timed out")),
    RuntimeError('Page.goto: net::ERR_NAME_NOT_RESOLVED at https://ehall.seu.edu.cn/'),
    RuntimeError('Page.goto: Timeout 30000ms exceeded. navigating to "https://cvs.seu.edu.cn/"'),
    RuntimeError('Page.goto: Could not connect to the server at https://ehall.seu.edu.cn/'),
    RuntimeError('Page.goto: A server with the specified hostname could not be found at https://ehall.seu.edu.cn/'),
    RuntimeError('Page.goto: NS_ERROR_UNKNOWN_HOST at https://ehall.seu.edu.cn/'),
    RuntimeError('Page.goto: NS_ERROR_NET_TIMEOUT at https://cvs.seu.edu.cn/'),
])
def test_dispatch_normalizes_campus_transport_failures(monkeypatch, tmp_path, error):
    monkeypatch.setenv("SEUDAILY_PROJECT_ROOT", str(tmp_path))
    def fail(request):
        raise error
    monkeypatch.setattr(cli, "_dispatch", fail)
    raw = cli.dispatch({"action": "get-schedule", "payload": {}})
    result = normalize_tool_result("get-schedule", raw)
    assert result["status"] == "failed"
    assert result["summary"] == MESSAGE
    assert result["data"]["errorCode"] == CODE
    assert "ehall.seu.edu.cn" not in str(result["data"])


@pytest.mark.parametrize("action,payload,error", [
    ("get-schedule", {}, RuntimeError('Locator.wait_for: Timeout 15000ms exceeded')),
    ("authorize-schedule", {}, RuntimeError('BrowserType.launch: executable missing')),
    ("get-schedule", {}, ValueError('semester 参数错误')),
    ("authorize", {}, ValueError('未配置 SEUDAILY_USERNAME/SEUDAILY_PASSWORD')),
    ("transcribe-cloud", {}, ConnectionRefusedError(errno.ECONNREFUSED, 'Connection refused')),
    ("summarize-course", {}, socket.timeout('timed out')),
    ("read-web-page", {"url": "https://example.com"}, socket.gaierror(-2, 'Name or service not known')),
    ("get-schedule", {"targetUrl": "https://example.com"}, socket.timeout('timed out')),
    ("capture-course-session", {}, RuntimeError('Connection refused https://api.deepseek.com/v1')),
    ("get-schedule", {}, HTTPError('https://ehall.seu.edu.cn', 403, 'Forbidden', {}, None)),
])
def test_unrelated_failures_keep_original_semantics(monkeypatch, action, payload, error):
    def fail(request):
        raise error
    monkeypatch.setattr(cli, "_dispatch", fail)
    with pytest.raises(type(error)):
        cli.dispatch({"action": action, "payload": payload})


def test_auth_required_is_preserved_for_resume(monkeypatch):
    auth = {"status": "auth_required", "message": "请重新授权", "resume": {"action": "get-schedule"}}
    monkeypatch.setattr(cli, "_dispatch", lambda _: auth)
    assert cli.dispatch({"action": "get-schedule"}) is auth


def test_already_caught_network_errors_hide_urls_and_credentials():
    result = {"status": "failed", "error": "Page.goto: net::ERR_CONNECTION_REFUSED at https://user:fixture@cvs.seu.edu.cn/?token=fixture"}
    cleaned = sanitize_campus_result("list-courses", {}, result)
    assert cleaned["message"] == MESSAGE
    assert "fixture" not in str(cleaned)
    assert "https://" not in str(cleaned)


def test_campus_web_url_is_classified_and_false_suffix_is_not():
    error = socket.gaierror(-2, 'Name or service not known')
    assert network_category('read-web-page', {'url': 'https://jwc.seu.edu.cn/a'}, error) == 'dns'
    assert network_category('read-web-page', {'url': 'https://seu.edu.cn.example.com'}, error) is None


def test_notice_cache_survives_public_network_failure_and_campus_batch_is_classified():
    result = {'status': 'completed', 'warnings': ['远端刷新失败，返回本地结果: <urlopen error timed out>']}
    assert sanitize_campus_result('list-jwc', {}, result) == result
    batch = {'status': 'partial', 'results': [{'status': 'failed', 'error': 'Page.goto: net::ERR_ADDRESS_UNREACHABLE at https://cvs.seu.edu.cn/'}]}
    assert sanitize_campus_result('capture-course-sessions', {}, batch)['message'] == MESSAGE


def test_cli_and_worker_emit_structured_network_failure_without_traceback(monkeypatch, tmp_path, capsys):
    import io
    import json
    import sys
    from seudaily import worker

    # Worker enables shared-browser mode; register its prior value for teardown.
    monkeypatch.setenv('SEUDAILY_PROJECT_ROOT', str(tmp_path))
    def fail(request):
        raise RuntimeError('Page.goto: net::ERR_CONNECTION_REFUSED at https://fixture:fixture@ehall.seu.edu.cn/?token=fixture')
    monkeypatch.setattr(cli, '_dispatch', fail)
    monkeypatch.setattr(sys, 'argv', ['seudaily-tool'])
    monkeypatch.setattr(sys, 'stdin', io.StringIO(json.dumps({'action': 'get-schedule', 'payload': {}})))
    cli.main()
    cli_output = capsys.readouterr()
    cli_result = json.loads(cli_output.out)
    assert cli_result['ok'] is True
    assert cli_result['data']['status'] == 'failed'
    assert cli_result['data']['summary'] == MESSAGE
    assert cli_output.err == ''
    assert 'fixture' not in cli_output.out

    request = {'requestId': 'campus-test', 'taskId': 'campus-task', 'action': 'get-schedule', 'payload': {}}
    monkeypatch.setattr(sys, 'stdin', io.StringIO(json.dumps(request) + '\n'))
    worker.main()
    worker_output = capsys.readouterr()
    response = json.loads(worker_output.out)
    assert response['type'] == 'result'
    assert response['result']['status'] == 'failed'
    assert response['result']['summary'] == MESSAGE
    assert response['result']['data']['errorCode'] == CODE
    assert worker_output.err == ''
    assert 'fixture' not in worker_output.out


@pytest.mark.parametrize("action", ["list-jwc", "search-jwc", "get-jwc-article", "list-cse", "search-cse", "get-cse-article"])
def test_public_notice_failures_do_not_require_campus_network(action):
    error = RuntimeError("远端刷新失败 https://jwc.seu.edu.cn/: <urlopen error timed out>")
    assert network_category(action, {}, error) is None

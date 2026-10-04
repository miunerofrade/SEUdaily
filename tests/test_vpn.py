from __future__ import annotations

import json
import os
import subprocess
import sys
from unittest.mock import MagicMock

import pytest

from seudaily import vpn, web_reader
from seudaily.asr import cloud


def test_proxy_lifetime_tracks_owner_process(tmp_path, monkeypatch):
    monkeypatch.setenv('SEUDAILY_PROJECT_ROOT', str(tmp_path))
    directory = vpn.vpn_directory()
    directory.mkdir(parents=True)
    child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
    try:
        state = {'state': 'connected', 'ownerPid': child.pid, 'httpProxy': 'http://127.0.0.1:11081'}
        (directory / 'status.json').write_text(json.dumps(state))
        assert vpn.campus_proxy() == state['httpProxy']
        child.terminate(); child.wait(timeout=5)
        assert vpn.campus_proxy() is None
    finally:
        if child.poll() is None:
            child.kill(); child.wait()


def test_callback_is_bound_to_seu_vpn():
    callback = 'https://vpn.seu.edu.cn/passport/v1/auth/cas?sfDomain=CAS-auth&ticket=ST-test'
    assert vpn.validate_callback(callback) == callback
    assert vpn.validate_callback(callback.replace("vpn.seu.edu.cn", "vpn.seu.edu.cn:443")) == callback
    with pytest.raises(ValueError):
        vpn.validate_callback(callback.replace('vpn.seu.edu.cn', 'example.org'))
    with pytest.raises(ValueError):
        vpn.validate_callback(callback.replace('CAS-auth', 'local'))


def test_vpn_http_captcha_uses_existing_browser_flow(monkeypatch):
    from seudaily.campus_auth import CampusAuthError, CampusSession
    manager = vpn.VpnManager()
    monkeypatch.setattr(manager, '_publish', lambda *_args: None)
    def captcha(*_args):
        raise CampusAuthError('captcha_required', '验证码')
    monkeypatch.setattr(CampusSession, 'capture_auth_redirect', captcha)
    browser = MagicMock(return_value='manual-callback')
    monkeypatch.setattr(manager, '_login_cas_browser', browser)
    assert manager._login_cas('/login') == 'manual-callback'
    browser.assert_called_once_with('/login')


def test_manager_disconnect_owns_core_and_revokes_proxy(tmp_path, monkeypatch):
    monkeypatch.setenv('SEUDAILY_PROJECT_ROOT', str(tmp_path))
    manager = vpn.VpnManager()
    manager.port = 11081
    manager.process = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
    try:
        manager._publish('connected', 'connected')
        assert vpn.campus_proxy()
        assert manager.disconnect()['state'] == 'disconnected'
        assert manager.process.poll() is not None
        assert vpn.campus_proxy() is None
        if os.name != 'nt':
            assert (vpn.vpn_directory() / 'status.json').stat().st_mode & 0o777 == 0o600
    finally:
        manager.disconnect()


def test_campus_dns_uses_vpn_but_private_urls_remain_blocked(monkeypatch):
    monkeypatch.setattr(web_reader, 'campus_proxy', lambda: 'http://127.0.0.1:11081')
    monkeypatch.setattr(web_reader.socket, 'getaddrinfo', lambda *_args, **_kwargs: [(2, 1, 6, '', ('127.0.0.1', 443))])
    assert web_reader.validate_public_url('https://cvs.seu.edu.cn/') == 'https://cvs.seu.edu.cn/'
    with pytest.raises(ValueError):
        web_reader.validate_public_url('https://example.org/')


def test_media_input_proxy_does_not_launch_a_real_download(tmp_path, monkeypatch):
    monkeypatch.setattr(cloud, 'campus_proxy', lambda: 'http://127.0.0.1:11081')
    process = MagicMock(returncode=0)
    popen = MagicMock(return_value=process)
    monkeypatch.setattr(cloud.subprocess, 'Popen', popen)
    worker = cloud.MediaWorker({}, tmp_path)
    try:
        with pytest.raises(RuntimeError, match='未生成有效媒体文件'):
            worker.extract_media('https://media.seu.edu.cn/video.mp4', 'https://cvs.seu.edu.cn/', audio_only=True)
        command = popen.call_args.args[0]
        assert command[command.index('-http_proxy') + 1] == 'http://127.0.0.1:11081'
        assert command.index('-http_proxy') < command.index('-i')
    finally:
        worker._cleanup()


def test_cas_redirect_ticket_is_captured_before_consumption():
    context = MagicMock()
    first = MagicMock(status=302, headers={'location': 'https://auth.seu.edu.cn/finish'})
    second = MagicMock(status=302, headers={'location': 'https://vpn.seu.edu.cn/passport/v1/auth/cas?sfDomain=CAS-auth&ticket=ST-test'})
    context.request.get.side_effect = [first, second]
    callback = vpn.capture_cas_redirect(context, 'https://auth.seu.edu.cn/start')
    assert callback.startswith('https://vpn.seu.edu.cn/')
    assert [call.args[0] for call in context.request.get.call_args_list] == [
        'https://auth.seu.edu.cn/start', 'https://auth.seu.edu.cn/finish']
    first.dispose.assert_called_once()
    second.dispose.assert_called_once()


def test_explicit_campus_proxy_overrides_system_bypass(monkeypatch):
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer
    from urllib.request import Request
    requests = []
    class Handler(BaseHTTPRequestHandler):
        def do_HEAD(self):
            requests.append(self.path)
            self.send_response(200); self.end_headers()
        def log_message(self, *_args):
            pass
    server = HTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setattr(vpn, 'campus_proxy', lambda: f'http://127.0.0.1:{server.server_port}')
    monkeypatch.setattr('urllib.request.proxy_bypass', lambda _host: True)
    try:
        url = 'http://unresolvable-campus.invalid/check'
        with vpn.campus_opener().open(Request(url, method='HEAD'), timeout=2) as response:
            assert response.status == 200
        assert requests == [url]
    finally:
        server.shutdown(); server.server_close(); thread.join(timeout=2)


def test_custom_proxy_port_is_saved_for_next_connection(tmp_path, monkeypatch):
    monkeypatch.setenv('SEUDAILY_PROJECT_ROOT', str(tmp_path))
    manager = vpn.VpnManager()
    monkeypatch.setattr(manager, '_run', lambda: manager.stop_event.wait(5))
    try:
        manager.connect(12081)
        assert manager.status()['configuredPort'] == 12081
    finally:
        manager.disconnect()
    assert vpn.VpnManager().status()['configuredPort'] == 12081

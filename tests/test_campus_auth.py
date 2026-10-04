import base64
from urllib.parse import quote

import httpx
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.asymmetric.padding import PKCS1v15
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from seudaily.campus_auth import CampusAuthError, CampusSession

ENTRY = "https://ehall.seu.edu.cn/appShow?appId=4770397878132218"
API = "https://ehall.seu.edu.cn/jwapp/sys/wdkb/modules/xskcb/xskcb.do"


class FakeCampus:
    """Independent CAS provider: password login, app SSO and expired app cookies."""
    def __init__(self, *, captcha=False):
        self.key = rsa.generate_private_key(public_exponent=65537, key_size=1024)
        self.password_logins = 0
        self.sso_logins = 0
        self.app_valid = False
        self.captcha = captcha

    def __call__(self, request):
        path = request.url.path
        sso = "SSO=valid" in request.headers.get("cookie", "")
        if path == "/appShow":
            if self.app_valid:
                return httpx.Response(200)
            service = "https://ehall.seu.edu.cn/app-callback" if sso else "http://ehall.seu.edu.cn/login"
            return httpx.Response(302, headers={"location": "https://auth.seu.edu.cn/dist/#/dist/main/login?service=" + quote(service, safe="")})
        if path == "/dist/":
            return httpx.Response(200)
        if path.endswith("/verifyTgt"):
            if sso:
                self.sso_logins += 1
                return httpx.Response(200, json={"success": True, "code": 201, "redirectUrl": "https://ehall.seu.edu.cn/app-callback?ticket=dummy"})
            return httpx.Response(200, json={"success": False, "code": 400})
        if path.endswith("/needCaptcha"):
            return httpx.Response(200, json={"code": 4000 if self.captcha else 200})
        if path.endswith("/getChiperKey"):
            public = self.key.public_key().public_bytes(Encoding.DER, PublicFormat.SubjectPublicKeyInfo)
            return httpx.Response(200, json={"success": True, "publicKey": base64.urlsafe_b64encode(public).decode()})
        if path.endswith("/casLogin"):
            import json
            payload = json.loads(request.content)
            assert payload["username"] == "test-user"
            assert self.key.decrypt(base64.b64decode(payload["password"]), PKCS1v15()) == b"test-password"
            self.password_logins += 1
            return httpx.Response(200, headers={"set-cookie": "SSO=valid; Path=/; Secure"},
                                  json={"success": True, "code": 200,
                                        "redirectUrl": quote("http://ehall.seu.edu.cn/login?ticket=dummy", safe="")})
        if path.endswith("/loginRedirect"):
            # eHall completed; the application now requires its own service ticket.
            return httpx.Response(302, headers={"location": "https://auth.seu.edu.cn/dist/#/dist/main/login?service=https%3A%2F%2Fehall.seu.edu.cn%2Fapp-callback"})
        if path == "/app-callback":
            self.app_valid = True
            return httpx.Response(200)
        if str(request.url) == API:
            if not self.app_valid:
                return httpx.Response(401)
            return httpx.Response(200, json={"datas": {"xskcb": {"rows": []}}})
        raise AssertionError(f"Unexpected route: {path}")


def session_for(tmp_path, provider, monkeypatch):
    monkeypatch.setattr("seudaily.campus_auth.campus_proxy", lambda: None)
    session = CampusSession(tmp_path / "cookies.json", username="test-user", password="test-password")
    session.client.close()
    session.client = httpx.Client(transport=httpx.MockTransport(provider))
    session._load_cookies()
    return session


def test_fresh_login_and_app_sso_use_one_encrypted_password_submission(tmp_path, monkeypatch):
    provider = FakeCampus()
    with session_for(tmp_path, provider, monkeypatch) as session:
        session.ensure_authenticated(ENTRY)
        assert session.post(API, form={}).json()["datas"]["xskcb"]["rows"] == []
        assert provider.password_logins == 1
        assert provider.sso_logins == 1
        assert session.cookie_file.exists()


def test_expired_business_session_is_renewed_and_query_retried(tmp_path, monkeypatch):
    provider = FakeCampus()
    with session_for(tmp_path, provider, monkeypatch) as session:
        session.ensure_authenticated(ENTRY)
        provider.app_valid = False
        assert session.post(API, form={}).ok
        assert provider.password_logins == 1
        assert provider.sso_logins == 2


def test_captcha_stops_before_submitting_password(tmp_path, monkeypatch):
    provider = FakeCampus(captcha=True)
    with session_for(tmp_path, provider, monkeypatch) as session:
        with pytest.raises(CampusAuthError) as raised:
            session.ensure_authenticated(ENTRY)
        assert raised.value.status == "captcha_required"
        assert raised.value.result()["status"] == "auth_required"
        assert provider.password_logins == 0
        assert not session.cookie_file.exists()


@pytest.mark.parametrize("existing_sso", [False, True])
def test_vpn_http_login_leaves_callback_ticket_unconsumed(tmp_path, monkeypatch, existing_sso):
    callback = "https://vpn.seu.edu.cn/passport/v1/auth/cas?sfDomain=CAS-auth&ticket=ST-test"
    provider = FakeCampus()
    requests = []

    def handle(request):
        requests.append(str(request.url))
        assert request.url.path != "/passport/v1/auth/cas", "Ticket must be consumed only by the VPN core"
        if request.url.path == "/vpn-entry":
            return httpx.Response(302, headers={"location": "https://auth.seu.edu.cn/dist/#/dist/main/login?service=" + quote(callback.split("?")[0], safe="")})
        if request.url.path.endswith("/loginRedirect"):
            return httpx.Response(302, headers={"location": callback})
        if existing_sso and request.url.path.endswith("/verifyTgt"):
            return httpx.Response(200, json={"success": True, "redirectUrl": callback})
        return provider(request)

    with session_for(tmp_path, handle, monkeypatch) as session:
        result = session.capture_auth_redirect("https://vpn.seu.edu.cn/vpn-entry",
                                              lambda url: url.startswith(callback.split("?")[0]))
        assert result == callback
        assert provider.password_logins == (0 if existing_sso else 1)
        assert callback not in requests
        assert not session.cookie_file.exists()

class SMSCampus(FakeCampus):
    def __init__(self):
        super().__init__()
        self.sends = 0
        self.codes = []

    def __call__(self, request):
        import json
        if request.url.path.endswith('/sendStage2Code'):
            assert json.loads(request.content) == {'userId': 'test-user'}
            self.sends += 1
            return httpx.Response(200, json={'code': 200})
        if request.url.path.endswith('/casLogin'):
            payload = json.loads(request.content)
            encrypted = payload['mobileVerifyCode']
            code = self.key.decrypt(base64.b64decode(encrypted), PKCS1v15()).decode() if encrypted else ''
            self.codes.append(code)
            if code != '123456':
                return httpx.Response(200, json={'code': 502})
        return super().__call__(request)


def test_sms_keeps_cas_session_and_retries_without_browser(tmp_path, monkeypatch):
    from seudaily.campus_auth import CampusSMSRequired, sms_challenge_action
    provider = SMSCampus()
    session = session_for(tmp_path, provider, monkeypatch)
    with session:
        with pytest.raises(CampusSMSRequired) as caught:
            session.ensure_authenticated(ENTRY)
    challenge = caught.value.challenge
    try:
        assert not session.client.is_closed
        assert caught.value.result()['authenticationReason'] == 'sms_required'
        sms_challenge_action(challenge.id, 'send')
        sms_challenge_action(challenge.id, 'send')
        assert provider.sends == 1
        with pytest.raises(CampusAuthError, match='未通过'):
            sms_challenge_action(challenge.id, 'verify', '999999')
        assert not challenge.done.is_set()
        assert sms_challenge_action(challenge.id, 'verify', '123456')['status'] == 'completed'
        assert session.client.is_closed
        assert provider.codes == ['', '999999', '123456']
        with session_for(tmp_path, provider, monkeypatch) as resumed:
            resumed.ensure_authenticated(ENTRY)
        assert provider.password_logins == 1
        with pytest.raises(CampusAuthError, match='已失效'):
            sms_challenge_action(challenge.id, 'verify', '123456')
    finally:
        challenge.close()


def test_sms_expiry_does_not_submit_code(tmp_path, monkeypatch):
    import time
    from seudaily.campus_auth import CampusSMSRequired
    provider = SMSCampus()
    with session_for(tmp_path, provider, monkeypatch) as session:
        with pytest.raises(CampusSMSRequired) as caught:
            session.ensure_authenticated(ENTRY)
    challenge = caught.value.challenge
    try:
        challenge.expires = time.monotonic() - 1
        with pytest.raises(CampusAuthError, match='已失效'):
            challenge.verify('123456')
        assert provider.codes == ['']
    finally:
        challenge.close()


def test_vpn_sms_does_not_consume_callback_ticket(tmp_path, monkeypatch):
    from seudaily.campus_auth import CampusSMSRequired
    callback = 'https://vpn.seu.edu.cn/passport/v1/auth/cas?sfDomain=CAS-auth&ticket=ST-sms'
    provider = SMSCampus()
    def handle(request):
        assert request.url.path != '/passport/v1/auth/cas'
        if request.url.path == '/vpn-entry':
            return httpx.Response(302, headers={'location': 'https://auth.seu.edu.cn/dist/?service=' + quote(callback.split('?')[0], safe='')})
        if request.url.path.endswith('/loginRedirect'):
            return httpx.Response(302, headers={'location': callback})
        return provider(request)
    with session_for(tmp_path, handle, monkeypatch) as session:
        with pytest.raises(CampusSMSRequired) as caught:
            session.capture_auth_redirect('https://vpn.seu.edu.cn/vpn-entry', lambda url: url.startswith(callback.split('?')[0]))
    challenge = caught.value.challenge
    try:
        challenge.send()
        challenge.verify('123456')
        assert challenge.callback == callback
        assert not session.cookie_file.exists()
    finally:
        challenge.close()


@pytest.mark.parametrize('target', ['course', 'schedule'])
def test_explicit_authorization_reports_sms_without_opening_browser(tmp_path, monkeypatch, target):
    provider = SMSCampus()
    session = session_for(tmp_path, provider, monkeypatch)
    def no_browser(*args, **kwargs):
        pytest.fail('SMS authorization must not launch a browser')
    if target == 'course':
        from seudaily.service import CourseService
        from seudaily.course_http import CourseHTTPClient
        service = CourseService(cookie_file=tmp_path / 'cookies.json')
        client = CourseHTTPClient(tmp_path / 'unused.json')
        client.session.client.close()
        client.session = session
        monkeypatch.setattr(service, '_http', lambda: client)
        # Reuse this fixture's eHall service to isolate the CAS protocol.
        monkeypatch.setattr('seudaily.course_http.ENTRY_URL', ENTRY)
    else:
        from seudaily.schedule import ScheduleService
        service = ScheduleService(cookie_file=tmp_path / 'cookies.json')
        monkeypatch.setattr('seudaily.schedule.CampusSession', lambda *args, **kwargs: session)
    monkeypatch.setattr(service, '_page', no_browser)
    try:
        result = service.authorize()
        assert result['status'] == 'auth_required'
        assert result['authenticationReason'] == 'sms_required'
        assert result['challengeId'] == session.pending_sms.id
        assert not session.client.is_closed
    finally:
        if session.pending_sms:
            session.pending_sms.close()

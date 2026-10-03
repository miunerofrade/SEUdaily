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

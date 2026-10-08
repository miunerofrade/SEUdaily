"""SEU's normal CAS password login and portal requests, without a browser."""

from __future__ import annotations

import base64
import json
import os
import threading
import time
import uuid
from http.cookiejar import Cookie
from pathlib import Path
from urllib.parse import parse_qs, urljoin, urlsplit

import httpx
from cryptography.hazmat.primitives.asymmetric.padding import PKCS1v15
from cryptography.hazmat.primitives.serialization import load_der_public_key

from .cancellation import raise_if_cancelled
from .campus_device import device_fingerprint
from .json_store import write_json_atomic
from .runtime_paths import env_value
from .vpn import campus_proxy

from .campus_endpoints import AUTH_ROOT, USER_AGENT


class CampusAuthError(RuntimeError):
    def __init__(self, status: str, message: str):
        super().__init__(message)
        self.status = status

    def result(self) -> dict:
        # Both frontends attach their manual login entry to auth_required.
        status = (
            "auth_required"
            if self.status in {"captcha_required", "credentials_missing"}
            else self.status
        )
        return {
            "status": status,
            "message": str(self),
            "authenticationReason": self.status,
        }


class CampusSMSRequired(CampusAuthError):
    def __init__(self, challenge):
        super().__init__("sms_required", "校园登录需要短信验证码。")
        self.challenge = challenge

    def result(self):
        return {
            "status": "auth_required",
            "message": str(self),
            "authenticationReason": "sms_required",
            "challengeId": self.challenge.id,
        }


_sms_challenges = {}
_sms_lock = threading.RLock()


class SMSChallenge:
    """Keep the CAS cookie jar and login payload only in worker memory."""

    def __init__(self, session, payload, stop_before):
        self.id = uuid.uuid4().hex
        self.session, self.payload, self.stop_before = session, payload, stop_before
        self.expires = time.monotonic() + 300
        self.sent_at = 0
        self.callback = None
        self.done = threading.Event()
        self.lock = threading.RLock()
        self.timer = threading.Timer(300, self.close)
        self.timer.daemon = True
        with _sms_lock:
            _sms_challenges[self.id] = self
        self.timer.start()

    def close(self):
        with self.lock:
            with _sms_lock:
                _sms_challenges.pop(self.id, None)
            self.timer.cancel()
            if self.session.pending_sms is self:
                self.session.pending_sms = None
                self.session.client.close()
            self.done.set()

    def send(self):
        with self.lock:
            self.check_expiry()
            remaining = 60 - (time.monotonic() - self.sent_at)
            if self.sent_at and remaining > 0:
                return {"status": "completed", "retryAfter": int(remaining) + 1}
            result = self.session._auth_post(
                "sendStage2Code", {"userId": self.session.username}
            )
            if result.get("code") != 200:
                raise CampusAuthError("auth_required", "短信发送失败，请稍后重试。")
            self.sent_at = time.monotonic()
            return {"status": "completed", "retryAfter": 60}

    def check_expiry(self):
        if self.done.is_set() or time.monotonic() >= self.expires:
            raise CampusAuthError("auth_required", "短信验证已失效，请重新登录。")

    def verify(self, code):
        if not code.isascii() or not code.isdigit() or not 4 <= len(code) <= 16:
            raise CampusAuthError("auth_required", "请输入短信中的数字验证码。")
        with self.lock:
            self.check_expiry()
            key = self.session._auth_post("getChiperKey", {})
            public = load_der_public_key(base64.urlsafe_b64decode(key["publicKey"]))
            encrypt = lambda value: base64.b64encode(
                public.encrypt(value.encode(), PKCS1v15())
            ).decode()
            result = self.session._auth_post(
                "casLogin",
                {
                    **self.payload,
                    "password": encrypt(self.session.password),
                    "mobileVerifyCode": encrypt(code),
                },
            )
            if result.get("code") != 200:
                raise CampusAuthError(
                    "auth_required", "短信验证码未通过，请检查后重试。"
                )
            redirect = result.get("redirectUrl")
            if not redirect:
                raise CampusAuthError("auth_required", "统一认证未提供业务跳转地址。")
            try:
                self.session.get(
                    f"{AUTH_ROOT}/loginRedirect?redirectUrl={redirect}",
                    stop_before=self.stop_before,
                )
                self.session.ensure_authenticated(self.session.entry_url)
            except _CapturedRedirect as captured:
                self.callback = captured.url
            self.close()
            return {"status": "completed", "message": "短信验证已完成。"}


def sms_challenge_action(challenge_id, action, code=""):
    with _sms_lock:
        challenge = _sms_challenges.get(challenge_id)
    if not challenge or challenge.stop_before:
        raise CampusAuthError("auth_required", "短信验证已失效，请重新登录。")
    return challenge.send() if action == "send" else challenge.verify(code)


class _CapturedRedirect(Exception):
    def __init__(self, url):
        self.url = url


def _campus_url(url: str) -> str:
    parsed = urlsplit(url)
    host = parsed.hostname or ""
    if (
        parsed.scheme not in {"http", "https"}
        or not (host == "seu.edu.cn" or host.endswith(".seu.edu.cn"))
        or parsed.username
        or parsed.password
    ):
        raise CampusAuthError("auth_required", "认证跳转不属于校园系统，已停止。")
    return url


class CampusSession:
    """A short-lived HTTP client; existing Playwright cookie files stay compatible."""

    def __init__(
        self,
        cookie_file: str | Path,
        *,
        username=None,
        password=None,
        load_saved_cookies=True,
        use_vpn=True,
    ):
        self.cookie_file = Path(cookie_file)
        self.username = username or env_value("SEUDAILY_USERNAME")
        self.password = password or env_value("SEUDAILY_PASSWORD")
        self.client = httpx.Client(
            proxy=campus_proxy() if use_vpn else None,
            trust_env=False,
            timeout=30,
            headers={"User-Agent": USER_AGENT},
        )
        self.url = ""
        self.entry_url = ""
        self.pending_sms = None
        # The business parsers only require request.post(), context.cookies().
        self.request = self
        self.context = self
        if load_saved_cookies:
            self._load_cookies()

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        if self.pending_sms is None:
            self.client.close()

    def _load_cookies(self):
        try:
            saved = json.loads(self.cookie_file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        for item in saved:
            domain = item["domain"]
            self.client.cookies.jar.set_cookie(
                Cookie(
                    version=0,
                    name=item["name"],
                    value=item["value"],
                    port=None,
                    port_specified=False,
                    domain=domain,
                    domain_specified=domain.startswith("."),
                    domain_initial_dot=domain.startswith("."),
                    path=item.get("path", "/"),
                    path_specified=True,
                    secure=item.get("secure", False),
                    expires=int(item["expires"])
                    if item.get("expires", -1) > 0
                    else None,
                    discard=item.get("expires", -1) <= 0,
                    comment=None,
                    comment_url=None,
                    rest={
                        "SameSite": item.get("sameSite", "Lax"),
                        **({"HttpOnly": None} if item.get("httpOnly") else {}),
                    },
                    rfc2109=False,
                )
            )

    def cookies(self):
        return [
            {
                "name": c.name,
                "value": c.value,
                "domain": c.domain,
                "path": c.path,
                "expires": c.expires if c.expires is not None else -1,
                "secure": c.secure,
                "httpOnly": c.has_nonstandard_attr("HttpOnly"),
                "sameSite": c.get_nonstandard_attr("SameSite", "Lax"),
            }
            for c in self.client.cookies.jar
        ]

    def save(self):
        write_json_atomic(self.cookie_file, self.cookies())

    def get(self, url: str, *, stop_before=None):
        for _ in range(12):
            raise_if_cancelled()
            _campus_url(url)
            if stop_before and stop_before(url):
                raise _CapturedRedirect(url)
            response = self.client.get(url)
            self.url = str(response.url)
            if response.is_redirect:
                url = urljoin(self.url, response.headers["location"])
                continue
            return response
        raise CampusAuthError("auth_required", "校园系统认证跳转次数过多，请重新授权。")

    def _auth_post(self, endpoint, payload):
        response = self.client.post(
            f"{AUTH_ROOT}/{endpoint}",
            json=payload,
            headers={
                "Origin": "https://auth.seu.edu.cn",
                "Referer": "https://auth.seu.edu.cn/dist/",
            },
        )
        if not response.is_success:
            raise CampusAuthError(
                "auth_required",
                f"统一认证接口请求失败（HTTP {response.status_code}）。",
            )
        try:
            result = response.json()
            if not isinstance(result, dict):
                raise ValueError("Expected authentication object")
            return result
        except ValueError:
            raise CampusAuthError(
                "auth_required", "统一认证接口没有返回有效数据。"
            ) from None

    @staticmethod
    def _service(url):
        parsed = urlsplit(url)
        query = parse_qs(parsed.query or parsed.fragment.partition("?")[2])
        return query.get("service", [""])[0]

    @staticmethod
    def _check_login(result):
        if result.get("code") == 502 or result.get("needStage2Validation"):
            raise CampusAuthError(
                "captcha_required", "统一认证需要二次验证，请在登录窗口完成。"
            )
        if result.get("code") != 200:
            raise CampusAuthError(
                "auth_required",
                "统一认证未通过，可能需要验证码或检查账号密码；请在登录窗口完成。",
            )

    def capture_auth_redirect(self, entry_url, callback_matches):
        """Authenticate, but leave the one-use service ticket for its consumer."""
        try:
            self.ensure_authenticated(entry_url, stop_before=callback_matches)
        except _CapturedRedirect as captured:
            return captured.url
        raise CampusAuthError(
            "auth_required", "统一认证未提供预期回调，请使用登录窗口。"
        )

    def ensure_authenticated(self, entry_url, *, stop_before=None):
        # eHall itself and each launched application have separate CAS services.
        # First establish eHall, then exchange the same SSO session for the app.
        self.entry_url = entry_url
        password_submitted = False
        for _ in range(3):
            response = self.get(entry_url, stop_before=stop_before)
            if urlsplit(self.url).hostname != "auth.seu.edu.cn":
                if not response.is_success:
                    raise CampusAuthError(
                        "launch_failed",
                        f"校园应用启动失败（HTTP {response.status_code}）。",
                    )
                self.save()
                return
            service = self._service(self.url)
            if not service:
                raise CampusAuthError(
                    "auth_required", "统一认证页面缺少业务系统地址，请使用登录窗口。"
                )
            _campus_url(service)
            result = self._auth_post(
                "verifyTgt", {"service": service, "loginType": "account"}
            )
            password_login = not result.get("success")
            if password_login:
                if password_submitted:
                    raise CampusAuthError(
                        "auth_required", "认证会话未能保持，请使用登录窗口。"
                    )
                if not self.username or not self.password:
                    raise CampusAuthError(
                        "credentials_missing", "登录会话已失效，且未配置校园账号密码。"
                    )
                captcha = self.client.get(f"{AUTH_ROOT}/needCaptcha").json()
                if captcha.get("code") == 4000:
                    raise CampusAuthError(
                        "captcha_required", "统一认证需要验证码，请在登录窗口完成。"
                    )
                key = self._auth_post("getChiperKey", {})
                public = load_der_public_key(base64.urlsafe_b64decode(key["publicKey"]))
                encrypted = base64.b64encode(
                    public.encrypt(self.password.encode(), PKCS1v15())
                ).decode()
                try:
                    fingerprint = device_fingerprint()
                except (OSError, ValueError) as error:
                    raise CampusAuthError(
                        "auth_required",
                        "无法读取或保存校园设备标识，请检查数据目录中的 .seudaily/campus-device.json。",
                    ) from error
                login_payload = {
                    "service": service,
                    "username": self.username,
                    "password": encrypted,
                    "captcha": "",
                    "rememberMe": False,
                    "loginType": "account",
                    "wxBinded": False,
                    "mobilePhoneNum": "",
                    "mobileVerifyCode": "",
                    "fingerPrint": fingerprint,
                }
                result = self._auth_post("casLogin", login_payload)
                if result.get("code") == 502:
                    self.pending_sms = SMSChallenge(self, login_payload, stop_before)
                    raise CampusSMSRequired(self.pending_sms)
                password_submitted = True
                self._check_login(result)
            redirect = result.get("redirectUrl")
            if not redirect:
                raise CampusAuthError(
                    "auth_required", "统一认证未提供业务跳转地址，请使用登录窗口。"
                )
            if password_login:
                # This value is already URL-encoded; use it exactly as the login UI.
                response = self.get(
                    f"{AUTH_ROOT}/loginRedirect?redirectUrl={redirect}",
                    stop_before=stop_before,
                )
            else:
                response = self.get(redirect, stop_before=stop_before)
            if response.is_success and urlsplit(self.url).hostname != "auth.seu.edu.cn":
                self.save()
                return
        raise CampusAuthError("auth_required", "业务会话未建立，请使用登录窗口。")

    def post(self, url, *, form, headers=None, timeout=30000):
        _campus_url(url)
        for attempt in range(2):
            raise_if_cancelled()
            response = self.client.post(
                url, data=form, headers=headers, timeout=timeout / 1000
            )
            # A forbidden response or a maintenance HTML page is not proof of expired auth.
            html = "text/html" in response.headers.get("content-type", "")
            login_html = html and any(
                marker in response.text.lower()
                for marker in ("auth.seu.edu.cn", "authserver/login", "cas/login")
            )
            location = response.headers.get("location", "").lower()
            login_redirect = response.is_redirect and any(
                marker in location
                for marker in ("auth.seu.edu.cn", "authserver/login", "cas/login")
            )
            expired = response.status_code == 401 or login_redirect or login_html
            if not expired:
                return PortalResponse(response)
            if attempt == 0 and self.entry_url:
                self.ensure_authenticated(self.entry_url)
            else:
                raise CampusAuthError("auth_required", "业务会话已失效，请重新认证。")


class PortalResponse:
    """The small response interface used by the existing campus data parsers."""

    def __init__(self, response):
        self._response = response
        self.status = response.status_code
        self.ok = response.is_success

    def json(self):
        return self._response.json()

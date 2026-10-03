"""SEU's normal CAS password login and portal requests, without a browser."""
from __future__ import annotations

import base64
import json
import os
import tempfile
from http.cookiejar import Cookie
from pathlib import Path
from urllib.parse import parse_qs, urljoin, urlsplit

import httpx
from cryptography.hazmat.primitives.asymmetric.padding import PKCS1v15
from cryptography.hazmat.primitives.serialization import load_der_public_key

from .cancellation import raise_if_cancelled
from .runtime_paths import env_value
from .vpn import campus_proxy

AUTH_ROOT = "https://auth.seu.edu.cn/auth/casback"
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36"


class CampusAuthError(RuntimeError):
    def __init__(self, status: str, message: str):
        super().__init__(message)
        self.status = status

    def result(self) -> dict:
        # Both frontends attach their manual login entry to auth_required.
        status = "auth_required" if self.status in {"captcha_required", "credentials_missing"} else self.status
        return {"status": status, "message": str(self), "authenticationReason": self.status}


def _campus_url(url: str) -> str:
    parsed = urlsplit(url)
    host = parsed.hostname or ""
    if (parsed.scheme not in {"http", "https"} or
            not (host == "seu.edu.cn" or host.endswith(".seu.edu.cn")) or
            parsed.username or parsed.password):
        raise CampusAuthError("auth_required", "认证跳转不属于校园系统，已停止。")
    return url


class CampusSession:
    """A short-lived HTTP client; existing Playwright cookie files stay compatible."""

    def __init__(self, cookie_file: str | Path, *, username=None, password=None,
                 load_saved_cookies=True):
        self.cookie_file = Path(cookie_file)
        self.username = username or env_value("SEUDAILY_USERNAME")
        self.password = password or env_value("SEUDAILY_PASSWORD")
        self.client = httpx.Client(proxy=campus_proxy(), trust_env=False, timeout=30,
                                   headers={"User-Agent": USER_AGENT})
        self.url = ""
        self.entry_url = ""
        # The business parsers only require request.post(), context.cookies().
        self.request = self
        self.context = self
        if load_saved_cookies:
            self._load_cookies()

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.client.close()

    def _load_cookies(self):
        try:
            saved = json.loads(self.cookie_file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        for item in saved:
            domain = item["domain"]
            self.client.cookies.jar.set_cookie(Cookie(
                version=0, name=item["name"], value=item["value"],
                port=None, port_specified=False, domain=domain,
                domain_specified=domain.startswith("."), domain_initial_dot=domain.startswith("."),
                path=item.get("path", "/"), path_specified=True,
                secure=item.get("secure", False),
                expires=int(item["expires"]) if item.get("expires", -1) > 0 else None,
                discard=item.get("expires", -1) <= 0, comment=None, comment_url=None,
                rest={"SameSite": item.get("sameSite", "Lax"),
                      **({"HttpOnly": None} if item.get("httpOnly") else {})}, rfc2109=False))

    def cookies(self):
        return [{"name": c.name, "value": c.value, "domain": c.domain,
                 "path": c.path, "expires": c.expires if c.expires is not None else -1,
                 "secure": c.secure, "httpOnly": c.has_nonstandard_attr("HttpOnly"),
                 "sameSite": c.get_nonstandard_attr("SameSite", "Lax")} for c in self.client.cookies.jar]

    def save(self):
        self.cookie_file.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8",
                                         dir=self.cookie_file.parent, delete=False) as file:
            json.dump(self.cookies(), file)
            name = file.name
        os.replace(name, self.cookie_file)

    def get(self, url: str):
        for _ in range(12):
            raise_if_cancelled()
            _campus_url(url)
            response = self.client.get(url)
            self.url = str(response.url)
            if response.is_redirect:
                url = urljoin(self.url, response.headers["location"])
                continue
            return response
        raise CampusAuthError("auth_required", "校园系统认证跳转次数过多，请重新授权。")

    def _auth_post(self, endpoint, payload):
        response = self.client.post(f"{AUTH_ROOT}/{endpoint}", json=payload,
                                    headers={"Origin": "https://auth.seu.edu.cn",
                                             "Referer": "https://auth.seu.edu.cn/dist/"})
        if not response.is_success:
            raise CampusAuthError("auth_required", f"统一认证接口请求失败（HTTP {response.status_code}）。")
        try:
            return response.json()
        except ValueError:
            raise CampusAuthError("auth_required", "统一认证接口没有返回有效数据。") from None

    @staticmethod
    def _service(url):
        parsed = urlsplit(url)
        query = parse_qs(parsed.query or parsed.fragment.partition("?")[2])
        return query.get("service", [""])[0]

    @staticmethod
    def _check_login(result):
        if result.get("code") == 502 or result.get("needStage2Validation"):
            raise CampusAuthError("captcha_required", "统一认证需要二次验证，请在登录窗口完成。")
        if result.get("code") != 200:
            raise CampusAuthError("auth_required", "统一认证未通过，可能需要验证码或检查账号密码；请在登录窗口完成。")

    def ensure_authenticated(self, entry_url):
        # eHall itself and each launched application have separate CAS services.
        # First establish eHall, then exchange the same SSO session for the app.
        self.entry_url = entry_url
        password_submitted = False
        for _ in range(3):
            response = self.get(entry_url)
            if urlsplit(self.url).hostname != "auth.seu.edu.cn":
                if not response.is_success:
                    raise CampusAuthError("launch_failed", f"校园应用启动失败（HTTP {response.status_code}）。")
                self.save()
                return
            service = self._service(self.url)
            if not service:
                raise CampusAuthError("auth_required", "统一认证页面缺少业务系统地址，请使用登录窗口。")
            _campus_url(service)
            result = self._auth_post("verifyTgt", {"service": service, "loginType": "account"})
            password_login = not result.get("success")
            if password_login:
                if password_submitted:
                    raise CampusAuthError("auth_required", "认证会话未能保持，请使用登录窗口。")
                if not self.username or not self.password:
                    raise CampusAuthError("credentials_missing", "登录会话已失效，且未配置校园账号密码。")
                captcha = self.client.get(f"{AUTH_ROOT}/needCaptcha").json()
                if captcha.get("code") == 4000:
                    raise CampusAuthError("captcha_required", "统一认证需要验证码，请在登录窗口完成。")
                key = self._auth_post("getChiperKey", {})
                public = load_der_public_key(base64.urlsafe_b64decode(key["publicKey"]))
                encrypted = base64.b64encode(public.encrypt(self.password.encode(), PKCS1v15())).decode()
                result = self._auth_post("casLogin", {
                    "service": service, "username": self.username, "password": encrypted,
                    "captcha": "", "rememberMe": False, "loginType": "account",
                    "wxBinded": False, "mobilePhoneNum": "", "mobileVerifyCode": "",
                    "fingerPrint": None})
                password_submitted = True
                self._check_login(result)
            redirect = result.get("redirectUrl")
            if not redirect:
                raise CampusAuthError("auth_required", "统一认证未提供业务跳转地址，请使用登录窗口。")
            if password_login:
                # This value is already URL-encoded; use it exactly as the login UI.
                response = self.get(f"{AUTH_ROOT}/loginRedirect?redirectUrl={redirect}")
            else:
                response = self.get(redirect)
            if response.is_success and urlsplit(self.url).hostname != "auth.seu.edu.cn":
                self.save()
                return
        raise CampusAuthError("auth_required", "业务会话未建立，请使用登录窗口。")

    def post(self, url, *, form, headers=None, timeout=30000):
        _campus_url(url)
        for attempt in range(2):
            raise_if_cancelled()
            response = self.client.post(url, data=form, headers=headers, timeout=timeout / 1000)
            expired = (response.status_code in {401, 403} or response.is_redirect or
                       "text/html" in response.headers.get("content-type", ""))
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

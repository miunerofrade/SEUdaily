"""Own an aTrust sidecar and complete SEU CAS login without exposing credentials."""
from __future__ import annotations

import atexit
import hashlib
import http.client
import io
import json
import os
import platform
import queue
import re
import socket
import ssl
import subprocess
import threading
import time
from pathlib import Path
from urllib.parse import parse_qs, urljoin, urlsplit
from urllib.request import ProxyHandler, Request, build_opener
import zipfile

from .runtime_paths import env_value
from .subprocess_utils import hidden_process_options

SERVER = "https://vpn.seu.edu.cn"
RELEASE = "v1.3.1"
SOURCE_COMMIT = "5d7f5b11fcf231f72a0ec0d888bf0f2eadcce1da"
SOURCE_URL = f"https://github.com/Mythologyli/zju-connect/tree/{SOURCE_COMMIT}"


def _write_core_notices(directory: Path) -> None:
    """Keep upstream license and matching source references beside our download."""
    license_file = Path(__file__).with_name("licenses") / "AGPL-3.0.txt"
    (directory / "LICENSE").write_bytes(license_file.read_bytes())
    (directory / "SOURCE.txt").write_text(
        f"zju-connect {RELEASE}, unmodified upstream release\n"
        "License: GNU Affero General Public License version 3 (see LICENSE).\n"
        f"Upstream source: {SOURCE_URL}\n"
        f"Source archive: https://github.com/Mythologyli/zju-connect/archive/{SOURCE_COMMIT}.tar.gz\n"
        "Copyright notices, dependencies and build instructions are in the source tree.\n"
        "Provided WITHOUT ANY WARRANTY; see LICENSE for your rights and terms.\n",
        encoding="utf-8",
    )


def vpn_directory() -> Path:
    return Path(env_value("SEUDAILY_PROJECT_ROOT") or os.getcwd()) / ".seudaily" / "vpn"


def campus_proxy() -> str | None:
    """Shared with background workers; stale sessions never enable a proxy."""
    try:
        state = json.loads((vpn_directory() / "status.json").read_text())
        if state.get("state") != "connected":
            return None
        owner = state["ownerPid"]
        if not isinstance(owner, int) or owner <= 0:
            return None
        os.kill(owner, 0)
        proxy = state["httpProxy"]
        url = urlsplit(proxy)
        if url.scheme == "http" and url.hostname == "127.0.0.1" and url.port and not url.username and not url.password:
            return f"http://127.0.0.1:{url.port}"
    except (OSError, ValueError, KeyError, TypeError):
        pass
    return None


class CampusProxyHandler(ProxyHandler):
    def proxy_open(self, request, proxy, protocol):
        # Explicit VPN selection must override macOS/NO_PROXY bypass rules.
        # Otherwise campus DNS is resolved locally before CONNECT is attempted.
        endpoint = urlsplit(proxy)
        original = request.type
        request.set_proxy(endpoint.netloc, endpoint.scheme)
        if original == endpoint.scheme or original == "https":
            return None
        return self.parent.open(request, timeout=request.timeout)


def campus_opener(*handlers):
    proxy = campus_proxy()
    return build_opener(*handlers, *([CampusProxyHandler({"http": proxy, "https": proxy})] if proxy else []))


def install_core() -> Path:
    """Download a pinned official release, verifying its GitHub SHA256 digest."""
    configured = env_value("SEUDAILY_VPN_BINARY")
    if configured:
        binary = Path(configured).expanduser().resolve()
        if not binary.is_file():
            raise RuntimeError("配置的 VPN 核心不存在")
        return binary
    system = {"Darwin": "darwin", "Linux": "linux", "Windows": "windows"}.get(platform.system())
    machine = {"arm64": "arm64", "aarch64": "arm64", "x86_64": "amd64", "AMD64": "amd64"}.get(platform.machine())
    if not system or not machine:
        raise RuntimeError("此平台请通过 SEUDAILY_VPN_BINARY 指定 zju-connect")
    directory = vpn_directory() / "bin"
    binary = directory / ("zju-connect.exe" if system == "windows" else "zju-connect")
    provenance = directory / "release.json"
    if binary.is_file() and provenance.is_file():
        saved = json.loads(provenance.read_text())
        if saved.get("version") == RELEASE and saved.get("binarySha256") == hashlib.sha256(binary.read_bytes()).hexdigest():
            _write_core_notices(directory)
            return binary
    opener = build_opener()
    api = f"https://api.github.com/repos/Mythologyli/zju-connect/releases/tags/{RELEASE}"
    with opener.open(Request(api, headers={"User-Agent": "SEUdaily"}), timeout=30) as response:
        release = json.load(response)
    name = f"zju-connect-{system}-{machine}.zip"
    asset = next((item for item in release["assets"] if item["name"] == name), None)
    if not asset or not str(asset.get("digest", "")).startswith("sha256:"):
        raise RuntimeError("官方发布缺少适用平台或校验摘要，请手动配置 VPN 核心")
    with opener.open(asset["browser_download_url"], timeout=60) as response:
        archive = response.read(30 * 1024 * 1024 + 1)
    if len(archive) > 30 * 1024 * 1024 or hashlib.sha256(archive).hexdigest() != asset["digest"].split(":", 1)[1]:
        raise RuntimeError("VPN 核心下载校验失败")
    directory.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(archive)) as zipped:
        member = next(item for item in zipped.namelist() if Path(item).name == binary.name)
        binary.write_bytes(zipped.read(member))
    binary.chmod(0o700)
    provenance.write_text(json.dumps({"version": RELEASE, "source": asset["browser_download_url"], "sourceCommit": SOURCE_COMMIT, "binarySha256": hashlib.sha256(binary.read_bytes()).hexdigest()}))
    _write_core_notices(directory)
    return binary


def validate_callback(value: str) -> str:
    parsed = urlsplit(value)
    if parsed.scheme != "https" or parsed.hostname != "vpn.seu.edu.cn" or parsed.port not in (None, 443) or parsed.username or parsed.password or parsed.path != "/passport/v1/auth/cas":
        raise ValueError("VPN 回调地址不匹配")
    values = parse_qs(parsed.query)
    if values.get("sfDomain") != ["CAS-auth"] or not values.get("ticket"):
        raise ValueError("VPN 回调缺少正确认证域或票据")
    # v1.3.1 compares Host literally, omitting its default HTTPS port.
    return parsed._replace(netloc="vpn.seu.edu.cn", fragment="").geturl()


def capture_cas_redirect(context, current: str) -> str | None:
    """Follow CAS redirects only up to the unconsumed VPN callback."""
    for _ in range(20):
        response = context.request.get(current, max_redirects=0, timeout=30000)
        try:
            location = response.headers.get("location")
            if response.status not in (301, 302, 303, 307, 308) or not location:
                return None
            current = urljoin(current, location)
            redirected = urlsplit(current)
            if redirected.hostname == "vpn.seu.edu.cn" and redirected.path == "/passport/v1/auth/cas":
                return validate_callback(current)
            if redirected.hostname not in {"auth.seu.edu.cn", "vpn.seu.edu.cn"} or redirected.scheme != "https":
                raise ValueError("CAS 跳转地址无效")
        finally:
            response.dispose()
    raise RuntimeError("CAS 跳转次数过多")


class VpnManager:
    def __init__(self):
        self.process: subprocess.Popen | None = None
        self.thread: threading.Thread | None = None
        self.stop_event = threading.Event()
        self.lock = threading.RLock()
        self.state = {"state": "disconnected", "message": "未连接", "httpProxy": "", "ownerPid": os.getpid()}
        settings = vpn_directory() / "settings.json"
        self.configured_port = json.loads(settings.read_text()).get("port", 11081) if settings.exists() else 11081
        self.state["configuredPort"] = self.configured_port
        self.port = 0

    def _publish(self, state: str, message: str):
        with self.lock:
            if self.stop_event.is_set() and state != "disconnected":
                return
            self.state.update(state=state, message=message, httpProxy=f"http://127.0.0.1:{self.port}" if self.port else "", ownerPid=os.getpid())
            directory = vpn_directory()
            directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            directory.chmod(0o700)
            temporary = directory / "status.tmp"
            temporary.write_text(json.dumps(self.state, ensure_ascii=False))
            temporary.chmod(0o600)
            temporary.replace(directory / "status.json")

    def status(self):
        with self.lock:
            if self.state["state"] == "connected" and (not self.process or self.process.poll() is not None):
                self._publish("expired", "VPN 会话已失效，请重新连接")
            return dict(self.state)

    def connect(self, port: int | None = None):
        with self.lock:
            if port is not None and (isinstance(port, bool) or not isinstance(port, int) or not 1024 <= port <= 65535):
                raise ValueError("代理端口应为 1024–65535")
            if self.thread and self.thread.is_alive() and port is not None and port != self.port:
                raise ValueError("请先断开 VPN，再修改代理端口")
            if self.thread and self.thread.is_alive():
                return self.status()
            if port is not None:
                self.configured_port = port
            self.state["configuredPort"] = self.configured_port
            directory = vpn_directory()
            directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            (directory / "settings.json").write_text(json.dumps({"port": self.configured_port}))
            self.stop_event.clear()
            self._publish("connecting", "正在准备 VPN 核心")
            self.thread = threading.Thread(target=self._run, name="seudaily-vpn", daemon=True)
            self.thread.start()
            return self.status()

    def disconnect(self):
        self.stop_event.set()
        with self.lock:
            process = self.process
        if process and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill(); process.wait(timeout=3)
        if self.thread and self.thread is not threading.current_thread():
            self.thread.join(timeout=5)
        self._publish("disconnected", "已断开")
        return self.status()

    def verify(self, code: str):
        with self.lock:
            if self.state["state"] != "verification_required" or not self.process or not self.process.stdin:
                raise ValueError("当前没有待验证的 VPN 请求")
            if not re.fullmatch(r"[A-Za-z0-9]{4,16}", code):
                raise ValueError("验证码格式无效")
            self.process.stdin.write(code + "\n"); self.process.stdin.flush()
            self._publish("connecting", "正在验证")
        return self.status()

    def _login_cas(self, login_url: str) -> str:
        from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout
        from .browser_runtime import launch_browser
        url = urljoin(SERVER, login_url)
        parsed = urlsplit(url)
        if parsed.hostname != "vpn.seu.edu.cn" or parsed.scheme != "https":
            raise ValueError("VPN 返回的登录地址无效")
        self._publish("auth_required", "正在使用校园账号登录；验证码或额外验证请在打开的窗口完成")
        callback: list[str] = []
        with sync_playwright() as playwright:
            browser = launch_browser(playwright, visible=True)
            try:
                context = browser.new_context(locale="zh-CN", service_workers="block")
                def intercept(route):
                    request = route.request
                    target = urlsplit(request.url)
                    if target.hostname == "vpn.seu.edu.cn" and target.path == "/passport/v1/auth/cas":
                        callback.append(validate_callback(request.url))
                        route.abort()
                        return
                    if not request.is_navigation_request() or request.method != "GET" or target.hostname != "auth.seu.edu.cn":
                        route.continue_()
                        return
                    # Playwright does not route subsequent HTTP redirects. Probe the
                    # CAS navigation without following the one-use VPN ticket.
                    captured = capture_cas_redirect(context, request.url)
                    if captured:
                        callback.append(captured)
                        route.abort()
                        return
                    route.continue_()
                context.route("**/*", intercept)
                page = context.new_page()
                try:
                    page.goto(url, wait_until="commit", timeout=45000)
                except Exception:
                    if not callback:
                        raise
                deadline = time.monotonic() + 300
                filled = False
                while not callback and not self.stop_event.is_set() and time.monotonic() < deadline:
                    if not filled:
                        user = page.locator("input[placeholder*='一卡通'], input[placeholder*='唯一ID'], .input-username-pc").first
                        password = page.locator("input[type='password']").first
                        if user.count() and user.is_visible() and password.count():
                            username, secret = env_value("SEUDAILY_USERNAME"), env_value("SEUDAILY_PASSWORD")
                            if username and secret:
                                user.fill(username); password.fill(secret)
                                captcha = page.locator("input[placeholder*='验证码']").first
                                if not captcha.count() or not captcha.is_visible():
                                    try:
                                        page.locator("button:has-text('登 录'), .login-button-pc").first.click(timeout=10000, no_wait_after=True)
                                    except PlaywrightTimeout:
                                        if not callback:
                                            raise
                            else:
                                self._publish("auth_required", "未配置校园账号，请在登录窗口完成登录")
                            filled = True
                    page.wait_for_timeout(250)
                if not callback:
                    raise RuntimeError("VPN 登录未完成，请重新连接")
                return callback[0]
            finally:
                browser.close()

    def _run(self):
        ready = False
        try:
            binary = install_core()
            # Validate the public gateway certificate before using the core.
            with build_opener().open(SERVER + "/public/manifest", timeout=15) as response:
                if json.load(response).get("code") != 0:
                    raise RuntimeError("VPN 服务暂不可用")
            with socket.socket() as listener:
                listener.bind(("127.0.0.1", self.configured_port)); self.port = self.configured_port
            if self.stop_event.is_set():
                return
            directory = vpn_directory()
            # SEU's first policy DNS did not answer over L3 in live checks;
            # use its working second DNS through the tunnel, not direct fallback.
            dns_server = env_value("SEUDAILY_VPN_DNS_SERVER") or "202.119.24.12"
            args = [str(binary), "-protocol", "atrust", "-server", "vpn.seu.edu.cn", "-port", "443", "-auth-type", "auth/cas", "-login-domain", "CAS-auth", "-disable-zju-config", "-remote-dns-server", dns_server, "-socks-bind", "", "-http-bind", f"127.0.0.1:{self.port}", "-client-data-file", str(directory / "client-data.json")]
            environment = {k: v for k, v in os.environ.items() if not any(word in k.upper() for word in ("PASSWORD", "API_KEY", "TOKEN", "SECRET")) and not k.startswith("ZJU_CONNECT_")}
            # Large ML-KEM ClientHello messages can stall older aTrust gateways.
            # Use Go's documented compatibility switches only in this child.
            debug = [item for item in environment.get("GODEBUG", "").split(",") if item and item.split("=", 1)[0] not in ("tlsmlkem", "tlssecpmlkem")]
            environment["GODEBUG"] = ",".join([*debug, "tlsmlkem=0", "tlssecpmlkem=0"])
            with self.lock:
                if self.stop_event.is_set():
                    return
                self._publish("connecting", "正在读取东大 VPN 认证配置")
                self.process = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1, env=environment, **hidden_process_options())
            process = self.process
            lines: queue.Queue[str | None] = queue.Queue()
            def read_output():
                buffer = ""
                for char in iter(lambda: process.stdout.read(1), ""):
                    buffer += char
                    if char == "\n" or (buffer.endswith(": ") and "Please enter" in buffer):
                        lines.put(buffer.strip()); buffer = ""
                if buffer: lines.put(buffer.strip())
                lines.put(None)
            threading.Thread(target=read_output, daemon=True).start()
            deadline = time.monotonic() + 360
            while not self.stop_event.is_set():
                if not ready and time.monotonic() > deadline:
                    raise RuntimeError("VPN 连接超时，请重新连接")
                try:
                    line = lines.get(timeout=0.25)
                except queue.Empty:
                    continue
                if line is None:
                    raise RuntimeError("VPN 核心已退出，会话可能失效；请重新连接")
                if any(marker in line for marker in ('Exec func', 'Start ZJU', 'VPN protocol', 'Perform GET', 'HTTP server listening', 'Login error', 'VPN client setup error', 'DNS server', 'cvs.seu.edu.cn ->', 'ehall.seu.edu.cn ->')):
                    safe = re.sub(r'https?://\S+', '[URL]', line)
                    for secret in (env_value('SEUDAILY_USERNAME'), env_value('SEUDAILY_PASSWORD')):
                        if secret: safe = safe.replace(secret, '[redacted]')
                    with (directory / 'diagnostic.log').open('a', encoding='utf-8') as diagnostic:
                        diagnostic.write(safe + '\n')
                    (directory / 'diagnostic.log').chmod(0o600)
                if "VPN client setup error" in line and "i/o timeout" in line and ":441" in line:
                    raise RuntimeError("VPN 已认证，但 L3 隧道握手超时；校园 IP 通道尚未建立")
                if match := re.search(r"Visit (\S+) to login", line):
                    callback = self._login_cas(match[1])
                    if self.stop_event.is_set(): break
                    process.stdin.write(callback + "\n"); process.stdin.flush()
                    self._publish("connecting", "校园认证已完成，正在建立隧道")
                elif 'Perform GET /passport/v1/public/authConfig' in line:
                    self._publish('connecting', '正在等待 VPN 认证配置')
                elif "Please enter" in line and "callback" not in line.lower():
                    self._publish("verification_required", "VPN 要求额外验证码，请在设置页填写")
                elif "HTTP server listening" in line:
                    self._publish("connecting", "正在检查校园代理连接")
                    for attempt in range(3):
                        probe = http.client.HTTPSConnection("127.0.0.1", self.port, timeout=10, context=ssl.create_default_context())
                        try:
                            # Verify a real campus response, not just a listening
                            # proxy or CONNECT status. HEAD never downloads media.
                            probe.set_tunnel("cvs.seu.edu.cn", 443)
                            probe.request("HEAD", "/", headers={"Connection": "close"})
                            response = probe.getresponse()
                            if 200 <= response.status < 500:
                                ready = True
                                self._publish("connected", "VPN 已连接，课程门户响应检查通过")
                                break
                        except (OSError, http.client.HTTPException):
                            pass
                        finally:
                            probe.close()
                        if self.stop_event.wait(0.5):
                            break
                    if not ready and not self.stop_event.is_set():
                        raise RuntimeError("VPN 认证成功，但校园数据通道未通过验证（课程门户未响应）；尚不可用")
        except Exception as error:
            if not self.stop_event.is_set():
                message = str(error) if isinstance(error, RuntimeError) else f"VPN 连接失败（{type(error).__name__}），请检查网络或登录窗口后重试"
                self._publish("expired" if ready else "failed", message)
        finally:
            process = self.process
            if process and process.poll() is None:
                process.terminate()
                try: process.wait(timeout=3)
                except subprocess.TimeoutExpired: process.kill(); process.wait(timeout=3)
            for stream in (process.stdin, process.stdout) if process else ():
                if stream: stream.close()


_manager: VpnManager | None = None

def manager() -> VpnManager:
    global _manager
    if _manager is None:
        _manager = VpnManager()
        atexit.register(_manager.disconnect)
    return _manager


def run_standalone(port: int) -> int:
    """Keep the proxy alive in the foreground, without an agent backend."""
    import signal
    if not 1024 <= port <= 65535:
        raise RuntimeError("--vpn 端口应为 1024–65535")
    if not (env_value("SEUDAILY_USERNAME") or "").strip() or not (env_value("SEUDAILY_PASSWORD") or "").strip():
        raise RuntimeError("缺少校园账号或密码；请配置 SEUDAILY_USERNAME 和 SEUDAILY_PASSWORD")
    if campus_proxy():
        raise RuntimeError("已有校园 VPN 连接；请先在原窗口断开，再启动独立 VPN")
    with socket.socket() as probe:
        try:
            probe.bind(("127.0.0.1", port))
        except OSError:
            raise RuntimeError(f"代理端口 {port} 已被占用，请选择其他端口") from None
    stopped = threading.Event()
    def stop(*_):
        if not stopped.is_set():
            stopped.set()
            raise KeyboardInterrupt
    handlers = {sig: signal.signal(sig, stop) for sig in (signal.SIGINT, signal.SIGTERM)}
    vpn = manager()
    previous = None
    try:
        vpn.connect(port)
        while not stopped.is_set():
            state = vpn.status()
            current = (state["state"], state["message"])
            if current != previous:
                print(state["message"], flush=True)
                if state["state"] == "connected":
                    print(f"HTTP 代理：{state['httpProxy']}（支持 HTTPS CONNECT）；按 Ctrl+C 断开。", flush=True)
                previous = current
            if state["state"] in {"failed", "expired"}:
                return 1
            if state["state"] == "verification_required":
                from getpass import getpass
                vpn.verify(getpass("VPN 验证码："))
            stopped.wait(0.2)
        return 130
    except KeyboardInterrupt:
        return 130
    finally:
        vpn.disconnect()
        for sig, handler in handlers.items():
            signal.signal(sig, handler)


if __name__ == "__main__":
    import argparse
    import sys
    parser = argparse.ArgumentParser(description="独立运行校园 VPN")
    parser.add_argument("port", type=int)
    args = parser.parse_args()
    try:
        raise SystemExit(run_standalone(args.port))
    except RuntimeError as error:
        print(f"SEUdaily：{error}", file=sys.stderr)
        raise SystemExit(1) from None

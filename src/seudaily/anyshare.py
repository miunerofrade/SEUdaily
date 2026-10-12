"""Experimental AnyShare backup transport using the existing campus HTTP session."""
from __future__ import annotations

import json
import os
import re
import threading
import tempfile
from pathlib import Path
from urllib.parse import unquote, urlsplit

import httpx

from .campus_auth import CampusAuthError, CampusSession
from .cancellation import raise_if_cancelled
from .json_store import write_json_atomic
from .runtime_paths import env_value
from .vpn import campus_proxy

BASE_URL = "https://pan.seu.edu.cn"
MAX_BYTES = 100 * 1024 * 1024
_SESSION_LOCK = threading.RLock()


class AnyShareError(RuntimeError):
    pass


def validate_docid(value: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"gns://[A-Za-z0-9-]+(?:/[A-Za-z0-9-]+)*", value):
        raise ValueError("请使用云盘列表返回的 gns docid。")
    return value


class AnyShareClient:
    def __init__(self, root: Path):
        self.root = Path(root).resolve()
        self.directory = self.root / ".seudaily" / "anyshare"
        self.session = CampusSession(self.directory / "cookies.json")
        self.session.save = self.save

    def __enter__(self):
        _SESSION_LOCK.acquire()
        return self

    def __exit__(self, *args):
        try:
            self.session.__exit__(*args)
        finally:
            _SESSION_LOCK.release()

    def save(self):
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        write_json_atomic(self.directory / "cookies.json", self.session.cookies())
        (self.directory / "cookies.json").chmod(0o600)

    def token(self):
        for cookie in self.session.client.cookies.jar:
            if cookie.name == "client.oauth2_token" and cookie.domain.lstrip(".") == "pan.seu.edu.cn":
                return unquote(cookie.value)
        return ""

    def login(self):
        # The web portal requires a real redirect target in its OAuth state.
        response = self.session.get(BASE_URL + "/anyshare/oauth2/login?redirect=%2Fanyshare%2Fzh-cn%2Fhomepage")
        match = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', response.text)
        if self.token() and response.is_success and not match:
            self.save()
            return
        try:
            props = json.loads(match.group(1))["props"]["pageProps"]
            entry = props["authconfig"]["thirdauth"]["config"]["authServer"]
            self.session.client.cookies.set("login_challenge", props["challenge"], domain="pan.seu.edu.cn", path="/")
        except (AttributeError, KeyError, TypeError, ValueError):
            raise CampusAuthError("auth_required", "云盘登录配置已变化，请重新检查登录接口。") from None
        self.session.ensure_authenticated(entry)
        if not self.token():
            raise CampusAuthError("auth_required", "云盘 OAuth 回调未建立会话。")
        self.save()

    def refresh(self):
        response = self.session.client.get(BASE_URL + "/anyshare/oauth2/login/refreshToken")
        if response.is_success and self.token():
            self.save()
            return
        self.login()

    def api(self, endpoint: str, payload=None):
        if not self.token():
            self.login()
        for attempt in range(2):
            raise_if_cancelled()
            response = self.session.client.request("GET" if payload is None else "POST", BASE_URL + "/api/efast/v1/" + endpoint,
                json=payload, headers={"Authorization": "Bearer " + self.token()})
            if response.status_code == 401 and attempt == 0:
                self.refresh()
                continue
            if response.status_code == 401:
                raise CampusAuthError("auth_required", "云盘会话已失效，请重新认证。")
            if not response.is_success:
                raise AnyShareError(f"云盘 {endpoint} 请求失败（HTTP {response.status_code}）。")
            try:
                return response.json()
            except ValueError:
                raise AnyShareError("云盘接口未返回 JSON。") from None

    def roots(self):
        return self.api("owned-doc-lib")

    def list_directory(self, docid: str):
        return self.api("dir/list", {"docid": validate_docid(docid)})

    def backup_directory(self, parent: str, name="SEUdaily备份", *, create=True):
        listing = self.list_directory(parent)
        for item in listing.get("dirs", []):
            if item["name"] == name:
                return validate_docid(item["docid"])
        if not create:
            raise ValueError("该文档库中还没有 SEUdaily备份 目录。")
        return self.api("dir/create", {"docid": parent, "name": name, "ondup": 1})["docid"]

    @staticmethod
    def signed_request(value, method):
        if not isinstance(value, list) or len(value) < 2 or value[0] != method:
            raise AnyShareError("云盘文件传输协议发生变化。")
        url = urlsplit(value[1])
        if url.scheme != "https" or not url.hostname or url.username or url.password:
            raise AnyShareError("云盘未返回 HTTPS 文件传输地址。")
        headers = {}
        for line in value[2:]:
            key, separator, content = line.partition(":")
            if not separator:
                raise AnyShareError("云盘文件传输请求头无效。")
            headers[key.strip()] = content.strip()
        return value[1], headers

    def upload(self, parent: str, path: Path, name: str):
        size = path.stat().st_size
        if not 0 < size <= MAX_BYTES:
            raise ValueError("实验版备份文件需在 100 MB 以内。")
        created = self.api("file/osbeginupload", {"docid": validate_docid(parent), "name": name, "length": size,
            "ondup": 1, "reqmethod": "PUT", "usehttps": True})
        url, headers = self.signed_request(created["authrequest"], "PUT")
        headers["Content-Length"] = str(size)
        # Use a separate client: portal cookies and bearer tokens stay at the portal.
        with httpx.Client(proxy=campus_proxy(), trust_env=False, timeout=120) as transfer, path.open("rb") as source:
            def chunks():
                while block := source.read(1024 * 1024):
                    raise_if_cancelled()
                    yield block
            response = transfer.put(url, headers=headers, content=chunks())
            if not response.is_success:
                raise AnyShareError(f"云盘备份数据上传失败（HTTP {response.status_code}）。")
        result = self.api("file/osendupload", {"docid": created["docid"], "rev": created["rev"]})
        return {"docid": created["docid"], "rev": created["rev"], "name": result.get("name", name), "size": size}

    def download(self, docid: str, destination: Path):
        info = self.api("file/osdownload", {"docid": validate_docid(docid), "usehttps": True})
        url, headers = self.signed_request(info["authrequest"], "GET")
        destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if destination.exists() or destination.is_symlink():
            raise ValueError("该备份已下载，请先使用现有文件。")
        fd, name = tempfile.mkstemp(prefix=".download-", suffix=".part", dir=destination.parent)
        os.close(fd)
        temporary = Path(name)
        try:
            size = 0
            with httpx.Client(proxy=campus_proxy(), trust_env=False, timeout=120) as transfer:
                with transfer.stream("GET", url, headers=headers) as response:
                    if not response.is_success:
                        raise AnyShareError(f"下载备份失败（HTTP {response.status_code}）。")
                    with temporary.open("wb") as target:
                        for block in response.iter_bytes():
                            raise_if_cancelled()
                            size += len(block)
                            if size > MAX_BYTES:
                                raise ValueError("实验版下载备份需在 100 MB 以内。")
                            target.write(block)
            os.link(temporary, destination)
            return size
        finally:
            temporary.unlink(missing_ok=True)

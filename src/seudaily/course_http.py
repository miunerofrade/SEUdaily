"""Authenticated requests to the course application's normal student APIs."""

from __future__ import annotations

import os
import json
import re
import tempfile
from pathlib import Path

from .campus_auth import CampusAuthError, CampusSession
from .cancellation import raise_if_cancelled

from .campus_endpoints import BASE_URL, UI_URL, ENTRY_URL, COURSE_ENDPOINTS


class CourseAPIError(RuntimeError):
    def __init__(self, message: str, *, forbidden: bool = False):
        super().__init__(message)
        self.forbidden = forbidden


class CourseHTTPClient:
    def __init__(self, cookie_file, *, username=None, password=None):
        self.session = CampusSession(cookie_file, username=username, password=password)
        self.token = None

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.session.__exit__(*_args)

    def authenticate(self):
        self.session.ensure_authenticated(ENTRY_URL)
        response = self.session.client.get(BASE_URL + COURSE_ENDPOINTS["token"])
        if response.status_code != 200:
            raise CampusAuthError(
                "auth_required", "课程应用未能建立登录态，请重新授权。"
            )
        try:
            data = response.json()
        except ValueError as error:
            raise CourseAPIError("课程登录接口没有返回有效 JSON") from error
        payload = data.get("result") if isinstance(data, dict) else None
        if not isinstance(payload, dict):
            raise CourseAPIError("课程登录接口返回格式无效，学校接口可能发生变化")
        self.token = payload.get("jwt_token")
        if not self.token:
            raise CampusAuthError(
                "auth_required", "课程应用没有返回有效登录凭据，请重新授权。"
            )
        self.session.save()

    @staticmethod
    def _expired(response, data):
        return (
            response.status_code == 401
            or response.is_redirect
            or (
                isinstance(data, dict)
                and (
                    data.get("status") == 401
                    or data.get("code") in (10013, 10014, 115117)
                    or (
                        data.get("code") == "-1"
                        and re.search(
                            r"invalid.?token|token已失效|jwt签名错误",
                            str(data.get("message", "")),
                            re.I,
                        )
                    )
                )
            )
        )

    @staticmethod
    def _forbidden(data):
        return isinstance(data, dict) and (
            data.get("status") == 403
            or re.search(
                r"无.{0,10}权限|没有.{0,10}权限|权限不足|禁止访问|拒绝访问|未开启.{0,10}下载|forbidden|access denied|permission denied",
                str(data.get("message", "")),
                re.I,
            )
        )

    def get(self, path, params=None):
        if self.token is None:
            self.authenticate()
        for attempt in range(2):
            raise_if_cancelled()
            response = self.session.client.get(
                BASE_URL + path, params=params, headers={"jwt-token": self.token}
            )
            try:
                data = response.json()
            except ValueError:
                data = None
            if self._expired(response, data):
                if attempt == 0:
                    self.authenticate()
                    continue
                raise CampusAuthError("auth_required", "课程登录态已失效，请重新授权。")
            status = data.get("status", 200) if isinstance(data, dict) else 200
            if response.status_code == 403 or self._forbidden(data):
                raise CourseAPIError(
                    "当前账号没有访问该课程资源的权限。", forbidden=True
                )
            if response.status_code != 200 or status != 200 or data is None:
                raise CourseAPIError(
                    f"课程接口请求失败（HTTP {response.status_code}，业务状态 {status}）。"
                )
            return data

    def records(self, path, params=None):
        """Read all pages, keeping the same ordering across course/session tools."""
        params = {**(params or {}), "page.pageIndex": 1, "page.pageSize": 100}
        rows = []
        seen = set()
        for _ in range(1000):
            payload = self.get(path, params)
            result = payload.get("data") if isinstance(payload, dict) else None
            if not isinstance(result, dict) or not isinstance(
                result.get("records"), list
            ):
                raise CourseAPIError(f"课程分页接口 {path} 返回格式无效")
            page, total = result["records"], result.get("rowCount")
            if isinstance(total, bool) or not isinstance(total, int) or total < 0:
                raise CourseAPIError(f"课程分页接口 {path} 缺少有效记录总数")
            fingerprint = json.dumps(page, sort_keys=True, ensure_ascii=False)
            if page and fingerprint in seen:
                raise CourseAPIError(f"课程分页接口 {path} 重复返回同一页，已停止请求")
            seen.add(fingerprint)
            rows.extend(page)
            if len(rows) >= total:
                return rows
            if not page:
                raise CourseAPIError(f"课程分页接口 {path} 提前结束，数据不完整")
            params["page.pageIndex"] += 1
        raise CourseAPIError(f"课程分页接口 {path} 超过 1000 页，已停止请求")

    def play(self, course_id):
        data = self.get(COURSE_ENDPOINTS["play"], {"courseId": course_id}).get("data")
        if data and data.get("lvcrVodStatus") == 0:
            raise CourseAPIError("当前账号没有播放该课次的权限。", forbidden=True)
        return data or {}

    def subtitle(self, course_id):
        return self.get(
            COURSE_ENDPOINTS["subtitle"].format(course_id=course_id),
            {"useOriginal": "false"},
        )

    def save_slides(self, course_id, destination: Path):
        """Use the server's PDF export instead of downloading a video to extract slides."""
        if self.token is None:
            self.authenticate()
        temporary = None
        try:
            for attempt in range(2):
                raise_if_cancelled()
                with self.session.client.stream(
                    "GET",
                    BASE_URL + COURSE_ENDPOINTS["slides_pdf"],
                    params={"courseId": course_id},
                    headers={"jwt-token": self.token},
                ) as response:
                    if response.status_code == 401 or response.is_redirect:
                        if attempt == 0:
                            self.authenticate()
                            continue
                        raise CampusAuthError(
                            "auth_required", "课件导出登录态已失效，请重新授权。"
                        )
                    if response.status_code == 403:
                        raise CourseAPIError(
                            "当前账号没有下载该课件的权限。", forbidden=True
                        )
                    if response.status_code != 200:
                        raise CourseAPIError(
                            f"课件导出失败（HTTP {response.status_code}）。"
                        )
                    if "json" in response.headers.get("content-type", ""):
                        response.read()
                        data = response.json()
                        if self._expired(response, data):
                            if attempt == 0:
                                self.authenticate()
                                continue
                            raise CampusAuthError(
                                "auth_required", "课件导出登录态已失效，请重新授权。"
                            )
                        if self._forbidden(data):
                            raise CourseAPIError(
                                "当前账号没有下载该课件的权限。", forbidden=True
                            )
                        raise CourseAPIError("课件导出未返回有效 PDF。")
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    with tempfile.NamedTemporaryFile(
                        dir=destination.parent, delete=False
                    ) as file:
                        temporary = Path(file.name)
                        for chunk in response.iter_bytes():
                            raise_if_cancelled()
                            file.write(chunk)
                    with temporary.open("rb") as file:
                        if file.read(5) != b"%PDF-":
                            raise CourseAPIError("课件导出未返回有效 PDF。")
                    os.replace(temporary, destination)
                    return
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)

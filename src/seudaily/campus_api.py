"""The eHall response envelope, independent of timetable/plan business rules."""

from __future__ import annotations

from typing import Any
from .campus_auth import CampusAuthError


class CampusAPIError(RuntimeError):
    """Upstream HTTP or schema failure; never a confirmed empty result."""


def dataset_rows(payload: Any, dataset: str) -> list[dict[str, Any]]:
    data = payload.get("datas") if isinstance(payload, dict) else None
    table = data.get(dataset) if isinstance(data, dict) else None
    rows = table.get("rows") if isinstance(table, dict) else None
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        raise CampusAPIError(
            f"eHall 返回的 {dataset} 数据格式无效；学校接口可能发生变化"
        )
    # Missing rows is an error; an explicit [] is a valid empty dataset.
    return rows


def post_rows(
    page, url: str, dataset: str, form: dict, *, headers=None
) -> list[dict[str, Any]]:
    options = {"form": form, "timeout": 30000}
    if headers is not None:
        options["headers"] = headers
    response = page.request.post(url, **options)
    if response.status == 401:
        raise CampusAuthError("auth_required", "校园应用登录已失效，请重新认证。")
    if response.status == 403:
        raise CampusAPIError(
            f"eHall 接口 {dataset} 拒绝访问（HTTP 403），请检查账号权限"
        )
    if not response.ok:
        raise CampusAPIError(f"eHall 接口 {dataset} 请求失败（HTTP {response.status}）")
    try:
        payload = response.json()
    except ValueError as error:
        raise CampusAPIError(f"eHall 接口 {dataset} 没有返回有效 JSON") from error
    return dataset_rows(payload, dataset)

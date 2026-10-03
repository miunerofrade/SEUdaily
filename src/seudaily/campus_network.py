"""Classify campus transport failures without exposing request credentials."""
from __future__ import annotations

import errno
import re
import socket
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit

import httpx

MESSAGE = "需要校园网环境"
CODE = "campus_network_required"
CAMPUS_ACTIONS = frozenset({
    "authorize", "authorize-schedule", "get-schedule", "get-training-plan",
    "search-training-plans", "analyze-training-plan", "list-courses", "search-courses",
    "list-course-sessions", "find-course-session", "capture-course-session",
    "capture-course-sessions", "list-dates", "capture-course", "list-jwc", "search-jwc",
    "get-jwc-article", "list-cse", "search-cse", "get-cse-article", "run-focus-cycle",
    "run-course-focus-queue",
})
_URL = re.compile(r'https?://[^\s<>"\']+', re.I)
_NETWORK_MARKERS = (
    "err_name_not_resolved", "err_connection_refused", "err_connection_timed_out",
    "err_address_unreachable", "err_network_unreachable", "err_internet_disconnected",
    "err_connection_reset", "getaddrinfo failed", "name or service not known",
    "nodename nor servname provided", "temporary failure in name resolution",
    "connection refused", "network is unreachable", "no route to host",
    "could not connect to the server", "couldn't connect to server",
    "could not resolve host", "a server with the specified hostname could not be found",
    "ns_error_unknown_host", "ns_error_connection_refused", "ns_error_net_timeout",
    "ns_error_net_reset", "ns_error_offline",
)
_NETWORK_ERRNOS = {errno.ECONNREFUSED, errno.ENETUNREACH, errno.EHOSTUNREACH, errno.ECONNRESET}


def _campus_url(value: str) -> bool:
    try:
        host = (urlsplit(value).hostname or "").lower().rstrip(".")
        return host == "seu.edu.cn" or host.endswith(".seu.edu.cn")
    except ValueError:
        return False


def _campus_context(action: str, payload: dict[str, Any], message: str) -> bool:
    urls = _URL.findall(message)
    if urls:
        return any(_campus_url(url) for url in urls) and all(_campus_url(url) for url in urls)
    if action == "read-web-page":
        return _campus_url(str(payload.get("url") or ""))
    if action not in CAMPUS_ACTIONS:
        return False
    for key in ("targetUrl", "baseUrl"):
        if payload.get(key) and not _campus_url(str(payload[key])):
            return False
    # Capture can also call a public ASR provider: require a campus URL for those failures.
    if action.startswith("capture-") and payload.get("asrEngine") == "cloud":
        return False
    return True


def network_category(action: str, payload: dict[str, Any], error: BaseException) -> str | None:
    message = str(error)
    if not _campus_context(action, payload, message):
        return None
    visited: set[int] = set()
    current: BaseException | None = error
    while current is not None and id(current) not in visited:
        visited.add(id(current))
        if isinstance(current, HTTPError):
            return None  # HTTP/auth/provider failures are not connectivity failures.
        if isinstance(current, socket.gaierror):
            return "dns"
        if isinstance(current, OSError) and current.errno in _NETWORK_ERRNOS:
            return "connection"
        text = str(current).lower()
        if any(marker in text for marker in _NETWORK_MARKERS):
            return "connection"
        if isinstance(current, (TimeoutError, socket.timeout, httpx.TimeoutException)):
            return "timeout"
        if ("timeout" in text or "timed out" in text) and ("page.goto" in text or "apirequestcontext" in text or "urlopen error" in text or "远端刷新失败" in text):
            # Playwright selector, login and expect_page timeouts must retain their meaning.
            return "timeout"
        if isinstance(current, URLError) and isinstance(current.reason, BaseException):
            current = current.reason
        else:
            current = current.__cause__ or current.__context__
    return None


def failure_result(category: str) -> dict[str, Any]:
    return {"status": "failed", "message": MESSAGE, "errorCode": CODE,
            "diagnosticCategory": category}


def sanitize_campus_result(action: str, payload: dict[str, Any], result: dict[str, Any]) -> dict[str, Any]:
    """Catch failures services have already converted into result dictionaries."""
    if result.get("status") in {"auth_required", "credentials_missing", "captcha_required", "auth_cancelled"}:
        return result
    if result.get("status") in {"failed", "error"}:
        for key in ("error", "message"):
            if isinstance(result.get(key), str):
                category = network_category(action, payload, RuntimeError(result[key]))
                if category:
                    return failure_result(category)
    warnings = result.get("warnings")
    if isinstance(warnings, list):
        for warning in warnings:
            if isinstance(warning, str):
                category = network_category(action, payload, RuntimeError(warning))
                if category:
                    return failure_result(category)
    sessions = result.get("results") or result.get("sessions")
    if isinstance(sessions, list):
        cleaned = [sanitize_campus_result(action, payload, item) if isinstance(item, dict) else item for item in sessions]
        if any(isinstance(item, dict) and item.get("errorCode") == CODE for item in cleaned):
            return failure_result("connection")
    return result

from __future__ import annotations

import atexit
import sys
import os
from pathlib import Path
import threading
from contextlib import contextmanager, suppress
from typing import TYPE_CHECKING, Any, Iterator

if TYPE_CHECKING:
    from playwright.sync_api import Browser, BrowserContext, Page, Playwright

from .optional_runtime import ensure_dependencies, preparation, run_install


def sync_playwright():
    ensure_dependencies("browser")
    from playwright.sync_api import sync_playwright as start
    return start()

from .runtime_paths import env_value
from .vpn import campus_proxy


def selected_browser() -> str:
    """Use the platform browser family, with an explicit environment override."""
    configured = (env_value("SEUDAILY_BROWSER") or "auto").strip().lower() or "auto"
    if configured == "safari":
        configured = "webkit"
    if configured == "auto":
        return "msedge" if sys.platform == "win32" else "webkit" if sys.platform == "darwin" else "firefox"
    if configured not in {"msedge", "webkit", "firefox", "chromium"}:
        raise ValueError("SEUDAILY_BROWSER 必须为 auto、msedge、webkit、safari、firefox 或 chromium")
    return configured


def launch_browser(playwright: Playwright, *, visible: bool) -> Browser:
    backend = selected_browser()
    if os.environ.get("SEUDAILY_INSTALL_ROOT") and backend != "msedge":
        executable = Path(getattr(playwright, backend).executable_path)
        if not executable.exists():
            preparation("preparing", f"正在下载并安装 {backend} 浏览器…", name="browser")
            try:
                run_install([sys.executable, "-m", "playwright", "install", backend])
                preparation("ready", "浏览器运行环境已就绪", name="browser")
            except Exception as error:
                preparation("failed", f"浏览器安装失败：{error}", name="browser")
                raise
    options: dict[str, Any] = {"headless": not visible}
    if backend in {"msedge", "chromium"}:
        options["args"] = ["--disable-blink-features=AutomationControlled", "--mute-audio"]
        options["args"].extend(
            ["--window-position=0,0", "--start-maximized"] if visible else ["--window-size=1920,1080"]
        )
        if backend == "msedge":
            options["channel"] = "msedge"
        return playwright.chromium.launch(**options)
    return getattr(playwright, backend).launch(**options)


class BrowserRuntime:
    """Process-local Playwright runtime for the long-lived worker."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._owner_thread: int | None = None
        self._playwright: Playwright | None = None
        self._browser: Browser | None = None
        self._contexts: dict[str, BrowserContext] = {}
        self._context_proxies: dict[str, str | None] = {}

    def _assert_thread(self) -> None:
        thread_id = threading.get_ident()
        if self._owner_thread is None:
            self._owner_thread = thread_id
        elif self._owner_thread != thread_id:
            raise RuntimeError("共享 Playwright 浏览器必须在 Worker 主线程中使用")

    def _ensure_playwright(self) -> Playwright:
        self._assert_thread()
        if self._playwright is None:
            self._playwright = sync_playwright().start()
        return self._playwright

    def _ensure_browser(self) -> Browser:
        playwright = self._ensure_playwright()
        if self._browser is None or not self._browser.is_connected():
            self._browser = launch_browser(playwright, visible=False)
            self._contexts.clear()
        return self._browser

    @contextmanager
    def page(
        self,
        portal: str,
        *,
        visible: bool,
        context_options: dict[str, Any],
    ) -> Iterator[Page]:
        with self._lock:
            temporary_browser: Browser | None = None
            temporary_context: BrowserContext | None = None
            context: BrowserContext | None = None
            existing_pages: set[Page] = set()
            try:
                proxy = campus_proxy() if portal in {'course-portal', 'schedule-portal', 'training-plan-portal'} else None
                context_options = {**context_options, **({'proxy': {'server': proxy, 'bypass': 'localhost,127.0.0.1'}} if proxy else {})}
                if self._context_proxies.get(portal) != proxy:
                    old = self._contexts.pop(portal, None)
                    if old is not None:
                        old.close()
                self._context_proxies[portal] = proxy
                if visible:
                    temporary_browser = launch_browser(self._ensure_playwright(), visible=True)
                    temporary_context = temporary_browser.new_context(**context_options)
                    context = temporary_context
                else:
                    browser = self._ensure_browser()
                    context = self._contexts.get(portal)
                    if context is None:
                        context = browser.new_context(**context_options)
                        self._contexts[portal] = context

                existing_pages = set(context.pages)
                page = context.new_page()
                yield page
            finally:
                if context is not None:
                    for opened_page in list(context.pages):
                        if opened_page not in existing_pages:
                            with suppress(Exception):
                                opened_page.close()
                for temporary in (temporary_context, temporary_browser):
                    if temporary is not None:
                        with suppress(Exception):
                            temporary.close()

    def invalidate_context(self, portal: str) -> None:
        with self._lock:
            context = self._contexts.pop(portal, None)
            if context is not None:
                with suppress(Exception):
                    context.close()

    def close(self) -> None:
        with self._lock:
            for context in list(self._contexts.values()):
                with suppress(Exception):
                    context.close()
            self._contexts.clear()
            if self._browser is not None:
                with suppress(Exception):
                    self._browser.close()
                self._browser = None
            if self._playwright is not None:
                with suppress(Exception):
                    self._playwright.stop()
                self._playwright = None
            self._owner_thread = None


_runtime = BrowserRuntime()
atexit.register(_runtime.close)


def browser_runtime() -> BrowserRuntime:
    return _runtime

from __future__ import annotations

import atexit
import threading
from contextlib import contextmanager
from typing import Any, Iterator

from playwright.sync_api import Browser, BrowserContext, Page, Playwright, sync_playwright


class BrowserRuntime:
    """Process-local Playwright runtime for the long-lived worker."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._owner_thread: int | None = None
        self._playwright: Playwright | None = None
        self._browser: Browser | None = None
        self._contexts: dict[str, BrowserContext] = {}

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
            self._browser = playwright.chromium.launch(
                headless=True,
                args=[
                    "--disable-blink-features=AutomationControlled",
                    "--mute-audio",
                    "--window-size=1920,1080",
                ],
            )
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
            playwright = self._ensure_playwright()
            temporary_browser: Browser | None = None
            temporary_context: BrowserContext | None = None
            if visible:
                temporary_browser = playwright.chromium.launch(
                    headless=False,
                    args=[
                        "--disable-blink-features=AutomationControlled",
                        "--mute-audio",
                        "--window-position=0,0",
                        "--start-maximized",
                    ],
                )
                temporary_context = temporary_browser.new_context(**context_options)
                context = temporary_context
            else:
                context = self._contexts.get(portal)
                if context is None:
                    context = self._ensure_browser().new_context(**context_options)
                    self._contexts[portal] = context

            existing_pages = set(context.pages)
            page = context.new_page()
            try:
                yield page
            finally:
                for opened_page in list(context.pages):
                    if opened_page not in existing_pages:
                        try:
                            opened_page.close()
                        except Exception:
                            pass
                if temporary_context is not None:
                    temporary_context.close()
                if temporary_browser is not None:
                    temporary_browser.close()

    def invalidate_context(self, portal: str) -> None:
        with self._lock:
            context = self._contexts.pop(portal, None)
            if context is not None:
                try:
                    context.close()
                except Exception:
                    pass

    def close(self) -> None:
        with self._lock:
            for context in list(self._contexts.values()):
                try:
                    context.close()
                except Exception:
                    pass
            self._contexts.clear()
            if self._browser is not None:
                try:
                    self._browser.close()
                except Exception:
                    pass
                self._browser = None
            if self._playwright is not None:
                try:
                    self._playwright.stop()
                except Exception:
                    pass
                self._playwright = None
            self._owner_thread = None


_runtime = BrowserRuntime()
atexit.register(_runtime.close)


def browser_runtime() -> BrowserRuntime:
    return _runtime

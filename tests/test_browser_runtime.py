from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

import seudaily.browser_runtime as browser_module


@pytest.fixture
def clean_browser_environment(monkeypatch):
    monkeypatch.delenv("SEUDAILY_BROWSER", raising=False)
    monkeypatch.delenv("CVSTREAM_BROWSER", raising=False)


@pytest.mark.parametrize(("platform", "expected"), [("win32", "msedge"), ("darwin", "webkit"), ("linux", "firefox")])
@pytest.mark.parametrize("visible", [False, True])
def test_browser_launch_uses_platform_family(monkeypatch, clean_browser_environment, platform, expected, visible):
    monkeypatch.setattr(browser_module.sys, "platform", platform)
    engines = {name: MagicMock() for name in ["chromium", "webkit", "firefox"]}
    playwright = SimpleNamespace(**engines)

    browser = browser_module.launch_browser(playwright, visible=visible)

    engine = engines["chromium" if expected == "msedge" else expected]
    assert browser is engine.launch.return_value
    engine.launch.assert_called_once()
    options = engine.launch.call_args.kwargs
    assert options["headless"] is (not visible)
    if expected == "msedge":
        assert options["channel"] == "msedge"
        assert "--disable-blink-features=AutomationControlled" in options["args"]
        assert ("--start-maximized" in options["args"]) is visible
    else:
        assert options == {"headless": not visible}
    for name, other in engines.items():
        if other is not engine:
            other.launch.assert_not_called()


@pytest.mark.parametrize(("override", "expected"), [
    ("msedge", "msedge"), ("webkit", "webkit"), (" Safari ", "webkit"),
    ("firefox", "firefox"), ("chromium", "chromium"), ("auto", "webkit"),
])
def test_browser_override_selects_engine(monkeypatch, clean_browser_environment, override, expected):
    monkeypatch.setattr(browser_module.sys, "platform", "darwin")
    monkeypatch.setenv("SEUDAILY_BROWSER", override)
    engines = {name: MagicMock() for name in ["chromium", "webkit", "firefox"]}

    browser_module.launch_browser(SimpleNamespace(**engines), visible=False)

    engine = engines["chromium" if expected == "msedge" else expected]
    options = engine.launch.call_args.kwargs
    if expected == "msedge":
        assert options["channel"] == "msedge"
    else:
        assert "channel" not in options
    assert ("args" in options) is (expected in {"msedge", "chromium"})


def test_invalid_browser_override_is_actionable(monkeypatch, clean_browser_environment):
    monkeypatch.setenv("SEUDAILY_BROWSER", "unknown")

    with pytest.raises(ValueError, match="SEUDAILY_BROWSER"):
        browser_module.selected_browser()


@pytest.mark.parametrize("visible", [False, True])
def test_browser_runtime_uses_selected_family_for_visible_and_shared_sessions(monkeypatch, clean_browser_environment, visible):
    monkeypatch.setenv("SEUDAILY_BROWSER", "firefox")
    engines = {name: MagicMock() for name in ["chromium", "webkit", "firefox"]}
    browser = engines["firefox"].launch.return_value
    context = browser.new_context.return_value
    context.pages = []
    runtime = browser_module.BrowserRuntime()
    runtime._playwright = SimpleNamespace(**engines, stop=MagicMock())
    try:
        with runtime.page("course", visible=visible, context_options={"locale": "zh-CN"}) as page:
            assert page is context.new_page.return_value
        engines["firefox"].launch.assert_called_once_with(headless=not visible)
        browser.new_context.assert_called_once_with(locale="zh-CN")
        if visible:
            context.close.assert_called_once()
            browser.close.assert_called_once()
        else:
            with runtime.page("course", visible=False, context_options={"locale": "zh-CN"}):
                pass
            engines["firefox"].launch.assert_called_once()
            browser.new_context.assert_called_once()
    finally:
        runtime.close()

"""Prepare optional dependencies at the point a capability actually uses them."""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time

from .cancellation import raise_if_cancelled
from .subprocess_utils import hidden_process_options

_install_lock = threading.RLock()
_modules = {
    "browser": ("playwright",),
    "documents": ("pypdfium2", "docx", "openpyxl", "pptx"),
    "summary": ("openai",),
    "asr": ("dashscope",),
    "media": ("cv2", "numpy", "img2pdf"),
}
_labels = {"browser": "Playwright 浏览器驱动", "documents": "文档解析", "summary": "课程摘要", "asr": "云端转写", "media": "视频幻灯片处理"}


def preparation(state: str, message: str, *, name: str = "python") -> None:
    print("SEUDAILY_PREPARATION " + json.dumps({"name": name, "state": state, "message": message}, ensure_ascii=False), file=sys.stderr, flush=True)


def run_install(command: list[str]) -> None:
    """Keep preparation cancellable and keep installer output off worker stdout."""
    raise_if_cancelled()
    process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=sys.stderr, stderr=sys.stderr, **hidden_process_options())
    deadline = time.monotonic() + 600
    try:
        while process.poll() is None:
            raise_if_cancelled()
            if time.monotonic() >= deadline:
                raise TimeoutError("依赖安装超过 10 分钟，请检查网络后重试")
            time.sleep(0.2)
        if process.returncode:
            raise subprocess.CalledProcessError(process.returncode, command)
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()


def ensure_dependencies(extra: str) -> None:
    modules = _modules[extra]
    with _install_lock:
        if all(importlib.util.find_spec(module) for module in modules):
            return
        if not os.environ.get("SEUDAILY_INSTALL_ROOT"):
            raise RuntimeError(f"需要{_labels[extra]}依赖，请执行 uv sync --extra {extra}")
        directory = os.environ.get("SEUDAILY_OPTIONAL_REQUIREMENTS_DIR")
        requirements = str(Path(directory) / f"{extra}-requirements.txt") if directory else os.environ.get("SEUDAILY_MEDIA_REQUIREMENTS") if extra == "media" else None
        uv = os.environ.get("SEUDAILY_UV_BINARY")
        if not uv or not requirements:
            raise RuntimeError("可选组件配置缺失，请重新启动 SEUdaily。")
        name = extra
        preparation("preparing", f"正在下载并安装{_labels[extra]}依赖…", name=name)
        try:
            run_install([uv, "pip", "install", "--python", sys.executable, "--require-hashes", "-r", requirements])
            importlib.invalidate_caches()
            preparation("ready", f"{_labels[extra]}依赖已就绪", name=name)
        except Exception as error:
            preparation("failed", f"{_labels[extra]}依赖安装失败：{error}", name=name)
            raise


def ensure_media_dependencies() -> None:
    if os.environ.get("SEUDAILY_INSTALL_ROOT"):
        ensure_dependencies("media")


def openai_client(*args, **kwargs):
    ensure_dependencies("summary")
    from openai import OpenAI
    return OpenAI(*args, **kwargs)

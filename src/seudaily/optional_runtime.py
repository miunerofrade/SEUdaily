"""Install media extras only when video slide extraction really needs them."""
from __future__ import annotations

import importlib.util
import os
import subprocess
import sys

from .cancellation import raise_if_cancelled
from .subprocess_utils import hidden_process_options


def ensure_media_dependencies() -> None:
    if not os.environ.get("SEUDAILY_INSTALL_ROOT"):
        return
    if all(importlib.util.find_spec(name) for name in ("cv2", "numpy", "img2pdf")):
        return
    raise_if_cancelled()
    uv = os.environ.get("SEUDAILY_UV_BINARY")
    requirements = os.environ.get("SEUDAILY_MEDIA_REQUIREMENTS")
    if not uv or not requirements:
        raise RuntimeError("媒体组件配置缺失，请重新启动 SEUdaily。")
    print("正在准备视频幻灯片处理组件…", file=sys.stderr)
    subprocess.run(
        [uv, "pip", "install", "--python", sys.executable, "--require-hashes", "-r", requirements],
        check=True, timeout=600, stdin=subprocess.DEVNULL, stdout=sys.stderr,
        **hidden_process_options(),
    )
    raise_if_cancelled()
    importlib.invalidate_caches()

"""Source checkout compatibility entry; all commands are parsed by the Node launcher."""
from __future__ import annotations

import os
from pathlib import Path
import shutil
import subprocess
import sys


def _project_root() -> Path:
    configured = os.environ.get("SEUDAILY_INSTALL_ROOT") or os.environ.get("SEUDAILY_PROJECT_ROOT")
    candidates = ([Path(configured)] if configured else []) + [Path(__file__).resolve().parents[2]]
    for root in candidates:
        if (root / "bin" / "seudaily.mjs").is_file():
            return root.resolve()
    raise RuntimeError("找不到 Node 启动入口；请使用 npm 安装的 seudaily。")


def _runtime_prefix() -> list[str]:
    """Use a compatible installed Node without changing the user's shell."""
    node = shutil.which("node")
    def supported(command: list[str]) -> bool:
        try:
            version = subprocess.check_output([*command, "--version"], text=True, stderr=subprocess.DEVNULL).strip().lstrip("v")
            major, minor, *_ = [int(part) for part in version.split(".")]
            return major == 22 and minor >= 22 or major == 24 and minor >= 12 or major > 24
        except (OSError, subprocess.CalledProcessError, ValueError):
            return False
    if node and supported([node]):
        return []
    fnm = shutil.which("fnm")
    if fnm and supported([fnm, "exec", "--using", "22", "node"]):
        return [fnm, "exec", "--using", "22"]
    raise RuntimeError("需要 Node.js 22.22+（22.x）或 24.12+；请安装或切换到兼容版本。")


def main() -> int:
    try:
        root = _project_root()
        if not (root / "dist" / "launcher.mjs").is_file():
            raise RuntimeError("请先在源码目录运行 npm ci 和 npm run build。")
        args = sys.argv[1:]
        # Source users keep their existing repository data; npm uses the system user data directory.
        if "--data-dir" not in args and not any(arg.startswith("--data-dir=") for arg in args):
            args = [*args, "--data-dir", str(root)]
        return subprocess.call([*_runtime_prefix(), "node", str(root / "bin" / "seudaily.mjs"), *args], cwd=root)
    except (RuntimeError, OSError) as error:
        print(f"SEUdaily：{error}", file=sys.stderr)
        return 1

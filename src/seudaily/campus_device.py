"""SEUdaily's opaque device identity, independent of accounts and cookie jars."""
from __future__ import annotations

import json
import os
import re
import secrets
import tempfile
from pathlib import Path

from .runtime_paths import env_value, runtime_root


def device_fingerprint() -> str:
    # PROJECT_ROOT is the launcher's resolved --data-dir, including overrides.
    root = env_value("SEUDAILY_PROJECT_ROOT") or env_value("SEUDAILY_DATA_DIR") or os.getcwd()
    path = runtime_root(root) / "campus-device.json"

    def read() -> str:
        # Do not follow a substituted identity file or silently rotate invalid IDs.
        if path.is_symlink():
            raise OSError("校园设备标识不能是符号链接")
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        with os.fdopen(fd, encoding="utf-8") as stream:
            saved = json.load(stream)
        value = saved.get("fingerprint") if isinstance(saved, dict) else None
        if not isinstance(saved, dict) or saved.get("version") != 1 or not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{32}", value):
            raise ValueError("校园设备标识文件无效")
        return value

    try:
        return read()
    except FileNotFoundError:
        pass
    value = secrets.token_hex(16)
    fd, temporary = tempfile.mkstemp(prefix=".campus-device-", dir=path.parent)
    try:
        # mkstemp creates mode 0600; publish complete data without replacing a winner.
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump({"version": 1, "fingerprint": value}, stream)
            stream.flush()
            os.fsync(stream.fileno())
        try:
            os.link(temporary, path)
        except FileExistsError:
            return read()
        return value
    finally:
        Path(temporary).unlink(missing_ok=True)

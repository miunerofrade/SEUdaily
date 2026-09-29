from __future__ import annotations

import os
import subprocess
from typing import Any


def hidden_process_options() -> dict[str, Any]:
    """Return Popen options that suppress console windows on Windows."""
    if os.name != "nt":
        return {}
    return {
        "creationflags": subprocess.CREATE_NO_WINDOW
        | subprocess.CREATE_NEW_PROCESS_GROUP,
    }

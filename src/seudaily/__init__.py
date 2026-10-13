"""SEUdaily automation services exposed to the agent layer."""

from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
import tomllib

# Editable/source checkouts use their project metadata; installed wheels use theirs.
_project = Path(__file__).resolve().parents[2] / "pyproject.toml"
if _project.is_file():
    _metadata = tomllib.loads(_project.read_text(encoding="utf-8"))["project"]
    __version__ = _metadata["version"]
else:
    try:
        __version__ = version("seudaily-core")
    except PackageNotFoundError:
        __version__ = "0+unknown"

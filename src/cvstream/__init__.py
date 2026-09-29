"""Compatibility import bridge for installations using the former package name.

New code and all packaged entry points use :mod:`seudaily`. This bridge only
redirects legacy submodule imports to the canonical package directory.
"""

from pathlib import Path

from seudaily import __version__

__path__ = [str(Path(__file__).resolve().parent.parent / "seudaily")]

__all__ = ["__version__"]

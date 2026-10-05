"""Dependency boundaries must survive imports and first-use installation."""
from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys

from seudaily import optional_runtime


def test_http_worker_imports_without_optional_packages():
    source = str(Path(__file__).resolve().parents[1] / "src")
    code = '''
import importlib.abc, sys
class NoOptional(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname.split('.')[0] in {'playwright','openai','dashscope','docx','pptx','openpyxl','pypdfium2','cv2','numpy','img2pdf'}:
            raise AssertionError('HTTP worker imported optional dependency: ' + fullname)
sys.meta_path.insert(0, NoOptional())
from seudaily.cli import dispatch
assert dispatch({'action': 'health', 'payload': {}})['version']
assert dispatch({'action': 'vpn-status', 'payload': {}})['data']['state'] == 'disconnected'
'''
    import tempfile
    with tempfile.TemporaryDirectory() as directory:
        subprocess.run([sys.executable, "-c", code], env={**os.environ, "PYTHONPATH": source, "SEUDAILY_PROJECT_ROOT": directory}, cwd=directory, check=True)


def test_document_preparation_installs_only_its_group_once(monkeypatch, tmp_path):
    installed = False
    commands = []
    monkeypatch.setenv("SEUDAILY_INSTALL_ROOT", str(tmp_path))
    monkeypatch.setenv("SEUDAILY_OPTIONAL_REQUIREMENTS_DIR", str(tmp_path))
    monkeypatch.setenv("SEUDAILY_UV_BINARY", "uv")
    monkeypatch.setattr(optional_runtime.importlib.util, "find_spec", lambda _: object() if installed else None)
    def install(command):
        nonlocal installed
        commands.append(command)
        installed = True
    monkeypatch.setattr(optional_runtime, "run_install", install)
    optional_runtime.ensure_dependencies("documents")
    optional_runtime.ensure_dependencies("documents")
    assert len(commands) == 1
    assert commands[0][-1] == str(tmp_path / "documents-requirements.txt")
    assert "--require-hashes" in commands[0]

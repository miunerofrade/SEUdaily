import sys
from pathlib import Path
import pytest
from seudaily import launcher


def test_source_launcher_forwards_unified_arguments_and_preserves_data(monkeypatch, tmp_path):
    (tmp_path / "dist").mkdir(); (tmp_path / "dist/launcher.mjs").touch()
    monkeypatch.setattr(launcher, "_project_root", lambda: tmp_path)
    monkeypatch.setattr(launcher, "_runtime_prefix", lambda: [])
    monkeypatch.setattr(sys, "argv", ["seudaily", "web", "--port", "5000"])
    calls = []
    monkeypatch.setattr(launcher.subprocess, "call", lambda command, **kw: calls.append((command, kw)) or 0)
    assert launcher.main() == 0
    assert calls[0][0][-5:] == ["web", "--port", "5000", "--data-dir", str(tmp_path)]


def test_source_launcher_respects_explicit_data_directory(monkeypatch, tmp_path):
    (tmp_path / "dist").mkdir(); (tmp_path / "dist/launcher.mjs").touch()
    monkeypatch.setattr(launcher, "_project_root", lambda: tmp_path)
    monkeypatch.setattr(launcher, "_runtime_prefix", lambda: [])
    monkeypatch.setattr(sys, "argv", ["seudaily", "chat", "--data-dir=/tmp/custom"])
    calls = []
    monkeypatch.setattr(launcher.subprocess, "call", lambda command, **kw: calls.append(command) or 0)
    assert launcher.main() == 0
    assert calls[0][-2:] == ["chat", "--data-dir=/tmp/custom"]


def test_source_launcher_missing_build_does_not_start_backend(monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(launcher, "_project_root", lambda: tmp_path)
    monkeypatch.setattr(launcher.subprocess, "call", lambda *a, **kw: pytest.fail("must not start"))
    assert launcher.main() == 1
    assert "npm run build" in capsys.readouterr().err


def test_standalone_vpn_missing_credentials_never_starts_core(monkeypatch):
    from seudaily import vpn
    monkeypatch.setattr(vpn, 'env_value', lambda *_: '')
    monkeypatch.setattr(vpn, 'manager', lambda: pytest.fail('VPN must not start without credentials'))
    with pytest.raises(RuntimeError, match='缺少校园账号或密码'):
        vpn.run_standalone(12081)


def test_standalone_vpn_interrupt_stops_owned_core(monkeypatch):
    from unittest.mock import MagicMock
    from seudaily import vpn
    monkeypatch.setattr(vpn, 'env_value', lambda *_: 'test-credential')
    monkeypatch.setattr(vpn, 'campus_proxy', lambda: None)
    monkeypatch.setattr(vpn.socket, 'socket', MagicMock())
    owned = MagicMock()
    owned.status.side_effect = KeyboardInterrupt
    monkeypatch.setattr(vpn, 'manager', lambda: owned)
    assert vpn.run_standalone(12081) == 130
    owned.connect.assert_called_once_with(12081)
    owned.disconnect.assert_called_once()

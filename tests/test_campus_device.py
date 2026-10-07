import json
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

import pytest

from seudaily.campus_device import device_fingerprint


def test_identity_is_atomic_private_and_shared_after_restart(tmp_path, monkeypatch):
    monkeypatch.setenv("SEUDAILY_PROJECT_ROOT", str(tmp_path))
    # The resolved launcher path wins over an unselected environment data dir.
    monkeypatch.setenv("SEUDAILY_DATA_DIR", str(tmp_path / "other"))
    with ThreadPoolExecutor(max_workers=8) as executor:
        values = list(executor.map(lambda _: device_fingerprint(), range(16)))
    assert len(set(values)) == 1
    path = tmp_path / ".seudaily/campus-device.json"
    assert json.loads(path.read_text())["fingerprint"] == values[0]
    if os.name != "nt":
        assert path.stat().st_mode & 0o777 == 0o600
    restarted = subprocess.check_output(
        [sys.executable, "-c", "from seudaily.campus_device import device_fingerprint; print(device_fingerprint())"],
        text=True,
    ).strip()
    assert restarted == values[0]
    assert not list(path.parent.glob(".campus-device-*"))
    assert not (tmp_path / "other").exists()


@pytest.mark.parametrize("contents", ['[]', '{"version":1,"fingerprint":"invalid"}', 'broken'])
def test_invalid_identity_is_preserved(tmp_path, monkeypatch, contents):
    monkeypatch.setenv("SEUDAILY_PROJECT_ROOT", str(tmp_path))
    path = tmp_path / ".seudaily/campus-device.json"
    path.parent.mkdir()
    path.write_text(contents)
    with pytest.raises(ValueError):
        device_fingerprint()
    assert path.read_text() == contents


def test_identity_does_not_follow_symlink(tmp_path, monkeypatch):
    if not hasattr(os, "O_NOFOLLOW"):
        pytest.skip("OS does not support O_NOFOLLOW")
    monkeypatch.setenv("SEUDAILY_PROJECT_ROOT", str(tmp_path))
    target = tmp_path / "outside.json"
    target.write_text('{"version":1,"fingerprint":"' + 'a' * 32 + '"}')
    path = tmp_path / ".seudaily/campus-device.json"
    path.parent.mkdir()
    path.symlink_to(target)
    with pytest.raises(OSError):
        device_fingerprint()

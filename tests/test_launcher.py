import os
import signal
import subprocess
import sys
import time
from types import SimpleNamespace

import pytest

from seudaily import launcher


@pytest.mark.skipif(os.name == "nt", reason="POSIX process group shutdown")
def test_stop_waits_for_and_cleans_children_after_session_leader_exits(monkeypatch):
    child_code = "import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); print('ready',flush=True); time.sleep(60)"
    parent_code = (
        "import subprocess,sys,time; "
        f"child=subprocess.Popen([sys.executable,'-c',{child_code!r}],stdout=subprocess.PIPE,text=True); "
        "child.stdout.readline(); print(child.pid,flush=True); time.sleep(60)"
    )
    process = subprocess.Popen([sys.executable, "-c", parent_code], start_new_session=True, stdout=subprocess.PIPE, text=True)
    try:
        child_pid = int(process.stdout.readline())
        # Accelerate only the launcher's grace period; subprocess still uses real time.
        monkeypatch.setattr(launcher, "time", SimpleNamespace(monotonic=lambda: time.monotonic() * 100, sleep=time.sleep))
        launcher._stop(process)
        assert process.poll() is not None
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            status = subprocess.run(["ps", "-o", "stat=", "-p", str(child_pid)], capture_output=True, text=True).stdout.strip()
            if not status or status.startswith("Z"):
                break
            time.sleep(0.05)
        else:
            pytest.fail("Child survived shutdown after its parent exited")
    finally:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait(timeout=2)

@pytest.mark.parametrize('argv',[['seudaily','-h'],['seudaily','-V'],['seudaily','chat','--help']])
def test_help_version_no_backend_or_node(monkeypatch,argv):
    def blocked(*args,**kwargs):raise AssertionError('runtime initialized for help')
    monkeypatch.setattr(sys,'argv',argv)
    monkeypatch.setattr(launcher,'_project_root',blocked)
    monkeypatch.setattr(launcher,'_runtime_prefix',blocked)
    monkeypatch.setattr(launcher,'backend_session',blocked)
    with pytest.raises(SystemExit) as result:launcher.main()
    assert result.value.code==0

@pytest.mark.skipif(os.name == "nt", reason="POSIX process groups")
@pytest.mark.parametrize("stage", ["term", "probe", "kill"])
def test_stop_group_permission_errors_preserve_normal_exit(monkeypatch, stage):
    from unittest.mock import Mock
    process = Mock(pid=43210)
    process.poll.return_value = 0
    def killpg(pid, sig):
        assert pid == process.pid
        if sig == {"term": signal.SIGTERM, "probe": 0, "kill": signal.SIGKILL}[stage]:
            raise PermissionError(1, "Operation not permitted")
    monkeypatch.setattr(os, "killpg", killpg)
    ticks = iter([0, 10])
    monkeypatch.setattr(launcher, "time", SimpleNamespace(monotonic=lambda: next(ticks), sleep=lambda _: None))
    if stage == "probe":
        monkeypatch.setattr(launcher, "time", SimpleNamespace(monotonic=lambda: 0, sleep=lambda _: None))
    launcher._stop(process)
    process.terminate.assert_not_called()
    process.kill.assert_not_called()

@pytest.mark.skipif(os.name == "nt", reason="POSIX process groups")
def test_stop_permission_denied_falls_back_to_owned_leader(monkeypatch):
    from unittest.mock import Mock
    process = Mock(pid=43210)
    process.poll.return_value = None
    monkeypatch.setattr(os, "killpg", Mock(side_effect=PermissionError(1, "denied")))
    launcher._stop(process)
    process.terminate.assert_called_once()
    process.wait.assert_called_once_with(timeout=5)

@pytest.mark.skipif(os.name == "nt", reason="POSIX process groups")
def test_backend_cleanup_does_not_replace_successful_cli_exit(monkeypatch, tmp_path):
    from unittest.mock import Mock
    process = Mock(pid=43210)
    process.poll.return_value = 0
    monkeypatch.setattr(launcher, "_port_open", lambda _: False)
    monkeypatch.setattr(launcher, "_backend_ready", lambda: True)
    monkeypatch.setattr(launcher, "_runtime_prefix", lambda: [])
    monkeypatch.setattr(launcher, "_npm_executable", lambda: "npm")
    monkeypatch.setattr(launcher, "runtime_root", lambda _: tmp_path)
    monkeypatch.setattr(launcher, "_spawn", lambda *args: process)
    def killpg(pid, sig):
        if sig == 0: raise PermissionError(1, "Operation not permitted")
    monkeypatch.setattr(os, "killpg", killpg)
    with pytest.raises(SystemExit) as result:
        with launcher.backend_session(tmp_path):
            raise SystemExit(0)
    assert result.value.code == 0

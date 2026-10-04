import os
import signal
import subprocess
import sys
import time
from types import SimpleNamespace

import pytest

from seudaily import launcher


def test_vpn_option_accepts_port_without_chat():
    args = launcher.build_parser().parse_args(['--vpn', '12081'])
    assert args.vpn == 12081
    assert args.command is None


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


def test_existing_backend_is_reused_and_never_stopped(monkeypatch, tmp_path):
    from unittest.mock import Mock
    response = Mock()
    response.__enter__ = Mock(return_value=response)
    response.__exit__ = Mock(return_value=False)
    response.read.return_value = b'{"name":"SEUdaily","runtime":"agent"}'
    monkeypatch.setattr(launcher, '_port_open', lambda port: True)
    monkeypatch.setattr(launcher, '_backend_ready', lambda: True)
    monkeypatch.setattr(launcher, 'urlopen', lambda *args, **kwargs: response)
    spawn, stop = Mock(), Mock()
    monkeypatch.setattr(launcher, '_spawn', spawn)
    monkeypatch.setattr(launcher, '_stop', stop)
    with launcher.backend_session(tmp_path):
        pass
    spawn.assert_not_called()
    stop.assert_not_called()


def test_web_starts_only_frontend_and_uses_shared_backend_session(monkeypatch, tmp_path):
    from contextlib import contextmanager
    from unittest.mock import Mock
    events = []
    @contextmanager
    def backend(root, **kwargs):
        events.append('backend-enter')
        try:
            yield
        finally:
            events.append('backend-exit')
    process = Mock()
    process.poll.side_effect = [None]
    monkeypatch.setattr(launcher, '_port_open', lambda port: False)
    monkeypatch.setattr(launcher, '_project_root', lambda: tmp_path)
    monkeypatch.setattr(launcher, 'runtime_root', lambda root: tmp_path)
    monkeypatch.setattr(launcher, '_npm_executable', lambda: 'npm')
    monkeypatch.setattr(launcher, '_runtime_prefix', lambda: [])
    monkeypatch.setattr(launcher, 'backend_session', backend)
    spawn = Mock(return_value=process)
    stop = Mock(side_effect=lambda p: events.append('web-stop'))
    monkeypatch.setattr(launcher, '_spawn', spawn)
    monkeypatch.setattr(launcher, '_stop', stop)
    monkeypatch.setattr(launcher, '_wait_until_ready', lambda processes: None)
    monkeypatch.setattr(launcher.time, 'sleep', Mock(side_effect=KeyboardInterrupt))
    assert launcher.start() == 0
    assert spawn.call_count == 1
    assert spawn.call_args.args[0] == ['npm', 'run', 'dev:web']
    assert events == ['backend-enter', 'web-stop', 'backend-exit']

@pytest.mark.parametrize('owner_exits_first', [True, False])
def test_shared_backend_stops_only_after_last_interface(monkeypatch, tmp_path, owner_exits_first):
    from unittest.mock import Mock
    process = Mock(pid=43210)
    monkeypatch.setattr(launcher, '_port_open', Mock(side_effect=[False, True]))
    monkeypatch.setattr(launcher, '_backend_ready', lambda: True)
    monkeypatch.setattr(launcher, '_runtime_prefix', lambda: [])
    monkeypatch.setattr(launcher, 'runtime_root', lambda _: tmp_path)
    monkeypatch.setattr(launcher, '_spawn', lambda *args: process)
    monkeypatch.setattr(launcher, '_backend_identity', lambda: {'name':'SEUdaily','runtime':'agent','processId':43210})
    stop = Mock()
    monkeypatch.setattr(launcher, '_stop', stop)
    owner = launcher.backend_session(tmp_path)
    borrower = launcher.backend_session(tmp_path)
    owner.__enter__(); borrower.__enter__()
    first, last = (owner, borrower) if owner_exits_first else (borrower, owner)
    first.__exit__(None, None, None)
    stop.assert_not_called()
    last.__exit__(None, None, None)
    assert stop.call_count == 1
    assert stop.call_args.args[0].pid == process.pid
    assert not (tmp_path / 'backend-clients' / 'managed.json').exists()

@pytest.mark.skipif(os.name == 'nt', reason='POSIX live process test')
def test_shared_backend_survives_owner_exit_across_processes(monkeypatch, tmp_path):
    import multiprocessing
    import socket
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        port = probe.getsockname()[1]
    monkeypatch.setattr(launcher, 'BACKEND_PORT', port)
    monkeypatch.setattr(launcher, 'runtime_root', lambda _: tmp_path)
    monkeypatch.setattr(launcher, '_runtime_prefix', lambda: [])
    spawn = launcher._spawn
    code = f'''import os,json
from http.server import BaseHTTPRequestHandler, HTTPServer
class Handler(BaseHTTPRequestHandler):
 def do_GET(self):
  self.send_response(200); self.end_headers()
  self.wfile.write(json.dumps(dict(name='SEUdaily',runtime='agent',processId=os.getpid())).encode())
 def log_message(self,*args): pass
HTTPServer(('127.0.0.1',{port}),Handler).serve_forever()
'''
    monkeypatch.setattr(launcher, '_spawn', lambda command, root, log: spawn([sys.executable, '-c', code], root, log))
    ctx = multiprocessing.get_context('fork')
    def interface(pipe):
        with launcher.backend_session(tmp_path):
            pipe.send('ready')
            pipe.recv()
        pipe.send('done')
    processes = []
    try:
        for _ in range(2):
            parent, child = ctx.Pipe()
            process = ctx.Process(target=interface, args=(child,))
            process.start(); child.close()
            processes.append((process, parent))
            assert parent.poll(10) and parent.recv() == 'ready'
        owner, owner_pipe = processes[0]
        owner_pipe.send('exit')
        assert owner_pipe.poll(10) and owner_pipe.recv() == 'done'
        owner.join(5); assert owner.exitcode == 0
        assert launcher._backend_ready()
        borrower, borrower_pipe = processes[1]
        borrower_pipe.send('exit')
        assert borrower_pipe.poll(10) and borrower_pipe.recv() == 'done'
        borrower.join(5); assert borrower.exitcode == 0
        assert not launcher._port_open(port)
    finally:
        for process, pipe in processes:
            if process.is_alive(): process.terminate()
            process.join(5); pipe.close()
        if launcher._port_open(port):
            launcher._stop(launcher._SharedBackendProcess(launcher._backend_identity()['processId']))

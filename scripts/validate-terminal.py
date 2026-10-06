"""Fixed Node build validation using actual App/Session and local fixtures.
Run node scripts/build-fixtures.mjs, then this script. POSIX PTY only.
"""
from __future__ import annotations
import argparse
import base64
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import shutil
import signal
import statistics
import struct
import subprocess
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'build/validation'
NODE = shutil.which('node')
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=')


def fixture(path: Path):
    (path / 'package.json').write_text('{"type":"module"}')
    (path / 'pyproject.toml').write_text('')
    (path / '.agent/skills').mkdir(parents=True)
    (path / '截图 with spaces.png').write_bytes(PNG)


def environment(path: Path):
    env = {key: value for key, value in os.environ.items()
           if not key.startswith(('SEUDAILY_', 'CVSTREAM_', 'DEEPSEEK_', 'NODE_', 'PROBE_'))}
    env.update(SEUDAILY_PROJECT_ROOT=str(path), TERM='xterm-256color', TERM_PROGRAM='Apple_Terminal',
               NODE_ENV='production', DEV='false', FORCE_COLOR='1')
    env.pop('NO_COLOR', None)
    env.pop('CI', None)
    return env


def command(path: Path, mode: str, installation: Path | None = None):
    if installation is not None: return [NODE, str(installation / 'node/core.mjs'), mode]
    shutil.copytree(OUTPUT / 'node', path / 'node')
    return [NODE, str(path / 'node/core.mjs'), mode]


def core(mode='core'):
    with tempfile.TemporaryDirectory(prefix='seudaily-build-detached-') as directory:
        path = Path(directory); fixture(path); env = environment(path)
        if mode == 'python':
            # Reuse the existing optional Python environment, without involving uv resolution.
            # This shim isolates bridge compatibility from future Python distribution work.
            shim = path / 'uv'
            shim.write_text('#!/bin/sh\nexec ' + repr(str(ROOT / '.venv/bin/seudaily-worker')) + '\n')
            shim.chmod(0o700)
            env['PATH'] = str(path) + os.pathsep + env['PATH']
        started = time.perf_counter()
        proc = subprocess.run(command(path, mode), cwd=path, env=env,
                              capture_output=True, text=True, timeout=30)
        elapsed = (time.perf_counter() - started) * 1000
        if proc.returncode: raise RuntimeError(f'Node/{mode}: {proc.stderr}\n{proc.stdout}')
        data = json.loads(proc.stdout.strip().splitlines()[-1])
        return dict(checks=data, elapsed_ms=round(elapsed, 2))


def terminal(exit_method='ctrl-d', installation: Path | None = None):
    with tempfile.TemporaryDirectory(prefix='seudaily-build-terminal-') as directory:
        path = Path(directory); fixture(path); env = environment(path)
        if installation is not None: env['PROBE_COMPONENT'] = str(installation / 'terminal.mjs')
        else:
            shutil.copy2(OUTPUT / 'terminal.mjs', path / 'terminal.mjs')
            env['PROBE_COMPONENT'] = str(path / 'terminal.mjs')
        cmd = command(path, 'cli', installation)
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 32, 100, 0, 0))
        initial_flags = termios.tcgetattr(master)[3]
        started = time.perf_counter()
        proc = subprocess.Popen(cmd, stdin=slave, stdout=slave, stderr=slave, cwd=path, env=env, start_new_session=True)
        os.close(slave)
        output = bytearray()

        def pump(seconds):
            end = time.monotonic() + seconds
            while time.monotonic() < end:
                if select.select([master], [], [], .01)[0]:
                    try: output.extend(os.read(master, 262144))
                    except OSError: break

        def send(value, wait=.15):
            os.write(master, value.encode() if isinstance(value, str) else value); pump(wait)
            if wait >= .35:
                deadline = time.monotonic() + 5
                state = path / 'session-busy'
                while state.exists() and time.monotonic() < deadline and proc.poll() is None:
                    pump(.025)

        def records():
            file = path / 'requests.jsonl'
            return [json.loads(line) for line in file.read_text().splitlines()] if file.exists() else []

        try:
            deadline = time.monotonic() + 15
            while b'fixture-model' not in output and time.monotonic() < deadline and proc.poll() is None: pump(.01)
            assert b'fixture-model' in output, output.decode(errors='replace')[-5000:]
            first_screen = (time.perf_counter() - started) * 1000
            while not (path / 'ready').exists() and proc.poll() is None: pump(.01)
            rss = json.loads((path / 'ready').read_text())['rss']
            send('/vpn')
            send(b'\r', .35)
            assert any(r.get('vpn') == {'action': 'connect'} for r in records()), '/vpn must connect without overriding the saved port'
            assert '正在创建 Python 虚拟环境' not in output.decode() and '正在安装 Firefox 浏览器' not in output.decode(), 'completed preparation history must not replay in the terminal'
            send('/vpn connect 11081')
            send(b'\r', .35)
            assert any(r.get('vpn') == {'action': 'connect', 'port': 11081} for r in records()), 'Enter must submit a completed VPN command'
            send('/resume'); send(b'\r', .35)
            send(b'\x1b[3~'); send(b'\x1b[B'); send(b'\r', .35)
            assert any(r.get('deleted') for r in records()), 'session picker must delete the selected conversation'
            send('/resume'); send(b'\r', .35); send(b'\x1b', .15)
            assert '当前任务正在运行' not in output.decode(), 'deletion must not leave the session busy'
            history = json.loads((path / '.seudaily/cli-history').read_text())
            assert 'y' not in history, 'confirmation must not leak into prompt history'
            send('中文输入\r')
            assert not [r for r in records() if 'messages' in r], 'IME commit must stay in draft'
            send(b'\r', .35)
            assert records()[-1]['messages'] == '中文输入'
            assert '回答完成' in output.decode(), 'streamed answer missing'
            send('LF 提交'); send(b'\n', .35)
            assert records()[-1]['messages'] == 'LF 提交'
            send('连续 Enter'); send(b'\r\r', .35)
            assert records()[-1]['messages'] == '连续 Enter'
            paste = '\x1b[200~' + json.dumps(str(path / '截图 with spaces.png'), ensure_ascii=False) + '\x1b[201~'
            send(paste, .3)
            assert any(r.get('uploaded') for r in records())
            send(b'\x7f')
            send('删除附件后发送'); send(b'\r', .35)
            assert records()[-1]['messages'] == '删除附件后发送', 'Backspace must remove file reference'
            send(paste, .3); send('描述图片'); send(b'\r', .35)
            message = records()[-1]['messages'][0]['content']
            assert message[0]['text'] == '描述图片'
            assert message[1]['data'] == 'seudaily-image-ref:fixture.png'
            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 70, 0, 0))
            os.killpg(proc.pid, signal.SIGWINCH); pump(.2)
            send('cancel-fixture'); send(b'\r', .2)
            send(paste, .3); send('排队消息'); send(b'\r', .2)
            queued = [r['queued'] for r in records() if 'queued' in r][-1]
            assert queued['text'] == '排队消息' and queued['images'][0]['ref'] == 'fixture.png'
            send(b'\x1b[A', .2)
            assert any(r.get('taken') == '排队消息' for r in records()), 'Up must take queued draft out of the queue'
            send(b'\x7f'); send(b'\r', .2)
            queued = [r['queued'] for r in records() if 'queued' in r][-1]
            assert queued['text'] == '排队消息' and queued['images'] == [], 'restored attachment must support Backspace deletion'
            send(b'\x03', .2)
            deadline = time.monotonic() + 5
            while not any(r.get('cancelled') for r in records()) and time.monotonic() < deadline and proc.poll() is None:
                pump(.025)
            assert any(r.get('cancelled') for r in records()), 'Ctrl+C must cancel current stream: ' + repr(records()) + output.decode(errors='replace')[-4000:]
            assert proc.poll() is None, 'short Ctrl+C must keep the app open'
            if exit_method == 'ctrl-d': send(b'\x04', .2)
            else:
                pump(.9)
                for _ in range(12):
                    if (path / 'clean-exit').exists() or proc.poll() is not None: break
                    send(b'\x03', .1)
            assert proc.wait(timeout=5) == 0
            pump(.05)
            assert (path / 'clean-exit').exists()
            assert b'\x1b[?1049l' in output, 'alternate screen must be restored'
            final_flags = termios.tcgetattr(master)[3]
            mask = termios.ECHO | termios.ICANON
            assert final_flags & mask == initial_flags & mask, 'raw mode must be restored'
            return dict(first_screen_ms=round(first_screen, 2), rss_bytes=rss,
                        checks=dict(chineseCommit=True, imagePaste=True, backspace=True, stream=True,
                                    resize=True, cancel=True, exit=exit_method, terminalRestored=True))
        finally:
            if proc.poll() is None:
                os.killpg(proc.pid, signal.SIGKILL); proc.wait(timeout=5)
            os.close(master)


def browser():
    with tempfile.TemporaryDirectory(prefix='seudaily-browser-fixture-') as directory:
        path = Path(directory); fixture(path); env = environment(path)
        cmd = command(path, 'browser')
        shutil.copy2(OUTPUT / 'browser.mjs', path / 'browser.mjs')
        shutil.copy2(OUTPUT / 'browser-client.mjs', path / 'browser-client.mjs')
        shutil.copytree(ROOT / 'node_modules/playwright-core', path / 'node_modules/playwright-core')
        config = path / 'browser.json'
        engine = 'webkit' if os.uname().sysname == 'Darwin' else 'firefox'
        config.write_text(json.dumps({'browser': {'browserName': engine, 'launchOptions': {'headless': True}}}))
        env.update(PROBE_CLIENT=str(path / 'browser-client.mjs'), PROBE_CHILD_COMMAND=json.dumps([NODE, str(path / 'browser.mjs'), str(config)]))
        proc = subprocess.run(cmd, cwd=path, env=env, capture_output=True, text=True, timeout=60)
        if proc.returncode: raise RuntimeError(f'Node/browser: {proc.stderr}\n{proc.stdout}')
        return json.loads(proc.stdout.strip().splitlines()[-1])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--repeats', type=int, default=1)
    parser.add_argument('--browser-only', action='store_true')
    parser.add_argument('--python', action='store_true')
    args = parser.parse_args()
    if args.repeats < 1: parser.error('--repeats must be positive')
    if args.browser_only: report = {'browser': browser()}
    else:
        runs = [terminal() for _ in range(args.repeats)]
        report = {'core': core(), 'terminal': runs, 'held_exit': terminal('held-ctrl-c'),
                  'median_first_screen_ms': statistics.median(run['first_screen_ms'] for run in runs)}
        if args.python: report['python'] = core('python')
    (OUTPUT / ('browser-result.json' if args.browser_only else 'result.json')).write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps(report, ensure_ascii=False), flush=True)


if __name__ == '__main__': main()

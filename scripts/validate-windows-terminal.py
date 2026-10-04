"""Windows counterpart to the POSIX PTY fixture, using a real ConPTY.
Only pywinpty is added to the CI test environment; it is not a product dependency.
"""
import base64
import argparse
import json
import os
from pathlib import Path
import select
import shutil
import subprocess
import sys
import tempfile
import time
from winpty import PtyProcess

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'build/validation'
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=')


def terminal(exit_method):
    with tempfile.TemporaryDirectory(prefix='seudaily-conpty-') as directory:
        path = Path(directory)
        (path / 'package.json').write_text('{"type":"module"}')
        (path / 'pyproject.toml').touch()
        (path / '.agent/skills').mkdir(parents=True)
        image = path / '截图 with spaces.png'
        image.write_bytes(PNG)
        env = {key: value for key, value in os.environ.items() if not key.startswith(('SEUDAILY_', 'CVSTREAM_', 'DEEPSEEK_', 'NODE_', 'PROBE_'))}
        env.update(SEUDAILY_PROJECT_ROOT=str(path), PROBE_COMPONENT=str(OUTPUT / 'terminal.mjs'), NODE_ENV='production', TERM='xterm-256color', FORCE_COLOR='1')
        env.pop('CI', None)
        env.pop('NO_COLOR', None)
        proc = PtyProcess.spawn([shutil.which('node'), str(OUTPUT / 'node/core.mjs'), 'cli'], cwd=directory, env=env, dimensions=(32, 100), backend=1)
        output = ''

        def pump(seconds):
            nonlocal output
            end = time.monotonic() + seconds
            while time.monotonic() < end:
                if select.select([proc.fileobj], [], [], .02)[0]:
                    try: output += proc.read(262144)
                    except EOFError: break

        def wait_for(check, timeout=15):
            end = time.monotonic() + timeout
            while not check() and time.monotonic() < end: pump(.05)
            assert check(), json.dumps(records(), ensure_ascii=False) + '\n' + output[-1200:]

        def send(text, pause=.15):
            proc.write(text)
            pump(pause)

        def records():
            file = path / 'requests.jsonl'
            return [json.loads(line) for line in file.read_text(encoding='utf-8').splitlines()] if file.exists() else []

        try:
            wait_for(lambda: 'fixture-model' in output and (path / 'ready').exists())
            pump(.5)
            send('中文输入\r')
            assert not [item for item in records() if 'messages' in item], 'IME commit must remain in draft'
            send('\r', .5)
            wait_for(lambda: any(item.get('messages') == '中文输入' for item in records()))
            wait_for(lambda: '回答完成' in output)
            paste = '\x1b[200~' + json.dumps(str(image), ensure_ascii=False) + '\x1b[201~'
            send(paste, .5)
            wait_for(lambda: any(item.get('uploaded') for item in records()))
            send('\x7f')
            send('删除附件后发送'); send('\r', .5)
            wait_for(lambda: any(item.get('messages') == '删除附件后发送' for item in records()))
            send(paste, .5); send('描述图片'); send('\r', .5)
            wait_for(lambda: any(isinstance(item.get('messages'), list) for item in records()))
            content = [item for item in records() if isinstance(item.get('messages'), list)][-1]['messages'][0]['content']
            assert content[0]['text'] == '描述图片'
            assert content[1]['data'] == 'seudaily-image-ref:fixture.png'
            proc.setwinsize(24, 80); pump(.2)
            send('cancel-fixture'); send('\r', .3); send('\x03', .3)
            wait_for(lambda: records()[-1].get('cancelled'))
            assert proc.isalive(), 'short Ctrl+C must keep the app open'
            if exit_method == 'ctrl-d': send('\x04')
            else:
                pump(.9)
                for _ in range(12):
                    if (path / 'clean-exit').exists() or not proc.isalive(): break
                    send('\x03', .1)
            wait_for(lambda: not proc.isalive())
            assert proc.exitstatus == 0
            assert (path / 'clean-exit').exists()
            assert (path / 'screen-restore-emitted').exists(), 'alternate screen exit must be emitted'
            assert (path / 'input-restored').read_text() == 'true', 'raw input mode must be restored'
            return {'chineseCommit': True, 'imagePaste': True, 'backspace': True, 'cancel': True, 'resize': True, 'exit': exit_method, 'restoreSequenceEmitted': True, 'rawInputRestored': True}
        finally:
            proc.close(force=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--case', choices=['ctrl-d', 'held-ctrl-c'])
    args = parser.parse_args()
    if args.case:
        print(json.dumps(terminal(args.case), ensure_ascii=False))
        sys.exit(0)
    # A fresh process gives each ConPTY its own native handle/thread lifecycle.
    runs = []
    for case in ['ctrl-d', 'held-ctrl-c']:
        result = subprocess.run([sys.executable, __file__, '--case', case], capture_output=True, text=True, encoding='utf-8', timeout=60)
        if result.returncode:
            raise RuntimeError(result.stderr + '\n' + result.stdout)
        runs.append(json.loads(result.stdout.strip().splitlines()[-1]))
    report = {'platform': 'win32', 'conpty': runs}
    (OUTPUT / 'conpty-result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False))

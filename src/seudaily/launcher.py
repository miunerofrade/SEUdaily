from __future__ import annotations

import argparse
from contextlib import contextmanager
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import IO, Iterator
from urllib.request import urlopen

from .runtime_paths import env_value, runtime_root
from . import __version__


BACKEND_PORT = 4111
WEB_PORT = 4173


def _project_root(directory: str | None = None) -> Path:
    configured = env_value("SEUDAILY_PROJECT_ROOT")
    if directory:
        candidate = Path(directory).expanduser().resolve()
        if (candidate / "package.json").is_file() and (candidate / "pyproject.toml").is_file():
            return candidate
        raise RuntimeError("--cwd 必须指向 SEUdaily 项目目录。")
    candidates = [Path(configured).expanduser()] if configured else []
    candidates.extend([Path.cwd(), *Path.cwd().parents, Path(__file__).resolve().parents[2]])
    for candidate in candidates:
        if (candidate / "package.json").is_file() and (candidate / "apps" / "web").is_dir():
            return candidate.resolve()
    raise RuntimeError("找不到 SEUdaily 项目目录；请在仓库内运行，或设置 SEUDAILY_PROJECT_ROOT。")


def _npm_executable() -> str:
    executable = shutil.which("npm.cmd" if os.name == "nt" else "npm")
    if not executable:
        raise RuntimeError("找不到 npm；请先安装 Node.js 22.22+（22.x）或 24.12+。")
    return executable


def _runtime_prefix() -> list[str]:
    """Use a compatible installed Node without changing the user's shell."""
    node = shutil.which("node")
    def supported(command: list[str]) -> bool:
        try:
            version = subprocess.check_output([*command, "--version"], text=True, stderr=subprocess.DEVNULL).strip().lstrip("v")
            major, minor, *_ = [int(part) for part in version.split(".")]
            return major == 22 and minor >= 22 or major == 24 and minor >= 12 or major > 24
        except (OSError, subprocess.CalledProcessError, ValueError):
            return False
    if node and supported([node]):
        return []
    fnm = shutil.which("fnm")
    if fnm and supported([fnm, "exec", "--using", "22", "node"]):
        return [fnm, "exec", "--using", "22"]
    raise RuntimeError("需要 Node.js 22.22+（22.x）或 24.12+；请安装或切换到兼容版本。")


def _port_open(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.25):
            return True
    except OSError:
        return False


def _spawn(command: list[str], root: Path, log: IO[bytes]) -> subprocess.Popen[bytes]:
    kwargs: dict[str, object] = {
        "cwd": root,
        "stdin": subprocess.DEVNULL,
        "stdout": log,
        "stderr": subprocess.STDOUT,
        "env": {**os.environ, "NO_COLOR": "1"},
    }
    if os.name == "nt":
        kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        kwargs["start_new_session"] = True
    return subprocess.Popen(command, **kwargs)  # type: ignore[arg-type]


def _stop(process: subprocess.Popen[bytes]) -> None:
    if os.name == "nt":
        if process.poll() is not None:
            return
        subprocess.run(
            ["taskkill", "/PID", str(process.pid), "/T", "/F"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
    else:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
        # npm can exit before the Agent and its MCP/worker children finish draining.
        # Wait for the whole session, so immediate restarts do not hit a live lock.
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            process.poll()  # Reap the session leader if it has exited.
            try:
                os.killpg(process.pid, 0)
            except ProcessLookupError:
                return
            time.sleep(0.05)
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            pass


def _backend_ready() -> bool:
    try:
        with urlopen(f"http://127.0.0.1:{BACKEND_PORT}/app/health", timeout=0.5) as response:
            return response.status == 200
    except OSError:
        return False


@contextmanager
def backend_session(root: Path, *, auto_start: bool = True, verbose: bool = False) -> Iterator[None]:
    """Attach to a live server; stop only a backend owned by this invocation."""
    if _port_open(BACKEND_PORT):
        try:
            with urlopen(f"http://127.0.0.1:{BACKEND_PORT}/api", timeout=2) as response:
                identity = json.load(response)
            if identity.get("name") != "SEUdaily" or identity.get("runtime") != "agent" or not _backend_ready():
                raise RuntimeError("端口 4111 上的服务不是已就绪的 SEUdaily Agent。")
        except (OSError, ValueError) as error:
            raise RuntimeError("无法连接已就绪的 SEUdaily 后端。") from error
        if verbose:
            print("连接已有 SEUdaily 后端，退出 CLI 时保持服务运行。", file=sys.stderr)
        yield
        return
    if not auto_start:
        raise RuntimeError("后端未启动；先运行 seudaily start，或去掉 --no-start。")
    log_dir = runtime_root(root) / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / "cli-backend.log"
    with log_path.open("wb") as log:
        process = _spawn([*_runtime_prefix(), _npm_executable(), "start"], root, log)
        try:
            deadline = time.monotonic() + 45
            while not _backend_ready():
                if process.poll() is not None or time.monotonic() >= deadline:
                    raise RuntimeError(f"后端启动失败，请检查 {log_path}")
                time.sleep(0.1)
            if verbose:
                print(f"CLI 后端已就绪，日志：{log_path}", file=sys.stderr)
            yield
        finally:
            _stop(process)


def _wait_until_ready(processes: list[subprocess.Popen[bytes]], timeout: float = 45) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        failed = next((process for process in processes if process.poll() is not None), None)
        if failed:
            raise RuntimeError(f"服务进程提前退出（退出码 {failed.returncode}）。")
        if _port_open(WEB_PORT) and _backend_ready():
            return
        time.sleep(0.25)
    raise RuntimeError("服务启动超时，请检查日志。")


def start() -> int:
    occupied = [str(port) for port in (BACKEND_PORT, WEB_PORT) if _port_open(port)]
    if occupied:
        raise RuntimeError(f"端口 {', '.join(occupied)} 已被占用；SEUdaily 可能已经启动。")

    root = _project_root()
    npm = _npm_executable()
    log_dir = runtime_root(root) / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    backend_path = log_dir / "backend.log"
    web_path = log_dir / "web.log"

    print("正在启动 SEUdaily…", flush=True)
    with backend_path.open("wb") as backend_log, web_path.open("wb") as web_log:
        processes: list[subprocess.Popen[bytes]] = []
        try:
            processes.append(_spawn([*_runtime_prefix(), npm, "start"], root, backend_log))
            processes.append(_spawn([*_runtime_prefix(), npm, "run", "dev:web"], root, web_log))
            _wait_until_ready(processes)
            print("\nSEUdaily 已启动")
            print(f"  Web:       http://127.0.0.1:{WEB_PORT}")
            print(f"  Agent API: http://127.0.0.1:{BACKEND_PORT}/api")
            print(f"  日志:      {log_dir}")
            print("\n按 Ctrl+C 停止。", flush=True)
            while all(process.poll() is None for process in processes):
                time.sleep(0.5)
            failed = next(process for process in processes if process.poll() is not None)
            raise RuntimeError(f"服务进程已退出（退出码 {failed.returncode}），请检查日志。")
        except KeyboardInterrupt:
            print("\n正在停止 SEUdaily…", flush=True)
            return 0
        finally:
            # Signal both services before waiting for either one's shutdown.
            if os.name != "nt":
                for process in processes:
                    try:
                        os.killpg(process.pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
            for process in processes:
                _stop(process)


def _common_options(parser: argparse.ArgumentParser, *, child: bool = False) -> None:
    def default(value):
        return argparse.SUPPRESS if child else value
    parser.add_argument("--cwd", default=default(None), help="SEUdaily 项目目录")
    parser.add_argument("-r", "--resume", nargs="?", const="choose", default=default(None), metavar="ID", help="恢复会话；省略 ID 显示会话选择列表")
    parser.add_argument("--no-start", action="store_true", default=default(False), help="只连接已有后端")
    parser.add_argument("--timeout", type=float, default=default(300), metavar="SECONDS", help="HTTP 读取超时，默认 300 秒")
    parser.add_argument("--no-color", action="store_true", default=default(False), help="禁用颜色")
    parser.add_argument("--vi", action="store_true", default=default(False), help="交互输入使用 Vi 按键")
    parser.add_argument("-v", "--verbose", action="store_true", default=default(False), help="显示连接与运行详情")
    parser.add_argument("-q", "--quiet", action="store_true", default=default(False), help="只显示回答，隐藏工具过程")
    parser.add_argument("--skill", action="append", default=default([]), metavar="NAME", help="为本轮显式加载 Skill，可重复指定")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="seudaily", description="SEUdaily：终端助手与本地 Web 工作台", allow_abbrev=False)
    parser.add_argument("-V", "--version", action="version", version=f"%(prog)s {__version__}")
    parser.add_argument("-c", "--chat", action="store_true", help="进入终端交互聊天（也可使用 chat 子命令）")
    parser.add_argument("-p", "--prompt", help="单次提问（也可使用 exec 子命令）")
    parser.add_argument("--json", action="store_true", help="单次运行输出 JSONL 事件")
    _common_options(parser)
    subparsers = parser.add_subparsers(dest="command")
    start_parser = subparsers.add_parser("start", help="同时启动 Agent 后端和 Web 前端")
    start_parser.add_argument("--cwd", default=argparse.SUPPRESS, help="SEUdaily 项目目录")
    chat_parser = subparsers.add_parser("chat", help="终端交互聊天")
    _common_options(chat_parser, child=True)
    chat_parser.add_argument("-p", "--prompt", default=argparse.SUPPRESS, help="进入 TUI 后发送的首条问题")
    exec_parser = subparsers.add_parser("exec", help="单次运行，支持管道和 JSONL")
    _common_options(exec_parser, child=True)
    exec_parser.add_argument("message", nargs="?", help="问题；省略时读取标准输入")
    exec_parser.add_argument("-p", "--prompt", default=argparse.SUPPRESS, help="单次提问")
    exec_parser.add_argument("--json", action="store_true", default=argparse.SUPPRESS, help="输出 JSONL 事件")
    for name, help_text in (("sessions", "列出历史会话"), ("skills", "列出可用 Skill")):
        _common_options(subparsers.add_parser(name, help=help_text), child=True)
    completion = subparsers.add_parser("completion", help="输出 Shell 补全脚本")
    completion.add_argument("shell", choices=("bash", "zsh", "fish", "powershell"))
    return parser


def completion_script(shell: str) -> str:
    words = "chat exec start sessions skills completion --chat --prompt --resume --cwd --no-start --timeout --no-color --vi --verbose --quiet --skill --json --help --version -c -p -r -v -q -h -V"
    if shell == "bash":
        return f'''_seudaily_complete() {{
  if [[ "${{COMP_WORDS[COMP_CWORD-1]}}" == "--cwd" ]]; then
    COMPREPLY=()
    while IFS= read -r line; do COMPREPLY+=("$line"); done < <(compgen -d -- "${{COMP_WORDS[COMP_CWORD]}}")
  else
    COMPREPLY=()
    while IFS= read -r line; do COMPREPLY+=("$line"); done < <(compgen -W '{words}' -- "${{COMP_WORDS[COMP_CWORD]}}")
  fi
}}
complete -o default -F _seudaily_complete seudaily'''
    if shell == "zsh":
        return f'''#compdef seudaily
_seudaily() {{
  local -a choices
  choices=({words})
  if [[ "$words[CURRENT-1]" == "--cwd" ]]; then _files -/; else compadd -- $choices; fi
}}
compdef _seudaily seudaily'''
    if shell == "fish":
        commands = "chat exec start sessions skills completion"
        lines = [f"complete -c seudaily -f -n '__fish_use_subcommand' -a '{commands}'"]
        lines += [f"complete -c seudaily -l {word[2:]}" for word in words.split() if word.startswith("--")]
        lines += ["complete -c seudaily -l cwd -r -a '(__fish_complete_directories)'", "complete -c seudaily -n '__fish_seen_subcommand_from completion' -a 'bash zsh fish powershell'"]
        return "\n".join(lines)
    return """Register-ArgumentCompleter -Native -CommandName seudaily -ScriptBlock {
 param($wordToComplete, $commandAst, $cursorPosition)
 foreach ($choice in '""" + words.replace(" ", "','") + """') {
   if ($choice.StartsWith($wordToComplete)) {
     [System.Management.Automation.CompletionResult]::new($choice, $choice, 'ParameterValue', $choice)
   }
 }
}"""


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8")
    parser = build_parser()
    args = parser.parse_args()
    if args.chat and args.command not in (None, "chat"):
        parser.error("--chat 不能与其他子命令一起使用")
    command = args.command or ("chat" if args.chat or not args.prompt else "exec")
    if command == "completion":
        print(completion_script(args.shell))
        return
    if args.timeout <= 0 or args.timeout != args.timeout or args.timeout == float("inf"):
        parser.error("--timeout 必须是有限正数")
    if args.quiet and args.verbose:
        parser.error("--quiet 与 --verbose 不能同时使用")
    if args.json and command != "exec":
        parser.error("--json 仅用于 exec 或 --prompt 单次运行")
    if command == "chat" and (not sys.stdin.isatty() or not sys.stdout.isatty()):
        parser.error("交互聊天需要终端；管道请使用 seudaily exec 或 -p")
    try:
        if command == "start":
            if args.cwd:
                os.environ["SEUDAILY_PROJECT_ROOT"] = str(_project_root(args.cwd))
            raise SystemExit(start())
        root = _project_root(args.cwd)
        os.environ["SEUDAILY_PROJECT_ROOT"] = str(root)
        with backend_session(root, auto_start=not args.no_start, verbose=args.verbose):
            node = shutil.which("node")
            if not node:
                raise RuntimeError("找不到 Node.js，请先安装项目要求的版本。")
            options = {**vars(args), "command": command, "cwd": str(root)}
            environment = {**os.environ, "SEUDAILY_CLI_OPTIONS": json.dumps(options, ensure_ascii=False)}
            prefix = _runtime_prefix()
            process = subprocess.Popen([*prefix, "node" if prefix else node, str(root / "node_modules/tsx/dist/cli.mjs"), str(root / "src/terminal/main.tsx")], cwd=root, env=environment)
            try:
                raise SystemExit(process.wait())
            finally:
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()
    except KeyboardInterrupt:
        raise SystemExit(130) from None
    except RuntimeError as error:
        print(f"SEUdaily：{error}", file=sys.stderr)
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()

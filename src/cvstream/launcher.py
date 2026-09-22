from __future__ import annotations

import argparse
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import IO


BACKEND_PORT = 4111
WEB_PORT = 4173


def _project_root() -> Path:
    configured = os.getenv("CVSTREAM_PROJECT_ROOT")
    candidates = [Path(configured).expanduser()] if configured else []
    candidates.extend([Path.cwd(), *Path.cwd().parents, Path(__file__).resolve().parents[2]])
    for candidate in candidates:
        if (candidate / "package.json").is_file() and (candidate / "apps" / "web").is_dir():
            return candidate.resolve()
    raise RuntimeError("找不到 SEUdaily 项目目录；请在仓库内运行，或设置 CVSTREAM_PROJECT_ROOT。")


def _npm_executable() -> str:
    executable = shutil.which("npm.cmd" if os.name == "nt" else "npm")
    if not executable:
        raise RuntimeError("找不到 npm；请先安装 Node.js 22.13 或更高版本。")
    return executable


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
    if process.poll() is not None:
        return
    if os.name == "nt":
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


def _wait_until_ready(processes: list[subprocess.Popen[bytes]], timeout: float = 45) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        failed = next((process for process in processes if process.poll() is not None), None)
        if failed:
            raise RuntimeError(f"服务进程提前退出（退出码 {failed.returncode}）。")
        if _port_open(BACKEND_PORT) and _port_open(WEB_PORT):
            return
        time.sleep(0.25)
    raise RuntimeError("服务启动超时，请检查日志。")


def start() -> int:
    occupied = [str(port) for port in (BACKEND_PORT, WEB_PORT) if _port_open(port)]
    if occupied:
        raise RuntimeError(f"端口 {', '.join(occupied)} 已被占用；SEUdaily 可能已经启动。")

    root = _project_root()
    npm = _npm_executable()
    log_dir = root / ".cvstream" / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    backend_path = log_dir / "backend.log"
    web_path = log_dir / "web.log"

    print("正在启动 SEUdaily…", flush=True)
    with backend_path.open("wb") as backend_log, web_path.open("wb") as web_log:
        processes: list[subprocess.Popen[bytes]] = []
        try:
            processes.append(_spawn([npm, "start"], root, backend_log))
            processes.append(_spawn([npm, "run", "dev:web"], root, web_log))
            _wait_until_ready(processes)
            print("\nSEUdaily 已启动")
            print(f"  Web:       http://127.0.0.1:{WEB_PORT}")
            print(f"  Studio:    http://127.0.0.1:{BACKEND_PORT}")
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
            for process in processes:
                _stop(process)


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(prog="seudaily", description="SEUdaily 本地服务启动器")
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("start", help="同时启动 Agent 后端和 Web 前端")
    args = parser.parse_args()
    try:
        if args.command == "start":
            raise SystemExit(start())
    except RuntimeError as error:
        print(f"启动失败：{error}", file=sys.stderr)
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()

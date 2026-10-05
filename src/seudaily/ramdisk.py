"""Owned, temporary RAM disks. Importing this module never mounts anything."""
from __future__ import annotations

import atexit
import ctypes
import hashlib
import io
import os
import re
import shutil
import subprocess
import sys
import tempfile
import warnings
import urllib.request
import zipfile
from pathlib import Path

from .runtime_paths import env_value


class RamDiskError(RuntimeError):
    pass


def size_bytes(size: str) -> int:
    match = re.fullmatch(r"([1-9]\d*)\s*([KMGT]?)(?:i?B)?", str(size).strip(), re.I)
    if not match:
        raise ValueError("内存盘容量必须为正整数，例如 128M、1G 或 1GiB")
    amount = int(match[1]) * 1024 ** (" KMGT".index(match[2].upper()) if match[2] else 0)
    if amount < 8 * 1024**2:
        raise ValueError("内存盘容量至少为 8MiB")
    return amount


def _run(*command: str) -> str:
    try:
        completed = subprocess.run(command, capture_output=True, text=True, timeout=60, check=True)
        return completed.stdout.strip()
    except (OSError, subprocess.TimeoutExpired, subprocess.CalledProcessError) as error:
        detail = getattr(error, "stderr", "") or str(error)
        raise RamDiskError(f"{command[0]}: {detail.strip()[:500]}") from error


def _linux_run(*command: str) -> str:
    # Never open a password prompt in the background Worker.
    if os.geteuid() != 0:
        if not shutil.which("sudo"):
            raise RamDiskError("Linux tmpfs 挂载需要 root/CAP_SYS_ADMIN 或已授权的 sudo")
        return _run("sudo", "-n", *command)
    return _run(*command)


IMDISK_VERSION = "20250206"
IMDISK_URL = f"https://downloads.sourceforge.net/project/imdisk-toolkit/{IMDISK_VERSION}/ImDiskTk.zip"
IMDISK_SHA256 = "b93eac82a86bf8913bff9c99cec30fc463d455d565baca2f5f45e4577d8ad3b9"


def _download_imdisk_installer() -> Path:
    """Provision the upstream installer only for an explicit Windows mount."""
    if sys.platform != "win32":
        raise RamDiskError("ImDisk 仅用于 Windows")
    cache = Path(env_value("SEUDAILY_PROJECT_ROOT") or os.getcwd()) / ".seudaily" / "imdisk"
    archive_path = cache / f"ImDiskTk{IMDISK_VERSION}.zip"
    cache.mkdir(parents=True, exist_ok=True)
    try:
        payload = archive_path.read_bytes() if archive_path.exists() else None
        if payload is None or hashlib.sha256(payload).hexdigest() != IMDISK_SHA256:
            with urllib.request.urlopen(IMDISK_URL, timeout=60) as response:
                payload = response.read()
            if hashlib.sha256(payload).hexdigest() != IMDISK_SHA256:
                raise RamDiskError("ImDisk 安装包校验失败，请重新启用内存盘")
            archive_path.write_bytes(payload)
        directory = cache / f"ImDiskTk{IMDISK_VERSION}"
        directory.mkdir(exist_ok=True)
        with zipfile.ZipFile(io.BytesIO(payload)) as archive:
            for name in ("files.cab", "install.bat"):
                (directory / name).write_bytes(archive.read(f"ImDiskTk{IMDISK_VERSION}/{name}"))
        return directory / "install.bat"
    except (OSError, ValueError, KeyError, zipfile.BadZipFile) as error:
        raise RamDiskError(f"无法获取 ImDisk 安装程序：{error}") from error


def check_and_install_imdisk():
    """Reuse ImDisk, or offer its installer through Windows administrator consent."""
    if sys.platform != "win32":
        return False, "ImDisk 仅用于 Windows"
    if shutil.which("imdisk"):
        return True, "驱动已就绪"
    resource = Path(__file__).resolve().parents[2] / "res"
    installers = sorted(resource.glob("ImDiskTk*.exe")) or sorted(resource.rglob("install.bat"))
    installer = installers[0] if installers else _download_imdisk_installer()
    if installer.suffix == ".bat":
        result = ctypes.windll.shell32.ShellExecuteW(None, "runas", "cmd.exe", f'/c "{installer}"', str(installer.parent), 1)
    else:
        result = ctypes.windll.shell32.ShellExecuteW(None, "runas", str(installer), "", None, 1)
    return False, "请完成 ImDisk 安装后重试" if result > 32 else f"安装请求失败：{result}"


class RamDisk:
    """Only unmount devices created by this instance; never reuse arbitrary mounts."""
    def __init__(self, size: str = "1G", *, mount_point: str | Path | None = None):
        self.capacity = size_bytes(size)
        self.path = Path(mount_point).absolute() if mount_point is not None else None
        self.device: str | None = None
        self.mounted = False
        self._created_directory = False
        self._platform = sys.platform

    def mount(self) -> Path:
        if self.mounted:
            return self.path
        if self._platform not in {"darwin", "linux"}:
            raise RamDiskError("此接口用于 macOS/Linux；Windows 使用 setup_ramdisk")
        if self.path is None:
            self.path = Path(tempfile.mkdtemp(prefix="seudaily-ramdisk-"))
            self._created_directory = True
        else:
            if self.path.is_symlink() or self.path.exists():
                raise RamDiskError("内存盘挂载位置必须是尚不存在的目录")
            self.path.mkdir(parents=True, mode=0o700)
            self._created_directory = True
        self.path = self.path.resolve()
        try:
            if self._platform == "darwin":
                output = _run("/usr/bin/hdiutil", "attach", "-nomount", f"ram://{(self.capacity + 511) // 512}")
                devices = re.findall(r"^(/dev/disk\d+)\s*$", output, re.M)
                if len(devices) != 1:
                    raise RamDiskError("hdiutil 未返回唯一的新 RAM 设备")
                self.device = devices[0]
                _run("/sbin/newfs_hfs", "-v", "SEUdailyRAM", self.device)
                _run("/usr/sbin/diskutil", "mount", "nobrowse", "-mountPoint", str(self.path), self.device)
            else:
                self.device = "tmpfs"
                _linux_run("mount", "-t", "tmpfs", "-o", f"size={self.capacity},mode=0700,uid={os.getuid()},gid={os.getgid()},nosuid,nodev,noexec", "seudaily-ramdisk", str(self.path))
            self.mounted = True
            self.path.chmod(0o700)
            atexit.register(self._exit_cleanup)
            return self.path
        except Exception:
            if self._platform == "linux" and os.path.ismount(self.path):
                self.mounted = True
            # An attached but unformatted macOS device must also be detached.
            self.unmount()
            raise

    def unmount(self) -> None:
        if self.device and self._platform == "darwin":
            _run("/usr/bin/hdiutil", "detach", self.device)
        elif self.mounted and self._platform == "linux":
            _linux_run("umount", str(self.path))
        self.device = None
        self.mounted = False
        atexit.unregister(self._exit_cleanup)
        if self._created_directory and self.path:
            self.path.rmdir()
            self._created_directory = False
            self.path = None

    def _exit_cleanup(self):
        try:
            self.unmount()
        except (RamDiskError, OSError) as error:
            warnings.warn(f"内存盘退出清理失败：{error}", RuntimeWarning)

    def __enter__(self) -> Path:
        return self.mount()

    def __exit__(self, *_args):
        self.unmount()


class TemporaryWorkspace:
    """Per-task media scratch space, with explicit RAM opt-in and disk fallback."""
    def __init__(self, *, use_ram: bool | None = None, size: str | None = None):
        self.use_ram = use_ram if use_ram is not None else (env_value("SEUDAILY_RAMDISK_ENABLED", "false") or "").lower() in {"1", "true", "yes", "on"}
        self.size = size or env_value("SEUDAILY_RAMDISK_SIZE", "1G") or "1G"
        self.ramdisk: RamDisk | None = None
        self.path: Path | None = None
        self.fallback_reason: str | None = None
        self._temporary: tempfile.TemporaryDirectory | None = None

    def open(self) -> Path:
        if self.path:
            return self.path
        task_root = os.environ.get("SEUDAILY_TASK_WORKSPACE")
        if task_root:
            # The Node task owner removes this directory after the worker exits,
            # including forced cancellation. Shared RAM disks remain service-owned.
            self._temporary = tempfile.TemporaryDirectory(prefix="media-", dir=task_root)
            self.path = Path(self._temporary.name)
            atexit.register(self.close)
            return self.path
        shared = _disks.get("R:")
        shared_path = shared.path if shared and shared.mounted else Path("R:/") if sys.platform == "win32" and Path("R:/").is_dir() else None
        if shared_path:
            try:
                self._temporary = tempfile.TemporaryDirectory(prefix="media-", dir=shared_path)
                self.path = Path(self._temporary.name)
                _leases.add(str(self.path))
            except OSError as error:
                self.fallback_reason = str(error)
                warnings.warn(f"内存盘无法写入，使用普通临时目录：{error}", RuntimeWarning)
        elif self.use_ram:
            try:
                if sys.platform == "win32":
                    # Do not trigger installers/UAC from unattended media processing.
                    if not Path("R:/").is_dir():
                        raise RamDiskError("请先通过 setup_ramdisk 创建 Windows R: 内存盘")
                    self._temporary = tempfile.TemporaryDirectory(prefix="seudaily-media-", dir="R:/")
                    self.path = Path(self._temporary.name)
                    _leases.add(str(self.path))
                else:
                    self.ramdisk = RamDisk(self.size)
                    root = self.ramdisk.mount()
                    self._temporary = tempfile.TemporaryDirectory(prefix="media-", dir=root)
                    self.path = Path(self._temporary.name)
            except (RamDiskError, ValueError, OSError) as error:
                # If rollback failed, retain ownership so callers can retry cleanup.
                if self.ramdisk and self.ramdisk.device:
                    self.ramdisk.unmount()
                self.ramdisk = None
                self.fallback_reason = str(error)
                warnings.warn(f"内存盘不可用，使用普通临时目录：{error}", RuntimeWarning)
        if self.path is None:
            self._temporary = tempfile.TemporaryDirectory(prefix="seudaily-media-")
            self.path = Path(self._temporary.name)
        atexit.register(self.close)
        return self.path

    def close(self):
        if self._temporary:
            self._temporary.cleanup()
            _leases.discard(str(self.path))
            self._temporary = None
        if self.ramdisk:
            self.ramdisk.unmount()
            self.ramdisk = None
        self.path = None
        atexit.unregister(self.close)

    def __enter__(self):
        return self.open()

    def __exit__(self, *_args):
        self.close()


_disks: dict[str, RamDisk] = {}
_leases: set[str] = set()


def setup_ramdisk(letter="R:", size="1G"):
    try:
        capacity = size_bytes(size)
        if sys.platform != "win32":
            key = str(letter)
            disk = _disks.get(key) or RamDisk(size, mount_point=None if letter == "R:" else letter)
            path = disk.mount()
            _disks[key] = disk
            return True, str(path)
        if not re.fullmatch(r"[A-Za-z]:", letter):
            raise ValueError("Windows 内存盘位置必须为盘符，例如 R:")
        ready, message = check_and_install_imdisk()
        if not ready:
            return False, message
        if Path(f"{letter}/").exists():
            return True, "已存在"
        result = ctypes.windll.shell32.ShellExecuteW(None, "runas", "imdisk", f'-a -s {capacity} -m {letter} -p "/fs:ntfs /q /y"', None, 0)
        return result > 32, "提权弹窗已发送" if result > 32 else f"挂载请求失败：{result}"
    except (RamDiskError, ValueError, OSError) as error:
        return False, str(error)


def remove_ramdisk(letter="R:"):
    try:
        if _leases:
            raise RamDiskError("内存盘正在处理媒体任务，请等待任务完成后卸载")
        if sys.platform != "win32":
            disk = _disks.get(str(letter))
            if disk:
                disk.unmount()
                del _disks[str(letter)]
            return True, "已卸载"
        if not re.fullmatch(r"[A-Za-z]:", letter):
            raise ValueError("无效盘符")
        if not shutil.which("imdisk") or not Path(f"{letter}/").exists():
            return True, "无需卸载"
        result = ctypes.windll.shell32.ShellExecuteW(None, "runas", "imdisk", f"-D -m {letter}", None, 0)
        return result > 32, "卸载请求已发送" if result > 32 else f"卸载请求失败：{result}"
    except (RamDiskError, ValueError, OSError) as error:
        return False, str(error)


def ramdisk_status() -> dict:
    disk = _disks.get("R:")
    mounted = bool(disk and disk.mounted) if sys.platform != "win32" else Path("R:/").is_dir()
    path = str(disk.path) if disk and disk.mounted else "R:/" if mounted else None
    usage = shutil.disk_usage(path) if path else None
    return {"mounted": mounted, "platform": sys.platform, "backend": "hdiutil" if sys.platform == "darwin" else "tmpfs" if sys.platform == "linux" else "imdisk", "path": path, "capacityBytes": usage.total if usage else 0, "usedBytes": usage.used if usage else 0, "availableBytes": usage.free if usage else 0, "activeTasks": len(_leases)}


def manage_ramdisk(action: str, size: str = "1G") -> dict:
    if action == "status":
        return ramdisk_status()
    ok, message = setup_ramdisk(size=size) if action == "mount" else remove_ramdisk() if action == "unmount" else (False, "未知内存盘操作")
    return {"status": "completed" if ok else "failed", "summary": message, "data": ramdisk_status()}


def reveal_ramdisk() -> dict:
    state = ramdisk_status()
    if not state["mounted"] or not state["path"]:
        raise RamDiskError("内存盘尚未挂载或已经卸载")
    path = str(Path(state["path"]).resolve(strict=True))
    if sys.platform == "darwin":
        _run("/usr/bin/open", "-R", path)
    elif sys.platform == "win32":
        os.startfile(path)
    elif sys.platform == "linux":
        if shutil.which("xdg-open"):
            _run("xdg-open", path)
        elif shutil.which("gio"):
            _run("gio", "open", path)
        else:
            raise RamDiskError("未找到桌面文件管理器，请安装 xdg-utils 或使用桌面环境的 gio")
    else:
        raise RamDiskError("当前系统暂不支持打开文件管理器")
    return {"status": "completed", "summary": "已在系统文件管理器中显示"}

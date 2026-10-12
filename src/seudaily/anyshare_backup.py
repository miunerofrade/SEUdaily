"""On-demand library snapshots. Backups stay separate from the library and RAG."""
from __future__ import annotations

import os
import tempfile
import uuid
import zipfile
from datetime import datetime
from pathlib import Path

import httpx

from .anyshare import AnyShareClient, AnyShareError, MAX_BYTES, validate_docid
from .campus_auth import CampusAuthError
from .cancellation import raise_if_cancelled
from .runtime_paths import env_value

LIBRARY_ROOTS = ("exports", ".seudaily/uploads/documents", ".seudaily/uploads/images",
                 ".seudaily/web-files/files", ".seudaily/knowledge/files", "docs/references")
EXTENSIONS = {".md", ".txt", ".pdf", ".docx", ".xlsx", ".ppt", ".pptx",
              ".mp3", ".m4a", ".wav", ".mp4", ".webm", ".png", ".jpg", ".jpeg", ".webp", ".gif"}


def selected_files(root: Path, paths: list[str]):
    if not isinstance(paths, list) or not paths or any(not isinstance(p, str) for p in paths):
        raise ValueError("请明确选择需要备份的资料库文件或目录。")
    root = root.resolve()
    allowed = [root / name for name in LIBRARY_ROOTS]
    files = {}
    for name in paths:
        target = root / name
        actual = target.resolve()
        owner = next((base for base in allowed if target == base or base in target.parents), None)
        if owner is None or not actual.is_relative_to(owner.resolve()) or not owner.resolve().is_relative_to(root) or target.is_symlink():
            raise ValueError("备份仅允许选择本地资料库文件或目录。")
        if not target.exists():
            raise ValueError("选中的资料库路径不存在。")
        for path in ([target] if target.is_file() else sorted(target.rglob("*"))):
            raise_if_cancelled()
            if path.is_symlink():
                raise ValueError("备份目录包含符号链接，请移除或选择具体原文件。")
            if not path.is_file() or path.suffix.lower() not in EXTENSIONS:
                continue
            if any(part.startswith(".") for part in path.relative_to(owner).parts):
                continue
            if not path.resolve().is_relative_to(owner.resolve()):
                raise ValueError("备份路径越出了资料库目录。")
            relative = path.relative_to(root).as_posix()
            files[relative] = path
            if len(files) > 1000:
                raise ValueError("实验版单次备份最多 1000 个文件。")
    if not files:
        raise ValueError("选择范围内没有可备份的资料文件。")
    if sum(path.stat().st_size for path in files.values()) > MAX_BYTES:
        raise ValueError("实验版单次备份原文件合计需在 100 MB 以内。")
    return files


def snapshot(root: Path, paths: list[str], directory: Path):
    files = selected_files(root, paths)
    archive = directory / ("library-" + datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:8] + ".zip")
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as output:
        for relative, path in files.items():
            raise_if_cancelled()
            output.write(path, relative)
    return archive, list(files)


def operate(payload: dict):
    if (env_value("SEUDAILY_EXPERIMENTAL_ANYSHARE") or "").lower() not in {"1", "true"}:
        raise ValueError("请先启用 SEUDAILY_EXPERIMENTAL_ANYSHARE=true。")
    root = Path(env_value("SEUDAILY_PROJECT_ROOT") or os.getcwd()).resolve()
    mode = payload.get("mode")
    if mode == "plan":
        files = selected_files(root, payload.get("paths"))
        return {"status": "completed", "message": "备份范围已列出，尚未上传。", "files": list(files),
                "totalBytes": sum(p.stat().st_size for p in files.values()), "count": len(files)}
    try:
        with AnyShareClient(root) as client:
            if mode == "browse":
                listing = client.list_directory(payload["docid"]) if payload.get("docid") else client.roots()
                items = listing if isinstance(listing, list) else listing.get("dirs", []) + listing.get("files", [])
                return {"status": "completed", "message": "东大云盘目录已读取。", "items": [
                    {key: item[key] for key in ("id", "docid", "name", "type", "size", "rev", "modified") if key in item} for item in items]}
            if mode == "backup":
                files = selected_files(root, payload.get("paths"))  # Validate before creating any remote directory.
                parent = validate_docid(payload["parentDocid"])
                with tempfile.TemporaryDirectory(prefix="seudaily-backup-") as scratch:
                    archive, names = snapshot(root, list(files), Path(scratch))
                    directory = client.backup_directory(parent)
                    uploaded = client.upload(directory, archive, archive.name)
                return {"status": "completed", "message": "资料库备份已上传至东大云盘的 SEUdaily备份 目录。",
                        "backup": uploaded, "directoryDocid": directory, "files": names, "count": len(names)}
            if mode == "download":
                docid = validate_docid(payload["docid"])
                # Only download archives recorded in our backup directory.
                parent = validate_docid(payload["parentDocid"])
                directory = client.backup_directory(parent, create=False)
                entry = next((item for item in client.list_directory(directory).get("files", []) if item["docid"] == docid), None)
                if not entry or not re_backup_name(entry["name"]):
                    raise ValueError("请选择 SEUdaily备份 目录中的资料库备份 ZIP。")
                destination = root / ".seudaily" / "anyshare" / "downloads" / entry["name"]
                if destination.exists():
                    raise ValueError("该备份已下载，请先使用现有文件。")
                size = client.download(docid, destination)
                return {"status": "completed", "message": "备份已下载，未解压或导入资料库。", "path": str(destination), "size": size}
            raise ValueError("云盘模式须为 browse、plan、backup 或 download。")
    except CampusAuthError as error:
        return error.result()
    except httpx.HTTPError as error:
        raise AnyShareError(f"云盘网络请求失败（{type(error).__name__}），请检查校园网或 VPN。") from None


def re_backup_name(name):
    import re
    return bool(re.fullmatch(r"library-\d{8}-\d{6}-[a-f0-9]{8}\.zip", name))

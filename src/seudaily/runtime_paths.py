from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
from pathlib import Path
from typing import Any

LEGACY_RUNTIME_NAME = ".cvstream"
RUNTIME_NAME = ".seudaily"
MIGRATION_MARKER = ".migration-cvstream-v1.json"


def env_value(name: str, default: str | None = None) -> str | None:
    """Read canonical SEUDAILY_* config, falling back to legacy CVSTREAM_*.

    Keep compatibility in one place so old environment names do not spread.
    """
    if not name.startswith("SEUDAILY_"):
        raise ValueError("canonical environment name must start with SEUDAILY_")
    value = os.getenv(name)
    if value is not None:
        return value
    return os.getenv("CVSTREAM_" + name.removeprefix("SEUDAILY_"), default)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def migrate_runtime_directory(project_root: str | Path) -> dict[str, Any]:
    """Idempotently migrate .cvstream into .seudaily without losing conflicts.

    New files always win. Conflicting legacy files are preserved beneath
    .seudaily/.migration-conflicts/cvstream/<relative-path>. A file is removed
    from the old tree only after its destination/archive has been committed.
    Symlinks and failed entries are left untouched and reported for recovery.
    """
    root = Path(project_root).resolve()
    legacy = root / LEGACY_RUNTIME_NAME
    current = root / RUNTIME_NAME
    current.mkdir(parents=True, exist_ok=True)
    report: dict[str, Any] = {"moved": [], "conflicts": [], "errors": [], "skipped": []}
    if not legacy.exists():
        return report
    if legacy.is_symlink():
        report["skipped"].append(".")
        (current / ".migration-status.json").write_text(
            json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        return report

    def archive_conflict(source: Path, relative: Path) -> Path:
        target = current / ".migration-conflicts" / "cvstream" / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        source_hash = _sha256(source)
        if target.exists() or target.is_symlink():
            if target.is_file() and not target.is_symlink() and _sha256(target) == source_hash:
                return target
            target = target.with_name(f"{target.name}.{source_hash[:12]}")
            while (target.exists() or target.is_symlink()) and (
                not target.is_file() or target.is_symlink() or _sha256(target) != source_hash
            ):
                target = target.with_name(f"{target.name}.1")
        if not target.exists():
            fd, temp_name = tempfile.mkstemp(prefix=".migration-", dir=target.parent)
            os.close(fd)
            temporary = Path(temp_name)
            try:
                shutil.copy2(source, temporary)
                os.replace(temporary, target)
            finally:
                temporary.unlink(missing_ok=True)
        return target

    for source in sorted(legacy.rglob("*")):
        relative = source.relative_to(legacy)
        try:
            if source.is_symlink():
                report["skipped"].append(relative.as_posix())
                continue
            if source.is_dir():
                continue
            if not source.is_file():
                report["skipped"].append(relative.as_posix())
                continue
            destination = current / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            committed = False
            if not destination.exists():
                try:
                    os.link(source, destination)
                    source.unlink()
                    committed = True
                except FileExistsError:
                    pass
                except OSError:
                    fd, temp_name = tempfile.mkstemp(prefix=".migration-", dir=destination.parent)
                    os.close(fd)
                    temporary = Path(temp_name)
                    try:
                        shutil.copy2(source, temporary)
                        try:
                            os.link(temporary, destination)
                            source.unlink()
                            committed = True
                        except FileExistsError:
                            pass
                    finally:
                        temporary.unlink(missing_ok=True)
            if committed:
                report["moved"].append(relative.as_posix())
                continue
            if destination.is_file() and not destination.is_symlink() and _sha256(destination) == _sha256(source):
                source.unlink()
                report["moved"].append(relative.as_posix())
                continue
            if destination.exists():
                archived = archive_conflict(source, relative)
                source.unlink()
                report["conflicts"].append({"path": relative.as_posix(), "archive": archived.relative_to(current).as_posix()})
            else:
                raise OSError("cannot atomically commit migrated file")
        except OSError as error:
            report["errors"].append({"path": str(relative), "error": str(error)})

    directories = [item for item in legacy.rglob("*") if item.is_dir() and not item.is_symlink()]
    for directory in sorted(directories, key=lambda item: len(item.parts), reverse=True):
        try:
            directory.rmdir()
        except OSError:
            pass
    if legacy.exists() and not report["errors"] and not report["skipped"]:
        try:
            legacy.rmdir()
        except OSError:
            pass
    status_path = current / ".migration-status.json"
    if not legacy.exists() and not report["errors"] and not report["skipped"]:
        marker = current / MIGRATION_MARKER
        marker.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        status_path.unlink(missing_ok=True)
    elif report["errors"] or report["skipped"]:
        status_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return report


def runtime_root(project_root: str | Path) -> Path:
    root = Path(project_root).resolve()
    report = migrate_runtime_directory(root)
    if report["errors"] or report["skipped"]:
        raise RuntimeError(f"旧运行数据迁移未完成，详情见 {root / RUNTIME_NAME / '.migration-status.json'}")
    return root / RUNTIME_NAME

from pathlib import Path

from seudaily.runtime_paths import env_value, migrate_runtime_directory


def test_migrates_only_legacy_runtime_tree(tmp_path: Path):
    legacy = tmp_path / ".cvstream" / "jwc" / "cache.json"
    legacy.parent.mkdir(parents=True)
    legacy.write_text("legacy", encoding="utf-8")

    report = migrate_runtime_directory(tmp_path)

    assert (tmp_path / ".seudaily" / "jwc" / "cache.json").read_text(encoding="utf-8") == "legacy"
    assert not (tmp_path / ".cvstream").exists()
    assert report["moved"] == ["jwc/cache.json"]


def test_keeps_only_new_runtime_tree(tmp_path: Path):
    current = tmp_path / ".seudaily" / "schedule.json"
    current.parent.mkdir(parents=True)
    current.write_text("new", encoding="utf-8")

    migrate_runtime_directory(tmp_path)

    assert current.read_text(encoding="utf-8") == "new"
    assert not (tmp_path / ".cvstream").exists()


def test_merges_distinct_files_from_both_runtime_trees(tmp_path: Path):
    current = tmp_path / ".seudaily" / "schedule.json"
    legacy = tmp_path / ".cvstream" / "jwc" / "cache.json"
    current.parent.mkdir(parents=True)
    legacy.parent.mkdir(parents=True)
    current.write_text("new schedule", encoding="utf-8")
    legacy.write_text("legacy cache", encoding="utf-8")

    migrate_runtime_directory(tmp_path)

    assert current.read_text(encoding="utf-8") == "new schedule"
    assert (tmp_path / ".seudaily" / "jwc" / "cache.json").read_text(encoding="utf-8") == "legacy cache"
    assert not (tmp_path / ".cvstream").exists()


def test_new_file_wins_and_legacy_conflict_is_archived(tmp_path: Path):
    current = tmp_path / ".seudaily" / "schedule.json"
    legacy = tmp_path / ".cvstream" / "schedule.json"
    current.parent.mkdir(parents=True)
    legacy.parent.mkdir(parents=True)
    current.write_text("new", encoding="utf-8")
    legacy.write_text("old", encoding="utf-8")

    report = migrate_runtime_directory(tmp_path)

    archive = tmp_path / ".seudaily" / ".migration-conflicts" / "cvstream" / "schedule.json"
    assert current.read_text(encoding="utf-8") == "new"
    assert archive.read_text(encoding="utf-8") == "old"
    assert report["conflicts"] == [{"path": "schedule.json", "archive": ".migration-conflicts/cvstream/schedule.json"}]
    assert not (tmp_path / ".cvstream").exists()


def test_archives_legacy_file_when_new_path_is_a_directory(tmp_path: Path):
    current = tmp_path / ".seudaily" / "schedule.json"
    legacy = tmp_path / ".cvstream" / "schedule.json"
    current.mkdir(parents=True)
    legacy.parent.mkdir(parents=True)
    (current / "preserved.txt").write_text("new", encoding="utf-8")
    legacy.write_text("legacy", encoding="utf-8")

    report = migrate_runtime_directory(tmp_path)

    archive = tmp_path / ".seudaily" / ".migration-conflicts" / "cvstream" / "schedule.json"
    assert (current / "preserved.txt").read_text(encoding="utf-8") == "new"
    assert archive.read_text(encoding="utf-8") == "legacy"
    assert report["conflicts"]


def test_migration_is_idempotent_and_identical_retry_is_not_conflict(tmp_path: Path):
    legacy = tmp_path / ".cvstream" / "schedule.json"
    legacy.parent.mkdir(parents=True)
    legacy.write_text("same", encoding="utf-8")
    migrate_runtime_directory(tmp_path)
    first_marker = (tmp_path / ".seudaily" / ".migration-cvstream-v1.json").read_text(encoding="utf-8")

    second_report = migrate_runtime_directory(tmp_path)

    assert second_report == {"moved": [], "conflicts": [], "errors": [], "skipped": []}
    assert (tmp_path / ".seudaily" / ".migration-cvstream-v1.json").read_text(encoding="utf-8") == first_marker
    assert list((tmp_path / ".seudaily").rglob("schedule.json")) == [tmp_path / ".seudaily" / "schedule.json"]


def test_resumes_after_copy_committed_but_legacy_source_remained(tmp_path: Path):
    current = tmp_path / ".seudaily" / "schedule.json"
    legacy = tmp_path / ".cvstream" / "schedule.json"
    current.parent.mkdir(parents=True)
    legacy.parent.mkdir(parents=True)
    current.write_text("same data", encoding="utf-8")
    legacy.write_text("same data", encoding="utf-8")

    report = migrate_runtime_directory(tmp_path)

    assert report["moved"] == ["schedule.json"]
    assert report["conflicts"] == []
    assert current.read_text(encoding="utf-8") == "same data"
    assert not (tmp_path / ".cvstream").exists()


def test_canonical_environment_value_wins_with_legacy_fallback(monkeypatch):
    monkeypatch.setenv("CVSTREAM_USERNAME", "legacy")
    monkeypatch.delenv("SEUDAILY_USERNAME", raising=False)
    assert env_value("SEUDAILY_USERNAME") == "legacy"
    monkeypatch.setenv("SEUDAILY_USERNAME", "canonical")
    assert env_value("SEUDAILY_USERNAME") == "canonical"


def test_legacy_python_import_namespace_points_to_canonical_package():
    import cvstream.protocol as legacy_protocol

    assert Path(legacy_protocol.__file__).parent.name == "seudaily"

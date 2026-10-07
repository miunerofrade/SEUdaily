import json
import pytest

from seudaily.jwc import CSE_CATEGORIES, JWC_CATEGORIES, CseService, _load_notice_categories


def test_packaged_categories_use_existing_service(tmp_path):
    assert JWC_CATEGORIES["student_status"] == ("学籍管理", "/xjgl/list.htm")
    service = CseService(cache_dir=str(tmp_path), background_sync=False)
    assert service.config.categories is CSE_CATEGORIES
    assert service._categories(["undergraduate_notices"], None) == ["undergraduate_notices"]
    assert service._categories(None, ["/49470/list.htm"]) == ["teaching"]


@pytest.mark.parametrize("entry", [
    ["通知", "https://other.example/list.htm"],
    ["通知", "//other.example/list.htm"],
    ["通知", "/../list.htm"],
    ["通知", "/news/list.htm?url=external"],
    ["", "/news/list.htm"],
    "not a category",
])
def test_invalid_category_config_is_rejected(tmp_path, entry):
    path = tmp_path / "categories.json"
    path.write_text(json.dumps({"jwc": {"news": entry}, "cse": {"news": ["通知", "/news/list.htm"]}}))
    with pytest.raises(ValueError):
        _load_notice_categories(path)


def test_duplicate_paths_are_rejected(tmp_path):
    path = tmp_path / "categories.json"
    path.write_text(json.dumps({"jwc": {"first": ["一", "/news/list.htm"], "second": ["二", "/news/list.htm"]},
                                "cse": {"news": ["通知", "/news/list.htm"]}}))
    with pytest.raises(ValueError, match="路径重复"):
        _load_notice_categories(path)

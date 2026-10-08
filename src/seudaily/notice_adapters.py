"""Small notice adapter boundary; storage, downloads and indexing stay shared."""

from __future__ import annotations
from typing import Any, Protocol
from .notice_sources import _NOTICE_SOURCES, source_config


class NoticeAdapter(Protocol):
    def list_articles(self, **options: Any) -> dict[str, Any]: ...
    def search(self, query: str, **options: Any) -> dict[str, Any]: ...
    def get_article(
        self, article_id: str, *, refresh: bool = True
    ) -> dict[str, Any]: ...
    def read_attachment(self, article_id: str, **options: Any) -> dict[str, Any]: ...
    def sync_pending(self) -> dict[str, Any]: ...


def create_notice_adapter(
    payload: dict[str, Any], *, sources: dict | None = None
) -> NoticeAdapter:
    registry = _NOTICE_SOURCES if sources is None else sources
    key = payload.get("source") or payload.get("site") or "jwc"
    config = source_config(key, registry)
    # Only registered implementations are allowed, never arbitrary module imports.
    if registry[key]["adapter"] != "webplus":
        raise ValueError(f"不支持的通知 adapter：{key}")
    from .jwc import WebplusNoticeAdapter

    return WebplusNoticeAdapter(
        config=config,
        base_url=payload.get("baseUrl", f"https://{config.host}"),
        cache_dir=payload.get("cacheDir", f".seudaily/{key}"),
        timeout_seconds=payload.get("timeoutSeconds", 15),
        background_sync=payload.get("backgroundSync", True),
    )

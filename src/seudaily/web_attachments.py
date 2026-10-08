"""Reuse intact originals before parsing; preserve them even if parsing fails."""

from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory
from . import saved_web_files
from .web_download import download, validate_signature
from .cancellation import raise_if_cancelled


def read_attachment(
    opener,
    url: str,
    name: str,
    extension: str,
    *,
    referer: str,
    timeout: int,
    max_bytes: int,
    validate_url,
    parse_document,
    refresh=False,
    source_name="",
) -> dict:
    validate_url(url)
    existing = saved_web_files.cached(url)
    if existing and not refresh:
        if existing.get("parsed"):
            return existing
        path = Path(existing["path"])
        original = path.read_bytes()
    else:
        original = download(
            opener,
            url,
            referer=referer,
            timeout=timeout,
            max_bytes=max_bytes,
            validate_url=validate_url,
        )
        validate_signature(original, extension)
        existing = saved_web_files.save(
            url, name, original, extension, source_url=referer, source_name=source_name
        )
        path = Path(existing["path"])
    raise_if_cancelled()
    # Parsers operate on disposable files; the durable original stays immutable.
    with TemporaryDirectory(prefix="seudaily-web-attachment-") as directory:
        temporary = Path(directory) / ("attachment" + extension)
        temporary.write_bytes(original)
        parsed = parse_document(str(temporary), filename=name)
    return saved_web_files.save(
        url,
        name,
        original,
        extension,
        markdown=parsed["markdown"],
        source_url=referer,
        source_name=source_name,
    )

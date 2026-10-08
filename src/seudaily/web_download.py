"""Bounded file downloads shared by web readers, notices and the calendar."""

from __future__ import annotations

from urllib.request import Request
from .cancellation import raise_if_cancelled


def read_chunks(chunks, *, max_bytes: int) -> bytes:
    parts, size = [], 0
    for chunk in chunks:
        raise_if_cancelled()
        size += len(chunk)
        if size > max_bytes:
            raise ValueError(f"附件超过 {max_bytes // (1024 * 1024)} MB，已停止下载")
        parts.append(chunk)
    return b"".join(parts)


def validate_signature(content: bytes, extension: str) -> None:
    if extension == ".pdf":
        valid = content.startswith(b"%PDF-")
    elif extension in {".jpg", ".jpeg"}:
        valid = content.startswith(b"\xff\xd8\xff")
    elif extension == ".png":
        valid = content.startswith(b"\x89PNG\r\n\x1a\n")
    else:
        valid = content.startswith(b"PK")
    if not valid:
        raise ValueError("附件内容与文件扩展名不匹配或文件已损坏")


def download(
    opener, url: str, *, referer: str, timeout: int, max_bytes: int, validate_url
) -> bytes:
    validate_url(url)
    request = Request(
        url,
        headers={"User-Agent": "SEUdaily/1.0 (+local web reader)", "Referer": referer},
    )
    with opener.open(request, timeout=timeout) as response:
        validate_url(response.geturl())
        length = response.headers.get("Content-Length")
        if length and int(length) > max_bytes:
            raise ValueError(f"附件超过 {max_bytes // (1024 * 1024)} MB，已拒绝下载")
        return read_chunks(
            iter(lambda: response.read(1024 * 1024), b""), max_bytes=max_bytes
        )

"""Cache official calendar attachments by URL; never redownload intact files."""
from __future__ import annotations

import hashlib
import json
import os
from contextlib import contextmanager
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlparse

import httpx

from .cancellation import TaskCancelledError

CALENDAR_URL = "https://jwc.seu.edu.cn/xl/list.htm"
MAX_BYTES = 8 * 1024 * 1024


class CalendarLinks(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links = []
        self.anchor = None

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if tag == "a" and values.get("href"):
            self.anchor = [values["href"], "", values.get("title", "")]

    def handle_data(self, data):
        if self.anchor is not None:
            self.anchor[1] += data

    def handle_endtag(self, tag):
        if tag == "a" and self.anchor is not None:
            url, title, fallback = self.anchor
            title = title.strip() or fallback
            self.anchor = None
            url = urljoin(CALENDAR_URL, url)
            parsed = urlparse(url)
            if (parsed.scheme == "https" and parsed.netloc == "jwc.seu.edu.cn"
                    and parsed.path.startswith("/_upload/article/")
                    and Path(parsed.path).suffix.lower() in {".pdf", ".jpg", ".jpeg", ".png"}
                    and any(word in title for word in ("校历", "节假日"))):
                self.links.append({"url": url, "title": title.strip()[:160]})


class AcademicCalendar:
    def __init__(self, directory: Path):
        self.directory = directory
        self.manifest = directory / "calendar.json"

    def cached(self):
        try:
            data = json.loads(self.manifest.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) and isinstance(data.get("attachments", []), list) else {}
        except (OSError, ValueError):
            return {}

    def _intact(self, attachment):
        # Only files inside this private cache may be reused.
        name = str(attachment.get("file", ""))
        if not name or Path(name).name != name:
            return False
        path = self.directory / name
        try:
            return hashlib.sha256(path.read_bytes()).hexdigest() == attachment.get("sha256")
        except OSError:
            return False

    @staticmethod
    def _download(client, url):
        with client.stream("GET", url) as response:
            response.raise_for_status()
            chunks, length = [], 0
            for chunk in response.iter_bytes():
                length += len(chunk)
                if length > MAX_BYTES:
                    raise ValueError("校历附件超过大小限制")
                chunks.append(chunk)
            return b"".join(chunks)

    @staticmethod
    def _pdf_text(path):
        from .optional_runtime import ensure_dependencies
        from .document_parser import _parse_pdf
        ensure_dependencies("documents")
        return _parse_pdf(path)[:12000]

    @contextmanager
    def _lock(self):
        self.directory.mkdir(parents=True, exist_ok=True)
        with (self.directory / "download.lock").open("a+b") as handle:
            if handle.tell() == 0:
                handle.write(b"0")
                handle.flush()
            handle.seek(0)
            try:
                if os.name == "nt":
                    import msvcrt
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                yield False
                return
            try:
                yield True
            finally:
                if os.name == "nt":
                    msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)

    def sync(self, write_json):
        # The OS releases this lock even if a worker crashes or is cancelled.
        with self._lock() as acquired:
            if not acquired:
                return {**self.view(), "warnings": ["校历正在同步，暂时使用已有缓存。"]}
            return self._sync_locked(write_json)

    def _sync_locked(self, write_json):
        previous = self.cached()
        saved = {item.get("url"): item for item in previous.get("attachments", []) if isinstance(item, dict)}
        attachments, warnings = [], []
        self.directory.mkdir(parents=True, exist_ok=True)
        try:
            with httpx.Client(timeout=15, follow_redirects=False) as client:
                html = self._download(client, CALENDAR_URL).decode("utf-8", errors="replace")
                parser = CalendarLinks()
                parser.feed(html)
                links = list({item["url"]: item for item in parser.links}.values())[:6]
                if not links:
                    raise ValueError("校历页面未返回可识别的官方附件")
                for link in links:
                    old = saved.get(link["url"], {})
                    item = {**old, **link}
                    try:
                        if not self._intact(old):
                            content = self._download(client, link["url"])
                            suffix = Path(urlparse(link["url"]).path).suffix.lower()
                            if not (content.startswith(b"%PDF-") if suffix == ".pdf" else content.startswith((b"\xff\xd8\xff", b"\x89PNG\r\n\x1a\n"))):
                                raise ValueError("校历附件不是有效的 PDF 或图片")
                            digest = hashlib.sha256(content).hexdigest()
                            name = digest + suffix
                            path = self.directory / name
                            temporary = path.with_suffix(suffix + ".tmp")
                            temporary.write_bytes(content)
                            temporary.replace(path)
                            item = {**link, "file": name, "sha256": digest, "downloadedAt": datetime.now(timezone.utc).isoformat()}
                        if item["file"].endswith(".pdf") and not item.get("text"):
                            try:
                                item["text"] = self._pdf_text(self.directory / item["file"])
                            except TaskCancelledError:
                                raise
                            except Exception:
                                warnings.append("节假日通知已缓存，文本解析暂未完成；原文件已保留。")
                        attachments.append(item)
                    except TaskCancelledError:
                        raise
                    except Exception:
                        warnings.append(f"{link['title']}下载失败，已保留原缓存。")
                        if self._intact(old):
                            attachments.append(old)
            result = {"sourceUrl": CALENDAR_URL, "checkedAt": datetime.now(timezone.utc).isoformat(), "attachments": attachments, "warnings": warnings}
            # Never replace a working manifest with an empty/failed download.
            if attachments:
                write_json(self.manifest, result)
                return result
            return {**previous, "warnings": warnings}
        except TaskCancelledError:
            raise
        except Exception:
            return {**previous, "sourceUrl": CALENDAR_URL, "warnings": ["校历同步暂时失败，已保留原缓存。"]}

    def view(self):
        data = self.cached()
        return {**data, "attachments": [item for item in data.get("attachments", []) if isinstance(item, dict) and self._intact(item)]}

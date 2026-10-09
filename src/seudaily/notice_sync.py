"""Persistent notice detail queue and worker lifecycle."""

from __future__ import annotations
from typing import Any
import json
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from .json_store import write_json_atomic
from contextlib import contextmanager


def sync_pending(self, *, max_workers: int = 4, now_iso) -> dict[str, Any]:
    self.cache_dir.mkdir(parents=True, exist_ok=True)
    try:
        worker_lock = self.worker_lock_file.open("x", encoding="utf-8")
    except FileExistsError:
        if time.time() - self.worker_lock_file.stat().st_mtime < 600:
            return {"status": "already_running", "completed": 0}
        self.worker_lock_file.unlink(missing_ok=True)
        worker_lock = self.worker_lock_file.open("x", encoding="utf-8")
    try:
        worker_lock.write(str(os.getpid()))
        worker_lock.close()
        with self._queue_lock():
            jobs = self._read_queue()
        if not jobs:
            return {"status": "empty", "completed": 0}
        completed: set[str] = set()
        failures: list[dict[str, str]] = []
        with ThreadPoolExecutor(max_workers=min(max_workers, len(jobs))) as executor:
            futures = {
                executor.submit(self._refresh_article, dict(job)): job for job in jobs
            }
            for future in as_completed(futures):
                job = futures[future]
                try:
                    future.result()
                    completed.add(job["id"])
                except Exception as exc:
                    failures.append(
                        {
                            "id": job["id"],
                            "url": job.get("url", ""),
                            "error": str(exc),
                            "failedAt": now_iso(),
                        }
                    )
        attempted = {job["id"] for job in jobs}
        with self._queue_lock():
            current = self._read_queue()
            self._write_queue(
                [job for job in current if job.get("id") not in attempted]
            )
        self._update_failures(completed, failures)
        return {
            "status": "completed" if not failures else "partial",
            "completed": len(completed),
            "failed": len(failures),
            "errors": [f"{item['id']}: {item['error']}" for item in failures],
        }
    finally:
        self.worker_lock_file.unlink(missing_ok=True)


def _enqueue_details(self, articles: list[dict[str, Any]]) -> list[str]:
    queued_ids = [article["id"] for article in articles]
    with self._queue_lock():
        existing = {job["id"]: job for job in self._read_queue()}
        for article in articles:
            existing[article["id"]] = {
                key: article.get(key)
                for key in (
                    "id",
                    "url",
                    "title",
                    "publishedAt",
                    "category",
                    "categoryLabel",
                )
            }
            existing[article["id"]]["url"] = self._normalize_url(article["url"])
        self._write_queue(list(existing.values()))
    return queued_ids


def _start_worker(self) -> None:
    command = [
        sys.executable,
        "-m",
        "seudaily.cli",
        "jwc-worker",
        json.dumps(
            {
                "site": self.config.key,
                "baseUrl": self.base_url,
                "cacheDir": str(self.cache_dir),
                "timeoutSeconds": self.timeout_seconds,
            }
        ),
    ]
    creationflags = 0
    if os.name == "nt":
        creationflags = (
            subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
        )
    subprocess.Popen(
        command,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        close_fds=True,
        creationflags=creationflags,
    )


@contextmanager
def _queue_lock(self):
    self.cache_dir.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + 3
    while True:
        try:
            handle = self.queue_lock_file.open("x", encoding="utf-8")
            break
        except FileExistsError:
            if time.time() - self.queue_lock_file.stat().st_mtime > 30:
                self.queue_lock_file.unlink(missing_ok=True)
                continue
            if time.monotonic() >= deadline:
                raise TimeoutError("教务处详情队列正在被占用")
            time.sleep(0.05)
    try:
        handle.write(str(os.getpid()))
        handle.close()
        yield
    finally:
        self.queue_lock_file.unlink(missing_ok=True)


def _read_queue(self) -> list[dict[str, Any]]:
    if not self.queue_file.exists():
        return []
    jobs = json.loads(self.queue_file.read_text(encoding="utf-8"))
    for job in jobs:
        if job.get("url"):
            job["url"] = self._normalize_url(job["url"])
    return jobs


def _write_queue(self, jobs: list[dict[str, Any]]) -> None:
    self.cache_dir.mkdir(parents=True, exist_ok=True)
    write_json_atomic(self.queue_file, jobs)


def _update_failures(
    self,
    completed: set[str],
    failures: list[dict[str, str]],
) -> None:
    existing: dict[str, dict[str, str]] = {}
    if self.failures_file.exists():
        existing = {
            item["id"]: item
            for item in json.loads(self.failures_file.read_text(encoding="utf-8"))
        }
    for article_id in completed:
        existing.pop(article_id, None)
    for failure in failures:
        existing[failure["id"]] = failure
    self.cache_dir.mkdir(parents=True, exist_ok=True)
    write_json_atomic(self.failures_file, list(existing.values()))

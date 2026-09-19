from __future__ import annotations

import threading


class TaskCancelledError(RuntimeError):
    pass


_local = threading.local()


def set_current_cancel_event(event: threading.Event | None) -> None:
    _local.event = event


def current_cancel_event() -> threading.Event:
    event = getattr(_local, "event", None)
    if event is None:
        event = threading.Event()
        _local.event = event
    return event


def raise_if_cancelled() -> None:
    if current_cancel_event().is_set():
        raise TaskCancelledError("任务已取消")

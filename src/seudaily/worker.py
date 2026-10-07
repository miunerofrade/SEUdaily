from __future__ import annotations

import json
import os
import queue
import sys
import threading
import traceback
from typing import Any

from . import __version__
from .cancellation import TaskCancelledError, raise_if_cancelled, set_current_cancel_event
from .cli import dispatch
from .protocol import normalize_tool_result
from .runtime_paths import env_value, migrate_runtime_directory


def _write(message: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", line_buffering=True)

    migration = migrate_runtime_directory(env_value("SEUDAILY_PROJECT_ROOT") or os.getcwd())
    if migration["errors"] or migration["skipped"]:
        raise RuntimeError("旧运行数据迁移未完成；请检查 .seudaily/.migration-status.json 后重试")
    requests: queue.Queue[dict[str, Any] | None] = queue.Queue()
    cancellation_events: dict[str, threading.Event] = {}
    cancelled_requests: set[str] = set()
    active_lock = threading.Lock()

    def read_requests() -> None:
        for line in sys.stdin:
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                print("Worker received invalid JSON", file=sys.stderr)
                continue
            request_id = str(message.get("requestId", ""))
            if message.get("type") == "cancel":
                with active_lock:
                    event = cancellation_events.get(request_id)
                    if event is not None:
                        event.set()
                    else:
                        cancelled_requests.add(request_id)
                continue
            requests.put(message)
        requests.put(None)

    threading.Thread(target=read_requests, name="seudaily-worker-reader", daemon=True).start()

    while True:
        request = requests.get()
        if request is None:
            break
        request_id = str(request.get("requestId") or "")
        task_id = str(request.get("taskId") or "")
        action = str(request.get("action") or "")
        payload = request.get("payload") or {}
        event = threading.Event()
        with active_lock:
            if request_id in cancelled_requests:
                event.set()
                cancelled_requests.discard(request_id)
            cancellation_events[request_id] = event
        set_current_cancel_event(event)
        try:
            raise_if_cancelled()
            if action == "health":
                raw_result = {"status": "completed", "version": __version__, "worker": True}
            else:
                raw_result = dispatch({"action": action, "payload": {**payload, "taskId": task_id}})
            if event.is_set():
                raise TaskCancelledError("任务已取消")
            if action == "knowledge-index" or action.startswith("vpn-") or action in {"ramdisk-status", "mount-ramdisk", "unmount-ramdisk", "reveal-ramdisk"}:
                # UI status polling is transient, not a historical Agent tool result.
                result = {"status": raw_result.get("status", "completed"), "taskId": task_id, "summary": raw_result.get("summary", "内存盘状态"), "data": raw_result.get("data", raw_result), "artifacts": [], "citations": [], "warnings": [], "metrics": {}}
            else:
                result = normalize_tool_result(action, raw_result, requested_task_id=task_id)
            _write({"requestId": request_id, "type": "result", "result": result})
        except TaskCancelledError as exc:
            result = normalize_tool_result(
                action,
                {"status": "cancelled", "message": str(exc)},
                requested_task_id=task_id,
            )
            _write({"requestId": request_id, "type": "result", "result": result})
        except Exception as exc:
            traceback.print_exc(file=sys.stderr)
            _write(
                {
                    "requestId": request_id,
                    "type": "error",
                    "error": str(exc),
                    "errorType": type(exc).__name__,
                }
            )
        finally:
            set_current_cancel_event(None)
            with active_lock:
                cancellation_events.pop(request_id, None)


if __name__ == "__main__":
    main()

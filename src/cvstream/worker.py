from __future__ import annotations

import json
import os
import queue
import sys
import threading
import traceback
from typing import Any

from .cancellation import TaskCancelledError, set_current_cancel_event
from .cli import dispatch
from .protocol import normalize_tool_result


def _write(message: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", line_buffering=True)

    os.environ["CVSTREAM_SHARED_BROWSER"] = "1"
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

    threading.Thread(target=read_requests, name="cvstream-worker-reader", daemon=True).start()

    while True:
        request = requests.get()
        if request is None:
            break
        request_id = str(request.get("requestId") or "")
        task_id = str(request.get("taskId") or "")
        action = str(request.get("action") or "")
        payload = request.get("payload") or {}
        event = threading.Event()
        if request_id in cancelled_requests:
            event.set()
            cancelled_requests.discard(request_id)
        with active_lock:
            cancellation_events[request_id] = event
        set_current_cancel_event(event)
        try:
            if action == "health":
                raw_result = {"status": "completed", "version": "0.3.0", "worker": True}
            else:
                raw_result = dispatch({"action": action, "payload": {**payload, "taskId": task_id}})
            if event.is_set():
                raise TaskCancelledError("任务已取消")
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

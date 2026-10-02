"""Thin local HTTP client. The Node agent owns tools, approvals and memory."""
from __future__ import annotations

import json
import re
from typing import Any, AsyncIterator
from urllib.parse import quote
from uuid import uuid4

import httpx

API_URL = "http://127.0.0.1:4111"
RESOURCE_ID = "seudaily-web-local"


class ClientError(RuntimeError):
    pass


def terminal_text(value: Any) -> str:
    """Treat model/tool text as text, never terminal control sequences."""
    text = str(value)
    text = re.sub(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)", "", text)
    text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", text)
    return re.sub(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]", "", text)


class AgentClient:
    def __init__(self, timeout: float = 300, transport: httpx.AsyncBaseTransport | None = None):
        self.http = httpx.AsyncClient(
            base_url=API_URL, timeout=httpx.Timeout(timeout, connect=5),
            trust_env=False, transport=transport,
        )

    async def close(self) -> None:
        await self.http.aclose()

    @staticmethod
    async def check(response: httpx.Response) -> None:
        if response.is_success:
            return
        await response.aread()
        try:
            error = response.json().get("error") or response.text
        except (ValueError, AttributeError):
            error = response.text
        raise ClientError(terminal_text(error) or f"请求失败（{response.status_code}）")

    async def request(self, method: str, path: str, **kwargs: Any) -> dict:
        try:
            response = await self.http.request(method, path, **kwargs)
            await self.check(response)
            return response.json()
        except (httpx.HTTPError, ValueError) as error:
            raise ClientError(f"本地服务请求失败：{terminal_text(error)}") from error

    async def threads(self) -> list[dict]:
        threads = []
        for resource in (RESOURCE_ID, "cvstream-web-local"):
            page = 0
            while True:
                response = await self.request("GET", "/api/memory/threads", params={"resourceId": resource, "perPage": 100, "page": page})
                batch = response.get("threads", [])
                threads.extend(batch)
                if len(batch) < 100:
                    break
                page += 1
        return sorted(threads, key=lambda thread: thread.get("updatedAt", ""), reverse=True)

    @staticmethod
    def thread_path(thread_id: str, action: str) -> str:
        return f"/api/memory/threads/{quote(thread_id, safe='')}/{action}"

    async def history(self, thread_id: str, resource_id: str, count: int = 100) -> dict:
        return await self.request("GET", self.thread_path(thread_id, "messages"), params={"resourceId": resource_id, "perPage": count})

    async def run_state(self, thread_id: str, resource_id: str) -> dict:
        return await self.request("GET", self.thread_path(thread_id, "run"), params={"resourceId": resource_id})

    async def cancel(self, thread_id: str, resource_id: str, run_token: str | None = None) -> None:
        try:
            await self.request("POST", self.thread_path(thread_id, "cancel"), params={"resourceId": resource_id}, json={"runToken": run_token} if run_token else {})
        except ClientError:
            pass  # A failed preflight may not have created a thread yet.

    async def stream(
        self, message: str | list, thread_id: str, resource_id: str, *, run_token: str | None = None,
        skills: list[str] | None = None, namespaces: list[str] | None = None,
        auth_resume_id: str | None = None, document_refs: list[str] | None = None,
    ) -> AsyncIterator[dict]:
        body = {
            "messages": message, "memory": {"thread": thread_id, "resource": resource_id},
            "requestContext": {
                "seudailyRunToken": run_token or str(uuid4()), "seudailyThreadId": thread_id,
                "seudailySkills": skills or [], "seudailyToolNamespaces": namespaces or [],
                "seudailyInterface": "cli",
                "seudailyDocumentRefs": document_refs or [],
                **({"seudailyAuthResumeId": auth_resume_id} if auth_resume_id else {}),
            },
        }
        complete = False
        try:
            async with self.http.stream("POST", "/api/agents/seudaily-agent/stream", json=body) as response:
                await self.check(response)
                lines: list[str] = []
                async for line in response.aiter_lines():
                    if line:
                        if line.startswith("data:"):
                            lines.append(line[5:].lstrip())
                        continue
                    if not lines:
                        continue
                    data = "\n".join(lines)
                    lines.clear()
                    if data == "[DONE]":
                        break
                    event = json.loads(data)
                    if not isinstance(event, dict) or not isinstance(event.get("type"), str):
                        raise ClientError("无效流式事件")
                    if event["type"] in {"finish", "error", "tool-approval-request"}:
                        complete = True
                    yield event
                if lines:
                    raise ClientError("服务端流式事件未完整结束")
                if not complete:
                    raise ClientError("回答连接中断，未收到完成状态；不会自动重试已执行的工具")
        except (httpx.HTTPError, ValueError) as error:
            raise ClientError(f"回答连接失败：{terminal_text(error)}") from error

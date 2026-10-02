"""Full-screen prompt_toolkit UI and one-shot command execution."""
from __future__ import annotations

import asyncio
import json
import os
import re
from pathlib import Path
import sys
from typing import Any
from urllib.parse import quote
from uuid import uuid4

from prompt_toolkit.application import Application
from prompt_toolkit.layout import Layout, HSplit, Window, FloatContainer, Float, ScrollOffsets
from prompt_toolkit.layout.controls import FormattedTextControl
from prompt_toolkit.layout.dimension import Dimension
from prompt_toolkit.layout.margins import ScrollbarMargin
from prompt_toolkit.layout.menus import CompletionsMenu
from prompt_toolkit.widgets import TextArea, Frame
from prompt_toolkit.auto_suggest import AutoSuggestFromHistory
from prompt_toolkit.enums import EditingMode
from prompt_toolkit.history import FileHistory
from prompt_toolkit.key_binding import KeyBindings
from prompt_toolkit.styles import Style

from .terminal_client import AgentClient, ClientError, RESOURCE_ID, terminal_text
from .terminal_view import TranscriptView
from .terminal_commands import COMMANDS, SlashCompleter, parser_for, programs_text, schedule_text, split_command, table


class Terminal:
    def __init__(self, client: AgentClient, args: Any, root: Path):
        self.client, self.args, self.root = client, args, root
        self.thread_id, self.resource_id = str(uuid4()), RESOURCE_ID
        self.skills = list(args.skill)
        self.catalog: list[dict] = []
        self.threads: list[dict] = []
        self.pending: dict | None = None
        self.confirmation: tuple[str, Any] | None = None
        self.auth_requests: dict[str, dict] = {}
        self.actions: dict[str, dict] = {}
        self.documents: list[dict] = []
        self.worker: asyncio.Task | None = None
        self.active_run_token: str | None = None
        self.cancelling = False
        self.status = "就绪"
        self.closed = False
        self.state_path = root / ".seudaily" / "cli-state.json"
        self.ui: Application | None = None
        self.transcript = ""
        self.scroll_line: int | None = None
        self.ui_mode = False
        self._rendered_source: str | None = None
        self._rendered_fragments: list[tuple[str, str]] = []

    def show(self, text: Any = "", *, end: str = "\n", error: bool = False) -> None:
        text = terminal_text(text)
        if self.ui_mode:
            self.transcript += ("\n错误 · " if error and text else "") + text + end
            if self.ui:
                self.ui.invalidate()
        else:
            print(text, end=end, flush=True, file=sys.stderr if error else sys.stdout)

    def save_session(self) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.state_path.with_name(f".cli-state-{uuid4()}.tmp")
        try:
            with temporary.open("x", encoding="utf-8") as output:
                if os.name != "nt":
                    os.chmod(temporary, 0o600)
                json.dump({"threadId": self.thread_id, "resourceId": self.resource_id}, output)
            temporary.replace(self.state_path)
        finally:
            temporary.unlink(missing_ok=True)

    async def initialize(self, *, display: bool = True) -> None:
        self.catalog = (await self.client.request("GET", "/app/skills")).get("skills", [])
        unknown = set(self.skills) - {item["name"] for item in self.catalog}
        if unknown:
            raise ClientError("Skill 不存在：" + ", ".join(sorted(unknown)))
        if self.args.resume:
            await self.resume(self.args.resume, display=display)
            self.skills = list(self.args.skill)
        elif display and not self.ui_mode:
            self.show("SEUdaily 终端助手 · /help 查看命令 · Tab 补全 · Alt+Enter 换行 · Ctrl+C 取消 · Ctrl+D 退出")
        if display:
            self.show("输入消息开始对话，或输入 / 查看可用命令。" if self.ui_mode else f"会话：{self.thread_id}")

    async def resume(self, target: str, *, display: bool = True) -> None:
        latest = target == 'latest'
        if target == "latest":
            try:
                target = json.loads(self.state_path.read_text(encoding="utf-8"))["threadId"]
            except (OSError, ValueError, KeyError, TypeError):
                target = ""
        if target.isdecimal() and self.threads:
            index = int(target) - 1
            if not 0 <= index < len(self.threads):
                raise ClientError("会话序号超出最近列表范围")
            selected = self.threads[index]
        else:
            threads = await self.client.threads()
            selected = next((thread for thread in threads if thread["id"] == target), None) if target else next(iter(threads), None)
            if latest and not selected:
                selected = next(iter(threads), None)
        if not selected:
            raise ClientError("找不到会话；使用 /sessions 查看 ID")
        self.thread_id, self.resource_id = selected["id"], selected["resourceId"]
        self.skills.clear()
        self.documents.clear()
        self.auth_requests.clear()
        self.actions.clear()
        self.pending = (await self.client.run_state(self.thread_id, self.resource_id)).get("pending")
        self.save_session()
        if display:
            self.show(f"已恢复：{selected.get('title') or self.thread_id}")
            await self.history(20)
            if self.pending:
                self.approval_notice()

    async def history(self, count: int = 100) -> None:
        response = await self.client.history(self.thread_id, self.resource_id, count)
        for message in response.get("messages", []):
            content = message.get("content") or {}
            parts = content.get("parts") or []
            text = content.get("content") or "\n".join(str(part.get("text", "")) for part in parts if part.get("type") == "text")
            role = "你" if message.get("role") == "user" else "SEUdaily"
            self.show(f"\n{role}\n{text}\n" if self.ui_mode else f"\n{role} › {text}")
            for part in parts:
                if part.get("type") == "tool-invocation":
                    invocation = part.get("toolInvocation") or {}
                    if invocation.get("result") is not None:
                        self.tool_result(invocation.get("toolName", "工具"), invocation["result"], quiet=True)
                elif part.get("type") == "error":
                    self.show((part.get("error") or {}).get("message") or "本轮曾中断")
        if response.get("hasMore"):
            self.show("还有更早记录；使用 /history 1000 查看更多。")

    def approval_notice(self) -> None:
        if self.pending:
            self.show(f"\n待审批：{self.pending.get('toolName', '工具')}\n{json.dumps(self.pending.get('args', {}), ensure_ascii=False)}\n使用 /approve 或 /reject；退出不会自动批准。")

    def tool_result(self, name: str, result: Any, *, quiet: bool = False) -> None:
        if not isinstance(result, dict):
            if not quiet and not self.args.quiet:
                self.show(f"\n[{name}] 已返回结果")
            return
        if not quiet and not self.args.quiet:
            self.show(f"\n[{name}] {result.get('summary') or result.get('status', '完成')}")
            for warning in result.get("warnings") or []:
                if not re.search(r'resultRef|上下文精简|完整清洗结果', str(warning)):
                    self.show(f"  {warning}")
            for citation in result.get("citations") or []:
                self.show(f"  来源：{citation.get('title', '')}")
        data = result.get("data") or {}
        if not isinstance(data, dict):
            return
        for key, store, command in (("authRequest", self.auth_requests, "login"), ("actionRequest", self.actions, "apply")):
            request = data.get(key)
            if isinstance(request, dict) and isinstance(request.get("id"), str):
                store[request["id"]] = request
                if not quiet:
                    self.show(f"\n{request.get('text') or '需要用户操作'}\n/{command} {request['id']}")

    async def agent(self, text: str | list, *, approval: dict | None = None, auth_resume_id: str | None = None, skills: list[str] | None = None, namespaces: list[str] | None = None, json_output: bool = False) -> int:
        if self.pending and not approval:
            raise ClientError("当前会话有待审批工具，请使用 /approve 或 /reject")
        run_token = approval["runToken"] if approval else str(uuid4())
        if approval:
            self.pending = None
        self.save_session()
        self.status = "正在回答"
        if self.ui_mode:
            self.show("\nSEUdaily\n")
        self.active_run_token = run_token
        failed = False
        try:
            async for event in self.client.stream(text, self.thread_id, self.resource_id, run_token=run_token, skills=skills if skills is not None else self.skills, namespaces=namespaces, auth_resume_id=auth_resume_id, document_refs=[document["contextRef"] for document in self.documents]):
                kind, payload = event["type"], event.get("payload") or {}
                if self.ui:
                    self.ui.invalidate()
                if json_output:
                    print(json.dumps(event, ensure_ascii=False), flush=True)
                if kind == "tool-approval-request":
                    self.pending = {**payload, "runToken": run_token}
                if kind == "error":
                    failed = True
                if json_output:
                    continue
                if kind == "text-delta":
                    self.show(payload.get("text", ""), end="")
                elif kind == "reasoning-start":
                    self.status = "正在思考"
                elif kind == "reasoning-end":
                    self.status = "正在回答"
                elif kind == "reasoning-delta" and self.args.verbose:
                    self.show(payload.get("text", ""), end="", error=True)
                elif kind == "tool-call":
                    self.status = f"工具：{payload.get('toolName', '')}"
                    if not self.args.quiet:
                        self.show(f"\n[{payload.get('toolName', '工具')}] 执行中")
                elif kind == "tool-result":
                    self.tool_result(payload.get("toolName", "工具"), payload.get("result"))
                elif kind == "tool-approval-request":
                    self.approval_notice()
                elif kind == "error":
                    self.show(f"\n{(payload.get('error') or {}).get('message', '回答失败')}", error=True)
                elif kind == "finish" and self.args.verbose:
                    self.show(f"\nusage：{json.dumps(payload.get('usage') or {}, ensure_ascii=False)}", error=True)
            if not json_output:
                self.show()
            self.documents.clear()
            if self.pending:
                return 3
            return 1 if failed else 0
        except asyncio.CancelledError:
            await asyncio.shield(self.client.cancel(self.thread_id, self.resource_id, run_token))
            raise
        finally:
            if self.active_run_token == run_token:
                self.active_run_token = None
            self.status = "待审批" if self.pending else "就绪"
            if self.ui:
                self.ui.invalidate()

    async def approve(self, approved: bool) -> int:
        if not self.pending:
            raise ClientError("没有待审批工具")
        pending = self.pending.copy()
        message = [{"role": "tool", "content": [{"type": "tool-approval-response", "approvalId": pending["approvalId"], "approved": approved}]}]
        try:
            return await self.agent(message, approval=pending)
        except ClientError:
            self.pending = (await self.client.run_state(self.thread_id, self.resource_id)).get("pending")
            raise

    async def cancel(self) -> None:
        if self.cancelling:
            return
        if self.worker and not self.worker.done():
            task = self.worker
            self.cancelling = True
            self.status = "正在停止"
            try:
                if self.active_run_token:
                    await self.client.cancel(self.thread_id, self.resource_id, self.active_run_token)
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
            finally:
                self.cancelling = False
            self.show("\n已停止当前任务。")
        elif self.pending:
            self.show("当前在等待审批；使用 /reject 拒绝工具。")
        else:
            self.show("没有正在运行的任务。")

    def confirm(self, kind: str, payload: Any, description: str) -> None:
        self.confirmation = (kind, payload)
        self.show(description + "\n输入 y 确认，其他输入取消。")

    async def confirmed(self, text: str) -> None:
        kind, payload = self.confirmation or ("", None)
        self.confirmation = None
        if text.lower() not in {"y", "yes"}:
            self.show("已取消。")
            return
        if kind == "mode":
            await self.client.request("POST", "/app/settings", json={"values": {"SEUDAILY_FULL_ACCESS": "true" if payload == "full" else "false", "SEUDAILY_FULL_ACCESS_EXTRA": "true" if payload == "extra" else "false"}})
            self.show(f"权限模式已设为 {payload}，同一后端的 Web 和其他会话也会使用此设置。")
        elif kind == "apply":
            result = await self.client.request("POST", f"/app/action-requests/{quote(payload, safe='')}/execute")
            self.ensure_result(result)
            self.actions.pop(payload, None)
            self.show(result.get("summary") or "操作已完成。")
        elif kind == "schedule-start":
            result = await self.client.request("PUT", "/app/schedule", json=payload)
            self.ensure_result(result)
            self.show("学期起始日期已保存。")

    def ensure_result(self, result: dict) -> None:
        if result.get("errorCode") == "campus_network_required" or result.get("summary") == "需要校园网环境":
            raise ClientError("需要校园网环境")
        if result.get("status") in {"failed", "cancelled"}:
            raise ClientError(result.get("summary") or "操作失败")
        if result.get("status") == "auth_required":
            raise ClientError("需要登录，请使用 /login schedule，登录后重试原斜杠命令。")

    async def command(self, text: str) -> None:
        name, words = split_command(text)
        skill_names = {item["name"] for item in self.catalog}
        if name == "help":
            if words:
                target = words[0]
                if len(words) != 1 or target not in COMMANDS:
                    raise ClientError('用法：/help [命令名称]')
                self.show(parser_for(target).format_help() if target in {'schedule', 'programs'} else f'/{target}：{COMMANDS[target]}')
                return
            self.show("\n".join(f"/{name:<12} {description}" for name, description in COMMANDS.items()))
            self.show("/skill NAME 问题 或 /NAME 问题 调用 Skill。/schedule、/programs 的 --sync 会联网；默认查询缓存。")
        elif name == "new":
            if self.pending:
                self.show("原会话仍有待审批工具，可通过 /resume 恢复；不会自动执行。")
            self.thread_id, self.resource_id = str(uuid4()), RESOURCE_ID
            self.pending = self.confirmation = None
            self.skills.clear(); self.documents.clear(); self.auth_requests.clear(); self.actions.clear()
            self.show(f"新会话：{self.thread_id}")
        elif name == "sessions":
            self.threads = await self.client.threads()
            self.show("\n".join(f"{index:>2}  {item.get('title') or '未命名'}\n    {item['id']}" for index, item in enumerate(self.threads, 1)) if self.threads else "暂无历史会话。")
        elif name == "resume":
            if len(words) > 1:
                raise ClientError("用法：/resume [ID 或序号]")
            await self.resume(words[0] if words else "latest")
        elif name == "history":
            count = int(words[0]) if len(words) == 1 and words[0].isdecimal() else 100 if not words else 0
            if not 1 <= count <= 1000:
                raise ClientError("用法：/history [1–1000]")
            await self.history(count)
        elif name == "skills":
            self.catalog = (await self.client.request("GET", "/app/skills")).get("skills", [])
            self.show("\n".join(f"/{item['name']} · {item['description']}" for item in self.catalog) or "项目内暂无 Skill。")
        elif name == "skill" or name in skill_names or name == "audit":
            if name == "audit":
                selected, query = "training-plan-audit", " ".join(words) or "请核查我的培养方案和毕业要求，说明学分缺口与证据限制。"
            elif name in skill_names:
                selected, query = name, " ".join(words)
            else:
                if not words:
                    self.show("当前 Skill：" + (", ".join(self.skills) or "自动发现"))
                    return
                selected, query = words[0], " ".join(words[1:])
            if selected == "off":
                self.skills.clear(); self.show("已取消显式 Skill 选择。")
            elif selected not in skill_names:
                raise ClientError("Skill 不存在；使用 /skills 查看目录")
            elif query:
                await self.agent(query, skills=[selected])
            else:
                self.skills = [selected]; self.show(f"后续消息使用 Skill：{selected}")
        elif name == "schedule":
            options = parser_for(name).parse_args(words)
            if options.help:
                self.show(parser_for(name).format_help())
                return
            if options.start_date and (options.sync or options.semester or options.date):
                raise ClientError("设置起始日期请单独使用 /schedule --start-date YYYY-MM-DD")
            result = await self.client.request("GET", "/app/schedule", params={"refresh": str(options.sync).lower(), "localOnly": str(not options.sync).lower(), "prefetchSemesters": "true", "includeSemesters": str(options.semesters).lower(), **({"semester": options.semester} if options.semester else {}), **({"date": options.date} if options.date else {})})
            self.ensure_result(result)
            if options.start_date:
                customizations = (result.get("data") or {}).get("customizations")
                if not isinstance(customizations, dict) or not isinstance(customizations.get("semester"), dict):
                    raise ClientError("尚无课表设置，请先同步课表")
                customizations["semester"]["startDate"] = options.start_date
                self.confirm("schedule-start", customizations, f"将当前学期起始日期设为 {options.start_date}。")
            else:
                self.show(schedule_text(result, show_semesters=options.semesters))
        elif name == "programs":
            options = parser_for(name).parse_args(words)
            if options.help:
                self.show(parser_for(name).format_help())
                return
            if options.page < 1 or not 1 <= options.limit <= 100:
                raise ClientError('--page 至少为 1，--limit 必须在 1–100 之间')
            result = await self.client.request("GET", "/app/programs", params={"refresh": str(options.sync).lower()})
            self.ensure_result(result)
            self.show(programs_text(result, plan_id=options.plan, page=options.page, limit=options.limit, query=options.filter))
        elif name in {"notices", "focus"}:
            if name == "focus" and not words:
                result = await self.client.request("GET", "/app/focus")
                self.ensure_result(result)
                items = (result.get("data") or {}).get("items") or []
                self.show(table(["标题", "类型", "启用", "ID"], [[item.get("title", ""), item.get("kind", ""), "是" if item.get("enabled") else "否", item.get("id", "")] for item in items]) if items else "暂无关注任务。")
            else:
                await self.agent(("查询校园通知：" if name == "notices" else "关注任务：") + (" ".join(words) or "最近的校园通知"), namespaces=["notices"] if name == "notices" else ["local-actions"])
        elif name in {"approve", "reject"}:
            if words:
                raise ClientError(f"/{name} 只处理当前会话的待审批工具，无需参数")
            await self.approve(name == "approve")
        elif name == "login":
            target = words[0] if len(words) == 1 else next(reversed(self.auth_requests), "") if not words else ""
            if target == "schedule":
                self.show("请在打开的校园登录窗口完成登录。")
                result = await self.client.request("POST", "/app/schedule/authorize")
                self.ensure_result(result)
                if result.get('status') != 'completed':
                    raise ClientError(result.get('summary') or '登录尚未完成，请完成验证后重试。')
                self.show(result.get("summary") or "登录操作已完成。")
            elif target in self.auth_requests:
                self.show("请在打开的校园登录窗口完成登录，成功后继续原任务。")
                result = await self.client.request("POST", f"/app/auth-resumes/{quote(target, safe='')}/execute")
                self.ensure_result(result)
                if result.get("status") != "completed":
                    raise ClientError("登录未完成，原任务尚未续接")
                self.auth_requests.pop(target, None)
                await self.agent("登录已完成，请根据续接结果继续原任务，不要重复执行原调用。", auth_resume_id=result["resumeId"])
            else:
                raise ClientError("用法：/login schedule 或 /login 工具返回的登录ID")
        elif name == "apply":
            target = words[0] if len(words) == 1 else next(reversed(self.actions), "") if not words else ""
            if target not in self.actions:
                raise ClientError("没有此操作请求；请先让 Agent 提出修改方案")
            self.confirm("apply", target, self.actions[target]["text"])
        elif name == "mode":
            if not words:
                fields = (await self.client.request("GET", "/app/settings")).get("fields", [])
                values = {field["name"]: field.get("value") for field in fields}
                mode = "extra" if values.get("SEUDAILY_FULL_ACCESS_EXTRA") == "true" else "full" if values.get("SEUDAILY_FULL_ACCESS") == "true" else "normal"
                self.show(f"当前权限：{mode}（与连接的 Web 后端共享）")
            elif len(words) == 1 and words[0] in {"normal", "full", "extra"}:
                self.confirm("mode", words[0], f"将权限设为 {words[0]}。full/extra 会跳过部分工具审批，extra 还会提供工作区工具；该设置与 Web 共享并保存到本地 env。")
            else:
                raise ClientError("用法：/mode [normal|full|extra]")
        elif name == "attach":
            if len(words) != 1 or len(self.documents) >= 4:
                raise ClientError('用法：/attach "文件路径"；最多 4 个文档')
            path = Path(words[0]).expanduser()
            path = path if path.is_absolute() else self.root / path
            if path.suffix.lower() not in {".pdf", ".docx", ".xlsx", ".pptx"}:
                raise ClientError("目前支持 PDF、DOCX、XLSX、PPTX；多媒体粘贴与复制暂缓")
            if not path.is_file() or not 0 < path.stat().st_size <= 50 * 1024 * 1024:
                raise ClientError("文档不存在、为空或超过 50 MB")
            with path.open("rb") as upload:
                document = await self.client.request("POST", "/app/documents", files={"file": (path.name, upload)})
            self.documents.append(document)
            self.show(f"已添加 {path.name}，下一条消息发送后清空附件列表。")
        elif name == "detach":
            self.documents.clear(); self.show("已清空待发送附件。")
        elif name == "cancel":
            await self.cancel()
        elif name == "quit":
            self.closed = True
        else:
            raise ClientError("未知命令；使用 /help 或 Tab 查看可用命令")

    async def work(self, text: str) -> None:
        try:
            if self.confirmation:
                await self.confirmed(text)
            elif text.startswith("/"):
                await self.command(text)
            else:
                await self.agent(text)
        except (ClientError, OSError, ValueError) as error:
            self.show(error, error=True)
        finally:
            self.status = "待确认" if self.confirmation else "待审批" if self.pending else "就绪"
            if self.ui:
                self.ui.invalidate()

    def transcript_fragments(self) -> list[tuple[str, str]]:
        """Render Markdown without passing model escape sequences to the terminal."""
        if self.transcript == self._rendered_source:
            return self._rendered_fragments
        fragments = []
        fenced = False
        for line in self.transcript.splitlines(keepends=True):
            if line.strip().startswith("```"):
                fenced = not fenced
                label = line.strip()[3:]
                fragments.append(("class:muted", (f"  {label}" if fenced else "") + "\n"))
                continue
            if fenced:
                fragments.append(("class:code", "  " + line))
                continue
            if line.strip() in {"你", "SEUdaily"}:
                fragments.append(("class:user" if line.strip() == "你" else "class:assistant", line))
                continue
            if line.startswith("错误 · "):
                fragments.append(("class:error", line))
                continue
            heading = re.match(r"^#{1,6}\s+(.+?)(\n?)$", line)
            if heading:
                fragments.append(("class:heading", heading[1] + heading[2]))
                continue
            line = re.sub(r"^(\s*)[-*] ", r"\1• ", line)
            # Basic Markdown emphasis, inline code and links; fenced code remains literal.
            parts = re.split(r"(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))", line)
            for part in parts:
                if part.startswith("**") and part.endswith("**"):
                    fragments.append(("class:strong", part[2:-2]))
                elif part.startswith("`") and part.endswith("`"):
                    fragments.append(("class:code", part[1:-1]))
                elif re.fullmatch(r"\[[^\]]+\]\([^)]+\)", part):
                    label, url = part[1:-1].split("](", 1)
                    fragments.append(("class:link", f"{label} ({url})"))
                else:
                    fragments.append(("", part))
        self._rendered_source = self.transcript
        self._rendered_fragments = fragments
        return fragments

    async def interactive(self) -> int:
        self.ui_mode = True
        await self.initialize()
        history_path = self.root / ".seudaily" / "cli-history"
        history_path.parent.mkdir(parents=True, exist_ok=True)
        history_path.touch(mode=0o600, exist_ok=True)
        if os.name != "nt":
            os.chmod(history_path, 0o600)
        bindings = KeyBindings()
        completer = SlashCompleter([item["name"] for item in self.catalog])
        editor = TextArea(
            multiline=True, history=FileHistory(str(history_path)),
            auto_suggest=AutoSuggestFromHistory(), completer=completer,
            complete_while_typing=True, height=lambda: Dimension.exact(min(7, max(3, editor.buffer.document.line_count))),
            prompt="› ", style="class:input", name="message-input",
        )
        def submit_text(text: str) -> None:
            if not text:
                return
            if text in {"/quit", "/exit"}:
                self.closed = True
                self.ui.exit()
            elif text == "/cancel":
                asyncio.create_task(self.cancel())
            elif self.worker and not self.worker.done():
                self.show("当前任务正在运行；可用 /cancel 或 Ctrl+C 停止。")
            else:
                self.scroll_line = None
                self.show(f"\n你\n{text}\n")
                self.worker = asyncio.create_task(self.work(text))
        @bindings.add("enter")
        def submit(event):
            buffer = editor.buffer
            text = buffer.text.strip()
            if self.worker and not self.worker.done() and text not in {"/cancel", "/quit", "/exit"}:
                self.show("当前任务正在运行；输入已保留。Ctrl+C 取消。")
                return
            buffer.append_to_history()
            buffer.reset()
            submit_text(text)
        @bindings.add("escape", "enter")
        def newline(event):
            editor.buffer.insert_text("\n")
        @bindings.add("c-c")
        def interrupt(event):
            if self.worker and not self.worker.done():
                asyncio.create_task(self.cancel())
            else:
                self.confirmation = None
                editor.buffer.reset()
        @bindings.add("c-d")
        def end(event):
            if not editor.buffer.text:
                self.closed = True
                event.app.exit()
            else:
                editor.buffer.delete()
        def scrolled() -> None:
            editor.buffer.cancel_completion()
            if self.ui:
                self.ui.invalidate()
        transcript_view = TranscriptView(
            self.transcript_fragments, lambda: self.scroll_line,
            lambda offset: setattr(self, "scroll_line", offset), scrolled,
        )
        @bindings.add("pageup")
        def page_up(event):
            transcript_view.scroll(-max(1, transcript_view.height - 1))
        @bindings.add("pagedown")
        def page_down(event):
            transcript_view.scroll(max(1, transcript_view.height - 1))
        @bindings.add("c-home")
        def head(event):
            self.scroll_line = 0
            scrolled()
        @bindings.add("c-end")
        def tail(event):
            self.scroll_line = None
            scrolled()
        conversation = Window(
            transcript_view, wrap_lines=False,
            get_vertical_scroll=lambda window: transcript_view.top,
            scroll_offsets=ScrollOffsets(top=0, bottom=0),
            right_margins=[ScrollbarMargin(display_arrows=False)],
            style="class:conversation", always_hide_cursor=True,
        )
        def status():
            completer.skill_names = [item["name"] for item in self.catalog]
            return [("class:status", f" {self.status}  ·  会话 {self.thread_id[:8]}  ·  " +
                     ("Skill " + ", ".join(self.skills) if self.skills else "自动 Skill") +
                     ("  ·  正在查看历史，Ctrl+End 回到底部" if self.scroll_line is not None else ""))]
        style = Style.from_dict({
            "": "bg:#20242c #dce1ea", "header": "bg:#292f3a #ffffff bold",
            "conversation": "bg:#20242c #dce1ea", "user": "#80cbc4 bold",
            "assistant": "#a8bfff bold", "strong": "bold #ffffff", "heading": "bold #a8bfff",
            "muted": "#8993a4", "code": "#e5c07b", "link": "#80cbc4 underline",
            "error": "#ff9292", "input": "bg:#292f3a #ffffff", "status": "#a8bfff",
            "frame.border": "#64738a", "frame.label": "#a8bfff",
            "completion-menu": "bg:#343d4c #dce1ea",
            "completion-menu.completion.current": "bg:#536585 #ffffff",
            "auto-suggestion": "#8993a4",
        }) if not self.args.no_color and not os.environ.get("NO_COLOR") else Style.from_dict({})
        layout = HSplit([
            Window(FormattedTextControl([("class:header", "  SEUdaily  /  终端助手")]), height=1),
            Window(height=1), conversation, Window(height=1),
            Window(FormattedTextControl(status), height=1),
            Frame(editor, title="消息 · Enter 发送 · Alt+Enter 换行"),
            Window(FormattedTextControl([("class:muted", " /help 命令  ·  Tab 补全  ·  PgUp/PgDn 滚动  ·  Ctrl+C 取消  ·  Ctrl+D 退出")]), height=1),
        ])
        self.ui = Application(
            layout=Layout(FloatContainer(content=layout, floats=[
                Float(xcursor=True, ycursor=True, content=CompletionsMenu(max_height=8, scroll_offset=1)),
            ]), focused_element=editor), key_bindings=bindings,
            full_screen=True, mouse_support=True, style=style,
            editing_mode=EditingMode.VI if self.args.vi else EditingMode.EMACS,
            min_redraw_interval=1 / 60, max_render_postpone_time=1 / 60,
        )
        if self.args.prompt:
            submit_text(self.args.prompt)
        try:
            await self.ui.run_async()
        finally:
            if self.worker and not self.worker.done():
                await self.cancel()
            self.ui = None
            self.ui_mode = False
        return 0


async def execute(args: Any, command: str, root: Path) -> int:
    client = AgentClient(args.timeout)
    terminal = Terminal(client, args, root)
    try:
        if command == "chat":
            return await terminal.interactive()
        if command in {"sessions", "skills"}:
            await terminal.command("/" + command)
            return 0
        await terminal.initialize(display=False)
        message = getattr(args, "message", None)
        if args.prompt and message:
            raise ClientError("问题只能通过 --prompt 或位置参数指定一次")
        text = args.prompt or message
        if not sys.stdin.isatty():
            piped = sys.stdin.read()
            text = f"{text}\n\n{piped}" if text and piped else text or piped
        if not text or not text.strip():
            raise ClientError("请提供问题，或通过标准输入传入文本")
        status = await terminal.agent(text.strip(), json_output=args.json)
        if status == 3:
            print(f"等待工具审批。使用 seudaily chat --resume {terminal.thread_id} 后 /approve 或 /reject。", file=sys.stderr)
        return status
    finally:
        await client.close()


def run_terminal(args: Any, command: str, root: Path) -> int:
    try:
        return asyncio.run(execute(args, command, root))
    except ClientError as error:
        print(terminal_text(error), file=sys.stderr)
        return 1

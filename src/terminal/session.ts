import { MAX_ATTACHMENTS } from "../shared/attachment-limits.js";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  unlink,
  stat,
  chmod,
} from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, extname, isAbsolute } from "node:path";
import { normalizedUsage, type Usage } from "./telemetry.js";
import { Client, RESOURCE, clean } from "./client.js";
import {
  diskSize,
  settingsForm,
  permissionForm,
  semesterForm,
  focusForm,
  type Form,
} from "./management.js";
import { imageMediaTypes, pastedFilePaths } from "./attachments.js";
export interface Options {
  command: string;
  cwd?: string;
  resume?: string;
  message?: string;
  skill?: string[];
  timeout?: number;
  quiet?: boolean;
  verbose?: boolean;
  json?: boolean;
  no_color?: boolean;
  vi?: boolean;
}
import { commands, flags, words } from "./command-parser.js";
export { commands, flags, words } from "./command-parser.js";
import { executeCommand } from "./commands.js";
export interface TerminalMessage {
  role: string;
  text: string;
  reasoning?: string;
  process?: Array<{
    type: "reasoning" | "text" | "tool";
    text: string;
    id?: string;
    expanded?: boolean;
  }>;
  streaming?: boolean;
  welcome?: boolean;
}
export class Session extends EventEmitter {
  client: Client;
  threadId = randomUUID() as string;
  resource = RESOURCE;
  runToken = "";
  model = "—";
  effort = "high";
  usage: Usage = {};
  usageByRun = new Map<string, Usage>();
  pending: any = null;
  confirmation: { kind: string; payload: any; text: string } | null = null;
  auth = new Map<string, any>();
  actions = new Map<string, any>();
  documents: any[] = [];
  images: { name: string; ref: string; mediaType: string }[] = [];
  attachmentLoading = false;
  skills: string[];
  catalog: any[] = [];
  threads: any[] = [];
  resumePickerRequested = 0;
  private titleTasks = new Map<string, Promise<void>>();
  private titleQueue = Promise.resolve();
  private namedThreads = new Set<string>();
  messages: TerminalMessage[] = [];
  copyOnSelect = false;
  reasoningExpanded = false;
  status = "就绪";
  busy = false;
  queueItems: any[] = [];
  queueActive = false;
  queueProgress = "";
  queueRunToken = "";
  private pollingQueue = false;
  vpnWatching = false;
  vpnState = "";
  preparationMessage = "";
  private preparationSequence: number | null = null;
  async pollPreparation() {
    const state = await this.client.json(
      "/app/runtime/preparation",
      "GET",
      undefined,
      AbortSignal.timeout(4000),
    );
    // Start at the current snapshot so a persistent backend does not replay old notices.
    if (this.preparationSequence === null)
      this.preparationSequence = Math.max(
        0,
        ...(state.events ?? []).map((event: any) => event.id),
      );
    for (const event of state.events ?? []) {
      if (event.id <= (this.preparationSequence ?? 0)) continue;
      this.preparationSequence = event.id;
      if (
        event.state === "failed" &&
        this.messages.at(-1)?.text !== event.message
      )
        this.show(event.message, "错误");
    }
    const message = Object.entries(state)
      .filter(
        ([name, item]) =>
          name !== "events" && (item as any)?.state === "preparing",
      )
      .map(([, item]) => (item as any).message)
      .join(" · ");
    if (message !== this.preparationMessage) {
      this.preparationMessage = message;
      this.changed();
    }
  }
  async pollVpn() {
    if (!this.vpnWatching) return;
    const preparation = (
      await this.client.json(
        "/app/runtime/preparation",
        "GET",
        undefined,
        AbortSignal.timeout(4000),
      )
    ).python;
    if (preparation?.state === "preparing") {
      this.vpnState = "VPN 等待运行环境准备";
      this.changed();
      return;
    }
    if (preparation?.state === "failed") {
      this.vpnWatching = false;
      this.vpnState = "VPN 未连接：工具环境准备失败";
      this.changed();
      return;
    }
    const result = await this.client.json(
      "/app/vpn",
      "GET",
      undefined,
      AbortSignal.timeout(4000),
    );
    this.reportVpn(result);
  }
  private reportVpn(result: any) {
    const state = result.data ?? result;
    const text =
      state.state === "connected"
        ? "VPN 已连接"
        : state.state === "campus_connected"
          ? "校园网已连接，无需 VPN"
          : state.message ||
            result.summary ||
            `VPN 状态：${state.state || "未知"}`;
    if (this.vpnState !== text) {
      this.vpnState = text;
      this.show(text);
    }
    this.vpnWatching = state.state === "connecting";
  }
  async pollQueue() {
    if (this.pollingQueue) return;
    this.pollingQueue = true;
    const thread = this.threadId,
      resource = this.resource;
    try {
      const state = await this.client.json(
        this.path("queue"),
        "GET",
        undefined,
        AbortSignal.timeout(4000),
      );
      if (thread !== this.threadId || resource !== this.resource) return;
      const finished = this.queueItems.some(
        (item) =>
          !state.items?.some((next: any) => next.id === item.id) ||
          (item.state === "running" &&
            state.items?.some(
              (next: any) => next.id === item.id && next.state !== "running",
            )),
      );
      this.queueItems = state.items ?? [];
      this.queueActive = state.active ?? false;
      this.queueProgress = state.progress?.text ?? "";
      this.queueRunToken = state.runToken ?? "";
      if (finished && !this.busy) {
        const notices = this.messages.filter(
          (message) =>
            !message.welcome && !["你", "SEUdaily"].includes(message.role),
        );
        this.messages = [];
        await this.history(100);
        if (thread !== this.threadId || resource !== this.resource) return;
        this.messages.push(...notices);
        const run = await this.client.json(
          this.path("run"),
          "GET",
          undefined,
          AbortSignal.timeout(4000),
        );
        if (thread !== this.threadId || resource !== this.resource) return;
        this.pending = run.pending ?? null;
      }
      this.changed();
    } finally {
      this.pollingQueue = false;
    }
  }
  async takeQueued() {
    const item = [...this.queueItems]
      .reverse()
      .find((item) => item.state !== "running");
    if (!item) return null;
    const draft = await this.client.json(
      this.path(`queue/${encodeURIComponent(item.id)}`),
      "DELETE",
      undefined,
      AbortSignal.timeout(4000),
    );
    this.images = draft.images;
    this.documents = draft.documents;
    this.skills = draft.skills;
    await this.pollQueue();
    return draft.text as string;
  }
  async enqueue(text: string) {
    const images = [...this.images],
      documents = [...this.documents],
      skills = this.skills;
    await this.client.json(
      this.path("queue"),
      "POST",
      { text, images, documents, skills, interface: "cli" },
      AbortSignal.timeout(5000),
    );
    this.images = this.images.filter(
      (image) => !images.some((sent) => sent.ref === image.ref),
    );
    this.documents = this.documents.filter(
      (document) =>
        !documents.some((sent) => sent.contextRef === document.contextRef),
    );
    if (this.skills === skills) this.skills = [];
    await this.recordInput(text);
    await this.pollQueue();
    this.changed();
  }
  thinking = false;
  page = "chat";
  schedule: any = { courses: [], availableSemesters: [] };
  programs: any = { plans: [] };
  viewOptions: Record<string, any> = {};
  form: Form | null = null;
  noticeItems: any[] = [];
  focusItems: any[] = [];
  focusTarget: any = null;
  openForm(form: Form) {
    this.form = form;
    this.changed();
  }
  async loadNotices(refresh = true, query = "") {
    const result = this.result(
      await this.client.json(`/app/notices?refresh=${refresh}`),
    );
    this.noticeItems = (result.data?.results ?? []).filter(
      (item: any) => !query || item.title?.includes(query),
    );
    this.page = "notices";
    this.changed();
    if (this.options.command !== "chat")
      this.show(
        this.noticeItems
          .map((item: any) => `${item.title}\n${item.url ?? ""}`)
          .join("\n\n") || "暂无通知",
      );
  }
  async loadFocus() {
    this.focusItems =
      this.result(await this.client.json("/app/focus")).data?.items ?? [];
    this.page = "focus";
    this.changed();
  }
  async openFocus(item: any) {
    if (this.busy) throw new Error("请先等待当前任务完成");
    this.threadId = item.threadId || item.id;
    this.resource = item.resourceId || "seudaily-focus-local";
    this.skills = [];
    this.documents = [];
    this.images = [];
    this.auth.clear();
    this.actions.clear();
    this.confirmation = null;
    this.pending = (await this.client.json(this.path("run"))).pending ?? null;
    this.runToken = "";
    this.reasoningExpanded = false;
    this.usageByRun.clear();
    this.usage = {};
    this.focusTarget = item;
    this.messages = [];
    this.page = "chat";
    await this.history();
    this.changed();
  }
  async runCreatedFocus(item: any) {
    this.form = null;
    await this.openFocus(item);
    this.busy = true;
    this.changed();
    try {
      await this.turn(item.description, {}, false, { respectInterval: true });
    } finally {
      this.busy = false;
      this.changed();
    }
  }
  controller: AbortController | null = null;
  operation: AbortController | null = null;
  statePath: string;
  constructor(
    public options: Options,
    public root: string,
  ) {
    super();
    this.client = new Client(options.timeout);
    this.skills = options.skill ?? [];
    this.statePath = resolve(root, ".seudaily/cli-state.json");
  }
  changed() {
    this.messages = [...this.messages];
    this.emit("change");
  }
  show(text: unknown, role = "系统") {
    this.messages.push({ role, text: clean(text) });
    this.changed();
  }
  async save() {
    await mkdir(resolve(this.root, ".seudaily"), { recursive: true });
    const temporary = this.statePath + "." + randomUUID() + ".tmp";
    try {
      await writeFile(
        temporary,
        JSON.stringify({ threadId: this.threadId, resourceId: this.resource }),
        { mode: 0o600 },
      );
      await rename(temporary, this.statePath);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
  path(action: string) {
    return `/api/memory/threads/${encodeURIComponent(this.threadId)}/${action}?resourceId=${encodeURIComponent(this.resource)}`;
  }
  inputHistory: string[] = [];
  async recordInput(text: string) {
    this.inputHistory.push(text);
    await writeFile(
      resolve(this.root, ".seudaily/cli-history"),
      JSON.stringify(this.inputHistory),
      { mode: 0o600 },
    );
    await chmod(resolve(this.root, ".seudaily/cli-history"), 0o600).catch(
      () => {},
    );
  }
  async initialize() {
    try {
      const preference = JSON.parse(
        await readFile(
          resolve(this.root, ".seudaily/cli-preferences.json"),
          "utf8",
        ),
      );
      this.copyOnSelect = preference.copyOnSelect === true;
    } catch {}
    await mkdir(resolve(this.root, ".seudaily"), { recursive: true });
    try {
      const history = await readFile(
        resolve(this.root, ".seudaily/cli-history"),
        "utf8",
      );
      try {
        this.inputHistory = JSON.parse(history);
      } catch {
        this.inputHistory = history.split(/\n(?=#)/).flatMap((record) => {
          const lines = record
            .split("\n")
            .filter((line) => line.startsWith("+"))
            .map((line) => line.slice(1));
          return lines.length ? [lines.join("\n")] : [];
        });
      }
    } catch {}
    this.catalog = (await this.client.json("/app/skills")).skills;
    const info = await this.client.json("/app/agent-info").catch(() => ({}));
    this.model = typeof info.model === "string" ? clean(info.model) : "—";
    this.effort = typeof info.effort === "string" ? clean(info.effort) : "high";
    for (const skill of this.skills)
      if (!this.catalog.some((s) => s.name === skill))
        throw new Error(`Skill 不存在：${skill}`);
    if (this.options.resume) {
      if (this.options.resume === "choose") await this.openResumePicker();
      else await this.resume(this.options.resume);
      this.skills = this.options.skill ?? [];
    } else this.welcome();
  }
  private welcome() {
    this.messages.push({
      role: "系统",
      welcome: true,
      text: "输入消息或 / 查看命令。\nCtrl+V / Alt+V 粘贴剪贴板图片、文本或文件；粘贴文件路径也可添加附件。\n方向键移动，Backspace/Delete 删除。\n/schedule 与 /programs 打开交互表格。",
    });
    this.changed();
  }
  async authorizeCampus(
    path: string,
    complete: (result: any) => Promise<void>,
    resetSession = true,
  ): Promise<void> {
    const response = await this.client.json(path, "POST", { resetSession });
    const challengeId = response.challengeId ?? response.data?.challengeId;
    if (challengeId) {
      this.result(
        await this.client.json("/app/auth/sms", "POST", {
          challengeId,
          operation: "send",
        }),
      );
      this.openForm({
        title: "校园短信验证（5 分钟内有效）",
        saveLabel: "验证并继续",
        fields: [{ key: "code", label: "短信验证码", value: "", secret: true }],
        save: async (values) => {
          this.result(
            await this.client.json("/app/auth/sms", "POST", {
              challengeId,
              operation: "verify",
              code: values.code,
            }),
          );
          await this.authorizeCampus(path, complete, false);
        },
      });
      return;
    }
    await complete(this.result(response));
  }
  result(result: any) {
    if (
      result.errorCode === "campus_network_required" ||
      result.summary === "需要校园网环境"
    )
      throw new Error("需要校园网环境");
    if (["failed", "cancelled"].includes(result.status))
      throw new Error(result.summary ?? "操作失败");
    if (result.status === "auth_required")
      throw new Error("需要登录，请使用 /login schedule。");
    return result;
  }
  tool(result: any) {
    const data = result?.data ?? {};
    for (const [key, map, command] of [
      ["authRequest", this.auth, "login"],
      ["actionRequest", this.actions, "apply"],
    ] as const) {
      const request = data[key];
      if (request?.id) {
        map.set(request.id, request);
        this.show(
          `${request.text ?? "需要用户操作"}\n/${command} ${request.id}`,
        );
      }
    }
  }
  recordUsage(runToken: string, usage: unknown) {
    const valid = normalizedUsage(usage);
    if (Object.keys(valid).length) this.usageByRun.set(runToken, valid);
    this.usage = {};
    for (const item of this.usageByRun.values())
      for (const [key, amount] of Object.entries(item))
        this.usage[key] = (this.usage[key] ?? 0) + amount;
  }
  async history(count = 100) {
    const thread = this.threadId,
      resource = this.resource;
    const result = await this.client.json(
      this.path("messages") + `&perPage=${count}&selectedPath=true`,
    );
    if (thread !== this.threadId || resource !== this.resource) return;
    for (const m of result.messages ?? []) {
      if (m.content?.runToken)
        this.recordUsage(m.content.runToken, m.content.usage);
      const parts = m.content?.parts ?? [];
      const text =
        m.content?.content ??
        parts
          .filter((p: any) => p.type === "text")
          .map((p: any) => p.text)
          .join("\n");
      const reasoning =
        m.role === "assistant"
          ? parts
              .filter((p: any) => p.type === "reasoning")
              .map((p: any) => p.text ?? p.reasoning ?? "")
              .join("\n")
          : "";
      if (text || reasoning) {
        this.messages.push({
          role: m.role === "user" ? "你" : "SEUdaily",
          text: clean(text ?? ""),
          reasoning: clean(reasoning),
          process:
            m.role === "assistant"
              ? parts.flatMap((p: any) => {
                  if (p.type === "text" || p.type === "reasoning")
                    return [
                      {
                        type: p.type,
                        text: clean(p.text ?? p.reasoning ?? ""),
                      },
                    ];
                  if (p.type === "tool-invocation") {
                    const tool = p.toolInvocation;
                    return [
                      {
                        type: "tool",
                        id: tool?.toolCallId,
                        text: clean(
                          tool?.result?.summary ??
                            `[${tool?.toolName ?? "工具"}] 完成`,
                        ),
                      },
                    ];
                  }
                  return [];
                })
              : undefined,
        });
        this.changed();
      }
      for (const p of parts)
        if (p.type === "tool-invocation") this.tool(p.toolInvocation?.result);
    }
    if (result.hasMore) this.show("还有较早记录；/history 1000 查看更多。");
  }
  async openResumePicker() {
    this.threads = await this.client.threads();
    this.page = "chat";
    this.resumePickerRequested++;
    this.changed();
    for (const thread of this.threads)
      if (!thread.title?.trim())
        this.nameThread(thread.id, thread.resourceId, "新对话");
  }
  requestDeleteThread(id: string) {
    const thread = this.threads.find((item) => item.id === id);
    if (!thread) throw new Error("找不到会话");
    this.confirm(
      "delete-thread",
      thread,
      `删除会话「${clean(thread.title || "未命名")}」及其全部消息？`,
    );
  }
  private nameThread(threadId: string, resourceId: string, titleInput: string) {
    if (this.titleTasks.has(threadId) || this.namedThreads.has(threadId))
      return;
    const task = this.titleQueue
      .then(async () => {
        const result = await this.client.json(
          "/app/conversations/title",
          "POST",
          {
            threadId,
            resourceId,
            titleInput,
          },
          AbortSignal.timeout(35_000),
        );
        if (result.title?.trim()) {
          this.namedThreads.add(threadId);
          this.threads = this.threads.map((thread) =>
            thread.id === threadId
              ? { ...thread, title: clean(result.title) }
              : thread,
          );
          this.changed();
        }
      })
      .catch(() => {
        /* A title failure must not interrupt chat; opening the list retries. */
      })
      .finally(() => {
        this.titleTasks.delete(threadId);
      });
    this.titleTasks.set(threadId, task);
    this.titleQueue = task;
  }
  async resume(target: string) {
    const latest = target === "latest";
    this.threads = await this.client.threads();
    if (target === "latest") {
      try {
        target = JSON.parse(await readFile(this.statePath, "utf8")).threadId;
      } catch {
        target = "";
      }
    }
    const selected = /^\d+$/.test(target)
      ? this.threads[Number(target) - 1]
      : (this.threads.find((t) => t.id === target) ??
        (!target || latest ? this.threads[0] : undefined));
    if (!selected) throw new Error("找不到会话，使用 /sessions 查看 ID。");
    this.page = "chat";
    this.threadId = selected.id;
    this.resource = selected.resourceId;
    this.queueItems = [];
    this.queueActive = false;
    this.queueProgress = "";
    this.queueRunToken = "";
    this.focusTarget = null;
    this.skills = [];
    this.documents = [];
    this.images = [];
    this.auth.clear();
    this.actions.clear();
    this.pending = (await this.client.json(this.path("run"))).pending;
    this.reasoningExpanded = false;
    this.messages = [];
    this.usageByRun.clear();
    this.usage = {};
    await this.save();
    await this.history(100);
    if (this.pending) this.show(`待审批：${this.pending.toolName}`);
    this.changed();
  }
  async cancel() {
    if (!this.controller && !this.operation && !this.queueActive) return;
    this.status = "正在停止";
    this.changed();
    try {
      const result = await this.client.json(
        this.path("cancel"),
        "POST",
        {
          runToken:
            this.busy && this.controller
              ? this.runToken || undefined
              : this.queueRunToken || undefined,
        },
        AbortSignal.timeout(20000),
      );
      if (result.active)
        throw new Error("任务仍在停止，请稍候；后端尚未确认结束");
      this.controller?.abort();
      this.operation?.abort();
      for (const message of this.messages)
        for (const part of message.process ?? [])
          if (part.type === "tool" && part.text.endsWith("执行中"))
            part.text = part.text.replace(/执行中$/, "已取消");
      if (this.queueActive && !this.busy) this.show("已取消");
      await this.pollQueue();
    } catch (error) {
      this.show(error instanceof Error ? error.message : String(error), "错误");
    }
    this.changed();
  }
  async turn(
    text: any,
    extra: Record<string, any> = {},
    approval = false,
    focusOptions = { respectInterval: false },
  ): Promise<number> {
    const titleThreadId = this.threadId,
      titleResourceId = this.resource;
    if (this.pending && !approval)
      throw new Error("当前会话有待审批工具，请使用 /approve 或 /reject");
    const turnImages = this.images,
      turnDocuments = this.documents;
    if (!approval) {
      this.images = [];
      this.documents = [];
    }
    const turnSkills = this.skills;
    if (!approval) this.skills = [];
    this.runToken = approval ? this.pending.runToken : randomUUID();
    if (approval) this.pending = null;
    const controller = new AbortController();
    this.controller = controller;
    await this.save();
    if (typeof text === "string")
      this.show(
        text +
          (!approval && turnImages.length
            ? "\n" +
              turnImages.map((image) => `[图片：${image.name}]`).join(" ")
            : ""),
        "你",
      );
    const input =
      typeof text === "string" && !approval && turnImages.length
        ? [
            {
              role: "user",
              content: [
                { type: "text", text },
                ...turnImages.map((image) => ({
                  type: "file",
                  data: `seudaily-image-ref:${image.ref}`,
                  filename: image.name,
                  mimeType: image.mediaType,
                })),
              ],
            },
          ]
        : text;
    this.reasoningExpanded = false;
    const message: TerminalMessage = {
      role: "SEUdaily",
      text: "",
      reasoning: "",
      process: [],
      streaming: true,
    };
    // Match the Web process sequence: only adjacent deltas of the same kind merge.
    const append = (
      type: "reasoning" | "text",
      text: string,
      startNew = false,
    ) => {
      const last = message.process!.at(-1);
      if (!startNew && last?.type === type) last.text += text;
      else message.process!.push({ type, text });
    };
    this.messages.push(message);
    this.status = "正在回答";
    this.thinking = true;
    this.changed();
    let code = 0;
    let focusRunId = "";
    try {
      if (this.focusTarget && !approval) {
        const claim = this.result(
          await this.client.json(
            `/app/focus/${encodeURIComponent(this.focusTarget.id)}/run/claim`,
            "POST",
            { force: true, respectInterval: focusOptions.respectInterval },
          ),
        );
        if (!claim.data?.claimed) throw new Error("这项关注正在执行或已暂停");
        focusRunId = claim.data.runId;
      }
      for await (const event of this.client.stream(
        {
          messages: input,
          memory: { thread: this.threadId, resource: this.resource },
          requestContext: {
            seudailyRunToken: this.runToken,
            seudailyThreadId: this.threadId,
            seudailyInterface: "cli",
            seudailySkills: turnSkills,
            seudailyToolNamespaces: [],
            seudailyDocumentRefs: turnDocuments.map((d) => d.contextRef),
            ...extra,
          },
        },
        controller.signal,
      )) {
        this.emit("event", event);
        const p = event.payload ?? {};
        if (event.type === "text-delta") {
          message.text += clean(p.text ?? "");
          append("text", clean(p.text ?? ""));
          if (p.text) {
            this.thinking = false;
            this.reasoningExpanded = false;
          }
        } else if (event.type === "reasoning-start") {
          this.status = "正在思考";
          this.thinking = true;
          append("reasoning", "", true);
        } else if (event.type === "reasoning-end") {
          this.status = "正在回答";
          this.thinking = false;
          this.reasoningExpanded = false;
        } else if (event.type === "reasoning-delta") {
          message.reasoning += clean(p.text ?? "");
          append("reasoning", clean(p.text ?? ""));
          if (this.options.verbose) this.emit("diagnostic", clean(p.text));
        } else if (event.type === "tool-call") {
          this.status = "工具：" + p.toolName;
          this.thinking = false;
          if (!this.options.quiet)
            message.process!.push({
              type: "tool",
              id: p.toolCallId,
              text: `[${p.toolName}] 执行中`,
            });
        } else if (event.type === "tool-result") {
          this.thinking = true;
          this.tool(p.result);
          if (!this.options.quiet) {
            const tool = [...message.process!]
              .reverse()
              .find((part) => part.type === "tool" && part.id === p.toolCallId);
            const text = clean(p.result?.summary ?? `[${p.toolName}] 完成`);
            if (tool) tool.text = text;
            else
              message.process!.push({ type: "tool", id: p.toolCallId, text });
          }
        } else if (event.type === "tool-approval-request") {
          this.pending = { ...p, runToken: this.runToken };
          code = 3;
        } else if (event.type === "error") {
          code = 1;
          this.show(p.error?.message ?? "模型错误", "错误");
        } else if (event.type === "finish") {
          this.recordUsage(this.runToken, p.usage);
          if (this.options.verbose)
            this.emit("diagnostic", JSON.stringify(p.usage ?? {}));
        }
        this.changed();
      }
      if (!code && message.text.trim() && typeof text === "string")
        this.nameThread(titleThreadId, titleResourceId, text);
      return code;
    } catch (error) {
      if (controller.signal.aborted) {
        code = 130;
        this.show("已取消");
        return 130;
      }
      code = 1;
      throw error;
    } finally {
      if (focusRunId)
        await this.client
          .json(
            `/app/focus/${encodeURIComponent(this.focusTarget.id)}/run/record`,
            "POST",
            {
              runId: focusRunId,
              status: code === 0 ? "completed" : "failed",
              message:
                code === 0 ? "CLI 关注对话已完成" : "CLI 关注任务中断或待审批",
            },
          )
          .catch(() => {});
      message.streaming = false;
      for (const part of message.process ?? []) part.expanded = false;
      this.reasoningExpanded = false;
      if (this.controller === controller) this.controller = null;
      this.thinking = false;
      this.status = this.pending ? "待审批" : "就绪";
      this.changed();
    }
  }
  confirm(kind: string, payload: any, text: string) {
    this.confirmation = { kind, payload, text };
    this.status = "待确认";
    this.changed();
  }
  async decide(approved: boolean) {
    const confirmation = this.confirmation;
    if (!confirmation) return;
    this.confirmation = null;
    this.status = "就绪";
    if (!approved) {
      this.show("已取消");
      return;
    }
    if (confirmation.kind === "mode") {
      const mode = confirmation.payload;
      await this.client.json("/app/settings", "POST", {
        values: {
          SEUDAILY_FULL_ACCESS: String(mode !== "normal"),
          SEUDAILY_FULL_ACCESS_EXTRA: String(mode === "extra"),
        },
      });
    } else if (confirmation.kind === "delete-thread") {
      const thread = confirmation.payload;
      await this.client.json(
        `/api/memory/threads/${encodeURIComponent(thread.id)}?resourceId=${encodeURIComponent(thread.resourceId ?? this.resource)}`,
        "DELETE",
      );
      this.threads = this.threads.filter((item) => item.id !== thread.id);
      if (this.threadId === thread.id) {
        // The server has accepted deletion: detach any remaining client stream.
        this.controller?.abort();
        this.operation?.abort();
        this.client.operationSignal = undefined;
        await this.command("/new");
      }
      this.show("会话已删除。");
      return;
    } else if (confirmation.kind === "schedule-start")
      this.result(
        await this.client.json("/app/schedule", "PUT", confirmation.payload),
      );
    else {
      this.result(
        await this.client.json(
          `/app/action-requests/${encodeURIComponent(confirmation.payload)}/execute`,
          "POST",
        ),
      );
      this.actions.delete(confirmation.payload);
    }
    this.show("操作已完成。");
  }
  async approve(approved: boolean) {
    if (!this.pending) throw new Error("没有待审批工具");
    const pending = this.pending;
    try {
      return await this.turn(
        [
          {
            role: "tool",
            content: [
              {
                type: "tool-approval-response",
                approvalId: pending.approvalId,
                approved,
              },
            ],
          },
        ],
        {},
        true,
      );
    } catch (error) {
      this.pending = (await this.client.json(this.path("run"))).pending;
      throw error;
    }
  }
  async loadSchedule(options: Record<string, any> = {}) {
    const query = new URLSearchParams({
      refresh: String(!!options.sync),
      localOnly: String(!options.sync),
      prefetchSemesters: "true",
      includeSemesters: "true",
      ...(options.semester ? { semester: options.semester } : {}),
      ...(options.date ? { date: options.date } : {}),
    });
    this.schedule = this.result(
      await this.client.json("/app/schedule?" + query),
    ).data;
    if (this.schedule.dateFilter?.reason === "missing_semester_start_date")
      throw new Error(
        "未配置学期起始日期；/schedule --start-date YYYY-MM-DD，不能据此判断当天无课。",
      );
    this.viewOptions = options;
    this.page = "schedule";
    this.changed();
  }
  async loadPrograms(options: Record<string, any> = {}) {
    this.programs = this.result(
      await this.client.json("/app/programs?refresh=" + String(!!options.sync)),
    ).data;
    this.viewOptions = options;
    this.page = "programs";
    this.changed();
  }
  async command(text: string) {
    return executeCommand(this, text, {
      welcome: () => this.welcome(),
      reportVpn: (result) => this.reportVpn(result),
    });
  }
  async attachClipboardImage(bytes: Buffer, mediaType: string) {
    if (this.attachmentLoading) throw new Error("正在添加附件，请稍候");
    if (this.documents.length + this.images.length >= MAX_ATTACHMENTS)
      throw new Error("每轮最多 10 个附件");
    if (!bytes.length || bytes.length > 10 * 1024 * 1024)
      throw new Error("图片须为 10 MB 以内");
    this.attachmentLoading = true;
    this.changed();
    try {
      const name = "clipboard.png";
      const image = await this.client.json("/app/images", "POST", {
        name,
        dataUrl: `data:${mediaType};base64,${bytes.toString("base64")}`,
      });
      this.images.push(image);
      return { id: image.ref as string, name, kind: "图片" as const };
    } finally {
      this.attachmentLoading = false;
      this.changed();
    }
  }
  async attachFile(givenPath: string) {
    if (this.attachmentLoading) throw new Error("正在添加附件，请稍候");
    if (this.documents.length + this.images.length >= MAX_ATTACHMENTS)
      throw new Error("每轮最多 10 个附件，请删除不需要的附件");
    const given = givenPath.replace(/^~(?=$|[\\/])/, homedir());
    const path = isAbsolute(given)
      ? given
      : resolve(this.options.cwd ?? this.root, given);
    const extension = extname(path).toLowerCase();
    const mediaType = imageMediaTypes[extension];
    if (
      !mediaType &&
      ![".pdf", ".docx", ".xlsx", ".pptx", ".txt", ".md"].includes(extension)
    )
      throw new Error(
        "支持 PNG/JPEG/WebP/GIF 图片和 PDF/DOCX/XLSX/PPTX/TXT/MD 文档；暂不支持此格式",
      );
    this.attachmentLoading = true;
    this.changed();
    try {
      const info = await stat(path);
      const limit = (mediaType ? 10 : 50) * 1024 * 1024;
      if (!info.isFile() || !info.size || info.size > limit)
        throw new Error(
          mediaType
            ? "图片须为 10 MB 以内的非空文件"
            : "文档须为 50 MB 以内的非空文件",
        );
      const name = path.split(/[\\/]/).at(-1)!;
      const bytes = await readFile(path);
      if (mediaType) {
        const image = await this.client.json("/app/images", "POST", {
          name,
          dataUrl: `data:${mediaType};base64,${bytes.toString("base64")}`,
        });
        this.images.push(image);
        return { id: image.ref as string, name, kind: "图片" as const };
      } else {
        const form = new FormData();
        form.set("file", new Blob([bytes]), name);
        const document = await (
          await this.client.request("/app/documents", {
            method: "POST",
            body: form,
          })
        ).json();
        this.documents.push(document);
        if (document.knowledge?.error)
          this.show("文档已添加，但自动入库失败：" + document.knowledge.error);
        return {
          id: document.contextRef as string,
          name,
          kind: "文档" as const,
        };
      }
    } finally {
      this.attachmentLoading = false;
      this.changed();
    }
  }
  removeAttachment(id: string) {
    this.images = this.images.filter((image) => image.ref !== id);
    this.documents = this.documents.filter(
      (document) => document.contextRef !== id,
    );
    this.changed();
  }
  async attachPastedFiles(text: string) {
    const paths = await pastedFilePaths(text, this.options.cwd ?? this.root);
    if (!paths) return null;
    if (
      paths.length + this.documents.length + this.images.length >
      MAX_ATTACHMENTS
    )
      throw new Error("每轮最多 10 个附件，请删除不需要的附件");
    const added = [];
    try {
      for (const path of paths) added.push(await this.attachFile(path));
      return added;
    } catch (error) {
      for (const attachment of added) this.removeAttachment(attachment.id);
      throw error;
    }
  }
  async submit(text: string): Promise<number> {
    if (this.attachmentLoading) throw new Error("附件仍在上传，请稍候再发送");
    if (text === "/cancel") {
      await this.cancel();
      return 0;
    }
    // Confirmation choices are UI actions, not prompts or input-history entries.
    if (this.confirmation) {
      await this.decide(["y", "yes"].includes(text.toLowerCase()));
      return 0;
    }
    // Browsing sessions must not be locked by a running model or another UI operation.
    if (/^\/resume(?:\s|$)/.test(text)) {
      if (this.controller && text.trim() !== "/resume")
        throw new Error("当前任务正在运行，请先取消。");
      await this.command(text);
      return 0;
    }
    if (text === "/thinking" || /^\/copy-on-select(?:\s|$)/.test(text)) {
      await this.command(text);
      return 0;
    }
    if (
      (this.busy || this.queueActive || this.queueItems.length) &&
      !text.startsWith("/") &&
      !this.confirmation
    ) {
      await this.enqueue(text);
      return 0;
    }
    if (this.busy && /^\/(?:vpn|queue)(?:\s|$)/i.test(text)) {
      await this.command(text);
      return 0;
    }
    if (this.busy) throw new Error("当前任务正在运行，请先取消。");
    this.busy = true;
    const operation = new AbortController();
    this.operation = operation;
    this.client.operationSignal = operation.signal;
    this.changed();
    try {
      await this.recordInput(text);
      return (
        (text.startsWith("/")
          ? await this.command(text)
          : await this.turn(text)) ?? 0
      );
    } catch (error) {
      if (operation.signal.aborted) {
        this.show("已取消");
        return 130;
      }
      throw error;
    } finally {
      this.operation = null;
      this.client.operationSignal = undefined;
      this.busy = false;
      this.status = this.pending
        ? "待审批"
        : this.confirmation
          ? "待确认"
          : "就绪";
      this.changed();
    }
  }
}

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
export interface Options {
  command: string;
  cwd?: string;
  resume?: string;
  prompt?: string;
  message?: string;
  skill?: string[];
  timeout?: number;
  quiet?: boolean;
  verbose?: boolean;
  json?: boolean;
  no_color?: boolean;
  vi?: boolean;
}
export const commands: Record<string, string> = {
  help: "命令帮助",
  new: "新会话",
  sessions: "历史会话",
  resume: "打开会话列表；可指定 [ID/序号/latest]",
  history: "查看完整原记录 [数量]",
  schedule: "课表 [--sync --semester ID --date YYYY-MM-DD --start-date 日期]",
  programs: "培养方案 [--sync --plan ID --filter 文字 --page N --limit N]",
  audit: "培养方案 Skill 核查",
  notices: "校园通知",
  focus: "关注任务",
  skills: "项目 Skill",
  skill: "选择 Skill NAME [问题]，off 清除",
  approve: "批准当前工具",
  reject: "拒绝当前工具",
  login: "登录续接 [schedule/ID]",
  apply: "确认本地操作 [ID]",
  mode: "权限 [normal/full/extra]",
  attach: '添加文档 "路径"',
  detach: "清空文档",
  thinking: "展开 / 折叠模型思考（Ctrl+T）",
  "copy-on-select": "拖选后自动复制 [on/off]，默认关闭",
  cancel: "取消当前任务",
  quit: "退出",
};
const aliases: Record<string, string> = {
  课表: "schedule",
  培养方案: "programs",
  技能: "skills",
  exit: "quit",
  chat: "chat",
};
export function words(text: string): string[] {
  const result: string[] = [];
  let word = "",
    quote = "";
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = "";
      else word += char;
    } else if (char === '"' || char === "'") quote = char;
    else if (/\s/.test(char)) {
      if (word) {
        result.push(word);
        word = "";
      }
    } else word += char;
  }
  if (quote) throw new Error("引号未闭合");
  if (word) result.push(word);
  return result;
}
export function flags(
  args: string[],
  allowed: Record<string, boolean>,
): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!(key in allowed)) throw new Error(`未知参数 ${key}`);
    if (!allowed[key]) result[key] = true;
    else {
      if (!args[i + 1] || args[i + 1].startsWith("--"))
        throw new Error(`${key} 缺少值`);
      result[key] = args[++i];
    }
  }
  return result;
}
export interface TerminalMessage {
  role: string;
  text: string;
  reasoning?: string;
  process?: Array<{ type: "reasoning" | "text" | "tool"; text: string; id?: string }>;
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
  thinking = false;
  page = "chat";
  schedule: any = { courses: [], availableSemesters: [] };
  programs: any = { plans: [] };
  viewOptions: Record<string, any> = {};
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
      const preference = JSON.parse(await readFile(resolve(this.root, ".seudaily/cli-preferences.json"), "utf8"));
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
    this.messages.push({ role: "系统", welcome: true,
      text: "输入消息或 / 查看命令。\n/schedule 与 /programs 打开交互表格。" });
    this.changed();
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
    const result = await this.client.json(
      this.path("messages") + `&perPage=${count}`,
    );
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
      const reasoning = m.role === "assistant"
        ? parts.filter((p: any) => p.type === "reasoning")
            .map((p: any) => p.text ?? p.reasoning ?? "").join("\n")
        : "";
      if (text || reasoning) {
        this.messages.push({
          role: m.role === "user" ? "你" : "SEUdaily",
          text: clean(text ?? ""),
          reasoning: clean(reasoning),
          process: m.role === "assistant" ? parts.flatMap((p: any) => {
            if (p.type === "text" || p.type === "reasoning")
              return [{ type: p.type, text: clean(p.text ?? p.reasoning ?? "") }];
            if (p.type === "tool-invocation") {
              const tool = p.toolInvocation;
              return [{ type: "tool", id: tool?.toolCallId,
                text: clean(tool?.result?.summary ?? `[${tool?.toolName ?? "工具"}] 完成`) }];
            }
            return [];
          }) : undefined,
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
      if (!thread.title?.trim()) this.nameThread(thread.id, thread.resourceId, "新对话");
  }
  private nameThread(threadId: string, resourceId: string, titleInput: string) {
    if (this.titleTasks.has(threadId) || this.namedThreads.has(threadId)) return;
    const task = this.titleQueue.then(async () => {
      const result = await this.client.json("/app/conversations/title", "POST", {
        threadId, resourceId, titleInput,
      }, AbortSignal.timeout(35_000));
      if (result.title?.trim()) {
        this.namedThreads.add(threadId);
        this.threads = this.threads.map((thread) => thread.id === threadId
          ? { ...thread, title: clean(result.title) } : thread);
        this.changed();
      }
    }).catch(() => { /* A title failure must not interrupt chat; opening the list retries. */ })
      .finally(() => { this.titleTasks.delete(threadId); });
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
    this.skills = [];
    this.documents = [];
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
    const controller = this.controller ?? this.operation;
    if (!controller) return;
    this.operation?.abort();
    this.status = "正在停止";
    this.changed();
    controller.abort();
    if (this.runToken)
      await this.client
        .json(
          this.path("cancel"),
          "POST",
          { runToken: this.runToken },
          new AbortController().signal,
        )
        .catch(() => {});
  }
  async turn(
    text: any,
    extra: Record<string, any> = {},
    approval = false,
  ): Promise<number> {
    const titleThreadId = this.threadId, titleResourceId = this.resource;
    if (this.pending && !approval)
      throw new Error("当前会话有待审批工具，请使用 /approve 或 /reject");
    this.runToken = approval ? this.pending.runToken : randomUUID();
    if (approval) this.pending = null;
    const controller = new AbortController();
    this.controller = controller;
    await this.save();
    if (typeof text === "string") this.show(text, "你");
    this.reasoningExpanded = false;
    const message: TerminalMessage = { role: "SEUdaily", text: "", reasoning: "", process: [], streaming: true };
    // Match the Web process sequence: only adjacent deltas of the same kind merge.
    const append = (type: "reasoning" | "text", text: string, startNew = false) => {
      const last = message.process!.at(-1);
      if (!startNew && last?.type === type) last.text += text;
      else message.process!.push({ type, text });
    };
    this.messages.push(message);
    this.status = "正在回答";
    this.thinking = true;
    this.changed();
    let code = 0;
    try {
      for await (const event of this.client.stream(
        {
          messages: text,
          memory: { thread: this.threadId, resource: this.resource },
          requestContext: {
            seudailyRunToken: this.runToken,
            seudailyThreadId: this.threadId,
            seudailyInterface: "cli",
            seudailySkills: this.skills,
            seudailyToolNamespaces: [],
            seudailyDocumentRefs: this.documents.map((d) => d.contextRef),
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
        }
        else if (event.type === "reasoning-delta") {
          message.reasoning += clean(p.text ?? "");
          append("reasoning", clean(p.text ?? ""));
          if (this.options.verbose) this.emit("diagnostic", clean(p.text));
        } else if (event.type === "tool-call") {
          this.status = "工具：" + p.toolName;
          this.thinking = false;
          if (!this.options.quiet) message.process!.push({ type: "tool", id: p.toolCallId, text: `[${p.toolName}] 执行中` });
        } else if (event.type === "tool-result") {
          this.thinking = true;
          this.tool(p.result);
          if (!this.options.quiet) {
            const tool = [...message.process!].reverse().find(part => part.type === "tool" && part.id === p.toolCallId);
            const text = clean(p.result?.summary ?? `[${p.toolName}] 完成`);
            if (tool) tool.text = text;
            else message.process!.push({ type: "tool", id: p.toolCallId, text });
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
      this.documents = [];
      if (!code && message.text.trim() && typeof text === "string")
        this.nameThread(titleThreadId, titleResourceId, text);
      return code;
    } catch (error) {
      if (controller.signal.aborted) {
        this.show("已取消");
        return 130;
      }
      throw error;
    } finally {
      message.streaming = false;
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
    if (!approved) {
      this.show("已取消");
      return;
    }
    if (confirmation.kind === "mode") {
      const mode = confirmation.payload;
      await this.client.json("/app/settings", "POST", {
        values: {
          SEUDAILY_FULL_ACCESS: String(mode === "full"),
          SEUDAILY_FULL_ACCESS_EXTRA: String(mode === "extra"),
        },
      });
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
    let [name, ...args] = words(text.slice(1));
    name = aliases[name] ?? name;
    if (
      !["schedule", "programs", "approve", "reject", "mode", "apply"].includes(
        name,
      )
    ) {
      this.page = "chat";
      this.changed();
    }
    if (name === "copy-on-select") {
      if (args.length > 1 || (args.length && !["on", "off"].includes(args[0])))
        throw new Error("/copy-on-select [on/off]");
      if (args.length) {
        this.copyOnSelect = args[0] === "on";
        await mkdir(resolve(this.root, ".seudaily"), { recursive: true });
        await writeFile(resolve(this.root, ".seudaily/cli-preferences.json"), JSON.stringify({ copyOnSelect: this.copyOnSelect }), { mode: 0o600 });
      }
      this.show("拖选后自动复制：" + (this.copyOnSelect ? "开启" : "关闭（选中后 Ctrl+C 复制）"));
      return;
    }
    if (name === "thinking") {
      this.reasoningExpanded = !this.reasoningExpanded;
      this.changed();
      return;
    }
    if (name === "chat") {
      this.page = "chat";
      this.changed();
      return;
    }
    if (name === "help") {
      this.show(
        args.length
          ? `/${args[0]}：${commands[args[0]] ?? "未知命令"}`
          : Object.entries(commands)
              .map(([n, d]) => `/${n}  ${d}`)
              .join("\n"),
      );
      return;
    }
    if (name === "new") {
      if (this.pending) this.show("原会话的待审批状态保留，可 /resume 恢复。");
      this.threadId = randomUUID();
      this.usageByRun.clear();
      this.usage = {};
      this.resource = RESOURCE;
      this.pending = this.confirmation = null;
      this.auth.clear();
      this.actions.clear();
      this.documents = [];
      this.skills = [];
      this.reasoningExpanded = false;
      this.messages = [];
      this.page = "chat";
      await this.save();
      this.welcome();
      return;
    }
    if (name === "sessions") {
      this.threads = await this.client.threads();
      this.show(
        this.threads
          .map((t, i) => `${i + 1} ${t.title || "未命名"}\n  ${t.id}`)
          .join("\n") || "暂无会话。",
      );
      return;
    }
    if (name === "resume") {
      if (args.length > 1) throw new Error("/resume [ID/序号/latest]");
      if (args.length) await this.resume(args[0]);
      else await this.openResumePicker();
      return;
    }
    if (name === "history") {
      const count = Number(args[0] ?? 100);
      if (!Number.isInteger(count) || count < 1 || count > 1000)
        throw new Error("数量必须在 1–1000 之间");
      await this.history(count);
      return;
    }
    if (name === "skills") {
      this.catalog = (await this.client.json("/app/skills")).skills;
      this.show(
        this.catalog.map((s) => `/${s.name} · ${s.description}`).join("\n") ||
          "暂无 Skill",
      );
      return;
    }
    if (
      name === "skill" ||
      name === "audit" ||
      this.catalog.some((s) => s.name === name)
    ) {
      const skill =
        name === "audit"
          ? "training-plan-audit"
          : name === "skill"
            ? args.shift()
            : name;
      const query =
        args.join(" ") ||
        (name === "audit" ? "请核查培养方案的毕业要求和学分缺口。" : "");
      if (!skill) {
        this.show("当前 Skill：" + (this.skills.join(", ") || "自动"));
        return;
      }
      if (skill === "off") {
        this.skills = [];
        this.changed();
        return;
      }
      if (!this.catalog.some((s) => s.name === skill))
        throw new Error("Skill 不存在");
      if (query) await this.turn(query, { seudailySkills: [skill] });
      else {
        this.skills = [skill];
        this.show("已选择 Skill：" + skill);
      }
      return;
    }
    if (name === "schedule" || name === "programs") {
      const parsed = flags(
        args,
        name === "schedule"
          ? {
              "--sync": false,
              "--semesters": false,
              "--semester": true,
              "--date": true,
              "--start-date": true,
              "--help": false,
              "-h": false,
            }
          : {
              "--sync": false,
              "--plan": true,
              "--page": true,
              "--limit": true,
              "--filter": true,
              "--help": false,
              "-h": false,
            },
      );
      if (parsed["--help"] || parsed["-h"]) {
        this.show(commands[name]);
        return;
      }
      const options = Object.fromEntries(
        Object.entries(parsed).map(([k, v]) => [
          k.slice(2).replace("-", "_"),
          v,
        ]),
      );
      for (const date of [options.date, options.start_date])
        if (
          date &&
          (!/^\d{4}-\d{2}-\d{2}$/.test(String(date)) ||
            new Date(String(date)).toISOString().slice(0, 10) !== date)
        )
          throw new Error("日期必须是 YYYY-MM-DD");
      if (name === "schedule") {
        if (
          options.start_date &&
          (options.sync || options.semester || options.date)
        )
          throw new Error("起始日期请单独设置");
        await this.loadSchedule(options);
        if (options.start_date) {
          const custom = structuredClone(this.schedule.customizations);
          if (!custom?.semester) throw new Error("尚无课表设置，请先同步");
          custom.semester.startDate = options.start_date;
          this.confirm(
            "schedule-start",
            custom,
            "设置学期起始日期为 " + options.start_date + "？",
          );
        }
      } else {
        if (
          (options.page &&
            (!Number.isInteger(Number(options.page)) ||
              Number(options.page) < 1)) ||
          (options.limit &&
            (!Number.isInteger(Number(options.limit)) ||
              Number(options.limit) < 1 ||
              Number(options.limit) > 100))
        )
          throw new Error("页码至少为 1，每页 1–100");
        await this.loadPrograms(options);
      }
      return;
    }
    if (name === "notices" || name === "focus") {
      if (name === "focus" && !args.length) {
        const result = this.result(await this.client.json("/app/focus"));
        this.show(
          (result.data?.items ?? [])
            .map(
              (i: any) =>
                `${i.title} · ${i.kind} · ${i.enabled ? "启用" : "停用"}\n${i.id}`,
            )
            .join("\n") || "暂无关注任务",
        );
      } else
        await this.turn(
          (name === "notices" ? "查询校园通知：" : "关注任务：") +
            (args.join(" ") || "最近通知"),
          {
            seudailyToolNamespaces: [
              name === "notices" ? "notices" : "local-actions",
            ],
          },
        );
      return;
    }
    if (name === "approve" || name === "reject") {
      if (args.length) throw new Error("只处理当前会话审批，无需参数");
      return this.approve(name === "approve");
    }
    if (name === "login") {
      const id = args[0] ?? [...this.auth.keys()].at(-1);
      if (id === "schedule") {
        this.show("请在校园登录窗口完成验证");
        const result = this.result(
          await this.client.json("/app/schedule/authorize", "POST"),
        );
        if (result.status !== "completed") throw new Error("登录尚未完成");
        this.show(result.summary);
      } else if (id && this.auth.has(id)) {
        const result = this.result(
          await this.client.json(
            `/app/auth-resumes/${encodeURIComponent(id)}/execute`,
            "POST",
          ),
        );
        if (result.status !== "completed") throw new Error("登录尚未完成");
        this.auth.delete(id);
        await this.turn(
          "登录完成，根据续接结果继续原任务，不要重复执行原调用。",
          { seudailyAuthResumeId: result.resumeId },
        );
      } else throw new Error("/login schedule 或工具返回的登录 ID");
      return;
    }
    if (name === "apply") {
      const id = args[0] ?? [...this.actions.keys()].at(-1);
      if (!id || !this.actions.has(id)) throw new Error("没有此操作请求");
      this.confirm("apply", id, this.actions.get(id).text);
      return;
    }
    if (name === "mode") {
      if (!args.length) {
        const fields = (await this.client.json("/app/settings")).fields;
        const value = (key: string) =>
          fields.find((f: any) => f.name === key)?.value === "true";
        this.show(
          "当前权限：" +
            (value("SEUDAILY_FULL_ACCESS_EXTRA")
              ? "extra"
              : value("SEUDAILY_FULL_ACCESS")
                ? "full"
                : "normal"),
        );
      } else if (
        args.length === 1 &&
        ["normal", "full", "extra"].includes(args[0])
      )
        this.confirm(
          "mode",
          args[0],
          `设为 ${args[0]}？权限与 Web 共享，full/extra 会跳过部分审批。`,
        );
      else throw new Error("/mode [normal|full|extra]");
      return;
    }
    if (name === "attach") {
      if (args.length !== 1 || this.documents.length >= 4)
        throw new Error('/attach "文档路径"，最多 4 个');
      const given = args[0].replace(/^~(?=$|[\\/])/, homedir());
      const path = isAbsolute(given) ? given : resolve(this.root, given);
      const info = await stat(path);
      if (
        !info.isFile() ||
        !info.size ||
        info.size > 50 * 1024 * 1024 ||
        ![".pdf", ".docx", ".xlsx", ".pptx"].includes(
          extname(path).toLowerCase(),
        )
      )
        throw new Error("支持不超过 50 MB 的 PDF/DOCX/XLSX/PPTX");
      const form = new FormData();
      form.set(
        "file",
        new Blob([await readFile(path)]),
        path.split(/[\\/]/).at(-1)!,
      );
      const result = await (
        await this.client.request("/app/documents", {
          method: "POST",
          body: form,
        })
      ).json();
      this.documents.push(result);
      this.show("已添加 " + args[0]);
      return;
    }
    if (name === "detach") {
      this.documents = [];
      this.show("已清空附件");
      return;
    }
    throw new Error("未知命令；/help 查看命令。");
  }
  async submit(text: string): Promise<number> {
    if (text === "/cancel") {
      await this.cancel();
      return 0;
    }
    if (text === "/thinking" || /^\/copy-on-select(?:\s|$)/.test(text)) {
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
      if (this.confirmation) {
        await this.decide(["y", "yes"].includes(text.toLowerCase()));
        return 0;
      }
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

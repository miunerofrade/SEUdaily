import type { Session } from "./session.js";
import { commands, aliases, flags, words } from "./command-parser.js";
import { RESOURCE } from "./client.js";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { stat, readFile, mkdir, writeFile } from "node:fs/promises";
import {
  diskSize,
  settingsForm,
  permissionForm,
  semesterForm,
  focusForm,
} from "./management.js";

export async function executeCommand(
  session: Session,
  text: string,
  hooks: {
    welcome: () => void;
    reportVpn: (result: any) => void;
  },
) {
  let [name, ...args] = words(text.slice(1));
  name = name.toLowerCase();
  name = aliases[name] ?? name;
  if (
    !["schedule", "programs", "approve", "reject", "mode", "apply"].includes(
      name,
    )
  ) {
    session.page = "chat";
    session.changed();
  }
  if (name === "queue") {
    if (args[0] === "resume") {
      await session.client.json(session.path("queue/resume"), "POST", {});
      await session.pollQueue();
      session.show("队列已继续");
    } else
      session.show(
        session.queueItems
          .map(
            (item) =>
              `${item.state === "running" ? "发送中" : item.state === "pending" ? "待发送" : "已暂停"}：${item.text}${item.error ? ` · ${item.error}` : ""}`,
          )
          .join("\n") || "队列为空",
      );
    return;
  }
  if (name === "vpn") {
    const action = args[0] ?? "connect";
    if (
      !["connect", "disconnect", "status", "verify", "resend"].includes(
        action,
      ) ||
      args.length > (action === "connect" ? 2 : 1)
    )
      throw new Error(
        "/vpn connect [端口]；或 disconnect / status / verify / resend",
      );
    if (action === "verify") {
      session.openForm({
        title: "VPN 额外验证",
        fields: [{ key: "code", label: "验证码", value: "", secret: true }],
        save: async (values) => {
          session.result(
            await session.client.json("/app/vpn", "POST", {
              action: "verify",
              code: values.code,
            }),
          );
          session.show("已提交 VPN 验证");
        },
      });
      return;
    }
    session.vpnState =
      action === "connect"
        ? "VPN 正在连接"
        : action === "disconnect"
          ? "VPN 正在断开"
          : "VPN 正在查询";
    session.vpnWatching = true;
    session.show(
      action === "connect"
        ? "正在连接 VPN…"
        : action === "disconnect"
          ? "正在断开 VPN…"
          : "正在查询 VPN 状态…",
    );
    try {
      const timeout = AbortSignal.timeout(15 * 60_000);
      const signal = session.operation
        ? AbortSignal.any([session.operation.signal, timeout])
        : timeout;
      const result = await session.client.json(
        "/app/vpn",
        action === "status" ? "GET" : "POST",
        action === "status"
          ? undefined
          : { action, ...(args[1] ? { port: Number(args[1]) } : {}) },
        signal,
        15 * 60,
      );
      session.vpnState = "";
      hooks.reportVpn(result);
      if (action !== "status") session.result(result);
    } catch (error) {
      session.vpnWatching = false;
      session.vpnState = "VPN 操作失败";
      session.changed();
      throw error;
    }
    return;
  }
  if (name === "settings") {
    session.openForm(await settingsForm(session));
    return;
  }
  if (name === "semester") {
    await session.loadSchedule();
    session.openForm(semesterForm(session));
    return;
  }
  if (name === "ramdisk") {
    const action = args.join(" ").toLowerCase();
    const result = await session.client.json(
      action === "reveal" ? "/app/ramdisk/reveal" : "/app/ramdisk",
      !action || action === "status" ? "GET" : "POST",
      !action || action === "status"
        ? undefined
        : action === "reveal"
          ? {}
          : {
              action: action === "unmount" ? "unmount" : "mount",
              ...(action === "unmount"
                ? {}
                : { size: diskSize(args.join(" ").replace(/^mount\s+/i, "")) }),
            },
    );
    session.result(result);
    session.show(
      result.summary || JSON.stringify(result.data ?? result, null, 2),
    );
    return;
  }
  if (name === "copy-on-select") {
    if (args.length > 1 || (args.length && !["on", "off"].includes(args[0])))
      throw new Error("/copy-on-select [on/off]");
    if (args.length) {
      session.copyOnSelect = args[0] === "on";
      await mkdir(resolve(session.root, ".seudaily"), { recursive: true });
      await writeFile(
        resolve(session.root, ".seudaily/cli-preferences.json"),
        JSON.stringify({ copyOnSelect: session.copyOnSelect }),
        { mode: 0o600 },
      );
    }
    session.show(
      "拖选后自动复制：" +
        (session.copyOnSelect ? "开启" : "关闭（选中后 Ctrl+C 复制）"),
    );
    return;
  }
  if (name === "thinking") {
    session.reasoningExpanded = !session.reasoningExpanded;
    session.changed();
    return;
  }
  if (name === "chat") {
    session.page = "chat";
    session.changed();
    return;
  }
  if (name === "help") {
    session.show(
      args.length
        ? `/${args[0]}：${commands[args[0]] ?? "未知命令"}`
        : Object.entries(commands)
            .map(([n, d]) => `/${n}  ${d}`)
            .join("\n"),
    );
    return;
  }
  if (name === "new") {
    session.focusTarget = null;
    session.resource = RESOURCE;
    if (session.pending)
      session.show("原会话的待审批状态保留，可 /resume 恢复。");
    session.threadId = randomUUID();
    session.queueItems = [];
    session.queueActive = false;
    session.queueProgress = "";
    session.queueRunToken = "";
    session.usageByRun.clear();
    session.usage = {};
    session.resource = RESOURCE;
    session.pending = session.confirmation = null;
    session.auth.clear();
    session.actions.clear();
    session.documents = [];
    session.images = [];
    session.skills = [];
    session.reasoningExpanded = false;
    session.messages = [];
    session.page = "chat";
    await session.save();
    hooks.welcome();
    return;
  }
  if (name === "sessions") {
    session.threads = await session.client.threads();
    session.show(
      session.threads
        .map((t, i) => `${i + 1} ${t.title || "未命名"}\n  ${t.id}`)
        .join("\n") || "暂无会话。",
    );
    return;
  }
  if (name === "resume") {
    if (args.length > 1) throw new Error("/resume [ID/序号/latest]");
    if (args.length) await session.resume(args[0]);
    else await session.openResumePicker();
    return;
  }
  if (name === "history") {
    const count = Number(args[0] ?? 100);
    if (!Number.isInteger(count) || count < 1 || count > 1000)
      throw new Error("数量必须在 1–1000 之间");
    await session.history(count);
    return;
  }
  if (name === "skills") {
    session.catalog = (await session.client.json("/app/skills")).skills;
    session.show(
      session.catalog.map((s) => `/${s.name} · ${s.description}`).join("\n") ||
        "暂无 Skill",
    );
    return;
  }
  if (
    name === "skill" ||
    name === "audit" ||
    session.catalog.some((s) => s.name === name)
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
      session.show("下轮 Skill：" + (session.skills.join(", ") || "自动"));
      return;
    }
    if (skill === "off") {
      session.skills = [];
      session.changed();
      return;
    }
    if (!session.catalog.some((s) => s.name === skill))
      throw new Error("Skill 不存在");
    if (query) await session.turn(query, { seudailySkills: [skill] });
    else {
      session.skills = [skill];
      session.show("已选择下轮 Skill（使用一次）：" + skill);
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
      session.show(commands[name]);
      return;
    }
    const options = Object.fromEntries(
      Object.entries(parsed).map(([k, v]) => [k.slice(2).replace("-", "_"), v]),
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
      await session.loadSchedule(options);
      if (options.start_date) {
        const custom = structuredClone(session.schedule.customizations);
        if (!custom?.semester) throw new Error("尚无课表设置，请先同步");
        custom.semester.startDate = options.start_date;
        session.confirm(
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
      await session.loadPrograms(options);
    }
    return;
  }
  if (name === "notices") {
    await session.loadNotices(true, args.join(" "));
    return;
  }
  if (name === "focus") {
    if (!args.length) {
      await session.loadFocus();
      return;
    }
    if (args[0] === "add") {
      session.openForm(focusForm(session));
      return;
    }
    if (args[0] === "run") {
      session.result(await session.client.json("/app/focus/run", "POST"));
      await session.loadFocus();
      return;
    }
    await session.turn("关注任务：" + args.join(" "), {
      seudailyToolNamespaces: ["local-actions"],
    });
    return;
  }
  if (name === "approve" || name === "reject") {
    if (args.length) throw new Error("只处理当前会话审批，无需参数");
    return session.approve(name === "approve");
  }
  if (name === "login") {
    const id = args[0] ?? [...session.auth.keys()].at(-1);
    if (id === "schedule") {
      session.show("正在通过 HTTPS 授权，需要短信时会提示输入");
      await session.authorizeCampus(
        "/app/schedule/authorize",
        async (result) => {
          if (result.status !== "completed") throw new Error("登录尚未完成");
          session.show(result.summary);
        },
      );
    } else if (id && session.auth.has(id)) {
      await session.authorizeCampus(
        `/app/auth-resumes/${encodeURIComponent(id)}/execute`,
        async (result) => {
          if (result.status !== "completed") throw new Error("登录尚未完成");
          session.auth.delete(id);
          await session.turn(
            "登录完成，根据续接结果继续原任务，不要重复执行原调用。",
            { seudailyAuthResumeId: result.resumeId },
          );
        },
      );
    } else throw new Error("/login schedule 或工具返回的登录 ID");
    return;
  }
  if (name === "apply") {
    const id = args[0] ?? [...session.actions.keys()].at(-1);
    if (!id || !session.actions.has(id)) throw new Error("没有此操作请求");
    const request = session.actions.get(id);
    session.confirm(
      "apply",
      id,
      request.text +
        (["create-focus", "create_focus"].includes(request.kind)
          ? "\n创建即授权此关注完全访问，不含 extra。"
          : ""),
    );
    return;
  }
  if (name === "knowledge") {
    const [action = "list", ...rest] = args;
    if (action === "add") {
      if (rest.length !== 1) throw new Error('/knowledge add "文件路径"');
      const path = resolve(session.options.cwd || process.cwd(), rest[0]),
        info = await stat(path);
      if (!info.isFile() || info.size > 50 * 1024 * 1024)
        throw new Error("请选择 50 MB 以内的文件");
      const form = new FormData();
      form.append(
        "file",
        new File(
          [await readFile(path)],
          path.split(/[\\/]/).at(-1) || "document",
        ),
      );
      const result = await (
        await session.client.request("/app/knowledge/documents", {
          method: "POST",
          body: form,
        })
      ).json();
      session.show(
        result.duplicate
          ? "文件已在知识库中。"
          : "已保存文件，后台将建立索引；/knowledge 查看进度。",
      );
    } else if (action === "list") {
      const result = await session.client.json("/app/knowledge");
      session.show(
        (result.configured ? "" : "请在 /settings 填写 DASHSCOPE_API_KEY。\n") +
          (result.documents
            .map(
              (document: any) =>
                `${document.name} · ${document.state} · ${document.chunkCount} 个片段\n${document.id}${document.error ? "\n" + document.error : ""}`,
            )
            .join("\n\n") ||
            "知识库暂无文件。粘贴文件路径添加文档后会自动入库。"),
      );
    } else if (action === "search") {
      const result = await session.client.json(
        "/app/knowledge/search",
        "POST",
        { query: rest.join(" ") },
      );
      session.show(
        result.summary +
          "\n" +
          result.matches
            .map(
              (match: any) =>
                `${match.name} · ${match.page ? "第 " + match.page + " 页" : "片段 " + (match.ordinal + 1)}\n${match.text}`,
            )
            .join("\n\n"),
      );
    } else if (action === "retry" && rest.length === 1) {
      await session.client.json(
        "/app/knowledge/documents/" + rest[0] + "/retry",
        "POST",
        {},
      );
      session.show("已重新排队。");
    } else if (action === "remove" && rest.length === 1) {
      await session.client.json(
        "/app/knowledge/documents/" + rest[0],
        "DELETE",
      );
      session.show("已移除知识库文件及索引，聊天附件保留。");
    } else
      throw new Error(
        '/knowledge [list|add "路径"|search 问题|retry ID|remove ID]',
      );
    return;
  }
  if (name === "permission") {
    if (!args.length) {
      const data = await session.client.json("/app/settings");
      const enabled = (key: string) =>
        data.fields.some(
          (field: any) => field.name === key && field.value === "true",
        );
      session.show(
        `当前权限：${enabled("SEUDAILY_FULL_ACCESS_EXTRA") ? "extra" : enabled("SEUDAILY_FULL_ACCESS") ? "full" : "normal"}\nnormal：逐项审批\nfull：业务与浏览器免审批\nextra：另启用工作区文件和终端\n用法：/permission normal|full|extra`,
      );
    } else if (
      args.length === 1 &&
      ["normal", "full", "extra"].includes(args[0])
    ) {
      await session.client.json("/app/settings", "POST", {
        values: {
          SEUDAILY_FULL_ACCESS: String(args[0] !== "normal"),
          SEUDAILY_FULL_ACCESS_EXTRA: String(args[0] === "extra"),
        },
      });
      session.show(
        `权限已切换为 ${args[0]}，与 Web、微信共享。已有待审批任务仍需确认或取消。`,
      );
    } else throw new Error("/permission [normal|full|extra]");
    return;
  }
  if (name === "mode") {
    if (!args.length) {
      session.openForm(await permissionForm(session));
    } else if (
      args.length === 1 &&
      ["normal", "full", "extra"].includes(args[0])
    )
      session.confirm(
        "mode",
        args[0],
        `设为 ${args[0]}？权限与 Web 共享，full/extra 会跳过部分审批。`,
      );
    else throw new Error("/mode [normal|full|extra]");
    return;
  }
  if (name === "attach") {
    if (args.length !== 1)
      throw new Error('/attach "图片或文档路径"，最多 10 个附件');
    const attachment = await session.attachFile(args[0]);
    session.show("已添加 " + attachment.name);
    return;
  }
  if (name === "detach") {
    session.documents = [];
    session.images = [];
    session.show("已清空附件");
    return;
  }
  throw new Error("未知命令；/help 查看命令。");
}

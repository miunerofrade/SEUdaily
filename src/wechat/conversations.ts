import { DEFAULT_CONVERSATION_TITLE, initialConversationMetadata } from '../shared/conversation-policy.js';
import type { ReceivedWeChatFile } from "./runtime.js";
import { createHash, randomUUID } from "node:crypto";
import { AgentStore, threadDeletionStatements } from "../agent/storage.js";
import type { AgentRuntime } from "../agent/runtime.js";
import { inferToolNamespaces } from "../agent/namespaces.js";
import {
  getPermissionMode,
  setPermissionMode,
  permissionModes,
  permissionHelp,
  type PermissionMode,
} from "../runtime/permission-state.js";
import { redactText, redactValue } from "../agent/redaction.js";
import type { BotAccount } from "./protocol.js";

export const WECHAT_RESOURCE = "seudaily-wechat-local";
export const WECHAT_HELP = `微信聊天
直接发文字，继续当前会话。
直接发文件，保存到资料库并自动索引，不调用聊天模型。

/new [名称] — 开始新会话
/sessions [页码] — 查看会话，★ 表示当前
/use 编号 — 切换会话
/delete [编号] — 删除会话，需再次确认
/context — 当前会话的摘要和最近讨论
/history [页码] — 最近对话，1 为最新
/permission [normal|full|extra] — 查看或切换权限
/approve 编号 — 确认操作（也可回复“确认 编号”）
/deny 编号 — 拒绝操作（也可回复“取消 编号”）
/help — 查看这些命令

<attachment> — 开始收集本次聊天附件
</attachment> 或 /attachment [问题] — 结束收集；没有标签时，提交最近文字和文件

完整记录也可在 SEUdaily 网页或终端查看。`;
type Inbox = {
  account: string;
  id: string;
  peer: string;
  text: string;
  threadId: string;
  resourceId: string;
  payload: string;
  files?: string;
  documents?: string;
};
const clip = (value: string, limit = 200) =>
  value.length > limit ? value.slice(0, limit) + "…" : value;
const visible = (message: any) =>
  String(
    message.content?.content ||
      message.content?.parts
        ?.filter((part: any) => part.type === "text")
        .map((part: any) => part.text ?? "")
        .join("") ||
      "",
  );

const approvalCode = (id: string) =>
  createHash("sha256").update(id).digest("hex").slice(0, 8).toUpperCase();
const matchesApprovalCode = (id: string, input: string) =>
  /^[A-F0-9]{4,8}$/.test(input) &&
  (approvalCode(id).startsWith(input) || approvalCode(id).endsWith(input));
function approvalText(run: any, fullCode = false) {
  const call = run.pendingCalls?.find(
    (call: any) => call.id === run.approval?.callId,
  );
  if (!run.approval || !call) return "当前没有待审批操作。";
  let args: any;
  try {
    args = JSON.parse(call.function.arguments);
  } catch {
    args = {};
  }
  const input = args.arguments ?? args;
  const schedule = input.schedule ?? {};
  const labels: Record<string, string> = {
    set_semester: "设置学期",
    add_schedule: "新增周期课程",
    update_schedule: "修改课程",
    move_schedule: "调整单次课程",
    add_schedule_once: "单日增课",
    cancel_schedule_once: "单日停课",
    create_focus: "创建关注",
  };
  const lines = [`待确认：${labels[input.kind] ?? call.function.name}`];
  if (input.kind === "set_semester") {
    const semester = schedule.semester ?? {};
    if (semester.name !== undefined) lines.push(`学期名称：${semester.name}`);
    if (semester.startDate !== undefined)
      lines.push(`起始日期：${semester.startDate}`);
    if (semester.totalWeeks !== undefined)
      lines.push(`总周数：${semester.totalWeeks}`);
  } else if (input.kind === "create_focus")
    lines.push(
      `关注：${input.focus?.title ?? ""}`,
      clip(String(input.focus?.description ?? ""), 300),
    );
  else if (labels[input.kind]) {
    const course = schedule.course;
    const existing = run.parts
      ?.flatMap((part: any) => part.toolInvocation?.result?.data?.courses ?? [])
      .find((course: any) => course.sourceKey === schedule.sourceKey);
    if (course?.courseName || existing?.courseName)
      lines.push(`课程：${course?.courseName ?? existing.courseName}`);
    if (schedule.date) lines.push(`日期：${schedule.date}`);
    if (schedule.fromDate) lines.push(`原日期：${schedule.fromDate}`);
    if (schedule.toDate) lines.push(`目标日期：${schedule.toDate}`);
    const fields: Record<string, string> = {
      courseName: "课程名",
      teacherName: "教师",
      classroom: "教室",
      weekday: "星期",
      startPeriod: "开始节次",
      endPeriod: "结束节次",
      weeks: "周次",
    };
    for (const [key, value] of Object.entries(schedule.changes ?? course ?? {}))
      if (fields[key])
        lines.push(
          `${fields[key]}：${Array.isArray(value) ? value.join(",") : value}`,
        );
  } else lines.push(clip(JSON.stringify(redactValue(args)), 700));
  const code = approvalCode(run.approval.id).slice(0, fullCode ? 8 : 4);
  return (
    redactText(lines.join("\n")) +
    `\n\n确认请回复：确认 ${code}\n拒绝请回复：取消 ${code}\n也可用 /approve ${code} 或 /deny ${code}。`
  );
}
type PermissionControls = {
  get: () => PermissionMode;
  set: (mode: PermissionMode) => Promise<void>;
};

/** The channel cursor is separate from threads.metadata.activeLeaf (conversation branches). */
export class WeChatConversations {
  constructor(
    private store: AgentStore,
    private agent: Pick<
      AgentRuntime,
      "runTurn" | "isActive" | "resumeApproval"
    >,
    private permission: PermissionControls = {
      get: getPermissionMode,
      set: setPermissionMode,
    },
  ) {}
  async initialize() {
    await this.store.ready;
    await this.store.client.batch([
      "CREATE TABLE IF NOT EXISTS wechat_attachment_batches (threadId TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,account TEXT NOT NULL,peer TEXT NOT NULL,files TEXT NOT NULL,text TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS wechat_sessions (account TEXT NOT NULL, peer TEXT NOT NULL, number INTEGER NOT NULL, threadId TEXT UNIQUE NOT NULL, PRIMARY KEY(account,peer,number))",
      "CREATE TABLE IF NOT EXISTS wechat_approval_decisions (account TEXT NOT NULL, id TEXT NOT NULL, threadId TEXT NOT NULL, runToken TEXT NOT NULL, approvalId TEXT NOT NULL, approved INTEGER NOT NULL, PRIMARY KEY(account,id))",
      "CREATE TABLE IF NOT EXISTS wechat_current (account TEXT NOT NULL, peer TEXT NOT NULL, threadId TEXT NOT NULL, PRIMARY KEY(account,peer))",
      "CREATE TABLE IF NOT EXISTS wechat_delete_confirmations (account TEXT NOT NULL, peer TEXT NOT NULL, threadId TEXT NOT NULL, number INTEGER NOT NULL, expiresAt INTEGER NOT NULL, PRIMARY KEY(account,peer))",
    ]);

  }
  async current(account: BotAccount) {
    const result = await this.store.client.execute({
      sql: `SELECT s.number,t.id,t.title FROM wechat_current c JOIN wechat_sessions s ON s.threadId=c.threadId JOIN threads t ON t.id=c.threadId WHERE c.account=? AND c.peer=?`,
      args: [account.botId, account.userId],
    });
    const row = result.rows[0];
    return row
      ? {
          number: Number(row.number),
          threadId: String(row.id),
          title: String(row.title || DEFAULT_CONVERSATION_TITLE),
        }
      : undefined;
  }
  private async history(threadId: string) {
    return this.store.contextMessages(threadId, WECHAT_RESOURCE);
  }
  private async context(threadId: string) {
    const selected = await this.history(threadId);
    const summary = await this.store.summary(selected.summaryKey);
    const fields: Record<string, string> = {
      goals: "目标",
      constraints: "约定",
      confirmedFacts: "已确认",
      completedActions: "已完成",
      pendingTasks: "待办",
    };
    const lines = summary
      ? Object.entries(fields).flatMap(([key, label]) => {
          const values = summary.value[key];
          return Array.isArray(values) && values.length
            ? [
                `${label}：${clip(values.map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join("；"), 220)}`,
              ]
            : [];
        })
      : [];
    if (!lines.length)
      lines.push("尚无压缩摘要；继续聊天会保留这个会话的历史。");
    const recent = selected.messages
      .filter((message) => visible(message))
      .slice(-3);
    if (recent.length)
      lines.push(
        "\n最近讨论：",
        ...recent.map(
          (message) =>
            `${message.role === "user" ? "你" : "助手"}：${clip(visible(message), 180)}`,
        ),
      );
    const files = [
      ...new Set(
        selected.messages.flatMap((message) =>
          (message.content.parts ?? [])
            .filter((part) => part.type === "file")
            .map((part) => String(part.filename || "附件")),
        ),
      ),
    ];
    if (files.length) lines.push(`\n附件：${clip(files.join("、"))}`);
    lines.push("\n/history 查看原文；完整记录在网页或终端。");
    return lines.join("\n");
  }
  async route(row: Inbox, account: BotAccount) {
    if (row.account !== account.botId || row.peer !== account.userId)
      throw new Error("微信消息不属于当前绑定");
    // Selection/new session and inbox transition commit together: reconnects cannot repeat /new.
    const tx = await this.store.client.transaction();
    let threadId = "",
      reply = "",
      state = "command";
    const text = row.text.trim();
    const approvalReply = /^(确认|同意|取消|拒绝)\s+([a-f0-9]{1,8})$/i.exec(
      text,
    );
    const hasFiles = JSON.parse(row.files || "[]").length > 0;
    const begin = /^<attachment>(?:\s*([\s\S]*))?$/.exec(text),
      end = /^<\/attachment>(?:\s*([\s\S]*))?$/.exec(text);
    const command = hasFiles
      ? null
      : begin
        ? [text, "attachment_begin", begin[1] || ""]
        : end
          ? [text, "attachment", end[1] || ""]
          : approvalReply
            ? [
                text,
                ["确认", "同意"].includes(approvalReply[1])
                  ? "approve"
                  : "deny",
                approvalReply[2],
              ]
            : /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text);
    const name = command?.[1]?.toLowerCase(),
      argument = command?.[2]?.trim() ?? "";
    try {
      const existing = (
        await tx.execute({
          sql: "SELECT state FROM wechat_messages WHERE account=? AND id=?",
          args: [row.account, row.id],
        })
      ).rows[0];
      if (existing?.state !== "received") {
        await tx.rollback();
        return;
      }
      const current = (
        await tx.execute({
          sql: `SELECT c.threadId FROM wechat_current c JOIN threads t ON t.id=c.threadId WHERE c.account=? AND c.peer=?`,
          args: [account.botId, account.userId],
        })
      ).rows[0];
      threadId = String(current?.threadId ?? "");
      if (
        (!threadId &&
          (!command ||
            ["new", "context", "history", "attachment_begin"].includes(
              name!,
            ))) ||
        name === "new"
      ) {
        const number = Number(
          (
            await tx.execute({
              sql: "SELECT COALESCE(MAX(number),0)+1 AS n FROM wechat_sessions WHERE account=? AND peer=?",
              args: [account.botId, account.userId],
            })
          ).rows[0].n,
        );
        threadId = "wechat-" + randomUUID();
        const manual = name === "new" && Boolean(argument);
        const title = manual ? clip(argument.replace(/\s+/g, " "), 40) : DEFAULT_CONVERSATION_TITLE;
        const now = new Date().toISOString();
        await tx.execute({
          sql: "INSERT INTO threads VALUES(?,?,?,?,?,?)",
          args: [
            threadId,
            WECHAT_RESOURCE,
            title,
            JSON.stringify(initialConversationMetadata(WECHAT_RESOURCE, "wechat", manual)),
            now,
            now,
          ],
        });
        await tx.execute({
          sql: "INSERT INTO wechat_sessions VALUES(?,?,?,?)",
          args: [account.botId, account.userId, number, threadId],
        });
        await tx.execute({
          sql: "INSERT INTO wechat_current VALUES(?,?,?) ON CONFLICT(account,peer) DO UPDATE SET threadId=excluded.threadId",
          args: [account.botId, account.userId, threadId],
        });
        if (name === "new")
          reply = `已新建 #${number}「${title}」\n直接发消息开始聊天。旧会话已保留，/sessions 可查看。`;
      }
      const batch = (
        await tx.execute({
          sql: "SELECT files,text FROM wechat_attachment_batches WHERE threadId=? AND account=? AND peer=?",
          args: [threadId, account.botId, account.userId],
        })
      ).rows[0];
      if (!command) {
        state = hasFiles ? "file" : "queued";
        if (batch && !hasFiles) {
          await tx.execute({
            sql: "UPDATE wechat_attachment_batches SET text=text || ? WHERE threadId=?",
            args: ["\n" + text, threadId],
          });
          state = "command";
          reply = "已记下问题。继续发送附件，最后发送 </attachment> 提交。";
        }
      } else if (name === "attachment_begin") {
        if (!batch)
          await tx.execute({
            sql: "INSERT INTO wechat_attachment_batches VALUES(?,?,?,?,?)",
            args: [threadId, account.botId, account.userId, "[]", argument],
          });
        reply =
          "开始收集聊天附件。发送文件和问题，最后发送 </attachment> 或 /attachment 提交给模型。";
      } else if (name === "attachment") {
        const pending = (
          await tx.execute({
            sql: "SELECT 1 FROM wechat_messages WHERE threadId=? AND state='file' LIMIT 1",
            args: [threadId],
          })
        ).rows.length;
        let files = JSON.parse(String(batch?.files || "[]"));
        let retrospectiveText = "";
        if (!batch && !end && argument !== "cancel") {
          const recent = (
            await tx.execute({
              sql: "SELECT text,files,documents,state FROM wechat_messages WHERE account=? AND peer=? AND threadId=? AND rowid < (SELECT rowid FROM wechat_messages WHERE account=? AND id=?) ORDER BY rowid DESC LIMIT 100",
              args: [row.account, row.peer, threadId, row.account, row.id],
            })
          ).rows;
          for (const item of recent) {
            const value = String(item.text).trim();
            if (
              /^\//.test(value) ||
              /<\/?(?:upload|attachment)>/i.test(value) ||
              JSON.parse(String(item.documents || "[]")).length
            )
              break;
            const received = JSON.parse(String(item.files || "[]"));
            if (received.length) {
              files.unshift(
                ...received.flatMap((file: any) =>
                  file.saved ? [file.saved] : [],
                ),
              );
              continue;
            }
            if (value) {
              if (retrospectiveText) break;
              retrospectiveText = value;
              if (files.length) break;
            }
          }
          files = [
            ...new Map(
              files.map((file: ReceivedWeChatFile) => [file.path, file]),
            ).values(),
          ];
        }
        if (argument === "cancel" && batch) {
          await tx.execute({
            sql: "DELETE FROM wechat_attachment_batches WHERE threadId=?",
            args: [threadId],
          });
          reply = "已取消本轮附件聊天，已上传的文件仍保存在资料库。";
        } else if (pending)
          reply = "附件还在接收，请稍后再次发送 /attachment。";
        else if (!batch && (!files.length || (!retrospectiveText && !argument)))
          reply =
            "没有找到本会话最近的文字和文件。可先发文字与文件，再发 /attachment；或使用 <attachment> 开始收集。";
        else if (!files.length)
          reply = "还没有收到附件，请先发送文件，再发送 </attachment>。";
        else {
          const prompt =
            [batch ? String(batch.text) : retrospectiveText, argument]
              .filter((value) => value.trim())
              .join("\n") ||
            "请阅读本次上传的附件，概括内容并说明可以帮助我分析哪些问题。";
          await tx.execute({
            sql: "UPDATE wechat_messages SET text=?,documents=? WHERE account=? AND id=?",
            args: [prompt, JSON.stringify(files), row.account, row.id],
          });
          await tx.execute({
            sql: "DELETE FROM wechat_attachment_batches WHERE threadId=?",
            args: [threadId],
          });
          state = "queued";
        }
      } else if (name === "help") reply = WECHAT_HELP;
      else if (name === "permission") reply = "@permission:" + argument;
      else if (name === "approve" || name === "deny") {
        const saved = (
          await tx.execute({
            sql: "SELECT state FROM runs WHERE threadId=? AND resourceId=? AND status='waiting' LIMIT 1",
            args: [threadId, WECHAT_RESOURCE],
          })
        ).rows[0];
        const run = saved ? JSON.parse(String(saved.state)) : undefined;
        if (!run?.approval)
          reply = "当前会话没有待审批操作。/sessions 和 /use 可切换会话。";
        else if (!argument) reply = approvalText(run);
        else if (!matchesApprovalCode(run.approval.id, argument.toUpperCase()))
          reply =
            "审批编号已失效、少于四位或不属于当前会话，未执行操作。\n\n" +
            approvalText(run);
        else {
          // Reject ambiguous abbreviations, including ones already consumed in this binding.
          const pending = (
            await tx.execute({
              sql: "SELECT r.state FROM runs r JOIN wechat_sessions s ON s.threadId=r.threadId WHERE s.account=? AND s.peer=? AND r.status='waiting'",
              args: [account.botId, account.userId],
            })
          ).rows;
          const consumed = (
            await tx.execute({
              sql: "SELECT d.approvalId FROM wechat_approval_decisions d JOIN wechat_messages m ON m.account=d.account AND m.id=d.id WHERE d.account=? AND m.peer=?",
              args: [account.botId, account.userId],
            })
          ).rows;
          const ids = new Set<string>(
            [
              ...pending.map(
                (row) => JSON.parse(String(row.state)).approval?.id,
              ),
              ...consumed.map((row) => String(row.approvalId)),
            ].filter(Boolean),
          );
          if (
            [...ids].filter((id) =>
              matchesApprovalCode(id, argument.toUpperCase()),
            ).length !== 1
          )
            reply =
              "这个短编号对应多个操作，请使用下面的完整编号。\n\n" +
              approvalText(run, true);
          else {
            await tx.execute({
              sql: "INSERT INTO wechat_approval_decisions VALUES(?,?,?,?,?,?)",
              args: [
                row.account,
                row.id,
                threadId,
                run.id,
                run.approval.id,
                name === "approve" ? 1 : 0,
              ],
            });
            state = "queued";
          }
        }
      } else if (name === "sessions") {
        const page = argument ? Number(argument) : 1;
        if (!Number.isSafeInteger(page) || page < 1)
          reply = "用法：/sessions [页码]，例如 /sessions 2";
        else {
          const sessions = (
            await tx.execute({
              sql: `SELECT s.number,s.threadId,t.title FROM wechat_sessions s JOIN threads t ON t.id=s.threadId WHERE s.account=? AND s.peer=? ORDER BY s.number DESC LIMIT 11 OFFSET ?`,
              args: [account.botId, account.userId, (page - 1) * 10],
            })
          ).rows;
          reply = sessions.length
            ? `会话 · 第 ${page} 页\n` +
              sessions
                .slice(0, 10)
                .map(
                  (session) =>
                    `${session.threadId === threadId ? "★" : "·"} #${session.number} ${clip(String(session.title || "新对话"), 40)}`,
                )
                .join("\n") +
              `\n\n/use 编号 切换` +
              (sessions.length > 10
                ? `；/sessions ${page + 1} 查看更早会话`
                : "")
            : "这一页没有会话。发送文字或 /new 开始聊天。";
        }
      } else if (name === "use") {
        const target = (
          await tx.execute({
            sql: `SELECT s.threadId,s.number FROM wechat_sessions s JOIN threads t ON t.id=s.threadId WHERE s.account=? AND s.peer=? AND s.number=?`,
            args: [
              account.botId,
              account.userId,
              /^[1-9]\d*$/.test(argument) ? Number(argument) : -1,
            ],
          })
        ).rows[0];
        if (!target)
          reply = "没有找到这个会话。请先发送 /sessions，再用 /use 编号切换。";
        else {
          threadId = String(target.threadId);
          await tx.execute({
            sql: "INSERT INTO wechat_current VALUES(?,?,?) ON CONFLICT(account,peer) DO UPDATE SET threadId=excluded.threadId",
            args: [account.botId, account.userId, threadId],
          });
        }
      } else if (name === "delete") {
        const parsed = argument
          ? /^([1-9]\d*)(?:\s+(确认|取消))?$/.exec(argument)
          : null;
        const number = parsed ? Number(parsed[1]) : undefined;
        const target =
          !argument || (parsed && Number.isSafeInteger(number))
            ? (
                await tx.execute({
                  sql: `SELECT s.threadId,s.number,t.title FROM wechat_sessions s JOIN threads t ON t.id=s.threadId WHERE s.account=? AND s.peer=? AND ${!argument ? "s.threadId=?" : "s.number=?"}`,
                  args: [
                    account.botId,
                    account.userId,
                    !argument ? threadId : number!,
                  ],
                })
              ).rows[0]
            : undefined;
        if (!target)
          reply =
            "没有找到这个会话。用 /sessions 查看编号，再发送 /delete 编号；不带编号表示当前会话。";
        else if (parsed?.[2] === "取消") {
          await tx.execute({
            sql: "DELETE FROM wechat_delete_confirmations WHERE account=? AND peer=? AND threadId=?",
            args: [account.botId, account.userId, String(target.threadId)],
          });
          reply = "已取消删除，会话已保留。";
        } else {
          const id = String(target.threadId),
            label = `#${target.number}「${clip(String(target.title || "新对话"), 40)}」`;
          const running =
            this.agent.isActive(id) ||
            (
              await tx.execute({
                sql: "SELECT 1 FROM runs WHERE threadId=? AND status IN ('running','waiting') LIMIT 1",
                args: [id],
              })
            ).rows.length > 0;
          const unsent =
            (
              await tx.execute({
                sql: "SELECT 1 FROM wechat_messages WHERE account=? AND peer=? AND threadId=? AND state IN ('queued','pending','file') LIMIT 1",
                args: [account.botId, account.userId, id],
              })
            ).rows.length > 0;
          if (running || unsent)
            reply = `暂时不能删除 ${label}：还有任务、待审批操作或未发送的回复。请等待完成，或在网页／终端处理后再试。`;
          else if (parsed?.[2] !== "确认") {
            await tx.execute({
              sql: "INSERT INTO wechat_delete_confirmations VALUES(?,?,?,?,?) ON CONFLICT(account,peer) DO UPDATE SET threadId=excluded.threadId,number=excluded.number,expiresAt=excluded.expiresAt",
              args: [
                account.botId,
                account.userId,
                id,
                Number(target.number),
                Date.now() + 5 * 60_000,
              ],
            });
            reply = `准备删除 ${label} 的本地会话记录，删除后无法恢复。\n\n5 分钟内发送 /delete ${target.number} 确认\n取消请发送 /delete ${target.number} 取消`;
          } else {
            const confirmation = (
              await tx.execute({
                sql: "SELECT threadId,expiresAt FROM wechat_delete_confirmations WHERE account=? AND peer=?",
                args: [account.botId, account.userId],
              })
            ).rows[0];
            if (
              confirmation?.threadId !== id ||
              Number(confirmation.expiresAt) <= Date.now()
            )
              reply = `没有有效的删除确认。请先发送 /delete ${target.number}，核对会话后再确认。`;
            else {
              for (const statement of threadDeletionStatements(id))
                await tx.execute(statement);
              await tx.execute({
                sql: "DELETE FROM wechat_approval_decisions WHERE threadId=?",
                args: [id],
              });
              await tx.execute({
                sql: "DELETE FROM wechat_current WHERE account=? AND peer=? AND threadId=?",
                args: [account.botId, account.userId, id],
              });
              await tx.execute({
                sql: "DELETE FROM wechat_delete_confirmations WHERE account=? AND peer=?",
                args: [account.botId, account.userId],
              });
              // Preserve inbound IDs as deduplication tombstones, but erase deleted text/routes.
              await tx.execute({
                sql: "UPDATE wechat_messages SET text='',reply='',payload='{}',threadId='',resourceId='' WHERE account=? AND peer=? AND threadId=? AND state='sent'",
                args: [account.botId, account.userId, id],
              });
              const deletedCurrent = threadId === id;
              if (deletedCurrent) threadId = "";
              reply = `已删除 ${label}。${deletedCurrent ? "\n下一条普通消息会新建会话；/use 编号 可切换到其他会话。" : "\n当前会话不变。"}`;
            }
          }
        }
      } else if (name !== "new" && !["context", "history"].includes(name!))
        reply = `未识别命令 /${clip(name!, 40)}。发送 /help 查看用法。`;
      // Store command state first; context/history are resolved below without holding SQLite across Agent reads.
      if (command && state !== "queued" && !reply)
        reply = "@" + name + ":" + argument;
      await tx.execute({
        sql: "UPDATE wechat_messages SET threadId=?,resourceId=?,reply=?,state=? WHERE account=? AND id=?",
        args: [threadId, WECHAT_RESOURCE, reply, state, row.account, row.id],
      });
      await tx.commit();
    } catch (error) {
      await tx.rollback();
      throw error;
    } finally {
      tx.close();
    }
  }
  async commandReply(row: Inbox & { reply: string }) {
    if (!row.reply.startsWith("@")) return row.reply;
    if (row.reply.startsWith("@permission:")) {
      const mode = row.reply.slice("@permission:".length).toLowerCase();
      if (!mode)
        return `当前权限：${this.permission.get()}\n\n${permissionHelp}\n\n切换：/permission normal|full|extra\n权限与 Web、终端共享，切换结果保存后保留。`;
      if (!permissionModes.includes(mode as PermissionMode))
        return "用法：/permission [normal|full|extra]，不带参数查看说明。";
      await this.permission.set(mode as PermissionMode);
      return `权限已切换为 ${mode}，与 Web、终端共享。已有待审批操作仍需确认或取消。`;
    }
    const thread = await this.store.getThreadById({
      threadId: row.threadId,
      resourceId: WECHAT_RESOURCE,
    });
    if (!thread) return "这个会话已在网页或终端删除。发送 /new 开始新会话。";
    const number = (
      await this.store.client.execute({
        sql: "SELECT number FROM wechat_sessions WHERE threadId=?",
        args: [row.threadId],
      })
    ).rows[0]?.number;
    const heading = `#${number}「${String(thread.title || "新对话")}」`;
    if (row.reply.startsWith("@use:")) {
      const last = (await this.history(row.threadId)).messages
        .filter((message) => visible(message))
        .at(-1);
      return `已切换到 ${heading}\n${last ? `最近${last.role === "user" ? "你说" : "回复"}：${clip(visible(last), 220)}` : "这个会话还没有消息。"}\n\n直接继续聊；/context 查看上下文。`;
    }
    if (row.reply.startsWith("@context:"))
      return `当前会话 ${heading}\n\n${await this.context(row.threadId)}`;
    const pageText = row.reply.slice("@history:".length),
      page = pageText ? Number(pageText) : 1;
    if (!Number.isSafeInteger(page) || page < 1)
      return "用法：/history [页码]，1 为最新，例如 /history 2";
    const history = (await this.history(row.threadId)).messages.filter(
      (message) => visible(message),
    );
    const end = Math.max(0, history.length - (page - 1) * 6),
      start = Math.max(0, end - 6);
    const rows = history.slice(start, end);
    return rows.length
      ? `最近对话 ${heading} · 第 ${page} 页\n\n${rows.map((message) => `${message.role === "user" ? "你" : "助手"}：${clip(visible(message), 250)}`).join("\n\n")}\n\n${start > 0 ? `/history ${page + 1} 查看更早记录；` : ""}完整原文在网页或终端。`
      : "这一页没有对话记录。";
  }
  async answer(row: Inbox, signal: AbortSignal, documentRefs?: string[]) {
    const runToken =
      "wechat-" +
      createHash("sha256")
        .update(row.account + "\0" + row.peer + "\0" + row.id)
        .digest("hex");
    const decision = (
      await this.store.client.execute({
        sql: "SELECT * FROM wechat_approval_decisions WHERE account=? AND id=? AND threadId=?",
        args: [row.account, row.id, row.threadId],
      })
    ).rows[0];
    let run = await this.store.getRun(
      decision ? String(decision.runToken) : runToken,
    );
    if (decision) {
      if (
        !run ||
        run.context.resourceId !== WECHAT_RESOURCE ||
        run.context.threadId !== row.threadId
      )
        return "审批不存在或不属于当前会话，未执行操作。";
      if (this.agent.isActive(row.threadId)) return undefined;
      if (run.status !== "waiting" || run.approval?.id !== decision.approvalId)
        return "审批已处理或已失效，未重复执行操作。";
      const events = await this.agent.resumeApproval(
        {
          approvalId: String(decision.approvalId),
          approved: Number(decision.approved) === 1,
        },
        run.context,
        signal,
      );
      for await (const event of events) {
        if (signal.aborted) return undefined;
      }
      run = await this.store.getRun(String(decision.runToken));
    } else if (!run) {
      if (this.agent.isActive(row.threadId)) return undefined;
      const waiting = await this.store.waitingRun(row.threadId);
      if (waiting) return approvalText(waiting);
      if (
        !(await this.store.getThreadById({
          threadId: row.threadId,
          resourceId: WECHAT_RESOURCE,
        }))
      )
        return "这个会话已被删除。发送 /new 开始新会话。";
      const events = await this.agent.runTurn(
        [{ role: "user", content: row.text }],
        {
          threadId: row.threadId,
          resourceId: WECHAT_RESOURCE,
          runToken,
          userMessageId: runToken + "-user",
          assistantMessageId: runToken + "-assistant",
          interface: "wechat",
          documentRefs,
          namespaces: inferToolNamespaces(row.text),
        },
        signal,
      );
      for await (const event of events) {
        if (signal.aborted) return undefined;
      }
      run = await this.store.getRun(runToken);
    }
    if (signal.aborted) return undefined;
    if (run?.status === "running") return undefined;
    const text =
      run?.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("") || "";
    if (run?.status === "waiting")
      return `${text ? clip(text, 700) + "\n\n" : ""}${approvalText(run)}`;
    if (run?.status === "cancelled" || run?.status === "interrupted")
      return "上一次回答已中断，已有记录保留，未重复执行工具。请重新发消息继续。";
    if (run?.status === "failed") {
      if (
        run.parts.some(
          (part) =>
            part.type === "error" &&
            /未配置 DEEPSEEK_API_KEY/.test(part.error?.message ?? ""),
        )
      )
        return "还没有配置模型。请在 SEUdaily 网页或终端的设置中配置模型，然后重新发送。会话管理命令仍可使用。";
      return `${text ? clip(text, 1300) + "\n\n" : ""}这次回答未完成，请在网页或终端查看详情和模型配置，再重新发送。`;
    }
    return redactText(text || "回答已完成，详细结果请在网页或终端查看。");
  }
  async fileReceipt(row: Inbox, files: ReceivedWeChatFile[]) {
    if (this.agent.isActive(row.threadId)) return undefined;
    const collecting =
      (
        await this.store.client.execute({
          sql: "SELECT threadId FROM wechat_attachment_batches WHERE threadId=?",
          args: [row.threadId],
        })
      ).rows.length > 0;
    const reply =
      files
        .map(
          (file) =>
            `已保存《${file.name}》${["queued", "indexed", "processing"].includes(file.state) ? "，已加入后台索引" : file.state === "waiting_config" ? "，配置百炼密钥后自动索引" : file.state === "unsupported" ? "，该格式暂不索引" : "，暂未索引，请在资料库检查"}`,
        )
        .join("\n") +
      (collecting
        ? "\n附件已收集；继续发送文件或问题，最后发送 </attachment> 提交。"
        : "\n原文件在资料库 → 上传文件；可以继续发文件或提问。");
    const id =
      "wechat-file-" +
      createHash("sha256")
        .update(row.account + "\0" + row.id)
        .digest("hex");
    const tx = await this.store.client.transaction("write");
    try {
      const thread = (
        await tx.execute({
          sql: "SELECT metadata FROM threads WHERE id=? AND resourceId=?",
          args: [row.threadId, WECHAT_RESOURCE],
        })
      ).rows[0];
      if (!thread) throw new Error("会话已删除");
      const existing = (
        await tx.execute({
          sql: "SELECT id FROM messages WHERE id=?",
          args: [id + "-user"],
        })
      ).rows.length;
      if (!existing) {
        const batch = (
          await tx.execute({
            sql: "SELECT files FROM wechat_attachment_batches WHERE threadId=? AND account=? AND peer=?",
            args: [row.threadId, row.account, row.peer],
          })
        ).rows[0];
        if (batch) {
          const collected = JSON.parse(
            String(batch.files),
          ) as ReceivedWeChatFile[];
          const unique = new Map(
            [...collected, ...files].map((file) => [file.path, file]),
          );
          if (unique.size > 10)
            throw new Error(
              "本轮聊天附件最多 10 个，新文件已保存到资料库；先结束本轮再开始下一轮",
            );
          await tx.execute({
            sql: "UPDATE wechat_attachment_batches SET files=? WHERE threadId=?",
            args: [JSON.stringify([...unique.values()]), row.threadId],
          });
        }
        const metadata = JSON.parse(String(thread.metadata)),
          now = new Date().toISOString();
        const parts = files.map((file) => ({
          type: "file",
          filename: file.name,
          path: file.path,
        }));
        const content =
          row.text || "上传文件：" + files.map((file) => file.name).join("、");
        const user = {
          content,
          parts,
          parentId: metadata.activeLeaf ?? null,
          modelMessages: [{ role: "user", content }],
        };
        const assistant = {
          content: reply,
          parts: [{ type: "text", text: reply }],
          parentId: id + "-user",
        };
        for (const [messageId, role, content] of [
          [id + "-user", "user", user],
          [id + "-assistant", "assistant", assistant],
        ] as const)
          await tx.execute({
            sql: "INSERT INTO messages(id,threadId,resourceId,role,content,createdAt) VALUES(?,?,?,?,?,?)",
            args: [
              messageId,
              row.threadId,
              WECHAT_RESOURCE,
              role,
              JSON.stringify(content),
              now,
            ],
          });
        await tx.execute({
          sql: "UPDATE threads SET metadata=?,updatedAt=? WHERE id=?",
          args: [
            JSON.stringify({ ...metadata, activeLeaf: id + "-assistant" }),
            now,
            row.threadId,
          ],
        });
      }
      await tx.commit();
      return reply;
    } catch (error) {
      await tx.rollback();
      throw error;
    } finally {
      tx.close();
    }
  }
  async label(threadId: string) {
    const thread = await this.store.getThreadById({
      threadId,
      resourceId: WECHAT_RESOURCE,
    });
    return String(thread?.title || "旧会话");
  }
}

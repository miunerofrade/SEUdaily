import { createHash, randomUUID } from 'node:crypto';
import { AgentStore } from '../agent/storage.js';
import type { AgentRuntime } from '../agent/runtime.js';
import { inferToolNamespaces } from '../agent/namespaces.js';
import { redactText } from '../agent/redaction.js';
import type { BotAccount } from './protocol.js';

export const WECHAT_RESOURCE = 'seudaily-wechat-local';
export const WECHAT_HELP = `微信聊天
直接发文字，继续当前会话。

/new [名称] — 开始新会话
/sessions [页码] — 查看会话，★ 表示当前
/use 编号 — 切换会话
/context — 当前会话的摘要和最近讨论
/history [页码] — 最近对话，1 为最新
/help — 查看这些命令

完整记录也可在 SEUdaily 网页或终端查看。`;
type Inbox = { account: string; id: string; peer: string; text: string; threadId: string; resourceId: string; payload: string };
const clip = (value: string, limit = 200) => value.length > limit ? value.slice(0, limit) + '…' : value;
const visible = (message: any) => String(message.content?.content || message.content?.parts?.filter((part: any) => part.type === 'text').map((part: any) => part.text ?? '').join('') || '');

/** The channel cursor is separate from threads.metadata.activeLeaf (conversation branches). */
export class WeChatConversations {
  constructor(private store: AgentStore, private agent: Pick<AgentRuntime, 'runTurn' | 'isActive'>) {}
  async initialize() {
    await this.store.ready;
    await this.store.client.batch([
      'CREATE TABLE IF NOT EXISTS wechat_sessions (account TEXT NOT NULL, peer TEXT NOT NULL, number INTEGER NOT NULL, threadId TEXT UNIQUE NOT NULL, PRIMARY KEY(account,peer,number))',
      'CREATE TABLE IF NOT EXISTS wechat_current (account TEXT NOT NULL, peer TEXT NOT NULL, threadId TEXT NOT NULL, PRIMARY KEY(account,peer))',
    ]);
  }
  async current(account: BotAccount) {
    const result = await this.store.client.execute({ sql: `SELECT s.number,t.id,t.title FROM wechat_current c JOIN wechat_sessions s ON s.threadId=c.threadId JOIN threads t ON t.id=c.threadId WHERE c.account=? AND c.peer=?`, args: [account.botId, account.userId] });
    const row = result.rows[0];
    return row ? { number: Number(row.number), threadId: String(row.id), title: String(row.title || '微信 · 新对话') } : undefined;
  }
  private async history(threadId: string) {
    return this.store.contextMessages(threadId, WECHAT_RESOURCE);
  }
  private async context(threadId: string) {
    const selected = await this.history(threadId);
    const summary = await this.store.summary(selected.summaryKey);
    const fields: Record<string, string> = { goals: '目标', constraints: '约定', confirmedFacts: '已确认', completedActions: '已完成', pendingTasks: '待办' };
    const lines = summary ? Object.entries(fields).flatMap(([key, label]) => {
      const values = summary.value[key];
      return Array.isArray(values) && values.length ? [`${label}：${clip(values.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join('；'), 220)}`] : [];
    }) : [];
    if (!lines.length) lines.push('尚无压缩摘要；继续聊天会保留这个会话的历史。');
    const recent = selected.messages.filter(message => visible(message)).slice(-3);
    if (recent.length) lines.push('\n最近讨论：', ...recent.map(message => `${message.role === 'user' ? '你' : '助手'}：${clip(visible(message), 180)}`));
    const files = [...new Set(selected.messages.flatMap(message => (message.content.parts ?? []).filter(part => part.type === 'file').map(part => String(part.filename || '附件'))))];
    if (files.length) lines.push(`\n附件：${clip(files.join('、'))}`);
    lines.push('\n/history 查看原文；完整记录在网页或终端。');
    return lines.join('\n');
  }
  async route(row: Inbox, account: BotAccount) {
    if (row.account !== account.botId || row.peer !== account.userId) throw new Error('微信消息不属于当前绑定');
    // Selection/new session and inbox transition commit together: reconnects cannot repeat /new.
    const tx = await this.store.client.transaction();
    let threadId = '', reply = '', state = 'command';
    const text = row.text.trim();
    const command = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text);
    const name = command?.[1]?.toLowerCase(), argument = command?.[2]?.trim() ?? '';
    try {
      const existing = (await tx.execute({sql:"SELECT state FROM wechat_messages WHERE account=? AND id=?",args:[row.account,row.id]})).rows[0];
      if (existing?.state !== 'received') { await tx.rollback(); return; }
      const current = (await tx.execute({sql:`SELECT c.threadId FROM wechat_current c JOIN threads t ON t.id=c.threadId WHERE c.account=? AND c.peer=?`,args:[account.botId,account.userId]})).rows[0];
      threadId = String(current?.threadId ?? '');
      if ((!threadId && (!command || ['new','context','history'].includes(name!))) || name === 'new') {
        const number = Number((await tx.execute({sql:'SELECT COALESCE(MAX(number),0)+1 AS n FROM wechat_sessions WHERE account=? AND peer=?',args:[account.botId,account.userId]})).rows[0].n);
        threadId = 'wechat-' + randomUUID();
        const title = '微信 · ' + (name === 'new' && argument ? clip(argument.replace(/\s+/g,' '), 40) : !command ? clip(text.replace(/\s+/g,' '), 24) : '新对话');
        const now = new Date().toISOString();
        await tx.execute({sql:'INSERT INTO threads VALUES(?,?,?,?,?,?)',args:[threadId,WECHAT_RESOURCE,title,JSON.stringify({channel:'wechat'}),now,now]});
        await tx.execute({sql:'INSERT INTO wechat_sessions VALUES(?,?,?,?)',args:[account.botId,account.userId,number,threadId]});
        await tx.execute({sql:'INSERT INTO wechat_current VALUES(?,?,?) ON CONFLICT(account,peer) DO UPDATE SET threadId=excluded.threadId',args:[account.botId,account.userId,threadId]});
        if (name === 'new') reply = `已新建 #${number}「${title.replace(/^微信 · /,'')}」\n直接发消息开始聊天。旧会话已保留，/sessions 可查看。`;
      }
      if (!command) state = 'queued';
      else if (name === 'help') reply = WECHAT_HELP;
      else if (name === 'sessions') {
        const page = argument ? Number(argument) : 1;
        if (!Number.isSafeInteger(page) || page < 1) reply = '用法：/sessions [页码]，例如 /sessions 2';
        else {
          const sessions = (await tx.execute({sql:`SELECT s.number,s.threadId,t.title FROM wechat_sessions s JOIN threads t ON t.id=s.threadId WHERE s.account=? AND s.peer=? ORDER BY s.number DESC LIMIT 11 OFFSET ?`,args:[account.botId,account.userId,(page-1)*10]})).rows;
          reply = sessions.length ? `会话 · 第 ${page} 页\n` + sessions.slice(0,10).map(session => `${session.threadId === threadId ? '★' : '·'} #${session.number} ${clip(String(session.title || '新对话').replace(/^微信 · /,''),40)}`).join('\n') + `\n\n/use 编号 切换` + (sessions.length > 10 ? `；/sessions ${page+1} 查看更早会话` : '') : '这一页没有会话。发送文字或 /new 开始聊天。';
        }
      } else if (name === 'use') {
        const target = (await tx.execute({sql:`SELECT s.threadId,s.number FROM wechat_sessions s JOIN threads t ON t.id=s.threadId WHERE s.account=? AND s.peer=? AND s.number=?`,args:[account.botId,account.userId,/^[1-9]\d*$/.test(argument) ? Number(argument) : -1]})).rows[0];
        if (!target) reply = '没有找到这个会话。请先发送 /sessions，再用 /use 编号切换。';
        else {
          threadId = String(target.threadId);
          await tx.execute({sql:'INSERT INTO wechat_current VALUES(?,?,?) ON CONFLICT(account,peer) DO UPDATE SET threadId=excluded.threadId',args:[account.botId,account.userId,threadId]});
        }
      } else if (name !== 'new' && !['context','history'].includes(name!)) reply = `未识别命令 /${clip(name!,40)}。发送 /help 查看用法。`;
      // Store command state first; context/history are resolved below without holding SQLite across Agent reads.
      if (command && !reply) reply = '@' + name + ':' + argument;
      await tx.execute({sql:'UPDATE wechat_messages SET threadId=?,resourceId=?,reply=?,state=? WHERE account=? AND id=?',args:[threadId,WECHAT_RESOURCE,reply,state,row.account,row.id]});
      await tx.commit();
    } catch (error) { await tx.rollback(); throw error; }
    finally { tx.close(); }
  }
  async commandReply(row: Inbox & {reply:string}) {
    if (!row.reply.startsWith('@')) return row.reply;
    const thread = await this.store.getThreadById({threadId:row.threadId,resourceId:WECHAT_RESOURCE});
    if (!thread) return '这个会话已在网页或终端删除。发送 /new 开始新会话。';
    const number = (await this.store.client.execute({sql:'SELECT number FROM wechat_sessions WHERE threadId=?',args:[row.threadId]})).rows[0]?.number;
    const heading = `#${number}「${String(thread.title || '新对话').replace(/^微信 · /,'')}」`;
    if (row.reply.startsWith('@use:')) {
      const last = (await this.history(row.threadId)).messages.filter(message => visible(message)).at(-1);
      return `已切换到 ${heading}\n${last ? `最近${last.role === 'user' ? '你说' : '回复'}：${clip(visible(last),220)}` : '这个会话还没有消息。'}\n\n直接继续聊；/context 查看上下文。`;
    }
    if (row.reply.startsWith('@context:')) return `当前会话 ${heading}\n\n${await this.context(row.threadId)}`;
    const pageText = row.reply.slice('@history:'.length), page = pageText ? Number(pageText) : 1;
    if (!Number.isSafeInteger(page) || page < 1) return '用法：/history [页码]，1 为最新，例如 /history 2';
    const history = (await this.history(row.threadId)).messages.filter(message => visible(message));
    const end = Math.max(0,history.length - (page-1)*6), start = Math.max(0,end-6);
    const rows = history.slice(start,end);
    return rows.length ? `最近对话 ${heading} · 第 ${page} 页\n\n${rows.map(message => `${message.role === 'user' ? '你' : '助手'}：${clip(visible(message),250)}`).join('\n\n')}\n\n${start > 0 ? `/history ${page+1} 查看更早记录；` : ''}完整原文在网页或终端。` : '这一页没有对话记录。';
  }
  async answer(row: Inbox, signal: AbortSignal) {
    const runToken = 'wechat-' + createHash('sha256').update(row.account + '\0' + row.peer + '\0' + row.id).digest('hex');
    let run = await this.store.getRun(runToken);
    if (!run) {
      if (this.agent.isActive(row.threadId)) return undefined;
      if (await this.store.waitingRun(row.threadId)) return '这个会话有待确认的操作，请在网页或终端打开同一会话完成确认，再继续聊天。';
      if (!await this.store.getThreadById({threadId:row.threadId,resourceId:WECHAT_RESOURCE})) return '这个会话已被删除。发送 /new 开始新会话。';
      const events = await this.agent.runTurn([{role:'user',content:row.text}],{threadId:row.threadId,resourceId:WECHAT_RESOURCE,runToken,userMessageId:runToken+'-user',assistantMessageId:runToken+'-assistant',interface:'wechat',namespaces:inferToolNamespaces(row.text)},signal);
      for await (const event of events) { if (signal.aborted) return undefined; }
      run = await this.store.getRun(runToken);
    }
    if (signal.aborted) return undefined;
    if (run?.status === 'running') return undefined;
    const text = run?.parts.filter(part => part.type === 'text').map(part => part.text ?? '').join('') || '';
    if (run?.status === 'waiting') return `${text ? clip(text,1300)+'\n\n' : ''}需要确认操作，请在网页或终端打开同一会话处理。微信不会自动批准。`;
    if (run?.status === 'cancelled' || run?.status === 'interrupted') return '上一次回答已中断，已有记录保留，未重复执行工具。请重新发消息继续。';
    if (run?.status === 'failed') {
      if (run.parts.some(part => part.type === 'error' && /未配置 DEEPSEEK_API_KEY/.test(part.error?.message ?? ''))) return '还没有配置模型。请在 SEUdaily 网页或终端的设置中配置模型，然后重新发送。会话管理命令仍可使用。';
      return `${text ? clip(text,1300)+'\n\n' : ''}这次回答未完成，请在网页或终端查看详情和模型配置，再重新发送。`;
    }
    return redactText(text || '回答已完成，详细结果请在网页或终端查看。');
  }
  async label(threadId: string) {
    const thread = await this.store.getThreadById({threadId,resourceId:WECHAT_RESOURCE});
    return String(thread?.title || '旧会话').replace(/^微信 · /,'');
  }
}

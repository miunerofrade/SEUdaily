import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import QRCode from 'qrcode';
import type {WeChatFile} from './media.js';
export type ReceivedWeChatFile = {name:string;path:string;state:string};
export type WeChatFileReceiver = (name:string,bytes:Buffer,source:string)=>Promise<ReceivedWeChatFile>;
import type { LocalClient } from '../agent/sqlite.js';
import type { WeChatConversations } from './conversations.js';
import { redactText } from '../agent/redaction.js';
import { WeChatProtocol, WeChatError, WECHAT_API, trustedWeChatBase, type BotAccount, type WeChatMessage } from './protocol.js';
export const DEMO_THREAD = 'wechat-demo';
export const DEMO_RESOURCE = 'seudaily-wechat-demo';
type Login = { id: string; qr: string; base: string; state: string; modules: string; size: number; code?: string; createdAt: number };
const loginStates = new Set(['wait', 'scaned', 'need_verifycode', 'verify_code_blocked', 'expired']);
export class WeChatRuntime {
  private account?: BotAccount;
  private notifiedAccount?: BotAccount;
  private login?: Login;
  private error = '';
  private ready?: Promise<void>;
  private controller?: AbortController;
  private running?: Promise<void>;
  private changing = Promise.resolve();
  private closed = false;
  private flushing = false;
  private nextFlushAt = 0;
  private flushFailures = 0;
  private workers = new Map<string, Promise<void>>();
  constructor(private db: LocalClient, private protocol = new WeChatProtocol(), private pollDelay = 1000, private conversations?: WeChatConversations,private receiveFile?:WeChatFileReceiver,private prepareFiles?:(files:ReceivedWeChatFile[],signal:AbortSignal)=>Promise<string[]>) {}
  initialize() {
    return this.ready ??= (async () => {
      await this.db.batch([
        'CREATE TABLE IF NOT EXISTS wechat_account (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL)',
        `CREATE TABLE IF NOT EXISTS wechat_messages (account TEXT NOT NULL, id TEXT NOT NULL, peer TEXT NOT NULL, session TEXT NOT NULL, text TEXT NOT NULL, reply TEXT NOT NULL, threadId TEXT NOT NULL, resourceId TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL, createdAt INTEGER NOT NULL, PRIMARY KEY(account,id))`,
        'CREATE INDEX IF NOT EXISTS wechat_pending ON wechat_messages(account,peer,state,createdAt)',
        'CREATE INDEX IF NOT EXISTS wechat_recent ON wechat_messages(account,peer,createdAt DESC)',
      ]);
      const columns=new Set((await this.db.execute('PRAGMA table_info(wechat_messages)')).rows.map(row=>String(row.name)));
      for (const [name,type] of [['files',"TEXT NOT NULL DEFAULT '[]'"],['documents',"TEXT NOT NULL DEFAULT '[]'"],['sourceCreatedAt','INTEGER'],['preparedAt','INTEGER'],['sentAt','INTEGER']] as const) {
        if (!columns.has(name)) await this.db.execute(`ALTER TABLE wechat_messages ADD COLUMN ${name} ${type}`);
      }
      await this.conversations?.initialize();
      const data = (await this.db.execute('SELECT data FROM wechat_account WHERE id=1')).rows[0]?.data;
      if (data) {
        let account;
        try { account = JSON.parse(String(data)); } catch { throw new Error('微信凭证数据损坏，已保留原数据'); }
        if (!account || typeof account !== 'object' || typeof account.token !== 'string' || !account.token || typeof account.botId !== 'string' || !account.botId || typeof account.userId !== 'string' || !account.userId || typeof account.cursor !== 'string' || typeof account.needsLogin !== 'boolean') throw new Error('微信凭证数据损坏，已保留原数据');
        this.account = { ...account, base: trustedWeChatBase(account.base) };
      }
    })();
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.changing.then(operation);
    this.changing = next.then(() => {}, () => {}); return next;
  }
  async start() { await this.initialize(); this.resume(); }
  private resume() {
    if (this.closed || this.running || (!this.login && (!this.account || this.account.needsLogin))) return;
    const controller = new AbortController(); this.controller = controller;
    this.running = this.loop(controller.signal).catch(() => { this.error = '微信运行失败；请查看连接状态并重试'; }).finally(() => { this.running = undefined; });
  }
  private async halt() {
    this.controller?.abort(); await this.running; this.running = undefined;
    if (this.notifiedAccount && typeof this.protocol.notify === 'function') {
      const account = this.notifiedAccount; this.notifiedAccount = undefined;
      await this.protocol.notify(account,'stop',AbortSignal.timeout(3000)).catch(() => {console.warn('微信停止通知失败，凭证和消息已保留');});
    }
  }
  async close() { this.closed = true; this.controller?.abort(); await this.changing; await this.halt(); }
  async status() {
    await this.initialize();
    const account = this.account;
    const currentSession = account ? await this.conversations?.current(account) : undefined;
    const rows = account ? (await this.db.execute({sql:'SELECT id,peer,session,text,reply,threadId,resourceId,state,createdAt,sourceCreatedAt,preparedAt,sentAt FROM wechat_messages WHERE account=? AND peer=? ORDER BY createdAt DESC LIMIT 6',args:[account.botId,account.userId]})).rows : [];
    return { state: this.login?.state ?? (account ? account.needsLogin ? 'needs_login' : 'connected' : 'disconnected'),
      loginId: this.login?.id, qr: this.login ? { size: this.login.size, modules: this.login.modules } : undefined,
      botId: account?.botId, userId: account?.userId, threadId: currentSession?.threadId ?? (this.conversations ? '' : DEMO_THREAD), resourceId: this.conversations ? 'seudaily-wechat-local' : DEMO_RESOURCE,
      currentSession,
      error: this.error, messages: rows };
  }
  connect(refresh = false) {
    return this.serialize(async () => {
      await this.initialize();
      if (this.closed) throw new Error('后端正在停止');
      if (!refresh && (this.login || this.account && !this.account.needsLogin)) { this.resume(); return this.status(); }
      await this.halt(); this.login = undefined; this.error = '';
      try {
        // Retain existing credentials until a replacement is confirmed.
        const controller = new AbortController(); this.controller = controller;
        const result = await this.protocol.qr(AbortSignal.any([controller.signal,AbortSignal.timeout(15000)]), this.account ? [this.account.token] : []);
        if (this.closed) throw new Error('后端正在停止');
        if (typeof result.qrcode !== 'string' || !result.qrcode || typeof result.qrcode_img_content !== 'string' || !result.qrcode_img_content || result.qrcode_img_content.length > 4096) throw new Error('微信未返回有效二维码');
        const qr = QRCode.create(result.qrcode_img_content, {errorCorrectionLevel:'M'});
        this.login = { id: randomUUID(), qr: result.qrcode, base: WECHAT_API, state: 'wait', size: qr.modules.size, modules: Array.from(qr.modules.data).join(''), createdAt: Date.now() };
      } catch (error) { this.error = error instanceof WeChatError ? error.message : '获取微信二维码失败，请重试'; this.resume(); throw new Error(this.error); }
      this.resume(); return this.status();
    });
  }
  verify(loginId: string, code: string) {
    return this.serialize(async () => {
      if (!this.login || this.login.id !== loginId || this.login.state !== 'need_verifycode') throw new Error('验证码请求已失效，请刷新连接状态');
      if (!/^[0-9A-Za-z]{4,12}$/.test(code)) throw new Error('请输入手机上显示的验证码（4–12 位字母或数字）');
      this.login.code = code; this.error = ''; return this.status();
    });
  }
  cancelLogin() {
    return this.serialize(async () => { await this.halt(); this.login = undefined; this.error = ''; this.resume(); return this.status(); });
  }
  private saveAccount(account: BotAccount) { return this.db.execute({sql:'INSERT INTO wechat_account(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',args:[JSON.stringify(account)]}); }
  private async pauseExpired() {
    if (!this.account) return;
    this.account = {...this.account,needsLogin:true};
    await this.db.execute("UPDATE wechat_account SET data=json_set(data,'$.needsLogin',json('true')) WHERE id=1");
    this.controller?.abort();
  }
  private async pollLogin(signal: AbortSignal) {
    const login = this.login!;
    if (Date.now() - login.createdAt > 5 * 60_000) { login.state = 'expired'; return; }
    if (['expired','verify_code_blocked'].includes(login.state) || login.state === 'need_verifycode' && !login.code) return;
    const code = login.code; login.code = undefined;
    const result = await this.protocol.qrStatus(login.base, login.qr, AbortSignal.any([signal, AbortSignal.timeout(35000)]), code);
    if (signal.aborted || this.login !== login) return;
    if (result.status === 'confirmed') {
      if (![result.bot_token,result.ilink_bot_id,result.ilink_user_id].every(value => typeof value === 'string' && value.length > 0)) throw new Error('登录凭证不完整');
      const account: BotAccount = { token:result.bot_token, botId:result.ilink_bot_id, userId:result.ilink_user_id, base:trustedWeChatBase(result.baseurl || login.base), cursor: this.account?.botId === result.ilink_bot_id && this.account?.userId === result.ilink_user_id ? this.account!.cursor : '', needsLogin:false };
      await this.saveAccount(account); this.account = account; this.login = undefined; this.error = '';
    } else if (result.status === 'scaned_but_redirect') {
      if (result.redirect_host) login.base = trustedWeChatBase(result.redirect_host);
      login.state = 'scaned';
    } else if (result.status === 'binded_redirect') {
      if (this.account && !this.account.needsLogin) { this.login = undefined; this.error = ''; }
      else { login.state = 'expired'; this.error = '微信报告已绑定，但本地没有有效凭证；请在微信解除旧绑定后重新扫码'; }
    } else if (loginStates.has(result.status)) { login.state = result.status; this.error = ''; }
    else throw new Error('未知微信登录状态');
  }
  private incoming(account: BotAccount, msg: WeChatMessage) {
    // The first demo is private: accept only the user who enrolled this bot.
    if (msg.message_type !== undefined && msg.message_type !== 1 || msg.message_state !== undefined && ![0,2].includes(msg.message_state) || msg.group_id || msg.from_user_id !== account.userId || !msg.context_token || msg.to_user_id && msg.to_user_id !== account.botId) return undefined;
    const sourceId = msg.message_id ?? msg.client_id;
    if (typeof sourceId !== 'string' || typeof msg.context_token !== 'string' || msg.session_id !== undefined && typeof msg.session_id !== 'string') return undefined;
    if (!sourceId || !Array.isArray(msg.item_list)) return undefined;
    const files = msg.item_list.filter(item=>item.type===4 && item.file_item).map(item=>{const file=item.file_item!;return {file_name:typeof file.file_name==='string' ? file.file_name : undefined,len:typeof file.len==='string' ? file.len : undefined,media:file.media ? {full_url:file.media.full_url,encrypt_query_param:file.media.encrypt_query_param,aes_key:file.media.aes_key,encrypt_type:file.media.encrypt_type} : undefined};});
    const text = msg.item_list.filter(item => item.type === 1 && typeof item.text_item?.text === 'string').map(item => item.text_item!.text).join('\n');
    const unsupported = msg.item_list.some(item => item.type !== 1 && !(item.type===4 && item.file_item && this.receiveFile));
    if (!text && !unsupported && !files.length) return undefined;
    const id = String(sourceId), peer = msg.from_user_id, session = msg.session_id ?? '';
    const reply = unsupported ? '目前支持文字和文件上传；图片、语音及视频暂未接入。文件请作为原文件发送。' : this.conversations ? '' : `SEUdaily 微信 demo\n会话：${DEMO_THREAD}\n消息：${id}\n${text.slice(0,1200)}`;
    const clientId = 'seudaily-' + createHash('sha256').update(`${account.botId}\0${peer}\0${id}`).digest('hex').slice(0,40);
    const payload = {from_user_id:'',to_user_id:peer,client_id:clientId,message_type:2,message_state:2,context_token:msg.context_token,item_list:[{type:1,text_item:{text:reply}}]};
    return {sql:`INSERT OR IGNORE INTO wechat_messages(account,id,peer,session,text,reply,threadId,resourceId,payload,state,createdAt,files,sourceCreatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,args:[account.botId,id,peer,session,text,reply,this.conversations ? '' : DEMO_THREAD,this.conversations ? '' : DEMO_RESOURCE,JSON.stringify(payload),this.conversations && !unsupported ? 'received' : 'pending',Date.now(),JSON.stringify(files),Number.isFinite(msg.create_time_ms) ? msg.create_time_ms! : null]};
  }
  private async prepareReply(row: any, text: string) {
    // Keep one reply/client_id per inbound message; complete long answers remain in Agent history.
    const characters = Array.from(redactText(text));
    const reply = characters.length > 1800 ? characters.slice(0,1800).join('') + '\n\n（回复较长，完整内容请在网页或终端查看。）' : characters.join('');
    const payload = JSON.parse(String(row.payload)); payload.item_list = [{type:1,text_item:{text:reply}}];
    await this.db.execute({sql:"UPDATE wechat_messages SET reply=?,payload=?,preparedAt=?,state='pending' WHERE account=? AND id=?",args:[reply,JSON.stringify(payload),Date.now(),row.account,row.id]});
  }
  private async flush(account: BotAccount, signal: AbortSignal) {
    if (this.flushing || signal.aborted || Date.now() < this.nextFlushAt || this.account?.needsLogin) return;
    this.flushing = true;
    try {
    if (this.conversations) {
      const received = (await this.db.execute({sql:"SELECT * FROM wechat_messages WHERE account=? AND peer=? AND state='received' ORDER BY rowid LIMIT 100",args:[account.botId,account.userId]})).rows;
      for (const row of received) { if (signal.aborted) return; await this.conversations.route(row as any,account); }
      const commands = (await this.db.execute({sql:"SELECT * FROM wechat_messages WHERE account=? AND peer=? AND state='command' ORDER BY rowid LIMIT 100",args:[account.botId,account.userId]})).rows;
      for (const row of commands) await this.prepareReply(row,await this.conversations.commandReply(row as any));
      const queued = (await this.db.execute({sql:"SELECT * FROM wechat_messages WHERE account=? AND peer=? AND state IN ('queued','file') ORDER BY rowid LIMIT 100",args:[account.botId,account.userId]})).rows;
      const seen = new Set<string>();
      for (const row of queued) {
        const thread = String(row.threadId);
        if (signal.aborted || seen.has(thread) || this.workers.has(thread)) continue;
        seen.add(thread);
        const worker = (async () => {
          try {
            let text:string|undefined;
            if (row.state==='file') {
              const files=JSON.parse(String(row.files)) as (WeChatFile & {saved?:ReceivedWeChatFile})[];
              const saved:ReceivedWeChatFile[]=[];
              if(files.length>10) throw new Error('每条微信消息最多接收 10 个附件');
              for(const [index,file] of files.entries()) {
                if(!file.saved) {
                  const downloaded=await this.protocol.downloadFile(file,AbortSignal.any([signal,AbortSignal.timeout(60000)]));
                  file.saved=await this.receiveFile!(downloaded.name,downloaded.bytes,`${row.account}:${row.id}:${index}`);
                  await this.db.execute({sql:'UPDATE wechat_messages SET files=? WHERE account=? AND id=?',args:[JSON.stringify(files),row.account,row.id]});
                }
                saved.push(file.saved);
              }
              text=await this.conversations!.fileReceipt(row as any,saved);
            } else {
              const documents=JSON.parse(String(row.documents || '[]')) as ReceivedWeChatFile[];
              const refs=documents.length ? await this.prepareFiles!(documents,signal) : undefined;
              text = await this.conversations!.answer(row as any,signal,refs);
            }
            if (!signal.aborted && text !== undefined) {
              const current = await this.conversations!.current(account);
              if (current?.threadId !== thread) text = `来自「${await this.conversations!.label(thread)}」\n\n` + text;
              await this.prepareReply(row,text);
            }
          } catch (error) {
            if (!signal.aborted && (error as any).status !== 409) await this.prepareReply(row,row.state==='file' ? '文件接收未完成：'+redactText((error as Error).message)+'。请重新发送；已保存的文件仍在资料库。' : JSON.parse(String(row.documents || '[]')).length ? '附件解析或聊天未完成：'+redactText((error as Error).message)+'。原文件仍保存在资料库。' : '这次回答未完成，请在网页或终端检查模型配置和会话状态，再重新发送。');
          }
        })().catch(() => {this.error = '微信回复保存失败，正在重试';}).finally(() => {this.workers.delete(thread);});
        this.workers.set(thread,worker);
      }
    }
    const rows = (await this.db.execute({sql:"SELECT id,payload,text,createdAt,sourceCreatedAt,preparedAt FROM wechat_messages WHERE account=? AND peer=? AND state='pending' ORDER BY rowid LIMIT 20",args:[account.botId,account.userId]})).rows;
    for (const row of rows) {
      if (signal.aborted) return;
      await this.protocol.send(account, JSON.parse(String(row.payload)), AbortSignal.any([signal, AbortSignal.timeout(15000)]));
      const sentAt=Date.now();
      await this.db.execute({sql:"UPDATE wechat_messages SET state='sent',sentAt=? WHERE account=? AND id=?",args:[sentAt,account.botId,row.id]});
      if (/^\/new(?:\s|$)/.test(String(row.text))) console.info('微信新建会话耗时：'+JSON.stringify({deliveryMs:row.sourceCreatedAt ? Number(row.createdAt)-Number(row.sourceCreatedAt) : null,localMs:row.preparedAt ? Number(row.preparedAt)-Number(row.createdAt) : null,sendMs:row.preparedAt ? sentAt-Number(row.preparedAt) : null}));
    }
    this.flushFailures = 0; this.nextFlushAt = 0;
    } catch (error) {
      this.nextFlushAt = Date.now() + Math.min(60000,1000 * 2 ** Math.min(++this.flushFailures,6));
      throw error;
    } finally {this.flushing = false;}
  }
  private async loop(signal: AbortSignal) {
    let failures = 0, timeout = 40000;
    // Model work and outbound replies must not wait for the next long-poll response.
    const pump = this.conversations ? setInterval(() => {
      const account = this.account;
      if (!this.login && account && !account.needsLogin) void this.flush(account,signal).catch(async error => {
        if (signal.aborted) return;
        this.error = error instanceof WeChatError ? error.message : '微信回复暂未送达，正在重试';
        if (error instanceof WeChatError && error.code === -14 && this.account) {
          await this.pauseExpired();
        }
      }).catch(() => {this.error = '微信状态保存失败，请重启服务后重试';});
    },Math.max(10,Math.min(500,this.pollDelay))) : undefined;
    try {
    while (!signal.aborted) {
      try {
        if (this.login) await this.pollLogin(signal);
        else {
          const account = this.account;
          if (!account || account.needsLogin) return;
          if (this.notifiedAccount?.token !== account.token && typeof this.protocol.notify === 'function') {
            this.notifiedAccount = account;
            await this.protocol.notify(account,'start',AbortSignal.any([signal,AbortSignal.timeout(3000)])).catch(() => {if (!signal.aborted) console.warn('微信启动通知失败，继续消息收发');});
            if (signal.aborted) return;
          }
          await this.flush(account, signal);
          const result = await this.protocol.updates(account, AbortSignal.any([signal, AbortSignal.timeout(timeout)]));
          if (signal.aborted || this.account?.needsLogin) return;
          if (result.msgs !== undefined && !Array.isArray(result.msgs)) throw new Error('消息列表格式错误');
          const cursor = typeof result.get_updates_buf === 'string' && result.get_updates_buf ? result.get_updates_buf : account.cursor;
          const entries = (result.msgs ?? []).map((msg: WeChatMessage) => this.incoming(account,msg)).filter(Boolean);
          // Only update the cursor: concurrent outbound credential expiry must remain durable.
          await this.db.batch([...entries,{sql:"UPDATE wechat_account SET data=json_set(data,'$.cursor',?) WHERE id=1",args:[cursor]}]);
          const next = {...this.account!,cursor}; this.account = next;
          if (Number.isFinite(result.longpolling_timeout_ms)) timeout = Math.min(90000,Math.max(10000,result.longpolling_timeout_ms + 5000));
          await this.flush(next, signal); this.error = '';
        }
        failures = 0;
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof WeChatError && error.code === -14 && !this.login && this.account) {
          this.error = error.message; await this.pauseExpired(); return;
        }
        if (error instanceof Error && error.name === 'TimeoutError') continue;
        this.error = error instanceof WeChatError ? error.message : '微信请求失败；消息和凭证已保留，正在重试'; failures++;
      }
      await delay(failures ? Math.min(60000,1000 * 2 ** Math.min(failures,6)) : this.pollDelay, undefined, {signal}).catch(() => {});
    }
    } finally {
      if (pump) clearInterval(pump);
      // Abort first (halt/shutdown), then allow Agent to persist its interrupted turn.
      await Promise.allSettled([...this.workers.values()]);
      while (this.flushing) await delay(10);
    }
  }
}

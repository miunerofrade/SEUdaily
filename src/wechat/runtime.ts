import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import QRCode from 'qrcode';
import type { LocalClient } from '../agent/sqlite.js';
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
  constructor(private db: LocalClient, private protocol = new WeChatProtocol(), private pollDelay = 1000) {}
  initialize() {
    return this.ready ??= (async () => {
      await this.db.batch([
        'CREATE TABLE IF NOT EXISTS wechat_account (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL)',
        `CREATE TABLE IF NOT EXISTS wechat_messages (account TEXT NOT NULL, id TEXT NOT NULL, peer TEXT NOT NULL, session TEXT NOT NULL, text TEXT NOT NULL, reply TEXT NOT NULL, threadId TEXT NOT NULL, resourceId TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL, createdAt INTEGER NOT NULL, PRIMARY KEY(account,id))`,
        'CREATE INDEX IF NOT EXISTS wechat_pending ON wechat_messages(account,peer,state,createdAt)',
        'CREATE INDEX IF NOT EXISTS wechat_recent ON wechat_messages(account,peer,createdAt DESC)',
      ]);
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
    const rows = account ? (await this.db.execute({sql:'SELECT id,peer,session,text,reply,threadId,resourceId,state,createdAt FROM wechat_messages WHERE account=? AND peer=? ORDER BY createdAt DESC LIMIT 6',args:[account.botId,account.userId]})).rows : [];
    return { state: this.login?.state ?? (account ? account.needsLogin ? 'needs_login' : 'connected' : 'disconnected'),
      loginId: this.login?.id, qr: this.login ? { size: this.login.size, modules: this.login.modules } : undefined,
      botId: account?.botId, userId: account?.userId, threadId: DEMO_THREAD, resourceId: DEMO_RESOURCE,
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
    if (msg.message_type !== 1 || msg.message_state !== 2 || msg.group_id || msg.from_user_id !== account.userId || !msg.context_token || msg.to_user_id && msg.to_user_id !== account.botId) return undefined;
    const sourceId = msg.message_id ?? msg.client_id;
    if (typeof sourceId !== 'string' || typeof msg.context_token !== 'string' || msg.session_id !== undefined && typeof msg.session_id !== 'string') return undefined;
    if (!sourceId || !Array.isArray(msg.item_list)) return undefined;
    const text = msg.item_list.filter(item => item.type === 1 && typeof item.text_item?.text === 'string').map(item => item.text_item!.text).join('\n');
    const unsupported = msg.item_list.some(item => item.type !== 1);
    if (!text && !unsupported) return undefined;
    const id = String(sourceId), peer = msg.from_user_id, session = msg.session_id ?? '';
    const reply = unsupported ? 'SEUdaily 微信 demo 已收到消息；当前仅支持文本，图片、语音及文件暂未接入。' : `SEUdaily 微信 demo\n会话：${DEMO_THREAD}\n消息：${id}\n${text.slice(0,1200)}`;
    const clientId = 'seudaily-' + createHash('sha256').update(`${account.botId}\0${peer}\0${id}`).digest('hex').slice(0,40);
    const payload = {from_user_id:'',to_user_id:peer,client_id:clientId,message_type:2,message_state:2,context_token:msg.context_token,item_list:[{type:1,text_item:{text:reply}}]};
    return {sql:`INSERT OR IGNORE INTO wechat_messages(account,id,peer,session,text,reply,threadId,resourceId,payload,state,createdAt) VALUES(?,?,?,?,?,?,?,?,?,'pending',?)`,args:[account.botId,id,peer,session,text,reply,DEMO_THREAD,DEMO_RESOURCE,JSON.stringify(payload),Date.now()]};
  }
  private async flush(account: BotAccount, signal: AbortSignal) {
    const rows = (await this.db.execute({sql:"SELECT id,payload FROM wechat_messages WHERE account=? AND peer=? AND state='pending' ORDER BY createdAt LIMIT 20",args:[account.botId,account.userId]})).rows;
    for (const row of rows) {
      if (signal.aborted) return;
      await this.protocol.send(account, JSON.parse(String(row.payload)), AbortSignal.any([signal, AbortSignal.timeout(15000)]));
      await this.db.execute({sql:"UPDATE wechat_messages SET state='sent' WHERE account=? AND id=?",args:[account.botId,row.id]});
    }
  }
  private async loop(signal: AbortSignal) {
    let failures = 0, timeout = 40000;
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
          if (signal.aborted) return;
          if (result.msgs !== undefined && !Array.isArray(result.msgs)) throw new Error('消息列表格式错误');
          const cursor = typeof result.get_updates_buf === 'string' && result.get_updates_buf ? result.get_updates_buf : account.cursor;
          const next = {...account,cursor};
          const entries = (result.msgs ?? []).map((msg: WeChatMessage) => this.incoming(account,msg)).filter(Boolean);
          await this.db.batch([...entries,{sql:'UPDATE wechat_account SET data=? WHERE id=1',args:[JSON.stringify(next)]}]);
          this.account = next;
          if (Number.isFinite(result.longpolling_timeout_ms)) timeout = Math.min(90000,Math.max(10000,result.longpolling_timeout_ms + 5000));
          await this.flush(next, signal); this.error = '';
        }
        failures = 0;
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof WeChatError && error.code === -14 && !this.login && this.account) {
          const account = {...this.account,needsLogin:true}; await this.saveAccount(account); this.account = account; this.error = error.message; return;
        }
        if (error instanceof Error && error.name === 'TimeoutError') continue;
        this.error = error instanceof WeChatError ? error.message : '微信请求失败；消息和凭证已保留，正在重试'; failures++;
      }
      await delay(failures ? Math.min(60000,1000 * 2 ** Math.min(failures,6)) : this.pollDelay, undefined, {signal}).catch(() => {});
    }
  }
}

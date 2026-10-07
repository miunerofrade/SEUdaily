import {downloadWeChatFile,type WeChatFile} from './media.js';
import { randomBytes } from 'node:crypto';
import { VERSION } from '../distribution/config.js';
export const WECHAT_API = 'https://ilinkai.weixin.qq.com';
export class WeChatError extends Error {
  constructor(message: string, public code?: number) { super(message); }
}
/** Never forward a bot credential to an arbitrary redirect or HTTP endpoint. */
export function trustedWeChatBase(value: string): string {
  let url: URL;
  try { url = new URL(value.includes('://') ? value : `https://${value}`); }
  catch { throw new WeChatError('微信返回了不可信的 API 地址'); }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.weixin.qq.com') || url.username || url.password || url.port || url.search || url.hash || url.pathname !== '/')
    throw new WeChatError('微信返回了不可信的 API 地址');
  return url.origin;
}
export type BotAccount = { token: string; botId: string; userId: string; base: string; cursor: string; needsLogin: boolean };
export type WeChatMessage = { message_id?: string; client_id?: string; from_user_id?: string; to_user_id?: string; session_id?: string; create_time_ms?: number; group_id?: string; message_type?: number; message_state?: number; context_token?: string; item_list?: { type: number; text_item?: { text?: string }; file_item?: WeChatFile }[] };
export class WeChatProtocol {
  constructor(private transport: typeof fetch = fetch) {}
  async request(base: string, path: string, body: unknown | undefined, signal: AbortSignal, token?: string): Promise<any> {
    const headers: Record<string,string> = { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': String(VERSION.split('.').reduce((value, part) => value * 256 + Number(part), 0)) };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers.AuthorizationType = 'ilink_bot_token';
      headers['X-WECHAT-UIN'] = Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64');
    }
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await this.transport(trustedWeChatBase(base) + path, { method: body === undefined ? 'GET' : 'POST', headers,
      ...(body === undefined ? {} : { body: JSON.stringify(token ? { ...body as object, base_info: { channel_version: VERSION, bot_agent: `SEUdaily/${VERSION}` } } : body) }), signal, redirect: 'error' });
    if (!response.ok) throw new WeChatError(`微信接口 HTTP ${response.status}`);
    // JSON numeric uint64 IDs must not be rounded before deduplication/routing.
    const data = JSON.parse(await response.text(), function(key, value, context?: { source?: string }) {
      if (key === 'message_id' && typeof value === 'number') {
        if (context?.source) return context.source;
        if (!Number.isSafeInteger(value)) throw new WeChatError('微信消息 ID 超出安全整数范围');
        return String(value);
      }
      return value;
    });
    const code = [data.ret, data.errcode].find(value => typeof value === 'number' && value !== 0);
    if (code !== undefined) throw new WeChatError(code === -14 ? '微信凭证失效，请重新扫码' : `微信接口返回错误码 ${code}`, code);
    return data;
  }
  downloadFile(file:WeChatFile,signal:AbortSignal) {return downloadWeChatFile(file,signal,this.transport);}
  qr(signal: AbortSignal, tokens: string[]) { return this.request(WECHAT_API, '/ilink/bot/get_bot_qrcode?bot_type=3', { local_token_list: tokens }, signal); }
  qrStatus(base: string, qr: string, signal: AbortSignal, code?: string) {
    return this.request(base, `/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qr)}${code ? `&verify_code=${encodeURIComponent(code)}` : ''}`, undefined, signal);
  }
  updates(account: BotAccount, signal: AbortSignal) { return this.request(account.base, '/ilink/bot/getupdates', { get_updates_buf: account.cursor }, signal, account.token); }
  notify(account: BotAccount, event: 'start' | 'stop', signal: AbortSignal) { return this.request(account.base, '/ilink/bot/msg/notify' + event, {}, signal, account.token); }
  send(account: BotAccount, msg: unknown, signal: AbortSignal) { return this.request(account.base, '/ilink/bot/sendmessage', { msg }, signal, account.token); }
}

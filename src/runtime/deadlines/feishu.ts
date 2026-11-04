import { createHmac } from 'node:crypto';
export function validFeishuWebhook(value: string) { const url = new URL(value); if (url.origin !== 'https://open.feishu.cn' || !/^\/open-apis\/bot\/v2\/hook\/[a-zA-Z0-9-]+$/.test(url.pathname) || url.search || url.hash || url.username || url.password)
    throw new Error('请填写飞书群机器人的 HTTPS Webhook 地址'); return url.href; }
export function feishuPayload(text: string, secret = '', now = Date.now()) {
    const timestamp = String(Math.floor(now / 1000));
    return { msg_type: 'text', content: { text }, ...(secret ? { timestamp, sign: createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64') } : {}) };
}
export async function sendFeishu(text: string, options: {
    webhook?: string;
    secret?: string;
    fetchImpl?: typeof fetch;
} = {}) {
    const webhook = options.webhook ?? process.env.SEUDAILY_FEISHU_WEBHOOK;
    if (!webhook)
        throw new Error('尚未配置飞书群机器人');
    const payload = JSON.stringify(feishuPayload(text, options.secret ?? process.env.SEUDAILY_FEISHU_SECRET));
    if (Buffer.byteLength(payload) > 18000)
        throw new Error('提醒正文过长');
    const response = await (options.fetchImpl ?? fetch)(validFeishuWebhook(webhook), { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: payload, signal: AbortSignal.timeout(10000) });
    if (!response.ok)
        throw new Error('飞书发送失败');
    const body = await response.json() as {
        code?: number;
        StatusCode?: number;
    };
    if ((body.code ?? body.StatusCode) !== 0)
        throw new Error('飞书拒绝了提醒消息');
}

export type WeChatStatus = {
  state: string; loginId?: string; qr?: {size:number;modules:string}; botId?: string; userId?: string;
  threadId: string; resourceId: string; error: string;
  currentSession?: {number:number;threadId:string;title:string};
  messages: {id:string;peer:string;session:string;text:string;reply:string;state:string;createdAt:number}[];
};
export const wechatStateLabel: Record<string,string> = {
  disconnected:'尚未连接微信', wait:'请用微信扫描二维码', scaned:'已扫码，请在手机上确认',
  need_verifycode:'请输入手机上显示的验证码', verify_code_blocked:'验证码尝试次数过多，请重新扫码',
  expired:'二维码已过期，请刷新', needs_login:'微信登录已失效，请重新扫码', connected:'微信已连接',
};
/** Half blocks preserve square modules with a four-module quiet zone. */
export function terminalWeChatQR(qr: {size:number;modules:string}) {
  const dark = (x:number,y:number) => x >= 0 && y >= 0 && x < qr.size && y < qr.size && qr.modules[y * qr.size + x] === '1';
  const rows = [];
  for (let y = -4; y < qr.size + 4; y += 2) {
    let row = '';
    for (let x = -4; x < qr.size + 4; x++) row += dark(x,y) ? dark(x,y+1) ? '█' : '▀' : dark(x,y+1) ? '▄' : ' ';
    rows.push(row);
  }
  return rows.join('\n');
}

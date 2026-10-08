export const commands: Record<string, string> = {
  help: "命令帮助",
  new: "新会话",
  sessions: "历史会话",
  resume: "打开会话列表；Delete 删除；可指定 [ID/序号/latest]",
  history: "查看完整原记录 [数量]",
  schedule:
    "课表；Enter 详情，e 编辑；a 添加，o 单日课，m 学期设置；--sync 同步",
  programs: "培养方案 [--sync --plan ID --filter 文字 --page N --limit N]",
  audit: "培养方案 Skill 核查",
  notices: "校园通知",
  focus: "关注任务",
  settings: "编辑环境变量和 AGENT.md",
  knowledge: '知识库：list / add "路径" / search 问题 / retry ID / remove ID',
  queue: "查看待发送消息；resume 继续暂停的队列",
  vpn: "连接校园 VPN（使用已保存端口）；status / disconnect / verify / resend",
  ramdisk: "内存盘：/ramdisk 512 MB；status / unmount / reveal",
  semester: "编辑学期名称、日期及总周数",
  skills: "项目 Skill",
  skill: "选择 Skill NAME [问题]，off 清除",
  approve: "批准当前工具",
  reject: "拒绝当前工具",
  login: "登录续接 [schedule/ID]",
  apply: "确认本地操作 [ID]",
  mode: "选择权限模式 [normal/full/extra]",
  permission: "查看或切换权限模式 [normal/full/extra]",
  attach: '添加图片或文档 "路径"；也可粘贴文件路径',
  detach: "清空文档",
  thinking: "展开 / 折叠模型思考（Ctrl+T）",
  "copy-on-select": "拖选后自动复制 [on/off]，默认关闭",
  cancel: "取消当前任务",
  quit: "退出",
};
export const aliases: Record<string, string> = {
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

export const slashCommands = [
  { command: '/vpn', description: '连接 VPN，使用已保存端口' },
  { command: '/vpn status', description: '刷新连接状态' },
  { command: '/vpn connect', description: '连接 VPN，可追加代理端口' },
  { command: '/vpn disconnect', description: '断开 VPN' },
  { command: '/ramdisk', description: '查看内存盘状态' },
  { command: '/ramdisk status', description: '刷新容量与使用情况' },
  { command: '/ramdisk 1G', description: '启用内存盘，可修改容量（64 MB–64 GB）' },
  { command: '/ramdisk unmount', description: '卸载内存盘' },
  { command: '/ramdisk reveal', description: '在文件管理器中显示' },
];

export function matchSlashCommands(draft: string) {
  if (!draft.startsWith('/') || draft.includes('\n')) return [];
  const query = draft.toLowerCase().replace(/\s+/g, ' ');
  return slashCommands.filter(item => item.command.toLowerCase().startsWith(query) && item.command.toLowerCase() !== query.trim());
}

export function slashCommandHint(draft: string) {
  if (!draft.startsWith('/')) return '';
  if (/^\/vpn(?:\s|$)/i.test(draft)) return 'VPN 命令 · /vpn 连接 · /vpn status 状态 · /vpn disconnect 断开';
  if (/^\/ramdisk(?:\s|$)/i.test(draft)) return '内存盘命令 · /ramdisk [容量] · status · unmount · reveal';
  return matchSlashCommands(draft).length ? '选择命令 · ↑↓ 切换 · Tab / Enter 补全' : '未识别的命令，将作为普通消息发送';
}

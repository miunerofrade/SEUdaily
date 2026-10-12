# 东大云盘资料库备份（实验）

本实验位于 `codex/anyshare-experiment`，入口是 `https://pan.seu.edu.cn`。
云盘作为按需备份目的地：明确选择本地资料文件，打成保留目录结构的 ZIP，上传至个人文档中的 `SEUdaily备份`。每次执行创建独立备份，重名时报错。

## 启用与使用

在运行 SEUdaily 的数据目录 `.env` 中设置：

```dotenv
SEUDAILY_EXPERIMENTAL_ANYSHARE=true
```

启动本分支的后端后，Agent 可通过 `search-capabilities` 搜索“云盘备份”，或选择 `cloud-backup` namespace，发现 `experimental-cloud-backup`。默认关闭。该能力沿用现有工具票据与审批流程。

工具支持四个模式：

- `browse`：省略 `docid` 时列出个人文档库；传列表返回的 `docid` 时列出目录。文档库根的字段是 `id`，目录和文件的字段是 `docid`，均为 `gns://...`。
- `plan`：传 `paths`，列出备份文件、数量和总大小。此步骤只读本地文件清单。
- `backup`：传相同的 `paths` 与 `parentDocid`，上传 ZIP。目标父目录使用 `browse` 返回的个人文档库 `id`。上传需要审批。
- `download`：传 `parentDocid` 与备份文件的 `docid`，下载 `SEUdaily备份` 目录内的 ZIP。下载需要审批。

例如先查看范围，再上传：

```json
{ "mode": "plan", "paths": ["exports", ".seudaily/uploads/documents"] }
```

```json
{
  "mode": "backup",
  "paths": ["exports", ".seudaily/uploads/documents"],
  "parentDocid": "gns://个人文档库ID"
}
```

`paths` 是相对当前数据目录的路径。允许选择以下资料目录及其中的文件：`exports`、`.seudaily/uploads/documents`、`.seudaily/uploads/images`、`.seudaily/web-files/files`、`.seudaily/knowledge/files`、`docs/references`。备份涵盖当前资料库支持的文档、图片、音视频格式；隐藏文件、配置和数据库不打包。符号链接会拒绝。

单次原文件合计最多 100 MB、1000 个文件，ZIP 上传及下载也限制在 100 MB。实验版采用单文件上传。

## 鉴权与网络

复用现有 Python 环境、`httpx`、校园 CAS 密码与 Cookie 会话。依次请求云盘 OAuth 登录入口、校园 CAS、携票据的云盘回调，再使用云盘 Cookie 中的访问令牌调用 AnyShare API。401 时尝试网页端 token 刷新，再回退 CAS 登录；需要验证码时返回认证提示。

所有过程通过 HTTP 客户端完成，无浏览器。站点的 HTTP 地址会跳转 HTTPS，服务端配置的 CAS、OAuth 回调与文件传输也使用 HTTPS。连接使用现有校园 VPN 代理；当前实测环境在校内，校外 DNS 与 VPN 路径仍需校外验收。

接口协议：目录列表和创建、`file/osbeginupload` → 签名 PUT → `file/osendupload`、`file/osdownload` → 签名 GET。文件传输使用单独客户端，认证 Cookie 与云盘 Bearer token 留在云盘站点。

云盘会话保存在数据目录 `.seudaily/anyshare/cookies.json`，文件权限为 `0600`。工具结果只返回文件清单、备份名称、大小和 docid，认证材料与签名下载地址留在传输层。

## 文件位置与范围

- 云端：个人文档 / `SEUdaily备份` / `library-时间戳-随机后缀.zip`。
- 下载：数据目录 `.seudaily/anyshare/downloads/`。
- 打包中间文件：使用临时目录，执行结束后清理。

备份和下载均独立于资料库与 RAG，ZIP 下载后保留原状。当前提供按需备份与下载；定时备份、哈希去重、增量同步、自动解压和恢复由后续需求决定。

## 验证记录

2026-10-12，现有 Python 3.13.3 环境，无新增依赖或环境：

- 校内 HTTP 首页返回 302，HTTPS 云盘页面可达。
- 纯 HTTP 客户端完成 CAS / OAuth，个人文档库和目录接口返回 200。
- token 刷新后再次列举文档库成功。
- 将仓库内一份手册 Markdown 打包并上传至个人文档 / `SEUdaily备份`，再下载 ZIP，确认目录条目和文本内容与本地原文件一致。临时 ZIP 和下载验证文件已清理；云端保留这份实际备份 `library-20261012-143131-dcbff184.zip`（107399 字节）。
- 自动测试覆盖登录 challenge 与回调、会话权限、401 刷新、失败脱敏、备份范围、符号链接和大小限制、传输与提交顺序、临时清理、默认关闭、工具发现、参数和审批。

参考：[学校云盘服务说明](https://nic.seu.edu.cn/fwzn/xxxtjs/ddyp.htm)、[AnyShare 官方文档访问 API](https://developers.aishutech.com/napi/documents/307)。

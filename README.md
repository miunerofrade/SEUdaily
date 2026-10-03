# SEUdaily

SEUdaily 是面向东南大学学习与校园事务的本地 Web 助手。React/Vite 提供工作台，TypeScript Agent 处理对话、工具调用与会话存储，Python 核心负责校园门户与媒体处理。

## 可以做什么

- 同步个人课表与培养方案，调整学期日期、课程安排，检查课程和学分要求。
- 查询课程点播和录播，抓取字幕、音视频和幻灯片，调用语音转写并整理学习资料。
- 查询教务处、计软智通知，设置 Focus 持续关注通知与课程资料。
- 保存多会话和历史分支，编辑提示词、重新生成回复，展示 Markdown、公式、图片与来源。
- 解析 PDF、Office 文档，把附件文本作为用户消息资料保存；附件内容不会加入系统指令。

校园门户需要有效账号和校园网络；首次登录或登录失效时，验证码与交互授权仍需手动完成。云端模型、语音转写与搜索需要对应 API Key，调用时会发送完成任务所需的内容。

## 从源码运行

当前尚未发布 npm 安装包。需要 Node.js 22.22+（22.x）或 24.12+、npm 10+、Python 3.13+、uv。媒体处理还需要 FFmpeg。

```bash
git clone https://github.com/miunerofrade/SEUdaily.git
cd SEUdaily
npm ci
uv sync --frozen
cp .env.example .env
```

在 `.env` 中按需配置 `DEEPSEEK_API_KEY`、校园账号、语音转写与搜索服务密钥，完整字段见 [.env.example](.env.example)。

浏览器默认：Windows 使用 Microsoft Edge，macOS 使用 Playwright WebKit，Linux 使用 Playwright Firefox。Node 与 Python 使用同一版本、共享一份浏览器缓存，运行统一安装入口：

```bash
npm run install:browser
```

Linux 将 `webkit` 换成 `firefox`，并安装 Playwright 提示的系统依赖。视频幻灯片可选依赖通过 `uv sync --frozen --extra ppt` 安装。

```bash
uv run seudaily start
```

也可以分别运行 `npm start` 和 `npm run dev:web`。本地工作台为 `http://127.0.0.1:4173`，后端为 `http://127.0.0.1:4111`。

## 交互约定

Skill 选择只作用于下一次发送，发送后自动清除。中文输入法确认候选时，Enter 不会发送消息；完成输入后再次按 Enter 发送，Shift+Enter 换行。

`/ramdisk 768M` 或 `/ramdisk 1.5 GB` 启用自定义内存盘，容量支持 64 MB–64 GB；`/ramdisk status` 查看状态，`/ramdisk unmount` 卸载，`/ramdisk reveal` 打开目录。命令由界面直接处理，资源面板同步显示使用量和任务数，每 5 秒刷新，有处理任务时不能卸载。

创建 Focus 即授予该关注完全访问权限，不授予 extra 文件和终端能力。编辑提示词保留同一任务和会话，保存新要求并重新执行，历史版本可在用户提示词下方切换。关注没有自动到期时间；暂停停止自动执行，删除撤回授权。登录续接请求有效期为 30 分钟，门户登录时效由学校系统决定。自动检查需要本地服务持续运行。

## 开发

```bash
npm run typecheck
npm run build:web
uv run pytest
```

`apps/web` 是界面，`src/agent` 是模型循环与持久化，`src/runtime`、`src/server` 提供工具与 HTTP 接口，`src/seudaily` 是 Python 业务核心。项目 Skill 位于 `.agent/skills`；项目 Agent 指令由设置页维护。

`main` 保留 Web 入口；独立的 `cli` 分支还提供终端交互。


## 校园 VPN

Web 设置页或右侧资源面板可以连接校园 VPN；Web 支持 `/vpn connect`、`/vpn status`、`/vpn disconnect`。额外验证码在面板中填写。

连接使用保存的校园账号密码打开东大 CAS 登录页，截获一次性认证回调后交给 zju-connect 的 aTrust 核心。遇到验证码或其他交互验证时，在登录窗口完成。首次使用下载官方固定版本 v1.3.1 并核验 SHA256，核心缓存在 `.seudaily/vpn/bin/`；也可以通过 `SEUDAILY_VPN_BINARY` 指定已安装的核心。

代理仅监听本机回环地址，接入课程门户、课表、培养方案、校园网页与媒体输入，不修改系统路由或全局代理。VPN 会话与业务门户 Cookie 分开保存；核心负责刷新会话，核心退出后代理失效，需要重新连接。断开连接或退出应用会停止核心。可访问资源由学校给账号下发的权限决定。

此接入按需下载 zju-connect 项目发布的未修改 AGPL-3.0 核心，不随本仓库或 npm 包附带其二进制。下载目录同时保存许可证全文和对应版本源码入口；设置页也提供这两个链接。SEUdaily 自有代码保持 MIT，第三方核心遵循自己的许可证；具体集成边界与发布条件见 [第三方 VPN 声明](THIRD_PARTY_NOTICES.md) 和 [许可证核查](docs/licensing-vpn.md)。上游 aTrust 内部仍跳过部分 TLS 证书校验；本项目连接前校验公开网关证书，但这不等同于修复核心内部校验。真实门户、媒体链接的验证结果见 [VPN 接入记录](docs/research/seu-vpn-zju-connect.md)。

VPN 默认 HTTP 代理地址为 `http://127.0.0.1:11081`，支持 HTTPS CONNECT。面板显示当前地址，可以在断开后修改端口，再连接使其生效；端口保存在本地设置中。Web 也支持 `/vpn connect 12081`。宿主机程序可以显式使用这个代理，例如 `curl --noproxy '' -I -x http://127.0.0.1:11081 https://cvs.seu.edu.cn/`。该端口只监听本机，HTTP 代理不承载系统 `ping` 的 ICMP 流量。

东大 VPN 默认使用校园 DNS `202.119.24.12` 经 L3 隧道解析，可通过 `SEUDAILY_VPN_DNS_SERVER` 调整。这是本次验证可用的学校第二 DNS；第一 DNS 无响应，而上游备用 DNS 查询走直连，曾导致校内域名仍然解析失败。核心子进程使用 Go 官方 TLS 兼容参数，避免较大的 ML-KEM 握手消息造成部分网关卡住。应用收到课程门户 HTTPS HEAD 响应后才显示已连接，不下载响应正文。

Node/Python Playwright 固定为同一正式版本。运行 `npm run install:browser` 检查版本及构建一致性并安装所选引擎；Windows 默认使用已安装的 Edge。

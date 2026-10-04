# SEUdaily

SEUdaily 是面向东南大学学习与校园事务的本地助手，提供终端交互和 Web 工作台。TypeScript Agent 负责对话、工具调用和会话存储；Python 核心负责校园门户与媒体处理。

## 可以做什么

- **课程与课表**：同步个人课表，调整学期日期与课程安排，查询课程点播和录播场次。
- **学习资料**：抓取字幕与课程媒体，调用云端语音转写，提取视频幻灯片并生成课程笔记。
- **培养方案**：同步个人培养方案，结合历年课表检查课程与学分要求。
- **通知与关注**：查询教务处、计软智通知，设置关注目标和课程资料抓取任务。
- **对话与附件**：保存多会话和分支，支持 Markdown、公式、图片，以及 PDF、Office 文档上下文。

校园门户需要有效账号和校园网络；首次登录或会话失效时可能需要交互授权。转写、总结、搜索等功能需要对应服务的 API Key。云端调用会发送完成任务所需的内容。

## 安装

当前从源码运行，尚未提供 npm 安装包。需要：

- Node.js **22.22+（22.x）或 24.12+**、npm **10+**。
- Python **3.13+** 和 [uv](https://docs.astral.sh/uv/)。
- Playwright 浏览器运行时；媒体下载与转写还需要系统 **FFmpeg**。

```bash
git clone https://github.com/miunerofrade/SEUdaily.git
cd SEUdaily
npm ci
uv sync --frozen
cp .env.example .env
```

在 `.env` 中按需填写 `DEEPSEEK_API_KEY`、`SEUDAILY_USERNAME`、`SEUDAILY_PASSWORD`、`SEUDAILY_ASR_API_KEY` 和 `TAVILY_API_KEY`；其他配置见 [.env.example](.env.example)。锁文件用于复现依赖，请保留 `npm ci` 和 `uv sync --frozen` 的安装方式。

普通课表、培养方案和课程资料查询使用 HTTP，可跳过浏览器安装。需要 VPN 登录、交互验证或通用网页操作时再安装浏览器。Windows 默认使用已安装的 Microsoft Edge，macOS 使用 Playwright WebKit，Linux 使用 Playwright Firefox。Node 与 Python 的 Playwright 固定为同一正式版本，共享同一份浏览器缓存。统一安装入口会检查两端版本及浏览器构建是否一致，再只安装所选引擎：

```bash
npm run install:browser
```

Linux 另需安装 Playwright 提示的系统依赖；Windows 默认直接使用已有 Edge，不下载另一份浏览器。可用 `SEUDAILY_BROWSER` 覆盖默认选择。升级时同时更新 npm 的 Playwright 固定版本与 Python 的固定版本，并更新两份锁文件；npm overrides 将 MCP 的预发布驱动依赖对齐到所选正式版，升级后需验证 MCP 的实际浏览器操作。

视频幻灯片提取需要可选依赖：

```bash
uv sync --frozen --extra ppt
```

基础对话、课表、通知和文档解析无需这些视频依赖。当前支持云端 ASR，本地 ASR 尚未提供可用实现。

## 使用

直接启动终端助手：

```bash
uv run seudaily
```

启动 Web 工作台与后端：

```bash
uv run seudaily start
```

Web 默认地址为 `http://127.0.0.1:4173`，Agent API 为 `http://localhost:4111/api`。按 `Ctrl+C` 停止；服务日志位于 `.seudaily/logs/`。

单次运行与其他命令：

```bash
uv run seudaily exec "查看今天的课程"
uv run seudaily --help
```

## 数据与权限

会话、配置和缓存主要保存在 `.seudaily/`，课程产物保存在 `exports/`，门户 Cookie 保存在本地。服务端数据库是会话历史的主存储，浏览器仅保存容量受限的缓存。账号、密钥与 Cookie 不应提交到 Git。

Agent 可通过工具访问工作区并执行命令。应用的权限设置控制工具授权，原生命令沙盒限制文件访问和网络：macOS 使用系统沙盒，Linux 使用 bubblewrap，Windows 可通过 WSL2 运行沙盒。运行环境缺少沙盒时的主机回退隔离能力较弱，应根据实际使用场景选择权限。

## 开发

```bash
npm run typecheck
npm run build:web
uv run --frozen pytest -q
```

后端与前端独立开发可使用 `npm run dev` 和 `npm run dev:web`。Node 回归测试使用内置 test runner 与 `tsx`；依赖本地模型配置的测试应使用隔离环境。真实门户验证需要有效登录状态，不能由离线测试替代。

| 目录 | 职责 |
| --- | --- |
| `apps/web/` | React Web 工作台 |
| `src/terminal/` | 终端界面与客户端 |
| `src/agent/` | Agent 循环、会话与审批 |
| `src/server/`、`src/runtime/` | HTTP/SSE、工具桥与工作区 |
| `src/seudaily/` | Python 门户、课表、通知与媒体服务 |
| `.agent/` | 领域指令与 Skills |
| `tests/` | 回归测试与显式运行的本地交互测试 |

版本历史见 [CHANGELOG.md](CHANGELOG.md)。

## 交互约定

Web 与终端的 Skill 选择只作用于下一次发送，发送后自动清除。解析附件作为用户消息中的资料保存，不加入系统指令。

终端输入框支持粘贴本地附件路径：复制或拖入文件，终端传入路径后会显示 `[图片：文件名]` 或 `[文档：文件名]`，再输入提示词并按 Enter 发送，无需附件命令。附件作为完整编辑单元，左右方向键跨过附件，Backspace/Delete 删除对应附件。支持 PNG/JPEG/WebP/GIF（每张不超过 10 MB）以及 PDF/DOCX/XLSX/PPTX（每个不超过 50 MB），每轮最多 4 个附件。普通文字按原样粘贴；未知格式明确提示不支持。这里识别的是终端实际传入的文件路径，尚未读取系统剪贴板的图片二进制。

`/ramdisk 768M` 或 `/ramdisk 1.5 GB` 启用自定义内存盘，支持 64 MB–64 GB；`/ramdisk status` 查看状态，`/ramdisk unmount` 卸载，`/ramdisk reveal` 打开目录。Web 在资源面板显示实时使用量和任务数，每 5 秒刷新；有处理任务时不能卸载。

终端 `/notices` 打开与 Web 相同的教务处通知列表，`r` 刷新，Enter 打开原文，Esc 返回。普通对话仍可查询其他来源的校园通知。

创建 Focus 即授予该关注完全访问权限，不授予 extra 文件和终端能力；验证码及交互登录仍需手动完成。编辑提示词保留同一任务与会话，保存新要求并重跑，历史版本保留。关注没有自动到期时间；暂停停止自动执行，删除撤回授权。登录续接请求有效期为 30 分钟，门户登录时效由学校系统决定。

## 校园登录

课表和个人培养方案使用纯 HTTP 统一认证及业务接口，普通登录不启动浏览器。先复用已保存的 Cookie；失效时尝试用学校 SSO 会话换取业务 Cookie，SSO 也失效时使用已保存的账号密码重新认证。接口请求发现登录失效后最多重认证并重试一次；验证码或二次验证返回人工登录入口。学校控制会话有效期，程序不假设 Cookie 永久有效。课程点播的普通登录、课程搜索、课次定位、播放链接和官方字幕也使用 HTTP；课件优先调用学校 PDF 导出接口，权限拒绝会直接报告。课表仍保留接口结构变更时的旧页面解析入口；通用网页操作、VPN 登录及需验证码或二次验证的显式授权仍使用浏览器。浏览器按需启动，普通校园查询不启动浏览器。对照测试和剩余依赖见 [课程 HTTP 记录](docs/research/seu-course-http.md)。

## 校园 VPN

只运行 VPN 代理：`uv run seudaily --vpn 11081`（已安装命令时使用 `seudaily --vpn 11081`）。自动读取项目 `.env` 和环境变量中的 `SEUDAILY_USERNAME`、`SEUDAILY_PASSWORD`，缺少任一项立即报错，不下载核心或打开登录窗口。此模式不启动聊天、Agent 后端或 Web 前端；连接期间保持终端运行，验证码在登录窗口完成，按 Ctrl+C 断开并停止核心。端口范围为 1024–65535；已有 VPN 连接时需先断开，避免多个核心互相覆盖共享状态。也可用 `npm run cli -- --vpn 11081`。

Web 设置页或右侧资源面板可以连接校园 VPN；终端和 Web 支持 `/vpn connect`、`/vpn status`、`/vpn disconnect`。终端 `/vpn verify` 安全填写额外验证码，Web 在面板中填写。

连接使用保存的校园账号密码打开东大 CAS 登录页，截获一次性认证回调后交给 zju-connect 的 aTrust 核心。遇到验证码或其他交互验证时，在登录窗口完成。首次使用下载官方固定版本 v1.3.1 并核验 SHA256，核心缓存在 `.seudaily/vpn/bin/`；也可以通过 `SEUDAILY_VPN_BINARY` 指定已安装的核心。

代理仅监听本机回环地址，接入课程门户、课表、培养方案、校园网页与媒体输入，不修改系统路由或全局代理。VPN 会话与业务门户 Cookie 分开保存；核心负责刷新会话，核心退出后代理失效，需要重新连接。断开连接或退出应用会停止核心。可访问资源由学校给账号下发的权限决定。

此接入按需下载 zju-connect 项目发布的未修改 AGPL-3.0 核心，不随本仓库或 npm 包附带其二进制。下载目录同时保存许可证全文和对应版本源码入口；设置页也提供这两个链接。SEUdaily 自有代码保持 MIT，第三方核心遵循自己的许可证；具体集成边界与发布条件见 [第三方 VPN 声明](THIRD_PARTY_NOTICES.md) 和 [许可证核查](docs/licensing-vpn.md)。上游 aTrust 内部仍跳过部分 TLS 证书校验；本项目连接前校验公开网关证书，但这不等同于修复核心内部校验。真实门户、媒体链接的验证结果见 [VPN 接入记录](docs/research/seu-vpn-zju-connect.md)。

VPN 默认 HTTP 代理地址为 `http://127.0.0.1:11081`，支持 HTTPS CONNECT。面板显示当前地址，可以在断开后修改端口，再连接使其生效；端口保存在本地设置中。Web 与终端也支持 `/vpn connect 12081`。宿主机程序可以显式使用这个代理，例如 `curl --noproxy '' -I -x http://127.0.0.1:11081 https://cvs.seu.edu.cn/`。该端口只监听本机，HTTP 代理不承载系统 `ping` 的 ICMP 流量。

东大 VPN 默认使用校园 DNS `202.119.24.12` 经 L3 隧道解析，可通过 `SEUDAILY_VPN_DNS_SERVER` 调整。这是本次验证可用的学校第二 DNS；第一 DNS 无响应，而上游备用 DNS 查询走直连，曾导致校内域名仍然解析失败。核心子进程使用 Go 官方 TLS 兼容参数，避免较大的 ML-KEM 握手消息造成部分网关卡住。应用收到课程门户 HTTPS HEAD 响应后才显示已连接，不下载响应正文。

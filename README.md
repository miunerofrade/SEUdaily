# SEUdaily

面向东南大学学习与校园事务的本地助手。安装一个命令即可使用终端聊天；需要网页时，再启动 Web 工作台。两种界面共享后端、会话和校园工具。

## 快速安装

需要 **Node.js 22.22+（22.x）或 24.12+**，以及 npm。可以从 [Node.js 官网](https://nodejs.org/) 安装符合要求的版本。

```bash
npm install -g seudaily
seudaily
```

打开网页界面：

```bash
seudaily web
```

首次运行 Web 时自动安装网页组件，并打开 `http://127.0.0.1:4111`。终端和 Web 可以同时运行，无需另外启动后端，也不需要 Vite。

`-g` 将命令安装到当前 Node 环境的全局目录；安装后可在不同工作目录执行 `seudaily`。公开包的安装不需要登录作者的 npm 账号。

普通聊天不需要 Python、uv 或自动化浏览器。校园、文档及浏览器工具在首次使用时自动准备对应组件和运行环境。首次准备需要联网，后续复用缓存；模型调用和校园服务仍需要网络。

## 首次配置

可在 Web 的设置页面填写模型、校园账号等配置；也可以在用户数据目录中创建 `.env`。已有后端运行时，修改环境变量或手动编辑 `.env` 后，请先执行 `seudaily stop`，再启动。

```dotenv
DEEPSEEK_API_KEY=你的模型服务密钥
DEEPSEEK_MODEL=deepseek-flash

# 使用校园服务时填写
SEUDAILY_USERNAME=你的校园账号
SEUDAILY_PASSWORD=你的校园密码

# 使用对应功能时填写
TAVILY_API_KEY=你的搜索服务密钥
SEUDAILY_ASR_API_KEY=你的云端转写服务密钥
```

不使用某项服务时，无需填写它的密钥。完整配置项见 [.env.example](https://github.com/miunerofrade/SEUdaily/blob/main/.env.example)。也可以直接通过系统环境变量配置，例如：

```bash
# macOS / Linux；只影响当前终端及其子进程
export DEEPSEEK_API_KEY="你的密钥"
seudaily
```

```powershell
# Windows PowerShell
$env:DEEPSEEK_API_KEY = "你的密钥"
seudaily
```

校园服务需要有效账号与校园网络，或本地校园 VPN。验证码、短信和其他二次验证仍需本人完成。模型、搜索与转写服务按各自规则计费。

## 可以做什么

- **对话与资料**：终端和 Web 聊天、历史会话、Markdown 与公式、图片和文档附件。
- **课表**：同步个人课表，查看课程安排，调整学期日期和课程信息。
- **课程学习**：查询点播及录播场次，获取字幕、课件与媒体，生成课程笔记。
- **培养方案**：同步个人培养方案，结合历年课表提供课程与学分核对依据。
- **通知与 Focus**：查看校园通知，创建、编辑、暂停关注任务。
- **校园 VPN**：连接本地代理，让校园工具和指定代理的宿主机程序访问授权资源。

课表、培养方案和常规课程查询优先使用 HTTP。通用网页操作以及部分交互登录保留浏览器方式，浏览器不会在应用启动时自动运行。

## 常用命令

```bash
seudaily                       # 默认终端聊天
seudaily chat                  # 同上；也可用 -c / --chat
seudaily web                   # 网页；也可用 -w / --web
seudaily ask "查看今天的课程"    # 单次提问
seudaily ask --stdin --json     # 从标准输入读取问题，输出 JSONL
seudaily --resume               # 选择并恢复已有会话
seudaily sessions               # 会话列表
seudaily skills                 # Skill 列表
seudaily status                 # 查看本地后端状态
seudaily stop                   # 停止本地后端
seudaily --help                 # 完整参数说明
seudaily --version
```

自定义数据目录或后端端口：

```bash
seudaily --data-dir ./my-seudaily
seudaily web --data-dir ./my-seudaily --port 4112
```

同时运行的界面须使用相同数据目录、后端端口和应用版本，才能共享后端。启动器会检查已运行服务的身份；端口被其他服务占用时会报错。

关闭 Web 启动终端时按 `Ctrl+C`；仅关闭网页标签不会结束启动器。终端聊天短按 `Ctrl+C` 取消当前运行，`Ctrl+D` 或持续重复 `Ctrl+C` 退出。自动启动的后端会在最后一个界面退出后停止。

Shell 补全：

```bash
seudaily completion zsh
# 同样支持 bash、fish、powershell；按对应 Shell 的方式加载输出
```

## 附件与斜杠命令

终端中粘贴或拖入本地文件路径，支持的文件会显示为附件项；输入提示词后按 Enter 发送，无需附件命令。左右方向键跨过附件项，Backspace/Delete 删除对应项。终端必须实际传入文件路径；目前不直接读取系统剪贴板中的图片二进制。

Web 使用附件入口上传。两端每条消息合计最多 **10 个附件**：

| 类型 | 格式 | 单个大小上限 |
| --- | --- | --- |
| 图片 | PNG、JPEG、WebP、GIF | 10 MB |
| 文档 | PDF、DOCX、XLSX、PPTX | 50 MB |

图片能力取决于所用模型；文档解析结果作为用户消息中的资料发送，不放入系统提示词。音视频文件不作为直接聊天附件。

常用输入框命令：

```text
/notices
/ramdisk 768M
/ramdisk status
/ramdisk unmount
/ramdisk reveal
/vpn connect 11081
/vpn status
/vpn verify
/vpn disconnect
```

内存盘容量支持 **64 MB–64 GB**，用于媒体临时文件；有处理任务时不能卸载。Skill 选择仅作用于下一次发送，发出后清除。

## 校园 VPN 与登录

只运行 VPN、不启动聊天或 Web：

```bash
seudaily vpn 11081
# 等价：seudaily --vpn 11081
```

读取环境变量或数据目录 `.env` 中的校园账号密码，缺失时直接报错。连接期间保持终端运行；短信验证码按提示输入，其他交互验证按登录提示完成。`Ctrl+C` 断开。

也可以在 Web 的 VPN 面板连接、填写验证码，并在断开后修改端口。默认 HTTP 代理为 `http://127.0.0.1:11081`，支持 HTTPS CONNECT，仅监听本机。其他程序可显式使用：

```bash
curl --noproxy '' -I -x http://127.0.0.1:11081 https://cvs.seu.edu.cn/
```

代理不修改系统路由或全局代理，也不承载 `ping` 的 ICMP。校园域名通过隧道中的校园 DNS 解析，默认 `202.119.24.12`，可用 `SEUDAILY_VPN_DNS_SERVER` 覆盖。可访问资源取决于学校授予账号的权限。

登录优先复用已有会话，失效时重新认证；Cookie 不能永久有效，VPN 会话与业务门户会话也相互独立。普通登录使用 HTTP，短信验证支持应用内续接；验证码或复杂交互保留人工登录与浏览器兜底。

首次连接按需下载固定版本的 zju-connect 核心并校验 SHA256，也可用 `SEUDAILY_VPN_BINARY` 指定已有核心。它是独立的 AGPL-3.0 第三方程序，不包含在 npm 发布包内；对应许可证与源码入口见 [VPN 许可证说明](https://github.com/miunerofrade/SEUdaily/blob/main/docs/licensing-vpn.md)。

## Focus 与工具权限

创建 Focus 前会提示授权：该任务可免逐次工具审批，但不获得 extra 工作区文件和终端能力。编辑要求沿用同一任务与会话，后续执行使用新要求并保留历史版本；暂停停止自动执行，删除撤回授权。Focus 没有自动到期时间，登录续接请求有效期为 30 分钟。

普通对话的工具访问由应用权限设置控制。工作区与命令执行涉及本机文件；云端模型、搜索或转写调用会向对应服务发送完成任务所需的内容。账号、密钥和 Cookie 不应提交到 Git。

## 数据、更新与卸载

默认数据目录：

| 系统 | 目录 |
| --- | --- |
| macOS | `~/Library/Application Support/SEUdaily` |
| Windows | `%LOCALAPPDATA%\SEUdaily` |
| Linux | `$XDG_DATA_HOME/seudaily`，未设置时为 `~/.local/share/seudaily` |

数据目录保存 `.env`、会话数据库、校园会话和设置，课程产物位于 `exports/`。后端日志位于数据目录下的 `.seudaily/logs/core.log`。可用 `--data-dir` 或 `SEUDAILY_DATA_DIR` 覆盖数据目录，用 `SEUDAILY_CACHE_DIR` 覆盖组件缓存目录。

更新前停止后端，再安装新版本：

```bash
seudaily stop
npm install -g seudaily@latest
```

组件版本与主包保持一致，首次需要时自动安装对应版本。更新或卸载 npm 包不会主动删除用户数据；重要会话与资料请自行备份。

```bash
npm uninstall -g seudaily
```

迁移旧源码目录的数据：

```bash
seudaily import-data /path/to/old/SEUdaily
```

该命令复制数据并保留原件；目标数据目录须为空，源后端须先停止。

## 分发与运行环境

用户只需安装 `seudaily`，无需手动逐个安装组件：

| npm 包 | 职责 |
| --- | --- |
| `seudaily` | 公共名称；内置 CLI、共享后端、Agent 与会话存储 |
| `@miunerofrade/seudaily-web` | 按需安装的 Web 静态页面 |
| `@miunerofrade/seudaily-python` | 校园、文档、VPN 管理的 Python 代码与依赖清单 |
| `@miunerofrade/seudaily-browser` | 按需安装的浏览器自动化服务与驱动 |

Python 解释器没有打进 npm 包。工具首次使用时优先复用已有 uv 0.11.1+ 和 Python 3.11+；找不到兼容版本才自动下载。依赖安装在应用自己的虚拟环境，不修改用户现有 Python 环境。Python 3.11、3.12、3.13 均有 CI 验证。

浏览器引擎按需安装，Python 与 Node 的 Playwright 版本和缓存统一。Windows 默认使用已有 Edge，macOS 使用 Playwright WebKit，Linux 使用 Playwright Firefox。Linux 可能需要额外系统库；媒体处理需要系统 FFmpeg。视频幻灯片提取依赖只在使用相关功能时准备；本地 ASR 尚未实现。

## 从源码开发

```bash
git clone https://github.com/miunerofrade/SEUdaily.git
cd SEUdaily
npm ci
uv sync --frozen
cp .env.example .env
npm run build
node bin/seudaily.mjs --data-dir "$PWD"
```

源码兼容入口 `uv run seudaily` 仍可使用，默认保留仓库数据。独立开发后端与网页可运行 `npm run dev` 和 `npm run dev:web`；Vite 仅用于开发。

```bash
npm run typecheck
node --import tsx --test tests/*.mjs
uv run --frozen pytest -q
npm run test:distribution
```

`main` 统一维护 CLI、Web 与公共核心，旧 `cli` 分支已合入，旧 `dev` 停止维护。GitHub Actions 验证 Windows、macOS、Linux，以及 Node 22/24 和 Python 3.11/3.12/3.13 的组合；真实校园登录、短信和校园权限需在实际环境验证。

更多信息：[分发说明](https://github.com/miunerofrade/SEUdaily/blob/main/docs/distribution.md) · [发布维护](https://github.com/miunerofrade/SEUdaily/blob/main/docs/npm-release.md) · [版本历史](https://github.com/miunerofrade/SEUdaily/blob/main/CHANGELOG.md)。

## 许可证

SEUdaily 自有代码采用 [MIT](https://github.com/miunerofrade/SEUdaily/blob/main/LICENSE)。发布包保留打包依赖的第三方许可证声明；VPN 核心及其他第三方软件遵循各自许可证，见 [第三方声明](https://github.com/miunerofrade/SEUdaily/blob/main/THIRD_PARTY_NOTICES.md)。

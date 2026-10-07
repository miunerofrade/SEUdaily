<div align="center">
  <img src="https://raw.githubusercontent.com/miunerofrade/SEUdaily/main/docs/assets/logo.png" width="140" height="140" alt="SEUdaily logo" />
  <h1>SEUdaily</h1>
  <p><strong>从终端到网页，把校园日常接起来。</strong></p>
  <p>课表 · 课程资料 · 培养方案 · 校园通知 · Focus · VPN</p>

  <p>
    <a href="https://www.npmjs.com/package/seudaily"><img src="https://img.shields.io/npm/v/seudaily?style=flat-square&amp;color=155bc4&amp;label=npm" alt="npm version" /></a>
    <a href="https://github.com/miunerofrade/SEUdaily/actions/workflows/distribution-ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/miunerofrade/SEUdaily/distribution-ci.yml?branch=main&amp;style=flat-square&amp;label=CI" alt="Distribution CI" /></a>
    <a href="https://github.com/miunerofrade/SEUdaily/blob/main/LICENSE"><img src="https://img.shields.io/github/license/miunerofrade/SEUdaily?style=flat-square&amp;color=0b918a" alt="MIT license" /></a>
    <a href="#分发与运行环境"><img src="https://img.shields.io/badge/Node.js-22%20%2F%2024-155bc4?style=flat-square&amp;logo=nodedotjs&amp;logoColor=white" alt="Node.js 22 / 24" /></a>
    <a href="#分发与运行环境"><img src="https://img.shields.io/badge/Python-3.11%2B-0b918a?style=flat-square&amp;logo=python&amp;logoColor=white" alt="Python 3.11+" /></a>
    <a href="#分发与运行环境"><img src="https://img.shields.io/badge/macOS%20%7C%20Windows%20%7C%20Linux-334155?style=flat-square" alt="macOS, Windows and Linux" /></a>
  </p>

  <p>
    <a href="#快速安装">快速安装</a> ·
    <a href="#首次配置">首次配置</a> ·
    <a href="#可以做什么">功能概览</a> ·
    <a href="#常用命令">使用说明</a> ·
    <a href="https://github.com/miunerofrade/SEUdaily/issues">反馈问题</a>
  </p>
</div>

---

面向东南大学学习与校园事务的本地助手。**安装一个包，就能使用终端聊天与共享后端。** 需要网页时启动 Web 工作台，两种界面共用会话、设置与校园工具。

普通聊天直接运行；Web、Python 和浏览器组件在首次需要时自动准备。

聊天中上传的文档自动加入[知识库](docs/knowledge.md)，后续正常提问即可跨会话检索。文本向量使用阿里云百炼 `qwen3.7-text-embedding`，聊天模型单独配置。

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

首次运行 Web 时自动安装网页组件，并打开 `http://127.0.0.1:4111`。终端和 Web 可以同时运行，共享自动启动的后端。

需要后端在所有界面退出后继续运行时，先执行 `seudaily serve`，之后照常使用 `seudaily` / `seudaily web` 连接它。部署、存储路径与验证码操作见[个人常驻服务说明](docs/service.md)。

`-g` 将命令安装到当前 Node 环境的全局目录，随后可在任意工作目录执行 `seudaily`。

校园、文档及浏览器工具在首次使用时联网准备对应组件和运行环境，后续复用缓存。普通聊天直接使用主包。

## 首次配置

运行 `seudaily settings` 打开终端设置，或在聊天输入框输入 `/settings`。使用 Tab / ↑↓ 切换字段，Ctrl+U 清空当前输入，Ctrl+S 保存，Esc 返回聊天。密码和密钥隐藏显示，留空保留原值。保存环境配置后，退出界面并执行 `seudaily stop`，再启动即可生效。

也可在 Web 的设置页面填写配置，或在用户数据目录中创建 `.env`。已有后端运行时，修改环境变量或手动编辑 `.env` 后，请先执行 `seudaily stop`，再启动。

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

按需填写对应服务的密钥。完整配置项见 [.env.example](https://github.com/miunerofrade/SEUdaily/blob/main/.env.example)。也可以直接通过系统环境变量配置，例如：

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

校园服务使用校园账号，通过校园网络或本地 VPN 访问；短信与二次验证按界面提示完成。

## 可以做什么

| | 功能 | 日常用法 |
| :---: | --- | --- |
| 💬 | **对话与资料** | 终端与 Web 聊天、历史会话、Markdown 与公式、图片和文档附件 |
| 📅 | **个人课表** | 同步课程安排，调整学期日期和课程信息 |
| 📚 | **课程学习** | 查询点播与录播，获取字幕、课件与媒体，生成课程笔记 |
| 🎓 | **培养方案** | 同步个人方案，结合历年课表核对课程与学分 |
| 🔔 | **通知与 Focus** | 查看校园通知，创建、编辑和暂停关注任务 |
| 🔗 | **校园 VPN** | 建立本地代理，供校园工具及宿主机程序访问授权资源 |

聊天查课表会自动同步缺失缓存，已有缓存仅在明确要求刷新时重新同步，断网保留旧数据；同步时顺带缓存学校校历和调课通知，已有校历附件不重复下载。校历通过已有网页读取能力访问固定入口，不增加专用工具；聊天可按现有权限设置学期、增课及调整单次课程。课表、培养方案和常规课程查询优先使用 HTTP。通用网页操作与部分交互登录按需启动浏览器。

源码维护者可在 `src/seudaily/notice_categories.json` 维护教务处（`jwc`）和计软智学院（`cse`）的公开栏目。每个机构包含 `name`（中文机构名）、`host`（站点域名）和 `categories`；栏目项为 `"栏目键": ["栏目中文名", "/栏目/list.htm"]`。只支持已知站点的 WebPlus 栏目路径；修改后重新启动后端生效。现有解析、缓存、附件和 Focus 继续复用；新增栏目键如需出现在固定界面筛选或工具枚举中，也需同步对应选项。额外链接来源（例如 `news`）可只填写 `name` 和 `host`，用于资料库中文来源名，不启用新的抓取器。此配置不支持任意站点抓取、认证接口或抽取脚本。

**同一份数据，两种使用方式：** 在终端里快速提问，在网页里查看课表、培养方案、通知和资料；也可以同时使用。

## 常用命令

```bash
seudaily                       # 默认终端聊天
seudaily chat                  # 同上；也可用 -c / --chat
seudaily web                   # 网页；也可用 -w / --web
seudaily settings              # 终端配置界面
seudaily ask "查看今天的课程"    # 单次提问
seudaily ask --stdin --json     # 从标准输入读取问题，输出 JSONL
seudaily --resume               # 选择并恢复已有会话
seudaily sessions               # 会话列表
seudaily skills                 # Skill 列表
seudaily status                 # 查看本地后端状态
seudaily stop                   # 停止本地后端
seudaily update                 # 检查并更新版本
seudaily --help                 # 完整参数说明
seudaily --version
```

自定义数据目录或后端端口：

```bash
seudaily --data-dir ./my-seudaily
seudaily web --data-dir ./my-seudaily --port 4112
```

使用相同数据目录、后端端口和应用版本的界面共享后端。

关闭 Web 启动终端时按 `Ctrl+C`；仅关闭网页标签不会结束启动器。终端聊天短按 `Ctrl+C` 取消当前运行，`Ctrl+D` 或持续重复 `Ctrl+C` 退出。自动启动的后端会在最后一个界面退出后停止。

Shell 补全：

```bash
seudaily completion zsh
# 同样支持 bash、fish、powershell；按对应 Shell 的方式加载输出
```

## 附件与斜杠命令

终端中粘贴或拖入本地文件路径，文件会显示为附件项；输入提示词后按 Enter 发送。左右方向键跨过附件项，Backspace/Delete 删除对应项。图片通过本地文件路径添加。

Web 使用附件入口上传。两端每条消息合计最多 **10 个附件**：

| 类型 | 格式 | 单个大小上限 |
| --- | --- | --- |
| 图片 | PNG、JPEG、WebP、GIF | 10 MB |
| 文档 | PDF、DOCX、XLSX、PPTX | 50 MB |

图片由支持图像输入的模型读取，文档解析结果随用户消息发送。

常用输入框命令：

```text
/notices
/mode
/ramdisk 768M
/ramdisk status
/ramdisk unmount
/ramdisk reveal
/vpn
/vpn connect 11081
/vpn status
/vpn verify
/vpn disconnect
```

内存盘容量支持 **64 MB–64 GB**，用于媒体临时文件；有处理任务时不能卸载。Windows 首次启用时自动下载 ImDisk Toolkit（约 750 KB）并请求管理员授权，安装完成后再次启用；已有驱动直接复用。macOS/Linux 使用系统挂载工具。Skill 选择仅作用于下一次发送，发出后清除。

`/vpn` 直接连接，复用已保存的代理端口，未设置时使用 `11081`；只有更改端口时才需要 `/vpn connect 端口`。

运行中继续输入消息并按 Enter，会进入当前会话的待发送队列。TUI 在输入框为空时按 ↑ 取回最后一条排队消息，取回即从队列移除；Web 可直接编辑或删除。取消或发送失败会暂停队列，TUI 使用 `/queue resume`，Web 点击“继续队列”。

`/vpn` 持续回报连接状态；已经连接时显示“VPN 已连接”。`/vpn status` 查看状态，`/vpn disconnect` 断开连接。

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

宿主机程序通过 HTTP 代理访问校园网。校园域名使用隧道中的校园 DNS，默认 `202.119.24.12`，可用 `SEUDAILY_VPN_DNS_SERVER` 修改。

VPN 与业务门户分别维护登录会话，失效时重新认证。普通登录使用 HTTP，短信验证支持应用内续接，复杂交互通过浏览器完成。

首次连接按需下载固定版本的 zju-connect 核心并校验 SHA256，也可用 `SEUDAILY_VPN_BINARY` 指定已有核心。它是独立的 AGPL-3.0 第三方程序，不包含在 npm 发布包内；对应许可证与源码入口见 [VPN 许可证说明](https://github.com/miunerofrade/SEUdaily/blob/main/docs/licensing-vpn.md)。

## Focus 与工具权限

创建 Focus 前会提示授权：该任务可免逐次工具审批，但不获得 extra 工作区文件和终端能力。编辑要求沿用同一任务与会话，后续执行使用新要求并保留历史版本；暂停停止自动执行，删除撤回授权。Focus 没有自动到期时间，登录续接请求有效期为 30 分钟。

TUI 输入 `/mode` 打开权限选择，用左右方向键选择并保存，与 Web 共享设置，下一轮生效：

| 模式 | 工具访问 |
| --- | --- |
| 普通 | 需要写入、命令和浏览器交互时逐项审批；微信支持文本确认／取消 |
| 完全访问 | 业务工具和浏览器交互免审批 |
| 完全访问-extra | 在完全访问基础上增加工作区文件与终端能力 |

模型、搜索与转写使用配置的服务。

## 数据、更新与卸载

默认数据目录：

| 系统 | 目录 |
| --- | --- |
| macOS | `~/Library/Application Support/SEUdaily` |
| Windows | `%LOCALAPPDATA%\SEUdaily` |
| Linux | `$XDG_DATA_HOME/seudaily`，未设置时为 `~/.local/share/seudaily` |

数据目录保存 `.env`、会话数据库、校园会话和设置，课程产物位于 `exports/`。后端日志位于数据目录下的 `.seudaily/logs/core.log`。可用 `--data-dir` 或 `SEUDAILY_DATA_DIR` 覆盖数据目录，用 `SEUDAILY_CACHE_DIR` 覆盖组件缓存目录。

校园 HTTP 密码登录首次使用时，在实际数据目录的 `.seudaily/campus-device.json` 原子保存随机设备标识；后续课程、课表、培养方案和 VPN 登录共享它，重启后保持稳定，短信续接也沿用同一标识。旧 Cookie 格式保持兼容。该文件不含账号密码；文件损坏时会提示检查并停止密码提交，不自动更换设备身份。如确需重置，停止后端后删除此文件，下次密码登录会生成新标识。是否影响验证码触发需要本人实测，当前没有线上验证结论。

检查并升级到最新版本：

```bash
seudaily update
```

更新命令复用当前安装位置，自动停止旧后端，完成后重新启动 `seudaily` 即可。TUI 在后台检查新版本并显示提醒，结果缓存一天，退出时取消检查。

从 1.1.2 及更早版本升级时，先运行一次：

```bash
seudaily stop
npm install -g seudaily@latest
```

组件与主包版本保持一致，首次使用时自动安装。更新或卸载后保留用户数据。

```bash
npm uninstall -g seudaily
```

迁移旧源码目录的数据：

```bash
seudaily import-data /path/to/old/SEUdaily
```

该命令复制数据并保留原件；目标数据目录须为空，源后端须先停止。

## 分发与运行环境

`seudaily` 负责安装与管理以下组件：

| npm 包 | 职责 |
| --- | --- |
| `seudaily` | 公共名称；内置 CLI、共享后端、Agent 与会话存储 |
| `@miunerofrade/seudaily-web` | 按需安装的 Web 静态页面 |
| `@miunerofrade/seudaily-python` | 校园、VPN 和可选工具的 Python 代码，以及各功能独立的依赖清单 |
| `@miunerofrade/seudaily-browser` | 按需安装的浏览器自动化服务与驱动 |

工具首次使用时优先复用已有 uv 0.11.1+ 和 Python 3.11+，缺少时自动下载。依赖安装在应用专用虚拟环境。Python 3.11、3.12、3.13 均有 CI 验证。

校园 HTTP 查询和 VPN 只安装基础 HTTP、认证及时区依赖。首次解析 PDF/Office 文档时安装文档库；首次使用课程摘要、云端转写或视频幻灯片提取时分别安装对应依赖。图片附件直接发送给模型，不触发文档或浏览器安装。

准备过程中，终端和 Web 会显示当前下载、安装阶段，以及完成或失败结果；已准备的依赖直接复用。Web 界面组件安装发生在网页打开前，进度显示在启动终端中。

通用浏览器工具按需安装浏览器服务；校园业务只有实际进入浏览器登录或页面兜底时才安装 Python Playwright。两端版本一致，共享浏览器引擎缓存。Windows 默认使用已有 Edge，macOS 使用 Playwright WebKit，Linux 使用 Playwright Firefox。Linux 浏览器所需系统库按安装提示准备；媒体处理使用系统 FFmpeg。

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

构建后执行 `npm link --ignore-scripts`，即可直接使用 `seudaily` 和所有子命令，无须加 `uv run`。继续使用仓库内的数据时，可在当前终端执行 `export SEUDAILY_DATA_DIR="$PWD"`，或每次传入 `--data-dir "$PWD"`。修改源码后重新执行 `npm run build`。

源码兼容入口 `uv run seudaily` 仍可使用，默认保留仓库数据。独立开发后端与网页可运行 `npm run dev` 和 `npm run dev:web`；Vite 仅用于开发。

```bash
npm run typecheck
node --import tsx --test tests/*.mjs
uv run --frozen pytest -q
npm run test:distribution
```

`main` 统一维护 CLI、Web 与公共核心，旧 `cli` 分支已合入，旧 `dev` 停止维护。GitHub Actions 验证 Windows、macOS、Linux，以及 Node 22/24 和 Python 3.11/3.12/3.13 的组合。

更多信息：[分发说明](https://github.com/miunerofrade/SEUdaily/blob/main/docs/distribution.md) · [发布维护](https://github.com/miunerofrade/SEUdaily/blob/main/docs/npm-release.md)。

## 许可证

SEUdaily 自有代码采用 [MIT](https://github.com/miunerofrade/SEUdaily/blob/main/LICENSE)。发布包保留打包依赖的第三方许可证声明；VPN 核心及其他第三方软件遵循各自许可证，见 [第三方声明](https://github.com/miunerofrade/SEUdaily/blob/main/THIRD_PARTY_NOTICES.md)。

### 微信接入与会话

执行 `seudaily wechat`，在 TUI 扫码接入；或运行 `seudaily web`，点击“微信”在浮层扫码和输入手机验证码。命令自动复用或启动常驻后端，退出界面后继续收发。普通文字进入当前 Agent 会话；发送 `/help` 查看 `/new`、`/sessions`、`/use`、`/context`、`/history`。会话管理不需要模型配置，文字聊天使用已有模型设置；微信直接发送文件会保存到资料库并自动索引，收件确认不调用聊天模型；微信图片、语音、视频尚未接入。接入资格及真实账号测试需本人完成。操作、存储与恢复说明见 [docs/wechat.md](docs/wechat.md)。

服务管理：`seudaily ps` 列出运行中的 SEUdaily 后端；`seudaily stop --port 4111` 或 `seudaily stop <PID>` 只停止选定的一个服务。旧版后端也可以查看和停止，不要求版本或数据目录与当前 CLI 一致。源码用户可用 `seudaily wechat --data-dir "$PWD"` 保留仓库中的原有数据。所有子命令均通过 npm 的 `seudaily` 入口运行。

微信与终端均支持 `/permission` 查看模式，`/permission normal|full|extra` 切换并持久保存共享权限。微信待审批操作会显示四位短码，可回复“确认 短码”或“取消 短码”（兼容旧编号的开头或末尾至少四位），也支持 `/approve 编号`、`/deny 编号`。学期默认总周数为 16，只设置起始日期时不修改其他字段。

### 网页与通知资料的来源目录

资料库首次进入仅显示分类目录，不默认选中或展开文件；点击分类后逐层展开。资料搜索默认收起，可通过右上角“搜索资料”按钮打开；不额外展示索引文件列表，原文件仍在资料库中浏览。网页资料按“网页与通知 → 机构/网页来源 → 文件”浏览。通知源配置中的 `name` 用于显示机构名称，如教务处、计软智学院；其他网页以域名作为来源。文件元数据记录结构化 `source: {id, name}`、`sourceUrl`、原名称、哈希和文件路径，不需要新增数据库表。

原文件保存在实际数据目录的 `.seudaily/web-files/files/<来源域名>/<内容哈希>.<扩展名>`；对应的 URL 元数据在 `.seudaily/web-files/metadata/`。例如教务处文件保存在 `files/jwc.seu.edu.cn/`，计软智学院文件保存在 `files/cse.seu.edu.cn/`；无法识别来源的旧文件保存在 `files/unclassified/`，界面显示“未分类”。

读取资料库时，兼容层将旧的平铺文件迁移到来源目录，并原子更新元数据路径：先复制并校验内容，完成所有引用更新后才删除旧位置；冲突或损坏的记录保留原文件。迁移可以重复执行，无需联网或重新解析附件。已删除的原文件不会因迁移而恢复。上传文件、会话数据库、通知抓取缓存与 RAG 索引继续使用各自的存储位置。

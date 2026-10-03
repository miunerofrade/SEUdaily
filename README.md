# SEUdaily

SEUdaily 是一个面向日常学习与校园生活的本地优先 Web 助手。它使用独立 TypeScript Agent 循环处理模型调用、工具执行、会话记忆与流式事件，以 React/Vite 提供对话工作台，并由 Python 自动化核心完成课程门户、课表、教务通知、字幕、媒体和语音处理。

当前稳定版本为 **1.1.0**。主要能力包括：

- ChatGPT 风格的多会话 Web UI，支持服务端历史、删除确认、编辑提示词、重新生成和复制。
- GFM Markdown、浅色代码高亮、KaTeX 行内/块级公式以及代码和回答复制。
- 工具执行与 reasoning 流式状态；最终回答产生后自动折叠工具过程。
- 图片选择与 `Ctrl+V` 粘贴、输入框内预览、历史消息持久引用及文件删除 fallback。
- 按当前周、单双周和节次展示的完整课表。
- 可设置学期起始日期、编辑抓取课表、添加单日课程，并将用户修正与远端元数据分开保存。
- 从 eHall 同步个人培养方案，按课程分类、选择组和专项要求展示学分结构，并通过独立 Skill 联合历年课表核查缺课、缺学分与毕业风险。
- Focus 接收自然语言关注目标，由大模型扩展多组查询并语义判断教务通知；课程按课程名称聚合教师与排课，并在结束一天后自动尝试抓取转写和总结。
- 按笔记、字幕、媒体和临时图片浏览的渐进式资料库，支持预览与手动删除。
- 支持上传 PDF、DOCX、XLSX、PPTX 等文档并将解析文本作为附件上下文；也可读取明确的公开网页，并在需要时临时下载和解析页面附件。
- 教务通知、运行设置、API Key 和环境变量管理。

完整变更见 [CHANGELOG.md](CHANGELOG.md)。

## Architecture

```text
apps/
└── web/
    └── src/
        ├── App.tsx               # 对话、会话、图片与工具流 UI
        ├── workspace-pages.tsx   # Focus、课表、资料库、通知和设置
        ├── api.ts                # Agent、记忆与应用 API 客户端
        └── markdown.ts           # Markdown/KaTeX 规范化
src/
├── agent/                       # 模型循环、审批、会话存储与按需摘要
├── server/                      # 本地 HTTP 路由和 SSE 适配
├── runtime/                     # 业务工具、附件、浏览器与工作区适配
│   ├── instructions.ts          # SEUdaily 行为与领域 Skill
│   ├── app-routes.ts            # 课表、资料、图片、通知与设置 API
│   ├── tools/python-bridge.ts   # 常驻 Python Worker JSONL 桥
│   ├── workspace.ts             # 项目文件、终端与后台进程工具
│   └── runtime-paths.ts         # 项目和运行数据路径
└── seudaily/
    ├── service.py                 # 与 UI 无关的业务服务
    ├── cli.py                     # JSON 工具协议入口
    ├── worker.py                  # 无控制台窗口的常驻工具进程
    ├── browser_runtime.py         # 系统 Edge 与门户 Context 复用
    ├── protocol.py                # 统一工具结果、产物与引用
    ├── auth.py                    # 门户认证与 Cookie 会话
    ├── schedule.py                # 校内课表同步、用户覆盖层、学期日期与本地缓存
    ├── focus.py                   # 教务通知关注与课程延迟 Catch
    ├── jwc.py                     # WebPlus 查询抽象及教务处/计软智站点适配器
    ├── capture.py                 # 课程、字幕与媒体抓取
    ├── asr/                       # 本地/云端语音转写
    ├── ppt.py                     # 视频幻灯片提取
    ├── summary.py                 # 课程讲义生成
    └── ramdisk.py                 # Windows/macOS/Linux 内存盘
```

Streamlit 页面层已经移除。账号、密码和密钥默认从环境变量读取，不进入 Agent 提示词。

## Setup

要求：Node.js 22.22+（22.x）或 24.12+、npm 10+、Python 3.13 和 uv。校园门户与浏览器工具按平台选择 Windows Edge、macOS WebKit、Linux Firefox；媒体抓取、云 ASR 和视频抽帧需要系统 FFmpeg。基础对话、通知和文档解析不需要 FFmpeg。Windows 上推荐启用 WSL2 Ubuntu；终端沙盒不依赖 Docker Desktop。

如果 `cd` 时 fnm 提示找不到 Node，当前保留 Node 22 的版本要求，待独立运行时稳定后再验证最低支持版本。项目 `.node-version` 指向 22，使用已有 fnm：

```bash
fnm install 22
fnm use 22
node --version
```

无需改变 fnm 全局默认版本。当前按 Git 仓库开发运行：

```bash
git clone https://github.com/miunerofrade/SEUdaily.git
cd SEUdaily
npm ci
uv sync --frozen
```

本地 ASR 暂不纳入安装与支持范围，不需要 Torch、Faster Whisper、CTranslate2、CUDA 或本地模型。云 ASR 使用基础依赖中的 DashScope 和 `SEUDAILY_ASR_API_KEY`，媒体提取仍需系统 FFmpeg。

默认安装不包含视频幻灯片提取依赖，需要时安装：

```bash
uv sync --frozen --extra ppt
# 兼容原来的 media extra（目前同样只包含视频抽帧依赖）
uv sync --frozen --extra media
```

基础课表、教务通知、网页、文档和课程门户查询不需要上述媒体 extra。未安装时，相关功能会在真正调用时返回缺少可选依赖的提示；启动 Python Worker 不会预先导入 OpenCV。

浏览器默认按平台自动选择：Windows 使用系统 Microsoft Edge；macOS 使用 Playwright WebKit（Safari 的引擎，不能直接控制系统 Safari）；Linux 使用 Playwright Firefox。可选 `SEUDAILY_BROWSER=auto|msedge|webkit|safari|firefox|chromium` 覆盖，`safari` 是 `webkit` 的别名。Node MCP 和 Python 校园工具分别依赖自己的 Playwright 版本，macOS 初始化时依次安装两端运行时（不要并行，以免缓存目录锁冲突）：

```bash
npx --no-install playwright install webkit
uv run --frozen playwright install webkit
```

Linux 将上述 `webkit` 换为 `firefox`，并根据 Playwright 官方提示安装对应系统依赖。Windows 默认已有 Edge 时不需要下载 WebKit/Firefox。更新 Node/Python Playwright 后可能需要重新安装匹配的运行时。

校园工具遇到校园域名 DNS、连接失败或导航网络超时时，捕获异常并显示“需要校园网环境”；不自动重试或修复网络。登录失效、缺浏览器和非校园服务错误保持原有提示。

仓库提交 `package-lock.json` 与 `uv.lock`。CI、部署和复现环境应使用 `npm ci` 与 `uv sync --frozen`，不要在未审查锁文件差异的情况下更新依赖。

复制 `.env.example` 为 `.env`，按需填写：

```dotenv
DEEPSEEK_MODEL=deepseek-flash
DEEPSEEK_API_KEY=
TAVILY_API_KEY=
SEUDAILY_PROJECT_ROOT=
SEUDAILY_OBSERVATIONAL_MEMORY=true
SEUDAILY_CONTEXT_WINDOW_TOKENS=512000
SEUDAILY_OBSERVATION_COMPRESSION_RATIO=0.8
SEUDAILY_MEMORY_LAST_MESSAGES=200
SEUDAILY_PREVIOUS_OBSERVER_TOKENS=1500
SEUDAILY_WORKSPACE_COMMAND_TIMEOUT_MS=120000
SEUDAILY_WSL_SANDBOX=true
SEUDAILY_WSL_DISTRO=Ubuntu-24.04
SEUDAILY_SANDBOX_NETWORK=false
SEUDAILY_USERNAME=
SEUDAILY_PASSWORD=
SEUDAILY_ASR_API_KEY=
SEUDAILY_BROWSER=auto
```

## 启动

首次安装依赖后，推荐用一个命令同时启动 Agent 后端和 Web 前端：

```bash
uv run seudaily start
```

如果已经激活项目的 `.venv`，可以直接运行：

```bash
seudaily start
```

命令会等待两个服务就绪，然后显示：

- Web 工作台：`http://127.0.0.1:4173`
- Agent API：`http://localhost:4111/api`

后端和前端日志分别写入 `.seudaily/logs/backend.log` 与 `.seudaily/logs/web.log`。按 `Ctrl+C` 会同时停止两个服务。

也可以分别启动后端和前端：

```bash
npm start
npm run dev:web
```

或使用 npm 的组合脚本：

```bash
npm run dev:all
```

前端通过 Vite 代理访问本机 Agent API。会话和消息以 `.seudaily/agent.db` 为主存储，旧 `.seudaily/mastra/mastra.db` 首次以只读方式导入并保留，不同浏览器读取同一服务端历史；浏览器本地存储只用于兼容旧记录与短暂 fallback。删除会话会同时清理服务端线程和本地镜像。

`npm run dev` 会监听后端源码变化并重启服务：

```bash
npm run dev
```

查看启动器帮助或版本：

```bash
uv run seudaily --help
uv run seudaily start --help
uv run seudaily --version
```

检查类型：`npm run typecheck`。当前使用源码和 Vite 启动，不需要生产构建。

## CLI / TUI（cli 分支）

`cli` 分支提供 Ink / React / TypeScript 全屏终端界面，复用现有 Node Agent 和本地数据库。Python 仅保留 uv 启动和进程管理，终端业务与界面均由 TypeScript 实现。CLI 代码与依赖留在该分支；通用 Skill、Web Skill 选择、课表查询和取消修复已同步到 `main`。不需要生产构建或安装 Torch。

```bash
uv sync
uv run seudaily                  # 默认进入 TUI
uv run seudaily -c               # --chat 的短名称
uv run seudaily chat --resume    # 恢复最近使用的会话
uv run seudaily -h
uv run seudaily -V               # --version；-v 表示详细日志
uv run seudaily exec -p "今天有什么课？"
printf '只回复你好' | uv run seudaily exec --json
uv run seudaily skills
uv run seudaily sessions
```

激活 `.venv` 后可以直接输入 `seudaily`。`--cwd` 选择本仓库目录，`--no-start` 只连接已有后端，`--timeout` 设置 HTTP 读取超时，`--skill NAME` 显式选择 Skill，`--vi` 切换输入按键，`--no-color` 禁用颜色，`-q/--quiet` 隐藏工具过程。帮助和版本不会初始化后端、数据库、模型或 Worker。

`/resume` 或 `uv run seudaily --resume` 先显示会话选择列表，支持中文标题 / ID 搜索、方向键、滚轮和点击恢复；Esc 返回当前会话。指定 ID / 序号可直接恢复，`latest` 显式恢复最近会话。

输入框使用真实终端光标，位置按中文字符显示宽度计算。输入法提交文字与回车同批到达时，保留文字在草稿中；独立的下一次 Enter 才发送。

没有服务时 CLI 只启动后端，将日志写入 `.seudaily/logs/cli-backend.log`，退出时清理自己启动的进程；连接现有服务时保持其运行。聊天采用 Ink 全屏 TUI：对话区独立滚动，底部固定输入框和模型用量信息，支持基础 Markdown 与带边框的聊天表格，中文单元格按终端宽度换行；等待模型时，输入框上方显示 Thinking 动画；DeepSeek 返回的思考文本默认显示一行，点击或 Ctrl+T（`/thinking`）展开 / 折叠，展开区域内滚轮单独查看完整思考，历史会话也可恢复。鼠标直接拖选文字，默认只高亮，macOS 在支持增强键盘协议的终端可用 Cmd+C，Windows / Linux 使用 Ctrl+C，macOS 也保留 Ctrl+C 兼容方式；Esc 清除选区；`/copy-on-select on` 可开启松开鼠标自动复制，`off` 关闭，偏好保存在 `.seudaily/cli-preferences.json`。选区保留时暂停流式画面刷新，清除后显示最新内容；普通点击和滚轮保持可用。复制使用 macOS 的 pbcopy、Linux 的 wl-copy/xclip/xsel、Windows 的 PowerShell，SSH 或无本地剪贴板工具时使用 OSC 52（终端需支持）；不会因为简单拖选就改写剪贴板。启动先关闭终端输入回显再初始化界面；macOS Terminal.app 不进行增强键盘协议探测，其他终端按需自动检测，仅增强快捷键和按键释放的识别；普通文字保留输入法生成的 UTF-8，不启用全按键编码上报。进入界面时清除旧会话可能遗留的文字按键上报模式。PgUp/PgDn 或鼠标滚轮查看历史，Ctrl+End 返回最新回答；退出后恢复原终端画面。普通输入通过 Agent 处理，Enter 发送，Alt+Enter 换行，补全候选以命令和中文说明表格显示，上下键选择，Tab 或输入末尾的右方向键接受；命令未输入完整时，Enter 接受高亮候选，补全后再次 Enter 执行；没有候选时上下键查询输入历史，Ctrl+C 取消当前任务或清空输入，Ctrl+D 直接退出；持续按住 Ctrl+C 约一秒退出，短按仍用于复制选区、取消任务或清空输入。输入框从一行开始，随内容自动扩展；粘贴至少 6 行或 1,000 字符时显示 `[pasted text +N lines]`，方向键跨过整个块，Backspace/Delete 整体删除，发送时展开为原文。粘贴不会自动发送。居中的底栏显示当前模型、effort（聊天请求默认 high）、会话累计 token 与输入缓存命中率，未报告的用量显示 `—`；新会话清零，恢复会话按运行 ID 去重。启动器优先使用满足要求的当前 Node；当前版本不兼容时可使用 fnm 中已有的 22.x，不修改 Shell 默认版本。输入历史和最近会话标记保存在 `.seudaily/cli-history`、`.seudaily/cli-state.json`，Unix 上权限为 0600。

主要斜杠命令：

| 命令 | 作用 |
| --- | --- |
| `/help`、`/new`、`/sessions`、`/resume [ID或序号]`、`/history` | 帮助、会话与原始历史 |
| `/schedule`、`/课表` | 默认只读取本地课表 |
| `/schedule --date YYYY-MM-DD --semester YYYY-YYYY-N` | 按日期或学期查看课表 |
| `/schedule --sync`、`/schedule --semesters` | 显式同步近四年的可选学期、列出缓存学期 |
| `/schedule --start-date YYYY-MM-DD` | 确认后保存当前学期起始日期 |
| `/programs --page 1 --limit 20`、`/培养方案` | 培养方案与学分；支持 `--plan ID`、`--filter 名称`、`--sync` |
| `/audit 问题`、`/training-plan-audit 问题` | 调用培养方案核查 Skill |
| `/skills`、`/skill NAME 问题`、`/skill off` | 发现、调用或取消显式 Skill；无问题时选择后续消息使用的 Skill |
| `/notices 问题`、`/focus` | 校园通知、关注列表；`/focus 需求` 由 Agent 提出操作 |
| `/login schedule`、`/login 登录ID` | 主动登录或登录后自动续接原任务 |
| `/approve`、`/reject` | 处理当前运行的待审批工具，批准只消费一次 |
| `/apply 操作ID` | 确认后执行 Agent 提出的本地操作 |
| `/mode normal或full或extra` | 确认后设置权限；与连接的 Web 共享并持久保存 |
| `/attach "文档路径"`、`/detach` | 添加或清空待发送的 Office/PDF 文档 |
| `/cancel`、`/quit` | 取消、退出 |

项目 Skill 位于 `.agent/skills/<名称>/SKILL.md`，包含 YAML `name`、`description`，可选 `namespaces` 列表。目录可通过 `/skills` 刷新，`/名称 问题` 可直接调用；模型也能通过 `list-skills`、`read-skill` 发现和加载规则，参考资料限定在该 Skill 的 `references/*.md` 内。当前提供 `training-plan-audit`。

`/schedule` 默认打开带时间和制表边框的周课表，连续节次合并课程区域；Tab 切换学期、周次、课程搜索与详情，Enter 选择，↑↓ 选课程，鼠标点击查看详情。滚轮或 PgUp/PgDn 查看其余节次，窄窗口用左右键查看其余星期，g 切换列表。`/programs` 按网页布局展示学分概览、进度、修读要求及按学期分组的课程表，支持方案、修读状态、课程搜索和学期筛选；选中课程查看完整信息。已完成学分与 Web 使用相同统计口径。r 显式同步，默认只读缓存。Esc 返回聊天。审批与本地修改使用独立确认面板，默认选中拒绝。

单次模式的标准输出为回答，`--json` 为逐行 SSE 事件对象；诊断写标准错误。退出码：0 完成、1 失败、2 参数错误、3 等待审批、130 中断。等待审批时用提示中的会话 ID 进入 TUI，再执行 `/approve` 或 `/reject`；不会自动批准或重放工具。校园网异常只显示“需要校园网环境”，不重试。

`seudaily completion bash|zsh|fish|powershell` 只输出补全脚本，由用户自行加载。例如在 Bash/Zsh 中运行 `source <(seudaily completion zsh)`（Bash 改为 bash）。当前完成了命令与参数补全；交互输入支持斜杠命令、Skill 名称和附件路径补全。

多媒体文件粘贴与复制暂缓；终端交互式子程序的 PTY/ConPTY 转接也暂未实现。需要运行命令时，明确向 Agent 提出请求并使用现有工作区权限与沙盒工具。

## Web workspace

Web 工作台入口为 `http://127.0.0.1:4173`，包含以下页面：

- **新对话 / 历史会话**：流式回答、Markdown、公式、代码高亮、图片消息、提示词编辑、重新生成与会话删除。
- **课表**：读取本地缓存或显式同步，根据用户设置的学期起始日期计算教学周；支持修正教室、教师、星期、节次与周次，并可添加常规或单日自定义课程。
- **培养方案**：从 eHall 同步个人培养方案，展示总学分、课程分类、培养要求和选择组；对话中的“培养方案检查”Skill 可结合已缓存的历年课表，整理要求学分、修读证据和待确认缺口。课表记录只代表修读证据，最终是否通过及能否毕业仍以成绩、学分认定和教务审核为准。
- **Focus**：限定为学校场景。通知 Focus 由大模型从自然语言意图规划多组查询并判断相关性；课程 Focus 会将同一课程的排课去重、教师取并集，也可直接搜索并关注不在个人课表中的课程平台课程。通知每两小时检查一次；所有课程 Focus 每 24 小时最多执行一次，包括课次发现、抓取、总结和失败重试。课表课程从上课后一天开始处理，两种来源共用任务去重和最多 7 次重试，并分别持久化上次执行时间。
- **资料库**：按资料类型进入目录，再按课程与教师逐级浏览；支持图片、文本、Markdown、PDF、音视频预览以及二次确认删除。
- **教务通知**：读取已适配站点的通知列表并打开原始来源。
- **设置**：展示当前 Provider，维护 API Key 与允许写入的运行环境变量。敏感值由后端保存，不进入对话提示词。

输入框的 `+` 按钮可选择图片或文档，也可直接按 `Ctrl+V` 粘贴剪贴板图片。图片暂存在 `.seudaily/uploads/images`，消息只保存稳定引用、摘要和哈希，不保存整段 Base64；文档在服务端解析后以受标记的附件上下文送入当前对话。历史图片不存在时前端隐藏损坏缩略图并保留文字消息。

检查 Python 工具桥：

```bash
echo '{"action":"health","payload":{}}' | uv run seudaily-tool
```

检查常驻 Worker 协议：

```bash
echo '{"requestId":"health-1","taskId":"task-health","action":"health","payload":{}}' | uv run seudaily-worker
```

## Runtime and memory

项目 Skill 统一放在项目根目录的 `.agent/skills/<名称>/SKILL.md`，Web 和 CLI 使用同一目录。全局 Agent 指令读取根目录 `AGENT.md`；设置页面直接编辑该文件，保存后在下一轮对话生效，不另建指令配置。`AGENT.md` 属于本地用户配置，不纳入 Git。

### 1.x compatibility identifiers

产品、代码与新包元数据统一使用 **SEUdaily** / `seudaily`。Python 正式包目录为 `src/seudaily`，旧 `cvstream.*` 导入由薄兼容包转发；新运行数据目录为 `.seudaily`，环境变量使用 `SEUDAILY_*`。为兼容旧安装，`cvstream-tool` / `cvstream-worker` 仍是命令别名；旧 `CVSTREAM_*` 环境变量只在对应 `SEUDAILY_*` 未设置时作为 fallback。浏览器会话键、会话资源 ID、附件标记、图片引用和请求上下文均使用新名称写入，并在读取历史值时接受旧名称。

首次启动时会把 `.cvstream` 的文件逐项迁移到 `.seudaily`。目标目录已有同名文件时以 `.seudaily` 为准，旧文件保留在 `.seudaily/.migration-conflicts/cvstream/`；迁移状态写入 `.migration-cvstream-v1.json`。每个文件原子移动或先完整复制再删除来源，失败和中断会保留来源并在下次启动重试；符号链接或权限错误会写入 `.migration-status.json` 并中止启动，待问题修复后重试。迁移完成后应用只向 `.seudaily` 写入。会话原文保存在 `.seudaily/agent.db`。旧 Mastra 数据库保留；线程、消息和旧观察记忆通过事务导入，完成后写入迁移标记。上下文默认预算为 512000 tokens，预留 8192 tokens 给回答，在可用预算达到 80% 或未压缩消息超过 200 条时，用当前模型整理旧的完整轮次为结构化摘要，优先保留最近 8 轮和本轮原文。摘要单独保存，历史原文不删除；大工具结果通过 `resultRef` 按需读取。`SEUDAILY_CONTEXT_WINDOW_TOKENS`、`SEUDAILY_OBSERVATION_COMPRESSION_RATIO` 和 `SEUDAILY_MEMORY_LAST_MESSAGES` 继续可用，旧观察器专用开关和阈值不再使用。

工具首次使用时启动一个长期运行的 Python Worker，而不是每次工具调用都打开 PowerShell 和浏览器。普通抓取根据平台使用 Edge（Windows）、WebKit（macOS）或 Firefox（Linux）的无头模式，并统一静音；同一门户复用 Browser Context，每个任务使用独立 Page。只有登录、验证码或二次确认会临时打开可见浏览器。Web 的停止信号会先请求任务协作取消，未能及时退出时再清理 Worker 及其子进程树。

Web 端通过 SSE 接收回答、reasoning 和工具事件。reasoning 仅展示 Provider 实际返回的 reasoning 流；工具过程使用紧凑行展示，在最终回答出现后默认折叠。工具完整结果仍以 `resultRef` 落盘，避免把大对象反复写入上下文。

工具结果采用统一结构：`status`、`taskId`、`summary`、`data`、`artifacts`、`citations`、`warnings`、`metrics`。完整清洗结果写入 `.seudaily/tasks/<taskId>/result.json`，对话只保存经过列表、字符串和层级限制的结果及 `resultRef`；大段日志另存为 `diagnostics.json`。传给模型的关键数据最多约 6000 字符，并继续执行敏感信息脱敏。课程总结正文使用 `[S1]` 形式的行内引用，并在末尾生成来源表。

Agent Workspace 的文件系统被限制在项目根目录。读取、列目录、文件状态和正文搜索可直接执行；写入、编辑、建目录、终端命令和终止后台进程会在 Web 中按权限模式请求审批；工作区仅在 extra 模式提供。

Windows 上的终端和后台进程优先通过 WSL2 进入 Bubblewrap 原生沙盒。宿主机项目只读映射到 `/project`，`.seudaily/sandbox-workspace` 作为可写、持久的 `/workspace`；沙盒只挂载运行命令所需的 Linux 系统目录，清空继承环境，并默认隔离网络。独立运行时负责无窗口启动、输出流、超时、后台进程和进程树终止。macOS 使用 Seatbelt、Linux 使用 Bubblewrap；缺少隔离能力时明确标记为 host-fallback。课程 Python Worker、Playwright 浏览器与媒体处理仍在宿主机运行。

如果 WSL2、指定发行版或 `bwrap` 不可用，启动时会自动降级为宿主机执行模式。Fallback 仍使用固定暂存目录、最小环境变量、无窗口进程与超时控制，但不提供操作系统级文件或网络隔离。可通过 `SEUDAILY_WSL_SANDBOX=false` 主动使用 fallback；`SEUDAILY_SANDBOX_NETWORK=true` 影响原生沙盒模式。Ubuntu 中安装 Bubblewrap：`wsl -d Ubuntu-24.04 -u root -- apt-get install -y bubblewrap`。

## Available tools

- `authorize-course-portal`：打开可见浏览器并更新登录会话。
- `authorize-schedule-portal`：默认清理旧的 eHall Cookie，在全新的可见窗口中自动填写环境变量中的账号密码并提交普通登录；VPN 二次确认或验证码由用户在可见窗口完成。它只清理课表门户会话，不会删除 历史对话或课表缓存；如需保留 Cookie，可传 `resetSession: false`。
- `get-course-schedule`：默认读取当前学期的完整课表，返回全部课程，不截取前 12 门；可传 `semester: "2025-2026-2"` 切换并读取往年课表。传 `date: "YYYY-MM-DD"` 时按学期起始日期、教学周、星期、单双周和日期调整筛选当天课程；`date` 省略或为空时返回完整课表。通常 `1=暑期学校`、`2=秋季学期`、`3=春季学期`，但实际可用值始终以学校动态返回的 `availableSemesters` 为准，其他数字尾码也会保留。各学期使用独立缓存。联网同步默认复用登录会话直接请求接口，抓取上海时区当前年份减 4 年对应学年起的全部可选学期（2026 年从 2022–2023 学年起），不逐个点击学期。设置 `prefetchAvailableSemesters: false` 可只同步选中学期；本地读取保持离线。`includeAvailableSemesters: true` 返回此范围内的动态学期列表。返回值还包含 `currentSemester`、`currentSemesterLabel`、`selectedSemester`、`selectedSemesterLabel` 和批量同步结果。
- `get-current-date`：返回 Asia/Shanghai 当前日期、星期和时间戳，供“今天/明天”等相对日期查询使用；不应通过终端命令或读取本地文件获取日期。
- 当前远端课表保存在 `.seudaily/schedule.json`，指定往年学期的课表保存在 `.seudaily/schedule.<semester>.json`；学期展示设置和用户修改保存在 `.seudaily/schedule-user.json`，重新抓取不会覆盖用户修改。Focus 规则、事件与任务幂等记录保存在 `.seudaily/focus.json`。
- `search-seu-academic-affairs`：先用条件请求校验相关公告列表并立即返回，命中详情交给后台并发同步；支持“最新一条”“最近 N 天”和历史查询。
- `get-seu-academic-affairs-notice`：按搜索返回的稳定 ID 读取一条公告正文与附件链接，需要时可同步校验详情页。
- `search-seu-cse-notices`：分栏查询计算机科学与工程学院、软件学院、人工智能学院官网，命中详情在后台并发同步。
- `get-seu-cse-notice`：按 `seu-cse-*` 稳定 ID 读取计软智公告正文与附件链接。
- `list-courses`：列出课程点播目录中的课程。
- `search-courses`：按课程名、教室、教师或课程号搜索点播课程，可用 `semester` 选择页面上的真实学期值（例如 `2026-2027学年第1学期`）。校内定义为第 1 学期=暑期学校、第 2 学期=秋季、第 3 学期=春季；未命中时返回可选学期与课表外手动目标提示。
- `find-course-session`：用课程名、教师名和周内节次定位课程；日期缺省时返回最新一次课。
- `capture-course-session`：抓取选中日期下的全部课段，而不是详情页中的单个列表序号。
- `capture-course-sessions`：批量抓取多门课程；当前常驻共享浏览器串行访问门户，视频、PPT、ASR 等重任务同样串行，以避免 Playwright 线程冲突和内存峰值。
- `transcribe-local-media`：用 Faster Whisper 转写本地媒体。
- `transcribe-cloud-audio`：用云端 ASR 转写本地 MP3/WAV。
- `extract-course-slides`：从视频检测页面变化并生成 PDF。
- `summarize-course-transcripts`：可总结整批字幕、指定字幕文件或直接文本，并可指定总结重点与输出格式。
- `read-seudaily-task-result`：按 `resultRef` 和 JSON Pointer 分页读取被紧凑结果省略的数据，单次最多 12000 字符，仍执行敏感字段脱敏。
- `web-search`：通过 Tavily 查询公共互联网，返回网页摘要、原始链接和 `W1`/`W2` 引用；未配置 `TAVILY_API_KEY` 时返回明确的配置错误。
- `read-web-page`：本地读取一个明确的公开 HTTP(S) URL，提取网页正文，并在正文为空、过短、提示“详见附件”或问题明确询问附件时，按需解析页面实际发现的 PDF、DOCX、XLSX、PPTX。附件只下载到系统临时目录，解析后立即删除；教务处与计软智页面统一使用此工具。
- `fetch-web-pages`：通过 Tavily Extract 从最多 5 个明确公共 URL 中提取与 query 最相关的正文片段，返回 `F1`/`F2` 引用；拒绝本地、私网、带凭据或敏感签名参数的 URL。
- `playwright_browser_*`：仅暴露导航、无障碍树快照、快照查找、点击、输入、下拉选择、按键和标签页 8 个工具。独立浏览器会话不共享 Python Worker 的门户登录状态；点击、输入、选择、按键等交互需要 Web 审批。
- `mastra_workspace_read_file`、`list_files`、`file_stat`、`grep`：读取和搜索项目内文件，结果设有 token 上限。
- `mastra_workspace_write_file`、`edit_file`、`mkdir`：经用户审批后修改项目文件；覆盖现有文件前要求先读取。
- `mastra_workspace_execute_command`：经用户审批后在暂存区执行前台或后台命令；Windows 优先使用 WSL2/Bubblewrap（只读 `/project`、可写 `/workspace`），macOS 使用 Seatbelt，Linux 使用 Bubblewrap，默认禁用网络。原生隔离不可用时使用明确标记的 `host-fallback`。默认超时 120 秒，可通过 `SEUDAILY_WORKSPACE_COMMAND_TIMEOUT_MS` 调整。
- `mastra_workspace_get_process_output`、`kill_process`：查看或经审批终止 Workspace 自己启动的后台进程。

请仅处理本人具有合法访问权限的课程内容。

手动课程定位示例：课程每周安排在第 3–5 节时，传入 `weeklyPeriods: [3, 4, 5]`。手动目标必须提供 `courseName`、`teacherName`、`weeklyPeriods`；`courseDate` 可选，省略时自动选择符合排课节次的最新日期。同一日期下的所有课段会作为一个完整会话处理。

抓取工具支持两种课程目标：课表内课程传入 `{ source: "schedule", scheduleId }`；课表外课程传入 `{ source: "manual", courseName, teacherName, weeklyPeriods }`。两种目标都可选传 `courseDate`，未传时默认抓取最新日期。

教务处查询缓存位于 `.seudaily/jwc`。除 `cache_only` 外，每次查询都会先校验语义相关的栏目列表，但不会遍历所有详情页；命中的候选 ID 会进入本地队列，由独立后台进程以最多 4 路并发保存快照，不阻塞搜索返回。版本缓存只保留清洗后的正文、附件名称与链接、内容哈希，不保存完整 HTML，也不自动下载附件文件。嵌入式 PDF Viewer 的 `file` 参数会被还原为真实 PDF 附件地址。

计软智官网使用同一套 WebPlus 查询与后台缓存机制，缓存隔离在 `.seudaily/cse`。适配层单独配置栏目、语义路由、详情标题与日期类名；当前覆盖本科通知、教学动态、学生工作、就业、科研、学术活动、人才招聘以及本科/研究生下载专区。

内存盘可在聊天右侧的“任务与资料”面板启用，支持 512 MB、1 GB、2 GB 和 4 GB。macOS 使用系统自带的 `hdiutil` 创建 RAM 设备，Linux 使用 `tmpfs`（需要 root/CAP_SYS_ADMIN 或已授权的非交互 sudo），Windows 继续使用 ImDisk。媒体处理自动使用已启用的内存盘；未启用时使用独立的普通临时目录。内存盘使用期间拒绝卸载，macOS/Linux 正常退出服务时清理挂载，Windows 通过 UAC 请求挂载与卸载。内存盘不保存 Cookie、会话数据库或最终产物，不会在重启后自动挂载。可用 `SEUDAILY_RAMDISK_ENABLED=true` 和 `SEUDAILY_RAMDISK_SIZE=1G` 选择每个媒体任务自动创建内存盘，挂载失败时告警并回退普通临时目录。Linux tmpfs 可能使用 swap。进程被 SIGKILL 强制终止时无法执行退出清理，残留挂载需要系统工具卸载。

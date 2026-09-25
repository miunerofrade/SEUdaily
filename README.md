# SEUdaily

SEUdaily 是一个面向日常学习与校园生活的本地优先 Web 助手。它以 Mastra 负责编排、记忆与流式事件，以 React/Vite 提供对话工作台，并由 Python 自动化核心完成课程门户、课表、教务通知、字幕、媒体和语音处理。

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
├── mastra/
│   ├── agents/course-agent.ts     # SEUdaily 行为、提示词与工具授权
│   ├── app-routes.ts              # 课表、资料、图片、通知与设置 API
│   ├── image-reference-processor.ts # 历史图片引用解析与缺失 fallback
│   ├── tools/course-tools.ts      # Mastra 工具及输入 Schema
│   ├── tools/task-result-tool.ts  # 完整任务结果的受限分页读取
│   ├── tools/python-bridge.ts     # 常驻 Python Worker JSONL 桥
│   ├── workspace.ts               # 项目文件、终端与后台进程工具
│   ├── native-command-sandbox.ts  # WSL2/Bubblewrap 与宿主机 fallback
│   ├── storage.ts                 # LibSQL 对话记忆与上下文压缩
│   └── runtime-paths.ts           # 稳定的项目/运行时路径
└── cvstream/
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
    └── ramdisk.py                 # Windows Ramdisk 支持
```

Streamlit 页面层已经移除。账号、密码和密钥默认从环境变量读取，不进入 Agent 提示词。

## Setup

要求：Node.js 22.13+、Python 3.13、uv、FFmpeg，以及 Windows 自带或单独安装的 Microsoft Edge。Windows 上推荐启用 WSL2 Ubuntu；终端沙盒不依赖 Docker Desktop。

```bash
git clone https://github.com/miunerofrade/SEUdaily.git
cd SEUdaily
npm ci
uv sync --frozen
```

浏览器自动化直接复用系统 Microsoft Edge，无需额外下载浏览器运行时。

仓库提交 `package-lock.json` 与 `uv.lock`。CI、部署和复现环境应使用 `npm ci` 与 `uv sync --frozen`，不要在未审查锁文件差异的情况下更新依赖。

复制 `.env.example` 为 `.env`，按需填写：

```dotenv
DEEPSEEK_MODEL=deepseek-flash
DEEPSEEK_API_KEY=
TAVILY_API_KEY=
CVSTREAM_PROJECT_ROOT=
CVSTREAM_OBSERVATIONAL_MEMORY=true
CVSTREAM_CONTEXT_WINDOW_TOKENS=512000
CVSTREAM_OBSERVATION_COMPRESSION_RATIO=0.8
CVSTREAM_MEMORY_LAST_MESSAGES=200
CVSTREAM_PREVIOUS_OBSERVER_TOKENS=1500
CVSTREAM_WORKSPACE_COMMAND_TIMEOUT_MS=120000
CVSTREAM_WSL_SANDBOX=true
CVSTREAM_WSL_DISTRO=Ubuntu-24.04
CVSTREAM_SANDBOX_NETWORK=false
CVSTREAM_USERNAME=
CVSTREAM_PASSWORD=
CVSTREAM_WHISPER_MODEL=
CVSTREAM_ASR_API_KEY=
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
- Studio Agent 页面：`http://localhost:4111/agents`
- Agent API：`http://localhost:4111/api`

后端和前端日志分别写入 `.cvstream/logs/backend.log` 与 `.cvstream/logs/web.log`。按 `Ctrl+C` 会同时停止两个服务。

也可以分别启动后端和前端：

```bash
npm start
npm run dev:web
```

或使用 npm 的组合脚本：

```bash
npm run dev:all
```

前端通过 Vite 代理访问本机 Agent API。会话和消息以 `.cvstream/mastra/mastra.db` 为主存储，不同浏览器读取同一服务端历史；浏览器本地存储只用于兼容旧记录与短暂 fallback。删除会话会同时清理服务端线程和本地镜像。

`npm run dev` 与 `npm start` 等价，适合开发时使用：

```bash
npm run dev
```

如需运行构建后的服务：

```bash
npm run build
npm run start:server
```

检查项目：

```bash
npm run typecheck
uv run pytest
```

## Web workspace

Web 工作台入口为 `http://127.0.0.1:4173`，包含以下页面：

- **新对话 / 历史会话**：流式回答、Markdown、公式、代码高亮、图片消息、提示词编辑、重新生成与会话删除。
- **课表**：读取本地缓存或显式同步，根据用户设置的学期起始日期计算教学周；支持修正教室、教师、星期、节次与周次，并可添加常规或单日自定义课程。
- **培养方案**：从 eHall 同步个人培养方案，展示总学分、课程分类、培养要求和选择组；对话中的“培养方案检查”Skill 可结合已缓存的历年课表，整理要求学分、修读证据和待确认缺口。课表记录只代表修读证据，最终是否通过及能否毕业仍以成绩、学分认定和教务审核为准。
- **Focus**：限定为学校场景。通知 Focus 由大模型从自然语言意图规划多组查询并判断相关性；课程 Focus 会将同一课程的排课去重、教师取并集，也可直接搜索并关注不在个人课表中的课程平台课程。通知每两小时检查一次；所有课程 Focus 每 24 小时最多执行一次，包括课次发现、抓取、总结和失败重试。课表课程从上课后一天开始处理，两种来源共用任务去重和最多 7 次重试，并分别持久化上次执行时间。
- **资料库**：按资料类型进入目录，再按课程与教师逐级浏览；支持图片、文本、Markdown、PDF、音视频预览以及二次确认删除。
- **教务通知**：读取已适配站点的通知列表并打开原始来源。
- **设置**：展示当前 Provider，维护 API Key 与允许写入的运行环境变量。敏感值由后端保存，不进入对话提示词。

输入框的 `+` 按钮可选择图片或文档，也可直接按 `Ctrl+V` 粘贴剪贴板图片。图片暂存在 `.cvstream/library/images`，消息只保存稳定引用、摘要和哈希，不保存整段 Base64；文档在服务端解析后以受标记的附件上下文送入当前对话。历史图片不存在时前端隐藏损坏缩略图并保留文字消息。

检查 Python 工具桥：

```bash
echo '{"action":"health","payload":{}}' | uv run seudaily-tool
```

检查常驻 Worker 协议：

```bash
echo '{"requestId":"health-1","taskId":"task-health","action":"health","payload":{}}' | uv run seudaily-worker
```

## Runtime and memory

### 1.x compatibility identifiers

产品、仓库和新包元数据统一使用 **SEUdaily**。为避免升级后丢失既有会话、课表缓存和外部脚本，1.x 继续兼容 Python import 命名空间 `cvstream`、旧命令别名 `cvstream-tool` / `cvstream-worker`、`.cvstream` 运行数据目录、`CVSTREAM_*` 环境变量以及旧浏览器会话键。这些名称仅作为兼容接口保留，不再作为产品或仓库名称；新集成应使用 `seudaily-tool` 与 `seudaily-worker`。

运行数据统一写入项目根目录的 `.cvstream`。Mastra 对话、线程与 Observational Memory 保存在 `.cvstream/mastra/mastra.db`，不再受 Studio 当前工作目录变化影响。默认上下文预算为 512000 tokens，未压缩消息达到 80%（409600 tokens）时同步启动 Observation；提前后台 buffering 已关闭。最近消息数量上限设为 200，防止在达到 token 阈值前仅因消息条数过早丢失历史，并最多带入 1500 tokens 的既有观察。窗口、比例和消息数量均可通过环境变量调整，也可用 `CVSTREAM_OBSERVATIONAL_MEMORY=false` 临时关闭压缩。`CVSTREAM_OBSERVATION_MESSAGE_TOKENS` 仍可作为高级配置直接覆盖计算后的阈值。

Mastra 启动一个长期运行的 Python Worker，而不是每次工具调用都打开 PowerShell 和浏览器。普通抓取使用系统 Microsoft Edge 的无头模式，并统一静音；同一门户复用 Browser Context，每个任务使用独立 Page。只有登录、验证码或二次确认会临时打开可见浏览器。Studio 的停止信号会先请求任务协作取消，未能及时退出时再清理 Worker 及其子进程树。

Web 端通过 SSE 接收回答、reasoning 和工具事件。reasoning 仅展示 Provider 实际返回的 reasoning 流；工具过程使用紧凑行展示，在最终回答出现后默认折叠。工具完整结果仍以 `resultRef` 落盘，避免把大对象反复写入上下文。

工具结果采用统一结构：`status`、`taskId`、`summary`、`data`、`artifacts`、`citations`、`warnings`、`metrics`。完整清洗结果写入 `.cvstream/tasks/<taskId>/result.json`，对话只保存经过列表、字符串和层级限制的结果及 `resultRef`；大段日志另存为 `diagnostics.json`。传给模型的关键数据最多约 6000 字符，并继续执行敏感信息脱敏。课程总结正文使用 `[S1]` 形式的行内引用，并在末尾生成来源表。

Agent Workspace 的文件系统被限制在项目根目录。读取、列目录、文件状态和正文搜索可直接执行；写入、编辑、建目录、终端命令和终止后台进程会在 Studio 中请求审批；删除工具关闭。

Windows 上的终端和后台进程优先通过 WSL2 进入 Bubblewrap 原生沙盒。宿主机项目只读映射到 `/project`，`.cvstream/sandbox-workspace` 作为可写、持久的 `/workspace`；沙盒只挂载运行命令所需的 Linux 系统目录，清空继承环境，并默认隔离网络。Mastra 继续负责无窗口启动、输出流、超时、后台进程和进程树终止。课程 Python Worker、Playwright 浏览器、FFmpeg 与 ASR 仍在宿主机运行。

如果 WSL2、指定发行版或 `bwrap` 不可用，启动时会自动降级为宿主机 `LocalSandbox`。Fallback 仍使用固定暂存目录、最小环境变量、无窗口进程与超时控制，但不提供操作系统级文件或网络隔离。可通过 `CVSTREAM_WSL_SANDBOX=false` 主动使用 fallback；`CVSTREAM_SANDBOX_NETWORK=true` 仅影响 WSL/Bubblewrap 模式。Ubuntu 中安装 Bubblewrap：`wsl -d Ubuntu-24.04 -u root -- apt-get install -y bubblewrap`。

## Available tools

- `authorize-course-portal`：打开可见浏览器并更新登录会话。
- `authorize-schedule-portal`：默认清理旧的 eHall Cookie，在全新的可见窗口中自动填写环境变量中的账号密码并提交普通登录；VPN 二次确认或验证码由用户在可见窗口完成。它只清理课表门户会话，不会删除 Mastra 对话或课表缓存；如需保留 Cookie，可传 `resetSession: false`。
- `get-course-schedule`：默认读取当前学期的完整课表，返回全部课程，不截取前 12 门；可传 `semester: "2025-2026-2"` 切换并读取往年课表。传 `date: "YYYY-MM-DD"` 时按学期起始日期、教学周、星期、单双周和日期调整筛选当天课程；`date` 省略或为空时返回完整课表。通常 `1=暑期学校`、`2=秋季学期`、`3=春季学期`，但实际可用值始终以学校动态返回的 `availableSemesters` 为准，其他数字尾码也会保留。各学期使用独立缓存，`refresh: true` 只更新选中的学期；设置 `includeAvailableSemesters: true` 可读取完整列表，配合 `prefetchAvailableSemesters: true` 会在同一认证会话中顺序获取并缓存全部可访问课表。返回值还包含 `currentSemester`、`currentSemesterLabel`、`selectedSemester`、`selectedSemesterLabel` 和批量同步结果。
- `get-current-date`：返回 Asia/Shanghai 当前日期、星期和时间戳，供“今天/明天”等相对日期查询使用；不应通过终端命令或读取本地文件获取日期。
- 当前远端课表保存在 `.cvstream/schedule.json`，指定往年学期的课表保存在 `.cvstream/schedule.<semester>.json`；学期展示设置和用户修改保存在 `.cvstream/schedule-user.json`，重新抓取不会覆盖用户修改。Focus 规则、事件与任务幂等记录保存在 `.cvstream/focus.json`。
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
- `playwright_browser_*`：仅暴露导航、无障碍树快照、快照查找、点击、输入、下拉选择、按键和标签页 8 个工具。独立浏览器会话不共享 Python Worker 的门户登录状态；点击、输入、选择、按键等交互需要 Studio 审批。
- `mastra_workspace_read_file`、`list_files`、`file_stat`、`grep`：读取和搜索项目内文件，结果设有 token 上限。
- `mastra_workspace_write_file`、`edit_file`、`mkdir`：经用户审批后修改项目文件；覆盖现有文件前要求先读取。
- `mastra_workspace_execute_command`：经用户审批后优先在 WSL/Bubblewrap 的 `/workspace` 暂存区执行前台或后台命令；宿主项目在 `/project` 只读可见。WSL 不可用时自动退回宿主机暂存目录。默认超时 120 秒，可通过 `CVSTREAM_WORKSPACE_COMMAND_TIMEOUT_MS` 调整。
- `mastra_workspace_get_process_output`、`kill_process`：查看或经审批终止 Workspace 自己启动的后台进程。

请仅处理本人具有合法访问权限的课程内容。

手动课程定位示例：课程每周安排在第 3–5 节时，传入 `weeklyPeriods: [3, 4, 5]`。手动目标必须提供 `courseName`、`teacherName`、`weeklyPeriods`；`courseDate` 可选，省略时自动选择符合排课节次的最新日期。同一日期下的所有课段会作为一个完整会话处理。

抓取工具支持两种课程目标：课表内课程传入 `{ source: "schedule", scheduleId }`；课表外课程传入 `{ source: "manual", courseName, teacherName, weeklyPeriods }`。两种目标都可选传 `courseDate`，未传时默认抓取最新日期。

教务处查询缓存位于 `.cvstream/jwc`。除 `cache_only` 外，每次查询都会先校验语义相关的栏目列表，但不会遍历所有详情页；命中的候选 ID 会进入本地队列，由独立后台进程以最多 4 路并发保存快照，不阻塞搜索返回。版本缓存只保留清洗后的正文、附件名称与链接、内容哈希，不保存完整 HTML，也不自动下载附件文件。嵌入式 PDF Viewer 的 `file` 参数会被还原为真实 PDF 附件地址。

计软智官网使用同一套 WebPlus 查询与后台缓存机制，缓存隔离在 `.cvstream/cse`。适配层单独配置栏目、语义路由、详情标题与日期类名；当前覆盖本科通知、教学动态、学生工作、就业、科研、学术活动、人才招聘以及本科/研究生下载专区。

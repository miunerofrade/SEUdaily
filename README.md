# CVStream Agent

CVStream Agent 将课程门户抓取、字幕获取、语音转写、PPT 提取和课程总结封装为 Agent 可调用的工具。项目使用 Mastra 负责编排，原有 Python 实现继续承担浏览器自动化和媒体处理。

## Architecture

```text
src/
├── mastra/
│   ├── agents/course-agent.ts     # Agent 行为与工具授权
│   ├── tools/course-tools.ts      # Mastra 工具及输入 Schema
│   └── tools/python-bridge.ts     # TypeScript → Python JSON 桥
└── cvstream/
    ├── service.py                 # 与 UI 无关的业务服务
    ├── cli.py                     # JSON 工具协议入口
    ├── auth.py                    # 门户认证与 Cookie 会话
    ├── schedule.py                # 校内课表同步、规范化与本地缓存
    ├── jwc.py                     # WebPlus 查询抽象及教务处/计软智站点适配器
    ├── capture.py                 # 课程、字幕与媒体抓取
    ├── asr/                       # 本地/云端语音转写
    ├── ppt.py                     # 视频幻灯片提取
    ├── summary.py                 # 课程讲义生成
    └── ramdisk.py                 # Windows Ramdisk 支持
```

Streamlit 页面层已经移除。账号、密码和密钥默认从环境变量读取，不进入 Agent 提示词。

## Setup

要求：Node.js 22.13+、Python 3.13、uv、FFmpeg。

```bash
npm install
uv sync
uv run playwright install chromium
```

复制 `.env.example` 为 `.env`，按需填写：

```dotenv
DEEPSEEK_MODEL=deepseek-flash
DEEPSEEK_API_KEY=
CVSTREAM_PROJECT_ROOT=
CVSTREAM_USERNAME=
CVSTREAM_PASSWORD=
CVSTREAM_WHISPER_MODEL=
CVSTREAM_ASR_API_KEY=
```

## Development

首次安装依赖后，日常启动 Mastra Studio 和 Agent API：

```bash
npm start
```

启动完成后访问：

- Studio Agent 页面：`http://localhost:4111/agents`
- Agent API：`http://localhost:4111/api`

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

检查 Python 工具桥：

```bash
echo '{"action":"health","payload":{}}' | uv run cvstream-tool
```

## Available tools

- `authorize-course-portal`：打开可见浏览器并更新登录会话。
- `authorize-schedule-portal`：自动填写环境变量中的账号密码并提交普通登录；VPN 二次确认或验证码由用户在可见窗口完成。
- `get-course-schedule`：默认读取本地课表缓存；首次同步或明确更新时才重新访问校内系统。
- `search-seu-academic-affairs`：先用条件请求校验相关公告列表并立即返回，命中详情交给后台并发同步；支持“最新一条”“最近 N 天”和历史查询。
- `get-seu-academic-affairs-notice`：按搜索返回的稳定 ID 读取一条公告正文与附件链接，需要时可同步校验详情页。
- `search-seu-cse-notices`：分栏查询计算机科学与工程学院、软件学院、人工智能学院官网，命中详情在后台并发同步。
- `get-seu-cse-notice`：按 `seu-cse-*` 稳定 ID 读取计软智公告正文与附件链接。
- `list-courses`：列出课程点播目录中的课程。
- `search-courses`：按课程名、教室、教师或课程号搜索课程。
- `find-course-session`：用课程名、教师名和周内节次定位课程；日期缺省时返回最新一次课。
- `capture-course-session`：抓取选中日期下的全部课段，而不是详情页中的单个列表序号。
- `capture-course-sessions`：批量抓取多门课程；纯字幕最多并发 2，视频、PPT、ASR 等重任务并发 1。
- `transcribe-local-media`：用 Faster Whisper 转写本地媒体。
- `transcribe-cloud-audio`：用云端 ASR 转写本地 MP3/WAV。
- `extract-course-slides`：从视频检测页面变化并生成 PDF。
- `summarize-course-transcripts`：可总结整批字幕、指定字幕文件或直接文本，并可指定总结重点与输出格式。

请仅处理本人具有合法访问权限的课程内容。

手动课程定位示例：课程每周安排在第 3–5 节时，传入 `weeklyPeriods: [3, 4, 5]`。手动目标必须提供 `courseName`、`teacherName`、`weeklyPeriods`；`courseDate` 可选，省略时自动选择符合排课节次的最新日期。同一日期下的所有课段会作为一个完整会话处理。

抓取工具支持两种课程目标：课表内课程传入 `{ source: "schedule", scheduleId }`；课表外课程传入 `{ source: "manual", courseName, teacherName, weeklyPeriods }`。两种目标都可选传 `courseDate`，未传时默认抓取最新日期。

教务处查询缓存位于 `.cvstream/jwc`。除 `cache_only` 外，每次查询都会先校验语义相关的栏目列表，但不会遍历所有详情页；命中的候选 ID 会进入本地队列，由独立后台进程以最多 4 路并发保存快照，不阻塞搜索返回。版本缓存只保留清洗后的正文、附件名称与链接、内容哈希，不保存完整 HTML，也不自动下载附件文件。嵌入式 PDF Viewer 的 `file` 参数会被还原为真实 PDF 附件地址。

计软智官网使用同一套 WebPlus 查询与后台缓存机制，缓存隔离在 `.cvstream/cse`。适配层单独配置栏目、语义路由、详情标题与日期类名；当前覆盖本科通知、教学动态、学生工作、就业、科研、学术活动、人才招聘以及本科/研究生下载专区。

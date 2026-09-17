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

启动 Mastra Studio：

```bash
npm run dev
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
- `list-courses`：列出课程点播目录中的课程。
- `search-courses`：按课程名、教室、教师或课程号搜索课程。
- `find-course-session`：用课程名、教师名和周内节次定位课程；日期缺省时返回最新一次课。
- `capture-course-session`：抓取选中日期下的全部课段，而不是详情页中的单个列表序号。
- `capture-course-sessions`：批量抓取多门课程；纯字幕最多并发 2，视频、PPT、ASR 等重任务并发 1。
- `transcribe-local-media`：用 Faster Whisper 转写本地媒体。
- `transcribe-cloud-audio`：用云端 ASR 转写本地 MP3/WAV。
- `extract-course-slides`：从视频检测页面变化并生成 PDF。
- `summarize-course-transcripts`：把一批字幕整理成 Markdown 讲义。

请仅处理本人具有合法访问权限的课程内容。

课程定位示例：课程每周安排在第 3–5 节时，传入 `weeklyPeriods: [3, 4, 5]`。`courseName`、`teacherName`、`weeklyPeriods` 三项必填；`courseDate` 可选，省略时自动选择符合排课节次的最新日期。同一日期下的所有课段会作为一个完整会话处理。

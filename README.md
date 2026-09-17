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
- `list-course-dates`：读取当前课程可用日期。
- `list-courses`：列出课程点播目录中的课程。
- `search-courses`：按课程名、教室、教师或课程号搜索课程。
- `find-course-lesson`：用课程名、教师名和课时序号精确定位一节课。
- `capture-course`：获取官方字幕，并按需抓取媒体、转写或提取 PPT。
- `transcribe-local-media`：用 Faster Whisper 转写本地媒体。
- `transcribe-cloud-audio`：用云端 ASR 转写本地 MP3/WAV。
- `extract-course-slides`：从视频检测页面变化并生成 PDF。
- `summarize-course-transcripts`：把一批字幕整理成 Markdown 讲义。

请仅处理本人具有合法访问权限的课程内容。

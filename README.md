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

浏览器默认：Windows 使用 Microsoft Edge，macOS 使用 Playwright WebKit，Linux 使用 Playwright Firefox。macOS 安装两端浏览器运行时：

```bash
npx --no-install playwright install webkit
uv run --frozen playwright install webkit
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

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

浏览器默认按系统选择：Windows 使用已安装的 Microsoft Edge，macOS 使用 Playwright WebKit，Linux 使用 Playwright Firefox。Node 浏览器工具和 Python 校园工具各自使用对应版本的 Playwright；macOS 依次安装两端运行时：

```bash
npx --no-install playwright install webkit
uv run --frozen playwright install webkit
```

Linux 将 `webkit` 换为 `firefox`，并安装 Playwright 提示的系统依赖。可用 `SEUDAILY_BROWSER` 覆盖默认选择。

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

`/ramdisk 768M` 或 `/ramdisk 1.5 GB` 启用自定义内存盘，支持 64 MB–64 GB；`/ramdisk status` 查看状态，`/ramdisk unmount` 卸载，`/ramdisk reveal` 打开目录。Web 在资源面板显示实时使用量和任务数，每 5 秒刷新；有处理任务时不能卸载。

终端 `/notices` 打开与 Web 相同的教务处通知列表，`r` 刷新，Enter 打开原文，Esc 返回。普通对话仍可查询其他来源的校园通知。

创建 Focus 即授予该关注完全访问权限，不授予 extra 文件和终端能力；验证码及交互登录仍需手动完成。编辑提示词保留同一任务与会话，保存新要求并重跑，历史版本保留。关注没有自动到期时间；暂停停止自动执行，删除撤回授权。登录续接请求有效期为 30 分钟，门户登录时效由学校系统决定。

# npm 发布检查（2026-10-02）

后续更新：平台浏览器选择与密钥填写后的真实对话测试已完成，当前浏览器要求与实测结果以 [Agent 对话与浏览器实测](chat-smoke-report.md) 为准。下文记录首次发布扫描时的状态。

本轮完成了 npm 源码模板 CLI、依赖安装、基础工具审计及可离线验证的修复。尚未向 npm 发布。当前发行方式为 `seudaily init` 创建本地应用，随后 `npm ci`、`uv sync --frozen`、填写 `.env`、`seudaily start`。不是安装 npm 包即可免配置运行的生产服务器，也不是可导入的 JS SDK。

## Node 版本问题

原报错来自 fnm 的自动版本切换：本机此前只有 Node 20.20.2，项目要求 22.13+。不是 uv 或 Python 报错。

不能只下调根 engines：Mastra 1.x 依赖要求 22.13+，锁定的 Babel 8 要求 `^22.18.0 || >=24.11.0`，Linux 可选压缩模块要求 `^22.20 || ^24.12 || >=25`，PostHog 要求 `^20.20.0 || >=22.22.0`。因此完整项目声明为 `^22.22.0 || >=24.12.0`；目前实际测试的是 Node 22.23.3。若一定要支持 Node 20，需选择旧版 Mastra 并迁移 Memory、Workspace、Server 等 API，再进行完整回归，不能承诺通过改一行获得兼容。

本机通过已有的 fnm 安装了 Node 22.23.3，没有修改 fnm 全局默认版本：

```text
Node: /Users/user/.local/share/fnm/node-versions/v22.23.3/installation/bin/node
npm: 同目录，版本 10.9.9
fnm: /opt/homebrew/bin/fnm
```

项目 `.node-version` 指向 22。启动前可执行 `fnm use 22`；自动切换需原有 shell 的 fnm 初始化。验证命令使用 `fnm exec --using 22 ...`，不会替换系统 Node。Mastra 的要求也见[官方说明](https://github.com/mastra-ai/mastra/blob/main/DEVELOPMENT.md)。

## 需要准备的组件

| 组件 | 是否必需 | 当前情况 / 安装方式 |
| --- | --- | --- |
| Node / npm | 必需 | 已安装并验证 Node 22.23.3 / npm 10.9.9 |
| uv | 必需 | 已有 `/Users/user/.local/bin/uv`，版本 0.11.1 |
| Python | 必需 | 推荐 3.13；本机用 Homebrew Python 3.13.3 创建项目 `.venv` |
| Node 依赖 | 必需 | 已 `npm ci`，使用锁文件 |
| Python 基础依赖 | 必需 | 已 `uv sync --frozen`，安装到项目 `.venv` |
| DeepSeek key | 对话/模型功能 | 填写 `.env` 的 `DEEPSEEK_API_KEY`，并确认模型名称可用 |
| Tavily key | 搜索和远程提取 | 填写 `TAVILY_API_KEY` |
| 校园账号/密码 | 校园个人数据 | 填写 `SEUDAILY_USERNAME` / `SEUDAILY_PASSWORD`，VPN/验证码可能需手动处理 |
| Microsoft Edge | 校园/浏览器自动化 | 当前固定 `msedge`，需安装系统 Edge；本机未检测到 `/Applications/Microsoft Edge.app` |
| FFmpeg 命令 | 媒体处理 | 本机 PATH 未找到；macOS 可通过 `brew install ffmpeg` 安装，普通对话/通知/文档解析无需它 |
| OpenCV / NumPy / img2pdf | 视频幻灯片提取 | 按需 `uv sync --frozen --extra ppt` |
| media extra | 兼容原媒体安装命令，目前仅包含抽帧 | `uv sync --frozen --extra media` |
| Torch / PyTorch | 不需要 | 本地 ASR 安装项已移除，无需 Torch / CUDA / 本地模型 |
| ImDisk / Windows 内存盘驱动 | Windows 可选 | npm 不包含仓库内安装程序。macOS/Linux 挂载未实现，按用户要求未测试 |

按用户最新要求，本地 ASR 暂不支持；已移除 `asr` extra、Faster Whisper 及相关锁文件依赖，撤回 CPU/CUDA 配置。本轮没有安装这些组件。保留旧实现源码，但不作为当前发行的可用功能。

## uv 兼容边界

- 基础环境已在 macOS arm64 / Python 3.13.3 / uv 0.11.1 上实装、运行 114 项测试。
- `pyproject.toml` 和 `uv.lock` 均要求 Python >=3.13；不能用 3.12 或更低版本直接 `uv sync --frozen`。推荐先保持 3.13，3.14+ 未实装测试。
- `uv sync --frozen --extra media --dry-run` 在本机可解析，将增加 6 个视频抽帧所需包；没有实装这些 extra，也没有下载模型或验证抽帧。不能把 dry-run 称为完整兼容验证。
- `uv sync` 默认精确同步：日后不带 `--extra` 再运行，可能移除已安装的媒体 extra。需要媒体功能时持续使用对应 extra；`uv run` 默认不精确清理额外包。
- Python Worker 固定依赖 PATH 中的 uv。npm 不会安装 uv、Edge、系统 FFmpeg、GPU 驱动或 本地模型。
- Windows/Linux、GPU、校内网络、真实网页登录和媒体抓取仍需目标环境实测。内存盘仅保留 Windows 实现。

## 已修复

- 移除 npm `private: true`，补齐 MIT 元数据、`bin`、发布白名单、版本约束和发布前检查。
- CLI 初始化独立项目，不向 npm/global 安装目录写运行数据；保留 Node/Python 锁文件和 Skill 资源；非空目录拒绝覆盖；`.env` 创建为 0600。
- npm 默认不发布根 package-lock，打包前将其保存到 `template/npm-lock.json`，初始化时恢复为项目 `package-lock.json`。
- 修复工具 broker 对含 transform 的 Zod schema 返回空对象的问题；课程抓取字段/日期校验；培养方案鉴权续接；预取消任务误启动/误杀共享 Worker。
- 修复远程网址 IPv6 私网漏拦、校园尾点域名和普通 `fc`/`fd` 域名误拦。
- 修复资料库符号链接越界预览/删除/列目录；`.env` 保存保留 `$&` 等字面内容、串行合并、原子私有写入。
- 后端固定 127.0.0.1，限定 CORS 来源，对全局 API 与跳过全局 middleware 的公开应用路由分别校验 Host/Origin。

## 验证与发布前剩余差距

已通过类型检查、前后端构建、11 项 Node 行为测试、114 项 Python 测试、真实 Python Worker 无 key smoke、后端无 key 启动及 HTTP Host/Origin 检查；实际 tarball 经 `npm install --omit=dev` 安装 CLI、初始化项目、`npm ci`、`uv sync --frozen` 和 CLI 启动，Web/API 返回 200，跨站请求返回 403。npm 官方 registry 对完整依赖扫描返回 0 个已知漏洞（仅表示当次数据库结果）。本机配置的 npmmirror 不实现 audit endpoint，审计使用 `--registry=https://registry.npmjs.org`。

后续已使用现有密钥验证真实模型对话、Tavily、WebKit、校园登录、个人课表同步和培养方案读取/核查，详见 [chat 实测报告](chat-smoke-report.md)。云 ASR、课程媒体抓取、验证码/VPN 二次认证和完整 UI 操作流程仍未验证；Edge 未安装，FFmpeg 和媒体 extra 未实装。

发布模式明确限制：初始化的本地应用使用 Mastra/Vite 开发服务器，必须安装 devDependencies；尚无“npm install --omit=dev 后直接启动生产 Web 应用”的入口。若目标是这种发行方式，后续需预构建后端、静态前端托管、只读包资源/用户数据分离以及升级策略。源码模板方式可以先独立发行，但用户仍需执行安装步骤。

Workspace 的 extra 完整项目访问会允许模型读取项目文件，项目包含 `.env` 和认证状态。当前未做秘密路径统一屏蔽；不要将此模式承诺为隔离秘密的安全沙盒。需要这类保证时，应实现受限工作目录或统一的文件系统拦截层。host-fallback 终端亦没有 OS 隔离。HTTP Host/Origin 防护不提供账号认证，不支持直接开放到公网。

修复了独立云转写与抽帧入口的延迟导入缺失；真实云转写仍待 API key。Mastra 构建期间出现 PostHog 遥测网络超时，构建最终成功，未影响验证。

Web 主 bundle 约 851 KB，构建出现分包建议；这是性能改进项。发布包排除 `.env`、认证数据、数据库、导出资料、环境、构建缓存、ImDisk 二进制安装文件。发布前仍需自己的 npm 登录、2FA/发布权限、最终版本号确认；本轮扫描时 `seudaily` 名称返回 404，不代表永久预留。

```bash
fnm use 22
npm run typecheck
npm run test:tools
uv run pytest
npm run build
npm run build:web
npm pack
# 验证包后由维护者执行：npm publish --access public
```

# 分发实现与发布状态

2026-10-05：Node 合并 JS、内置 SQLite、统一启动器和组件边界已落地；已在 macOS arm64 验收本地 npm 打包文件，已按维护者授权向 npm 发布 1.1.0。根包及组件仍为 `private: true`。

## 构建和使用

开发者构建需要当前锁文件对应的 npm 依赖和 uv；使用构建后的普通聊天只需要兼容 Node，不需要系统 Python、uv 或浏览器。

```sh
npm ci
npm run build
node bin/seudaily.mjs --data-dir "$PWD"
node bin/seudaily.mjs web --data-dir "$PWD"
node bin/seudaily.mjs ask "你好" --data-dir "$PWD"
node bin/seudaily.mjs --help
```

`uv run seudaily` 作为源码兼容入口，转交同一个 Node 启动器并默认保留仓库数据。`start`、`exec`、`--prompt`、`--cwd`、`--no-start` 不再作为公共命令接受。新的动作是 `chat`、`web`、`ask`、`vpn`、`status`、`stop`、`sessions`、`skills`、`completion`、`import-data`；`-c/--chat`、`-w/--web`、`--vpn PORT` 是别名。

npm 发布后，基础包安装提供 `seudaily` 命令。三个可选组件已公开发布到维护者个人命名空间；CLI 始终使用包内 `dist/cli/`，本地可选组件优先使用 `dist/components/`，打包验收用本地临时注册表验证下载流程。

## 包边界

| 包 | 内容 | 何时使用 |
| --- | --- | --- |
| `seudaily` | Node 启动器、内置 CLI、公共核心、内置 Skill、可选组件清单 | 安装即可使用终端 |
| `@miunerofrade/seudaily-web` | React 静态页面及资源 | web |
| `@miunerofrade/seudaily-python` | Python wheel，以及基础、browser、documents、summary、asr、media 的锁定 hash 清单 | 首次调用 Python 工具先准备基础环境，其余依赖在功能内部首次实际使用时安装 |
| `@miunerofrade/seudaily-browser` | 合并后的 MCP 服务与固定 Playwright core 依赖 | 通用浏览器工具 |

构建根据实际打包模块生成 THIRD_PARTY_NOTICES.txt，缺失的 Yoga/remark 许可证从对应上游版本补齐；根包没有运行时 npm 依赖，没有用户数据、源码、Web、Python、浏览器组件或实验产物。内置 CLI 也没有运行时 npm 依赖。浏览器保留必要资源目录，属于按需组件；不能宣称所有功能都只有两个文件。

公共核心与终端通过 HTTP/SSE 通信。Web 静态页面由核心同端口托管，不启动 Vite。启动器检查后端名称、协议、版本和数据目录；数据目录锁在加载数据库前取得。多个界面共用一个核心，连接每 10 秒续租，正常退出立即释放；崩溃租约约 30 秒失效。自动核心在最后一个界面退出后停止，独立开发后端不由租约回收。Web 启动器关闭的入口是终端 Ctrl+C，关闭浏览器标签本身不等于结束启动器。

CLI 不下载、不写入组件缓存。可选组件按当前应用版本安装至私有缓存，用目录锁避免重复安装，npm 校验包 integrity，禁用安装脚本；下载/安装完成后原子发布目录。失败目录清理后可重试。Python 环境先安装锁定 wheel 和 hash 清单，再写就绪标记，不把半成品交给 worker。uv 0.11.1 的下载 URL 和 SHA256 已固定，保留 MIT/Apache 许可证，不修改全局 uv、Python 或 Shell 配置。

Python 基础环境只有 httpx、cryptography、tzdata 及其传递依赖；worker 导入、VPN、课表及培养方案 HTTP 路径不加载 Playwright、文档库或模型 SDK。文档解析、课程摘要/语义 Focus、云端 ASR、视频幻灯片提取分别准备 documents、summary、asr、media。Python 浏览器兜底在实际调用时准备 browser，包含 Playwright 驱动；通用浏览器工具由独立 browser npm 包提供。两个驱动仍各自属于对应语言的调用端，版本同为 1.63.0，共享一份所选浏览器引擎缓存。Windows 默认已有 Edge，不另下载浏览器。官方 PDF 导出成功时不安装视频提取依赖。FFmpeg 与 Linux 浏览器系统库仍是外部系统依赖。本地 ASR 尚不可用。

分包控制代码下载，extras 控制 Python 运行依赖安装；清单随 Python 包一起下载，但不会因此安装所有清单。开发环境默认也不安装重依赖，按需执行 `uv sync --extra documents` 或 `uv sync --extra browser`；测试使用独立 `test` 依赖组。升级不主动卸载用户已经准备的可选能力。

四个 npm 包是当前的代码分发渠道，不是按需安装的必要条件。也可以把小型工具代码放入主包，把较大的可选组件改为版本化的 Release 下载资源。第三方 Python 库仍由 uv 从 PyPI 下载，浏览器引擎由 Playwright 从其下载源获取，VPN 核心来自上游 GitHub Release；这些资源不会因为合并 npm 包而消失。当前发布结构保持四包。

准备提示覆盖组件下载、uv、Python/虚拟环境、各可选依赖、浏览器引擎及 VPN 核心。TUI 保留阶段消息并在底栏显示当前准备状态；Web 显示准备浮层，完成提示自动收起，失败提示可关闭。Web 组件下载发生在网页可用前，因此显示在启动终端。各功能分别维护准备状态，文档安装失败不会被当成 VPN 基础环境失败。

浏览器工具发现只使用主包内的工具元数据，不下载组件或启动 MCP；实际执行工具时才准备浏览器服务及引擎。元数据由 `node scripts/update-browser-catalog.mjs` 从固定版本 MCP 生成，浏览器验收会比对实际服务的参数及说明。

VPN 核心继续独立按需下载；源代码/AGPL 说明见 [VPN 许可证记录](licensing-vpn.md)。

## 数据和缓存

| 平台 | 默认用户数据目录 | 默认组件缓存目录 |
| --- | --- | --- |
| macOS | `~/Library/Application Support/SEUdaily` | `~/Library/Caches/SEUdaily` |
| Windows | `%LOCALAPPDATA%/SEUdaily` | `%LOCALAPPDATA%/SEUdaily/cache` |
| Linux | `$XDG_DATA_HOME/seudaily`，默认 `~/.local/share/seudaily` | `$XDG_CACHE_HOME/seudaily`，默认 `~/.cache/seudaily` |

用户数据目录内保存 `.env`、`AGENT.md`、`.agent/skills/`、`.seudaily/`、`exports/`；数据库仍为 `.seudaily/agent.db`。安装升级不写这些文件。`--data-dir` 或 `SEUDAILY_DATA_DIR` 选择数据目录；`SEUDAILY_CACHE_DIR` 选择缓存目录，`--port` 同时改变服务端口、CLI 地址和本地 Host/Origin 校验。

新默认目录不会自动读取旧仓库中的凭据或历史。停止旧后端后，用显式导入保留原件；目标必须为空：

```sh
node bin/seudaily.mjs import-data /absolute/old/repository
```

历史数据库 schema 不变；旧 Mastra 数据只读导入也已改为 SQLite，不依赖 Python。用户可以继续通过 `--data-dir /absolute/old/repository` 使用原目录，不要求迁移。

额外部署配置：`SEUDAILY_COMPONENT_DIR` 可指向本地构建组件目录；`SEUDAILY_UV_BINARY` 可显式指定现有 uv，否则优先复用 PATH 中的 uv（最低 0.11.1），不存在兼容版本才下载到私有缓存。Python 优先复用已有 3.11 或更高版本的解释器；不存在时才下载 3.13。依赖始终安装在应用自己的虚拟环境，不修改用户环境。`PLAYWRIGHT_BROWSERS_PATH` 可复用已有对应版本引擎。修改已有后端的端口/数据目录需要先停止它，不会把另一服务当成可复用后端。

## 验收与发布门槛

```sh
npm run typecheck
npm run build
npm run test:agent
npm run test:distribution
node --import tsx --test tests/*.mjs
uv run --group test pytest -q
node scripts/build-fixtures.mjs
python3 scripts/validate-terminal.py --python
python3 scripts/validate-terminal.py --browser-only
npm run pack:local
```

固定用例包括原 Agent/HTTP/附件回归、事务隔离、注册表下载失败重试、纯打包安装、同时打开两个 Web 与 CLI、同一核心复用、最后退出/重启、Host/Origin 校验、空 Focus 列表不安装 Python，以及旧数据复制不覆盖原件。PTY 固定用例继续覆盖中文输入、附件、流式输出、取消、退出和终端恢复；浏览器只访问本机 fixture。

最终回归为 Node 75/75、Python 256/256，类型检查和生产构建通过；实际安装新 Python wheel 后导入也通过。默认包（已含 CLI）压缩约 480 KiB，解压约 1.63 MiB；这些数字不包含按需的 Python 依赖、浏览器和 VPN 核心。包大小、integrity 和固定用例结果见 [候选包验证记录](research/data/distribution-candidate.json)。

本地验收使用 macOS arm64；2026-10-05 GitHub 三系统 × Node 22/24、Python 3.11/3.12/3.13 九组全部通过。当前验收与后续维护：

1. 云端安装、生命周期和默认浏览器验收已完成；Windows ConPTY 和 macOS/Linux PTY 用例均通过。校园 VPN/短信需要本机网络和人工验证，未把校园凭据交给 CI。
2. 四个包的 1.1.0 已公开发布，维护者为 miunerofrade；三个组件使用 @miunerofrade scope，主包为 seudaily。后续升级统一版本，组件先发布，主包后发布。
3. 复核生成的第三方许可证清单、npm 文件白名单，复核已接入的 CI/发布流程。SQLite 警告保留在核心日志，不全局屏蔽其他警告。
4. 已在无 npm 登录配置的临时环境验证真实注册表安装、内置 CLI、scoped Web 自动安装和共享后端。旧数据导入继续由固定回归覆盖。

跨界面共享历史已存在，但完整的实时变更广播仍未实施；常驻后台 Focus、Bun 独立程序和 Node SEA 继续搁置。已完成 npm 1.1.0 发布，也没有重启用户当前运行的旧后端。

GitHub 已配置三系统 × Node 22/24 自动验收和手动发布候选流程；具体凭据、Environment 审核及 Trusted Publisher 配置见 [npm 发布说明](npm-release.md)。云端结果以对应 Actions run 为准。

最终九组云端通过记录：[Actions run](https://github.com/miunerofrade/SEUdaily/actions/runs/37224641743)，[结果清单](research/data/github-distribution-ci.json)。

实际发布与安装记录：[包完整性](research/data/npm-release.json)、[公开安装验收](research/data/npm-public-installation.json)。

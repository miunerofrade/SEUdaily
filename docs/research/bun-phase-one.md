# Bun 第一阶段可行性验证

日期：2026-10-04。环境：macOS arm64，Node 22.23.3，Bun 1.4.2，项目当前锁定依赖。

**结论：本机有条件通过，可以继续做 Bun 核心与外部组件的生产入口原型。尚未切换正式运行方式，尚不能认定跨平台发布条件已满足。**

一个 Bun 可执行文件可以承载核心，并加载独立 CLI JavaScript 组件；基础核心和 CLI 脱离仓库后不需要 `node_modules`。浏览器工具需要独立的驱动资源组件，Python 与浏览器引擎仍然是外部可选运行环境。与此同时，“合并 JS + 已有 Node”也实测可行，体积更小，保留为备选。

## 固定用例与结果

同一组 fixture 对比四种方式：Node 源码、Node 合并 JS、普通 Bun、Bun 编译核心。没有调用真实模型、登录校园账号或下载课程资料。

| 验证内容 | Node 源码 | Node 合并 JS | 普通 Bun | Bun 编译核心 |
| --- | --- | --- | --- | --- |
| libsql 事务回滚、历史写入及关闭后恢复 | 通过 | 通过 | 通过 | 通过 |
| Agent 工具审批、执行一次、重复审批拒绝 | 通过 | 通过 | 通过 | 通过 |
| 实际 HTTP 服务、中文 SSE、历史查询、取消接口及错误 token | 通过 | 通过 | 通过 | 通过 |
| 实际 Ink 终端：中文提交保留草稿、独立 Enter 发送 | 通过 | 通过 | 通过 | 通过 |
| 图片路径粘贴、附件上传及发送、退格删除附件 | 通过 | 通过 | 通过 | 通过 |
| 流式回答、窗口 resize、短 Ctrl+C 取消并保留界面 | 通过 | 通过 | 通过 | 通过 |
| Ctrl+D 和持续 Ctrl+C 退出，恢复 raw mode 与 alternate screen | 通过 | 通过 | 通过 | 通过 |
| Python worker 健康检查、Unicode 错误、错误后恢复及关闭 | 通过 | 通过 | 通过 | 通过 |
| 已取消的 Python 调用不启动请求 | 通过 | 通过 | 通过 | 通过 |
| MCP 子进程发现工具、WebKit 导航、点击、快照和关闭 | 通过 | 通过 | 通过 | 通过 |

此外，现有 `test_agent_runtime.mjs`、`test_agent_http.mjs`、`test_terminal_attachments.mjs` 共 **28 个用例**在 Node 和普通 Bun 下各自全部通过；编译程序运行的是上表的集成 fixture，不是声称它跑过同一套 `node:test` 测试。正式项目 TypeScript 检查通过。

编译核心和合并 JS 均复制到临时目录验证。基本 fixture 只创建项目识别标记、空 Skill 目录及测试图片；没有源码、`.env` 或项目 `node_modules`。浏览器 fixture 另带自己的 `playwright-core` 目录，Python fixture 通过临时 `uv` shim 调用已有 `.venv/bin/seudaily-worker`。这验证了桥接兼容性，不代表 Python 安装器已经完成。

最后还将编译程序的 PATH 限制到 `/usr/bin:/bin:/usr/sbin:/sbin`，确认这些目录里没有 Node/Bun/uv，再重复核心、终端、Python桥接和浏览器用例，全部通过。Python 单独加入 fixture 的 `uv` shim，执行现有 Python worker；基础核心/CLI 和浏览器工具不借用系统 Node 或另装 Bun。

## 测量结果

首屏从创建进程到伪终端收到模型名称计时，包含核心模块导入和 CLI 初始化。模型与后台响应来自 fixture，因此它不是 `uv run seudaily` 全链路启动耗时，也不包含环境安装、后端探测、校园登录。没有清空操作系统文件缓存。

每次使用新目录、新复制的程序/资源，三次测量中位数：

| 运行方式 | 首屏 | 首屏 RSS |
| --- | ---: | ---: |
| Node 源码 + tsx | 382 ms | 163.5 MiB |
| Node 合并 JS + 原生模块 | 336 ms | 113.8 MiB |
| 普通 Bun 运行源码 | 155 ms | 138.1 MiB |
| Bun 编译核心 + 外部 CLI | 587 ms | 126.4 MiB |

为避免把新复制产物的首次执行成本混入日常启动，另将产物放在固定的临时安装目录，各运行五次。首次启动与后四次的中位数分开记录：

| 方案 | 固定安装位置的首次启动 | 后续四次首屏中位数 | 后续四次 RSS 中位数 |
| --- | ---: | ---: | ---: |
| Node 合并 JS | 3,235 ms | 153 ms | 约 112 MiB |
| Bun 编译核心 | 580 ms | 110 ms | 约 125 MiB |

首次执行存在明显波动，不能据此承诺冷启动一定更快，也没有足够证据将它全部归因于某一种系统检查。稳定安装位置下，Bun 此次首屏比 Node 合并 JS 快约 **28%**，但 RSS 高约 **12%**。这是本机小样本结果，不是跨平台性能保证。

验证产物体积如下，使用 MiB（1,048,576 字节）；gzip 为单个文件压缩后相加，不等同于最终发布归档：

| 方案/组件 | 未压缩 | gzip |
| --- | ---: | ---: |
| Bun 核心（含运行时与 libsql 原生模块） | 67.61 MiB | 28.23 MiB |
| 独立 CLI JS（含 Ink/React/Yoga） | 0.49 MiB | 0.17 MiB |
| Bun 核心 + CLI 合计 | **68.10 MiB** | **28.40 MiB** |
| Node 核心 JS + libsql `.node` + CLI 合计 | **8.72 MiB** | **3.85 MiB** |
| 可选浏览器入口 JS + 保留的 Playwright 驱动目录 | 约 12.94 MiB | 未作为发布归档测量 |

Node 方案不包含用户已有的 Node 运行时。上述体积均不包含 Python 环境、浏览器引擎、Web 静态资源和 VPN 核心。验证代码也在核心产物内，正式产物还需重新测量。不能把开发环境整个 `node_modules` 的体积直接当成这两种生产方案的差异。

## 发现的适配点

1. **libsql 动态原生模块加载。** 直接 `bun build --compile` 的产物在仓库内能运行，移到空目录后找不到 `@libsql/darwin-arm64`。构建插件将计算出的 require 改成静态引用后，`.node` 能嵌入 Bun 程序；Node JS 方案则输出一个独立的原生模块文件。生产构建需要按目标系统/CPU/ABI选择模块，不能拿 macOS 模块交叉打包给其他平台。
2. **Ink 可选 devtools。** 当前没有安装可选的 `react-devtools-core`，Bun 构建会尝试解析/提升这个调试导入。验证构建明确排除 Ink 的 devtools 动态导入并固定生产环境后，CLI 完整 bundle 可以在空目录加载。没有修改仓库的第三方依赖文件。
3. **浏览器 MCP 不能照搬 `process.execPath + 源码脚本`。** 当前代码通过 Node 可执行文件启动仓库 `node_modules` 中的 MCP CLI；编译后 `process.execPath` 指向 SEUdaily 自己，需要正式内部工具入口。验证中由同一核心执行 `mcp-child` 并加载外部浏览器 JS，实际操作通过，不需要额外携带另一个 Bun。
4. **Playwright 资源不能盲目合并。** 直接合并 MCP 会遇到未安装的可选 `chromium-bidi` 依赖；上游同时依赖自身目录下的包信息、浏览器构建清单及其他资源。此次保留独立驱动目录，浏览器引擎仍使用已有缓存。基础聊天包不应因此带上全部浏览器依赖。
5. **项目路径仍需生产改造。** 当前 `runtime-paths.ts` 从源码位置找 `package.json`、`pyproject.toml`。fixture 使用 `SEUDAILY_PROJECT_ROOT` 与两个标记绕过仓库依赖，证明业务逻辑可运行；真实发布仍需分离组件安装目录、数据目录、工作区，不能要求用户准备这些伪项目标记。
6. **上游 MCP 返回形式需要保留兼容。** 当前版本导航返回快照文件链接，显式 `browser_snapshot` 返回内联 YAML；点击参数叫 `target`。验证按实际发现的 schema 和返回形式操作。后续拆工具组件时不能只处理一种快照返回形式，更不能仍假定旧的 `ref` 参数。

原生扩展的显式引用与独立可执行文件构建能力可对照 [Bun 官方文档](https://bun.com/docs/bundler/executables)。实际是否兼容以上表的实测为准。

## 尚未通过的发布门槛

- Windows、Linux、其他 CPU 的实际运行测试尚未执行。当前 PTY 驱动只使用 POSIX 接口；Windows 需要 ConPTY 用例，Linux 需要验证浏览器系统库及原生 ABI。现在只接受 macOS arm64 的结论。
- 没有实现下载器、组件协议/版本校验、升级与回滚、生产数据迁移、npm 启动器和文件白名单，也没有切换 CLI/Web 后端生命周期。这些属于后续实施，不是本次通过的项目。
- 没有验证编译后的完整 Focus 调度、真实校园登录及双界面同时使用。网络与模型 fixture 刻意避免更改用户数据或产生实际流量。

建议继续 Bun 优先原型，同时保留 Node 合并 JS 的构建路线。如果用户优先要求最小下载且已装 Node，Node 方案当前明显更小；如果优先要求独立核心与统一运行时，Bun 方案有本机依据。正式选择应等必需平台验证和生产入口适配完成。

## 复现与原始记录

执行说明见 [验证脚本说明](../../scripts/probes/README.md)。原始结果保存在本机被忽略的目录：

- `.seudaily/probes/bun/comparison.json`：四种运行方式的固定用例与三次首屏测量。
- `.seudaily/probes/bun/installed-comparison.json`：固定安装位置的首次/后续启动。
- `.seudaily/probes/bun/browser-comparison.json`：四种方式的浏览器用例。
- `.seudaily/probes/bun/sizes.json`：产物字节数与 gzip 体积。
- `.seudaily/probes/bun/comparison-compiled.json` 与 `browser-comparison-compiled.json`：移除 PATH 中 Node/Bun/uv 后的追加验证。

工具取自 [Bun 官方 1.4.2 发布](https://github.com/oven-sh/bun/releases/tag/bun-v1.4.2)。本次 macOS arm64 压缩包 SHA256 为 `90987a3a16d7db556d886ac3d551e7b6d3edf0a1cf43acaed622e8676be1d12f`，校验通过后才解压使用。已删除首次下载失败的残片及不再使用的早期 smoke 二进制。

## 后续状态

正式路线已转为 Node 合并 JS 与内置 SQLite。原 Bun/SQLite 实验脚本、下载的 Bun 工具及二进制对照产物已清理，历史测量 JSON 保存在 [data](data/)；仍有用的固定用例已迁入 `tests/distribution-fixtures/`，通过 `scripts/build-fixtures.mjs` 与 `scripts/validate-terminal.py` 复现当前正式构建的验证。本文上面的旧实验命令和路径仅为历史记录。实施与发布状态见 [分发说明](../distribution.md)。

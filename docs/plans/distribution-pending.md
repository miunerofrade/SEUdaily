# SEUdaily 分发与体积优化待定记录

记录日期：2026-10-04（Asia/Shanghai）。

**状态：npm 分发准备与 Bun 优先验证计划已确认；尚未实施打包或发布。Node SEA 与后台常驻 Focus 继续搁置。**

本文件保存讨论结果与待验证问题，不代表分发功能已经实现。2026-10-04 后续已确认：优先验证 Bun，按公共核心、CLI、Web 与可选工具划分构建和安装边界；代码统一到 main，cli 合入 main，旧 dev 停止维护并删除。此次分支整合不执行 npm 发布。

## 一、CLI / Web 双形态与统一入口

### 已选择的方向

- 一个轻量 npm 入口包 `seudaily`；CLI、Web、公共核心及工具组件按需准备。
- CLI 与 Web 均可独立使用；同时运行时共享核心、数据库、Python worker、VPN 和浏览器缓存。
- 用户预装兼容 Node.js；普通聊天不要求 Python。校园、文档等能力首次使用时，由程序准备私有 uv、Python 环境和对应依赖。
- 正式运行入口使用 Node；环境准备完成后直接调用受管理环境中的 Python，不依赖用户 PATH 中的 uv。此方向尚未实现。
- 保持当前退出行为：最后一个界面关闭后停止自动启动的核心；常驻 Focus 和空闲 60 秒退出机制继续搁置。
- 首版面向本机使用，不包含远程多用户服务。
- main 统一维护 CLI、Web 和公共核心；cli 合入 main 后不再独立同步公共修改。安装内容由组件边界决定，不由 Git 分支决定。旧 dev 停止维护。

### 最新命令提案

采用“动作子命令 + 配置参数”，不强制全部功能写成 `--参数`。下表为未来接口提案，不能视为当前可用命令。

| 功能 | 提案 |
| --- | --- |
| 终端交互 | `seudaily`、`seudaily chat`、`seudaily --chat`、`seudaily -c` |
| 本地网页 | `seudaily web`、`seudaily --web`、`seudaily -w` |
| 单次提问 | `seudaily ask "问题"`；`--json` 输出 JSONL |
| 管道输入 | `seudaily ask --stdin` |
| 恢复会话 | `seudaily chat --resume [ID]`；省略 ID 打开选择列表 |
| 独立 VPN | `seudaily vpn PORT`，保留 `seudaily --vpn PORT` 别名 |
| 状态与停止 | `seudaily status`、`seudaily stop` |
| 会话与 Skill 列表 | `seudaily sessions`、`seudaily skills` |
| Shell 补全 | `seudaily completion SHELL` |

保留必要的 `--skill`、`--timeout`、`--quiet`、`--verbose`、`--no-color`、`--vi`、`--help`、`--version`；提议新增 `--data-dir`、`--port`。`start` 删除；`exec`、`--prompt`、`--cwd`、`--no-start` 等旧接口的替代和错误提示仍需在实施前核对。界面内 `/vpn`、`/ramdisk` 等斜杠命令保留。

所有别名共用解析和执行逻辑；npm 与源码入口共享帮助、参数和补全。

### 尚需解决的发布缺口

- 当前运行依赖源码目录、开发工具及项目 Python 环境；npm 包仍为 `private: true`，缺少正式 `bin` 和生产构建入口。
- Web 当前依靠 Vite；拟由公共核心同端口托管静态构建，并支持运行时挂载 Web。
- 已实现 CLI/Web 探测并复用已有后端，以及最后一个界面退出后关闭自动启动的后端；发布入口仍需摆脱 Python 启动器和开发服务器。
- 拟增加按数据目录的单实例锁，以及连接时的服务身份、数据目录和协议版本核对。
- 配置、数据库与安装目录尚未分离；拟使用系统用户数据与缓存目录，旧数据显式复制导入并保留原件。
- 历史共享尚不等于跨界面实时同步；拟增加共享事件接口，保持服务端权威和同一会话单次执行。
- 端口和本地 Host/Origin 校验需要一起调整；生产服务仍仅监听本机。
- 依赖与 Python worker 导入需按能力拆分；组件需固定版本、校验和、原子安装及失败重试。
- 当前 Playwright 统一依靠根目录 npm `overrides`；成为发布依赖后不能假设该约束仍生效，需要单独锁定和验证。
- 发布采用文件白名单，排除凭据、运行数据、开发工具及测试；补齐脱离源码仓库后的安装验收。

VPN 继续采用按需下载的未修改 zju-connect 核心，保留许可证和对应源码入口。延迟下载不自动免除第三方许可证义务，相关说明见 [VPN 许可证记录](../licensing-vpn.md)。

## 二、依赖体积与可执行文件

**状态：已确认优先验证 Bun；尚未执行合并打包或单文件构建验证。关键兼容性未通过时首版采用 JS 合并打包。**

2026-10-04 的本机开发环境测量：`node_modules` 约 246 MB，`.venv` 约 258 MB。它们包含开发或未使用内容，不等于最终发布体积，也不能据此承诺具体压缩比例。

### 待比较路线

| 路线 | 分发形式 | 主要取舍 |
| --- | --- | --- |
| JavaScript 合并打包 | 少量 JS、资源及必要原生模块，使用已有 Node | 裁剪开发依赖与未使用代码，不额外携带运行时 |
| Bun 独立可执行文件 | 应用代码与 Bun 运行时一起分发 | 用户无需另装 Node/Bun；需验证现有依赖兼容性 |
| Node SEA | 应用代码与固定 Node 运行时一起分发 | 保持 Node 运行环境；需适配模块加载、资源和原生扩展 |

单文件并不等于全部编译为机器指令，也不保证比“合并 JS + 已有 Node”更省空间。减少开发依赖、合并和裁剪代码，与生成可执行文件是不同步骤。

先用固定用例比较 Node、普通 Bun 和 Bun 编译产物，覆盖 Ink 输入、libsql 原生模块、子进程、浏览器 MCP、Python worker，以及编译程序加载外部界面组件。Node SEA 继续搁置。基础运行时不携带 Web 页面或浏览器引擎；CLI/Web 分别加载界面组件并共享公共核心。

### 验证问题

- Ink 的实际终端输入、粘贴、渲染、退出与子进程行为。
- libsql 的 `.node` 原生模块是否正确打包、加载，以及数据库事务与历史读写是否兼容。
- 当前浏览器工具通过 `process.execPath` 启动 `node_modules` 中的 MCP 脚本；打包后需验证内部工具入口或独立工具组件。
- 动态导入、worker、资源读取及源码路径假设需适配分发环境。
- CLI、后端与 Web 组件共享服务，不能因打包改变生命周期和数据归属。
- Windows、macOS、Linux 及 CPU 架构需要对应构建与实际验证；还需处理签名、升级和内置运行时维护。
- Python、浏览器引擎和 VPN 仍有独立体积；主程序单文件不意味着所有工具零外部文件。
- 比较下载体积、安装体积、文件数量和启动时间，不能仅凭二进制文件数量判断优化效果。

## 参考资料

- [OpenCode 构建源码](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/script/build.ts)：Bun 可执行文件构建，并支持嵌入 Web 资源。
- [OpenCode npm 启动器](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/bin/opencode)：选择并启动对应平台程序。
- [Claude Code 官方 npm 安装说明](https://code.claude.com/docs/en/setup#install-with-npm)：npm 可以用于分发平台二进制，程序运行时不一定使用系统 Node。
- [Gemini CLI 构建配置](https://github.com/google-gemini/gemini-cli/blob/main/esbuild.config.js)：esbuild 合并代码，单独处理部分原生依赖和 Ink worker；不能笼统理解为所有功能严格只有一个文件。
- [Bun 单文件可执行程序文档](https://bun.com/docs/bundler/executables)：运行时、资源及原生扩展打包能力。
- [Node SEA 文档](https://nodejs.org/api/single-executable-applications.html)：Node 单文件分发、资源与原生扩展限制；实施时核对选定 Node 版本的支持情况。
- [npm overrides 规则](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#overrides)：只考虑根项目的覆盖规则。
- [原 vercel/pkg 仓库](https://github.com/vercel/pkg)：已弃用并归档，不作为默认新方案。

参考链接指向可变化的官方文档或开发分支，记录查询日期为 2026-10-04。未来恢复讨论或实施时，需要重新核对相关版本与行为。

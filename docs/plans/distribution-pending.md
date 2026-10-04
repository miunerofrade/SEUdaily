# SEUdaily 分发进度与后续计划

更新：2026-10-05。

**状态：正式 Node 打包、统一入口、组件边界与本地候选包验收已落实；已公开发布 npm 1.1.0，GitHub 三系统 × Node 22/24 验收已全部通过，发布流程已准备。**

## 已按顺序完成

1. **轻量公共核心**：正式存储改为 Node 内置 SQLite，移除 libsql 原生依赖。旧数据库 schema 保持兼容，旧 Mastra 导入只读且不再调用 Python。
2. **统一入口**：npm `bin` 提供 `seudaily`；采用 `chat / web / ask / vpn / status / stop / sessions / skills / completion / import-data`。`-c/--chat`、`-w/--web`、`--vpn PORT` 共用同一解析。旧 `start / exec / --prompt / --cwd / --no-start` 已移除；源码 Python 入口只转交 Node 启动器。
3. **CLI/Web 边界**：核心、CLI、Web 分开构建；Web 为同端口静态页面，运行时不需要 Vite。多入口核对身份、版本、协议和数据目录后复用同一个核心，正常释放及崩溃租约维护生命周期。独立开发后端不会因界面退出而停止。
4. **数据和按需组件**：默认数据目录与安装目录分离，可显式复制旧数据而不删除原件。默认包内置 CLI 与核心；Web/Python/浏览器按版本安装到私有缓存；失败可重试，完整组件再原子发布。uv 固定 URL/SHA256，Python 依赖按 lock 导出且检查 hash。Python/Node 的浏览器共用同一版本和缓存，视频提取依赖只在真实 fallback 时安装。
5. **本地发布候选**：基础包使用文件白名单，分组件生成 `.tgz`；脱离源码仓库的安装、失败重试、共享后端、退出/重启和数据导入验收通过。根据实际模块生成许可证文本。四个包已发布。

Node 原型实验中的核心+CLI 为 1.11 MiB；正式包还包含启动器、完整业务边界和许可证，最终大小以 `npm run pack:local` 的 `build/packages/index.json` 为准。Node 路线复用已有 Node，不包括 Python 环境或浏览器引擎；不能把原型体积当成全部功能安装大小。

`main` 统一维护 CLI、Web 和公共核心，`cli` 已合入，旧 `dev` 停止维护。功能/安装边界由组件决定。

## 发布完成与后续维护

1. GitHub 九组跨平台验收全部通过；真实校园 VPN/短信继续在本机验证，CI 不使用校园凭据。
2. `seudaily@1.1.0` 及三个 `@miunerofrade/seudaily-*` 可选组件已公开发布，维护者均为 miunerofrade；注册表完整性与候选一致。
3. 无 npm 登录配置的真实注册表安装已通过；内置 CLI、Web 自动安装、共享后端和退出清理已验证。
4. 后续配置四个包的 Trusted Publisher，再通过受保护的 GitHub 发布工作流发布新版本；统一版本，组件先发，主包最后发。

完整的跨界面实时变更广播仍待实施。常驻后台 Focus、Bun 可选独立程序和 Node SEA 继续搁置；这些不阻塞当前本地 Node 候选方案。

## 实验清理

已删除旧 Bun 下载工具/二进制、libsql 对照产物和仅用于替换模块的 SQLite 实验适配器。历史测量 JSON 保留在 `docs/research/data/`；固定验收用例已迁入 `tests/distribution-fixtures/`，通过当前生产构建配置继续运行，不再维护两套实验驱动。

具体命令、目录、包边界和限制见 [分发说明](../distribution.md)。历史结论见 [Bun 第一阶段](../research/bun-phase-one.md)与 [SQLite 打包实验](../research/node-sqlite-packaging.md)。VPN 继续按需下载独立核心，许可记录见 [VPN 许可证说明](../licensing-vpn.md)。

GitHub 工作流、npm 账号和授权准备见 [发布说明](../npm-release.md)。2026-10-05 已按维护者授权发布四个包的 1.1.0。

2026-10-05 云端最终九组全部通过：[Actions run](https://github.com/miunerofrade/SEUdaily/actions/runs/37224641743)。结果清单见 [验收记录](../research/data/github-distribution-ci.json)。Windows 验收修复了共享后端随窗口退出、异步命令强制退出及 VPN 进程存活查询问题；终端测试使用独立 ConPTY 进程，检查真实输入及恢复指令。

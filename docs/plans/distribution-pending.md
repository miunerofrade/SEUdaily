# SEUdaily 分发进度与后续计划

更新：2026-10-04。

**状态：正式 Node 打包、统一入口、组件边界与本地候选包验收已落实；尚未执行 npm 发布，Windows/Linux 实测及发布流程仍待完成。**

## 已按顺序完成

1. **轻量公共核心**：正式存储改为 Node 内置 SQLite，移除 libsql 原生依赖。旧数据库 schema 保持兼容，旧 Mastra 导入只读且不再调用 Python。
2. **统一入口**：npm `bin` 提供 `seudaily`；采用 `chat / web / ask / vpn / status / stop / sessions / skills / completion / import-data`。`-c/--chat`、`-w/--web`、`--vpn PORT` 共用同一解析。旧 `start / exec / --prompt / --cwd / --no-start` 已移除；源码 Python 入口只转交 Node 启动器。
3. **CLI/Web 边界**：核心、CLI、Web 分开构建；Web 为同端口静态页面，运行时不需要 Vite。多入口核对身份、版本、协议和数据目录后复用同一个核心，正常释放及崩溃租约维护生命周期。独立开发后端不会因界面退出而停止。
4. **数据和按需组件**：默认数据目录与安装目录分离，可显式复制旧数据而不删除原件。CLI/Web/Python/浏览器按版本安装到私有缓存；失败可重试，完整组件再原子发布。uv 固定 URL/SHA256，Python 依赖按 lock 导出且检查 hash。Python/Node 的浏览器共用同一版本和缓存，视频提取依赖只在真实 fallback 时安装。
5. **本地发布候选**：基础包使用文件白名单，分组件生成 `.tgz`；脱离源码仓库的安装、失败重试、共享后端、退出/重启和数据导入验收通过。根据实际模块生成许可证文本。仍未发布。

Node 原型实验中的核心+CLI 为 1.11 MiB；正式包还包含启动器、完整业务边界和许可证，最终大小以 `npm run pack:local` 的 `build/packages/index.json` 为准。Node 路线复用已有 Node，不包括 Python 环境或浏览器引擎；不能把原型体积当成全部功能安装大小。

`main` 统一维护 CLI、Web 和公共核心，`cli` 已合入，旧 `dev` 停止维护。功能/安装边界由组件决定。

## 下一步：发布前验收

按以下顺序推进，不自动发布：

1. Windows/Linux 的实际安装、TTY、进程退出、Python/VPN 和浏览器验收；核对 Node 22/24 支持范围。当前实测只有 macOS arm64。
2. 确认包名所有权，选择新的发布版本，统一基础包及四个组件版本。当前五个名称查询返回 404，但尚未注册。
3. CI 和手动发布候选流程已接入 GitHub Actions；等三系统 × Node 22/24 云端结果通过，复核许可证及包内容，先发组件、再发基础包。Node 22 的 SQLite 警告保留在核心日志。
4. 验收实际注册表安装、升级和旧数据导入；本地注册表 fixture 不能替代真实发布验收。

完整的跨界面实时变更广播仍待实施。常驻后台 Focus、Bun 可选独立程序和 Node SEA 继续搁置；这些不阻塞当前本地 Node 候选方案。

## 实验清理

已删除旧 Bun 下载工具/二进制、libsql 对照产物和仅用于替换模块的 SQLite 实验适配器。历史测量 JSON 保留在 `docs/research/data/`；固定验收用例已迁入 `tests/distribution-fixtures/`，通过当前生产构建配置继续运行，不再维护两套实验驱动。

具体命令、目录、包边界和限制见 [分发说明](../distribution.md)。历史结论见 [Bun 第一阶段](../research/bun-phase-one.md)与 [SQLite 打包实验](../research/node-sqlite-packaging.md)。VPN 继续按需下载独立核心，许可记录见 [VPN 许可证说明](../licensing-vpn.md)。

GitHub 工作流、npm 账号和授权准备见 [发布说明](../npm-release.md)。当前没有执行 npm 发布。

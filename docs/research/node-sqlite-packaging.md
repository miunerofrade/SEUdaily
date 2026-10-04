# Node 内置 SQLite 打包实验

2026-10-04，macOS arm64，Node 22.23.3，Bun 1.4.2 作为构建工具。

结论：对 npm 分发，复用用户已有 Node、合并 JS 并使用内置 SQLite 值得继续推进。核心加 CLI 的实验产物从 8.72 MiB 降为 1.11 MiB，减少约 87%；不再附带 libsql 的平台专用 `.node` 文件。启动没有明显改善。本次没有切换正式存储、修改生产入口、重启后端或发布 npm。

## 相同范围比较

| 指标 | Node 合并 JS + libsql | Node 合并 JS + 内置 SQLite |
| --- | ---: | ---: |
| 核心和 CLI 文件数 | 3 | 2 |
| 合计字节数 | 9,140,845 | 1,166,134 |
| 安装体积 | 8.72 MiB | 1.11 MiB |
| 各文件 gzip 字节数之和 | 4,033,449 | 381,133 |
| gzip 体积估算 | 3.85 MiB | 0.36 MiB |
| 固定安装位置，首次首屏 | 568 ms | 293 ms |
| 随后四次首屏中位数 | 300 ms | 290 ms |

每种方式各运行五次，顺序运行，使用同一终端 fixture。首屏从创建进程到收到模型名称，包含核心及界面初始化；不包含正式启动器、后台发现、安装或校园登录。首次数值受文件缓存等因素影响，不能据此推导首次安装性能。内存和后续启动差距均不足以说明显著性能收益。

两个文件是核心和 CLI 组件，均在临时安装位置加载，基础产物没有外部 `node_modules`。它们仍需要已有 Node；体积不包含 Node 本身、Web 静态页面、Python worker 环境、可选浏览器驱动/引擎或 VPN 核心，也不是最终 npm 包大小。gzip 是逐文件压缩估算，正式 npm tarball 还需实测。

## 验证结果

- 原有 Agent runtime、HTTP、终端附件固定用例：libsql 基线 28/28，实验适配层 28/28。覆盖审批恢复、旧数据库导入和运行令牌冲突。
- 两个新增事务用例通过：持有事务时，其他请求排队，不能被其回滚；批量插入失败会完整回滚，并释放后续请求。
- 同一个临时数据库分别完成「libsql 创建 → 内置 SQLite 修改 → libsql 验证」和反向三阶段。历史分支、选中消息路径、中文/emoji、摘要、审批及运行状态、分支复制/删除均一致。没有使用用户实际数据库。
- 实际合并产物通过数据库回滚、历史恢复、单次审批、HTTP、中文 SSE、取消检查。
- 真实 PTY 中通过中文输入提交、图片粘贴/发送、退格删除、流式渲染、窗口调整、取消、Ctrl-D 和长按 Ctrl-C；退出后恢复终端状态。启动比较中的每轮也重复同一 PTY 用例。
- 现有 Python worker 的健康检查、Unicode 错误、恢复、取消通过；可选浏览器 MCP 的工具发现、导航、点击、快照及关闭通过。只访问本地 fixture，未下载校园资料。
- 项目 TypeScript 检查和 Python 验证脚本编译通过。

原始产物和结果位于被 Git 忽略的 `.seudaily/probes/sqlite/`；libsql 对照的独立安装测量位于 `.seudaily/probes/sqlite-baseline/installed-comparison.json`。上一轮 Bun 比较记录未覆盖。复现命令见 [当前分发说明](../distribution.md)。

## 实现与边界

`scripts/probes/node-sqlite.mjs` 只实现当前 AgentStore 使用的本地客户端子集。构建时替换 `@libsql/client`，源码测试通过进程内模块 hook 替换；正式源码仍导入 libsql。数据库 schema 不变，不需要转换 fixture 数据文件。

单连接队列覆盖整个事务生命周期，其他请求等待提交或回滚；SQLite 约束错误映射为 AgentStore 当前识别的代码。没有实现远程 libsql、完整结果对象或所有参数模式。事务内必须通过事务对象执行语句，不能等待同一客户端的普通请求，否则会等待自己释放队列；当前 AgentStore 符合这个约束。

Node 的数据库 API 同步执行，长查询或外部锁等待可能阻塞事件循环；这次没有进行大规模历史数据或多进程竞争压测，不能宣称吞吐提升。当前结果只证明现有固定功能用例及两种驱动的顺序切换兼容，不是两种驱动同时写入的兼容保证。

适配使用的 `timeout`、`columns()` API 从 Node 22.16 可用；实际只验证 22.23.3。测试 hook 依赖 `registerHooks`，不进入正式产物。Node 22 实测会发出 SQLite 实验性警告；正式发布前应确定支持的 Node 版本和警告处理策略，不能直接假设所有安装了 npm 的环境都支持。这些 API 和同步行为见 [Node 官方 SQLite 文档](https://nodejs.org/api/sqlite.html)。

Windows/Linux 未实测。内置 SQLite 可以减少原生模块跨平台分发工作，但终端、Python、浏览器和生命周期仍需要对应平台验收。

## 后续实施建议

优先把「Node 合并 JS + 内置 SQLite」作为 npm 路线候选，Bun 可执行文件继续作为无需已有 Node 的可选分发形式。正式切换时将本地存储抽象为项目自己的接口，固定 Node 支持范围，并在该范围内补齐平台验收；不要将实验 facade 当成完整 libsql 替代包。

这一步仅解决基础产物体积。原发布计划中的生产启动器、CLI/Web 边界、用户数据目录、可选组件安装、安装包白名单及脱离源码仓库验收仍需完成。

## 后续状态

正式路线已转为 Node 合并 JS 与内置 SQLite。原 Bun/SQLite 实验脚本、下载的 Bun 工具及二进制对照产物已清理，历史测量 JSON 保存在 [data](data/)；仍有用的固定用例已迁入 `tests/distribution-fixtures/`，通过 `scripts/build-fixtures.mjs` 与 `scripts/validate-terminal.py` 复现当前正式构建的验证。本文上面的旧实验命令和路径仅为历史记录。实施与发布状态见 [分发说明](../distribution.md)。

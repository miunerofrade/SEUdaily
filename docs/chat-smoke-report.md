# Agent 对话与浏览器实测（2026-10-02）

使用用户现有 `.env`，经与 Web 前端相同的 `/api/agents/seudaily-agent/stream` SSE 接口调用真实 Agent。密钥与空白可选项未修改。测试使用独立的 `seudaily-live-smoke` resource 和随机 thread，避免混入工作台既有聊天。未测试本地 ASR、内存盘。用户授权后，已进行真实校园登录与登录后的读取测试。

## 平台浏览器选择

Node Playwright MCP 和 Python 校园工具统一选择：

| 平台 | 默认实现 |
| --- | --- |
| Windows | Chromium 引擎 + `msedge` 通道，系统 Edge |
| macOS | Playwright WebKit |
| Linux | Playwright Firefox |

Playwright 不能控制系统 Safari；WebKit 是 Safari 使用的引擎，属于 Playwright 的专用构建。Linux 也需要 Playwright 匹配的 Firefox 构建。[官方浏览器说明](https://playwright.dev/docs/browsers)

可选 `SEUDAILY_BROWSER=auto|msedge|webkit|safari|firefox|chromium` 覆盖，空白等于 auto，safari 映射为 webkit。Chromium 参数不会传给 WebKit/Firefox。设置后需重启服务。

本机已安装两个 SDK 各自的版本：

- Node MCP：Playwright `1.64.0-alpha-2026-09-14`，WebKit 2361。
- Python：Playwright 1.58.0，WebKit 2248。
- 缓存目录：`~/Library/Caches/ms-playwright`。Playwright 还下载了自己的 FFmpeg 辅助程序，它不等于项目媒体工具需要的 PATH 中系统 `ffmpeg`。

Node 与 Python 安装器共享目录锁，应依次运行。本轮第一个下载源连接断开，备用官方源完成下载。运行时下载、锁等待的问题已经处理，不影响下表完成的实测。

## 真实 chat 结果

| 场景 | 结果 | 实际行为 |
| --- | --- | --- |
| 问候 | 通过 | 返回“你好，SEUdaily 已准备好。”，未调用工具 |
| 算术 | 通过 | 17×23 返回 391，未调用工具 |
| 记忆写入 | 通过 | 在独立测试 thread 记录代号 |
| 记忆读取 | 通过 | 下一轮正确回答“青竹-47” |
| 日期 | 通过 | 调用 getCurrentDateTool，返回 2026-10-02、周五、Asia/Shanghai |
| 本地课表 | 通过 | 调用日期及 get-course-schedule，localOnly=true；如实说明缓存为空，未联网/登录 |
| 公开网页 | 通过 | read-web-page 实际读取 Example Domain，返回正文和引用 |
| 网页搜索 | 通过 | web-search 实际检索官方文档，并使用 read-web-page 核对；Tavily 调用正常 |
| 浏览器 | 通过 | 使用 WebKit，browser_navigate / snapshot / find 获取 Example Domain 标题与正文 |
| 联网课表 | 正确阻塞 | get-course-schedule 返回 auth_required，Agent 说明会话失效；未打开授权窗口或重试 |
| 教务通知 | 通过 | query-campus-notices 返回最新通知，Agent 列出两条 |

11 个场景全部产生 HTTP 200 和可读流式回答，无 Provider/SSE 错误。其中联网课表验证的是正确的鉴权阻塞，**没有成功同步个人课表**。当前环境能访问教务处公开通知。本轮未触发真实校园网运输故障，不能据此声称全部校园服务都可用。

脱敏原始记录位于项目 `.seudaily/smoke-tests/`（私有运行数据，不进入 npm 包），包含工具调用和结果，供本机排查。真实测试可能消耗模型/搜索额度。

## 登录后实测

通过应用 POST `/app/schedule/authorize` 启动可见 WebKit 认证窗口，使用现有配置登录。返回 `authorized` 并保存会话，没有遇到验证码。发现默认服务超时为 180 秒，短于交互认证最长 300 秒；已将服务超时设为 360 秒，避免前端先收到 Gateway Timeout。

直接 API 实测：当前学期课表同步成功，返回 25 条排课记录；培养方案同步成功，返回 1 份个人方案。

随后真实 Agent 复测：

| 场景 | 结果 | 证据 |
| --- | --- | --- |
| 当前学期联网同步 | 通过 | get-course-schedule 返回 fresh，25 条，无失败后读取缓存冒充成功 |
| 今天本地课表 | 通过 | 日期工具 + localOnly=true；dateFilter.applied=true，matchedCount=3 |
| 培养方案核查 | 通过 | 加载领域 Skill，audit-training-plan 返回 completed，说明课表证据不能证明已通过 |

初次 Agent 同步曾遇到偶发首屏加载超时，后续复测成功。现已单次等待最多 30 秒，确认当前学期值初始化；首屏加载超时单独返回 page_load_failed，与实际学期切换超时区分，两者都不再误导用户重新登录。新增 3 个回归场景，与校园网分类一起共 45 项相关测试通过；新代码使用已有会话实际同步也返回 fresh、25 条。首次测试脚本误将失败后读取缓存成功算作同步成功，已收紧校验并把旧记录改为 failed；保留失败证据。初次按日期查询时学期起始日期未配置，返回 partial；后续配置存在后实际筛选通过。Agent 已补充规则：缺少起始日期时应提示用户填写课表设置，不能承诺重新同步会自动补齐。

成功记录：`.seudaily/smoke-tests/authenticated-e3242cab-8afc-46d4-8822-92af58c8cbf3.json`。失败记录：`authenticated-d1111ef1-7368-44b9-97b9-69f914cf4d0c.json`。本轮没有修改用户的排课、培养方案或关注项，也没有测试课程媒体抓取。

## 默认同步历年课表（后续修正）

默认联网同步现在抓取上海时区当前年份减 4 年对应学年起的全部可选学期。例如 2026 年从 2022–2023 学年起，2027 年从 2023–2024 学年起。普通本地查询仍不联网；明确设置 prefetchAvailableSemesters=false 可只同步指定学期。

通过学校门户自身脚本核对 dqxnxq.do、xnxqcx.do 和 xskcb.do，复用登录 Cookie 直接请求当前学期、可选学期列表及排课，不逐学期操作页面。有效空学期会保存为空；异常结构不会覆盖缓存，部分失败返回 partial；校园网络故障停止请求并交由既有“需要校园网环境”处理。标准接口不可解析时保留原页面读取作为兼容后备。

最终默认 HTTP API 实测：范围内 15 个学期全部同步，无失败；有排课记录的 4 个学期分别返回 18、20、9、25 条，共 72 条。培养方案重新按历年课表匹配后，not_taken 从 29 项降到 2 项，历史课表匹配 completed 30 项、studying 13 项。此处 completed 仍是既有课表证据推算，并非成绩通过证明。

## 校园网异常处理

校园 DNS、连接拒绝/不可达及导航网络超时被捕获为结构化 failed，公开信息只显示“需要校园网环境”，`data.errorCode=campus_network_required`，仅保留安全错误类别。Agent 收到此结果后停止重试，不启动登录、不修复网络。

鉴权失效、缺账号、缺浏览器、字段错误、页面元素等待超时、HTTP 错误以及非校园 API 错误保留原有含义，不统一伪装成校园网问题。CLI、Worker、缓存 warning 和批量结果的分类均有模拟测试。真实网络故障的用户环境验证仍待以后进行。

## 其他修复与验证

- 修复测试停止后立即重启时，npm 已退出而 Mastra 子进程尚存造成的进程锁冲突；POSIX 启动器等待整个进程组退出，必要时超时清理。
- 补齐协议模块缺少的 os 导入。
- MCP 默认返回页面快照，Agent 可直接读取浏览器页面。
- 类型检查、12 项 Node 行为测试、163 项 Python 测试通过。Windows/Linux 浏览器选择有模拟测试，真实启动只在本机 macOS WebKit 上验证。

本机验证命令（测试脚本按用户要求保留在本地，不随此提交提供；先启动服务）：

```bash
fnm use 22
uv run --frozen seudaily start
# 另一个终端：
node scripts/smoke-chat.mjs basic
node scripts/smoke-chat.mjs web
node scripts/smoke-chat.mjs browser
node scripts/smoke-chat.mjs campus
# 已完成校园授权后：
node scripts/smoke-chat.mjs authenticated
```

campus / authenticated 测试遇到 campus_network_required 会停止后续校园场景，等待用户决定下一步。脚本提供预期回答与工具调用校验。真实媒体处理、验证码和 VPN 二次认证流程未验证。

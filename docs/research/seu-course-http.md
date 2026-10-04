# 课程点播 HTTP 实现与对照验证

2026-10-04。使用用户授权的校园账号，通过现有 VPN 本地代理验证。课程工具现已通过共享 Python 实现使用 HTTP；CLI 与 Web 调用同一套后端。真实验证没有下载视频、音频或课件图片，不保存账号、密码、Cookie、JWT、ticket、课程人员信息或签名媒体链接到仓库。

## 结论

课程搜索、学期列表、课次列表、获取播放链接、官方字幕和服务端课件切片都有 HTTP 接口。前五项已取得有效业务数据；课件切片已取得一份图片/OCR 元数据，尚未下载图片核验内容。普通认证不需要运行网页 JavaScript，也不需要启动浏览器。

`course_http.py` 提供 CAS 登录、JWT 请求、分页和失效后一次重认证；`service.py` 保留课程结果结构、精确教师匹配、学期别名、日期/节次选择与产物目录；`capture_http.py` 直接取得签名链接和官方字幕。课程 DOM 查找、点击、重载和媒体嗅探已从工具调用链移除。旧 `capture.py` 页面捕获函数保留为兼容模块及原有回归用例入口，当前 CourseService 不调用它。

课件优先使用正常的 PDF 导出接口；无服务端切片时可继续视频抽帧。课件下载被拒绝时记录权限错误，不重认证或自动下载视频兜底。官方字幕缺失且本地 ASR 不可用时不下载媒体；配置云 ASR、明确保留媒体或需要抽帧时，仍按相应选项处理媒体。

不能把课程门户入口的故障当作账号没有权限。本次门户 `/jy-portal/oauth2/callback` 连续返回 HTTP 502；点播应用自己的 `/jy-application-resourcemanage/oauth2/callback` 则正常完成认证。直接使用点播应用的正常 CAS 登录入口即可完成此次查询，没有修改服务端权限。

## 认证链路

1. 访问 `https://cvs.seu.edu.cn/jy-application-resourcemanage/oauth2/authorize?json=0&returnUri=...`。`returnUri` 为 URL 编码的 `https://cvs.seu.edu.cn/jy-application-resourcemanage-ui/#/login?type=cas`。
2. 正常跟随 `/cloud-rbac/authorize` 到学校 CAS；沿用 `campus_auth.py` 的 `verifyTgt`、验证码检查、RSA 密码提交及认证重定向流程。
3. 跟随点播应用自己的 `/oauth2/callback`，建立应用会话，再 `GET /jy-application-resourcemanage/oauth2/token`。
4. 成功 JSON 的 `result.jwt_token` 用于业务请求头 `jwt-token`。这不是 `Authorization: Bearer`。返回值还包含 `refresh_token` 等字段，均属于凭据。
5. 本次 token 响应的 `expires_in` 为 86400 秒。这是服务器声明的有效期，不能承诺实际始终有效 24 小时；没有等待真实过期。现有公开配置未指定刷新地址，不能据此假设刷新接口可用。后续接入时应在失效后重新走正常 CAS 换取 token，保留人工验证码/二次验证入口。

保存应用 Cookie 后，另起 HTTP 客户端重走授权入口并取得 token，耗时约 0.55 秒，密码提交次数为零。这证明会话复用可行，没有验证强制登出、服务端提前撤销或真实计时过期。

## 已核实的业务接口

以下路径均相对于 `https://cvs.seu.edu.cn/jy-application-resourcemanage`，使用 GET 和 `jwt-token` 请求头。

| 能力 | 接口与参数 | 本次证据 |
| --- | --- | --- |
| 当前身份 | `/v1/currentuser` | HTTP 200，业务 `status=200` |
| 学期列表 | `/v1/list/termYear` | 返回 8 个学期；响应是顶层数组 |
| 点播课程列表 | `/v1/group_subject_vod_list/t-1`；`page.pageIndex`、`page.pageSize`、`page.orders[0].asc`、`page.orders[0].field` | 返回课程记录及分页信息，含 `teclId`、课程/教师/学期信息 |
| 课程搜索 | `/v1/union/vod_live_new`；`courStatus=1`、`unionName`、`acteId` 和分页参数 | 用列表中已有课程名称及学期筛选，返回匹配记录；网页的转写筛选 `courTransferFlag=true` 返回 3 条课程记录 |
| 课次列表 | `/v1/subject_vod_list_new`；`teclIds`、分页参数，按 `courBeginTime` 排序 | 一门课程返回总计 12 节，读取前 5 节；含时间、教室、节次、播放及转写标志 |
| 播放地址 | `/v1/course_vod_urls_new?courseId=...` | `lvcrVodStatus=1`，返回 3 路 `courseVodViewList`，包含签名 URL |
| 官方字幕 | `/v1/course/ai/translate/{courseId}?useOriginal=false` | 有转写的课返回 `afterAssemblyList`、`beforeAssemblyList`，其中组装字幕 145 段；无转写的课返回成功但 `data=null` |
| 服务端课件切片 | `/v1/course/ai/ppt?courseId=...` | 返回 1 条 `docList` 元数据，含 `imageUrl`、`ocrText`、截图时间；不是完整 PPT 文件的证明 |

课次的业务 ID 来自已返回的课次列表；未猜测其他课程或人员 ID。上述播放接口的 `courseId` 按前端实际实现使用课次记录的 `id`。

对返回的 `dncvsvod.seu.edu.cn` 签名 MP4 地址仅发出 HEAD 请求，HTTP 200、`Content-Type: video/mp4`、响应体零字节。没有自行生成签名，也没有下载媒体内容。临时研究材料总计约 2.6 MB，主要是公开前端脚本，收尾时删除。

## 权限与空结果的区别

- 使用全新客户端，不携带 Cookie 或 JWT，当前身份、课程列表、播放地址三个接口均返回 HTTP 401。途中在已认证客户端移除 JWT 请求头仍能成功，是其已有会话 Cookie 的作用，不能据此认为接口公开。
- 请求成功不等于允许播放。点播页还检查业务返回的 `lvcrVodStatus`；前端明确将值为零显示为“暂无权限观看”。此次选取课程返回的是 1，没有实测受限课程，不能声称已验证所有课程权限。
- `data=null`、课程无转写标志、字幕未发布、视频未生成和服务端错误不能统一解释为权限不足。应按业务状态和可用资源分别展示。
- 公开脚本包含授权管理、审核及修改接口，仅说明网页具备这些功能。此次没有调用它们，也不把这些接口视为学生账号可用功能。
- 实现验证发现：同一账号可取得 81 条课件切片元数据，但 PDF 导出返回 HTTP 200、业务 `status=500`、`code=-1` 及权限不足类消息。当前实现实测将它识别为课件权限拒绝，未生成文件，也未绕过限制。`code=-1` 本身不能直接判断 token 过期。成功 PDF 保存使用固定测试响应验证，没有取得真实 PDF。

## tools 与剩余浏览器依赖

公开课程工具是 `resolve-course`、`capture-course-materials`；其内部搜索、列课次、定位课程和捕获操作均已切换至 HTTP。

课表、培养方案已使用 HTTP 认证及查询；通知、网页读取和文档解析也已有 HTTP/本地解析路径。名称中出现 `page` 不一定代表真实浏览器实例，例如培养方案现有适配器的 `page.request` 实际由 HTTP 会话提供。

通用的 `browser_navigate`、`browser_snapshot`、点击、输入、按键、选择与标签页工具属于任意网页操作能力，应作为可选工具保留；不能用几组校园 API 替代它们。

完整保留清单：`browser_find`、`browser_press_key`、`browser_type`、`browser_navigate`、`browser_snapshot`、`browser_click`、`browser_select_option`、`browser_tabs`。

VPN 仍有可见浏览器完成 CAS 回调截获。它使用同一学校认证体系，具备改成 HTTP 获取正常重定向并在一次性 ticket 被消费前交给 VPN 核心的可能；本次未替换或实测这条链路，不能说已经完成。验证码和交互验证仍需用户操作。

仍需浏览器的业务入口：VPN CAS 回调截获、课程与课表遇到验证码/二次验证时的显式可见授权、课表接口结构变化或自定义门户的旧页面兜底。一般网页页面操作工具保持浏览器实现。通知、网页读取、课表、培养方案、课程查询/字幕/资料链接的正常流程不启动浏览器。

## 固定用例与复测

- 修改前固定 `tests/test_course_contract.py` 的 9 个用例：课程字段、学期别名与不存在学期、日期/节次分组、最新或指定日期定位、节次不匹配、日期不存在、教师不匹配。只替代 I/O，业务选择与结果断言保持不变。修改前后同一组用例均通过；连同既有 capture、CAS、浏览器生命周期与工具清单检查，基线为 43 项通过。
- 迁移后增加 HTTP 边界检查：业务 token 失效、最多一次重试、资源权限不当成重登录、跨页结果、字幕写入、缺失本地 ASR 时不下载、学校 PDF 保存及失败时保留已有文件、验证码返回人工登录原因。实际 PDF 权限错误另固定为用例。
- 修改前用正常 HTTP 登录取得同一真实课程的原始记录并固定请求。旧浏览器页面基线采集超时，未取得有效 DOM 输出，因此不声称完成真实浏览器与 HTTP 的逐字段比较，也不据此给出浏览器速度提升倍数。
- 新实现取得该课程 18 个课次、9 个日期；日期和节次分组与固定原始记录相同，指定课次定位成功。四步查询/定位/抓取共约 9.9 秒；取得 1 份官方字幕，ASR 尝试为零，Python 浏览器实例未创建。重复相同抓取请求，字幕 SHA-256 一致，未生成 MP4 文件。
- 媒体链接 HEAD 返回 200，响应体零字节。课件导出的真实成功文件因账号权限限制未验证；拒绝路径已实测，成功写入及原子替换由固定响应验证。临时凭据、原始课程数据和测试产物在收尾时清理。
- 最终检查：cli 分支 Python 全量 255 项通过；main 分支 Python 全量 181 项通过。Node 工具、浏览器配置、Python 桥接、Agent 与 Focus 相关 36 项通过；两个分支 TypeScript 类型检查通过。两分支独立同步共享实现，没有合并。

## 浏览器生命周期

- Python `BrowserRuntime` 构造不启动 Playwright；第一次 `page()` 才启动驱动及浏览器。无头实例跨任务复用 Context，任务结束关闭新建页面，实例在 worker 退出时回收；目前无空闲定时回收。显式可见授权使用临时实例，结束即关闭。课程普通 HTTP 操作不会触发这条路径。
- Node MCP 连接由 `browser` 命名空间或明确搜索网页操作能力时按需建立。列出工具启动 MCP 进程，不等于打开浏览器；执行需要页面的操作时才打开。浏览器空闲 15 分钟执行 `browser_close`，MCP 连接仍可保留；应用退出时关闭连接。
- Playwright 依赖和浏览器安装缓存仍保留，尚未拆成可选发行组件。本次降低的是正常校园工具调用时的运行开销，不能声称已经消除安装体积。

## 前端来源

直接分析学校公开前端脚本，没有克隆外部仓库：

- 门户：`https://cvs.seu.edu.cn/static/js/main.52a2064af1a82b955f25.js`。
- 点播应用：`https://cvs.seu.edu.cn/jy-application-resourcemanage-ui/static/js/index.cf0a1d62.js`。
- 业务 API 定义：点播应用的 `static/js/2287.ba12478e.js`；列表相关定义在 `442.bc1c5136.js`，课次及播放参数调用在 `3064.d7351e88.js`。
- 点播配置：`https://cvs.seu.edu.cn/jy-application-resourcemanage-ui/static/config/global-production.json`，`BASE_URL=/jy-application-resourcemanage`。

脚本文件名可能随学校升级变化。本记录是本次版本的核验结果，不是学校承诺稳定的公开 API。

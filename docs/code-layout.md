# 代码职责与拆分

Node 负责常驻服务、Agent 编排、权限、界面和知识库编排。Python worker 负责校园业务、文档和媒体处理。两者的任务协议继续使用已有 `python-bridge.ts` / `worker.py`，本轮不引入通用跨语言框架。

前端：

- `App.tsx`：会话状态、流式事件、导航、发送和页面组装。
- `chat/message.tsx`：消息、思考和工具执行过程，以及交互请求。
- `chat/markdown-content.tsx`：Markdown、代码高亮与复制。
- `chat/tool-presentation.tsx`：工具中文名称、状态描述和图标。
- `chat/sources-sidebar.tsx`：单条回复来源。
- `workspace/focus-page.tsx`：关注任务及其对话。
- `workspace/library-page.tsx`：资料库目录、分页、搜索和预览。
- `workspace/page-ui.tsx`：已有的页面标题、加载及错误状态组件。
- `workspace-pages.tsx`：课表、培养方案、通知和设置页面；保留 Focus/Library 导出供旧调用方使用。

课表：

- `schedule.py`：远端认证、抓取、缓存、查询和服务入口。
- `schedule_rows.py`：学校数据字段归一化、课程标识、周次与日期计算。
- `schedule_customizations.py`：本地学期、课程、单次修改的校验、保存和应用。

`ScheduleService` 继续提供原方法名与调用方式；提取逻辑通过直接委托及静态/类方法绑定保持兼容，不新增继承体系。后续按实际修改频率继续拆分，不要求每个函数一个文件。

网页原件的共同磁盘规则见 [网页原件存储协议](web-file-storage.md)。

校园 HTTP 接口与缓存：

- `campus_endpoints.py` 集中现有逆向接口的地址、应用编号和数据集映射。学校改接口时先检查这里，再调整对应字段归一化模块。
- `campus_api.py` 统一 eHall 数据集解包和错误分类：合法空列表与缺失字段分开；403、维护页不触发重新登录。课表和培养方案刷新失败保留旧缓存，并返回失败原因。
- `training_plan_normalize.py` 处理培养方案字段与选课规则；`training_plan_evidence.py` 处理课表证据与学分计算；`training_plan.py` 保留认证、抓取和查询入口。
- `webplus_page.py` 负责通知站点配置与页面解析；`jwc.py` 负责同步与缓存。未识别正文结构时拒绝覆盖缓存。
- `browser_auth.py` 统一浏览器登录字段选择器；`json_store.py` 统一 Python JSON 原子写入。Node 对应写入机制在 `runtime/atomic-file.ts`；调用方负责业务锁。
- `web_download.py` 统一有上限、可取消的下载和文件签名校验；`web_attachments.py` 统一附件保存与解析。完整原件复用，解析失败重试读取本地原件，解析临时副本自动清理。校历继续使用自己的清单和缓存策略。

后台任务与 RAG：

- `notice-attachments.ts` 将任务和重试期限持久化到数据根目录的 `.seudaily/notice-attachment-jobs.json`。只解析发生变化的通知缓存文件；后台重启保留重试进度。正文或附件列表版本变化时重新检查该通知的附件。
- `knowledge/cloud.ts` 负责嵌入和重排请求、响应校验与网络错误分类；`knowledge/service.ts` 负责文档状态、去重、排队和索引。
- 临时网络错误、408、429、5xx 最多失败 5 次，按 30 秒起的退避重试；期限保存在知识库 SQLite 的 `knowledge_retries` 表。配置及其他请求错误直接失败；手动重试清除之前的退避。索引写入与删除结果必须成功才继续更新本地状态。
- `course_periods.json`、`document_formats.json` 是两种语言共用的课程时段与文档格式数据，随 Python wheel 打包，Node 经 `shared/` 模块读取。

终端与路由：

- `terminal/command-parser.ts` 负责命令与参数解析，`terminal/commands.ts` 负责执行；`session.ts` 保留状态和请求生命周期。
- `terminal/panels.tsx` 负责课程结果、详情及字幕展示，`theme.ts` 保存共同配色与标签；`app.tsx` 保留键盘交互和界面状态。
- `runtime/conversation-title.ts` 负责会话命名，`runtime/library-files.ts` 负责资料路径及预览规则，`app-routes.ts` 组装 HTTP 路由。

这些边界围绕已有重复逻辑拆分，不增加通用 Adapter/FSM 框架。接口字段校验能阻止错误缓存替换，但学校新增字段或业务规则仍需要更新归一化代码与样例测试。

学校通知来源的 adapter 与接入方法见 [通知来源](notice-sources.md)。通知工具已从 `course-tools.ts` 提取到 `tools/notices.ts`；旧导出入口保留，来源枚举和栏目约束由共同注册表生成。

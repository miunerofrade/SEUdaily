# 校园来源与本地操作的维护入口

通知来源统一在 `src/seudaily/notice_categories.json` 声明机构中文名、域名、栏目路径、文章 ID 前缀和 WebPlus 页面特征。Python 的 `notice_sources.py` 和 TypeScript 的 `shared/notice-sources.ts` 读取同一份配置；`notice_adapters.py` 只选择已登记的实现。

通知正文和附件保存时传递完整通知信息，以“机构 / 栏目 / 通知 / 文件”归档。没有通知上下文的普通网页继续使用默认归档。旧调用通过来源注册表和已有文章缓存恢复上下文；`runtime/web-library.ts` 负责历史目录迁移，不通过重新下载修正目录。关注任务绑定一个 `source`，旧任务默认 `jwc`，改变来源或栏目会清除此前的检查记录和查询缓存。

## 本地操作

`src/seudaily/local_operations.json` 是操作名称、Python action、子操作映射、参数 JSON Schema 和默认结果说明的共享定义。TypeScript 用 Zod `fromJSONSchema` 读取，Python 用 `jsonschema` 读取。有效日期、节次顺序、周次排序去重等语义规则分别执行，并通过 `tests/fixtures/local-operation-cases.json` 对照接受、拒绝和归一化结果。

新增课表子操作时，在契约登记参数和 handler，并在 `schedule_customizations.py` 的处理表登记对应函数。现有 Python action、模型工具 ID 和审批入口继续使用，不需要增加沿调用链分派的分支。业务返回的 `message` 优先于契约默认说明。

创建关注的模型输入仍要求课程名称；历史课程关注可以先描述发现目标，因此直接关注服务保留这种兼容性。已有缓存不会因增加校验而被批量改写，新的课表修改或直接保存会校验类型和周次范围。

## 职责划分

- HTTP 路由：`app-routes-conversations.ts`、`app-routes-schedule.ts`、`app-routes-library.ts`、`app-routes-settings.ts`。`app-routes.ts` 只组装，公共结果读取逻辑在 `app-route-helpers.ts`。
- 终端：`app-input.ts` 处理键盘事件并保持回调读取当前渲染状态；`app-dialogs.ts` 管理弹窗状态、选项与选择动作。`app.tsx` 组装界面、滚动和鼠标选择。
- 课表：`schedule_remote.py` 处理远端请求与学期选择，`schedule_cache.py` 管理缓存及原有兼容迁移。`ScheduleService` 保留方法签名并直接委托。
- 通知：`webplus_search.py` 处理站内搜索协议，`notice_sync.py` 管理详情同步队列和后台 worker。服务保留原入口；时钟、认证会话和请求入口通过明确参数委托，便于离线测试。

验证使用全量 Python/Node 测试、两端类型检查和构建。跨语言对照测试在 `test_local_operations.py` / `.mjs`，第三来源完整流程在 `test_notice_adapters.py` 和 `test_notice_sources.mjs`，终端交互在 `test_terminal_input.mjs`。

课表缓存约定：远端同步的每个学期均保存 `schedule.<学期编号>.json`；`schedule.json` 保留为当前课表入口，同步当前学期时两份一起更新。旧数据仅有主缓存时，显式学期读取只在 `selectedSemester` 完全一致时补齐对应学期文件；主缓存当前学期的数据优先，避免旧副本遮蔽刷新结果。远端各路径统一通过 `schedule_cache._write_schedule_cache` 写入。

会话自动命名由后端完成回调统一触发，微信、网页、终端复用 `conversation-title.ts`。问候语保留临时标题，首次明确主题生成正式标题；手动标题及已生成标题不覆盖。命名在后台执行，重复请求按会话合并，失败可在后续回复后重试。网页顶部只截断显示，完整标题仍保存在会话中。


会话命名与同步契约：

- 新会话默认 `新对话`，存储层统一设置 `titleProvisional`；指定名称的入口设置 `titleManual`。来源单独保存为 `channel`，不拼进标题。
- 正式命名只由共享后端 Agent 完成回调触发，从已保存的用户文字或附件名取主题，不读取客户端传入的命名提示。网页、终端和微信没有独立生成、截取首句或重命名逻辑。旧 `/app/conversations/title` 已删除，旧客户端必须更新，不提供回退或旧标题转换。
- 客户端通过 `GET /app/conversations?perPage=100&page=0` 读取同一份标题、来源与会话元数据，按页加载。后端从数据库发现全部普通会话，不维护客户端资源 ID 名单；程序/关注会话保留各自的业务标题和专用入口。
- 标题更新不改变消息更新时间和会话排序。网页合并时以服务端标题和来源为准，同时保留正在流式输出或尚未同步的本地消息；可见页面定期刷新元数据，后台命名完成后无需重新打开会话。
- 新客户端只需调用现有聊天协议、提供稳定的资源 ID 及可选来源标记，再读取会话列表；无需调用命名 API、配置命名规则或枚举其他客户端。

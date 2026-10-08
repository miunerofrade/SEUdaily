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

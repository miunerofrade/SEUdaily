# 学校通知来源

来源登记在 `src/seudaily/notice_categories.json`，Python 抓取和 Node 工具、资料库、PDF 队列共用这一份配置。已有 `jwc`、`cse` 的 ID、文章前缀和缓存目录不变；`news` 只有机构名称，不自动抓取。

## 接入同类站点

来源信息仍只维护在这份 JSON 中。对于布局可由现有规则表达的 WebPlus 站点，增加配置和网页样本即可接入：

```json
"civil": {
  "name": "土木工程学院",
  "host": "civil.seu.edu.cn",
  "adapter": "webplus",
  "idPrefix": "seu-civil",
  "categories": {
    "announcements": ["学院通知", "/notice/list.htm"]
  },
  "selectors": {
    "title": ["Article_Title"],
    "date": ["Article_PublishDate"],
    "content": ["wp_articlecontent", "Article_Content"]
  },
  "searchType": ""
}
```

这是格式示例，栏目地址需核实。`selectors` 是 HTML class 名的列表，不是任意 CSS 或脚本；省略时使用上述默认值。`idPrefix` 默认 `seu-来源ID`，必须唯一，已有来源不要修改。计软智的搜索参数 `searchType` 为 `"1"`，教务处为 `""`。`displayCategories` 可限定网页通知入口的默认栏目，省略则使用全部栏目。

配置只允许学校域名、站内栏目路径和已注册 adapter。保存后重新构建并更新后端：Node 配置会编入组件，Python 配置随 wheel 安装，必须同时更新；不是在网页设置中热加载。

## 各层职责

- `notice_sources.py` / `shared/notice-sources.ts`：校验来源、栏目、选择器和稳定 ID。
- `notice_adapters.py`：小的 `NoticeAdapter` 协议和来源工厂。协议涵盖列表、站内搜索、正文、已确认附件和后台正文同步。
- `notice_service.py` 的 `NoticeService`：统一编排抓取、缓存、条件请求、去重、正文归档及附件下载。现有调用入口共用这套流程。
- `notice_sites/webplus.py`：按来源配置解析列表、单页栏目和正文，发现标准 WebPlus 搜索入口。
- `notice_sites/jwc.py`：教务处的特殊搜索入口发现；使用网页公开上下文。计软智的结构由来源配置表达，使用默认 `WebplusSite`，无需空的专属实现。
- `notice_readers.py`：按正文最终网址选择本源、其他已注册站点或微信公众号规则，独立于列表来源。
- `notice_sync.py`：共用持久化详情队列及 `notice-worker` 子进程生命周期。
- `runtime/tools/notices.ts`：固定两个模型工具 `query-campus-notices`、`read-campus-notice`。来源及栏目枚举、参数校验、能力检索别名从配置生成，不逐站扩展工具数量。
- `web-library.ts` / `notice-attachments.ts`：遍历注册的可抓取来源，沿用原目录、迁移、去重和重试机制。

新增来源会自动进入工具选项、资料库机构/栏目目录和 PDF 后台扫描。网页通知接口支持 `/app/notices?source=civil`，省略 source 仍返回原教务处列表，现有网页不新增默认栏目。未配置的来源明确报错，不退回教务处。

## 配置列表与单页栏目

`selectors` 沿用 class 名数组，增加以下可选项；不接受任意 CSS 表达式或可执行代码。

| 配置 | 含义 |
| --- | --- |
| `list` | 通知列表容器 class |
| `listItem` | 单条通知的 class；省略时使用通用 WebPlus 的 li/tr 行 |
| `listTitle` | 单条通知内标题区域的 class |
| `listDate` | 单条通知内发布日期区域的 class |
| `title` / `date` / `content` | 保留原有正文选择器 |
| `singlePageCategories` | 来源顶层字段，列出直接展示正文的栏目 ID，例如教务处的 `downloads` |

教务处新版列表配置为 `news-list-wrap / news-list-item / news-item-title / news-item-date-ym`；计软智配置为 `col_news_list / news / news_title / news_meta`。单页栏目需要显式登记，普通列表不再因为发现正文容器而自动转为单页。

新增来源有特殊流程时，在 `notice_sites/` 中实现 `WebplusSite` 子类，按需覆盖 `parse_list`、`parse_detail` 或 `discover_search`，并在该包的 `_SITE_OVERRIDES` 中绑定来源 ID。这个映射只登记实现，域名、栏目和选择器继续取自 JSON。无需另加 Agent 工具、缓存方案或客户端入口。

列表和详情的 HTTP 验证器包含来源、解析阶段、规则版本和选择器摘要。改教务处列表规则只让教务处列表重新验证；普通正文继续沿用自己的验证器。单页栏目的列表验证器也包含正文选择器。共同解析组件发生变化时，相关来源统一重新验证。通知数字 ID、缓存目录、归档路径和 Focus 已读 ID 保持原有规则。配置变更自动更新摘要；修改站点解析算法时递增对应的 `list_revision` / `detail_revision`，修改公共算法时递增 `PARSER_VERSION`。

## 搜索行为

`mode=search` 继续使用网站的 WebPlus 搜索，省略 `categories` 和 `paths` 时搜索全站；传入时限制到对应栏目。列表、详情、附件、正文缓存以及返回字段保持现有格式。

如果网站不是 WebPlus，或列表/搜索协议不同，增加一个 adapter 实现并在工厂登记；配置校验同步允许该类型。当前不支持 RSS、订阅调度或动态插件。

## WebPlus 页面适配与失败边界

列表只从已识别的通知区域读取：新版 `.news-list-wrap / .news-list-item`，以及原有 WebPlus 列表容器。优先使用页面显示的日期；链接先去除首尾空白，再解析相对地址。`/_t数字/` 模板前缀不会改变 WebPlus 数字文章 ID，已有文章、版本目录和 Focus 已读记录仍沿用原 ID。

下载专区、人才招聘等单页正文栏目作为一个资源页收录。真正的空栏目需要空记录文字、零记录标记，或空 `simpleList` 的 `No Data` 标记。布局无法识别、条目不完整、维护页和访问限制页均报告错误；HTTP 200 本身不算抓取成功。失败页面不会替换正文缓存、归档或 HTTP 验证器。解析器升级后会重新验证旧缓存一次，之后继续使用条件请求。

正文支持普通附件链接、`.wp_pdf_player[pdfsrc]`、PDF viewer 的 `file` 参数以及正文图片。编辑器资源路径和节点用途用于识别附件图标、占位图，正常上传目录中的同名图片仍保留。直接指向 Word、PDF 等文件的列表条目先验证文件头，再作为附件入口保存；旧 `.doc/.xls/.ppt` 可以保留下载链接，文本解析格式仍以 `document_formats.json` 为准。

学院转载和新闻网页面使用正文边界解析；微信公众号使用其独立正文容器。遇到校园访问限制时沿用已连接的校园 VPN 重试机制；微信网页验证等限制会明确报错，不保存提示页。一个栏目或一篇详情失败不阻断其他项目；所有列表或搜索栏目失败时明确报告整轮失败。

教务处新版模板没有搜索表单时，由 `JwcSite` 从页面公开的站点、模板和栏目标识建立原有 WebPlus 搜索上下文，继续请求学校搜索接口。不会将有限页数的标题筛选冒充全站搜索。

2026-10-24 的线上核对、样本和测试结果见 [新版站点验证记录](research/notices-webplus-2026-10-24.md)。

站点级拆分的测试与线上复查见 [站点适配验证记录](research/notices-site-adapters-2026-10-24.md)。

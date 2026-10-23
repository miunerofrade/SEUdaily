# 学校通知来源

来源登记在 `src/seudaily/notice_categories.json`，Python 抓取和 Node 工具、资料库、PDF 队列共用这一份配置。已有 `jwc`、`cse` 的 ID、文章前缀和缓存目录不变；`news` 只有机构名称，不自动抓取。

## 接入同类站点

对于学校的 WebPlus 站点，增加一项配置即可，不再为每个机构增加工具或服务类：

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
- `jwc.py` 的 `WebplusNoticeAdapter`：复用现有 WebPlus 实现。`JwcService`、`CseService` 留作兼容入口，旧 worker action 也保留。
- `runtime/tools/notices.ts`：固定两个模型工具 `query-campus-notices`、`read-campus-notice`。来源及栏目枚举、参数校验、能力检索别名从配置生成，不逐站扩展工具数量。
- `web-library.ts` / `notice-attachments.ts`：遍历注册的可抓取来源，沿用原目录、迁移、去重和重试机制。

新增来源会自动进入工具选项、资料库机构/栏目目录和 PDF 后台扫描。网页通知接口支持 `/app/notices?source=civil`，省略 source 仍返回原教务处列表，现有网页不新增默认栏目。未配置的来源明确报错，不退回教务处。

## 搜索行为

`mode=search` 继续使用网站的 WebPlus 搜索，省略 `categories` 和 `paths` 时搜索全站；传入时限制到对应栏目。列表、详情、附件、正文缓存以及返回字段保持现有格式。

如果网站不是 WebPlus，或列表/搜索协议不同，增加一个 adapter 实现并在工厂登记；配置校验同步允许该类型。当前不支持 RSS、订阅调度或动态插件。

## WebPlus 页面适配与失败边界

列表只从已识别的通知区域读取：新版 `.news-list-wrap / .news-list-item`，以及原有 WebPlus 列表容器。优先使用页面显示的日期；链接先去除首尾空白，再解析相对地址。`/_t数字/` 模板前缀不会改变 WebPlus 数字文章 ID，已有文章、版本目录和 Focus 已读记录仍沿用原 ID。

下载专区、人才招聘等单页正文栏目作为一个资源页收录。真正的空栏目需要空记录文字、零记录标记，或空 `simpleList` 的 `No Data` 标记。布局无法识别、条目不完整、维护页和访问限制页均报告错误；HTTP 200 本身不算抓取成功。失败页面不会替换正文缓存、归档或 HTTP 验证器。解析器升级后会重新验证旧缓存一次，之后继续使用条件请求。

正文支持普通附件链接、`.wp_pdf_player[pdfsrc]`、PDF viewer 的 `file` 参数以及正文图片。编辑器资源路径和节点用途用于识别附件图标、占位图，正常上传目录中的同名图片仍保留。直接指向 Word、PDF 等文件的列表条目先验证文件头，再作为附件入口保存；旧 `.doc/.xls/.ppt` 可以保留下载链接，文本解析格式仍以 `document_formats.json` 为准。

学院转载和新闻网页面使用正文边界解析；微信公众号使用其独立正文容器。遇到校园访问限制时沿用已连接的校园 VPN 重试机制；微信网页验证等限制会明确报错，不保存提示页。一个栏目或一篇详情失败不阻断其他项目；所有列表或搜索栏目失败时明确报告整轮失败。

新版模板没有搜索表单时，从页面公开的站点、模板和栏目标识建立原有 WebPlus 搜索上下文，继续请求学校搜索接口。不会将有限页数的标题筛选冒充全站搜索。

2026-10-24 的线上核对、样本和测试结果见 [新版站点验证记录](research/notices-webplus-2026-10-24.md)。

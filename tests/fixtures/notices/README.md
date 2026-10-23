# 学校通知 HTML 样本

2026-10-24 抓取的公开网页片段，删除导航、脚本和其他无关区域，规范化 HTML 引号和实体。标题、日期、文章/附件地址和正文结构保留。样本不含校园账号、Cookie、学生个人名单或下载文件。

| 文件 | 页面来源与用途 |
| --- | --- |
| jwc-academic.html | https://jwc.seu.edu.cn/jwxx/list.htm；新版 div 列表、显示日期和模板前缀 |
| cse-undergraduate.html | https://cse.seu.edu.cn/49469/list.htm；既有计软智列表 |
| cse-empty.html | https://cse.seu.edu.cn/jyxx/list.htm；明确的 No Data 空栏目 |
| jwc-pdf-body.html | https://jwc.seu.edu.cn/2026/1023/c21681a587358/page.htm；嵌入 PDF、普通 PDF 链接及编辑器图标 |
| cse-attachment-body.html | https://cse.seu.edu.cn/2026/0924/c49469a584397/page.htm；Excel 附件与编辑器图标 |
| jwc-static.html | https://jwc.seu.edu.cn/xzzq/list.htm；单页正文形式的栏目 |

其他损坏布局、HTTP 200 提示页、分页刷新失败、模板切换及文件头样本在 `test_notice_html.py` 中构造，验证错误边界和缓存保留。线上验证记录另见 `docs/research/notices-webplus-2026-10-24.md`。

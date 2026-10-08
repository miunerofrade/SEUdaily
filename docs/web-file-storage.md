# 网页原件存储协议

网页正文和下载附件共用磁盘协议。Python 写入、Node 读取与迁移，不需要通过 worker 往返读取每份原文件。

目录名、目录标识校验及 SHA-256 格式集中在 `src/seudaily/web_files_protocol.json`。Python 的 `saved_web_files.py` 和 Node 的 `web-file-store.ts` 均读取此文件；`notice_categories.json` 继续提供机构中文名和栏目名称。修改协议规则时需同时验证两种语言，不能仅修改一边的路径拼接。

所有路径相对于服务的数据目录：

```text
.seudaily/web-files/
  metadata/<SHA256(完整URL)>.json
  files/<来源域名或标识>/<栏目键>/<通知ID>/<SHA256(文件内容)>.<扩展名>
```

完整 URL 是下载缓存身份，文件内容哈希负责去重。不同 URL 可以引用同一原件；不同通知目录可各自保留相同文件，RAG 按内容哈希合并。UI 使用 `name` 展示友好文件名，不展示哈希名。

新元数据包含：

| 字段 | 含义 |
| --- | --- |
| `url` / `sourceUrl` | 文件下载地址 / 所属通知或网页地址 |
| `name` / `path` | 原始友好文件名 / 本机原件绝对路径 |
| `sha256` / `sizeBytes` | 原件内容校验和 / 字节数 |
| `source: {id,name}` | 来源目录标识和机构中文名 |
| `notice: {id,title,url}` | 所属通知身份、标题、地址 |
| `sectionId` | 栏目键，未知栏目使用 `other` |
| `markdown` / `charCount` / `parsed` | 可选的附件解析缓存 |
| `noticeSection` / `legacyPaths` | Node 为显示及恢复迁移添加的兼容字段 |

Python URL 缓存与 Node PDF 同步读取都校验字段、原件位于受管目录、符号链接和 SHA-256。后台下载完成后也必须经过同样校验，再加入 RAG，不能信任工具返回的路径。

旧的平铺目录和旧来源目录由 `web-library.ts` 兼容迁移：复制、校验目标、原子更新元数据，确认引用迁移完成后清理旧路径；冲突或损坏时保留原件。`legacyPaths` 保留知识库来源重定位所需记录。正常查询缓存不重新下载。

`tests/test_web_file_protocol.mjs` 验证 Python 写入→Node 读取、Node 正文生成→Python 缓存读取，以及非法路径和新下载文件的校验。旧目录迁移另由 `tests/test_web_library.mjs` 覆盖。

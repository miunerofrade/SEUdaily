# 个人知识库

知识库独立于聊天会话。在聊天中上传的有文字文档自动入库，切换或删除聊天不会删除知识库。聊天模型保持原有配置，文本向量单独使用阿里云百炼。

## 配置百炼

在[阿里云百炼](https://help.aliyun.com/zh/model-studio/get-api-key)创建北京地域 API Key。在 Web 的“设置”或终端 `/settings` 中填写“阿里云百炼 API Key”。通过界面保存立即生效，无需重启。密钥无需发给聊天模型。

也可在用户数据目录的 `.env` 中配置，手动编辑后需重启后端：

```dotenv
DASHSCOPE_API_KEY=你的百炼密钥
SEUDAILY_EMBEDDING_MODEL=qwen3.7-text-embedding
SEUDAILY_EMBEDDING_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
```

后两项可留空，使用上述默认值。默认采用模型返回的 1024 维向量。官方也推荐业务空间专属地址：`https://你的业务空间ID.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`，可填入“向量服务地址”。密钥与地址必须属于同一地域。参见[百炼 Embedding 接口文档](https://help.aliyun.com/zh/model-studio/embedding-interfaces-compatible-with-openai/)。

文件可以在配置密钥前上传，保存配置后后台开始处理。云端收到用于索引的文字片段以及检索问题；原文件保存在本机。

## 上传后自动检索文件

直接在 Web 聊天框上传文档，或在 TUI 粘贴文件路径，即可自动解析并进入后台索引，无需先执行命令。支持 PDF、DOCX、XLSX、PPTX、TXT 和 MD。也可在 Web“资料库”的知识库区域上传。单个文件最大 50 MB。旧资料不会自动扫描入库：在资料库选中文件，然后点击加入知识库。

通常上传后直接提问即可，例如“之前上传的课程说明里，考试占比是多少？”；刚上传的文档可以立即根据正文回答，跨会话检索需等索引完成。

下面的终端命令是可选管理与调试入口，不是每次上传必做的步骤：

```text
/knowledge
/knowledge add "/完整路径/课程资料.pdf"
/knowledge search 考试占比是多少
/knowledge retry 文档ID
/knowledge remove 文档ID
```

文档 ID 可从 `/knowledge` 的列表复制。Web 提供重试和移除按钮。聊天文档会自动入库，图片暂不索引。

完成索引后，可在任意会话询问“从知识库找一下考试占比”。无需特意说“知识库”；模型通过按需发现的 `search-knowledge` 工具检索正文片段，获得文件名及页码；没有真实页码时只标注片段序号。检索结果是资料，不能作为操作指令执行。

图片和无文字的扫描 PDF 暂不做 OCR，也不会为其调用向量接口。`<upload>` 批量上传模式、微信文件接收和相对日期标注尚未接入本阶段。

## 处理和存储

原文件按 SHA256 去重。解析正文采用 LangChain 递归分块器，每块最多 1000 字符、相邻块重叠最多 150 字符，优先按段落和中文标点分开，长段落继续拆分。保留 PDF 页码。

文件、解析缓存、片段向量缓存和 LanceDB 索引位于用户数据目录下的 `.seudaily/knowledge/`，其中 `files/` 保存原文件。现有 `.seudaily/agent.db` 记录文档及处理状态，无需另启数据库服务。文件原子写入；处理中断后重新排队；网络失败保留文件并提供重试，相同配置下已生成的向量复用缓存。

向量模型、服务地址或分块规则变化后，旧索引显示为需重建，检索不混用不同配置的向量。点击重建或执行 `/knowledge retry 文档ID`。移除文件时同时移除知识库副本和可检索记录，不删除原资料库文件。

NPM 安装首次处理知识库时自动准备可选 Python 组件；源码开发环境可先执行 `uv sync --extra documents --extra knowledge --group test`。本阶段不包含定时备份或 OCR。

源码开发的 Web 默认运行在 4173，通过 Vite 代理连接 4111 的后端，也可复用 NPM 启动的常驻后端。开发代理仅转换本地开发界面的 Origin；外部站点请求仍由后端拒绝。

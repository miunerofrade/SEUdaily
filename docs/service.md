# 个人常驻服务与存储

## 两种运行方式

普通 `seudaily`、`seudaily web` 会先查找同端口、同数据目录、同版本的后端。已有后端就直接连接，不改变它的生命周期；不存在才启动临时后端。临时后端在没有客户端且没有正在发送的队列任务时自动关闭。

先启动常驻后端：

```bash
seudaily serve
```

然后在其他终端照常运行 `seudaily` 或 `seudaily web`。它们退出后，`serve` 后端仍然运行，Focus 也继续检查。`serve` 不注册界面客户端、不依赖界面心跳，日志直接输出到前台。已有后端时再执行 `serve` 会报错；先停止原后端再启动，避免同一份数据由多个进程维护。

如果需要启动后立刻提供网页资源，可用：

```bash
seudaily serve --with-web --data-dir /path/to/data --port 4111
```

`--with-web` 只是预先准备 Web 资源；不带它时，后续 `seudaily web` 也会为同一个常驻后端开启 Web。连接的命令需要使用相同的 `--data-dir` 和 `--port`。

`serve` 是前台进程，显式 Ctrl+C、SIGTERM 或 `seudaily stop` 会停止它。需要退出登录、关闭 SSH 后仍运行时，使用下面的 systemd 服务管理。关闭客户端不等于停止服务。

## Linux：systemd 用户服务

仓库提供 `deploy/seudaily.service`，npm 包也包含这个文件。先检查实际安装位置：

```bash
command -v node
npm root -g
```

编辑 unit 的 `ExecStart`，使用稳定的绝对 Node 路径和实际的 `<npm root -g>/seudaily/bin/seudaily.mjs`；示例路径不是自动探测结果。使用 fnm/nvm 时，服务不会读取交互 shell 的初始化脚本，应写具体的 Node 路径，升级 Node 后同步修改。`Environment=PATH=...` 也应覆盖 npm、uv 所在目录；首次准备可选组件需要 npm 和网络。

把 unit 放到 `~/.config/systemd/user/seudaily.service`，然后：

```bash
systemctl --user daemon-reload
systemctl --user enable --now seudaily.service
systemctl --user status seudaily.service
journalctl --user -u seudaily.service -f
```

若希望退出登录后继续运行、开机时无人登录也启动，为这个账号启用 linger（通常需要管理员执行）：

```bash
sudo loginctl enable-linger "$USER"
```

停止和重启：

```bash
systemctl --user stop seudaily.service
systemctl --user restart seudaily.service
```

unit 使用 `Restart=on-failure`，异常退出后等待 10 秒重启，正常停止不会自动重新启动。停止超时为 25 秒，后端内部有 15 秒退出上限；systemd 最终清理整个进程组。不要以 root 运行个人服务。配置仍使用数据目录 `.env`，不把校园密码写进 unit。

更新步骤：先 `systemctl --user stop seudaily`，再用相同数据目录执行 `seudaily update`，最后 `systemctl --user start seudaily`。安装目录与数据目录分开，更新不替换个人数据。运行中的常驻后端会阻止自动更新停服，避免与服务管理器竞争。

macOS 的 `serve` 使用相同的后端行为；长期管理可交给 launchd，前台调试也可使用 tmux。仓库中的 systemd unit 适用于 Linux。

## 服务器怎么访问和完成认证

后端继续只监听 `127.0.0.1`，沿用已有本地 Host/Origin 检查，没有新增公网账号系统。远程使用网页时，先在服务器启动 `serve --with-web`，再从个人电脑建立隧道：

```bash
ssh -N -L 4111:127.0.0.1:4111 user@server
```

用浏览器打开 `http://127.0.0.1:4111`。本地转发端口与后端端口应保持一致，以满足原有 Host/Origin 校验；端口冲突时统一改用其他端口。CLI 可在服务器 SSH 会话中执行普通 `seudaily`，连接已运行的后端。

认证流程已有两条路径：

1. 在设置里保存校园账号密码（数据目录 `.env`），首先尝试 HTTP 自动认证。课程 Cookie 保存在 `cookies.json`，课表/培养方案 Cookie 保存在 `.seudaily/ehall-cookies.json`，后续调用复用它们。
2. 需要短信时，CLI 会打开“校园短信验证”表单，Web 会弹出短信对话框；发送短信、填写验证码、点击验证并继续。短信 challenge 在 Python worker 内存中，5 分钟有效；服务重启或 challenge 过期后重新发起登录即可，无需重新配置账号。
3. 需要验证码、扫码或其他浏览器交互时，点击会话里的“登录课表系统并继续”或“登录课程平台并继续”；CLI 使用结果中的登录续接操作。后端发起明确授权动作后，在**后端机器**启动可见 Playwright 浏览器。本人在该窗口完成操作；成功后保存 Cookie，并重新执行被打断的原工具调用。
4. 通用登录续接请求保存在 `.seudaily/auth-resumes.json`，有效期为 30 分钟，最多 3 次失败尝试。授权动作最长等候约 5 分钟；课程页面内部等待约 2 分钟。上次授权超过 6 分钟仍未完成时允许重试。续接成功后由界面发送结果给 Agent 继续原任务。

**打开本地 Web 不会把服务器的 Playwright 登录窗口显示到本地浏览器中。** 无桌面的 Linux 主机要配置可交互的远程桌面/VNC，并让服务具有该图形会话的 DISPLAY 和访问权限；连接服务器桌面后再点击授权，完成窗口里的验证码或扫码。Xvfb 只提供虚拟显示器，本身不能让你看到并操作窗口。只有短信的场景可直接通过 SSH 隧道后的网页或 CLI 完成。

具体操作：用同一账号连接服务器远程桌面，在该桌面的终端中执行下面两条命令，把实际的图形会话环境交给用户服务，再通过网页发起登录：

```bash
systemctl --user import-environment DISPLAY XAUTHORITY WAYLAND_DISPLAY XDG_RUNTIME_DIR
systemctl --user restart seudaily.service
```

只需导入当前桌面中实际存在的变量；远程桌面重新创建或更换显示号后重新导入。随后查看服务器桌面上弹出的浏览器，完成验证码/扫码，等待网页或 CLI 显示登录完成，再继续原任务。

校园/VPN/模型服务暂时失效不会让常驻 HTTP 后端退出。Focus 外层执行失败会记录日志，5 分钟后重试；通知任务按已有两小时间隔检查。课程任务沿用持久队列、24 小时重试间隔和连续失败暂停规则，恢复网络/认证后可能需要在 Focus 界面恢复已暂停的关注。没有配置的关注不会自动生成新任务；本次没有新增全量校园数据定时同步。

## 数据存在哪里

下表路径以 `--data-dir` 选择的目录为根。npm 默认目录：

| 平台 | 默认数据根目录 |
| --- | --- |
| macOS | `~/Library/Application Support/SEUdaily` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/seudaily` |
| Windows | `%LOCALAPPDATA%\SEUdaily` |

通过源码兼容入口 `uv run seudaily` 启动时，默认使用仓库目录；直接调用 `node bin/seudaily.mjs` 则使用 npm 默认目录。以前仓库中的数据可以用 `import-data` 导入空的新数据目录。

| 路径 | 内容 |
| --- | --- |
| `.seudaily/agent.db` | 对话、执行状态、摘要、消息队列和迁移标记 |
| `.seudaily/uploads/images/` | 图片原件；会话保存图片 ref、名称、类型等信息，不把整张图片二进制放进 SQLite |
| `.seudaily/uploads/documents/<contextRef>.<扩展名>` | 本次新增：解析成功的 PDF、DOCX、XLSX、PPTX 原件，资料库可查看/下载 |
| `.seudaily/document-context/<contextRef>.json` | 本次改为持久保存：原始文件名和解析 Markdown 文本，供队列与后续轮次读取 |
| `exports/` | 课程资料、转写、笔记及其他工具导出文件 |
| `.seudaily/tasks/` | 工具任务结果及结果引用；不是统一附件仓库 |
| `.seudaily/focus.json` | 关注配置、事件、课程任务队列和运行租约 |
| `.seudaily/schedule*.json`、`.seudaily/training-plan.json` | 课表与培养方案等缓存；并非 SQLite 表 |
| `.env`、`cookies.json`、`.seudaily/ehall-cookies.json` | 配置及认证凭据 |

数据库中的表具体包括：

- `threads`：会话 ID、资源归属、标题、元数据、时间；元数据包含会话树选择等信息。
- `messages`：角色、完整消息内容 JSON、顺序和时间；内容包含文本、工具调用/结果片段、消息父节点、模型消息和图片引用。
- `runs`：Agent 的执行状态、上下文、待处理工具调用、审批、输入/输出等恢复所需状态。
- `summaries`：压缩后的上下文摘要及覆盖到的消息序号。
- `message_queue`：待发送/失败/暂停的消息草稿及图片、文档引用。
- `legacy_memory`：从旧 Mastra 数据库导入的记忆；`metadata`：迁移标记等。

文档解析文本在发起 Agent 轮次时，会按“附件名、字符数、解析 Markdown”包装进用户消息，随后随消息存入 SQLite。PDF 提取的文字、Office 文档的段落/表格/工作表/幻灯片文字等以解析器输出为准；这里没有 embedding、向量库或 RAG 索引。完整原件及独立解析文本在上述文件目录中保留，便于后续再设计 RAG。

**改动前**：图片已经持久落盘；文档原件放在系统临时目录，解析后立即删除。文档解析文本放在 `seudaily-document-context-<uid>` 临时目录，未消费 10 分钟过期，消费后延长到 24 小时；进入对话的解析文本仍随消息存在数据库里。本次不能恢复已经删掉的旧文档原件，但旧临时引用在尚未过期时仍可读取。

**改动后**：解析成功的上传文档和解析文本不再自动过期；图片照旧保留。会话删除不会自动清理附件文件。解析失败的原件仍按既有行为清理，上传成功但没有发送的附件也会保留。磁盘占用会随使用增长，目前没有自动保留期、配额、垃圾回收、微信接入或 RAG。

## SQLite 可靠性与 WAL

WAL 是 Write-Ahead Logging（预写日志）：写入先提交到旁边的 `agent.db-wal`，SQLite 再把它合并到 `agent.db`；`agent.db-shm` 是协调访问的共享索引。WAL 能改善读写并发，并在进程异常退出后恢复已提交事务。运行中这些文件存在是正常情况，不应手动删除。

本次启用 WAL、`synchronous=FULL`、5 秒锁等待、启动 `quick_check`。同一连接的读写通过队列串行化，写事务使用 `BEGIN IMMEDIATE`，失败时回滚，关闭时排空已排队操作再 checkpoint/关闭。文件权限保持私有；同一数据目录的后端通过 `core.lock` 防止重复运行，异常退出留下的锁在确认原进程已不存在后清理。

启动时把崩溃遗留的 `running` Agent 标记为 `interrupted`，已经开始执行的消息队列标记为失败，供用户取回编辑后重发；不盲目重放可能有副作用的调用。通知 Focus 的旧运行租约会在常驻后端启动时释放，保留原检查间隔。Focus/认证续接状态损坏时保留文件并报错，避免静默用空状态覆盖配置。

WAL 不是备份，也不能承诺损坏的磁盘永远可恢复。数据库应放在本机可靠文件系统；不要让多台主机通过网络盘共享 WAL 数据库。发现检查失败时先保留文件和日志，不自动删库重建。原有 Mastra 导入仍为事务迁移并保留旧数据库，迁移标记避免重复导入。

本次没有实现数据库定时备份。以后实现在线备份时应使用 SQLite 提供的一致快照机制，不能只复制运行中的 `agent.db` 忽略 WAL；离线归档则要先停止服务并同时保留附件、配置与相关状态。

## 终端粘贴

新增直接读取系统剪贴板的 `Ctrl+V` / `Alt+V`，可粘贴截图、文本、剪贴板中的文件路径。原有终端原生粘贴、文件拖入及 `/attach "路径"` 保留。图片最多 10 MB，每轮最多 10 个图片/文档附件。

macOS 原生文本粘贴通常用 Command+V，由终端负责；CLI 能收到 Command+V 按键事件时也处理它。图片建议用 Ctrl+V。Option/Alt+V 需要终端把 Option 配成 Meta/Esc；默认输入特殊字符的终端可直接用 Ctrl+V。Windows 使用 PowerShell STA 读取剪贴板；Linux Wayland 需 `wl-clipboard`，X11 需 `xclip` 或 `xsel`（`xsel` 只提供文本回退）。SSH 里的程序读不到你电脑的系统剪贴板，使用终端原生文本粘贴或 Web 上传图片。

OpenAI 官方 [图片输入说明](https://learn.chatgpt.com/docs/image-inputs?surface=cli)确认 CLI 支持粘贴图片；快捷键另外核对了其[官方源码 keymap](https://github.com/openai/codex/blob/main/codex-rs/tui/src/keymap.rs)：固定图片粘贴绑定为 Ctrl+V / Ctrl+Alt+V。本项目额外支持用户要求的 Alt+V。

## 微信渠道

`seudaily wechat` 首次扫码接入，复用已有后端；缺少后端时启动常驻服务，已有临时后端则转换为常驻。普通 CLI/Web 打开已有微信绑定的数据目录时也会恢复渠道并保持常驻。退出界面后继续收发；开机启动和崩溃恢复仍交给这里的 systemd `serve` 服务。具体步骤、文字聊天与会话管理、凭证和消息存储、重新认证见 [微信接入说明](wechat.md)。

## 列出和停止单个服务

`ps` 是 process status（进程状态）的缩写。`seudaily ps` 列出本机正在监听的 SEUdaily 后端，显示 PID、端口、常驻/临时模式、版本和数据目录。也识别旧版源码后端；旧版未提供的数据标为未知，在 macOS/Linux 上尽量通过工作目录补充。它不列出其他应用的所有端口。

```sh
seudaily ps
seudaily stop --port 4111    # 只停止这个端口上的 SEUdaily
seudaily stop 12345          # 只停止 ps 中 PID 为 12345 的 SEUdaily
seudaily stop                # 只处理默认端口 4111，或 SEUDAILY_PORT 指定端口
```

停止管理不要求目标后端与当前 CLI 版本、协议或数据目录相同；普通聊天和 Web 连接仍要求兼容。停止优先调用后端的退出接口。没有该接口的旧版会核实系统监听端口、进程命令与 SEUdaily 身份，再向确切 PID 发送 SIGTERM；不使用 SIGKILL，也不会按名称批量关闭 Node。现代后端通过退出接口执行数据库收尾；旧版进程收到 SIGTERM 后的行为由其旧代码和操作系统决定。PID 不属于可识别的 SEUdaily、PID 与指定端口不符或端口是其他服务时会拒绝操作。

源码目录构建后执行 `npm link --ignore-scripts`，使用 `seudaily wechat --data-dir "$PWD"`，可继续使用仓库中原有的校园配置、数据库和附件；直接使用 Node 入口而不带 `--data-dir` 时，默认数据目录是系统用户数据目录。

同版本、同数据目录的后端重启后，新版 CLI/Web 启动器会在续租失效时验证服务身份并重新登记连接；Web 同时恢复静态页面服务。跨版本更新需退出旧界面后重新打开。旧版进程无法热更新，反复出现“界面连接已失效”时，先按 Esc/Ctrl+C 退出旧启动器，再运行当前版本的命令。

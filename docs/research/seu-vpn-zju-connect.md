# 东南大学 VPN 与 zju-connect 接入调查

调查日期：2026-10-03。研究对象：zju-connect `923672dc927e43e04592595a0005ad90a7a3afb5`（2026-09-29），当前 SEUdaily `cli` 分支。

## 结论与验证范围

有可行的接入路径：使用 zju-connect 的 aTrust 协议，通过东大的 CAS 账号密码登录取得 VPN 会话，再向 SEUdaily 的校园请求提供本地 HTTP/SOCKS 代理。校内人员当然可以使用统一身份认证账号密码；CAS 描述的是认证流程，而不是必须扫码。

已经克隆并阅读 zju-connect 和 hitsz-connect-verge；参考了 EZ4Connect 的公开 README 与架构说明。EZ4Connect 的克隆受 GitHub 网络错误影响，未完成本地源码核验。

最初完成了公共接口与源码调查；随后按用户要求接入应用，并使用已保存的校园账号完成真实 CAS 认证和 aTrust 核心启动。已确认认证、核心初始化及 eHall 的一次 TCP CONNECT 成功；随后 HTTPS HEAD 请求仍出现代理错误/超时，CVS 经 VPN DNS 返回域名不存在。未确认课表、课程媒体可通过此通道正常使用。未更改系统路由或系统代理，未下载课程媒体、未调用 ASR。

## 公共接口实测

`https://vpn.seu.edu.cn/public/manifest` 和以下认证列表接口均返回 HTTP 200、业务 code 0：

```text
GET /passport/v1/public/authConfig?clientType=SDPClient&lang=en-US&needTicket=1&platform=Linux
```

| 显示名称 | loginDomain | authType | 应用含义 |
| --- | --- | --- | --- |
| 校内人员 | CAS-auth | auth/cas | 校园统一身份认证账号密码登录 |
| 校外人员 | local | auth/psw | 本地认证域；不应拿校园账号直接套用这个默认入口 |
| 扫码登录（数智东南） | wechat | auth/qywechat | 可选的扫码入口；当前核心登录方法没有实现该 authType |

校内登录入口是相对 URL `/passport/v1/public/casLogin?sfDomain=CAS-auth`，需要先与 VPN 服务的 origin 拼接。匿名访问它得到 302，跳转到 `https://auth.seu.edu.cn/dist/` 的 SPA 登录路由，service 指向 `https://vpn.seu.edu.cn:443/passport/v1/auth/cas?sfDomain=CAS-auth`。

当前网络的本地 DNS 可以解析 `vpn.seu.edu.cn`、`ehall.seu.edu.cn`，不能解析 `cvs.seu.edu.cn`。这解释了此前课程门户无法访问的一部分原因；尚未验证该域名是否在账号的 VPN 资源授权列表中。

## 核心如何工作

1. `client/atrust/auth/request.go` 查询认证配置、公钥及会话参数。
2. `auth/login_method.go` 按 authType 分派登录。`auth/psw` 会消费 username/password；`auth/cas` 会使用 CAS ticket 或外部登录回调，不会自动拿 username/password 操作学校 CAS 页面。
3. `auth/cas.go` 接受 CAS 回调，把一次性 ticket 交给 VPN 的 `/passport/v1/auth/cas`，换取后续认证所需的票据；再完成客户端环境上报与服务器要求的附加认证。
4. `client/atrust/client.go` 初始化资源、节点及隧道，`main.go` 组合用户态网络栈、DNS 解析和代理服务。
5. `service/http.go` 提供 HTTP 与 HTTPS CONNECT 代理，`service/socks.go` 提供 SOCKS5；`dial/dialer.go` 根据服务端下发的域名/IP/端口资源选择隧道或直连。它不提供服务器未授权的资源权限。
6. `client/atrust/session.go` 定期刷新有效会话并保存新 Cookie。默认刷新间隔 1800 秒；临时刷新错误较快重试，明确的会话失效会退出进程，不会替用户自动重做交互登录。

CAS callback 必须在浏览器真正请求 VPN 回调之前截获并交给核心，不能先让浏览器消费 ticket 再重复提交。登录成功后仍需区分 VPN 会话与 eHall/CVS 业务登录 Cookie：有 VPN 通道不代表业务系统已经登录。

## 对截图中两个客户端的判断

- **EZ4Connect**：适合参考。官方文档明确支持 aTrust；架构包含核心进程、连接会话、重连、认证窗口与代理生命周期。可借鉴交互设计，让用户只在必要时处理验证码，而不是让用户手动复制 ticket。未本地验证其当前 CAS 实现。
- **hitsz-connect-verge**：已克隆到 `88d7e3e`。本地 `app/utils/connection_utils.py` 主要封装 server/username/password 和代理参数，没有看到对东大所需 aTrust CAS 流程的支持；项目已于 2026-05-15 归档，更适合参考基础界面与代理配置。

## 推荐的 SEUdaily 接入方式

采用独立 VPN 子进程和应用内代理，不先要求管理员权限，也不默认更改全系统网络。

```text
已有校园账号密码
  → 专用 CAS 登录页（必要时人工验证码）
  → 截获一次性回调并交给 zju-connect
  → aTrust 会话、资源策略和校园 DNS
  → 127.0.0.1 上的 HTTP/SOCKS 代理
  → 校园浏览器、业务接口、媒体下载
```

### 认证与生命周期

- 后端新增一个 VPN manager，拥有唯一子进程与状态：未连接、连接中、待验证、已连接、失效、失败。
- 使用现有 `SEUDAILY_USERNAME/SEUDAILY_PASSWORD` 填写 CAS 页面；密码不传给 Agent，不放进命令行参数或普通日志。
- CAS 登录用专用浏览器上下文、可信 VPN/认证服务地址。先取得该子进程要求的 login URL，再规范化相对 URL，截获回调并通过 stdin/内部接口交回子进程。
- 现成 CLI 会等待外部回调，短期可通过 stdin 对接；长期需要稳定结构化事件时，核心已经提供 `SetupOptions.ChallengeHandler` 注入点，可以包装成 JSON 事件，避免解析大量自然语言日志。
- 在权限受限的目录保存 client-data（核心新建文件使用 0600），与业务 Cookie 分开。设备信任绑定应由用户选择，不自动注册为可信设备。
- 保活、会话刷新成功后继续使用；明确失效进入待登录状态，验证码仍交给用户。Focus 等待授权，连通后只续接原任务，不无限循环尝试登录。
- 连接状态要求经代理向 CVS 完成证书校验并收到 HTTPS HEAD 的 200–499 响应；不会读取正文或自动跟随登录跳转。仅监听成功或 CONNECT 200 均不能判定可用；业务登录 Cookie 和各资源权限仍需分别处理。

### 流量与 DNS

| 当前调用位置 | 接入点 |
| --- | --- |
| `src/seudaily/browser_runtime.py`、`service.py`、`schedule.py`、`training_plan.py` | 给校园 Playwright browser/context 显式配置 HTTP 代理；代理改变时重建复用的上下文 |
| `src/seudaily/jwc.py` | 校园请求使用显式 urllib opener/ProxyHandler；公网可访问通知继续直连 |
| `src/seudaily/asr/cloud.py:extract_media` | 给远端校园媒体的 FFmpeg 输入显式配置 `-http_proxy`，覆盖真实媒体域名；云端转写 API 仍走原网络 |
| `src/runtime/tools/browser-tools.ts` | 如确实需要通用浏览器访问校园资源，向 Playwright MCP 配置显式加入代理；不能只改 Python 浏览器 |
| `src/seudaily/web_reader.py:validate_public_url` | 当前本地 DNS 校验和私网限制会提前拒绝校内网页；校园专用读取应使用受限可信目标和 VPN 解析，保留普通网页读取的私网限制 |

代理只监听 `127.0.0.1`。VPN 服务连接和 CAS 认证走底层网络，避免代理自己形成回环；模型、搜索、ASR 云服务和本地后端保持原路径。使用学校下发的 DNS/资源策略，不写死浙江大学的 DNS，不把旧 EasyConnect 示例里的 skip-domain-resource 等参数直接照搬到 aTrust。

HTTP CONNECT 可把目标域名交给代理侧解析，有助于访问本地无法解析的课程门户。不过在调用代理之前就执行本地 DNS 检查的代码仍需单独调整；不能认为设置一个 HTTP_PROXY 环境变量便能覆盖所有客户端。

### 核心启动参数

```bash
zju-connect -protocol atrust -server vpn.seu.edu.cn -port 443 \
  -auth-type auth/cas -login-domain CAS-auth \
  -disable-zju-config -remote-dns-server 202.119.24.12 \
  -socks-bind "" -http-bind 127.0.0.1:11081 \
  -client-data-file .seudaily/vpn/client-data.json
```

应用的 `vpn.py` 已提供目录权限、账号填写、CAS 回调适配和进程生命周期管理；单独运行上面的核心命令仍需要自行提供 CAS 回调。应用默认使用 11081 端口，用户修改后保存并在下次连接时使用。

## 实质限制与下一步验证

- 已真实验证校园账号认证成功以及核心初始化；各业务资源与媒体域名仍需分别验证，门户能登录不代表每个资源都能访问。
- 当前 `campus_network.py` 会把若干校园域名 DNS/连接失败归为“需要校园网环境”；这个提示不是服务端确认 VPN 必需。公网通知站断网也可能触发它，接入后需要保留可区分的诊断。
- 上游 `auth/auth.go` 和 `client/atrust/tls.go` 存在 `InsecureSkipVerify: true`。接入时需要确认并处理证书信任/校验，不能把它当成普通的安全 TLS 默认值；调试日志也可能含会话和签名 URL。
- zju-connect 是 AGPL-3.0，EZ4Connect 是 GPL-3.0。若复制、修改或随包分发，需要同时处理相应许可证与源代码交付要求；应用只在首次连接时下载官方固定版本的核心，Git 仓库未打包该二进制，未复制其他客户端的实现；文档保留许可证及上游源码链接。
- 本次按用户要求只验证连接和 HEAD 响应，不进行课程媒体下载。Focus 不自动连接 VPN；用户建立通道后可继续原任务。

## 来源

- [东南大学 VPN 升级通知](https://nic.seu.edu.cn/info/1011/1515.htm)
- [东南大学 VPN 服务指南](https://nic.seu.edu.cn/fwzn/w/VPNFW/VPNfwzn.htm)
- [zju-connect](https://github.com/Mythologyli/zju-connect)
- [所研究版本的 CAS 实现](https://github.com/Mythologyli/zju-connect/blob/923672dc927e43e04592595a0005ad90a7a3afb5/client/atrust/auth/cas.go)
- [EZ4Connect README](https://github.com/chenx-dust/EZ4Connect/blob/master/README.md)
- [EZ4Connect 架构](https://github.com/chenx-dust/EZ4Connect/blob/master/docs/ARCHITECTURE.md)
- [hitsz-connect-verge（已归档）](https://github.com/kowyo/hitsz-connect-verge)
- [FFmpeg HTTP/TLS 代理参数](https://ffmpeg.org/ffmpeg-protocols.html)

## 已实现的应用入口

- Web 设置页和资源面板提供连接、状态、断开和额外验证码提交；每 3 秒同步状态。
- Web 与终端支持 `/vpn connect`、`/vpn status`、`/vpn disconnect`；终端 `/vpn verify` 打开隐私输入框。
- Python 校园浏览器、课表、培养方案、通知/网页读取、远端校园 FFmpeg 输入，以及 Node Playwright MCP 浏览器配置都消费同一份 VPN 状态。代理变化后重建浏览器上下文。
- 普通账号密码登录优先使用 HTTP CAS，短信二次验证通过 HTTPS 发码与提交；图片验证码等其他交互场景保留专用 CAS 窗口。回调通过核心 stdin 交付；账号密码不作为 Agent 内容、命令行参数或普通日志保存。HTTP 登录直连公网认证入口，不依赖待建立的 VPN 代理；临时 Cookie 随认证结束清理。工作进程退出和断开会停止核心，状态文件检测拥有进程是否存活。
- macOS/NO_PROXY 的系统绕过规则会影响标准 urllib ProxyHandler，因此应用对已连接的校园代理显式发送请求；不依赖本机解析 CVS 域名。
- CAS 的 HTTP 重定向不能依赖 Playwright 对每一跳执行 route。适配器预读可信认证域的重定向，在请求 VPN 一次性 ticket 之前停止，再交给核心。v1.3.1 严格比较 host，回调统一移除默认 `:443`，与核心一致。

版本兼容核验：[v1.3.1 CAS 校验](https://github.com/Mythologyli/zju-connect/blob/v1.3.1/client/atrust/auth/cas.go)、[v1.3.1 默认端口处理](https://github.com/Mythologyli/zju-connect/blob/v1.3.1/client/atrust/client.go)。研究时读取的仓库主线实现与正式发布版本在这里存在差异。

## 本次验证与清理

真实验证使用已有账号完成 CAS；核心恢复已保存会话时也能进入初始化，服务端下发两台校园 DNS。对 eHall 的代理 CONNECT 返回过 HTTP 200；CVS 的代理 CONNECT 返回 HTTP 500，正文错误为 `lookup cvs.seu.edu.cn: no such host`。后续 HTTPS HEAD 没有确认成功，因此不能据此宣称课表或课程媒体已可下载。诊断没有写入校园账号、密码、ticket 或 Cookie。

测试采用 Python 回归、Node 路由/浏览器配置检查，以及隔离的 WebKit 页面验证连接、验证码提交、断开操作。未进行课程媒体下载或 ASR。首次官方核心归档下载量为 5,401,684 字节，其余流量为登录、配置、DNS 与连接检查。

研究用 zju-connect 和 hitsz-connect-verge 临时克隆及登录/界面调试脚本在工作完成后清理；运行所需的官方核心及受限权限的本地会话缓存保留在 Git 忽略目录 `.seudaily/vpn/`。

### 后续 IP 诊断与端口配置

用户提供 `10.208.100.167` 后，直接对代理发送该 IP 的 CONNECT（80/443）均得到明确错误：`resource requires L3 tunnel, but TCP-only mode is active`。这不涉及域名解析，说明此前强制 TCP-only 至少阻断了这类校园资源；现已移除该参数，恢复核心的 L3 能力。此前 `no such host` 不能单凭这一条错误归因为学校 DNS 不存在：还需区分远端 DNS 的查询能否经隧道传输，以及失败后是否落到备用解析。

HTTP 代理默认监听 `127.0.0.1:11081`，在面板显示完整地址。断开后可修改端口，再连接生效；`/vpn connect 12081` 同样支持，端口写入本地 settings.json。宿主机程序可以显式使用该代理；它没有修改系统路由，不会承载宿主机 ping 的 ICMP 流量。实测系统 ping 用户给定 IP 三次均超时，此结果不能直接判定 VPN 隧道内的 IP 不可达。

移除 TCP-only 后的真实重试：一次认证请求超时；另一次完成认证和 onlineInfo 请求后，核心在 `222.190.112.125:441` 的读取发生 i/o timeout，L3 初始化未完成。因此不能认定纯 IP 或 CVS 已可访问，也不能把所有失败归结为 DNS。端口配置与 UI 修改已验证；VPN 核心退出时该端口不会继续监听。


### L3 重试后的最终结果（2026-10-03 23:45–23:48）

已经在当前运行后端建立可用连接，状态为 connected，代理为 `http://127.0.0.1:11081`。没有切换分支、合并或发布 npm。

- 两条网关 `222.190.112.123:441`、`222.190.112.125:441` 的隧道认证及资源授权均返回成功。第一 DNS `58.192.112.11` 的授权成功，但本次未收到 DNS 数据回包；不能将此说成账号不能登录或学校域名不存在。
- 换成服务端下发的第二 DNS `202.119.24.12` 后，独立的小型 UDP 查询在 TLS 1.2、TLS 1.3 隧道中均收到 `0x94` 数据响应。应用核心随后能够解析并访问 CVS。
- 阅读上游 `resolve/resolver.go` 发现：主 DNS 经 VPN stack 查询，备用 DNS 却使用普通 `net.Dialer` 直连。因此主 DNS 不响应时，即使备用 DNS 配置为学校地址，原实现也不会确保查询经过 VPN。这解释了此前代理配置存在、校内域名仍失败的现象。
- 应用明确将 `202.119.24.12` 配置为 remote DNS，使其查询经过 L3。可用 `SEUDAILY_VPN_DNS_SERVER` 覆盖，不修改宿主机 DNS 或系统路由；这是基于本次真实验证选择的 SEU DNS，不是所有部署通用的固定地址。
- 固定发布核心采用 Go 1.26.6。根据 Go 官方文档，仅为核心子进程设置 `GODEBUG=tlsmlkem=0,tlssecpmlkem=0`，保留其他 GODEBUG 项；不修改整个应用的环境，不强制旧 TLS 版本。兼容参数启用后能够建立隧道，但没有做确定性的 A/B 实验，不能认定此前每次握手超时都由 ML-KEM 引起。
- 官方 2026-09-29 nightly 对照也出现相同的第一 DNS / 校内 IP 超时，没有替换应用固定版本。其大小及官方 SHA256 核验通过；临时源码、nightly 核心和诊断脚本已清理。

最终实际验证：

| 检查 | 结果 |
| --- | --- |
| 当前后端 `/app/vpn` | connected，课程门户响应检查通过 |
| 宿主机 curl 经 HTTP 代理，CVS HTTPS HEAD | HTTP 200 |
| CVS 通过校园 DNS 解析 | `10.64.86.180` |
| 代理直接 CONNECT `10.64.86.180:443`，使用 CVS SNI 和 Host 做 HTTPS HEAD | CONNECT 200，HEAD 200，证书校验通过 |
| eHall HTTPS HEAD | HTTP 301，跳转至其 `/new/index.html` |
| 用户提供的 `10.208.100.167` | 本次不是 CVS 的解析地址；此前 80/443 超时，没有确认该地址的业务可用性 |

以上只进行认证、配置、DNS、小型连接探测与 HEAD；没有下载课程媒体或读取门户响应正文。VPN 相关 Python 8 项、Node 7 项检查和 TypeScript 类型检查通过。连接检查已从 eHall CONNECT 改为实际 CVS HTTPS HEAD，避免仅凭代理端口和 CONNECT 成功就显示可用。

实现参考：[上游 DNS 查询路径](https://github.com/Mythologyli/zju-connect/blob/v1.3.1/resolve/resolver.go)、[Go 1.24 TLS 兼容说明](https://go.dev/doc/go1.24)、[Go 1.26 新增 TLS 混合密钥组](https://go.dev/doc/go1.26)。临时诊断中的会话参数仅在内存中使用，没有打印或持久化；保留的诊断记录仅含脱敏的阶段信息及门户解析地址。


## CAS 短信二次验证（2026-10-04）

对照学校公开脚本 `https://auth.seu.edu.cn/dist/umi.32c0b43a.js`：`casLogin` 返回业务 `code: 502` 表示账号短信二次验证；`POST /auth/casback/sendStage2Code` 的 JSON 为 `{userId: 一卡通账号}`。验证码通过 `getChiperKey` 的 RSA 公钥加密后放入 `casLogin.mobileVerifyCode`，密码同时重新加密。它不是手机号短信登录的 `createMobileVerifyCode`。

VPN 保留当前 CAS Cookie 和回调拦截，发布 `verification_required`，Web 在原面板输入，CLI 使用 `/vpn verify` 或独立 VPN 模式中的输入提示；`/vpn resend` 可重发校园短信。成功后仅把未消费的 ticket 回调交给核心。核心自身额外验证继续走 stdin。

课程、课表与培养方案共享同一 CAS 短信实现，前端通过 `POST /app/auth/sms`（`challengeId`、`operation: send|verify`、可选 `code`）完成验证，随后续接原授权/原任务。短信挑战只保存在工作进程内存，5 分钟后清理；发码间隔 60 秒。后端重启后必须重新登录。成功后的正常业务 Cookie 仍按原机制保存。

短信分支以学校源码和固定模拟测试验证（RSA 加密、错误码重试、过期、保留一次性 ticket）。当前实际账号登录未触发短信，因此未声称真实短信收发完成实测。普通 HTTP 登录及 VPN 连接继续进行真实回归；不下载课程媒体。

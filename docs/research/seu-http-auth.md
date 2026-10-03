# 东大 eHall HTTP 登录与会话恢复

2026-10-04。使用用户授权的已保存账号实测，不记录账号、密码、Cookie 或 ticket 值，不下载媒体。

## 已接入范围

课表和个人培养方案使用 `src/seudaily/campus_auth.py` 的短期 HTTP 客户端。Web 与 CLI 调用同一个 Python 实现，不另起 Playwright 驱动或浏览器。既有 Playwright Cookie 文件保持兼容；两项服务继续共享 `.seudaily/ehall-cookies.json`。

课程点播与通用网页操作仍依赖浏览器。VPN 的 CAS 回调截获也仍保持原实现，本次未调整。

## 认证流程

1. 访问 eHall 应用启动地址，跟随学校的正常重定向。登录页的 `service` 参数位于 URL fragment 路由中，需要从 `#/dist/main/login?service=...` 读取。
2. `POST https://auth.seu.edu.cn/auth/casback/verifyTgt` 检查已有 SSO 会话。有效时用返回地址换取该业务系统的会话，无需再次提交密码。
3. 无有效 SSO 时，先 `GET /auth/casback/needCaptcha`。网页以 `code=4000` 表示需验证码，此时不提交密码，交给人工登录。
4. `POST /auth/casback/getChiperKey` 获取 URL-safe Base64 编码的 DER RSA 公钥。按官方网页的密码处理方式执行 RSA PKCS#1 v1.5 加密，将普通 Base64 密文发送到 `POST /auth/casback/casLogin`，通过 HTTPS 传输；不自制加密或签名。
5. 普通密码登录返回的 `redirectUrl` 已经 URL 编码。按网页直接拼到 `/auth/casback/loginRedirect?redirectUrl=...`，重复编码会导致跳转失败。服务 ticket 正常交给目标系统验证。
6. eHall 大厅、课表和培养方案是不同 CAS service。先建立大厅会话，再用同一个 SSO 会话换取具体应用的 Cookie。普通流程只需一次密码提交。
7. 保留服务器下发的 Cookie 到期属性，HTTP 客户端自动管理 Cookie。业务查询遇到 HTTP 401/403、登录重定向或 HTML 登录页时，最多重新认证并重试一次；不反复提交密码。

认证失败、验证码、二次验证均返回前端现有的 `auth_required` 登录入口，并保留具体原因；不会绕过学校验证。普通同步没有浏览器交互，显式授权在 HTTP 无法完成时保留可见登录窗口。

## 实测结果

- 从空 Cookie 会话完成登录，课表学期接口返回合法 JSON；只提交一次密码，约 2 秒完成认证及首个接口请求。
- 完整课表服务同步返回 `fresh`，获取 25 条课程记录；完整培养方案服务返回 `completed`，获取 1 个方案、121 门课程。课表包含历年学期同步，总耗时约 15.6 秒；培养方案约 1.7 秒。
- 删除客户端全部 eHall 业务 Cookie、保留 SSO Cookie后，业务查询恢复成功，密码提交次数不增加。
- 删除客户端业务及 SSO Cookie 后，自动重新提交一次密码，业务查询恢复成功。
- 单元检查覆盖首次登录和应用 SSO、业务查询中途失效后的重认证及重试、需验证码时不提交密码。没有等待学校会话真实计时过期，约两小时的服务器有效期尚未独立核实；上述恢复验证通过移除客户端 Cookie 实现。

## 来源

学校公开登录页：<https://auth.seu.edu.cn/dist/>。本次分析对应公开脚本 `umi.32c0b43a.js`，脚本文件名可能随着学校更新变化。

本实现复现正常密码登录和 CAS 跳转，没有假设学校开放通用 CAS REST 密码接口，也没有把 VPN 登录态当作业务系统登录态。

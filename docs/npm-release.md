# GitHub 验收与 npm 发布

## 自动验收

`.github/workflows/distribution-ci.yml` 在 main push、PR 和手动触发时运行，也可由发布工作流复用。矩阵：Ubuntu 24.04、Windows Server 2025、macOS 15，分别验证 Node 22.22.0 + Python 3.11、Node 24.12.0 + Python 3.12、Node 24.12.0 + Python 3.13，共九组。Windows ConPTY 测试驱动单独固定 Python 3.13，不属于产品依赖；业务 Python 仍按矩阵版本测试。

每组执行锁文件安装、类型检查、生产构建、Node/Python 回归、纯打包安装与多界面生命周期验证。macOS/Linux 使用 POSIX PTY，Windows 使用 ConPTY；Windows 强制结束进程由租约超时回收。真实私有 Python 安装和平台默认浏览器访问本机 fixture，页面导航/点击/快照均做验收。不传校园账号、模型密钥，也不测试真实校园 VPN；验证码、短信和校园连通性仍需要本机验证。

每组保留 14 天的候选 `.tgz`、大小/integrity 清单和终端/浏览器验证 JSON，位于 Actions run 的 Artifacts。Actions 主步骤失败时不会进入发布流程；上传仅保留已生成的结果，不上传 `.env` 或用户目录。

## 发布候选

Actions → `npm release candidate` → Run workflow，选择 main，版本必须等于已提交的 `package.json`（当前 1.1.0），`publish` 默认 false。流程先跑完整矩阵，再构建并生成公开发布候选。不设置 npm 凭据也能完成这一步。

源代码根包和组件仍保持 private。`scripts/prepare-release.mjs` 在 `build/release/staging/` 复制文件白名单、移除主包开发依赖与脚本、设置公开清单，再打包；不会修改源码 package.json 或直接发布。默认包 `seudaily` 内置 CLI 与后端，不再发布 `seudaily-cli`。发布顺序为 Web、Python、浏览器，最后默认包；用户只安装默认包，可选组件由启动器自动安装。

## 需要维护者完成的 npm 配置

1. 本机 `npm whoami` 已确认账号 `miunerofrade`，邮箱已验证；2026-10-05 已确认 2FA 为 `auth-and-writes`，首次发布时维护者按 npm 提示完成验证；账号配置已就绪。不得向对话提供密码、验证码或 token。
2. 当前候选统一版本为 **1.1.0**；四个名称是 `seudaily`、`seudaily-web`、`seudaily-python`、`seudaily-browser`。2026-10-05 注册表均返回 404，但名称尚未取得所有权，发布前要再次核对。默认不改为带 scope 的名称。
3. **首次发布推荐使用已经登录的本机**，在明确授权并确认最新 CI/候选文件后，依次发布 `build/release/packages/` 中的三个可选组件和主包；通过 npm 的交互流程完成 2FA。首次本地发布不带 `--provenance`（来源证明由后续 GitHub 发布生成）。这一步不要求提前创建 GitHub npm token。候选生成和本次准备均不执行发布。
4. 包创建后，在四个包的 npm Settings → Trusted Publisher 配置 GitHub owner **miunerofrade**、repository **SEUdaily**、workflow filename **npm-release.yml**、environment **npm**，允许直接 `npm publish`。配置后 GitHub 使用 OIDC，不需要长期 token。官方说明：[Trusted Publisher](https://docs.npmjs.com/trusted-publishers/)。
5. 如果首次也必须由 GitHub 发布，则另需将具备这四个名称发布权限、能满足 2FA 策略的 npm granular token 保存为 GitHub **npm Environment Secret `NPM_TOKEN`**；不提交到仓库、不发进对话。后续配置 Trusted Publisher 后移除它。这是替代方案，不是本机首次发布的必备条件。
6. GitHub 的 npm environment 保留人工审核和 main 分支限制。后续明确要求发布时，才把 `publish` 选为 true，审批通过后才执行 npm publish。

版本在首次发布前可继续调整。工作流会先检查所有版本是否已存在，避免意外覆盖；如中途部分发布成功，先检查 registry 已发布版本再决定补发或统一新版本，不自动跳过已有包。跨系统矩阵通过也不意味着校园登录、短信、VPN 和所有设备上的图形交互已经实测。

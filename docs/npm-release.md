# GitHub 验收与 npm 发布

## 自动验收

`.github/workflows/distribution-ci.yml` 在 main push、PR 和手动触发时运行，也可由发布工作流复用。矩阵：Ubuntu 24.04、Windows Server 2025、macOS 15，分别验证 Node 22.22.0 + Python 3.11、Node 24.12.0 + Python 3.12、Node 24.12.0 + Python 3.13，共九组。Windows ConPTY 测试驱动单独固定 Python 3.13，不属于产品依赖；业务 Python 仍按矩阵版本测试。

每组执行锁文件安装、类型检查、生产构建、Node/Python 回归、纯打包安装与多界面生命周期验证。macOS/Linux 使用 POSIX PTY，Windows 使用 ConPTY；Windows 强制结束进程由租约超时回收。真实私有 Python 安装和平台默认浏览器访问本机 fixture，页面导航/点击/快照均做验收。不传校园账号、模型密钥，也不测试真实校园 VPN；验证码、短信和校园连通性仍需要本机验证。

每组保留 14 天的候选 `.tgz`、大小/integrity 清单和终端/浏览器验证 JSON，位于 Actions run 的 Artifacts。Actions 主步骤失败时不会进入发布流程；上传仅保留已生成的结果，不上传 `.env` 或用户目录。

## 发布候选

Actions → `npm release candidate` → Run workflow，选择 main，版本必须等于已提交的 `package.json`（当前 1.1.0），`publish` 默认 false。流程先跑完整矩阵，再构建并生成公开发布候选。不设置 npm 凭据也能完成这一步。

源代码根包和组件仍保持 private。`scripts/prepare-release.mjs` 在 `build/release/staging/` 复制文件白名单、移除主包开发依赖与脚本、设置公开清单，再打包；不会修改源码 package.json 或直接发布。发布顺序为 CLI、Web、Python、浏览器，最后基础包。

## 需要维护者完成的 npm 配置

1. npm 账号、已验证邮箱、2FA；取得 `seudaily`、`seudaily-cli`、`seudaily-web`、`seudaily-python`、`seudaily-browser` 五个包的发布权限。首次注册包名需要登录后的首次发布，不能把 registry 404 当作已经拥有包名。
2. 首次发布可将具备相应发布权限的 npm token 放入 GitHub 的 **npm Environment Secret `NPM_TOKEN`**；不要提交到仓库或发进对话。凭据和 2FA 方式以 npm 当前账号策略为准。
3. 包存在后，建议每个包设置 npm Trusted Publisher：GitHub owner `miunerofrade`，repository `SEUdaily`，workflow `npm-release.yml`，environment `npm`。工作流用 OIDC（npm >=11.5.1），随后可移除 NPM_TOKEN。官方说明：https://docs.npmjs.com/trusted-publishers/ 。
4. GitHub 的 npm environment 保留人工审核和 main 分支限制。只有明确要求发布时，才把 `publish` 选为 true；审批通过后才执行 npm publish。

版本在首次发布前可继续调整。工作流会先检查所有版本是否已存在，避免意外覆盖；如中途部分发布成功，先检查 registry 已发布版本再决定补发或统一新版本，不自动跳过已有包。跨系统矩阵通过也不意味着校园登录、短信、VPN 和所有设备上的图形交互已经实测。

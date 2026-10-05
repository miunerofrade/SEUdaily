# GitHub 验收与 npm 发布

## 自动验收

`.github/workflows/distribution-ci.yml` 在 main push、PR 和手动触发时运行，也可由发布工作流复用。矩阵：Ubuntu 24.04、Windows Server 2025、macOS 15，分别验证 Node 22.22.0 + Python 3.11、Node 24.12.0 + Python 3.12、Node 24.12.0 + Python 3.13，共九组。Windows ConPTY 测试驱动单独固定 Python 3.13，不属于产品依赖；业务 Python 仍按矩阵版本测试。

每组执行锁文件安装、类型检查、生产构建、Node/Python 回归、纯打包安装与多界面生命周期验证。macOS/Linux 使用 POSIX PTY，Windows 使用 ConPTY；Windows 强制结束进程由租约超时回收。真实私有 Python 安装和平台默认浏览器访问本机 fixture，页面导航/点击/快照均做验收。不传校园账号、模型密钥，也不测试真实校园 VPN；验证码、短信和校园连通性仍需要本机验证。

每组保留 14 天的候选 `.tgz`、大小/integrity 清单和终端/浏览器验证 JSON，位于 Actions run 的 Artifacts。Actions 主步骤失败时不会进入发布流程；上传仅保留已生成的结果，不上传 `.env` 或用户目录。

## 发布候选

Actions → `npm release candidate` → Run workflow，选择 main，版本必须等于已提交的 `package.json`（当前 1.1.1），`publish` 默认 false。流程先跑完整矩阵，再构建并生成公开发布候选。不设置 npm 凭据也能完成这一步。

源代码根包和组件仍保持 private。`scripts/prepare-release.mjs` 在 `build/release/staging/` 复制文件白名单、移除主包开发依赖与脚本、设置公开清单，再打包；不会修改源码 package.json 或直接发布。默认包 `seudaily` 内置 CLI 与后端，不再发布 `seudaily-cli`。发布顺序为 Web、Python、浏览器，最后默认包；用户只安装默认包，可选组件由启动器自动安装。

## npm 发布与 Trusted Publisher

2026-10-05 已发布统一版本 **1.1.1**：`seudaily`、`@miunerofrade/seudaily-web`、`@miunerofrade/seudaily-python`、`@miunerofrade/seudaily-browser`。主包使用公共名称，三个可选组件使用维护者个人 scope；注册表维护者与候选完整性均已核验。

四个包的 Trusted Publisher 统一绑定：

| 配置 | 值 |
| --- | --- |
| Provider | GitHub Actions |
| Repository | `miunerofrade/SEUdaily` |
| Workflow filename | `npm-release.yml` |
| Environment | `npm` |
| Allowed actions | `publish`、`stage publish` |

1.1.1 已通过 [GitHub 发布流程](https://github.com/miunerofrade/SEUdaily/actions/runs/37266910707) 完成九组矩阵验收和发布，四个包均已核对 registry 完整性与来源证明。发布工作流使用 OIDC 获取短期凭据，并生成来源证明；无需配置 `NPM_TOKEN`。GitHub 的 `npm` environment 仅允许 `main` 分支，审核人为 `miunerofrade`。

发布新版本：

1. 更新版本、提交并推送到 `main`。
2. Actions → `npm release candidate` → Run workflow，填写版本，勾选 `publish`。
3. 完整九组矩阵验收和候选构建通过后，批准 `npm` environment 部署。
4. 工作流依次发布三个可选组件和主包。

维护者可使用 npm 11.15+ 的 `npm trust list <包名>` 查看配置。重新配置时，使用已登录且开启 2FA 的 npm 账号执行：

```bash
npm trust github <包名> --repo miunerofrade/SEUdaily \
  --file npm-release.yml --env npm --allow-publish --yes
```

此命令配置发布权限，按 npm 提示在浏览器完成账号验证。官方说明：[Trusted Publisher](https://docs.npmjs.com/trusted-publishers/)。

1.1.1 已发布且不可覆盖，后续发布先统一更新四个包的版本。工作流会先检查所有版本是否已存在，避免意外覆盖；如中途部分发布成功，先检查 registry 已发布版本再决定补发或统一新版本，不自动跳过已有包。跨系统矩阵通过也不意味着校园登录、短信、VPN 和所有设备上的图形交互已经实测。

本次发布记录：[包名、版本与完整性](research/data/npm-release.json)。实际公开安装验收：[结果](research/data/npm-public-installation.json)。

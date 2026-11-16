# VaultFetch

[English](README.md)

通过 Obsidian SecretStorage 管理的凭据，从公开或私有 **GitHub Release** 安装并更新插件。

## 首版能力

- 安装前预览插件 ID、版本、兼容要求及发布说明。
- 通过 GitHub 附件 API 读取私有仓库的发布文件。
- 跟随最新正式版，或固定到指定标签。
- 手动检查更新；可在工作区就绪 15 秒后检查。
- 自动安装更新需要全局和逐来源同时开启，固定版本不自动更新。
- 更新保留目标插件的启用状态、`data.json` 和其他非代码文件；接管已有插件需要明确确认。
- 安装失败恢复代码备份，启动时恢复未完成的事务。

## 安装 VaultFetch

当前已按社区目录要求准备发布文件，**尚未在官方目录上架**。公开 GitHub 仓库不代表已经通过审核。

审核前，可从 [Release](https://github.com/Yukinoshita52/obsidian-vault-fetch/releases/latest) 下载 `main.js`、`manifest.json`、`styles.css`，放入仓库配置目录的 `plugins/vault-fetch/`，刷新已安装插件列表并启用。

审核通过后，可从「设置 → 第三方插件 → 浏览」安装。VaultFetch 自身使用 Obsidian 原生更新机制，不会自行安装或更新自身。

最低 Obsidian 版本为 **1.11.4**。代码不依赖 Node.js 或 Electron，并使用实际的配置目录。插件识别与热重载需要 Obsidian 内部管理接口；版本不具备这些能力时，会在写入代码前拒绝操作。

## 安装私有插件

1. 准备有目标仓库读取权限的 GitHub 凭据；细粒度 PAT 需要 `Contents: read`，具有相应权限的现有 OAuth 凭据也可使用。
2. 在 VaultFetch 设置中通过原生密钥选择器链接凭据；每个来源也可以单独选择密钥。
3. 点击「添加插件」，输入 `owner/repository` 或仓库 HTTPS 地址，预览发布版本。
4. 核对插件身份及兼容要求；若接管已有插件，明确确认后再安装。

Release 标签留空时跟随最新正式版；填写标签后固定版本。标签应与 manifest 版本一致，可带 `v` 前缀。

需要自动更新时，同时开启启动检查、全局自动应用更新和来源的自动更新。缺失的插件不会被后台自动重装，来源也不能悄悄更换插件 ID。「停止管理」只移除跟踪记录，保留插件和配置。

## 目标仓库的要求

Release 附件必须包含 `manifest.json`、`main.js`，可选 `styles.css`。不会复制仓库中的其他模块、资源或文件；多文件插件需要另行处理打包。

manifest 上限 64 KiB，JavaScript 上限 20 MiB，CSS 上限 2 MiB。安装前校验文件尺寸及 GitHub 提供的 SHA-256（若有）。摘要校验不代表发布者可信。草稿版本不安装；预发行版需明确指定标签。

## 隐私与恢复

凭据交由 Obsidian SecretStorage 保存，配置中只存密钥名称，不保存 token 原文，也不由本插件同步。网络只用于读取 GitHub 发布信息及附件；下载重定向由 Obsidian 网络层处理。没有遥测、笔记上传或客户端账号服务。

安装和更新会运行发布者的代码，请选择可信来源。事务目录位于 VaultFetch 自己的插件目录 `transactions/` 下，只备份及替换三个代码文件。无法安全恢复或已被外部改动的事务会保留备份并报错，不强行覆盖。

代码回滚无法撤销目标插件自行执行的数据迁移或其他操作，完整备份仍应独立维护。同一插件不要同时交由多个管理器更新。

## 开发与提交目录

```sh
npm ci --ignore-scripts
npm run check
npm run build
```

开发需要 Node.js 22+。发布标签与 manifest 版本完全一致，例如 `0.1.0`。工作流从标签对应源码构建并上传三个独立附件，运行依赖及许可声明打包到 `main.js`。

### 审核修复与补丁发布

**在同一个修复分支反复预审，通过后再发布一个补丁版本。**

1. 本轮修复使用同一个 `feat/*` 分支和一个尚未发布的补丁版本号，保持 `manifest.json`、`package.json`、`package-lock.json` 与 `versions.json` 一致。
2. 运行 `npm run check` 和 `npm run build`，提交并推送分支。在 Community 管理页选择 **Review branch**，输入分支名或提交 SHA，点击 **Run preview scan**。
3. 预审发现错误时，继续在同一分支修复、提交、推送并重新预审。以最新提交没有 **Error** 为发布门槛；处理 Warning、Recommendation，或记录保留原因。每次预审失败不单独递增版本或创建 Release。
4. 合入主分支后，确认实际将要打标签的提交 SHA 已通过预审；合并或后续修改产生新提交时，对新 SHA 再次预审。通过后才创建版本标签，发布这一个补丁版本。
5. 发布后核对正式 Release 的附件、来源证明和市场审核结果；分支预审通过不等于正式版本已经上架。

仅更新文档不递增插件版本或创建 Release。预审入口详见 [官方管理指南](https://docs.obsidian.md/community-directory/manage-entry)。

正式目录申请通过 [Obsidian Community](https://community.obsidian.md) 提交，需发布者连接 Obsidian 与 GitHub 账号并完成审核。详见 [官方提交指南](https://docs.obsidian.md/plugins/releasing/submit-plugin)。

## 许可

MIT。

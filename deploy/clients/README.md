# 双端客户端分发

状态：规划

| 平台 | 形态 | 一期范围 | 当前 |
|---|---|---|---|
| Windows x64 | 自建 Electron 桌面壳 NSIS 安装包（`heluo-forge-enterprise-<version>-setup-x64.exe`），内嵌锁定版 dsh 运行时与随包企业资产 | 约 400 人 | CI 已产草稿包；未签名、未做 VM 与企业终端实机验收 |
| macOS arm64 / x64 | 同源桌面壳 `.zip` / `.dmg`（未签名、未公证） | 按需交付 | `arm64` CI 已产草稿包；`x64` 与双架构安装待验收 |
| 银河麒麟 aarch64 / x86_64 | 同源桌面壳 `.deb`（含 `systemd --user` 单元）；若 Electron 兼容性探针受阻则回退 `dsh --profile web` + 浏览器方案 | 约 400 台 | 未构建、未实机验证 |

## Web 浏览器

Web 端建议使用支持 `AbortSignal.any()` 的新版 Chrome 或 Chromium；Chrome 的系统和处理器要求以[官方说明](https://support.google.com/chrome/answer/95346)为准。该接口从 [Chrome 116](https://developer.chrome.com/blog/chrome-116-beta) 开始提供，但接口可用不代表所有功能均已完成兼容性验收。

银河麒麟 V10 SP1 aarch64 虚拟机使用 DSH `0.2.1-rc.3` 和 Chromium `128.0.6613.119` 时，已验证 Web 页面和工作区目录列表可打开。该环境中的奇安信可信浏览器 `1.0.46402.2` 打开工作区目录时出现 `AbortSignal.any is not a function`；可改用上述浏览器。Chrome、其他版本及企业目标终端仍需各自验证。

## 计划资产

| 资产 | 用途 | 状态 |
|---|---|---|
| Windows NSIS 安装包与静默安装参数 | 自助安装与无交互安装 | CI 已产草稿包；VM 与实机未验 |
| macOS arm64 / x64 安装包与首开引导 | 自助安装（Gatekeeper 未签名绕过指引） | `arm64` CI 已产草稿包；`x64` 与实机未验 |
| 麒麟 deb/apt 包与 `systemd --user` 单元 | Electron 桌面端安装与开机自启（或 web deb 兜底） | 待构建、未实机验证 |
| 随包企业资产目录（`enterprise-assets/`） | 首启自动装载 `@heluo/forge-enterprise` 与凭据入库 | 已随统一构建产出 |
| 升级与回退语义 | 异版本先卸载再安装并保留用户数据 | 见下文参数与配置；实机未验 |

## Windows NSIS 静默安装与升级参数

Windows 安装包基于 electron-builder NSIS（`oneClick: true`、`perMachine: false`、`deleteAppDataOnUninstall: false`）：

| 参数 | 作用 | 说明 |
|---|---|---|
| `/S` | 静默安装 / 静默卸载 | 无界面完成安装或卸载；需在 Windows VM 实测确认 |
| `/D=<绝对路径>` | 指定安装目录 | NSIS 标准约定：必须放在命令行最后、不加引号、且仅作用于用户级可写目录 |
| 升级 / 回退语义 | 异版本先卸载再安装 | 安装目录随版本更新，`%APPDATA%` 与 `$DSH_HOME` 下的 `first-run.json`、日志及凭据库保留（`deleteAppDataOnUninstall: false`） |

> 注：企业无统一 MDM，本节仅面向自助安装与本地排障参考，不随包分发批量推送脚本；上述静默参数待离线 Win10 x64 虚拟机实测取证。

## 边界

- 全平台桌面客户端共用自有 Electron 壳（`services/forge-desktop/`），仅加载本机 `dsh --profile web`（仅监听 `127.0.0.1`），不修改或重编译上游 `apps/desktop`；桌面壳仅消费随包内嵌或同目录自动探测到的 `enterprise-assets/`。
- 自有壳不签名、不公证、不建自动更新 feed；SmartScreen 与 Gatekeeper 未签名首开路径按目标环境实测记录。
- 两端凭据与执行隔离须实机验证，配置文本不能证明隔离有效。

## IAM 安装准入

目标企业私版配置机密客户端与 PKCE S256。打包人员确认授权码换票和刷新使用 IAM 登记的同一种客户端认证方法。终端管理员在首次登录前向 Host 使用的凭据库预置密钥，私版配置仅携带非秘密引用。见[管理员预置与轮换](../../packages/forge-iam/docs/credential-access.md#9-管理员预置与轮换-iam-客户端密钥)。

Windows 与麒麟分别安装实际交付制品。新登录后验证计划续期日志出现 `refresh-committed` 且会话保持 `ready`。当前登记与两端闭环均待实测。见[双端验收矩阵](../../docs/plans/2026-11-04-iam-dual-platform-acceptance.md)。

# 双端客户端分发

状态：规划

| 平台 | 形态 | 一期范围 | 当前 |
|---|---|---|---|
| Windows | 桌面应用，MSI 预置企业组合包 | 约 400 人 | 未构建、未签名、未验证 |
| 银河麒麟 aarch64 | `dsh --profile web` + 浏览器，仅绑定 `127.0.0.1` | 约 400 台 | 未构建、未实机验证 |

## Web 浏览器

Web 端建议使用支持 `AbortSignal.any()` 的新版 Chrome 或 Chromium；Chrome 的系统和处理器要求以[官方说明](https://support.google.com/chrome/answer/95346)为准。该接口从 [Chrome 116](https://developer.chrome.com/blog/chrome-116-beta) 开始提供，但接口可用不代表所有功能均已完成兼容性验收。

银河麒麟 V10 SP1 aarch64 虚拟机使用 DSH `0.2.1-rc.3` 和 Chromium `128.0.6613.119` 时，已验证 Web 页面和工作区目录列表可打开。该环境中的奇安信可信浏览器 `1.0.46402.2` 打开工作区目录时出现 `AbortSignal.any is not a function`；可改用上述浏览器。Chrome、其他版本及企业目标终端仍需各自验证。

## 计划资产

| 资产 | 用途 | 状态 |
|---|---|---|
| Windows 安装包与静默安装参数 | 自助安装与 MDM 推送 | 待构建 |
| 麒麟 deb/apt 包与 `systemd --user` 单元 | 安装、开机启动、`dsh-web-open` 启动脚本 | 待构建 |
| 企业组合包与默认配置 | 预置 `@heluo/forge-enterprise` 与私有源 | 待构建 |
| 升级与回退脚本 | 版本切换与失败回退 | 待构建 |

## 边界

- 不构建 Linux 桌面客户端；麒麟使用本机 Web，仅监听回环地址。
- 安装包与配置不得内置用户凭据或共享密钥。
- 签名、公证、MDM 与软件源由 IT 确认，仓库只保存可审查的构建与配置输入。
- 两端凭据与执行隔离须实机验证，配置文本不能证明隔离有效。

## IAM 安装准入

目标企业私版配置机密客户端与 PKCE S256。打包人员确认授权码换票和刷新使用 IAM 登记的同一种客户端认证方法。终端管理员在首次登录前向 Host 使用的凭据库预置密钥，私版配置仅携带非秘密引用。见[管理员预置与轮换](../../packages/forge-iam/docs/credential-access.md#9-管理员预置与轮换-iam-客户端密钥)。

Windows 与麒麟分别安装实际交付制品。新登录后验证计划续期日志出现 `refresh-committed` 且会话保持 `ready`。当前登记与两端闭环均待实测。见[双端验收矩阵](../../docs/plans/2026-11-04-iam-dual-platform-acceptance.md)。

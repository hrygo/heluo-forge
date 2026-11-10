---
name: heluo-forge-release-bundle
description: 在 macOS 上由已核验的公版制品生成企业私版插件包，并装配/核验六类目标的完整 DSH 安装包；真实企业配置只从仓库外的 .env 读取，任何密钥都不得进入日志、报告或 argv。
---
# 企业私版发布包与完整安装包

## 何时使用

用户明确要求制作企业私版插件包、装配完整 DSH 安装包或核验已有安装包，并且已经拿到公版制品与独立可信的摘要时使用。

不适用：日常开发构建、公开发布、把企业制品上传公共 CI，以及未获授权的公证。

## 前置条件

- 公版 `.tgz` 已下载，摘要来自发布页或另一条可信渠道，而不是制品同目录的清单文件。
- 企业 `.env` 位于仓库之外，字段已填齐，文件权限仅当前用户可读。
- 输出目录位于仓库之外且尚不存在，磁盘空间足够容纳六类目标。
- 本机具备组装与核验工具链所需的 Node 版本和归档工具。

## 不可让步的边界

- 真实企业配置只从仓库外的 `.env` 读取；不写入仓库、聊天记录、报告或命令行参数。
- 公版与私版摘要都必须先确认；摘要不一致时停止，不重试，也不猜测替代文件。
- 禁止对包内文件做全局文本替换；只允许工具明确声明的少数配置位置。
- 密钥、令牌与配置值不得进入日志、报告或 argv；可以出现的只有配置键名与脱敏结论。
- 缺少必需字段、摘要不匹配、输出目录已存在或用户取消时，一律安全失败，不留下半成品。
- 企业制品不得上传公共 CI，也不得在未获授权时提交公证。

## 命令顺序

在仓库根目录执行，尖括号参数替换为实际值：

```sh
node scripts/make-private-bundle.mjs --public <public.tgz> --public-sha256 <hex> --config <enterprise.env> --version <x.y.z> --output <dir> [--confirm <12hex>]
node scripts/assemble-full-installer.mjs --inputs <installer-inputs.json> --private <private.tgz> --private-sha256 <hex> --output <dir> [--confirm <12hex>]
node scripts/verify-full-installer.mjs --installer <dir> [--json]
```

每步先读脱敏结论再进入下一步；`--confirm` 只接受本次工具回显的摘要前缀，不复用上一次确认。

## 按需材料

- [references/sop.md](references/sop.md) — 预检、确认流程、允许输出的脱敏信息、失败处理与应保留的证据。
- [references/installer-inputs.md](references/installer-inputs.md) — 六类目标的 `installer-inputs.json` 结构与缺项时的失败行为。

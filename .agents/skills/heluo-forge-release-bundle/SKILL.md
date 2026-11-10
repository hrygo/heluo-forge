---
name: heluo-forge-release-bundle
description: 在 macOS 上由已核验的公版制品生成企业私版插件包，并用初始化脚本在员工官方 DSH 上完成安装与核验；真实企业配置只从仓库外的 .env 读取，任何密钥都不得进入日志、报告或 argv。
---
# 企业私版发布包与员工端初始化

## 何时使用

用户明确要求制作企业私版插件包、生成员工端初始化步骤或在员工机初始化企业插件，并且已经拿到公版制品与独立可信的摘要时使用。

不适用：日常开发构建、公开发布、把企业制品上传公共 CI，以及未获授权的公证。

## 前置条件

- 公版 `.tgz` 已下载，摘要来自发布页或另一条可信渠道，而不是制品同目录的清单文件。
- 企业 `.env` 位于仓库之外，字段已填齐，文件权限仅当前用户可读。
- 输出目录位于仓库之外且尚不存在，磁盘空间足够容纳私版制品。
- 员工机已从官方渠道安装 DSH，且目标 profile 已由官方宿主完成初始化（`desktop` 需先启动一次 Desktop 并完全退出）。
- 本机具备制作与初始化工具链所需的 Node 版本和归档工具。

## 不可让步的边界

- 真实企业配置只从仓库外的 `.env` 读取；不写入仓库、聊天记录、报告或命令行参数。
- 公版与私版摘要都必须先确认；摘要不一致时停止，不重试，也不猜测替代文件。
- 禁止对包内文件做全局文本替换；只允许工具明确声明的少数配置位置。
- 密钥、令牌与配置值不得进入日志、报告或 argv；可以出现的只有配置键名与脱敏结论。
- 缺少必需字段、摘要不匹配、输出目录已存在或用户取消时，一律安全失败，不留下半成品。
- 企业交付物是私版 `.tgz` + `private-release.json` + `scripts/init-enterprise-plugin.mjs`，不含自制的宿主安装包；宿主由员工从官方渠道安装。
- 员工端唯一写入面是 `dsh plugin --profile <p> add <tgz>`；初始化脚本不创建 profile、不启动或重启宿主、不直接编辑 profile 文件。
- 运行期是否真正挂载只能在宿主「设置 → 插件」确认；初始化脚本只报 `mounted=unknown`，不得把它写成挂载证据。

## 命令顺序

在仓库根目录执行，尖括号参数替换为实际值：

```sh
node scripts/make-private-bundle.mjs --public <public.tgz> --public-sha256 <hex> --config <enterprise.env> --version <x.y.z> --output <dir> [--confirm <12hex>]
node scripts/init-enterprise-plugin.mjs --release <dir> --profile <desktop|web> [--sha256 <hex>] [--dsh <path>] [--dry-run] [--json]
```

第一步先读脱敏结论再进入下一步；`--confirm` 只接受本次工具回显的摘要前缀，不复用上一次确认。第二步在员工机执行：`--dry-run` 先看将执行的命令与核验点，`--sha256` 提供独立摘要口径，缺省才用 `private-release.json` 的自证摘要。已装同版本时脚本零写入，异版本时停止并给出升级或回退命令。

## 按需材料

- [references/sop.md](references/sop.md) — 预检、确认流程、初始化步骤、允许输出的脱敏信息、失败处理与应保留的证据。

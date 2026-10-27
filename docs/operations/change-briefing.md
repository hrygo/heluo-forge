# 变更只读简报：试用与测试输入

## 文档信息

| 项 | 内容 |
|---|---|
| 文档编号 | CORP-DSH-OPS-001 |
| 文档名称 | 变更只读简报：试用与测试输入 |
| 版本 | V0.1.0 |
| 文档状态 | 草案 |
| 密级 | — |
| 编制 | 平台组（代拟） |
| 审核 | 待定 |
| 批准 | 待定 |
| 最后更新 | 2026-10-27 |
| 门禁 | 本地试用；不代表企业准入 |

> 编制依据：2026-10-27 用户确认 `oh-my-sdd` 中 CLI 用法已在企业实测；对照提交 `3b95d536230fde36f867b3b1917d6569ae0d918c` 的显式 `dop change view <ID> -j`、子系统和故事内排期字段。本方自行搭建无网络仿 CLI，以真实子进程验证，不重新索取已确认的 CLI 使用方案。真实测试终端往返仍单独记账。
>
> 关联文档：[DevOps 设计](../design/plugins/forge-devops.md)、[工程工具契约](../contracts/engineering-tools.md)、[模块与验证状态](../design/README.md)、[文档清单](../DOCUMENT-REGISTER.md)。

## 1. 你现在拿到什么

一个**可运行的端到端只读入口**，而不只是测试列表。输入显式变更号，得到需求正文、独立验收项、子系统、故事和排期；可在终端查看，也可打开离线 HTML。示例为“图书借阅 · 到期提醒”，全部使用合成数据。

该入口是用户直接执行的诊断 CLI，复用 policy 的判定/必要审计核心，不声称已接入当前 DSH profile 的 IAM、角色与组织开关。写能力保持关闭，不自动建单、done、合并、触发 CI 或上报遥测。

## 2. 立即试用（不需要企业环境）

在仓库根目录：

```sh
pnpm install --offline --ignore-scripts
pnpm demo:change
# 可选：生成一个新 HTML 文件；已存在时拒绝覆盖
node packages/forge-devops/src/change-cli.mjs demo --out ./change-demo.html
```

发行物已内含运行时代码与 policy 依赖。没有源码也可以：把 `@heluo/forge-devops` 自包含 tarball 解压到一个新目录，运行下面的 Node 入口。不需要联网安装，也不用把包安装进真实 DSH profile：

```sh
# 把提供的 tarball 解压后，其中根目录为 package/
node package/src/change-cli.mjs demo
node package/src/change-cli.mjs demo --out ./change-demo.html
```

本地故障演示同样可直接跑，均应退出 1，且没有业务写入：

```sh
node package/src/change-cli.mjs demo --scenario denied
node package/src/change-cli.mjs demo --scenario malformed
node package/src/change-cli.mjs demo --scenario timeout
```

正常演示退出 0 表示“只读简报已生成”，**不是业务验收通过**。JSON 的 `status: unknown` 与 `engineeringReady: false` 有意保留：已知源契约没有可核定的需求版本与仓库映射，读到内容也不能伪造冻结依据。

## 3. 只需你提供的输入

**先回前两项就够**，其余到对应阶段再提供。我会自行完成 mock/本地环境、故障注入、自动化回归和制品验证，不要求你搭这些环境。

| 阶段 | 请你提供或协调 | 为什么无法由本地 mock 替代 |
|---|---|---|
| 当前只读接入 | 一个允许查询的测试变更号；对应测试仓库的显式映射。若 DOP 没有仓库/需求版本字段，只说明其权威来源即可；不要编造字段 | 无法从变更号前缀猜仓库，也无法从正文哈希冒充平台版本 |
| 当前只读接入 | 能运行现有企业 `dop` 的测试终端，或你在其上运行 §4 后返回脱敏退出码/结果；CLI 原生产物路径与实际版本 | 项目源码证明用法，不自动提供可运行的企业 CLI 或内网连通性。**不需重写使用方案** |
| Gitee 读取切片 | 指向 `oh-my-sdd` 中企业 Gitee 实测用法的确切位置，或提供一组脱敏“命令 + 字段”；任选已知仓库/Issue/PR | 已找到的 `gh` 用法描述 GitHub，不能据此猜 Gitee 主机/参数/身份路由 |
| 双端验收 | Windows 与麒麟 aarch64 测试机，或愿意按测试包执行并返回结果的人员 | 能本地验证协议和失败路径，不能用操作系统参数 mock 冒充真机执行 |
| 受控写阶段 | 你决定优先交付哪一个动作（澄清、进展、Issue/PR 维护择一），并协调有权责任方确认 C3 分类、测试对象、服务端权限及必要审计落点/保留期 | mock 可验拒绝与并发，不构成组织批准；你无需一次批准所有写能力 |
| 身份/模型/观察接入阶段 | 对应测试应用/租户、已配置的测试账户/模型，以及正式测试摄取服务；网关 A/B 路线由有权方确认 | 我负责 mock OIDC/模型/摄取端；真实回跳、当前人员/用途、模型授权和正式摄取回查仍须真实应用证明 |

建议回复模板（允许分批）：

```text
测试变更号：<显式 ID>
对应仓库：<提供方 + owner/repository>
需求版本依据：<字段 / 版本化文档 / 目前没有>
CLI 测试方式：<你可连接的测试终端 / 我来执行测试包并回传脱敏结果>
CLI 实际版本与原生可执行文件：<不含任何 token>
Gitee 已验证用法位置：<现有项目路径，若暂未安排可留空>
```

**不要在聊天、公开 PR 或报告附件里发密码/token/个人数据/内网地址。** 测试账号在终端经既有 CLI 登录即可；没有认证时本入口只会报 `AUTH_FAILED`，不会替你登录或换服务账号。

## 4. 已有企业终端上的显式只读试跑

先由你使用既有方式完成企业 CLI 登录；本入口不调用登录。只替换占位的 ID、绝对 CLI 路径和你批准的本地输出路径：

```sh
node package/src/change-cli.mjs view DEMO100001 \
  --cli /approved/path/dop \
  --audit-file ./new-read-audit.jsonl \
  --out ./new-change-report.html
```

Windows 使用 `dop.exe` 的绝对路径；当前不接受 `.cmd/.bat`，不静默走 Shell。原生产物不存在时，不要求你为本项目临时造一个命令别名。

- 仅执行 `dop change view <ID> -j`，不扫描全量变更。
- 超时、非 JSON、权限拒绝、目标不符、输出超限均终止；不自动重试。
- 审计文件和报告必须是新文件；拒绝覆盖已有文件。查询失败可能留下空报告文件（不伪装成完整 HTML），保留审计失败结论便于诊断，重新执行使用新路径。
- 审计只含最小动作/结果字段，不含需求正文、CLI stdout/stderr 或凭据；文件采用独占创建、`0600` 和 fsync。Windows 的实际 ACL 仍须终端验证。
- 这个本地审计文件不自动成为组织正式落点；HTML 是用户显式选择导出的业务内容，仅保存在获准目录。
- 不继承整个工具/网关环境，不传 token 参数；现有 CLI 自行消费本机登录状态。如原 CLI 只能用特殊环境变量，本轮不会猜变量名或自动转存凭据。

## 5. 本地验收与实际边界

```sh
node --test packages/forge-devops/test/*.test.mjs
node --test tests/bundle-build.test.mjs
pnpm check
```

本方可独立验收的能力：命令固定和参数拒绝、真实子进程正反向、字段/目标严格校验、故事内排期提取、必要审计零调用屏障、正文 HTML 转义、报告拒绝覆盖、自包含最终 tarball 离线运行。

未由本地模拟替代：企业系统本次往返、两端原生 CLI、真实仓库/需求版本映射、Gitee 来源事实、企业身份/角色/审批与正式审计保留。以上是下一阶段接入点，不阻止现在打开演示或运行测试包。

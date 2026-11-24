# 专家智能体（`@heluo/forge-experts`）实现与验证记录

设计规格与验收判据见 [Forge 专家智能体管理插件详细设计](../plugins/forge-experts.md)（`CORP-DSH-DESIGN-023`）与 [Delegra 专家智能体员工访问与受限受理契约](../../contracts/delegra-expert-access.md)（`CORP-DSH-EXPERT-001`）。本页汇总当前已落地的离线单测、独立制品闭包、宿主预检与安装回读证据，并对缺乏目标 DSH `0.2.1-rc.3` 实机发行物与真实企业 Delegra 联调环境的验收项如实标记为 `BLOCKED` / `NOT RUN`；在实机与企业联调闭环前，本页不替代生产准入（追踪见 [heluo-forge#243](https://github.com/hrygo/heluo-forge/issues/243)、[#244](https://github.com/hrygo/heluo-forge/issues/244)、[#245](https://github.com/hrygo/heluo-forge/issues/245)、[#246](https://github.com/hrygo/heluo-forge/issues/246)、[#247](https://github.com/hrygo/heluo-forge/issues/247)）。

## 固定代码基线

核验日期为 2026-11-24。

- **Heluo Forge 主干（`hrygo/heluo-forge:main`）**：已合入 `#423`（宿主预检探针 `scripts/probe/run-forge-experts-host-preflight.mjs`）、`#424`（`CORP-DSH-EXPERT-001` 契约）、`#425`（`@heluo/forge-experts` 独立管理包 Stage 3A-1/3A-2）、`#426`（`@heluo/forge-iam` RFC 8693 受众换票与单次不透明句柄）及 `#446`（`@heluo/forge-experts` 阶段 C1 Delegra 连接器与离线 Contract Harness）。在途 PR `#450`（阶段 C2 可信选择绑定、Forge Policy 外发门禁与 `#247` 请求关联持久化）与 `#451`（`#426` 换票安全加固）待审批合入。
- **Delegra 后端（`hrygo/Delegra:deploy`）**：已合入 `#91`（阶段 B 受限员工 API `/api/v1/employee/experts*` 与 `/api/v1/employee/expert-tasks*` 骨架及 Vitest 路由测试，合并提交 `9dc5649b`）；生产化后端缺口已拆分为 4 项协同 Issue 跟踪：[Delegra#99](https://github.com/hrygo/Delegra/issues/99)（RFC 8693 换票端点与真实 JWT 验签）、[Delegra#98](https://github.com/hrygo/Delegra/issues/98)（PostgreSQL 单一事务持久化与真实目录/队列接线）、[Delegra#97](https://github.com/hrygo/Delegra/issues/97)（通用列表/运行历史/WebSocket 私有 ACL 全路径过滤）与 [Delegra#96](https://github.com/hrygo/Delegra/issues/96)（跨会话 Runner 上下文隔离与只读 `reuseRefs`）。

## 已落地离线与合成环境验证证据

| 验收面（对应设计 §5.2） | 复跑命令与覆盖范围 | 已验证结果 | 当前状态 |
| --- | --- | --- | --- |
| 管理包单测、P1–P9 架构守卫与变异证明 | `node --test packages/forge-experts/test/*.test.mjs` | 目录/可调用视图分离、默认未启用、`editToken` 并发与撤权重授重置、未知写入结果 fail-closed 降级、隔离 `@` 候选三方交集与 `A → B → A` 版本递增、P1–P9 结构守卫与变异证明全部通过 | 离线单测 PASS |
| Delegra 员工契约连接器与 RFC 8693 换票 | `packages/forge-experts/test/delegra-client.test.mjs`、`packages/forge-iam/test/service-token-exchange.test.mjs` | 单次不透明凭据句柄零明文泄露、`scope` 信封复核、3xx 重定向拒绝、分页超限 fail-closed、幂等重放与 `409` 摘要冲突、传输未知态 `by-request` 对账及 `apply()` 装配接线均已通过 | 离线单测 PASS |
| 独立制品构建、离线安装、重启回读与未知格式保全 | `node --test packages/forge-experts/test/host-install.test.mjs` | 通过 `scripts/build-enterprise-bundle.mjs --entry @heluo/forge-experts` 构建独立 tarball，在隔离目录离线安装并通过 `auditReleaseClosure` 闭包审计；验证启用偏好经卸载重装与重启后完整回读，以及 `schemaVersion: 99` 未知格式文件 fail-closed 且原字节零改动 | 合成宿主 PASS |
| 建包前宿主预检探针（离线闭包与 Client 槽位） | `FORGE_EXPERTS_TARGET=web node scripts/probe/run-forge-experts-host-preflight.mjs` | 2026-11-24 本机执行结果：`PASS=5`（`target-selection`、`build-standalone-tarball`、`offline-tarball-install`、`client-bundle-slot-and-trigger-contract`、`repository-working-tree-untouched`）、`FAIL=0`、`BLOCKED=1`（`dsh-cli-available` 缺本机 `dsh` CLI）、`NOT_RUN=4`（目标 profile 配置导出与真实 Cordis 运行时激活） | 部分 PASS（缺 `dsh` 阻断项见下表） |

## 实机与企业联调阻断项（BLOCKED / NOT RUN）

以下验收项依赖目标 DSH `0.2.1-rc.3` 发行物、真实企业 IAM 或 Delegra 阶段 B2 后端生产化落地，当前环境不具备条件，全部如实标记为 `BLOCKED` / `NOT RUN`：

| 验收项 | 依赖条件与跟踪项 | 当前状态 | 解除阻断判据 |
| --- | --- | --- | --- |
| 目标 DSH `0.2.1-rc.3` 发行物装入、原生设置页、两窗口并发与已开 `@` 菜单失效 | 目标终端可执行的 `DSH_BIN`（Web）或 `DSH_APP`（Desktop `0.2.1-rc.3`）；跟踪 [#246](https://github.com/hrygo/heluo-forge/issues/246) | `BLOCKED` | 以目标版本运行 `run-forge-experts-host-preflight.mjs` 与 `host-install.test.mjs` 全项 `PASS`（含 `target-version-pin`、`host-storage-domain-restart-readback`）并完成原生设置页与双窗口实机复核 |
| DSH 原生聊天 `@` 点选、实际提交绑定、模型未调用兜底与草稿恢复 | 目标 DSH `0.2.1-rc.3` 原生输入/执行入口接缝与 `#450` 合入后主助手工具接线；跟踪 [#245](https://github.com/hrygo/heluo-forge/issues/245) | `NOT RUN` | 验证普通文字、粘贴/重放、失效引用、停用与出站双顺序及拒绝后草稿与后续输入保留 |
| 企业 IAM RFC 8693 换票端点、四角色授权矩阵与撤权收敛实测 | [Delegra#99](https://github.com/hrygo/Delegra/issues/99)、[Delegra#98](https://github.com/hrygo/Delegra/issues/98) 与真实企业测试组织；跟踪 [#244](https://github.com/hrygo/heluo-forge/issues/244) | `BLOCKED` | 冻结 `CORP-DSH-EXPERT-001 §9.3` 换票端点/`audience`/`resource`/声明集，通过发起员工、仅查看权、同组织同事、跨组织账号四角色矩阵及 `<= 5 min` 撤权收敛实测 |
| PostgreSQL 原子受理故障注入、通用运行列表私有 ACL 与跨会话 Runner 隔离 | [Delegra#98](https://github.com/hrygo/Delegra/issues/98)、[Delegra#97](https://github.com/hrygo/Delegra/issues/97)、[Delegra#96](https://github.com/hrygo/Delegra/issues/96)；跟踪 [#244](https://github.com/hrygo/heluo-forge/issues/244)、[#247](https://github.com/hrygo/heluo-forge/issues/247) | `BLOCKED` | 实测事务回滚零任务、丢回执 `by-request` 对账、通用列表与 `heartbeat-runs`/`live-runs` 对同组织未获权同事零脱敏条目泄漏，以及双 DSH 会话调同一专家零上下文串扰 |

## 解除阻断与准入条件

在目标 DSH `0.2.1-rc.3` 发行物与已完成 `Delegra#96`–`#99` 的企业测试环境中逐项补齐上述实测，并将实测日期、Git SHA、制品 `sha256`、命令输出与四角色矩阵结果回填至本页替换 `BLOCKED` / `NOT RUN` 后，方可按 [设计 §5](../plugins/forge-experts.md#5-逐文件实施与验收计划) 分阶段开启 `managementEnabled` 与 `dispatchEnabled` 并推进 [#243](https://github.com/hrygo/heluo-forge/issues/243)–[#247](https://github.com/hrygo/heluo-forge/issues/247) 关单。

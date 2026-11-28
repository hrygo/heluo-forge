# 专家智能体（`@heluo/forge-experts`）实现与验证记录

设计规格与验收判据见 [Forge 专家智能体管理插件详细设计](../plugins/forge-experts.md)（`CORP-DSH-DESIGN-023`）与 [Delegra 专家智能体员工访问与受限受理契约](../../contracts/delegra-expert-access.md)（`CORP-DSH-EXPERT-001`）。本页汇总当前已落地的离线单测、独立制品闭包、宿主预检与安装回读证据，并对目标终端和真实企业 Delegra 联调缺少证据的验收项标记为 `BLOCKED` / `NOT RUN`；在实机与企业联调闭环前，本页不替代生产准入（追踪见 [heluo-forge#243](https://github.com/hrygo/heluo-forge/issues/243)、[#244](https://github.com/hrygo/heluo-forge/issues/244)、[#245](https://github.com/hrygo/heluo-forge/issues/245)、[#246](https://github.com/hrygo/heluo-forge/issues/246)、[#247](https://github.com/hrygo/heluo-forge/issues/247)）。

## 固定代码基线

核验日期为 2026-11-25。

- **Heluo Forge（`hrygo/heluo-forge`）**：
  - 主干（`main`）已合入 `#423`（宿主预检探针）、`#424`（`CORP-DSH-EXPERT-001` 契约）、`#425`（`@heluo/forge-experts` Stage 3A）、`#426`/`#451`（`@heluo/forge-iam` RFC 8693 换票与加固）、`#446`（Stage C1）、`#450`（Stage C2 可信选择绑定、Forge Policy 外发门禁与 `#247` 请求关联持久化）、`#452`（独立安装验证）、`#453`（Stage C3 主助手受限工具桥接与 `#247` 合成信封）及 `#479`（DSH 基线升级至 `0.2.2-rc.5`）。
  - Stage C4 合集（`#484`，合并原 `#481` Stage C4-A、`#482` Stage C4-B 与 Stage C4-C）：已落地生产 `@` 选择绑定、SSE 草稿恢复与 `prestep.mjs` 守卫；已补齐 `#247` 异步任务状态/恢复卡片 UI（`chat.taskCard` 槽位：默认折叠原文抽屉、fail-closed 来源与产物过滤、按原请求号对账、刷新状态与结果、`waiting_user` 只读提示与显式追问、取消外部动作未撤销提示）、启动/重连期 `pending_index` + `/tasks/pending` + `/tasks/reconcile` 自动对账及 `#246` `dispatchEnabled` 管理页状态提示；已补齐跨包真实 `@heluo/forge-iam`（RFC 8693 换票与 `sessionView`）+ `@heluo/forge-policy`（`policy.decide` 拒绝/放行/卸载 fail-closed）+ `@heluo/forge-experts`（默认关闭、受限工具、预步守卫、丢回执对账）端到端仿真验证，并修复跨包契约适配问题。
- **Delegra 后端（`hrygo/Delegra`）**：
  - `deploy` 已合入 `#91`（阶段 B 受限员工 API 骨架）及 `#92`–`#95`（K8s 智能调度落地）。
  - 阶段 B2 全部 4 个后端生产化 Issue 已在分支 `feat/employee-experts-runner-isolation`（`1a725a86fa`）完成实现、官方 Drizzle 快照（`0453_employee_expert_tasks.sql` + `0453_snapshot.json`）生成及安全加固，并已向 `hrygo/Delegra:deploy` 提交合集 PR 覆盖 [Delegra#99](https://github.com/hrygo/Delegra/issues/99)（RFC 8693 换票端点与 `verifyCredential`）、[Delegra#98](https://github.com/hrygo/Delegra/issues/98)（PG 单事务持久化与真实目录/`scope-check`/`authContinuityDigest` 适配器）、[Delegra#97](https://github.com/hrygo/Delegra/issues/97)（通用列表、`heartbeat-runs`、`live-runs`、单条 run 直访 404 与 WebSocket 私有 ACL 过滤）与 [Delegra#96](https://github.com/hrygo/Delegra/issues/96)（按任务 Runner 隔离、`runGeneration` 围栏、只读 `reuseRefs` 与运行时 `isIsolationVerified()` 503 探针）。

## 已落地离线与合成环境验证证据

| 验收面（对应设计 §5.2） | 复跑命令与覆盖范围 | 已验证结果 | 当前状态 |
| --- | --- | --- | --- |
| 管理包单测、Stage C4-A/C4-B/C4-C 跨包仿真、P1–P9 架构守卫与变异证明 | `DSH_BIN="$(command -v dsh)" node --test packages/forge-experts/test/*.test.mjs tests/forge-experts-enterprise-e2e.test.mjs` | 2026-11-28 使用 DSH `0.2.2-rc.5` 实跑 `122 passed, 0 failed`，含 Web profile 装配探针：覆盖目录/可调用视图分离、`editToken` 并发与撤权重授重置、生产 `@` 选择绑定与 SSE 草稿恢复、`chat.taskCard` 异步状态/折叠原文抽屉/对账/追问/取消/`waiting_user` 只读卡片、启动期 `by-request` 自动对账、任务卡撤权清理与异步响应隔离、首次委派与追问不可访问态、原请求重查及只读草稿、重复对账通知隔离、Host 列表和 SSE 的实时身份与组织复核、交叠 404 与受理写入失败后的重启对账、索引写入失败清理、同摘要轮次独立恢复、追问幂等并发、跨包真实 `@heluo/forge-iam` + `@heluo/forge-policy` + `@heluo/forge-experts` 端到端仿真及 P1–P9 结构守卫与变异证明 | 离线/跨包仿真 PASS |
| Delegra 员工契约连接器与 RFC 8693 换票 | `packages/forge-experts/test/delegra-client.test.mjs`、`packages/forge-iam/test/service-token-exchange.test.mjs` | 单次不透明凭据句柄零明文泄露、`scope` 信封复核、3xx 重定向拒绝、分页超限 fail-closed、幂等重放与 `409` 摘要冲突、传输未知态 `by-request` 对账及 `apply()` 装配接线均已通过 | 离线单测 PASS |
| Delegra Stage B2 后端生产化与迁移快照校验 | `vitest run`（`check-migration-safety.test.ts`、`migration-snapshot-drift.test.ts`、`employee-token-exchange.test.ts`、`employee-experts-routes.test.ts`、`employee-experts-persistence.test.ts`、`employee-experts-acl-matrix.test.ts`、`employee-experts-isolation.test.ts`）+ `check-delegra-branch-policy.mjs` | 2026-11-25 实跑全部通过（DB 迁移安全 25/25 + 快照零漂移 1/1 + 服务端 19/19，`ok: 50 active patch(es)`），已提 PR 待 CI 全绿合入 `deploy` | 离线/合成 PASS（待合入） |
| 独立制品构建、离线安装、重启回读与未知格式保全 | `node --test packages/forge-experts/test/host-install.test.mjs` | 通过 `scripts/build-enterprise-bundle.mjs --entry @heluo/forge-experts` 构建独立 tarball，在隔离目录离线安装并通过 `auditReleaseClosure` 闭包审计；验证启用偏好经卸载重装与重启后完整回读，以及 `schemaVersion: 99` 未知格式文件 fail-closed 且原字节零改动 | 合成宿主 PASS |
| 建包前宿主预检探针（离线闭包与 Client 槽位） | `FORGE_EXPERTS_TARGET=web node scripts/probe/run-forge-experts-host-preflight.mjs` | 2026-11-25 macOS arm64、DSH `0.2.2-rc.5`，独立合成夹具执行 `PASS=11`、`FAIL=0`。路由与连接使用夹具，存储域走宿主实现 | 合成宿主 PASS，目标端 UI 与企业联调待验 |

## 实机与企业联调阻断项（BLOCKED / NOT RUN）

以下验收项依赖目标终端、真实企业 IAM 或部署后实机联调环境，当前环境尚未完成验证：

| 验收项 | 依赖条件与跟踪项 | 当前状态 | 解除阻断判据 |
| --- | --- | --- | --- |
| 目标 DSH 发行物装入、原生设置页、两窗口并发与已开 `@` 菜单失效 | 目标终端可执行的 `DSH_BIN`（Web）或 `DSH_APP`（Desktop）；跟踪 [#246](https://github.com/hrygo/heluo-forge/issues/246) | `BLOCKED` | 以目标版本运行 `run-forge-experts-host-preflight.mjs` 与 `host-install.test.mjs` 全项 `PASS`（含 `target-version-pin`、`host-storage-domain-restart-readback`）并完成原生设置页与双窗口实机复核 |
| DSH 原生聊天 `@` 点选、实际提交绑定、模型未调用兜底与草稿恢复 | 目标 DSH 原生输入/执行入口实机环境；跟踪 [#245](https://github.com/hrygo/heluo-forge/issues/245) | `NOT RUN` | 验证普通文字、粘贴/重放、失效引用、停用与出站双顺序及拒绝后草稿与后续输入保留 |
| 企业 IAM RFC 8693 换票端点、四角色授权矩阵与撤权收敛实测 | Delegra Stage B2 合集 PR 合入部署 + 真实企业 IAM 测试组织；跟踪 [#244](https://github.com/hrygo/heluo-forge/issues/244) | `BLOCKED` | 冻结 `CORP-DSH-EXPERT-001 §9.3` 换票端点/`audience`/`resource`/声明集，通过发起员工、仅查看权、同组织同事、跨组织账号四角色矩阵及 `<= 5 min` 撤权收敛实测 |
| 真实 PostgreSQL 故障注入、通用运行列表私有 ACL 与跨会话 K8s Runner 隔离实机复核 | Delegra Stage B2 合集 PR 合入部署 + 目标 K8s 集群；跟踪 [#244](https://github.com/hrygo/heluo-forge/issues/244)、[#247](https://github.com/hrygo/heluo-forge/issues/247) | `BLOCKED` | 在真实 PG 与 K8s 集群复核事务回滚零任务、丢回执 `by-request` 对账、通用列表与 `heartbeat-runs`/`live-runs` 对同组织未获权同事零脱敏条目泄漏，以及双 DSH 会话调同一专家零上下文串扰 |

## 解除阻断与准入条件

在目标 DSH 发行物与已部署 Delegra Stage B2（`#96`–`#99`）的企业测试环境中逐项补齐上述实测，并将实测日期、Git SHA、制品 `sha256`、命令输出与四角色矩阵结果回填至本页替换 `BLOCKED` / `NOT RUN` 后，方可按 [设计 §5](../plugins/forge-experts.md#5-逐文件实施与验收计划) 分阶段开启 `managementEnabled` 与 `dispatchEnabled` 并推进 [#243](https://github.com/hrygo/heluo-forge/issues/243)–[#247](https://github.com/hrygo/heluo-forge/issues/247) 关单。

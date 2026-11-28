# 中段整体审查

2026-11-27，Agent 代拟。独立评审阅读 V0.1.0 全文、仓库内基线与此前三个阶段的发现。第一阶段的独立交付面包括移除视图读取回边、隔离展示发布及保留原有授权时序。第一阶段验收后可暂停包内拆分。 [PLAN-029](../../../plans/2026-11-27-iam-session-model-boundary.md) · [初次审查](zoom_out_report.md) · [可理解性](comprehension_report.md) · [设计批判](critic_report.md)

- **I8-1 · 重要。** §2 第 42–46 行与 §3.3 须纳入独立发现的绑定和会话变化。普通网关摘要回读发生变化时只安排选型观察，异常清空摘要也无会话通知。跨 Host 会话采纳的公开帧比较未包含 `sessionInstanceId`。将已确认的有效上下文变化纳入私有失效信号，同值强读保持静默。验收覆盖共享存储回读发现 Key 清除、展示字段同值的登录实例替换，以及无需读取视图的模型清理。 [摘要更新第 124 行](../../../../packages/forge-iam/src/service-gateway.mjs) · [会话采纳第 409、451 行](../../../../packages/forge-iam/src/service-reconcile.mjs) · [路由读取第 470 行](../../../../packages/forge-iam/src/routes.mjs)
- **I8-2 · 重要。** §3.2 第 63、66 行应明确业务错误处理的终点。登录已写入 grant 后仍在可能清除 grant、撤销令牌的 `try` 内读取完整视图。`hydrate()` 也先等待 `syncFromStore()` 返回再读网关。扩展 Z5-1、D7-1，将模型投影移出这些内部链路，验证投影故障时已提交登录、凭据确认、存储恢复和会话调度均按各自契约处理。 [回调第 394 行](../../../../packages/forge-iam/src/service-signin.mjs) · [恢复第 494 行](../../../../packages/forge-iam/src/service-reconcile.mjs)
- **I8-3 · 重要。** §2 第 42、45、50 行须保留独占冲突被发现后的持续拒绝。现有复查只提交失败，晚挂的官方账号服务随后撤挂也不会恢复旧会话。由 IAM 在纯投影之外处理发现与状态提交，补齐 Z5-3、U6-2、D7-4、S7-4 的交错验收。 [独占写入第 50 行](../../../../packages/forge-iam/src/service-state.mjs) · [晚挂回归第 243 行](../../../../packages/forge-iam/test/service.test.mjs)
- **I8-4 · 重要。** §3.1 第 57–58 行与 §3.3 第 71–72 行需用实际 `apply` 的双出口验证通知隔离。SDK 默认模型观察可以强制重读网关摘要。摘要同值时只发生预期的展示发布和有界观察。发现真实变化时应发内部失效信号。测试 Host 必须支持注册适配器，单独使用既有默认模型观察夹具无法覆盖实际运行时。 [双出口第 489 行](../../../../packages/forge-iam/src/managed-models.mjs) · [强制回读第 96 行](../../../../packages/forge-iam/src/service-model-selection.mjs) · [既有夹具第 26 行](../../../../packages/forge-iam/test/model-selection-host.test.mjs)
- **I8-5 · 重要。** §3.1 第 58 行与 §4 应迁移续期截止回归的时钟注入点。现有用例用模型 getter 在会话取样后、排程前推进墙钟。将这一交错移到 IAM 取样和排程之间，保留原取样时间、下一次唤醒时发布 `renewal=unavailable`、零换票及无重复发布的断言。 [现有回归第 185 行](../../../../packages/forge-iam/test/session-renewal-view.test.mjs) · [PLAN-028](../../../plans/2026-11-27-iam-session-freshness.md)
- **I8-6 · 轻微。** §3.3 第 72 行的每条禁止调用边应分别执行一次变异验证。§4 离线复跑说明应包含 `DSH_BIN` 和 `PATH` 的条件。宿主探针会自行清除 `DSH_HOME`，仅隔离该目录不能决定探针跳过。 [结构守卫规范](../../dsh-plugin-conventions.md) · [宿主探针第 78 行](../../../../tests/host-probe.test.mjs)

保留先前关于代际与快照归属、首次取样顺序和第一阶段停点的意见。改动可复用现有状态所有者、清理逻辑、单飞和派发门禁，后续提取模块以 PLAN-014 的维护收益判据决定。 [PLAN-014](../../../plans/2026-11-05-forge-iam-structure.md)

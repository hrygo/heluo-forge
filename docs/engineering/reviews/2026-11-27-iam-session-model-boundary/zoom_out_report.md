# 初次整体审查

2026-11-27，Agent 代拟。两名独立评审阅读方案全文和仓库内基线，分别审查总体方向与可行替代。评审对象为 V0.1.0，源码基线为 `bcca688d`。 [PLAN-029](../../../plans/2026-11-27-iam-session-model-boundary.md)

同时处理读时采样和目录通知回流有独立价值。只处理任意一条都保留另一条耦合。第一阶段可复用现有代际、订阅清理和最后派发门禁，继续以一个插件和一个浏览器 bundle 交付。替代方案评审结论为 “No false compromise detected”。

- **Z5-1 · 重要。** 方案第 45–46、63、70 行仍可能让会话推进依赖模型投影。当前 `notify()` 先构造视图，再通知监听器和安排续期、到期。网关 Key 持久写入确认也依次调用 `ctx.notify()` 和 `ctx.view()`，异常进入写入结果未知处理。会话发布、计时和持久写入确认应只读会话与凭据取样。完整视图在门面响应和公开发布时组合。验收应注入模型投影故障，核对会话调度和凭据确认仍可完成。 [会话发布第 146 行](../../../../packages/forge-iam/src/service-state.mjs) · [网关写入确认第 304 行](../../../../packages/forge-iam/src/service-gateway.mjs)
- **Z5-2 · 重要。** 方案第 46、57、71–72 行应覆盖真实 Host 的两个发布出口。模型 `publish()` 先发 `llm/adapters-updated`，再调用 `onChange`。配置了默认模型时，SDK 事件会触发有界观察，其中包括强制读网关凭据摘要。用真实 `apply` 接线验证展示更新、SDK 观察，以及会话订阅、续期调度和目录重拉次数。 [模型发布第 489 行](../../../../packages/forge-iam/src/managed-models.mjs) · [Host 接线第 347 行](../../../../packages/forge-iam/src/index.mjs) · [默认模型观察第 64 行](../../../../packages/forge-iam/src/service-model-selection.mjs)
- **Z5-3 · 重要。** 方案第 42、50、63–65 行应明确动态独占判定的读取和写入归属。当前 `view()` 调用会写状态的 `recheckExclusive()`。模型采样和原生列表依赖此有效状态。验收覆盖官方账号服务迟到挂载、无先行会话通知时的即时遮蔽和保持现有派发判定。 [独占判定第 50、104 行](../../../../packages/forge-iam/src/service-state.mjs) · [原生模型列表第 1427 行](../../../../packages/forge-iam/src/managed-models.mjs)
- **Z5-4 · 轻微。** 方案第 112–114 行的再次拆分应以已经观察到的维护收益为条件。模型可调用性还取决于已安装的适配器和调用形态。按 PLAN-014 复核变更局部性、故障隔离与测试独立性，再决定是否提取包内模块。 [适配器判定第 470 行](../../../../packages/forge-iam/src/managed-models.mjs) · [PLAN-014](../../../plans/2026-11-05-forge-iam-structure.md)

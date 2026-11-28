# 设计批判审查

2026-11-27，Agent 代拟。三个独立评审分别依据设计、结构和表述标准审查 V0.1.0 第 1–51 行。源码基线为 `bcca688d`。 [PLAN-029](../../../plans/2026-11-27-iam-session-model-boundary.md)

## 设计

- **D7-1 · 重要。** 第 26、45–46 行应指定所有公开操作的统一投影出口。开始登录、取消登录、退出、保存和清除网关凭据直接返回 `ctx.view()` 或 `ctx.publish()` 派生的结果。路由使用这些结果及其双时钟元数据。门面应组合完整的 `IamView`，覆盖直接返回和嵌套 `view`。 [登录第 231、486 行](../../../../packages/forge-iam/src/service-signin.mjs) · [退出第 302 行](../../../../packages/forge-iam/src/service-signout.mjs) · [凭据确认第 304 行](../../../../packages/forge-iam/src/service-gateway.mjs) · [序列化第 11 行](../../../../packages/forge-iam/src/routes.mjs)
- **D7-2 · 重要。** 第 42–43、48 行列出的会话发布不足以覆盖授权代际变化。取消已结束的登录尝试时，现有代码递增 `authEpoch` 后调用视图，且该分支没有调用会话通知。当前投影回边会当场采样并取消旧租约。改造后须由状态所有者明确发出内部失效，复核原有取消时点和新调用可用性。 [取消登录第 478 行](../../../../packages/forge-iam/src/service-signin.mjs) · [租约采样第 592 行](../../../../packages/forge-iam/src/managed-models.mjs)
- **D7-3 · 重要。** 第 45、48 行需要分别规定目录和选型快照的有效范围。同主体重登且网关未变时可展示已确认目录。旧手动条目、启用集、默认项和安装态应先失效。换主体或绑定时清目录。会话仍可恢复时沿用缓存展示条件。测试应在订阅延迟期间验证各项。 [快照归属第 606 行](../../../../packages/forge-iam/src/managed-models.mjs) · [可恢复会话第 111 行](../../../../packages/forge-iam/src/service-state.mjs) · [同主体重登用例第 1328 行](../../../../packages/forge-iam/test/managed-models.test.mjs)
- **D7-4 · 重要。** 第 42、45、50 行应明确实时独占复查的触发点。`getView()`、`watch()` 首帧和 `llm.listModels()` 目前经同一读取链观察迟到的官方账号服务。将 IAM 主动校验与纯组合分开，逐一说明这些入口如何保持即时拒绝。 [独占检查第 50、104 行](../../../../packages/forge-iam/src/service-state.mjs) · [首帧第 437 行](../../../../packages/forge-iam/src/service.mjs) · [原生选择器第 1427 行](../../../../packages/forge-iam/src/managed-models.mjs)
- **D7-5 · 轻微。** 第 34–37、46 行应列出独立的 SDK 拓扑通知。`llm/adapters-updated` 仍经既有入口触发只读默认模型观察。 `publishModelView()` 负责账户展示。 [两项发布第 489 行](../../../../packages/forge-iam/src/managed-models.mjs) · [默认模型观察第 347 行](../../../../packages/forge-iam/src/index.mjs)

## 结构

- **S7-1 · 重要。** 第 22–50 行缺少方案取舍。用简短对照交代仅拆通知会留下读取回边，仅拆投影会留下发布回流，以及同批消除两条边的回归成本。
- **S7-2 · 重要。** 第 24、42–46 行的“运行时拥有选型”应限定为模型运行时快照与应用。持久化读写及选型代际沿用既有 IAM 选型与存储职责。 [模块职责](../../../../packages/forge-iam/README.md) · [选型入口第 386 行](../../../../packages/forge-iam/src/service.mjs)
- **S7-3 · 重要。** 第 43 行应说明监听注册与首次取样的顺序。现有 `watch()` 在生成首帧前注册监听。新接口应用受控交错证明启动窗口内的状态变化会被消费。 [订阅第 437 行](../../../../packages/forge-iam/src/service.mjs)
- **S7-4 · 重要。** 第 42、45、50 行同时要求保留独占检查和只读投影。说明首次发现冲突时如何生成只读的失败视图，以及哪个 IAM 入口负责提交状态。 [状态写入第 50 行](../../../../packages/forge-iam/src/service-state.mjs)

## 表述

- **F7-1 · 重要。** 第 24 行应明确第一阶段本身形成可交付改动，验收后暂停进一步的包内模块拆分。
- **F7-2 · 轻微。** 第 42–43 行需区分同步读取和状态更新。使用“同步读取当前上下文”和“收到信号后重读”。
- **F7-3 · 重要。** 第 48 行的“已受理流按现有授权继续”应明确截止、退出和撤权仍适用。

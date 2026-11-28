# 实施就绪度审查

2026-11-27，Agent 代拟。实施就绪、源码细节和表述三个独立评审核对 V0.1.0 第 52–114 行。当前实施就绪度未通过。两位评审独立定位到网关摘要采纳的同一阻断。 [PLAN-029](../../../plans/2026-11-27-iam-session-model-boundary.md)

## 实施步骤与验收

- **R9-1 · 阻断。** 第 65–71、79–81 行缺少网关绑定变化的完整发布路径。普通或强制读取也可替换或清空 `gatewaySummary`，只有 `sessionRefresh` 的已变更分支触发 `ctx.notify()`。SDK 默认模型观察会触发强制读取。应列出摘要变化、读取失效、确认写入和 provider 变更的发布入口，验证无展示读取时也能清理旧状态，并保留同值重读的去重。 [摘要加载第 124 行](../../../../packages/forge-iam/src/service-gateway.mjs) · [默认模型观察第 96 行](../../../../packages/forge-iam/src/service-model-selection.mjs)
- **R9-2 · 重要。** 第 63–66、79–82 行应给出可直接实现的字段级投影规则，覆盖不同绑定、同主体重新登录、可恢复到期、同一次登录续期和无运行时。模型与会话使用同一取样，并保留双时钟属性的内部和传输语义。 [会话投影第 111 行](../../../../packages/forge-iam/src/service-state.mjs) · [运行时采样第 592 行](../../../../packages/forge-iam/src/managed-models.mjs)
- **R9-3 · 重要。** 第 56–59、70–72 行应经已登录的 `apply` Host 夹具驱动真实模型目录更新。旧版和目标版通过同一入口，分别证明现有回流和切断后的行为。补订阅启动与首次同步、卸载与迟到回调的受控交错。三条结构守卫分别作一次变异验证。 [现有目录通知用例第 234 行](../../../../packages/forge-iam/test/iam-view-consumer.test.mjs) · [Host 装配第 305 行](../../../../packages/forge-iam/src/index.mjs)
- **R9-4 · 重要。** 第 63–73 行需列出调用方迁移范围。除已点名的用例，还包括 `automatic-renewal`、`gateway-save-confirmation`、`gateway-sqlite-regression`、`host-default-model`、`iam-call-recovery`、`manual-models-backend`、`model-transport`、`model-transport-sqlite` 八个 `.test.mjs` 调用方。加上网关摘要发布落点，合并 §3.2 与 §3.3 为一个可构建、可验收、可回退的代码停点。
- **R9-5 · 重要。** 第 64、84–108 行应给出已安装 Host 的合成探针命令 `node scripts/probe/run-iam-managed-models-probe.mjs` 和 `DSH_BIN`、`DSH_NODE_MODULES` 条件。沿用目录、对话、续期和退出后拒绝的断言。单列无宿主环境的离线检查命令。 [本地模拟测试指南](../../../../packages/forge-iam/docs/local-mock-testing.md#自动验证)
- **R9-6 · 重要。** 第 110 行的回退需写明制品兼容和复验。将源码按同一实施单元撤回。所选上一份完整验签制品需兼容现用刷新和退出协议，沿用原配置、凭据库和混跑约束。回退后检查会话恢复、续期、SSE 更新和模型单次派发。 [参考回退判据](../../../plans/2026-11-27-iam-session-freshness.md)

## 源码细节

- **K9-1 · 阻断。** 第 63–71、79–81 行缺少普通摘要采纳的模型通知。`/view` 显式加载普通网关摘要后再读投影。`defaultModel` 为空时，现有选型调度直接返回。回归应通过双 Host 在本机正常入口发现 Key 清除或替换，随后观察运行时清理，无需额外模型操作。 [路由第 470 行](../../../../packages/forge-iam/src/routes.mjs) · [网关读第 104 行](../../../../packages/forge-iam/src/service-gateway.mjs) · [选型调度第 53 行](../../../../packages/forge-iam/src/service-model-selection.mjs)
- **K9-2 · 重要。** 第 57–58、70–71 行需区分现有 `notifyView()` 用例。续期截止依赖会话发布及计时调度，令牌轮换有两处直接的 `ctx` 监听。目录用例则应从真实模型 `onChange` 观测展示帧。 [令牌监听第 298、1473 行](../../../../packages/forge-iam/src/service-token.mjs) · [续期测试第 185 行](../../../../packages/forge-iam/test/session-renewal-view.test.mjs)
- **K9-3 · 重要。** 第 56、65、79 行应规定到期首帧、重登、同址重存 Key 和自身选型写入时的目录与选型字段。现有绑定比较、登录实例、选型代际和存储可用性共同决定不同遮蔽行为。 [模型采样第 592 行](../../../../packages/forge-iam/src/managed-models.mjs) · [同主体重登第 1328 行](../../../../packages/forge-iam/test/managed-models.test.mjs)
- **K9-4 · 重要。** 第 57、71、79 行的“目录变化发一帧”范围宽于既有去重签名。同 ID 元数据、`syncedAt` 和选型值的变化可能保留相同签名。明确本阶段需要发布的变化范围，同一失败的去重仍须验证。 [发布签名第 489 行](../../../../packages/forge-iam/src/managed-models.mjs) · [热目录提交第 1296 行](../../../../packages/forge-iam/src/managed-models.mjs)
- **K9-5 · 重要。** 第 70、81 行的销毁判据不能仅复用已有 `stop()`。当前它只唤醒处于等待的迭代器，首帧或队列暂停处会继续检查外部信号。需要覆盖两条订阅在暂停、排队和等待位置的终止。 [订阅和销毁第 437、486 行](../../../../packages/forge-iam/src/service.mjs)
- **K9-6 · 重要。** 第 63–73、86–104 行的迁移要覆盖直接创建 `createServiceState` 和仅注入视图的夹具。额外列明组合探针命令及缺少宿主时的证据。 `pnpm check` 执行自动发现的单测。 [直接状态夹具第 126 行](../../../../packages/forge-iam/test/manual-models-backend.test.mjs) · [纯视图夹具第 333 行](../../../../packages/forge-iam/test/session-read-lock-recovery.test.mjs) · [组合探针](../../../../scripts/probe/run-iam-managed-models-probe.mjs) · [检查入口](../../../../package.json)

## 表述

- **F9-1 · 重要。** 第 56 行应明确退出、清除凭据和重登每个场景均连续读取两次，并分别断言零读取副作用。
- **F9-2 · 重要。** 第 71 行应明确每种代际变化触发的遮蔽、取消或刷新动作，并复用现有代际定义。

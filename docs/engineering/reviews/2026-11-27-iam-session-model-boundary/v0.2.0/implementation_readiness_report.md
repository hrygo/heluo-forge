# PLAN-029 V0.2.0 实施就绪度复审

2026-11-27，Agent 代拟。EGM 第 9 阶段单轮复审，实施就绪、源码细节和表述三位评审独立核对 §3–§5，并以 §2 核对失效契约。源码基线为 `main` 的 `bcca688d`，图谱新鲜度不足的路径按工作区源码核对。 [PLAN-029 V0.2.0](../../../../plans/2026-11-27-iam-session-model-boundary.md) · [V0.1.0 审查](../consolidated_review_report.md)

**结论为第一阶段暂缓开工。** A1 原先遗漏的通知来源已入表。有效绑定从暂态进入确认态的规则仍有歧义，§4.1 的网关回读和目录隔离用例也可能把旧行为判为通过。第一阶段继续以一个插件内消除两处依赖回路为目标，开工门禁见下列发现。

## 上轮问题复核

| 上轮发现 | V0.2.0 的复核结果 |
|---|---|
| A1 失效信号 | §2.2 已指定普通和强制回读、失败、跨 Host 同账号新登录、已结束登录尝试的取消、已确认写入、来源解绑及恢复的通知点。同步撤权、先订阅后发现目录、快速失效并恢复时旧租约保持取消，均已写明。A1 仍受 R1、R2 阻断。 |
| A2–A4 业务确认、投影、独占 | 业务结果先确认再组合视图，字段和代际已入表，独占检查保留在正常入口。异址和同址重存的流验收见 R4，`notifyView()` 返回值见 R5。 |
| A5 通知隔离与终止 | 已定义公开与私有订阅的终止位置、实例替换和迟到回调规则。真实装配的目录隔离待补观察点，见 R3。 |
| A6–A7 迁移、回退和停点 | 已列直接工厂调用方和视图桩、同批迁移和回退、隔离离线命令、宿主探针及后续拆分条件。结构守卫的变异与失败信号并入 R3。 |

## 开工前须关闭的发现

### R1 · 阻断 · 固定有效绑定的所有者、提交与失信边界

§2.1–§2.2 第 47、58、63–70 行允许驻留数据的直接取样，也规定加载暂清属于中间态。当前 `refreshSessionSummary()` 在异步读前清空 `gatewaySummary`，`syncFromStore()` 可在读结束前发布会话。仅在发布处过滤暂清，运行时首样本或显式模型操作仍可能读出假失效。另一条正常路径 `resolveToken()` 可采纳持久 grant 并直接发会话事件，网关摘要的 `matchesAccount` 仍是摘要生成时的判断。原子存储及机密来源的解绑也能保留同一 `credentials`，`ensure()` 在同实例时会早退。 [摘要暂清第 150 行](../../../../../packages/forge-iam/src/service-gateway.mjs) · [会话采纳第 429 行](../../../../../packages/forge-iam/src/service-reconcile.mjs) · [令牌采纳第 472、688 行](../../../../../packages/forge-iam/src/service-token.mjs) · [解绑第 387–422 行](../../../../../packages/forge-iam/src/index.mjs) · [存储来源第 50 行](../../../../../packages/forge-iam/src/service-store.mjs)

在 §2.2 和 §3.2 固定一个 IAM 内部所有者，以及供直接取样、订阅首样本和变更通知共同读取的最后确认有效绑定。仍可信且同归属的暂态读取保留它，归属按当前 grant 的主体、发行者和来源核对。采纳新登录实例当场终止旧租约。已确认解绑、失配、当前回读确认不可用和写入确认结果未知均同步提交有效变化。恢复须确认当前来源及记录，迟到结果按原所有权判据丢弃。把同值绑定回读的去重与 `accessEpoch` 的待派发围栏分别定义，保存及清除开始时已可推进选型代际。 [摘要归属第 67–75 行](../../../../../packages/forge-iam/src/service-gateway.mjs) · [更新起点第 459、567 行](../../../../../packages/forge-iam/src/service-gateway.mjs) · [代际第 137、333 行](../../../../../packages/forge-iam/src/service.mjs)

在 §4.1 加受控 SQLite 屏障。可信来源采纳同一登录的会话记录后，暂停尚未完成的网关回读，核对直接取样和订阅首样本都保留仍有效的绑定，当前流的取消为零。分别撤挂原子存储及 confidential 模式的机密来源，保留同一凭据对象，撤挂返回前旧流已取消。恢复时先保留失效，放行当前记录确认后只为新工作建立租约，同时释放旧来源的迟到结果验证它保持静默。 [相同来源重绑夹具第 259 行](../../../../../packages/forge-iam/test/late-credentials-hydration.test.mjs)

### R2 · 阻断验收 · 在最终投影前观察租约撤回

§3.1 第 98–99 行要求新增缺陷用例能在旧版失败。§4.1 第 128 行已要求在回读返回前取消，还需在指定的 `/view` 入口固定断言位置。现有路由在 `loadGatewayCredential()` 后执行 `getView()`，旧模型 getter 会执行 `sample()` 并可撤销租约。看到 HTTP 响应后再检查旧流，会把这个读时补救当成同步失效。 [正常路由第 470 行](../../../../../packages/forge-iam/src/routes.mjs) · [采样撤销第 592–605 行](../../../../../packages/forge-iam/src/managed-models.mjs) · [旧 getter 第 1830 行](../../../../../packages/forge-iam/src/managed-models.mjs)

从真实 SQLite 双 Host 的 `/view` 入口开始，固定空 `defaultModel`、缓存窗口和一条已受理且暂停输出的流。让另一 Host 清除 Key 或让当前回读确认失败。路由夹具在 `loadGatewayCredential()` 完成采纳、最终 `getView()` 尚未执行的边界暂停，直接检查既有传输的 `AbortSignal` 已取消，随后才放行响应。强制回读的同值与旧来源结果用零失效、零目录重拉作对照。同账号换实例和取消登录可保留正常出口的兼容断言，并在纯投影版本分别屏蔽该私有发布，确认用例能识别漏接。 [SQLite 与路由夹具第 70、166 行](../../../../../packages/forge-iam/test/gateway-sqlite-regression.test.mjs) · [现有流信号夹具第 420 行](../../../../../packages/forge-iam/test/gateway-save-confirmation.test.mjs)

### R3 · 重要 · 用真实装配验证目录通知和会话调度分离

§4.1 第 133 行给出了帧数和重排目标。当前 `notify()` 每次经过会话监听与续期调度，续期器可因同身份、同截止而直接返回。新增计时器和续期日志均为零时，旧回流仍可能存在。现有目录消费者用例直接调用服务的 `notifyView()`，`apply` 夹具的专用适配器注册是空实现。 [会话通知第 159–168 行](../../../../../packages/forge-iam/src/service-state.mjs) · [续期去重第 457 行](../../../../../packages/forge-iam/src/service-token.mjs) · [消费者夹具第 234 行](../../../../../packages/forge-iam/test/iam-view-consumer.test.mjs) · [Host 夹具第 358–402 行](../../../../../packages/forge-iam/test/model-selection-host.test.mjs)

在指定的 Host 夹具上捕获适配器注册并调用，接入 `apply` 注册的 `/api/forge-iam/events` 路由及受控 Connection。登录、绑定、首帧与 SDK 初始观察收敛后，以一次目录热刷新触发受管模型运行时的 `onChange`。记录一帧新增 SSE、预期 SDK 观察次数和仅有的主动目录刷新。对会话监听或续期调度入口断言零调用，也可由可变异的结构守卫提供调用边的证据。单独验证 SDK 回读确认真实变绑时同步提交有效变化。 [模型接线第 336、347 行](../../../../../packages/forge-iam/src/index.mjs) · [路由接线第 445 行](../../../../../packages/forge-iam/src/index.mjs)

§3.3 第 117 行的三个变异应各自写明恢复的调用、对应断言及恢复后通过的结果。分别让运行时重新读完整 IAM 视图、让纯投影重新进入 `sample()`、让 `onChange` 重新调用 `notifyView()`。每次只改一条调用边，目标守卫因对应越界失败。 [现有结构守卫](../../../../../packages/forge-iam/test/service-state-structure.test.mjs)

### R4 · 重要 · 明确同主体异址换绑对已受理流的判据

§2.2 第 65 行和 §2.3 第 91 行需要区分“旧绑定失效”和“另一个有效地址”。当前已受理流的授权比较以主体、凭据状态和授权代际为依据，地址及 Key 代际另在派发前核验。方案应将同主体两个地址均有效时的已受理流行为写成显式判据，沿用现有流契约。§4.1 的同址正向用例也要让流跨过成功确认后继续输出，现有测试在放行确认前已结束流。补充有效异址和清除的对照，同时核对新派发按已确认地址执行。 [流授权契约 §8.1.6](../../../../design/plugins/forge-iam.md#816-流中授权边界) · [授权比较第 112 行、派发复核第 894 行](../../../../../packages/forge-iam/src/managed-models.mjs) · [现有确认测试第 465–473 行](../../../../../packages/forge-iam/test/gateway-save-confirmation.test.mjs)

### R5 · 轻微 · 补齐 `notifyView()` 的门面返回值

§2.1 第 50 行和 §3.2 第 106 行应列明现有 `notifyView()` 门面继续返回完整 `IamView`，会话轴内部按样本发布与调度。既有续期用例直接断言返回值的 `state`、`renewal`。 [门面第 360 行](../../../../../packages/forge-iam/src/service.mjs) · [返回值用例第 262 行](../../../../../packages/forge-iam/test/preflight-retry-lifecycle.test.mjs)

## 复审追溯

| 发现 | 独立评审记录 |
|---|---|
| R1 有效绑定 | RD-1、CB-1 |
| R2 回读撤权判据 | RD-2、CB-3 |
| R3 目录隔离判据 | RD-3、CB-4、ST-1、ST-2 |
| R4 有效异址与流 | CB-2 |
| R5 门面返回值 | RD-4、CB-5 |

## 证据范围

以 Node 24.21.0、隔离 `DSH_HOME` 与本机宿主路径运行 `pnpm check`。文档、仓库结构和版本检查通过，既有离线测试 5,776 项通过、0 项失败、7 项跳过，耗时 70.81 秒。§4.2 命令通过 `sh -n`，计划引用的 17 个测试路径或模式及合成探针脚本均已定位。修订后新增的失效判据、合成 Host 探针和企业环境行为均待分别取证。

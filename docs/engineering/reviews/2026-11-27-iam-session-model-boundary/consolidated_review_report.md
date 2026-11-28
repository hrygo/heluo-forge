# IAM 会话与受管模型解耦方案审查

2026-11-27，Agent 代拟。审查对象为 PLAN-029 V0.1.0。源码基线为 `main` 的 `bcca688d`。EGM 连续模式完成五阶段，十个评审分别使用无父会话历史的上下文。设计审查聚焦第 1–51 行，实施就绪审查聚焦第 52–114 行。较旧的图谱定位以当前源码核实。 [PLAN-029](../../../plans/2026-11-27-iam-session-model-boundary.md)

**结论是先修订，再实施。** 两个实施就绪评审独立确认了同一个阻断。普通网关回读可以采纳新绑定或清空旧摘要，当前依靠后续视图读取让模型采样并响应。方案移除这条调用边时，必须同时补足模型失效信号。第一阶段同时消除视图读取回边和目录通知回流，在现有 `@heluo/forge-iam` 内具备独立交付价值。第一阶段验收后即可暂缓进一步拆分。

## 修订项与验收证据

### A1 · 阻断 · 使所有已确认的失效可被模型运行时消费

普通网关摘要回读、回读异常、多 Host 更新的采纳以及取消已结束的登录尝试，都可能改变模型上下文而不触发现有会话通知。回读摘要变化时经常只安排默认模型观察，`defaultModel` 为空时该观察调度直接返回。跨 Host 会话采纳判断公开帧时也未比较 `sessionInstanceId`。 [网关采纳第 124 行](../../../../packages/forge-iam/src/service-gateway.mjs) · [选型调度第 53 行](../../../../packages/forge-iam/src/service-model-selection.mjs) · [会话采纳第 451 行](../../../../packages/forge-iam/src/service-reconcile.mjs) · [取消登录第 478 行](../../../../packages/forge-iam/src/service-signin.mjs)

在方案 §2 和 §3.3 列出由谁提交变化、何时发布内部信号、何时必须让旧租约失效。覆盖会话与绑定采纳、读取失效、已确认写入、provider 解绑和恢复。订阅应保证注册与首次读取之间不会漏掉变化。连续的失效和恢复须保留旧租约应当失效的事实，同值回读依然去重。沿用已有探测入口、代际与目录单飞。

用受控测试验证四种交错。正常 `/view` 回读发现另一 Host 清除或替换 Key，随后保持页面和模型命令静默，旧运行时仍能清理或重建。同账号替换登录实例且公开字段同值，旧租约失效。取消已结束的登录尝试保留已安装模型可用性。订阅启动窗口内发生变更，运行时采用当前上下文。 [管理路由第 470 行](../../../../packages/forge-iam/src/routes.mjs) · [取消登录回归第 465 行](../../../../packages/forge-iam/test/managed-models.test.mjs)

### A2 · 重要 · 将完整视图移出业务确认和会话调度

当前完整视图的读取先于会话发布和期限排程。网关确认路径在持久写入后读取 `ctx.view()`，读取异常会进入未知结果处理。登录回调也在提交 grant 后、仍处于失败清理范围内时读取视图。单纯把投影换成注入回调会保留这一故障传播路径。 [会话发布第 146 行](../../../../packages/forge-iam/src/service-state.mjs) · [Key 确认第 304 行](../../../../packages/forge-iam/src/service-gateway.mjs) · [登录回调第 394 行](../../../../packages/forge-iam/src/service-signin.mjs) · [存储恢复第 496 行](../../../../packages/forge-iam/src/service-reconcile.mjs)

会话轴和写入确认消费会话与凭据样本。模型投影在公共门面和展示发布层组合。列出登录、取消、退出、凭据变更、存储同步及订阅中直接或嵌套的 `IamView` 出口，覆盖 `sampledAt` 和 `sampledMonotonicAt` 已有的内部属性及序列化方式。向模型投影注入失败，核对已确认的持久结果、后台恢复、续期与到期排程均按各自契约完成。 [HTTP 序列化第 11、565 行](../../../../packages/forge-iam/src/routes.mjs)

### A3 · 重要 · 把目录、选型和流的判据写成同一张表

给出权限代际、登录实例、绑定和选型代际的来源及含义。方案应区分可恢复到期的旧目录及 `stale` 状态、同主体新登录可展示的已确认目录及等待重读的选型、换绑或退出时应遮蔽的字段，以及无运行时的投影。持久选型继续由 IAM 的选型与存储入口负责，模型运行时拥有用于展示和调用的快照。每种场景在暂停订阅时连续读取两次，验证零视图副作用。续期及同址重存 Key 的对照保留原有流的期限、撤权和最后派发判定。 [代际第 333 行](../../../../packages/forge-iam/src/service.mjs) · [模型采样第 592 行](../../../../packages/forge-iam/src/managed-models.mjs) · [同主体重登第 1328 行](../../../../packages/forge-iam/test/managed-models.test.mjs)

### A4 · 重要 · 明确 IAM 动态独占检查的入口

当前读取会发现晚挂载的官方账号服务并记住冲突。把 Host Lookup 和状态提交留在 IAM 一侧，在纯投影之外明确执行入口。沿用现有 `getView()`、订阅首帧、原生模型列表和派发对冲突的判定。验收覆盖晚挂载被读入口发现，撤挂后旧会话仍保持拒绝。 [独占检查第 50、104 行](../../../../packages/forge-iam/src/service-state.mjs) · [晚挂用例第 243 行](../../../../packages/forge-iam/test/service.test.mjs)

### A5 · 重要 · 经真实 Host 装配证明通知隔离和终止

现有目录通知测试直接调用服务桩，状态为未登录。通过已登录的 `apply`、原生适配器注册与受控目录响应，断言目录状态变化产生预期展示帧，允许有界 SDK 默认模型观察，且同值绑定下会话唤醒、续期重排和目录重拉均为零。另测真实绑定变更进入 A1，以及令牌模块的直接监听仍收到会话发布。 [目录测试第 234 行](../../../../packages/forge-iam/test/iam-view-consumer.test.mjs) · [SDK 接线第 347 行](../../../../packages/forge-iam/src/index.mjs) · [令牌监听第 298、1473 行](../../../../packages/forge-iam/src/service-token.mjs)

明确 §3.1 的展示帧验收沿用现有目录状态、模型 ID 或启用位变化。仅改同 ID 的元数据可能沿用原去重签名，可单独评估其展示时效。订阅销毁覆盖首帧暂停、队列和等待三处，验证结束时不再交付已排队的数据。 [发布签名第 489 行](../../../../packages/forge-iam/src/managed-models.mjs) · [迭代器和销毁第 437、486 行](../../../../packages/forge-iam/src/service.mjs)

### A6 · 重要 · 将迁移、测试和回退做成可执行单元

列出需迁移的生产入口、直接工厂调用者、视图夹具和组合探针。§3.2 与 §3.3 合为一个可构建、可测试、可回退的代码停点。把续期截止用例的墙钟推进放在 IAM 取样和排程之间，保留在下一次计时触发时发布 `renewal=unavailable` 且零换票的断言。每条禁止调用边分别做一次变异。写明离线隔离命令、合成宿主探针的可用条件，以及启用兼容验签制品回退后对原凭据库的恢复、续期、SSE 和单次派发复验。 [时钟回归第 185 行](../../../../packages/forge-iam/test/session-renewal-view.test.mjs) · [合成宿主探针](../../../../packages/forge-iam/docs/local-mock-testing.md#自动验证) · [PLAN-028](../../../plans/2026-11-27-iam-session-freshness.md)

### A7 · 轻微 · 在方案里写清取舍和停点

用一段说明两个局部选项的残余成本。仅隔离目录通知会保留读取触发模型采样。仅改投影会保留目录通知触发会话调度。两项在同一个插件内一起交付，回归通过后即可停止。后续提取目录与设置以变更局部性、单一写者、故障隔离或可独立测试的实证收益为条件。派发需要的只读快照还须表达适配器是否已安装和调用形态是否匹配。 [PLAN-014](../../../plans/2026-11-05-forge-iam-structure.md)

## 发现追溯

| 修订项 | 评审发现 |
| --- | --- |
| A1 失效信号 | U6-3、D7-2、S7-3、I8-1、R9-1、K9-1 |
| A2 业务确认与投影 | Z5-1、D7-1、I8-2、K9-2 |
| A3 状态与投影判据 | U6-1、D7-3、S7-2、F7-2、F7-3、R9-2、K9-3、F9-1、F9-2 |
| A4 动态独占检查 | Z5-3、U6-2、D7-4、S7-4、I8-3 |
| A5 通知和终止 | Z5-2、D7-5、I8-4、R9-3、K9-4、K9-5 |
| A6 迁移与实测 | U6-4、I8-5、I8-6、R9-4、R9-5、R9-6、K9-6 |
| A7 取舍与停点 | Z5-4、S7-1、F7-1 |

## 核验范围

Node 24.21.0 下，对 `service`、`late-credentials-hydration`、`gateway-provider-context`、`model-selection-host`、`managed-models`、`session-renewal-view` 和 `iam-view-consumer` 七个既有 `.test.mjs` 文件运行 `node --test --test-timeout=120000`，241 项通过，耗时 7.92 秒。隔离 `DSH_HOME` 和本机宿主路径后运行 `pnpm check`，静态检查通过，5,776 项通过、7 项跳过，耗时 54.40 秒。这是 `bcca688d` 的现有离线基线。方案修订后的回归、合成宿主探针与真实企业环境验收待执行。

[初次整体审查](zoom_out_report.md) · [可理解性审查](comprehension_report.md) · [设计批判审查](critic_report.md) · [中段整体审查](intermediate_zoom_out_report.md) · [实施就绪度审查](implementation_readiness_report.md)

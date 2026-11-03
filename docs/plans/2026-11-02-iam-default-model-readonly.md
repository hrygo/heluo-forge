# IAM 默认模型只读编排实施计划

## 文档信息

| 项 | 内容 |
|---|---|
| 文档编号 | CORP-DSH-PLAN-005 |
| 文档名称 | IAM 默认模型只读编排实施计划 |
| 版本 | V0.1.1 |
| 文档状态 | 草案 |
| 密级 | — |
| 编制 | DSH 平台组（代拟） |
| 审核 | 待定 |
| 批准 | 待定 |
| 最后更新 | 2026-11-02 |
| 门禁 | 源码与隔离模拟；禁止真实模型设置写入 |

> 编制依据：用户于 2026-11-02 明确选择“严格保护，真实 Host 不自动写”。同日只读 SDK 核验确认 currentSelection 没有 explicit 或明确空态，saveSelection 完整覆盖且排队，无条件提交、guard 或取消能力；记录式测试不补足这些契约。
>
> 关联文档：[IAM 模块设计](<../design/plugins/forge-iam.md>)、[验收清单](<../design/README.md#221-iam-离线验收清单>)、[总体架构](<../architecture/platform-architecture.md>)。

## 1. 目标与技术边界

**目标**：把当前孤立的模型判定与 IAM Host 生命周期衔接为只读编排，保留所有真实选择，不授权或执行模型调用。

**方式**：沿用 Node 24.21.0、ESM、node:test、现有服务及 Cordis effect/inject。采用单一源码 writer、逐项 TDD 与独立只读审查，不提交、不安装当前 profile、不增加依赖或修改 DSH 核心。

- 真实路径只读取 llm.listProviders 与 agentDefaultModel.currentSelection，连 saveSelection 属性都不访问；不存在配置开关、失败回落或私有能力注入可解除本轮禁写。
- defaultModel 为空时不启动模型编排；未知、双空串、读取失败、官方旧默认与任何现有选择均不视为自动覆盖许可，reasoningEffort 与其余设置保留。
- 工厂可选依赖只提供上述两个具体 SDK 实例；这是内部组合参数，不是新的 SDK Service、配置、Remote、路由或 Client 字段。
- Host 协调返回固定只读状态，不输出主体、Key、令牌、SDK 原始异常或原始选择。不把计划成功当作模型可调用、人员/用途校验或持久化证明。
- 复用私有认证代际及精确 credentials/SDK 实例检查，避免异步读取的旧结果发布；不新增持久版本、锁、lease、跨进程授权协议或轮询器。
- 合并生命周期触发，但不能形成“读取网关 → notify → 再读取”的自触发循环；getView/getPrincipal 保持只读，不隐式启动编排。
- 独立模拟写入仍使用现有 applyModelSelection 记录式 sink；模拟正向不进入真实 Host 保存分支，也不发明 SDK 空态或原子接口。

## 2. 文件职责与步骤

一个 writer 独占[Host 入口](<../../packages/forge-iam/src/index.mjs>)与[IAM 服务](<../../packages/forge-iam/src/service.mjs>)，必要时新增小型只读协调模块；新增 `test/model-selection-host.test.mjs`。root 维护本计划、用户/开发指南、模块和验收索引；独立 reviewer 不写相同文件。

内部接缝为工厂参数 `getModelSelectionServices()`，同步提供 `{ llm, agentDefaultModel }` 或缺失；这是本包组合函数，不是 SDK 新方法。Host 内部协调方法 `reconcileDefaultModel()` 返回冻结的 `{ mode: 'read-only', written: false, verified: false, reason }`，reason 只取固定枚举；不带原始选择、attempted、主体或异常，也不改动公开 view、HTTP 或 Remote。

### 任务 A：实际 Host 的零写入契约

- [x] 先写失败用例：真实 apply 与 IAM 服务加模拟 ctx，saveSelection 使用一访问即失败的 getter；默认配置、缺 SDK、未 ready、网关不匹配和所有现有选择均不得访问它。
- [x] 执行 RED，确认失败来自未接线，不用虚构 explicit、空态或事务能力制造正向。
- [x] 实现可选 SDK 绑定与只读协调入口，不新增 UI/管理路由，不把模型失败接入 OIDC 回调清理路径。
- [x] 验证 ready、完整现有选择、目标 provider 状态与各种未知结果的固定只读返回，真实设置始终保持原值。

### 任务 B：生命周期与合并触发

- [x] 接入已有 IAM 就绪/网关状态与 llm/adapters-updated；采用已有框架生命周期清理和单飞，不加轮询。
- [x] 用受控 Promise 验证退出、卸载、credentials 或 SDK 替换、旧读取/错误不会发布新上下文结果，已清理监听器不再触发。
- [x] 验证自身读取不自触发循环、重复事件有界合并、getView/getPrincipal 不调用模型 SDK；不依靠 sleep 或真实模型网络。

### 任务 C：交付与验收

- [x] 独立审查禁写边界、生命周期和异常原文；保持已有模型判定与未知结果测试，不能删安全断言换绿测。
- [x] 同步终态文档：真实 Host 只读、模拟写入独立、模型调用授权未接；公开说明剩余机密客户端与执行入口契约仍待确定。
- [x] 完成定向与一次有效全仓检查，关闭真实 macOS keychain spike；只报告实际结果，不宣称生产模型选择或调用已完成。

## 3. 交付判断

本阶段完成的证据是实际 Host 编排与生命周期的模拟回归、真实保存入口零访问、已有设置不变及文档一致。真实自动保存不在本阶段开放范围；只有空态和可靠条件提交能力明确、另行获得授权后才能评审，用户本次选择不授权修改当前 profile。

# IAM 只读状态订阅隔离契约

## 文档信息

| 项 | 内容 |
|---|---|
| 文档编号 | CORP-DSH-IAM-004 |
| 文档名称 | IAM 只读状态订阅隔离契约 |
| 版本 | V0.3.0 |
| 文档状态 | 草案 |
| 密级 | — |
| 编制 | DSH 平台组（代拟） |
| 审核 | 待定 |
| 批准 | 待定 |
| 最后更新 | 2026-11-03 |
| 门禁 | 用户已批准最小 source/mock 范围；私有接缝已实现并完成定向验收；真实注册关闭 |

> 编制依据：用户选择“继续最小订阅隔离实现”。先核接口与访问准入，再实现并验收私有接缝；真实 Remote 注册不在本批。正式团队审核、生产资源声明与真实 Host 准入仍未完成。
>
> 关联文档：[PLAN-008](<../plans/2026-11-03-iam-mock-closeout.md>)、[IAM-003](<iam-consumer-isolated.md>)、[设计索引](<../design/README.md#22-实现与验证入口>)。

## 1. 性质与边界

本契约描述两个私有模块：[观察组](<../../packages/forge-iam/src/iam-view-observer.mjs>)（Host 侧）与[消费者](<../../packages/forge-iam/src/iam-view-consumer.mjs>)（Client 侧纯模块）。二者仅经[测试入口](<../../packages/forge-iam/src/isolated-testing.mjs>)的 `./isolated-testing` 子路径导出，不是 SDK 方法、生产端点或通用授权框架。

| 项 | 本批状态 |
|---|---|
| 观察组、消费者、模拟管理传输 | 已实现并定向验收 |
| 真实 IAM 登录来源 | 沿用实际 [createIamService](<../../packages/forge-iam/src/service.mjs>) 与 mock IdP，不另造登录状态机 |
| 真实 Remote 注册、真实 Host 上下文、资源策略 | 未实施 |
| [插件入口 apply](<../../packages/forge-iam/src/index.mjs>)、[Client 入口](<../../packages/forge-iam/client.js>)、[HTTP 路由](<../../packages/forge-iam/src/routes.mjs>) | 未改动 |
| SDK 依赖、包导出面与清单下限 | 未改动 |

管理面准入与 IAM 登录相互独立：管理用户退出 IAM 后仍能读取登录页。本契约不为真实人员用途、额度或企业授权背书。

## 2. 已核 SDK 形状与私有上下文

依据 rc.2 与 rc.3 的公开协议类型（两份声明相同）：

- `$mount(contribution): Promise<TypertDisposer>`；contribution 为 `{ package, descriptors }`，卸载函数在挂载就绪后才返回，调用时返回 Promise。
- 生成的 stream 方法**同步**返回 `RemoteStreamHandle`，不返回 Promise。该句柄是 AsyncIterable，提供 `dispose(): void`（不是 `cancel()`）；调用即打开逻辑流，提前结束迭代会取消，一个句柄对应一个物理代际。
- Host 的 `Context.invocation` 含 `service`、`peer` 与 `signal`；`peer.principal` 由进程内 Host 固定，wire 字段不能设置。

以上只证明类型层形状，不证明 Gateway 运行实现、全部 `>=rc.2` 版本兼容或真实联调；单消费者是否在 wire 级强制未验证。

模拟管理传输在私有注册表中签发不可伪造的 context，只为当前管理调用建立绑定。校验按以下顺序进行：原 context 对象身份、原 observer 身份、host 标记、principal 一致。异常、Promise、结构副本、其他传输签发的 context、撤销后再次使用均拒绝。撤销使旧 context 永久失效；恢复须签发新 context，旧等待任务不能复活。

## 3. 私有工厂

```ts
createIamViewObserver(iam, {
  verifyManagementContext: (context: object, observer: object) => boolean,
  clock?: { setInterval(callback: () => void, milliseconds: number): unknown;
            clearInterval(handle: unknown): void }
}): {
  observe(context: object, signal?: AbortSignal): AsyncIterable<ReadonlyView>;
  dispose(): Promise<void>;
}

createIamViewConsumer({
  open: (signal: AbortSignal) => RemoteStreamHandle<ReadonlyView, never>,
  accept: (view: ReadonlyView) => void,
  onError?: (failure: Readonly<{ code: string; message: string }>) => void
}): { start(): void; restart(): void; dispose(): Promise<void> }
```

约束：

- `ReadonlyView` 是 §5 白名单的冻结复制品；此处只引用 SDK 句柄形状，不重新定义 SDK 类型。
- `iam` 是测试装配持有的实际工厂实例。校验器独立于 iam，不能来自 iam 属性、管理配置 Boolean 或 DTO；不以 `remoteAccess.allows` 在 Remote 外的默认 true 补造认证。
- 校验器必须同步返回字面量 `true`。Promise、truthy 对象或异步回答一律按未证实处理。
- 每个读周期开始前与每帧交付前，至少一个订阅仍须持有有效管理证明。
- 视图必须是 data-only 纯对象。Host 侧用 `util.types.isProxy` 在任何属性 trap 前拒绝 Proxy；白名单外字段从不读取；访问器按自有描述符拒绝。

## 4. Host 观察组

**生命周期。** 首个获准订阅启动一个组；每个组只持有一个读周期与一个 watch 泵。最后一个订阅退出或 `dispose()` 后停止该组的 timer 与 watch，并使旧代际失效。旧组读尚未结算时，新组的读等其结束后再开始（跨组串行）；旧组停止后的迟到结算不得发布。

**读周期。** 固定 2000ms，顺序为 `syncFromStore → loadGatewayCredential → getView`。不强制 `hydrate()`，不新增刷新逻辑；初始化完成前不发布缓存首帧。

**复验点。** 原方法身份、context、observer 与 principal 在等待前固定；首个 service 调用前、每次 await 后与发布前复验。方法被换绑、许可被撤销或生命周期改变后，不采用旧读，也不借新 context 补票。

**watch 语义。** watch 只唤醒读取当前完整视图，不直接采用其积压快照；周期内通知合并。

**失败与取消。** 失败只终止相关订阅或当前已失效的组，不影响其他消费者。取消与正常卸载静默结束，已排队帧被丢弃，撤销后的旧帧不再交付。

**dispose 语义。** 先封闭启动与采用入口；timer 与 watch 立即停止。不等待无法撤回的外部 I/O；其迟到结算被观察并丢弃，不产生未处理拒绝。

## 5. 视图与 Client 生命周期

**白名单。** 复用当前 [createView](<../../packages/forge-iam/src/state.mjs>) 的 12 个非秘密字段：`state`、`configured`、`signedIn`、`canSignOut`、`canSignIn`、`missing`、`error`、`exclusive`、`principal`、`accessExpiresAt`、`gatewayCredential`、`gatewayConsoleUrl`。

**复制规则。** 只复制自有 data 属性中的字符串、布尔、`null` 与字符串数组；结果冻结。未知字段不读，不调用 getter 或 `toJSON`。已知字段出现访问器、错误类型或额外对象结构时拒绝，不做隐式字符串化。

**gatewayCredential。** 只保留 `state`、`ownerSubject`、`deviceLabel`、`enteredAt`、`suggestedExpiry`、`storage`、`matchesAccount`。缺少的可选字段保持缺少，`null` 保持 `null`。令牌、`ref`、secret、`authorizationUrl`、attempt 与 `lastProbeAt` 不进入输出。

**Client 消费者。**

- `start()` 幂等；`open` 必须同步返回句柄，Promise 按非法句柄拒绝。
- `restart()` 先取消旧代际再开新代际；每次 next 后与 accept 前核对句柄与本地代际。
- 旧帧、旧错误不得覆盖新代际；拒绝与未知不触发 HTTP 降级或自动重放。
- `dispose()` 封闭采用、取消信号、释放句柄并结束自有循环；不声称撤回已发请求。

## 6. 私有错误与验收

固定错误分类：

| code | 含义 |
|---|---|
| `IAM_VIEW_UNVERIFIED` | 管理调用未经证实 |
| `IAM_VIEW_CHANGED` | 等待期间绑定或许可改变 |
| `IAM_VIEW_INVALID` | 视图或句柄形状不符合本契约 |
| `IAM_VIEW_UNKNOWN` | 其他失败 |

只输出固定 code 与 message，不复制外来 body、cause、堆栈或秘密。显式取消与正常卸载静默结束。

必要验收限六组，每组按需合并正反用例，不扩 A—E 矩阵：

1. 拒绝伪造、副本、异步与已撤销的管理上下文，且零 service 调用。
2. 签出状态可读；实际登录后更新为 ready。
3. 双订阅共享一个读周期；末订阅退出清理 timer 与 watch。
4. 撤权、换绑或取消穿越 await 时不再读取、不再发布。
5. 重连或重启后，旧代际迟到结果不得进入 accept。
6. 挂载、单消费者与卸载无自有 timer、watch 或循环残留。

第 6 组包含验收用模拟挂载：卸载只释放该挂载拥有的贡献与逻辑流，不影响其他挂载。

### 6.1 实现证据

| 项 | 结果 |
|---|---|
| 定向用例 | 18 项通过：观察组 12、消费者 6 |
| 受控突变 | 13 处守卫逐项单独删除，只有对应用例行失败；还原后全绿 |
| 完整检查 | 2599 项中 2597 通过、0 失败、0 取消、2 项平台跳过；文档、仓库、打包、版本四段均 `ok` |
| 平台跳过 | macOS 钥匙串 spike（未启用）与 Windows 8.3 别名，均为既有项 |

逐项突变清单、检查命令与审阅状态见 [PLAN-008 §8](<../plans/2026-11-03-iam-mock-closeout.md#8-验收记录>)。该记录不改变真实注册、真实 Host 访问或生产准入的关闭状态。

## 7. 门禁

**已满足（本批）：**

| 事项 | 证据 |
|---|---|
| 用户批准最小 source/mock 范围 | 明确选择“继续最小订阅隔离实现” |
| rc.2/rc.3 公开类型 ABI | 两份协议声明相同、两份 Client 类型声明相同；仅限类型层 |
| 私有接缝实现与定向验收 | 18 项用例、13 处突变、完整检查 2597/2599 通过（2 项平台跳过） |

**仍待确认：**

| 事项 | 责任方（待确认） | 前置条件 |
|---|---|---|
| 真实 Context、资源策略与运行时兼容 | 平台组、SDK 维护方、安全 | 真实 Remote 注册前；本批不实施 |
| 企业 probe、人员用途与资源换票契约 | 相应提供方与安全 | 各自后续设计；本批不混入 |
| 正式团队审核与生产准入 | 平台组、安全 | 任何真实接线前 |

用户批准的是最小隔离范围。定向本地验收已通过，但不代表正式团队审核、真实 Remote 注册或生产准入已经完成。
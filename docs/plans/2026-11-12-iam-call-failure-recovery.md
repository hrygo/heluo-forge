# IAM 调用失败自愈与错误码恢复方案

## 文档信息

| 项 | 内容 |
|---|---|
| 文档编号 | CORP-DSH-PLAN-018 |
| 文档名称 | IAM 调用失败自愈与错误码恢复方案 |
| 版本 | V0.2.0 |
| 文档状态 | 草案 |
| 密级 | — |
| 编制 | DSH 平台组（代拟） |
| 审核 | 待定 |
| 批准 | 待定 |
| 最后更新 | 2026-11-12 |
| 门禁 | 设计评审；以 PR #253 为基线，不改写现有实现状态，不授予生产能力 |
| 文档层级 | L2 实施计划；错误码与字段以设计文档和契约为准 |

> 编制依据：PR #253 head `11b3237`（分支 `codex/credential-storage-clean-arch`）的 `managed-models.mjs`、`service-token.mjs`、`service-gateway.mjs` 与 `gateway-failure.mjs`；2026-11-12 在本机以只读脚本复现的四条失败路径；issue #226 关于跨进程写入的待核实边界。Windows 实机日志未取得，A 类与 B 类的现场归因仍需该证据关闭。

> 关联文档：[IAM 接入详细设计](<../design/plugins/forge-iam.md>)、[凭据存储模式](<../design/credential-modes.md>)、[凭据存储整洁架构实施方案](<2026-11-12-credential-storage-clean-arch.md>)、[PR #253](https://github.com/hrygo/heluo-forge/pull/253)、[issue #226](https://github.com/hrygo/heluo-forge/issues/226)、[issue #259](https://github.com/hrygo/heluo-forge/issues/259)（落地跟踪）。

## 1. 结论与范围

目标不是让分类表多认几个码，而是两件事同时成立：

1. **良性变化不报错**。令牌轮换、同地址换 Key、跨进程写入、模型选择变化，都不应产生用户可见的失败。
2. **真失败可识别**。确实无法继续时，界面给出的码必须指向具体动作，不能落到 `ENTERPRISE_GATEWAY_CALL_FAILED`。

当前实现两层都未达到：派发前的良性变化被当成致命错误，错误又因分类表不认插件码而失去身份。方案按“先不报错、再可识别”排序，先修恢复路径，再修错误映射。

- **做**：会话预检在 AT 仍有效时返回当前令牌；网关绑定只比较地址与主体，不把同地址换 Key 当作上下文变化；绑定变化时在派发前重建并重试一次；流中只检查身份、退出与吊销；把插件 `IamError` 映射为已登记的用户码。
- **不做**：不改 DSH 核心与 pi-ai SDK；不做跨进程原子存储；不修改凭据格式与存储后端；不把重试放到请求已发出之后；不在本方案内完成 Windows 实机取证。
- **安全边界不变**：不向新地址发送旧 Key；不跨主体复用 Key 与令牌；吊销后不再发起新请求。

## 2. 现状与证据

### 2.1 失败漏斗

`resolveApiKey` 在模型请求发出前解析 Key 与 IAM 令牌，两个解析器都可能抛出 `IamError`。`protect()` 捕获后先调用 `refusal()`：只要账号状态仍为 ready、`version` 未变，`refusal()` 返回 `null`，异常随后进入 `classifyFailure()`。分类表只认 `ENTERPRISE_*` 前缀，所有 `IAM_*` 与 `CRED_*` 码都落到兜底：

```text
resolveKey / resolveIamToken 抛出 IamError
  → protect catch
  → refusal() 返回 null（视图仍 ready，version 未变）
  → classifyFailure() 不认该码
  → ENTERPRISE_GATEWAY_CALL_FAILED
```

2026-11-12 的只读复现覆盖四条路径，结果一致：stale adapter generation、`IAM_UNREACHABLE`、`IAM_MODEL_CONTEXT_CHANGED`、`CRED_DECRYPT_FAILED` 全部输出 `ENTERPRISE_GATEWAY_CALL_FAILED`。

### 2.2 A 类：预检窗口

`resolveToken()` 在访问令牌到期前 60 秒进入刷新窗口（`shouldRefresh()`，默认 `refreshSkewSeconds=60`）。窗口内每个请求都先尝试刷新。刷新前的元数据或 JWKS 预检失败时，`resolveToken()` 即使当前 AT 仍有效也会 `throw cause`；代码注释说明 Host 可以重试这次预检，但 `managed-models.mjs` 并不重试。

`resolveGatewayConnection()` 的第一行又是 `await resolveToken()`，因此失败发生在 Key 解析之前。用户看到的是模型调用失败，实际是令牌预检失败。窗口最长 60 秒，期间每个请求都会重复同一失败；网络恢复或重新选择模型触发一次新刷新后恢复，下一次窗口再复发。

### 2.3 B 类：绑定失配

`writeOperationId` 在每次保存网关凭据时生成新的随机 UUID（`store.mjs`），同一个 Key 重新保存也会变。`resolveKey` 把 `next.generation !== connection.generation` 直接当作上下文变化并抛错；`version` 又依赖缓存的网关摘要，跨进程写入不会及时触发 `version++`。于是：

- `refusal()` 认为上下文没变，放行；
- `resolveKey` 认为绑定变了，抛 `IAM_MODEL_CONTEXT_CHANGED`；
- 分类器把它变成 `CALL_FAILED`；
- 旧 adapter 没有被重建，之后每个请求都在同一处失败，直到重选模型或重新登录。

这解释了“重选一次模型就好、之后又复发”的粘性特征。同地址换 Key 本来可以安全使用新 Key，当前却按致命错误处理。

### 2.4 C 类：流中误杀

`protect()` 在流中每个分片后调用 `refusal(request, mine)`。`refusal()` 包含 `captured !== version`，所以模型选择变化、同进程保存凭据都会让一个已经正常输出的回答被 `finish(IAM_MODEL_CONTEXT_CHANGED)` 中止。用户丢掉已经生成的内容，错误码却指向账号或凭证。

### 2.5 D 类：重建中止

`refresh()` 的失败分支只在 `mine === version && !disposed` 时处理。刷新过程中上下文变化会让本次刷新静默作废，旧 `backend` 保留，也没有为新版本补一次重建。下一次请求继续使用过期 adapter，落入 B 类。

## 3. 目标行为

| 变化 | 判定 | 动作 | 用户可见 |
|---|---|---|---|
| 预检失败，AT 仍有效 | 会话仍可用 | 返回当前 AT，后台按退避重试 | 无错误 |
| 预检失败，AT 已过期 | 无法继续 | 等待一次刷新；失败则报认证服务不可达 | `ENTERPRISE_IAM_UNAVAILABLE` |
| 同地址换 Key | 绑定未变 | 直接使用新 Key，更新本地快照 | 无错误 |
| 网关地址或主体变化 | 绑定已变 | 单飞重建，派发前重试一次 | 无错误；重建失败才报错 |
| 主体变化或退出 | 身份已变 | 不发送，不重试 | `IAM_LOGIN_REQUIRED` |
| 流中模型选择变化 | 授权未变 | 让当前回答完成 | 无错误 |
| 流中凭据吊销 | 授权已变 | 中止 | `ENTERPRISE_GATEWAY_CREDENTIAL_REVOKED` |
| 真的上游失败 | 无法归类 | 保留既有分类 | 既有网关错误码 |

## 4. 设计

### 4.1 派发前重试边界

`resolveApiKey` 在请求构造与发送之前执行。此时抛出只说明“还没发出去”，重试不会重复计费，也不会产生两条模型请求。方案把重试限定在这一阶段，并用两个条件守住边界：

- `emitted === false`：`protect()` 尚未产出任何分片；一旦产出，禁止重试。
- 错误码必须是插件自己抛出的 `IAM_GATEWAY_BINDING_CHANGED`；其他异常不重试。

重试预算为一次。重建走模型目录 `refresh()` 单飞；等待上限 5 秒，超时按 `ENTERPRISE_GATEWAY_UNAVAILABLE` 处理。请求已取消时不再重试。

### 4.2 绑定快照

`resolveGatewayConnection()` 返回 `{ key, baseURL, generation, subject }`。运行时保存的绑定快照是 `{ baseURL, subject }`：

- `generation` 只是 Key 的写入版本，同地址换 Key 时允许变化，并在本地更新快照。
- `baseURL` 或 `subject` 变化才视为绑定变化。地址变化必须重建 adapter；主体变化必须重新登录。
- 两个 `resolveKey` 闭包（`createAdapter` 与 `applyOptions` 重建）共用一个 `sameBinding()` 与一个可变的 `connection` 持有者，避免两处判断继续分叉。

`baseURL` 使用与 `resolveGatewayConnection()` 相同的规范化结果，不新增第二套比较规则。

### 4.3 认证与上下文分离

流中的检查拆成两个函数：

- `refusal()`：流开始前使用，保留 `version`、`backend`、`allowed` 全部检查，拒绝过期 prepared call。
- `authorizationRefusal()`：流中使用，只检查 `disposed`、`permit()`、`revokedCredential` 与主体。模型选择与 Key 轮换不中止已经开始的回答。

`prepareCall` 与 `stream` 之间发生选择变化时，若模型仍被允许，优先重新准备而不是直接报 `IAM_MODEL_CONTEXT_CHANGED`；只有重新准备失败才报错。

### 4.4 错误分类

`protect()` 的 catch 与 finish-failure 分支统一走 `failureCode(cause)`：

1. `refusal()` 已给出码时用该码。
2. 插件 `IamError` 按显式映射表转换。
3. 其他异常交给既有 `classifyFailure()`。

映射表的键覆盖 `ERROR_STATUS` 中的全部 IAM 与 CRED 码。测试遍历该表并要求每个键都有映射，新增码未决定去向时测试失败，避免再次出现静默兜底。

### 4.5 自愈

- 同地址换 Key：不重建，直接采用新 Key。
- 绑定变化：`protect()` 捕获 `IAM_GATEWAY_BINDING_CHANGED`，`await refresh()`，调用 `redispatch()`，再试一次。
- `prepareCall` 路径：`redispatch()` 重新执行 `backend.prepareCall()` 并替换闭包里的 `prepared`；否则重试仍会走旧 prepared。
- `llm/stream` 路径：`dispatch` 在调用时读取当前 `backend`，刷新后自然切换。
- `refresh()` 在 `mine !== version` 时，为当前版本补一次有界重建；成功或达到次数上限后停止。

## 5. 分阶段改动

### P0-1 会话预检返回有效 AT

文件：`packages/forge-iam/src/service-token.mjs`。

在 `retryablePreflight` 分支中，`ctx.state === 'ready'` 且 `isAccessExpired(ctx.lastGrant, now()) === false` 时，先 `scheduleRenewal({ retry: true })`，再 `return ctx.lastGrant.accessToken`，不抛错。AT 已过期或状态为 `expired` 时保留现有 `throw cause`。

验收：时钟拨到到期前 30 秒，元数据请求失败，`getAccessToken()` 返回当前 AT；模型请求继续，后台出现一次续期重试；AT 过期后同一失败返回 `ENTERPRISE_IAM_UNAVAILABLE`。

### P0-2 绑定比较与同地址换 Key

文件：`packages/forge-iam/src/service-gateway.mjs`、`packages/forge-iam/src/managed-models.mjs`。

- `resolveConnection()` 返回值增加 `subject`。
- 新增 `sameBinding(a, b)`，比较规范化后的 `baseURL` 与 `subject`。
- `createAdapter` 与 `applyOptions` 两处 `resolveKey`：`requestVersion !== version` 仍抛 `IAM_MODEL_CONTEXT_CHANGED`；`sameBinding` 为真但 `generation` 不同则采用 `next.key` 并更新 `connection`；`sameBinding` 为假则抛 `IAM_GATEWAY_BINDING_CHANGED`，附 `retryable: true`。
- `connection` 由 `const` 改为可更新的持有者。

验收：同地址换 Key 后首个请求成功，且不再使用旧 Key；地址变化触发一次重建，重试后成功；主体变化直接返回 `IAM_LOGIN_REQUIRED`。

### P0-3 派发前重建与一次重试

文件：`packages/forge-iam/src/managed-models.mjs`。

- `protect(request, dispatch, captured, redispatch)` 增加 `emitted` 标志与一次重试。
- catch 中仅当 `!emitted`、错误码为 `IAM_GATEWAY_BINDING_CHANGED`、尝试次数为 0 时，`await refresh()` 并调用 `redispatch?.()`，然后重新进入循环。
- `prepareCall` 的 `stream` 传入 `redispatch`，重新构建 `prepared`；`llm/stream` 路径不传，`dispatch` 自己读取 `backend`。
- `refresh()` 失败时直接映射其错误码，不再尝试第二次。
- 请求 signal 已取消时不重试。

验收：绑定变化只产生一次模型请求；重试后成功时没有失败分片；重建失败时返回具体码；取消后不出现第二次派发。

### P0-4 流中只查授权

文件：`packages/forge-iam/src/managed-models.mjs`。

新增 `authorizationRefusal(request)`，流中与流结束后的检查改用它。保留 `disposed`、`permit()`、`revokedCredential`、主体检查；移除 `captured !== version`、`backend` 与 `allowed`。

验收：流中切换模型选择，回答完整结束；流中退出登录，回答中止并返回 `IAM_LOGIN_REQUIRED`；流中吊销凭据，返回 `ENTERPRISE_GATEWAY_CREDENTIAL_REVOKED`。

### P0-5 错误码映射

文件：`packages/forge-iam/src/gateway-failure.mjs`、`packages/forge-iam/src/managed-models.mjs`、`packages/forge-iam/src/error-contract.mjs`。

- 新增 `failureCode(cause)`，先看 `refusal()`，再查 IAM 映射，最后 `classifyFailure()`。
- 映射至少覆盖：`IAM_MODEL_CONTEXT_CHANGED` → 自身；`IAM_GATEWAY_CREDENTIAL_REQUIRED` → 自身；`IAM_LOGIN_REQUIRED` / `IAM_NOT_SIGNED_IN` / `IAM_REAUTH_REQUIRED` → `IAM_LOGIN_REQUIRED`；`IAM_UNREACHABLE` / `IAM_HTTP_ERROR` → `ENTERPRISE_IAM_UNAVAILABLE`；`CRED_KEY_UNAVAILABLE` / `CRED_DECRYPT_FAILED` / `IAM_CREDENTIALS_UNAVAILABLE` → `ENTERPRISE_CREDENTIAL_STORAGE_UNAVAILABLE`；`IAM_DISPOSED` / `IAM_EXCLUSIVE_CONFLICT` → `ENTERPRISE_MODELS_UNAVAILABLE`；`IAM_GATEWAY_URL_INVALID` → 自身。
- 新码登记到 `ERROR_STATUS` 与 `MESSAGES`，并同步设计文档 §8.1.2 的用户可见码表。
- 不把真实异常文本放进错误体；`detailCode` 仅记录到调试日志，是否进入 failure 对象待宿主确认。

验收：`ERROR_STATUS` 中每个 IAM 与 CRED 码都能映射到一个已登记用户码；`ENTERPRISE_GATEWAY_CALL_FAILED` 只出现在真正的未知异常上。

### P1-1 解耦 Key 解析与令牌刷新

文件：`packages/forge-iam/src/service-gateway.mjs`。

`resolveConnection()` 不再以 `await resolveToken()` 作为前置。改为检查当前会话是否可继续（`lastGrant` 存在、主体一致、刷新令牌可用），把刷新交给随后的 `resolveIamToken()`。AT 过期但可刷新时，Key 仍可解析；刷新失败时由 `resolveIamToken()` 返回具体码。

验收：AT 过期且可刷新时，Key 解析成功、令牌刷新一次；刷新失败时错误码来自令牌层，而不是 Key 层。

### P1-2 重建中止补偿

文件：`packages/forge-iam/src/managed-models.mjs`。

`refresh()` 的 catch 在 `mine !== version` 且未销毁时，为当前版本安排一次重建；用 `refreshRequestedVersion` 去重，避免循环。达到上限后停止并记录调试日志。

验收：刷新期间发生选择变化，下一次请求使用新 backend；不会出现无限重建。

### P1-3 诊断字段

在确认宿主 `finish` 解析器容忍额外字段后，为 failure 增加非敏感 `detailCode`（插件内部码）。若宿主拒绝，退回结构化日志，不修改 failure 形状。

## 6. 错误码与文案

| 内部码 | 用户码 | 文案 | 状态 |
|---|---|---|---|
| `IAM_UNREACHABLE`、`IAM_HTTP_ERROR` | `ENTERPRISE_IAM_UNAVAILABLE`（新） | 企业认证服务暂不可达，请稍后重试。 | 503 |
| `CRED_KEY_UNAVAILABLE`、`CRED_DECRYPT_FAILED`、`IAM_CREDENTIALS_UNAVAILABLE` | `ENTERPRISE_CREDENTIAL_STORAGE_UNAVAILABLE`（新） | 凭据安全存储暂不可用，请检查系统密钥环或联系管理员。 | 503 |
| `IAM_MODEL_CONTEXT_CHANGED`、`IAM_GATEWAY_BINDING_CHANGED` | `IAM_MODEL_CONTEXT_CHANGED` | 账号或凭证已变化，请重新选择模型后再试。 | 409 |
| `IAM_NOT_SIGNED_IN`、`IAM_REAUTH_REQUIRED` | `IAM_LOGIN_REQUIRED` | 企业账号已退出或登录已过期，请重新登录后再使用模型。 | 401 |
| `IAM_DISPOSED`、`IAM_EXCLUSIVE_CONFLICT` | `ENTERPRISE_MODELS_UNAVAILABLE` | 企业模型暂不可用，请联系管理员检查配置。 | 503 |
| `IAM_GATEWAY_URL_INVALID` | 自身 | 请先设置网关地址。 | 400 |

`ENTERPRISE_GATEWAY_CALL_FAILED` 保留为未知异常兜底，但不再承接任何已登记的 IAM 或 CRED 码。

## 7. 测试与验收

### 7.1 自动化用例

| 场景 | 断言 |
|---|---|
| 到期前 30 秒预检失败 | 返回当前 AT；请求成功；出现一次续期重试 |
| AT 过期且预检失败 | 返回 `ENTERPRISE_IAM_UNAVAILABLE`，不返回旧 AT |
| 同地址换 Key | 请求成功；使用新 Key；无失败分片 |
| 地址变化 | `refresh()` 调用一次；重试一次后成功 |
| 地址变化且重建失败 | 返回具体码，不出现 `CALL_FAILED` |
| 主体变化 | `IAM_LOGIN_REQUIRED`，零次模型请求 |
| 流中切换模型 | 回答完整结束 |
| 流中退出登录 | 中止并返回 `IAM_LOGIN_REQUIRED` |
| 首个分片后绑定变化 | 不重试，按当前回答结束或既有错误处理 |
| `prepareCall` 路径绑定变化 | 重新准备并成功；只产生一次模型请求 |
| 取消信号在重试前触发 | 不出现第二次派发 |
| 映射表完备性 | `ERROR_STATUS` 中每个 IAM 与 CRED 码都有用户码 |

### 7.2 变异证明

分别移除预检回退、`sameBinding`、`redispatch` 与映射表，对应用例必须失败；不能只靠新增用例通过来证明。

### 7.3 手工验收

Windows 目标机至少覆盖：

- 令牌到期前 60 秒内断网，再恢复：请求不报错，或只出现一次可恢复的认证错误。
- 在设置中重新保存同一个 Key：进行中的对话不中断。
- 另一进程改写网关凭据后发起请求：首个请求自动重建，不出现 `CALL_FAILED`。
- 对话进行中切换模型：回答不中断。

Windows 实机未取证前，上述结论标记为未验证。

### 7.4 命令

```sh
node --test packages/forge-iam/test
pnpm check:repo
git diff --check
```

## 8. 落地顺序与回滚

1. 本文档 PR 合并，登记 `CORP-DSH-PLAN-018`。
2. P0-1 到 P0-5 在 PR #253 分支上实现，PR 描述引用本计划与跟踪 issue。
3. P1-1 到 P1-3 单独提交，便于回退。
4. 合并顺序：先文档，后实现；实现 PR 仍以 PR #253 为基线，PR #253 的 review-fixes 未提交改动合入前先 rebase。

不引入配置开关。回滚以提交为单位撤销；错误码为新增，删除映射不会破坏既有客户端，但会回到 `CALL_FAILED`，因此回滚需同时保留 P0-5。

## 9. 风险与未验证

- 重试仅限派发前。若未来适配器把 Key 解析移到发送之后，`emitted` 守卫必须同步调整，否则可能重复请求。
- `refresh()` 最长等待 5 秒，慢网下会增加首字延迟；选择这一上限是为了避免请求悬挂。
- 同地址换 Key 的前提是 `baseURL` 规范化可靠。若同一 URL 背后换了网关，旧 Key 会得到 401，按 `ENTERPRISE_GATEWAY_CREDENTIAL_REJECTED` 处理。
- 预检失败时返回仍有效的 AT 是安全的，但服务端可能已撤销该 AT；网关的 401 仍是最终判据。
- 跨进程写入仍是最终一致；自愈覆盖首个请求，不承诺无锁原子性。
- Windows、麒麟与 Electron 宿主未按本方案取证。

## 10. 待确认

| 问题 | 责任方 | 截止门禁 | 现状 |
|---|---|---|---|
| 宿主 `finish` 是否接受额外 `detailCode` 字段 | 宿主适配层 | P1-3 开始前 | 按客户端契约保持 `{ code, message }`，内部码经宿主调试日志记录（P1-3 回退路径） |
| 流中凭据吊销是否必须中止已开始的回答 | 产品与安全 | P0-4 评审 | 是：`authorizationRefusal()` 保留吊销中止 |
| PR #253 的 review-fixes 是否先合入 | 实现负责人 | 实现 PR 创建前 | PR #253 已合入 main（`ce19a34`）；实现基线取 `origin/main` `5e026a2` |
| Windows 实机由谁提供日志与复现 | 试点支持 | 验收前 | 未取得，§7.3 手工矩阵未执行 |

## 11. 附图

同目录 [HTML 版](<2026-11-12-iam-call-failure-recovery.html>) 为评审视图，控制稿为本文。两者冲突时以本文为准；状态、门禁与未验证项只以本文为准。

## 12. 实施与验证记录

P0-1～P0-5、P1-1、P1-2 已落地；P1-3 采用“failure 形状不变、内部码走宿主调试日志”的回退路径。基线为 `origin/main` `5e026a2`（含 PR #253 `ce19a34` 与 PR #258 方案文档）。

### 12.1 落地清单

| 项 | 文件 | 落地内容 |
|---|---|---|
| P0-1 | `packages/forge-iam/src/service-token.mjs` | `retryablePreflight` 分支在 AT 未过期时先按退避安排续期再返回当前 AT；AT 过期或状态非 ready 时保留原错误 |
| P0-2 | `packages/forge-iam/src/service-gateway.mjs`、`src/managed-models.mjs` | `resolveConnection()` 返回 `subject`；新增 `sameBinding()` 只比较规范化地址与主体；同地址换 Key 直接采用新 Key，地址变化抛内部码 `IAM_GATEWAY_BINDING_CHANGED`（`ERROR_STATUS` 409），主体变化按登录失效处理 |
| P0-3 | `packages/forge-iam/src/managed-models.mjs` | `protect()` 增加 `emitted` 守卫、一次重试预算与 `redispatch`；仅派发前、未产出分片、原因为 `IAM_GATEWAY_BINDING_CHANGED`、请求未取消时重建并重试；重建等待上限 5 秒 |
| P0-4 | `packages/forge-iam/src/managed-models.mjs` | 新增 `authorizationRefusal()` 供流中使用，只查销毁、账号与凭据、吊销与主体；`prepareCall` 与 `stream` 间的代际变化改为重新准备一次 |
| P0-5 | `src/gateway-failure.mjs`、`src/managed-models.mjs`、`src/error-contract.mjs`、`client.js` | 新增 `failureCode()` 与 `USER_CODE_BY_INTERNAL`（覆盖 `ERROR_STATUS` 全部 `IAM_*`／`CRED_*` 码）；登记 `ENTERPRISE_IAM_UNAVAILABLE`、`ENTERPRISE_CREDENTIAL_STORAGE_UNAVAILABLE`、`IAM_GATEWAY_BINDING_CHANGED`；客户端文案与宿主同步 |
| P1-1 | `packages/forge-iam/src/service-gateway.mjs` | `resolveConnection()` 只在冷启动（内存无 grant）时读取会话，不再以 `resolveToken()` 为前置；续期可用即视为会话可继续 |
| P1-2 | `packages/forge-iam/src/managed-models.mjs` | `refresh()` 因上下文变化作废时，为当前版本补一次重建；按版本去重，连续最多 3 次 |
| P1-3 | `packages/forge-iam/src/managed-models.mjs`、`src/index.mjs` | failure 形状保持 `{ code, message }`；被映射的内部码经 `logFailure` 写入宿主调试日志 |

### 12.2 自动化验证

| 命令 | 结果 |
|---|---|
| `node --test`（`packages/forge-iam`） | 1564 通过、0 失败（新增 17 项：`iam-call-recovery` 14 项、`gateway-failure` 3 项） |
| `node scripts/check-docs.mjs` | `docs: ok`（157 文件、1048 表格、1226 本地链接、165 片段、46 受控文档） |
| `node scripts/check-repo.mjs` | 通过 |
| `node scripts/dsh-version.mjs check` | 通过 |
| `node --test`（仓库根） | 全量通过 |
| `git diff --check` | 无输出 |

### 12.3 变异证明

| 变异 | 实测转红的用例 |
|---|---|
| 删除预检回退（AT 仍有效时不返回） | `preflight-retry-lifecycle`：adopted rotation（valid／expired access）、view notification 后保留重试；`login`：prefetch failure serves the still-valid access token |
| `sameBinding` 恒真（不再比较地址与主体） | `iam-call-recovery`：地址变化重建并重试、重建失败返回具体码、prepared call 重新准备 |
| 移除派发前重建与一次重试 | 同上三项 |
| 移除内部码→用户码映射 | `gateway-failure`：映射完备性、已知码不落兜底、用户码直通；`iam-call-recovery`：主体变化、IAM 令牌失败、凭据存储失败、映射日志 |

### 12.4 未验证项

- Windows 目标机 §7.3 手工矩阵未执行：当前无 Windows 目标机，A/B 类现场归因仍待该证据关闭。
- 企业真实 IAM 与网关未联调：结论来自离线用例与本地 mock。
- 宿主是否实际输出 `iam` 调试日志未在真机确认。
- 跨进程写入仍为最终一致，仅保证首个请求自愈。

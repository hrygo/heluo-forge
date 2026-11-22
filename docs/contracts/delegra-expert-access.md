# Delegra 专家智能体员工访问与受限受理契约

## 文档信息

| 项 | 内容 |
| --- | --- |
| 文档编号 | CORP-DSH-EXPERT-001 |
| 文档名称 | Delegra 专家智能体员工访问与受限受理契约 |
| 版本 | V0.1.0 |
| 文档状态 | 草案 |
| 密级 | — |
| 编制 | Agent（代拟） |
| 负责 | 平台组（代拟） |
| 审核 | 待定 |
| 批准 | 待定 |
| 最后更新 | 2026-11-22 |
| 门禁 | 由 #244 目标环境与角色矩阵实测冻结；管理包建包前须完成目录与授权连续性取证，真实委派开放前须完成私有任务与原子受理取证 |

> 编制依据：依据 [Forge 专家智能体 PRD](../requirements/delegra-experts-prd.md)（V0.10.0）、[Forge 专家智能体接入方案](../plans/2026-11-18-forge-experts-integration-proposal.md)（V0.4.0）、[Forge 专家智能体管理插件详细设计](../design/plugins/forge-experts.md)（V0.6.0）以及 2026-11-18 / 2026-11-20 对 Delegra `deploy/v2026.1106.0-r2`（`25c86a283a9c787a01911c714618d78df7552af7`）的固定版本源码核验起草。本文当前为待企业环境与 Delegra 维护方会签的契约草案，不代表目标云端接口已上线或通过企业联调。
>
> 关联文档：[专家 PRD](../requirements/delegra-experts-prd.md)、[专家接入方案](../plans/2026-11-18-forge-experts-integration-proposal.md)、[管理插件详细设计](../design/plugins/forge-experts.md)、[需求与场景基线 §4.4](../requirements/requirements-baseline.md#44-数据与合规约束)、[Issue #244](https://github.com/hrygo/heluo-forge/issues/244)。

## 1. 定位、适用范围与责任边界

本契约定义 `@heluo/forge-experts`（DSH 独立安装单元，Host 侧）与 Delegra 云端受限员工 API 之间的逻辑操作、字段语义、授权连续性、私有任务可见性、原子受理、回查对账及错误码规范。

- **Delegra 持有权威事实**：员工与组织映射、逐专家查看/调用权限、专家接单状态、可披露能力与权限摘要、私有任务可见性、运行上下文隔离及任务生命周期均由 Delegra 服务端独立裁决。
- **DSH Host 仅持有个人偏好与短期投影**：Host 通过本契约按需读取目录与范围资格，仅在本机 `storageDomain` 持久保存员工个人启停偏好及 #247 最小请求关联，不得将本地缓存或前端筛选当作授权凭证。
- **分阶段准入**：第 2–5 节及第 8 节对应目录部分为 `@heluo/forge-experts` 管理包（#246）前置门禁；第 6–7 节及第 8 节对应受理与回查部分为生产 `@` 点选与真实委派（#245、#246、#247）前置门禁。

## 2. 员工身份与作用域绑定

### 2.1 专用凭据校验

所有受限员工 API 均由 DSH Host 通过服务端专用凭据通道调用，禁止使用共享管理员密钥、Agent API Key 或浏览器直连凭据替代真实员工身份。

| 校验项 | 服务端强制要求 | 不满足时的行为 |
| --- | --- | --- |
| 签发方与受众 | 核验凭据 `issuer`、`audience` 属于已备案的企业身份源与目标 Delegra 实例 | 拒绝并返回 `401 EXPERT_AUTH_INVALID` |
| 有效期与撤销 | 核验令牌未过期、未被撤销，且员工仍具备目标组织有效成员资格 | 拒绝并返回 `401 EXPERT_AUTH_REVOKED` 或 `403 EXPERT_ORG_FORBIDDEN` |
| 实例与组织绑定 | 从已核验凭据与可信目录映射解析唯一 `(instanceId, orgId, issuer, subject)`，忽略请求体或请求头中客户端自报的身份字段 | 作用域缺失或不匹配时返回 `403 EXPERT_SCOPE_MISMATCH`，响应体不包含任何受限字段 |

### 2.2 响应作用域信封

所有成功响应必须回传服务端核验后的权威作用域信封 `scope`，供 DSH Host 在发布投影或保存偏好前二次核对：

```json
{
  "scope": {
    "instanceId": "delegra-prod-cn-01",
    "orgId": "org_01J9X...",
    "issuer": "https://iam.corp.example",
    "subject": "emp_10086",
    "verifiedAt": "2026-11-22T12:00:00Z",
    "validUntil": "2026-11-22T12:05:00Z"
  }
}
```

- `validUntil` 给出本次授权与目录投影的最大有效截止时间；超过该时间后 Host 必须暂停依赖旧快照的 `@` 候选并重新读取。
- 若响应中的 `scope` 与 Host 当前活跃会话的 `(instanceId, orgId, issuer, subject)` 任一字段不一致，Host 必须直接丢弃响应并拒绝写入。

## 3. 专家目录、能力摘要、调用资格与接单状态

### 3.1 组织内目录查询

`GET /api/v1/employee/experts`

| 查询参数 | 必填 | 说明 |
| --- | --- | --- |
| `orgId` | 是 | 目标组织标识，须与员工当前获准访问的组织一致 |
| `view` | 是 | `directory`（当前员工获准查看的全部专家）或 `callable`（所选组织内至少在一个有效委派范围内具备调用资格的专家） |
| `query` | 否 | 按名称、职责关键词筛选，仅在服务端授权过滤后的结果集内匹配 |
| `cursor` | 否 | 上一页返回的不透明分页游标 |
| `limit` | 否 | 单页上限，默认 `50`，最大 `100` |

单条专家记录契约：

```json
{
  "expertId": "exp_01J9Y...",
  "displayName": "经营分析专家",
  "disambiguation": "财务经营分析组 · 只读报表",
  "summary": {
    "disclosureState": "available",
    "responsibility": "整理与解释获准访问的月度经营报表",
    "capabilities": ["经营指标拆解", "同比环比异常归因"],
    "toolScope": ["bi-report:read"],
    "updatedAt": "2026-11-20T08:00:00Z"
  },
  "access": {
    "readable": true,
    "callableInOrg": true,
    "callableReason": "granted",
    "authContinuityDigest": "sha256:9f86d081..."
  },
  "availability": {
    "acceptingTasks": "accepting",
    "reason": null
  }
}
```

字段约束：

- **稳定标识与同名区分**：`expertId` 在实例内全局稳定，客户端与偏好存储一律按 `expertId` 绑定；存在同名专家时，服务端应提供获准披露的 `disambiguation`（如岗位/团队短标签），不得依赖名称匹配。
- **能力与权限摘要**：`summary.disclosureState` 取值限定为 `available`、`missing`、`stale`、`restricted`；非 `available` 时客户端必须如实提示，不得用专家名称推断或补全工具权限。摘要仅作选择参考，不构成调用或工具授权凭证。
- **查看、调用与接单分离**：
  - `access.readable` 对应目录可见权（对标 `agent:read` 语义）；
  - `access.callableInOrg` 表示该员工在所选组织内至少存在一个有效委派范围具备调用资格（对标 `tasks:assign` 等效授权），`callableReason` 取 `granted | view_only | org_restricted | revoked | unknown`；
  - `availability.acceptingTasks` 独立表示专家当前接单状态，取 `accepting | paused | unavailable | unknown`。仅暂停接单（`paused`）但仍具备 `callableInOrg: true` 的专家，须保留在「可调用」管理视图中允许员工管理启停，但不进入 `@` 候选。

### 3.2 会话委派范围资格核验

`POST /api/v1/employee/experts/scope-check`

用于 `@` 候选投影与发送前复验。员工在项目 A 具备调用资格时，在项目 B 可能只有查看权；仅凭组织级目录不得直接生成会话级 `@` 候选。

- **输入**：`orgId`、`delegationScope`（当前 DSH 会话对应的项目或业务委派范围标识）、`expertIds`（当前员工在本机已启用的专家 ID 列表，单次上限 `100`）。
- **输出**：返回 `scope`、`scopeVerified`（布尔）、`validUntil` 以及逐专家结果数组：
  - `{ expertId, callableInScope, callableReason, acceptingTasks, authContinuityDigest }`。
- **范围证据缺失**：当服务端无法确认 `delegationScope` 或该范围不合法时，返回 `scopeVerified: false` 或 `409 EXPERT_SCOPE_UNVERIFIED`，Host 必须暂停该会话的专家 `@` 候选，不得回落到组织级目录放行。

## 4. 分页完整性与游标契约

目录响应必须显式携带完整性元数据，禁止把截断页或部分失败伪装为完整目录：

```json
{
  "catalogVersion": "cv_20261122_0042",
  "completeness": "complete",
  "coveredScopes": ["org_01J9X..."],
  "items": [],
  "page": {
    "nextCursor": null,
    "hasMore": false
  }
}
```

- **游标绑定**：`nextCursor` 必须由服务端签名或不透明绑定 `(instanceId, orgId, issuer, subject, view, query, catalogVersion)`。跨账号、跨组织、改筛选条件或目录版本切换时提交旧游标，服务端必须拒绝并返回 `409 EXPERT_CURSOR_STALE`。
- **完整性枚举**：`completeness` 取值限定为：
  - `complete`：本次查询已完整覆盖所请求的组织与视图范围；
  - `partial`：后端分片或下游权限源部分不可用，当前列表存在缺项；
  - `truncated`：受单次结果上限截断，需缩小搜索词或继续翻页；
  - `unknown`：无法证明覆盖完整性。
- **不完整时的保护语义**：当 `completeness !== 'complete'` 或分页尚未走完时，DSH Host 必须保留本机既有偏好记录（不得误判为撤权删除），同时在界面明示实际覆盖范围并暂停未获确认的启停动作与候选。

## 5. 授权连续性与撤权收敛语义

为满足“首次使用、新获调用权与组织内全量撤权后重授均须手动重新启用，而单项目范围变化保留组织内启用偏好”的产品规则，服务端必须为每位具备 `callableInOrg: true` 的专家提供可核验的 `authContinuityDigest`（或单调递进的组织级授权连续性令牌）：

| 授权变化场景 | 服务端 `authContinuityDigest` 行为 | DSH Host 行为 |
| --- | --- | --- |
| 持续具备组织内调用资格（含单个项目 A → B 增减） | 保持同一 `authContinuityDigest` 不变 | 保留本机 `enabled` 偏好，仅按 `scope-check` 更新受影响会话的 `@` 候选 |
| 员工在该组织内失去该专家的全部调用资格 | 返回 `callableInOrg: false`、`callableReason: "revoked"`，作废原连续性摘要 | Host 立即作废本机启用状态与 `editToken`，按写序持久更新为未启用 |
| 全量撤权后重新授予组织内调用资格 | 生成全新且不可复用旧值的 `authContinuityDigest` | Host 检测到摘要断裂，视作新获权专家，**默认未启用**，须员工手动点击启用 |
| 目录暂不可用或离线恢复后无法证明连续性 | 返回 `503 EXPERT_DIRECTORY_UNAVAILABLE` 或 `authContinuityDigest: null` | Host 保留原记录但收紧候选；无法确认连续性时要求员工重新启用 |

- **撤权收敛时限**：目标环境须实测并冻结从企业权限源撤权到 Delegra 目录、范围核验、任务受理、结果回查及实时推送全部拒绝的最大收敛窗口（记入 #244 实测记录）。
- **实时通道复验**：若提供长连接或事件订阅，服务端在每次事件投递与重连订阅时均须重新核验当前员工与组织授权，不得沿用连接建立时的旧权限快照。

## 6. 私有任务可见性、上下文隔离与显式复用

### 6.1 默认私有可见性与全路径 ACL 过滤

所有经受限员工 API 创建的专家任务必须在创建事务中强制写入：

- `visibility = "private"`
- `responsibleUserId = <verified employee subject>`
- `originClient = "dsh"` 与 `originSessionRef`（仅作会话归属关联，不作为权限凭据）

针对固定版本 `deploy/v2026.1106.0-r2` 本机复核中发现的通用运行列表泄漏脱敏条目问题，本契约强制要求以下全部入口在分页、聚合与推送**之前**执行同一套私有记录 ACL 过滤：

1. 受限员工专用接口（任务详情、状态、结果、产物、追问、取消）；
2. Delegra 通用任务详情、任务列表、全文与精确搜索；
3. 通用运行历史（`heartbeat-runs`）、实时运行列表（`live-runs`）、运行事件流与 WebSocket 广播；
4. 评论、附件/产物下载、用量与费用明细视图。

除发起员工本人及按企业合规规则明确获授审计范围的管理/审计主体外，同组织其他普通成员、未获权 Agent 均不得看到任务正文，亦不得看到任何包含运行 ID、耗时、费用或用量的脱敏条目；直接按 ID 访问时统一返回 `404 EXPERT_TASK_NOT_FOUND`。通用分享与改派接口必须拒绝扩大专家任务的可见范围或变更 `responsibleUserId`。

### 6.2 跨会话上下文隔离与显式复用

- **默认隔离**：同一员工在不同 DSH 会话（或同一 DSH 会话发起的两次独立新委派）调用同一专家时，服务端必须分配独立的私有任务与独立的运行上下文（覆盖真实模型线程、工作区、可变记忆、工具缓存及运行凭据），禁止将其他会话的历史消息或资料自动带入本次运行。
- **同任务追问**：仅当员工对同一 `taskId` 发起显式追问并通过当前授权复验时，才沿用该任务的上下文并按任务串行排队。
- **运行代次围栏**：每次实际执行绑定单调 `runGeneration`；旧代次运行迟到的结果、状态更新、交互确认或工具回调必须被服务端拒绝。
- **显式复用**：仅在请求携带员工明确选定且服务端确认当前仍获准读取的来源引用时，以只读快照方式导入新上下文并保留来源标注，不得建立可写共享历史。
- **无法证明隔离时的阻断**：若目标运行器无法验证跨任务上下文隔离，服务端必须拒绝开放受限受理入口并返回 `503 EXPERT_ISOLATION_UNVERIFIED`。

## 7. 原子受理、幂等回执与授权回查

### 7.1 原子创建与受理

`POST /api/v1/employee/expert-tasks`

- **请求关键字段**：
  - `orgId`、`expertId`、`delegationScope`
  - `requestId`（由 DSH Host 在首次发送前持久化的稳定 UUID，用于 #247 关联与对账）
  - `originSessionRef`（DSH 原会话关联标识）
  - `taskText`（员工确认提交的规范化任务文本）
  - `payloadDigest`（覆盖 `expertId`、`delegationScope`、`taskText` 与显式复用引用的 SHA-256 摘要）
  - `reuseRefs`（可选，员工明确选择的获权复用引用列表）
- **单一数据库事务**：服务端必须在**同一个事务**内完成三项写入并返回确认回执，不允许出现“任务已创建但回执或派发意图未落盘”的分裂态：
  1. 写入 `visibility=private` 的专家任务及归属元数据；
  2. 写入幂等回执记录（键为 `(orgId, issuer, subject, "create_task", requestId)`，绑定 `payloadDigest` 与 `taskId`）；
  3. 写入可恢复的持久派发意图（交由现有持久工作队列按任务与 `runGeneration` 领取）。
- **幂等重放规则**：
  - 同幂等键且 `payloadDigest` 相同、当前授权仍有效：返回原已受理回执（`idempotentReplay: true`），不新建任务、不重复入队；
  - 同幂等键但 `payloadDigest` 不同：拒绝并返回 `409 EXPERT_IDEMPOTENCY_CONFLICT`；
  - 事务失败或提交前拒绝：零任务、零派发意图，返回明确业务错误码。

### 7.2 权威回查、结果、追问与取消

| 入口 | 语义与授权要求 |
| --- | --- |
| `GET /api/v1/employee/expert-tasks/by-request/{requestId}` | 供 #247 在断网、超时、丢回执或 Host 重启后按原 `requestId` 权威对账。核验当前员工与原提交归属；查无记录返回 `404`（客户端不得仅凭超时推断未受理，须以本接口确认状态） |
| `GET /api/v1/employee/expert-tasks/{taskId}` | 返回权威任务状态（`accepted`、`queued`、`running`、`waiting_user`、`completed`、`failed`、`cancelled`），附当前 `runId`、`runGeneration` 与最新 `resultVersion` |
| `GET /api/v1/employee/expert-tasks/{taskId}/result` | 返回归属到具体 `taskId`、`runId`、`runGeneration` 与 `resultVersion` 的权威结果、来源标识及当前获准打开的产物引用；区分部分结果与终态，不要求客户端从评论列表猜测最终答复 |
| `POST /api/v1/employee/expert-tasks/{taskId}/followups` | 绑定原员工、专家与 `taskId`，使用独立 `requestId` 实现幂等与同任务串行受理；重新核验当前员工调用权、任务 ACL 与专家接单状态 |
| `POST /api/v1/employee/expert-tasks/{taskId}/cancel` | 提交取消请求，立即返回 `cancelRequested: true` 与当前真实状态；仅在运行器确认终止后进入 `cancelled` 终态。若任务在并发窗口内已完成，以服务端终态 `completed` 为准 |

## 8. 统一错误码与 HTTP 状态映射

所有错误响应统一返回结构 `{ "error": { "code": "<CODE>", "message": "<脱敏说明>", "retryable": <bool>, "requestTraceId": "<关联号>" } }`，不得透出内部堆栈、凭据原值、SQL/上游原始错误或任务正文。

| HTTP | `error.code` | 语义 | 客户端/Host 动作 |
| --- | --- | --- | --- |
| `401` | `EXPERT_AUTH_INVALID` | 凭据缺失、签名无效或已过期 | 停止调用，触发身份状态刷新并提示重新登录 |
| `401` | `EXPERT_AUTH_REVOKED` | 员工令牌已撤销 | 废弃当前作用域投影与待提交选择 |
| `403` | `EXPERT_ORG_FORBIDDEN` | 员工无权访问目标组织 | 拒绝访问，不展示旧组织缓存 |
| `403` | `EXPERT_SCOPE_MISMATCH` | 凭据归属与请求作用域不匹配 | 拒绝并丢弃响应，推进 `scopeEpoch` |
| `403` | `EXPERT_CALL_FORBIDDEN` | 员工仅有查看权或已失去该专家调用权 | 禁止启停或委派，保留草稿并提示重选 |
| `404` | `EXPERT_NOT_FOUND` | 专家不存在或当前员工无权查看 | 统一按不可访问处理，不泄露存在性 |
| `404` | `EXPERT_TASK_NOT_FOUND` | 任务/请求不存在或无权读取（含私有 ACL 拒访） | 统一按不可访问处理，不泄露私有任务存在性 |
| `409` | `EXPERT_CURSOR_STALE` | 分页游标过期、版本漂移或跨范围使用 | 废弃旧游标并从首页重查 |
| `409` | `EXPERT_SCOPE_UNVERIFIED` | 缺少当前会话的有效委派范围证据 | 暂停当前会话 `@` 候选 |
| `409` | `EXPERT_NOT_ACCEPTING` | 专家当前暂不接单或不可用 | 阻止新委派，保留草稿并提示状态 |
| `409` | `EXPERT_IDEMPOTENCY_CONFLICT` | 同一 `requestId` 携带了不同的请求摘要 | 拒绝重放，交由人工核对原任务 |
| `409` | `EXPERT_TASK_STATE_CONFLICT` | 任务已终态或旧 `runGeneration` 冲突 | 回读权威任务状态并刷新视图 |
| `422` | `EXPERT_REQUEST_INVALID` | 参数格式或长度不合法 | 保留草稿并提示修正输入，不重试 |
| `429` | `EXPERT_RATE_LIMITED` | 触发服务端限流或队列反压 | 按退避策略重试只读查询；写操作不盲目换键重发 |
| `503` | `EXPERT_DIRECTORY_UNAVAILABLE` | 目录或上游权限源暂不可用 | 保留本机偏好，暂停未确认动作与候选 |
| `503` | `EXPERT_ISOLATION_UNVERIFIED` | 目标运行器无法证明跨会话隔离或私有边界 | 关闭受影响的真实委派入口 |
| `503` | `EXPERT_ACCEPTANCE_UNKNOWN` | 受理结果暂无法确认 | 严禁换新 `requestId` 重发，改走 `by-request/{requestId}` 对账 |
| `500` | `EXPERT_INTERNAL_ERROR` | 服务端未分类内部异常 | 记录脱敏诊断号；对写操作先走权威回查 |

## 9. 验收矩阵、回退契约与待冻结项

### 9.1 角色矩阵与负向用例（#244 准入）

| 验证维度 | 必须覆盖的角色与操作 | 通过判据 |
| --- | --- | --- |
| 目录与摘要边界 | 发起员工、仅查看权员工、同组织普通员工、跨组织账号；覆盖跨页、同名专家、摘要缺失/过期/不可披露 | 无权专家零泄露；仅查看权员工 `callableInOrg: false` 且直接提交返回 `403 EXPERT_CALL_FORBIDDEN`；跨页游标在版本变化后返回 `409 EXPERT_CURSOR_STALE` |
| 授权连续性与撤权 | 项目 A → B 范围切换、组织内全量撤权、全量撤权后重授、专家暂停接单与恢复 | 单项目变化保持 `authContinuityDigest` 不变；全量撤权后重授生成新摘要触发重新启用；撤权收敛满足实测 SLA |
| 私有任务与全列表隔离 | 上述四类账号加获准审计角色，分别访问专用接口、通用详情/列表/搜索、`heartbeat-runs`、`live-runs` 与 WebSocket | 未获权主体在所有入口均不可见（含零脱敏运行元数据）；直接按 ID 查询返回 `404`；扩大可见范围或改派被拒绝 |
| 原子受理与故障注入 | 在真实 PostgreSQL 夹具注入事务回滚、提交后丢响应、同键同体/异体重放、worker 重启、并发取消与完成 | 一次委派至多一条私有任务；丢响应后 `by-request/{requestId}` 可准确对账；同键异体返回 `409`；旧 `runGeneration` 更新被拒 |

### 9.2 回退与停用契约

- 两侧须支持独立关闭新委派入口；停用新委派期间，存量任务的权威状态、结果与取消查询按当前有效授权继续可用。
- 云端版本回退时，目标旧版本必须维持同等的私有记录 ACL 过滤（覆盖通用列表、运行历史与实时推送）；若旧版本无法保证该边界，必须保留具备访问控制的版本或先停用受影响投影，禁止在回退窗口内暴露私有任务。

### 9.3 待目标环境实测冻结项

以下参数需由 Delegra 维护方与企业环境负责人结合目标版本线在 #244 联调后回填冻结：

1. 企业 IAM 到 Delegra 员工/组织映射的真实令牌类型、`issuer`/`audience` 校验方式与撤权收敛最大时限；
2. 目标部署中 `delegationScope` 的具体业务粒度（项目 ID、工作区或单组织默认范围）；
3. 幂等回执与私有任务结果的保留期限，以及符合 [需求基线 §4.4](../requirements/requirements-baseline.md#44-数据与合规约束)（C1–C4）的数据路径与日志关闭抽验结果。

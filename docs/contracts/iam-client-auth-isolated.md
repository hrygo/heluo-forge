# IAM 客户端认证契约

## 文档信息

| 项 | 内容 |
|---|---|
| 文档编号 | CORP-DSH-IAM-002 |
| 文档名称 | IAM 客户端认证契约 |
| 版本 | V1.1.1 |
| 文档状态 | 草案 |
| 密级 | — |
| 编制 | DSH 平台组（代拟） |
| 负责 | 平台组（代拟） |
| 审核 | 待定 |
| 批准 | 待定 |
| 最后更新 | 2026-11-20 |
| 确认人 | 项目负责人 |
| 确认日期 | 2026-11-02 |
| 确认事项 | 批准 IAM-002 与 DESIGN-016 进入 source/mock 实施 |
| 适用范围 | 可选机密客户端的 source/mock 隔离契约 |
| 门禁 | 目标 IAM 客户端登记、实际终端凭据预置及正常计划续期须通过 G1 核验 |

> 适用范围：使用授权码与 PKCE S256 的 IAM 登录。要求刷新请求认证客户端的企业部署采用 `authMode=confidential`。客户端认证方法与 IAM 的 `token_endpoint_auth_method` 一致。
>
> 编制依据：[issue #408 的 IAM 核对结论](https://github.com/hrygo/heluo-forge/issues/408#issuecomment-7034227656)、现有来源隔离与 Host 单记录契约，以及仓库内的组合和离线用例。事故部署的登记方法、正常续期和实际平台交付仍待联合核验。
>
> 关联文档：[隔离开发设计](<../design/iam-confidential-isolated.md>)、[现行 IAM 模块](<../design/plugins/forge-iam.md>)、[IAM 回函](<../collaboration/iam-confirmation-letter.md>)。

## 1. 配置与模式

| 字段 | 提案值与约束 | 语义 |
|---|---|---|
| authMode | public / confidential；省略等价 public | public 适用于 IAM 明确允许无客户端认证换票与刷新的部署；要求客户端认证时显式使用 confidential |
| clientAuthMethod | public 省略或 none；confidential 必须显式为 client_secret_basic / client_secret_post | 授权码换票、刷新、回调失败清理的撤销 POST 共用登记方法 |
| clientSecretRef | 仅 confidential 必填；匹配 `^[a-z][a-z0-9-]*$` | 指向当前凭据命名空间内的 IAM 专用记录 `iam-client-secret/<ref>` |

公共配置出现任何 clientSecretRef（包括空、null 或显式 undefined）均拒绝；正常 public 归一化结果不产生此键。未知 mode/method、部分机密配置、原始 clientSecret/client_secret、自定义 Authorization 或认证 body 覆盖均拒绝。缺少来源、凭据或精确认可时拒绝机密登录和刷新。Discovery、401 和其他响应均不触发认证方式切换。

所有模式要求 PKCE S256、state、nonce 和 code_verifier。私版只注入模式、方法和非秘密引用。密钥预置和轮换走凭据存储的独立运维入口。

**轮换**：认证上下文（method/ref/revision）变化后需新登录。Host 拒绝采用旧 AT/RT，禁止用新 secret 重放旧 RT。IAM 书面答复称 secret 由管理员轮换，后台更新最迟两分钟经缓存生效，既发 AT 自然过期。实际生效窗口与目标端点行为须联调核验。见[接入确认函 §5](<../collaboration/iam-access-confirmation.md#5-客户端注册与-secret-管理>)。

## 2. 私有只读来源

IAM 服务工厂使用以下私有参数。真实 Host 从凭据组合的内部 `iam-client-secret-source` 端口装配它们：

```ts
type SecretBinding = Readonly<{ issuer: string; clientId: string; ref: string }>;
type ClientAuthScope = Readonly<SecretBinding & {
  method: 'client_secret_basic' | 'client_secret_post';
}>;
type SecretSnapshot = Readonly<SecretBinding & { revision: string; value: string }>;
interface ClientSecretSource {
  read(expected: SecretBinding): Promise<SecretSnapshot | undefined>;
  isCurrent(originalSnapshot: SecretSnapshot): boolean;
}
getClientSecretSource?: () => ClientSecretSource | undefined;
verifyClientSecretSource?: (
  credentials: object, source: ClientSecretSource, scope: ClientAuthScope,
) => boolean;
```

- 仅内置加密 SQLite 凭据组合注册 `iam-client-secret-source`，并按身份核对同一 `credentials` 实例。Host 在 confidential 模式注入该端口，为同一绑定返回稳定 source；端口解绑或重绑使已捕获的来源失效。
- verifier 在当前注入作用域检查具体 credentials、source、配置的 clientId/ref/method；记录读取再精确核对 issuer/clientId/method。只有同步字面 `true` 通过。凭据的来源证明独立于 IAM grant 单记录及网关联合写入能力。
- binding 冻结且不交给来源修改。read 只捕获一次完整内存快照，缺失不查找第二来源；service 独立核对五字段类型、精确 binding、非空 revision/value，不 trim secret。
- 内置来源读取当前凭据命名空间的 `iam-client-secret/<ref>`，记录为 `{ kind: 'grant', payload: { issuer, clientId, method, value } }`。复用值级加密与单记录提交。每次写入产生新加密信封。`revision` 取已认证信封的摘要。同步 `isCurrent` 确认当前存储可读，并按原快照核对当前行。密钥文件不可用、记录删除或重写时，快照失效。隔离 fixture 同样提供不可变快照和同步检查。
- service 保留原快照仅用于身份检查，另取私有字段副本用于请求与 pin；每个使用边界检查原数据仍匹配副本，不能让来源改写调用方的秘密或比较基准。
- secret 原值仅进入管理员标准输入、加密记录的读写及必要 HTTP 操作；attempt、会话 grant、pending、view、诊断、错误、日志、argv 和交付物均不携带原值。

管理员使用 `heluo-forge client-secret set` 在目标 Host 使用的目录和命名空间预置或轮换。该命令更新已有引用时须匹配原 issuer/clientId/method。更正同一引用的绑定使用 `client-secret replace`，从标准输入读取密钥，在同一次单记录更新中检查原 issuer/clientId/method 并写入新绑定。记录缺失或旧绑定不符时中止更新并返回 `IAM_CLIENT_SECRET_BINDING_MISMATCH`。来源直接读专用加密记录，任何环境变量、配置值和其他凭据引用都不能提供 secret。运维步骤见 [IAM 凭据接入指南](../../packages/forge-iam/docs/credential-access.md)。

## 3. HTTP 认证

依 [RFC 6749 §2.3.1](<https://www.rfc-editor.org/rfc/rfc6749.html#section-2.3.1>)，每次请求只采用一种认证方法：

| 方法 | Authorization | 表单 |
|---|---|---|
| public / none | 无 | client_id；无 client_secret |
| client_secret_basic | Basic；clientId、secret 分别 form-urlencoded 后以冒号连接，再 UTF-8/Base64 | 不放 client_id/client_secret 认证参数 |
| client_secret_post | 无 | URLSearchParams 编码 client_id/client_secret |

共享纯构造函数供 code、refresh、revoke 及失败 cleanup 使用。secret 不进授权 URL、重定向或日志；Basic 编码串也视为秘密。端点接受 HTTP(S)，保留 redirect:error、超时、取消和现有资源/回调上下文；HTTP 不提供传输加密或端点身份认证，secret 与令牌可能被窃取或篡改。POST 是显式兼容选项，不是推荐默认；不得自动 Basic↔Post 切换、无认证降级或重试。

依 [RFC 7009 §2.1](<https://www.rfc-editor.org/rfc/rfc7009.html#section-2.1>)，有客户端凭据时撤销也认证；真实 IAM 的方法、token/revoke 能否采用同一选择仍待供应商确认。本地 fixture 接受某方法不证明真实端点接受。

## 4. 会话与记录隔离

- public 使用 grant format 1，不增加机密上下文；带 `sessionInstanceId` 且无新认证字段的 V1 按现行明确 issuer/client/resource 规则读取。V1 出现 authContext/clientAuth 等认证标记（含 null/undefined/畸形）拒绝，不擦字段伪装 legacy。
- confidential 使用 grant format 2，原 grant 业务字段和 `sessionInstanceId` 继续有效；public V1 与 confidential V2 缺少 `sessionInstanceId` 时均拒绝采用，外层字段严格列举。必填 authContext 为 `{mode:'confidential', method, secretRef, secretRevision}`，method 取上表两种；拒绝未知键、public/none、秘密原文、header 或编码串。
- issuer/clientId/resource 沿用 grant 原字段；source 对象身份不持久化。V2 本身不是可信证明，仍核对当前配置、来源、binding、revision 和现有存储/生命周期前提。
- public 不采用 V2；confidential 不采用 V1。method/ref/revision 改变后不能采用旧 AT/RT/共享完成结果，需新登录，不自动迁移或拿新 secret 重放旧 RT。旧 public reader 严格 version=1，因而拒绝 V2；这不阻止被授权的旧 writer 覆盖相同 key，隔离 fixture 不混跑旧 writer。
- attempt 只固定非秘密 auth pin、精确 source/credentials/store 和现有 issuer/端点/redirect/resource/state/nonce/verifier/代际。callback 与每个 POST 重新 read 并要求同一 revision，不在 attempt 保留 value。
- 现有 refresh pending/complete 保留，完整 base、显式身份比较、完成采纳、回调 discard 均纳入 authContext。pending 不放 secret，也不因来源失效而清除/接管/重发。

## 5. 固定错误与未知结果

| 固定错误 | 语义 | HTTP |
|---|---|---|
| IAM_CONFIG_INVALID | 认证配置不完整或不支持 | 目标400；当前路由无专门映射，仍为500 |
| IAM_CLIENT_AUTH_UNVERIFIED | 无具体受信来源或 snapshot 无法验证 | 503 |
| IAM_CLIENT_AUTH_CHANGED | 当前操作的来源、代际或认证上下文变化 | 409 |
| IAM_CLIENT_AUTH_CONTEXT_INVALID | 当前 grant 与所选模式/方法/ref/revision 不符；需新登录 | 401 |

三个 IAM_CLIENT_AUTH_* 码已由实际管理 handler 验证503/409/401；不据此宣称 IAM_CONFIG_INVALID 已映射400。消息固定，不附 source 异常、原始响应、secret、ref、完整 snapshot、header 或表单。既有 OAuth 标准码只允许精确白名单；unknown/mixed error 不保留。成功业务响应不因错误脱敏而被删改。

HTTP 401 如包含标准 OAuth 错误，诊断记录固定 `oauthError`。否则仅记 `oauthErrorResponse` 的 `empty`、`nonstandard` 或 `unreadable`。Token 请求阶段同时记录实际采用的 `clientAuthMethod`。空或非标准响应本身不能确定服务端拒绝原因。

检查只能拒绝可观察的旧结果，不能撤回已发请求、证明远端旧 secret 失效、远端 token 后代撤销或跨进程一致。IAM 答复旧访问令牌不随 secret 轮换作废；按范围前提，轮换按运维窗口执行。未知不补偿、不借新来源重试。secret 不可用时，本地退出仍按既有精确快照和受信 grant 规则处理；远端 revoke 不发送无认证请求，不盲删其他模式/主体记录，结果如实标未确认。

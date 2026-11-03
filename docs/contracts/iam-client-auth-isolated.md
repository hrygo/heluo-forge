# IAM 机密客户端隔离开发契约

## 文档信息

| 项 | 内容 |
|---|---|
| 文档编号 | CORP-DSH-IAM-002 |
| 文档名称 | IAM 机密客户端隔离开发契约 |
| 版本 | V0.4.1 |
| 文档状态 | 草案 |
| 密级 | — |
| 编制 | DSH 平台组（代拟） |
| 审核 | 待定 |
| 批准 | 待定 |
| 最后更新 | 2026-11-03 |
| 门禁 | 用户已批准 source/mock 设计；真实来源关闭，生产 G1 未关闭 |

> 编制依据：用户于 2026-11-02 选择管理员预置的隔离基线并批准完整设计进入 source/mock 实施。本契约定义本包的配置、私有组合参数和记录格式。实际隔离服务已接入 Basic/Post 的 code/refresh/revoke、V2 会话、共享刷新与 cleanup，不代表 SDK 新增接口、供应商能力或生产批准。
>
> 关联文档：[隔离开发设计](<../design/iam-confidential-isolated.md>)、[现行 IAM 模块](<../design/plugins/forge-iam.md>)、[IAM 回函](<../collaboration/iam-confirmation-letter.md>)。

## 1. 配置与模式

| 字段 | 提案值与约束 | 语义 |
|---|---|---|
| authMode | public / confidential；省略等价 public | 原型兼容默认，不改变生产以机密客户端为目标的准入要求 |
| clientAuthMethod | public 省略或 none；confidential 必须显式为 client_secret_basic / client_secret_post | code、refresh、revoke 同一方法，不根据 discovery、401 或失败响应猜测/切换 |
| clientSecretRef | 仅 confidential 必填非空逻辑 selector | 仅匹配 synthetic source，不是 SDK CredentialRef、CredentialKey、路径或环境变量名，不触发 resolve/readRecord |

公共配置出现任何 clientSecretRef（包括空、null 或显式 undefined）均拒绝；正常 public 归一化结果不产生此键。归一化结果再次验证仍有效。未知 mode/method、部分机密配置、原始 clientSecret/client_secret、自定义 Authorization 或认证 body 覆盖均拒绝；不能静默回落 public。pkce/aigs 不作为本阶段 authMode，plain、关闭 PKCE 或其他降级分支不开放。现行 schema 与实际服务支持该联合；confidential 必须由可信隔离组合注入具体来源与独立认可。真实 apply 无来源，缺失或非法认可仍固定拒绝，不能凭配置启用。

所有模式保持现有 mandatory PKCE S256、state、nonce、code_verifier。字段只属于本包 source/mock 提案；没有 editor 开关或原生来源自动发现能解除真实来源门禁。

**已确认的外部轮换事实（2026-11-03 IAM 答复，未联调）**：企业 IAM 全企业共用一个 client_id；client_secret 只能人工轮换，后台更新后最迟两分钟经缓存生效；轮换不会作废已发出的访问令牌（按 7200 秒自然过期），刷新接口必须同时携带 secret，因此旧刷新令牌在 secret 更换后实际不可用。本契约仍采用更严格的本地策略：认证上下文（method/ref/revision）改变后不采用旧 AT/RT，需新登录；不得用新 secret 重放旧 RT。轮换后至少等待两分钟再判定失败，不在该窗口内反复重建来源或切换方法。本项目内部使用，client_id/client_secret 泄露不在评估范围（用户 2026-11-03 决定，视为无影响）；凭据存放与轮换按存储和运维要求执行。依据见[接入确认函 §5](<../collaboration/iam-access-confirmation.md#5-客户端注册与-secret-管理>)。

## 2. 私有只读来源

以下为已接入隔离服务的私有工厂参数，不是 Cordis Service、SDK API、Remote、HTTP、Client 或配置字段：

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

- getter 同步返回同一作用域内的具体 source；替换/解绑就是新作用域。真实 apply 不传 getter/verifier，也不探测 ctx 中的隐藏来源。
- verifier 由可信 fixture 组合提供，仅对已认可的具体 credentials/source/精确 issuer-clientId-ref-method 返回同步字面 true。缺失、false、抛错或 Promise 均不能授权；异步拒绝收敛但不等待为 true。它独立于 IAM grant 单记录与网关联合能力证明；自报 trusted/keychain/atomic 或方法形状不作证明。
- binding 冻结且不交给来源修改。read 只捕获一次完整内存快照，缺失不查找第二来源；service 独立核对五字段类型、精确 binding、非空 revision/value，不 trim secret。
- fixture 预置的 snapshot 为不可变数据；替换、删除、恢复都更换 revision，不复用 ABA 版本。source 的同步 isCurrent 只对原快照且仍为本地 current 返回字面 true；Promise、缺失、异常或非 true 视为失效。
- service 保留原快照仅用于身份检查，另取私有字段副本用于请求与 pin；每个使用边界检查原数据仍匹配副本，不能让来源改写调用方的秘密或比较基准。
- value 仅在 fixture 内存和短时 HTTP 操作中可达，不放入 attempt、grant、pending、view、诊断、错误、日志、argv 或交付物。secret、revision、ref 不由客户端上传或生成可信证明。

本阶段不定义真实 secret 持久格式、写入 API、管理员工具、MDM、环境变量、文件回落或 native adapter。系统钥匙串生产适配另行设计；普通 SDK resolve 有环境回落，不能直接用于本契约。

## 3. HTTP 认证

依 [RFC 6749 §2.3.1](<https://www.rfc-editor.org/rfc/rfc6749.html#section-2.3.1>)，每次请求只采用一种认证方法：

| 方法 | Authorization | 表单 |
|---|---|---|
| public / none | 无 | client_id；无 client_secret |
| client_secret_basic | Basic；clientId、secret 分别 form-urlencoded 后以冒号连接，再 UTF-8/Base64 | 不放 client_id/client_secret 认证参数 |
| client_secret_post | 无 | URLSearchParams 编码 client_id/client_secret |

共享纯构造函数供 code、refresh、revoke 及失败 cleanup 使用。secret 不进授权 URL、重定向或日志；Basic 编码串也视为秘密。保留 safeEndpoint、TLS/显式 loopback 模拟例外、redirect:error、超时、取消和现有资源/回调上下文。POST 是显式兼容选项，不是推荐默认；不得自动 Basic↔Post 切换、无认证降级或重试。

依 [RFC 7009 §2.1](<https://www.rfc-editor.org/rfc/rfc7009.html#section-2.1>)，有客户端凭据时撤销也认证；真实 IAM 的方法、token/revoke 能否采用同一选择仍待供应商确认。本地 fixture 接受某方法不证明真实端点接受。

## 4. 会话与记录隔离

- public 继续原 grant format 1，不增加机密上下文；无新认证字段的旧 V1 按现行明确 issuer/client/resource 规则读取。V1 出现 authContext/clientAuth 等认证标记（含 null/undefined/畸形）拒绝，不擦字段伪装 legacy。
- confidential 使用 grant format 2，原 grant 业务字段和 sessionInstanceId 继续有效；外层字段严格列举。必填 authContext 为 `{mode:'confidential', method, secretRef, secretRevision}`，method 取上表两种；拒绝未知键、public/none、秘密原文、header 或编码串。
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

检查只能拒绝可观察的旧结果，不能撤回已发请求、证明远端旧 secret 失效、远端 token 后代撤销或跨进程一致。IAM 答复旧访问令牌不随 secret 轮换作废；按范围前提，轮换按运维窗口执行。未知不补偿、不借新来源重试。secret 不可用时，本地退出仍按既有精确快照和受信 grant 规则处理；远端 revoke 不发送无认证请求，不盲删其他模式/主体记录，结果如实标未确认。

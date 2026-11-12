# IAM 开发者指南

本指南说明包的现行代码、配置与验证边界，不是生产运行手册或外部 IAM 契约。返回[包入口](<../README.md>)；账户操作见[用户指南](<user-guide.md>)。

## 能力与组合边界

Host 提供 `ctx.iam`、OIDC 回调与同源管理 HTTP API；[Client](<../client.js>)通过 2 秒轮询展示账户、横幅和四步引导，不使用 Client Remote/watch。Host 内部 `watch(signal)` 不等于已接通 Client 状态流。

内置 SQLite 凭据组合提供与当前 provider 精确绑定的 `iam-atomic-store`；[插件 apply](<../src/index.mjs>)使用它验证 IAM 单记录能力并取得网关联合 adapter。缺少受信绑定时，登录、刷新和网关写入按各自门禁拒绝。未过期且无需刷新的旧 grant 仍可能被恢复、读取，此门禁不是全面的会话或执行隔离。目标平台与企业环境尚未完成验证。

组合方先准备 `@heluo/forge-credentials-keychain`，禁用 `dsh-credentials-local`，再挂载 IAM。服务通过 `getCredentials` 延迟读取当前 `ctx.credentials`，不能以加载顺序代替存储能力验证。凭据包使用值级加密 SQLite；内存后端仅供隔离测试且不授予 IAM 信任，目标平台实测仍待完成。

官方登录、官方模型、官方 API Key 路由和官方账户 UI 由企业组合包禁用。IAM 的 `requireExclusive` 检查 `deepseekAccount` 服务残留，不证明全部官方行和执行旁路都已消失。组合禁用失败时须修正组合，不能关闭检查作为生产恢复方案。

## 配置

配置对象直接传给插件，不加额外的 `iam` 包装层。字段、默认值与校验以[配置实现](<../src/config.mjs>)为准。

| 配置 | 默认值 | 语义 |
|---|---|---|
| `clientId` | 空 | 必需的预注册客户端标识；public 无 secret，隔离 confidential 按显式 Basic/Post 认证。 |
| `authMode` | `public` | public 保持兼容默认；confidential 还要求具体受信私有来源与独立认可，真实 apply 不注入。 |
| `clientAuthMethod` | `none` | public 仅 none；confidential 必须显式 client_secret_basic/client_secret_post，不猜测端点支持。 |
| `clientSecretRef` | 不产生 | 仅 confidential 配置的非空逻辑 selector；不是 SDK 引用、环境变量、路径或记录 key，不触发凭据读取。 |
| `discoveryUrl` | 空 | 用于补齐缺失的 issuer、授权、token 或 JWKS 端点。 |
| `issuer` | 空 | 不使用 discovery 时必需；作为明确的发行者 pin。只配 discovery 仍可配置登录，但旧 grant 复用要求明确 pin 或本实例已验证的 metadata issuer，不能由旧记录自行提供信任。 |
| `authorizationEndpoint` / `tokenEndpoint` / `jwksUri` | 空 | 无 discovery 时与 issuer 一起必需；显式值优先。 |
| `revocationEndpoint` | 空 | 可选；显式配置及 discovery 均未提供时，退出不发送撤销请求。 |
| `endSessionEndpoint` | 空 | `logoutMode=rp` 时配置校验要求提供。 |
| `scopes` | `openid profile offline_access` 数组 | 必须包含 `openid`。 |
| `redirectPath` | `/iam/callback` | 绝对路径；不能为根路径、带尾斜杠或占用 `/api/forge-iam` 前缀。 |
| `callbackPort` | 空 | 省略时沿用宿主 `webServer` 的实时 Origin，仅用于开发与兼容；`0` 由系统分配回环端口；1024–65535 固定该端口。插件自建监听，只在登录尝试期间存在，绑定失败即拒登录，不回落。 |
| `callbackAddress` | `auto` | 始终先试 `127.0.0.1`（与 IAM 登记的前缀一致），只有该地址族在本机不可用时才退到 `::1`；端口占用不触发切换。也可固定 `127.0.0.1` 或 `::1`。IPv6 需 IAM 额外登记 `http://[::1]`，回调地址写作 `http://[::1]:<port><redirectPath>`。仅与 `callbackPort` 同时生效。 |
| `redirectUri` | 空 | 可省略，由宿主 Origin 或回环监听的实时地址推导；固定端口时必须逐字节等于 `http://<callbackAddress>:<callbackPort><redirectPath>`，系统分配端口时不允许设置。显式 URI 的 path 必须与 `redirectPath` 相同，无 query/fragment。 |
| `postLogoutRedirectUri` | 空 | 可选的 RP 登出回跳 URI。 |
| `gatewayResource` | 空 | 可选的授权/令牌请求 resource 与 grant 上下文约束；不证明已实现网关目标授权。 |
| `gatewayConsoleUrl` | 空 | 网关控制台引导链接，不参与鉴权。 |
| `defaultProvider` / `defaultModel` | `enterprise` / 空 | 只读模型观察目标；defaultModel 为空时不注册模型注入、不取 SDK。不会自动写入宿主默认模型。 |
| `refreshSkewSeconds` | `60` | `resolveToken()` 提前刷新阈值；普通视图轮询只在 access 已过期时触发后台刷新。 |
| `attemptTimeoutSeconds` | `300` | 登录尝试时限。 |
| `httpTimeoutMs` | `10000` | 协议请求超时参数；刷新与退出撤销请求取该值和 5000ms 的较小值，不是整个操作总时限。 |
| `logoutMode` | `local` | `local` 尽力撤销并本地退出；`rp` 还可生成浏览器登出 URL，不保证单授权或全局 SSO 生命周期闭环。 |
| `requireExclusive` | `true` | 发现官方账号服务残留时拒绝就绪和相关操作。 |

登录时必须取得可用的实时回调 Origin：省略 `callbackPort` 时取宿主 `webServer` Origin，配置后取已绑定回环监听的 Origin，两者不互相回落。即使显式配置 `redirectUri`，其 Origin 也必须与所选实时 Origin 相等；不相等以 `IAM_CONFIG_INVALID` 拒绝。所选 Origin 缺失、获取异常或不是有效 HTTP(S) 地址时，以 `IAM_CALLBACK_UNAVAILABLE` 拒绝登录，不生成授权链接。复用进行中的登录链接前重新检查回调地址；来源失效或变更时取消原尝试，旧回调不得继续使用。

含旧配置项 `allowInsecureHttp` 的有效 profile 仍可使用；该项按未知键忽略，不出现在规范化结果中。新配置不得设置该项，调用方不得依赖其开关行为。

显式 issuer、授权、token、JWKS 全部齐全时，不强制请求 discovery。协议端点和网关地址接受 HTTP 或 HTTPS；HTTP 不提供传输加密或端点身份认证，令牌、客户端 secret、网关 Key 与业务内容可能被窃取或篡改，OIDC 公钥经 HTTP 获取时签名校验也不能防止网络替换公钥。回调须符合 IAM 登记规则；这里没有已验证的生产配置模板。

所有模式强制 PKCE S256，不能关闭。实际服务已接入隔离 confidential 的授权码、刷新、有效 AT、V2 恢复、认证撤销与回调清理；仅具体受信 source/credentials/精确 binding 的独立认可才允许。真实 apply 不传 getClientSecretSource/verifyClientSecretSource；缺失、伪造或异步认可在构造或使用前拒绝，不发送带凭据 POST。配置通过不等于真实来源可用。

[认证 helper](<../src/client-auth.mjs>)与实际服务共同完成隔离来源固定、操作检查和 HTTP 认证，不是原生秘密来源。它不发现 ctx 隐藏来源、不使用环境/文件后备，不从通用 credentials.resolve 推导信任。公共配置带 selector、部分机密配置、原文 secret、自定义认证 header/body 或关闭 S256 均拒绝；其余未知普通字段仍会被忽略。正式 secret 下发、平台存储、远端轮换与生产接入仍未完成。

## 隔离机密服务与会话边界

机密测试由实际服务工厂与 localhost mock IdP 驱动，不只是检查请求 helper。测试组合独立认可精确 credentials/source/issuer-clientId-ref-method；source、getter、verifier 或 revision 变化后，旧操作不能借新来源继续。secret 只在来源及短时操作内存中使用，attempt 只保存非秘密 pin，不存原 snapshot 或捕获秘密的闭包。Basic 对标识和 secret 分别 form 编码，Post 只在表单认证；失败不自动换方法。

public 使用 V1，不采用或盲删 V2；confidential 使用 V2 和完整 authContext，不迁移 V1。机密 grant 的方法、selector 或 revision 不符时拒绝；有效 AT、恢复、共享刷新完成和最终 token 返回同样复验来源。V2 不是防旧 writer 回滚机制，测试组合不混跑可覆盖同一键的旧 writer。

来源准备在 grant 锁外。刷新先确认持久 pending，再最多发送一次原请求；来源变化、回执异常或结果未知不能接管、清除 pending 或重发。每个 await、提交和结果采用边界复验原操作；取消、退出或卸载后的旧成功和旧错误不覆盖新会话。检查不能撤回已经发出的 HTTP。

来源消失后，只有本实例先前已独立认可、且当前完整快照仍精确匹配的会话可本地清理；远端撤销报告未确认。不认识的冷启动 V2、不同主体、会话标识或认证上下文均保留，不盲删、不裸发撤销。

这些正向仅由私有测试工厂注入。手工启动 mock IdP 或修改部署配置不会自动获得来源；没有可供生产直接复制的机密配置模板。正式管理员预置、系统钥匙串与轮换管理仍待设计和验证。

### 隔离会话见证不授予业务权限

[显式测试工厂](<../src/isolated-testing.mjs>)导出实际服务工厂，不注册插件或模型路由。[会话见证](<../src/consumption-witness.mjs>)只证明已采纳会话与精确非秘密绑定仍连续；见证不含令牌、secret、原snapshot或整grant。普通apply不注入这些选项，capture/current不读取秘密。

明确issuer的public/Basic/Post登录、恢复、刷新已有57项新测试及760项必要合并证据，独立审查关闭；没有因此接通真实提供方人员授权、原生工具/模型或真实profile。首次discovery-only开始时没有已知issuer，就没有原ticket；callback不能补票，所以首次ready不提供见证。后续真实sync/resolve成功重验证后才可能取得；不宣称首次discovery正向已验。

下游工具与模型必须固定同一实际工厂交出的source及原会话见证，并取得独立的当前人员/精确用途许可；缓存ready/getPrincipal不能代替。消费端C/D的私有SDK-shaped工具/命令与模型接缝已分段验收，根E已由公开测试导出的实际IAM工厂及mock IdP联合验证16项，包含public/Basic和不同issuer/person整体替换；不把分段fixture或该联合子集写成真实提供方证据。普通apply不注入这些私有来源或启用合成route，详细隔离边界按CORP-DSH-IAM-003与CORP-DSH-PLAN-007评审，不构成真实接通教程。

### 隔离只读订阅接缝

[测试入口](<../src/isolated-testing.mjs>) 另导出 `createIamViewObserver` 与 `createIamViewConsumer`。接口与边界见仓库私有契约 CORP-DSH-IAM-004；该契约随仓库维护，不随包分发，也不是 SDK 方法或生产端点。

- 观察组：由实际工厂实例驱动；一次串行读为 `syncFromStore → loadGatewayCredential → getView`；`watch` 只唤醒当前读；每个读周期与每帧交付前复验管理证明。
- 消费者：按代际接收；`start()` 幂等；`restart()` 先取消旧代际；异步 `open` 按非法句柄拒绝；`dispose()` 结束自有循环。
- 未接线：真实 [Client](<../client.js>) 仍走同源 HTTP 两秒轮询；`apply` 不注册 Remote 贡献，也不改 HTTP 路由。取消只结束本订阅，不撤回已经发出的请求。
- 证据：18 项定向用例通过；完整检查 2599 项中 2597 通过、0 失败、2 项平台跳过，明细见仓库计划 CORP-DSH-PLAN-008 §8。

## 实际接口

跨模块与下游 CLI 读取「用户令牌 + 身份」的对外契约（存储内容、位置、获取方法与样例）单独成文：[FORGE-IAM 凭据接入指南](<credential-access.md>)。本节只列 Host 与 HTTP 的当前方法，不重复该契约。

### Host 服务

[服务工厂](<../src/service.mjs>)为 `createIamService(config, options)`；插件将返回对象注册为 `ctx.iam`。`service.mjs` 是唯一装配入口，内部按轴分给 `src/service-*.mjs`，各轴的状态归属与改动落点见[模块 README](<../README.md#host-分轴模块>)。以下均为现行接口，不是未来 Remote 定义。

| 方法 | 返回与用途 |
|---|---|
| `getView()` | 同步返回非敏感快照。 |
| `hydrate()` / `syncFromStore()` | 异步恢复或同步共享会话；`hydrate` 还加载网关凭据摘要。 |
| `startSignIn()` | 无参，返回 `{view, authorizationUrl}`；可返回当前共享尝试的链接，已 ready 时链接可为空。 |
| `cancelSignIn()` | 无参，取消本实例当前尝试，返回 view；不是按指定 attempt 条件取消。 |
| `handleCallback(rawUrl)` | 接受完整回调 URL，校验并处理授权码；仅 Host 使用。 |
| `signOut()` | 返回 `{view, logoutUrl, revocation, revocationError?}`；结果可能是已清理、撤销失败或未知。 |
| `resolveToken()` | 返回 access token 字符串或拒绝；refresh token 不通过此方法交给调用方。 |
| `getPrincipal()` | 返回最小 `{issuer, subject}` 或 `undefined`，供 Host 使用；不是独立的服务端授权证明。 |
| `saveGatewayCredential({key, deviceLabel, baseURL})` | 在独立受信联合存储上保存新格式值及元数据，返回 view；还要求可取得会话主体和可变更的目标 pair。 |
| `clearGatewayCredential()` / `loadGatewayCredential({force})` | 清除同样需要独立联合能力及可变更目标；读取不自动迁移，不探测网关。 |
| `watch(signal)` / `dispose()` | Host 内部状态观察与释放运行时资源。 |

view 包含 `state`、`configured`、`signedIn`、`canSignIn`、`canSignOut`、`missing`、`error`、`exclusive`、`principal`、`accessExpiresAt`、`gatewayCredential`、`gatewayConsoleUrl` 与 `modelAccess`。`principal` 为主体字符串或 null，`error` 为错误码字符串或 null；view 不含 token、`authorizationUrl` 或 `attemptId`。授权 URL 随 `startSignIn` 单独返回。

### 同源 HTTP

[管理路由](<../src/routes.mjs>)位于 `/api/forge-iam`，先经宿主 Connection 认证。`requestRejection` 只在同步返回 `undefined` 时放行，返回 401/403 时按原状态拒绝；Connection 缺失、调用异常、Promise 或其他返回值均以 503 拒绝，不进入 service。自定义请求头不能替代认证。所有变更请求要求 `x-forge-iam-request: 1` 和 `content-type: application/json`；凭据保存接口读取的 JSON 正文上限为 8 KiB。

| 方法与路径 | 输入 | 返回 |
|---|---|---|
| `GET /api/forge-iam/view` | 无 | 同步共享记录及凭据摘要后直接返回 view；读取可能触发过期会话的后台刷新。 |
| `POST /api/forge-iam/sign-in` | `{}` | `{view, authorizationUrl}`。 |
| `POST /api/forge-iam/cancel` | `{}` | `{view}`。 |
| `POST /api/forge-iam/sign-out` | `{}` | 退出结果对象；清理失败或撤销 unknown 返回 503，并清空 `logoutUrl`。 |
| `GET /api/forge-iam/credential` | 无 | `{credential}`。 |
| `PUT /api/forge-iam/credential` | `{key, deviceLabel?}` | `{view}`。 |
| `DELETE /api/forge-iam/credential` | 无 | `{view}`。 |

错误通常返回 `{error: {code, message?}}`；退出失败还可携带 view 与撤销结果。客户端必须检查 HTTP 状态和返回结果，不能只看是否收到 JSON。凭据原文不回显。

后端失败响应的 error 只按有限标准码精确识别，任意文本、拼接/空白变体或编码凭据不进入 OidcError.details.oauthError；error_description 与原始错误体也不输出。合法 invalid_grant 保持现有分类；成功业务 JSON 不受错误分支过滤影响。这些回归同时覆盖隔离机密认证，不证明真实企业端点已联调。

回调为 `GET <redirectPath>`，返回最小 HTML 而非管理 API JSON；使用 state、PKCE、回调来源及 Host 校验，不套用管理 API 的变更头。回调页不包含 code/token 或外部资源。真实 Desktop 浏览器调度、launch token 与代理环境的可达性仍待验证。

## 存储与会话生命周期

[记录校验](<../src/record.mjs>)与[存储适配](<../src/store.mjs>)使用以下分离内容：

| 内容 | 保存位置与边界 |
|---|---|
| IAM grant | `heluo-iam/session` 的 `GrantRecord.payload`；含 access/refresh token、身份与到期信息。仅 RP 登出模式保存 ID Token。 |
| 网关 Key | 凭据引用 `ENTERPRISE_STATIC_KEY`。 |
| 网关元数据 | 独立记录 `heluo-iam/gateway-credential`，记录录入人、设备标签、录入和建议到期时间。 |
| 旧 IAM 镜像 | 新令牌不再写 `ENTERPRISE_ACCESS_TOKEN`；启动不自动删除现存旧引用。保留不等于隔离，其他消费者仍可能解析它。 |

网关状态只有 `unconfigured`、`configured`、`owner-mismatch`、`invalid`；读取失败还可让摘要未知。`ownerSubject` 只是录入人，不证明真实 Key 归属。换账号、共享记录同步、回调和取消保留现存 Key/元数据。旧格式、未知格式和不一致 pair 只读；显式操作也不自动迁移或修复。

网关读取在检查缓存或复用在途请求前重取当前 provider。一次加载固定同一 store/provider 读取元数据、值与存储描述，每次异步完成后复查；旧 provider 的结果、错误和收尾不会覆盖另一 provider 的摘要或释放其单飞 guard。账户匹配只使用同一 store 已采纳的 IAM 主体，不借用其他 provider 的缓存身份。

保存从捕获的当前 store 重读并校验 grant，以该记录主体写入元数据；读取完成后及返回前检查 provider、认证代际和卸载状态。清除也固定原 provider 并在返回前核实上下文。进行中的登录、退出或 provider 变化可能使保存被拒绝；已提交给 provider 的请求不能撤回，拒绝或异常不能证明先前 I/O 未发生，不自动重放。

网关不使用分步 SDK 写入和失败补偿。内置 SQLite 组合提供联合快照与条件提交；缺少受信联合能力时，保存和清除在任何持久变更前拒绝。异常或无效回执报告未知，可能已提交，但不重试、不补偿、不通过重新读取后续 writer 的状态猜测本次提交。页面摘要不是执行授权屏障，不能据“已配置”推断实际消费方已接线。

### 原子存储信任

IAM 会话的单记录信任仅由受信宿主组合代码提供：同步 `verifyAtomicStore(credentials)` 对当前精确实例返回 literal `true`，服务才接受其原子存储信任声明。缺失、异常、Promise 和其他返回值均拒绝。provider 自报的 `kind`、`durable`、`crossProcessLock` 或 `transaction` 不能代替证据；不能从用户配置、环境变量或 Client 推导 verifier。

这些声明不是后端能力的自动证明，也不是同权 JS 之间的隔离边界。同权代码仍可直接使用底层存储；隔离测试只承认其明确绑定的 fixture，不是产品开关或生产证明。

### 网关联合存储的组合接口

现行 SDK 没有联合修改 `CredentialRef` 与 `CredentialKey` 的方法。不得把 `set/unset` 放进 `modifyRecord` 冒充事务：共享逻辑锁可能自锁，分步操作也不能抵抗迟到写入。服务工厂的以下依赖仅供受信组合及隔离测试，不是配置、Host Service 新方法或 Remote 接口：

```text
getGatewayAtomicStore(credentials) -> adapter 或 undefined（同步、非 thenable）
verifyGatewayAtomicStore(credentials, adapter, scope) -> 仅字面 true 放行（同步）

// scope 固定 recordKey 与 ref；缺失字段使用 undefined，不使用环境回落值
adapter.snapshot(scope) -> Promise<{ record, value }>
adapter.compareAndSwap(scope, expectedPair, nextPair, guard)
  -> Promise<{ ok: false } 或 { ok: true, snapshot: committedPair }>
```

getter 与 verifier 绑定具体 credentials、adapter 和作用域。只比方法形状、自报属性或复用 grant verifier 均不足以放行。联合快照必须脱离后端引用；CAS 比较完整 record 和精确存储值，expected 不随失败更新、不重试。比较成功后，adapter 在同一不可让出的提交临界段恰好调用一次同步 guard；只有字面 `true` 可联合写入。guard 内重验专用信任及现有 provider、认证代际、独占状态和卸载状态。store 私有保留原始 expected 与 next，只把独立深拷贝交给 adapter；guard 还核对可见参数没有偏离原始快照或意图，回执只对私有原始 next 比较。不能用 adapter 改过的对象反过来定义“成功”；已提交后才发现偏离仍报告未知，不补偿。仅修改提交后的局部参数不改变该次真实回执的含义，返回元数据也不与 adapter 参数共享。此保护不证明 adapter 任意内部实现可靠，更不隔离恶意同权 JS。

新元数据采用内部格式 `version: 2`，增加随机 `writeOperationId` 和 `valueDigest`。前者区分写入代际，后者在分开读取值和元数据时检出错配；都不是原子能力或真实 Key 归属证明，不进入 HostView 或诊断。Key 原文仍只在引用中，不放进元数据。格式 1 永远只读；这不是产品一期 V1 或 IAM grant 格式版本的变更。

每次成功 clear，包括空状态与重复 clear，都联合写入新代际逻辑墓碑和缺失引用值，废止先前快照，不物理删除元数据记录。orphan、未知版本、错误 kind、digest 错配或墓碑配值均拒绝变更，不自动修复。回执只核对本次 committedPair，不读取随后当前 pair 判断此前提交；回执畸形、异常、无异常值的拒绝也统一报告未知，不输出底层原文。

| 错误码 | HTTP | 现行含义 |
|---|---|---|
| `IAM_GATEWAY_ATOMIC_UNVERIFIED` | 503 | 联合能力未核验；拒绝任何持久变更。 |
| `IAM_GATEWAY_LEGACY_READ_ONLY` | 409 | 旧格式或不一致目标保留，不自动迁移。 |
| `IAM_GATEWAY_CHANGED` | 409 | 快照冲突或提交前 guard 拒绝；不自动重试。 |
| `IAM_GATEWAY_WRITE_UNKNOWN` | 503 | 提交或回执无法确认；可能已生效，不补偿或重放。 |

内置 SQLite adapter 实现该契约，并有本地合成测试；目标平台与企业环境尚未验证。双键事务不包含其他进程的 IAM grant 授权事实；同步本地 guard 也不证明整个异步耐久写入期间授权不变。后置检查拒绝仅阻止发布旧上下文结果，不代表可撤回提交。清除保持原有允许未登录调用的策略，但仍受联合能力和记录状态限制。旧客户端及同权代码混用不享有本协议保证。

### 会话读取与同步

会话使用的 issuer 来自明确配置或本实例已验证的 metadata，不来自旧 grant 自证。操作在异步边界前捕获固定上下文，之后同步复查；锁内不获取 metadata/JWKS。恢复旧有效会话不为补齐未知上下文而新增网络请求。

登录 URL 生成、换码、回调写入/清理与刷新关键边界复核 provider 实例及声明；无需刷新的令牌在采用 grant 前也复查 provider 身份。共享同步在读取前后复查 provider 与本地操作，provider 失效或被替换时只丢弃本次仍持有的旧身份，不覆盖新会话。

同 provider 并发同步使用本地采纳版本与缓存身份快照保护结果。确认空记录也推进版本；旧读取及旧错误不能覆盖较新同步已采纳的身份或空状态。仅启动另一次读取不使先完成的有效读取失效，避免慢存储被轮询持续饿死；该版本不是持久存储版本或跨进程顺序屏障。

`getView()` 与 `getPrincipal()` 本身只读缓存，不进行实时 provider 查询，不构成即时撤权屏障。检查不能撤回 provider 在 mutator 返回后才发生的提交或迟到写入；生命周期协调与可靠提交确认仍是后端和受信组合的责任。

### 登录与回调清理

> 仓库评审依据为 CORP-DSH-DESIGN-002；该整仓材料不随安装包分发。本节说明包内实际登录与回调行为，不依赖包外链接。

Host 为登录尝试生成 state、nonce 和 PKCE S256；授权码只兑换一次。ID Token 校验签名（RS256/PS256/ES256）、issuer、audience/azp、nonce 与有效期等条件，拒绝 `none`/HS*；JWKS 未命中 `kid` 时重新获取一次。

回调写 grant 的锁内 mutator 同步复查本进程 attempt、代际与到期状态，失效时抛错而非把未写入当成功。新 grant 带随机 32 字节 canonical base64url `sessionInstanceId`，刷新保持该标识不变；它只用于记录匹配，不是认证凭据。

失败或取消后的回调清理只针对该回调记住的 store、会话标识及固定上下文。匹配时写 `{version: 1, type: 'heluo-iam-session-tombstone'}` 的固定逻辑墓碑（`kind: grant`），读取将严格匹配的墓碑视为空，新登录可以覆盖；物理记录仍存在。旧 V1 无标识仍可读，但不能被回调清理安全归属。坏记录、无标识、异常提交或回执不符均不能报告清理成功；远端只尽力撤销该回调自己的 refresh token。

### 刷新防重放

1. 读取并校验会话，锁外获取当前 metadata，精确比较旧 grant issuer 与该 metadata issuer；匹配后才取 JWKS 及 claim，不能借刷新响应改绑到另一 issuer。
2. 同一 grant 的短事务内复查完整记录，写入随机唯一 `refreshOperation={version,state:'pending',id,base}`；`base` 绑定原记录。只有提交回执得到确认才发送请求。
3. 在锁外发送一次刷新并校验响应。缺少新 refresh token、返回原 refresh token 或响应结果不确定时，不推测旧 token 可以复用。
4. 第二次短事务比较完整 pending 记录及操作标记，提交新 grant 和同操作 `complete` 标记；不能让迟到刷新覆盖另一登录。

同进程且 provider、issuer 上下文匹配的调用共用刷新 promise；其他参与者只等待自己观察到的操作，匹配操作标记、会话身份和令牌变化，不隐式采用另一授权。等待超时不是租约，不接管、不重发旧 refresh token。`invalid_grant`、网络不确定、校验或提交失败不返回旧 access token，不读后删除记录；已写入的 pending 保留并要求重新登录。若 complete 已提交但回复丢失，其他实例仍可能取得匹配结果，不能声称所有实例必然重登。

旧 grant 含 `resource` 而刷新结果删除该字段时，完整会话身份不一致，等待者和桥接拒绝本次结果；不复制旧 `resource`，也不自动迁移。

配置 Host 桥接时，Host 先核验 issuer 信任上下文并解析令牌，CLI 回读合法、未过期且无退出 pending 的当前会话，只输出与 Host 响应一致的 access token。无 `sessionInstanceId` 的旧 V1 也可按原 pending 的操作 version、id、base、会话身份及 refresh token 变化核验对应 complete；若首次读取为 active 而回读为 complete，则以完整原 grant 和 complete 的 id 计算 `base`，并核验身份和令牌变化。结果未确认、操作或会话不匹配时拒绝；不为桥接增加标识或迁移存储。该匹配仍受下述旧记录 ABA 和同权写入限制。

等待阶段采用单调时钟的 5 秒截止；只对无副作用的读取竞速超时，底层 I/O 不会被取消。首次读取、claim/写入、事件循环阻塞及退出自身 I/O 不在这一总等待界限内。迟到读取结果不能更新该次等待的视图。

普通 `/view` 对无标记、可刷新的过期会话可触发后台刷新，使用 30 秒退避。观察 pending 时视图进入 error；仅本实例明确观察并绑定的操作，才可在本地时钟 5 秒观察窗内由轮询采用匹配的合法 complete。记录或会话变化、过期、其他错误、读取失败、退出、卸载或新登录都会阻止该恢复；恢复后的视图仍不是服务端授权或强一致证明。

未知版本、状态或损坏操作标记拒绝使用。无标记的旧 grant 可由遵守协议的新进程在事务内受控升级；旧客户端混跑不享有这些保证。

### 退出与卸载

显式退出先使本实例登录尝试失效。对受信存储，退出读取完整 grant 快照并核验可用 metadata 的 issuer，在同记录锁内比较快照、拒绝 pending 或替换记录，再持久化唯一的 `signOutOperation` pending。释放锁后按 D1 以 `GET <revocationEndpoint>?access_token=…` 撤销访问令牌（不带客户端认证）；撤销确认后重新取得记录锁，只有 pending 仍与本次操作完全一致时才写固定逻辑墓碑并核对回执。未配置撤销端点时可直接完成本地逻辑清理，不宣称服务端撤销。回执三态：`result=true` 或 `result=false`+`errcode=2002` 记 ok，明确拒绝记 failed，超时/5xx/无法解析记 unknown。刷新令牌不随之撤销，只能自然过期；登录换票失败后的 RFC 7009 POST 清理是另一条路径，不用于退出。配置未显式 issuer 时，单独配置撤销地址不能代替发行者绑定；须先解析当前 discovery，issuer 不匹配或无法取得该上下文时保留持久 grant、报告 unknown。撤销 HTTP 请求最多 5 秒，不表示整个退出 I/O 有界。

未验证 provider 的退出不修改持久记录、不发撤销请求，只清运行时会话并报告 `IAM_CREDENTIALS_CLEAR_FAILED`、`revocation: 'unknown'`；重启仍可能恢复。存储异常、mutator 未执行、提交/回执不确定均不报告成功。已写入 pending 后，撤销失败、结果未知或进程中断会保留该状态；不重发旧令牌、不返回旧令牌，也不报告本地清理完成。撤销成功响应不证明当前授权及所有刷新后代被撤销。用户侧结果与边界见[退出说明](<user-guide.md#退出的结果与边界>)。

`dispose()` 停止订阅、attempt 和内存状态，保留持久 grant 与网关 Key，不执行撤销。Cordis 对普通函数插件的返回值不提供这里需要的生命周期托管；插件通过 `ctx.effect` 显式拥有 service、`ctx.iam` 注册与 webServer fiber 的释放。

### Client 请求顺序

账户页的本地代际使先前请求响应失效，退出时隐藏旧视图，并拒绝操作前及操作中的迟到轮询；非 2xx 返回视图和网络未知分别展示。用户主动“继续或重新登录”复用无参 `startSignIn()`，可能获得共享 attempt 或新建登录；同页防重，不自动取消或重试。取消/退出释放本页防重，旧请求的收尾不能解锁新请求。

这些规则不能撤回已发送请求或重排 Host。旧登录可能在退出后才被处理，随后页面显示无链接的登录中状态；恢复按钮只恢复可操作性。横幅独立轮询，跨组件即时同步、跨入口/标签/实例意图排序与条件取消均不在此保证内。onboarding 遮罩显式接收 pointer events，完成屏不因重复 ready 轮询倒退。

### 用户自助复制

两个复制入口只在设置账户页提供，采用浏览器 `clipboard.writeText`，只由用户点击触发。[MDN 接口说明](<https://developer.mozilla.org/en-US/docs/Web/API/Clipboard/writeText>)（2026-11-02 核对）要求安全上下文及允许写入；本插件不申请额外扩展权限、不绕过浏览器拒绝。复制登录链接要求本页仍有等待登录中的链接；不会向 Host 补发登录。授权 URL 含登录参数，不能作为脱敏诊断提供给支持人员。

“复制脱敏诊断”从点击时已取得的页面状态作固定白名单投影；不展开或序列化原始 view。只输出有限枚举、严格布尔值、数量及固定白名单错误码，未知值保持 unknown/null，不把缺失状态当成未登录或未配置。诊断版本是本地格式版本，不是包或宿主版本；不导出主体、配置值、URL、期限、设备标签、异常原文或输入草稿。

复制不会额外请求 Host、读取剪贴板或发起遥测/下载，也不会暂停既有轮询。API 不可用、同步异常或权限拒绝均显示通用提示，不输出异常内容，不自动重试。复制中的同步 guard 防止同页重复发送；退出、取消、新登录及卸载使旧提示失效。已发出的浏览器 I/O 不能撤回，不清空用户剪贴板，不承诺跨组件或外部应用的剪贴板顺序。真实浏览器权限、原生剪贴板和双端 WebView 仍需另测。

诊断 JSON 的固定字段如下；任何新字段均需显式评审，不能透传 Host 扩展字段。

| 字段 | 内容与未知值 |
|---|---|
| `format` / `version` | 固定 `forge-iam-diagnostic` / `1`；不是包版本 |
| `pagePhase` | `loading`、`ready`、`error`；其他为 `unknown` |
| `iamState` | 页面支持的 IAM 状态枚举；其他为 `unknown` |
| `configured` / `signedIn` | 严格布尔值；缺失或其他类型为 `null` |
| `exclusive` | `ok`、`not-ok`、`unknown`；不复制原因原文 |
| `gatewayState` | 页面支持的网关状态枚举；其他为 `unknown` |
| `errorCode` | 固定代码白名单；无错误为 `null`，其他为 `unknown` |
| `missingConfigCount` | 缺失配置数组的长度；非数组为 `null`，不复制数组内容 |

RP 退出的显式 `endSessionEndpoint` 是合法配置的必填项，并优先于 discovery 的同名值。六项受控 RP 上下文回归验证正常参数、未知/错配 issuer、`local` 模式不返回 RP URL，以及取消旧 discovery 的迟到窗口。测试保护既有行为；没有为构造失败而绕过配置校验，也没有把固定退出地址误写为 issuer 同源保证。真实 OP 退出会话和授权后代终止仍未验证。

## 本地开发与验证

需要在浏览器中完整体验模拟登录和模型对话时，参见[本地 mock 用户流程测试](<local-mock-testing.md>)。

以下命令在完整源码仓库根目录执行。测试、mock 脚本和仓库工具链声明不随安装包分发；不能在只有本包制品时照搬这些路径。使用仓库声明的 Node/pnpm 版本，不以本机默认版本替代。

```sh
# IAM 包的离线用例，按文件通配运行
node --test "packages/forge-iam/test/*.test.mjs"

# 聚焦仿 OIDC 登录、刷新、撤销
node --test packages/forge-iam/test/login.test.mjs

# 仓库检查
pnpm check
git diff --check

# 启动本地仿 OIDC；在另一个终端执行，Ctrl+C 停止
DSH_WEB_ORIGIN=http://127.0.0.1:<dsh-port> node packages/forge-iam/scripts/mock-oidc.mjs
```

最后一条命令中的 `<dsh-port>` 先替换为实际测试端口。脚本打印端点配置；它只启动模拟身份提供方，不改变凭据存储，也不改变门禁判定——能否登录取决于该 profile 的存储是否已通过受信联合存储校验。不要使用真实身份、Key 或企业凭据。协议用例通过受信测试代码注入合成 provider/verifier；不要把测试注入搬进产品配置。

本地模拟配置形态如下，端口使用占位值。JSON 只说明配置字段，不证明真实 IAM 登录或环境准入：

```json
{
  "issuer": "http://127.0.0.1:<mock-port>",
  "authorizationEndpoint": "http://127.0.0.1:<mock-port>/authorize",
  "tokenEndpoint": "http://127.0.0.1:<mock-port>/token",
  "jwksUri": "http://127.0.0.1:<mock-port>/jwks",
  "revocationEndpoint": "http://127.0.0.1:<mock-port>/revoke",
  "clientId": "dsh-desktop",
  "redirectUri": "http://127.0.0.1:<dsh-port>/iam/callback"
}
```

不把本地 HTTP 或 mock 端点用于生产。纯算法、组件 mock、内存 provider 与文件锁子进程夹具仅证明其受控输入和时序。账户恢复也有真实 service 加内存 provider 的受控请求交付验证，但不证明真实宿主调度。历史探针、源码检查与包体检查均不能替代当前双端、GUI、生产存储或真实 IAM/UAG 联调；具体执行结果与状态摘要在源码仓库的设计索引维护，不随包复制测试计数。

## 默认模型判定与写入结果

Host 已接入严格只读编排：可选绑定 llm 与 agentDefaultModel，在 IAM 就绪、网关状态变更和 llm/adapters-updated 时合并观察。defaultModel 为空时不注册模型注入，也不调用私有 SDK getter；缺 SDK、不满足 ready、凭据不匹配或选择无法证明时保守返回。观察只调用 listProviders/currentSelection，不读 saveSelection 属性、不发模型请求、不做额外 discovery。所有现有选择和 reasoningEffort 都保留，没有配置或私有注入可以解锁保存。该路径仍只读；唯一的写入在企业模型运行时，见下文“新对话默认模型对齐”。

`reconcileDefaultModel()` 仅为本包 Host 协调方法，不是 DSH 新增 SDK API 或 Remote/HTTP 接口。返回冻结的 `{ mode: 'read-only', written: false, verified: false, reason }`；reason 为固定代码，不带主体、原始选择、Key、令牌或 SDK 异常。结果没有放行含义，不证明目标模型存在、凭据有效、当前人员/用途或服务端权限。

工厂的私有 `getModelSelectionServices()` 同步提供 `{ llm, agentDefaultModel }` 或缺失。同一注入作用域必须返回同一个 binding 对象，并固定这两个实例；解绑返回缺失，再绑定使用新对象，即使复用同一 SDK 实例也不能复用旧作用域。标准 apply 已管理这一约定。该接缝只提供读取依赖，不接保存器或写能力。

观察复查认证代际、grant/credentials/SDK 与注入作用域身份；网关变更开始即使旧观察失效。单飞与一个待执行位合并外部触发，自身强制网关读取不形成反馈循环。getView/getPrincipal 本身不启动观察；模型失败不进入 OIDC 成功回调的 grant 清理或撤销分支。解绑与卸载清理监听器，旧结果不得发布为新上下文结果。观察可能发起或复用既有 gatewayLoading，退出也可能等待同一 provider I/O；这不是超时、取消或退出总耗时保证。

`evaluateModelGate` 与 `applyModelSelection` 仍是独立的纯判定加可注入写入器适配。Host 不把假设切换目标交给保存器；记录式 sink 的成功路径不是当前真实模型切换，input.selection.explicit 也不是 SDK 原生字段。

`applyModelSelection` 的 `written` 是三态，调用方应严格区分：

| written | verified | 含义 |
|---|---|---|
| `false` | `false` | 没有调用写入器；被门禁、保留规则或不可证明的当前选择阻止。 |
| `null` | `false` | 已调用写入器但调用抛错；提交结果未知，可能已经修改，保留 attempted，不补偿或自动重试。 |
| `true` | `false` | 写入调用返回；未提供回读、回读失败或不一致，不能证明实际持久修改。 |
| `true` | `true` | 调用返回且本次回读与目标一致；只证明这一观察，不证明排他、持久提交或是本次调用造成。 |

为兼容现有原因码，`selection-write-failed` 仍表示写入调用报错，不表示设置必然未变。 调用方应使用 `written === false` 判断未调用，不能用 `!written` 将 `null` 误当作可安全重试的未写入。SDK 异常与不一致回读的原文不进入 notes；结果对象仍含调用方模型标识，不能未经筛选当作脱敏诊断导出。

2026-11-02 只读 SDK 核验确认：`currentSelection()` 的声明始终返回 provider/model 对象，没有 explicit 或已定义的空态；`saveSelection(next)` 是完整选择覆盖，省略 reasoningEffort 会清除该设置。保存按提交顺序排队，没有比较快照、同步 guard 或取消接口，无配置 editor 时可不改设置而正常返回。因此不能把 null/undefined/双方空串或 provider 暂时未注册直接解释为“用户没有显式选择”，也不能承诺写前检查能撤回已排队的保存。用户已选择真实 Host 严格只读，禁止自动保存且完整保留现有设置；只读编排已按禁写边界接线。不把临时 fixture 的空态、显式标记或条件回调当 SDK 能力。

### 新对话默认模型对齐

2026-11-05 用户确认：内网环境官方模型不可用，企业补丁禁用官方行后 DSH 的出厂默认模型必然失效，首次登录直接发消息会得到 `session/model-unavailable`。因此由企业模型运行时（`src/managed-models.mjs` 调用 `src/host-default-model.mjs`）在目录就绪和启用集保存后对齐一次：

- 只在当前默认**可证明不可用**时写：提供方未注册；或是企业提供方但模型未启用、不在目录；或已注册提供方的 `listModels` 结果不含该模型。
- `currentSelection()` 读不出、返回异步值、`listModels` 抛错均按未知处理，不写。仍可用的选择（含非企业提供方）一律保留。
- 写入目标为 `{ provider: 企业提供方, model: defaultModelId }`，不带 reasoningEffort，由适配器取该模型推理强度下界。
- 写前复查 IAM 会话代际与准入；单飞，进行中再次触发只补跑一次；失败不重试、不补偿。对齐成功后发出 `llm/adapters-updated`，让客户端目录重新读取默认值。
- 结果以固定代码暴露在 `modelAccess.hostDefaultModel`：`aligned` / `kept` / `no-target` / `unsupported` / `unknown` / `stale` / `failed`，不含选择原文、主体或 SDK 异常。

SDK 的 `saveSelection` 仍无条件提交与取消能力：写前复查只缩小竞态窗口，不能撤回已排队的保存。

## 限制与生产门禁

**现行限制**：

- IAM 单记录事务依赖所有参与者遵守协议，且同记录跨进程排他与提交确认可靠；provider 迟到提交无法靠回读自证已消除。无标识旧 grant 的 ABA（记录被替换后又变回完全相同的字节）仍不能识别；此事务不提供网关两键或会话整体线性一致性，网关另受独立联合能力门禁约束。
- 默认组合经 `iam-atomic-store` 绑定 verifier；未知 provider 上旧有效 grant 仍可 ready/读取，退出保留持久记录。存储门禁不能抵御同权 JS 直接写存储。
- 旧 V1 不携带 discovery 来源，不能从旧记录自己取得可信 issuer。启动不联网；无明确 issuer pin 或本实例已验证的 metadata 上下文时，拒绝恢复身份、返回 AT 或采用其主体保存网关 Key，保留持久记录。显式 issuer 匹配的旧 V1 继续兼容，不因缺少 `sessionInstanceId` 一刀拒绝；不自动增加来源字段或迁移。只配 discovery 的新登录仍是有效配置，本实例取得可信 metadata 后可按其固定上下文处理会话。
- [只读模型采样](<../src/model-selection-host.mjs>)已接入 Host 生命周期，但没有实际保存或模型/工具执行授权。独立的[判定与记录式适配](<../src/model-gate.mjs>)保留显式选择、未知写入和回读缺口的测试；不把 SDK 缺少 explicit 或明确空态视为覆盖许可。真实默认模型配置不自动保存。
- 本地模型执行门禁与网关消费方已接入；真实企业授权和工具执行入口仍须分别核验。前端隐藏、Key 保存、ownerSubject 匹配及旧引用保留均不能证明实际调用已安全隔离；个人 A/B 授权路线及服务端归属校验未完成。
- 自动迁移旧凭据存储、Client Remote/watch 与凭据探测未实现；真实 GUI/浏览器调度、跨入口顺序、Windows/麒麟平台及真实 IAM/UAG 路径缺少完整验证。界面文案仍为中文，locale 元数据不等于界面全量本地化。

**生产开放前必须另行满足**：IAM 支持且落地的客户端认证与 secret 下发/存储/轮换/吊销；经审核并验证的目标平台存储、原子排他及提交语义；真实执行入口的身份/用途/授权检查与无官方或旧引用绕行；五分钟撤权、当前授权及刷新后代撤销的正式契约和联调；目标双端、GUI 与组合验收，以及责任方批准。现行代码和本地测试不能替代这些门禁。

仓库详细设计、外部契约、回函与设计索引是扩展评审材料，不随本包分发；安装包使用不依赖这些材料，但生产准入必须由对应权威证据判断。


## 可配置网关与动态模型目录

`managedModels` 仅接受可选的 `{baseURL}` 作为预填地址，不接受 Key、静态模型清单、协议或任意头。企业账号页将 `baseURL` 与个人访问凭证一并送至原凭证 PUT 路由；V2 元数据新增可选 `baseURL`，与 Key 在现有联合 CAS 中提交，不迁移旧只读记录。显式地址的兼容 Key 为 1—4096 个可见 ASCII 字符；旧的无地址路径继续使用 UAG 格式校验。Key 原文不进入视图、日志或错误响应。

新增同源 `GET /api/forge-iam/models`，在既有 Connection 认证后调用 Host 的 `refreshGatewayModels()`；返回 `{models,view}` 或精确错误码。该入口是用户主动刷新，直接发起一次目录同步。`modelAccess` 提供目录 `state`、`error`、`stale`、`retryAt`、`syncedAt`、`models` 及已保存地址；`stale` 表示列表仍是上次成功目录、网关此后未连上，`retryAt` 是下一次自动重试时间（不可重试的失败为空），`syncedAt` 是最近一次成功时间。它不是网关授权证明：调用仍按 `permit()` 与启用集合裁决。`resolveGatewayConnection()` 仅供 Host 返回绑定的地址、Key 与代际，每次通过 `resolveToken()` 复查会话及 Key owner，异步读取后复查生命周期；令牌不发往网关。

[模型运行时](<../src/managed-models.mjs>)通过公开 `llm.registerAdapter` 注册单一企业路由，通过 `llm/stream` 阻断其他提供方与目录外模型。目录请求带宿主 `attributionHeaders()`，只请求 `${baseURL}/models`，禁用重定向、限制响应大小与数量、去重校验 ID；例如 `baseURL` 为 `https://gateway.corp.example/v1` 时，请求路径为 `/v1/models`。同步失败保留上次目录并标记 `stale`：可重试的失败（连接、超时、限流）同时保留适配器，按 2/5/15/30/60 秒退避；不可重试的失败（凭证被拒、目录非法）保留目录但关闭模型调用表面，避免每次调用都打到网关再失败；身份或网关变化、显式退出才清空。地址/Key/身份变化、显式退出与令牌到期撤销旧代际；本地在途流收到 abort，迟到目录和内容不交付。展示用目录不随访问令牌过期清空：同一主体与网关下保留列表并以 `stale` 标注，调用仍被 `IAM_LOGIN_REQUIRED` 拒绝直到会话恢复。传输复用宿主公开 `PiAiAdapter` 与 SDK OpenAI-compatible 协议，不自写流协议。模型仅声明文本输入；标准列表没有容量信息，当前适配采用 `200000`（`200K`）上下文窗口与 `64000`（`64K`）最大输出本地容量默认值，不宣称为网关实际上限。

宿主公共模块经 `loader.import` 读取；能力缺失关闭模型入口。企业补丁同时关闭 `llm-pi-ai` 与 `ui-settings-models`，不创建其可写 namespace；IAM Standard Schema 不提供 volatile 配置字段，通用设置写接口不能添加自由提供方。用户对网关的修改统一走账号页及受信凭据事务。默认模型保持严格只读，不自动保存。`IAM_LOGIN_REQUIRED` 与网关凭证拒绝、403、目录异常分别展示；不使用原生 `AUTH` 表示退出，不自动重放失败请求。

模型启用与参数覆盖分两层。**启用集合**决定可用性：`modelOptions` 的键即"已启用"，值为覆盖参数（可为空对象）。未启用的目录模型照旧出现在账号页，但 `listModels` 不返回它，`prepareCall`/`resolveModel`/`llm/stream` 都以 `ENTERPRISE_MODEL_NOT_ALLOWED` 拒绝，避免"能选不能用"。首跑（该 subject 从未保存过）自动启用目录第一个模型并落盘；管理员配置了 `defaultModel` 且网关仍提供时优先用它。显式保存空集合是合法状态，不会被打回默认值——区分"从未保存"与"保存为空"的是 `readModelSelection()` 返回的 `saved` 标志。

**持久化**在宿主侧凭证记录的独立键 `heluo-iam/model-selection`（`createModelSelectionStore`，`grant` 类载荷，仅存 subject、模型 ID 与覆盖参数，不含凭据）。读写都以回读的 grant subject 为准，换人不继承旧记录，过期写入拒绝 `IAM_NOT_SIGNED_IN`；该记录不参与网关凭证的联合原子事务，最后确认写入者胜，失败不阻断调用（`updateModelOptions` 返回 `persisted: false`，面板据此提示）。`PUT /api/forge-iam/models` 仍只改本地 `PiAiAdapter` 目录，不写 profile 配置、不改网关目录。面板以当前账号的宿主选择为准（包括显式空集合），浏览器缓存仅作副本，不向宿主自动回推；账号或宿主选择变化时更新显示，避免旧缓存覆盖已保存选择。模型行提供“一键启用”“一键停用”与“全部默认启用”快捷操作，支持一键采用默认参数（`200K` 上下文、`64K` 最大输出）启用并立即持久化生效；已启用模型的行可直接停用，不必展开精细配置。行上停用与一键启用对称：改完启用集立即提交整份集合，因此会连同其他未保存的面板修改一并生效；停用默认模型时由宿主在同一次提交内重算默认模型并同步宿主新会话默认，停用最后一个模型提交显式空集合，重新启用前新对话无企业模型可用。推理等级仅开放 `'off'`、`'low'`、`'medium'`、`'high'`、`'xhigh'`、`'max'`，按宿主 `thinkingLevelMap` 语义生成，支持快捷档位及自由选择推理强度下界（最低档）与上界（最高档，`buildReasoningEffortRange` / `getReasoningEffortBounds`），所选区间外档位显式置 `null`；线名由档位名推导，暂不支持逐档自定义字符串；`off` 不下发线值，`thinkingLevelMap.off` 恒为 `null`，请求以省略 `reasoning_effort` 表示不抑制推理；宿主传来不支持的档位时返回 `ENTERPRISE_MODEL_REASONING_UNSUPPORTED`，网关返回 4xx 时返回 `ENTERPRISE_GATEWAY_REQUEST_REJECTED`，两者都不再伪装成不可达。`contextWindow`/`maxTokens` 接受正整数或 `K`/`M` 后缀；`maxTokens` 仅在显式覆盖时计入 `configuredMaxTokens`。回归：`node --test packages/forge-iam/test/managed-models.test.mjs packages/forge-iam/test/model-selection-store.test.mjs packages/forge-iam/test/model-selection-service.test.mjs packages/forge-iam/test/client-managed-models.test.mjs packages/forge-iam/test/model-options.test.mjs`。

回归命令：`node --test packages/forge-iam/test/managed-models.test.mjs packages/forge-iam/test/gateway-atomic-service.test.mjs`。安装宿主组合探针：`node scripts/probe/run-iam-managed-models-probe.mjs`；支持现有 `DSH_BIN` / `DSH_NODE_MODULES` 定位参数。探针使用实际 Cordis/LLM/PiAiAdapter、模拟 IAM 与网关及显式内存事务夹具，验证登录、标准目录、流式对话、刷新和退出后零模型请求；不构成生产存储、真实 IAM/UAG 或双端 GUI 验收。

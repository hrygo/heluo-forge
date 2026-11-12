# @heluo/forge-iam

`@heluo/forge-iam` 是 DSH 企业组合中的 IAM 登录插件。Host 负责 OIDC 授权码与 PKCE S256、回调、会话刷新和退出；Client 提供企业账号页、登录引导和状态展示。

状态：可用（开发骨架）。SQLite 凭据组合、存储门禁和协议流程具有本地测试；真实 IAM 未联调，网关及目标宿主的验证范围以设计索引为准，本地测试不代表生产就绪。

模型网关的个人访问凭证 `ENTERPRISE_STATIC_KEY` 由企业账号页或引导页管理。IAM 登录不写入 `ENTERPRISE_ACCESS_TOKEN`，启动时保留已有旧引用；`gatewayResource` 配置后作为 grant 上下文约束。凭据探测与真实 IAM/UAG 联调尚未完成。

## 阅读入口

| 目的 | 入口 |
|---|---|
| 按运行位置读取身份、令牌或存取业务凭据 | [凭据接入指南](docs/credential-access.md) |
| 使用模拟 IAM 完成本地验证 | [本地模拟验收指南](docs/local-mock-testing.md) |
| 查询服务、路由、状态机与配置 | [IAM 开发指南](docs/developer-guide.md) |
| 从常驻入口查找接入示例 | [issue #260](https://github.com/hrygo/heluo-forge/issues/260) |

## 当前实现

- 模型门禁：`src/model-gate.mjs` 的 `evaluateModelGate` 是纯判定，不修改设置。未登录、网关凭据缺失或企业模型不可用时拒绝；对未选择、当前选择不可用或同提供方的非显式选择，可返回企业模型候选；显式企业选择予以保留，其他可用提供方不静默放行。
- 模型写入适配：`applyModelSelection()` 只调用显式注入的写入器，用于隔离验证；写入前独立复查，当前选择无法证明时不写，写入后回读不一致则报告未验证。记录式 sink 的结果不代表真实 Host 设置已改变。
- 新对话默认模型观察：企业模型目录就绪或启用集变更后，`src/host-default-model.mjs` 只读观察宿主选择，不访问 `agentDefaultModel.saveSelection`。

默认模型始终由用户选择，系统不自动修改，见总体架构 `ADR-20`。当前模型不可用时，用户在宿主中选择其他已启用模型。

| 项 | 状态 |
|---|---|
| 形态 | Host + Client 插件；Client 使用 interim same-origin route 与 2 秒轮询，Remote/watch 未接 |
| 配置 | `src/config.mjs`：显式端点/discovery、issuer、clientId、可选 `gatewayResource`/`gatewayConsoleUrl`、redirectUri/callbackPort、超时与安全开关；`scopes` 必须含 `openid`，回调路径不得占用 `/api/forge-iam` |
| 状态机 | `src/state.mjs`：`unconfigured` / `signed-out` / `authenticating` / `ready` / `expired` / `unreachable` / `error` |
| 凭据记录 | `src/record.mjs`：`IamGrantV1` 校验、到期/刷新判定；写入 `credentials` 的 GrantRecord |
| 凭据适配 | `src/store.mjs`：GrantRecord、网关凭据（`ENTERPRISE_STATIC_KEY` + `kind: grant` 的不透明元数据记录）、锁内 `mutate`、旧镜像清理方法（启动不调用）、官方旧记录检测 |
| 网关凭据 | 录入/替换/清除与状态（未配置/已配置/属于其他账号/记录损坏）；显示存储来源，非 keychain 时提示未受系统保护；不签发、不刷新、不探测；退出与卸载保留 |
| Host 服务 | `src/service.mjs`：OIDC 登录、state/nonce、PKCE S256、token 交换、ID Token/JWKS 校验、刷新、撤销 |
| 登录/刷新/撤销 | 协议和存储门禁有离线 mock 测试；真实 IAM 与目标机联调未完成 |
| 凭据 provider | 独立包 `@heluo/forge-credentials-keychain` 使用 SQLite 值级加密；组合根绑定受信的单记录及联合存储，目标平台尚未取证 |
| Client UI | `settings.section` 企业账号页、四步引导和未登录横幅；登录使用浏览器回调 |

账户页退出时清除旧视图并丢弃该操作前及操作中的迟到轮询；非 2xx 的返回视图与网络结果未知分别展示，不将未知结果显示为退出成功。横幅独立轮询，跨组件即时同步和真实 GUI 挂载仍待验证。登录请求若在退出完成后才由 Host 处理，旧响应会被丢弃，界面可能停留在无链接的登录中状态，需取消后重试。引导完成页不会因轮询回退；overlay 显式开启 pointer events。

## Host 分轴模块

`src/service.mjs` 只做装配与服务出口，内部状态按轴分给下列模块。每个模块只有一份可写状态，跨模块读写一律经工厂参数（端口）而非直接取用；依赖方向由 `test/service-state-structure.test.mjs` 冻结。

| 模块 | 拥有的状态 | 职责边界 |
|---|---|---|
| `src/service-state.mjs` | `state`、`error`、`lastGrant`、`sessionAuthentication`、`disposed`、`exclusive`、监听器集合 | 唯一的状态写入路径、`view()` 投影与 `notify()` 发布 |
| `src/service-store.mjs` | 凭据 provider、凭据缓存、网关 store、选型 store、网关摘要与 epoch | provider 解析、原子性断言、网关摘要缓存与 epoch 递增 |
| `src/service-grant.mjs` | `metadataCache`、`jwksCache`、`identityProfile`、grant 归属表 | 协议缓存、登录/刷新/回调的绑定与校验、身份投影 |
| `src/service-model-selection.mjs` | 选型单飞、排队标志、选型代际、选型读写 | 默认模型勘定与其单飞、选型记录的读与写；只经端口反向读网关 |
| `src/service-gateway.mjs` | 网关凭据摘要、加载时间、加载单飞、网关 epoch | 网关凭据的读取、解析、保存与清除，摘要失效；变更时通知选型 |
| `src/service-token.mjs` | 刷新单飞及其 store/credentials/issuer/认证描述符、Host 续期计时器与退避 | `resolveToken` 与 `getAccessToken` 的完整刷新路径 |
| `src/service-reconcile.mjs` | 无（经端口读写观测标志与发布计数） | 记录到视图的勘定：`syncFromStore`、`hydrate` |
| `src/service-signin.mjs` | 登录 attempt 及其计时器 | `startSignIn`、回调、取消，含 verifier/nonce 的归属 |
| `src/service-signout.mjs` | 退出单飞、`signingOut` 标志 | `signOut`、清理、桥接凭据 |
| `src/service-helpers.mjs` | 无 | 纯函数与共享常量（时间、错误码映射） |
| `src/session-identity.mjs` | 无 | Host 与 CLI 共用的会话身份和刷新记录绑定纯逻辑 |

各轴的修改落在所属模块；`service.mjs` 负责装配，不持有其他模块的业务状态。

## 改动落点

客户端由单个 `client.js` 加载，通过文件内分区锚点划分职责；`grep -n "// §" packages/forge-iam/client.js` 可列出分区。`test/client-structure.test.mjs` 按符号归属检查状态判定、存储访问、错误解包与渲染入参。

四段结构由锚点区间体现，段间单向依赖：

| 段 | 锚点 | 允许依赖 |
|---|---|---|
| 纯函数与常量 | §1–§3、§4 状态标签、§9 错误文案 | 无 |
| IO 边界 | §5 HTTP 封装、§8 本地存储 | 纯函数段 |
| 状态所有权 | §7 登录窗口、§10 诊断快照、§11 会话轮询、§13 模型缓存 | 上两段 |
| 视图与出口 | §6 网关状态、§12 卡片、§12.1–§12.4、§13.1、§14 面板、§15 启动器、§16 横幅与引导、§17 出口 | 以上各段 |

结构守卫按符号归属而非行号判断：状态字面量属于 `deriveSessionUi` / `deriveModelUi`，`localStorage` 属于 `createClientStore`，错误码解包属于 `resultNotice` / `resultCode`；`render*` 的解构键不超过 4 个，且只取自 `{h, ui, model, actions}`。这些基线只能收紧。

| 要改的东西 | 落点 |
|---|---|
| 登录态、徽章、旅程条口径 | `client.js` §4 状态标签、§6 网关状态与徽章、§9 错误文案 |
| 请求、本地存储 | `client.js` §5 HTTP 封装、§8 本地存储 |
| 账户卡、网关卡 | `client.js` §12、§12.1 |
| 模型条目、模型卡、模型缓存 | `client.js` §12.2、§13、§13.1 |
| 面板装配、轮询 | `client.js` §14，轮询 §11 |
| 设置页启动器 | `client.js` §15 |
| 未登录横幅、四步引导 | `client.js` §16、§16.2、§16.3 |
| 宿主：配置、状态机、凭据记录 | `src/config.mjs`、`src/state.mjs`、`src/record.mjs`、`src/store.mjs` |
| 宿主：登录、令牌、网关与模型业务 | [Host 分轴模块](#host-分轴模块) |

## 登录边界

### 授权与回调

- 授权码 + PKCE S256；回调绑定单次 `state`/`nonce`，校验 ID Token 签名（RS256/PS256/ES256，拒绝 `none`/HS*）、issuer、audience（含多 audience 的 `azp`）、nonce、exp；`kid` 未命中时重取一次 JWKS。
- token 交换与刷新只由 Host 发起。账户页和引导使用授权 URL 与非敏感 `IamView`；已通过 Connection 鉴权的同源页面可按需调用令牌接口，见[凭据接入指南](docs/credential-access.md)。
- 回调路径默认 `/iam/callback`，由 `redirectPath` 注册；不得为站点根或以 `/` 结尾（DSH 路由是不带尾斜杠的绝对路径）。显式 `redirectUri` 必须为 HTTP(S) 地址，其 path 与 `redirectPath` 一致且不含 query/fragment；运行时还须与实时回调 Origin 同源，否则以 `IAM_CONFIG_INVALID` 拒绝。生产值须符合 IAM 的登记规则。
- 生产形态配置 `callbackPort: 0`：插件自建回环监听，端口由系统分配，回调地址在登录发起时才确定，监听也只在这次尝试期间存在（RFC 8252 §8.3）。需要固定端口时填 1024–65535；绑定失败直接拒登录并报 `IAM_CALLBACK_PORT_UNAVAILABLE`。省略 `callbackPort` 时仅使用宿主实时 Origin，供开发与兼容；配置后仅使用已绑定回环监听的实时 Origin，两者不互相回落。Origin 缺失、获取异常或不是有效 HTTP(S) 地址时，以 `IAM_CALLBACK_UNAVAILABLE` 拒绝登录，不生成授权链接。`callbackAddress` 默认 `auto`，始终先试 `127.0.0.1`，只在该地址族不可用时退到 `::1`；IPv6 需另行登记前缀 `http://[::1]`。
- IAM 协议端点和网关地址接受 HTTP 或 HTTPS；含旧配置项 `allowInsecureHttp` 的有效 profile 仍可使用，该项按未知键忽略且不出现在规范化结果中。新配置不得设置该项，调用方不得依赖其开关行为。HTTP 不提供传输加密或端点身份认证，会暴露令牌、Key 和请求内容。
- 显式端点齐全时不强制拉取 `discoveryUrl`；issuer/authorize/token/JWKS 缺项时使用 discovery 补齐。

### 凭据与网关

- IAM access token 保存在 GrantRecord 与内存，不写 `ENTERPRISE_ACCESS_TOKEN`；启动也不自动删除已有旧引用。保留不等于阻止消费：若旧配置或其他组件继续解析该引用，可能构成绕行，须在实际执行入口阻断并另定受授权的遗留处理。企业模型运行时使用 `ENTERPRISE_STATIC_KEY` 并实施本地调用门禁；其他消费入口和服务端授权仍须分别核验。
- 网关凭据值写入 `ENTERPRISE_STATIC_KEY`，录入人和设备标签写入独立记录 `heluo-iam/gateway-credential`。换账号、启动恢复、共享会话同步、回调或取消均不自动删除现存值及元数据。新格式的显式保存与清除要求受信联合存储，值和元数据通过条件提交一起变更；旧格式和不一致记录保留，不被采用或自动修改。提交或回执异常时结果可能未知，不自动重试或补偿。

### 会话刷新与恢复

- Host 在访问令牌或已知刷新令牌到期前调度续期，复用单飞与原子提交；Host 停止、设备休眠或断网期间不能保证续期。
- 写入 pending 前，Discovery 或 JWKS 预检发生网络故障、HTTP 408、429 或 5xx 时，保留未失效的刷新授权并退避重试。获取刷新写锁超时且回调尚未进入时，使该次回调失效，对未变的可刷新会话退避重试；本次调用仍返回 `IAM_REAUTH_REQUIRED`。回调已进入或提交结果未知时失败关闭。
- 过期的访问令牌不返回。刷新请求结果不确定或 `invalid_grant` 时保留 pending、要求重新登录，不返回旧令牌。无标记且可刷新的过期会话可在后台恢复。
- 无需刷新的令牌读取在采用 grant 前复查 provider 实例；读取期间 provider 被替换或撤销时拒绝返回旧令牌。此检查不覆盖所有状态同步和 provider 生命周期交错，也不证明真实执行门禁。
- Host 启动或凭据服务重新绑定后，凭据与对应的原子存储信任均就绪时恢复已有会话并安排续期；信任暂不可用时不启动后台刷新，重新绑定后继续恢复。刷新写入结果未知时仍保持失败关闭。

### 回调清理与退出

- 登录回调写 grant 时，在 `credentials.modifyRecord` 的锁内 mutator 同步复查本进程 attempt、epoch 和到期状态；失效则抛出取消或过期错误并拒绝写入，不将未写入当成成功，避免等待锁的旧回调覆盖新 grant。
- 新回调 grant 使用随机 32 字节 canonical base64url `sessionInstanceId`，刷新 pending/complete 保持不变；该标识仅用于记录匹配，不是认证凭据。缺少该标识的旧会话不被采用。回调写入前捕获目标 store 与 grant；失败或取消时使用一次 `modifyRecord`，锁内核对标识与固定上下文，仅对自己的记录写入无敏感信息的 `{version: 1, type: 'heluo-iam-session-tombstone'}`（`kind: grant`）。严格墓碑读取与 mutate 视为空，新登录可覆盖，物理记录仍存在。坏记录、无标识或提交结果不确定均按清理未知处理，不得报告成功；只尽力撤销该回调自己的 refresh token。
- 此机制依赖所有参与者和 provider 提供可靠的同记录跨进程原子锁及提交确认；无此能力或旧客户端混跑仍不安全。写操作异常后仍可能迟到提交，无法仅凭清理或回读自证闭环；远端撤销未验证，不保证多键事务或会话整体线性一致。
- 可信 provider 的退出先核对完整 grant 并持久化随机 `signOutOperation` pending；有可用撤销端点和 access token 时在锁外发起撤销，确认后再次条件比对并写墓碑。没有撤销端点时只执行本地清理。撤销失败、未知或进程中断时保留 pending，旧令牌不可读取或重发；迟到的退出不会清除新登录。网关凭据保留；合成测试不证明真实远端授权及刷新后代撤销。
- 插件卸载只释放订阅、attempt 与内存状态，但不撤销也不删除 GrantRecord 与网关凭据；下次启动 `hydrate` 恢复。显式 `signOut` 在可信原子存储上条件清除 IAM 记录，并在撤销端点可用时请求撤销当前 access token；墓碑不等于物理删除。

### 接口与客户端生命周期

- 同源管理 API 使用 DSH `ctx.connection.requestRejection` 鉴权；`ctx.connection` 缺失时 fail closed 返回 503。自定义 `x-forge-iam-request` 头只作 CSRF 意图校验，不替代身份认证。回环桥 `/api/forge-iam/bridge/token` 不走 Connection，须验证回环来源与存储中的能力值；回调使用 `state`/PKCE 并保留自己的 Host 校验。
- 插件卸载清理由 `ctx.effect` 登记：Cordis 4 对普通 `function apply` 走构造器分支，不收集返回值，因此 `service.dispose()`、撤销 `ctx.iam` 与停止 webServer fiber 都必须显式登记，否则禁用/重载只撤销路由注册，不会清理运行时状态。
- 界面使用宿主主题 token（`--dsw-alias-*`）；包内 `locale/{en,zh}.json` 与 `icon.svg` 提供插件管理面的显示元数据；`icon.svg` 直接取自预置品牌资产 `docs/assets/branding/cyber-long/components/forge-iam-symbol.svg`，逐字节一致，不另绘，界面文案仍是硬编码中文。

### 凭据归属与独占状态

- 已存凭据的 `ownerSubject` 与当前主体不同时，view 显示 `owner-mismatch`；有值但元数据缺失或损坏时显示 `invalid`，保留原值和记录供用户处置。`ownerSubject` 只表示录入人，不证明 Key 的真实归属。这些状态、前端隐藏及模型门禁纯判定不能代替调用授权；本地企业模型运行时有独立执行门禁，其他消费方仍可能解析该引用。真实企业授权、工具入口和服务端归属校验未完成，不能据此宣称生产可用。
- 独占断言发现 `deepseekAccount` 仍挂载时进入 `error`，不写入任何模型凭据。

## 原子存储运行时门禁

内置 SQLite 凭据组合提供绑定当前 provider 实例的 `iam-atomic-store`；IAM 的 `apply` 通过该服务验证单记录操作并取得独立的网关联合 adapter。注入的测试 backend 不获得信任，缺失、异常、Promise 或非 `true` 的验证结果均拒绝受保护操作。provider 自报的 `crossProcessLock`、`durable`、`kind`、`transaction` 不是可信证据，也不得从用户配置、环境变量或客户端推导。该绑定不是同权 JS 隔离边界：同权代码仍可直接访问底层存储或自行注入服务。未知 provider 的旧有效 grant 可能只读恢复；退出不修改持久记录或发送撤销，并报告结果未知。跨平台原子性、提交确认和企业环境仍待实机验证。

登录 URL、换码、写入、回调清理及刷新 claim、发送和提交前复核身份与声明；异步边界和锁内 guard 复核，防止新 provider 冒充原实例。provider 执行 mutator 后、实际提交前替换或迟到提交无法由调用方检查撤销，安全仍依赖可信组合协调替换及 provider 的提交语义；未知提交不宣称成功。公共客户端使用带 `sessionInstanceId` 的 V1，会话缺少该标识时拒绝采用；不宣称 signOut、网关消费或多键事务安全。

## 刷新防重放

刷新使用本地 write-ahead 协议，避免轮换后的 refresh token 因响应丢失而被重发。

1. 发送 IdP 请求前，对同一 grant 执行短暂 `modifyRecord`，写入随机唯一的 `refreshOperation` pending 标记。标记包含版本、状态、标识和绑定原记录的随机盐摘要；只有 provider 确认写入成功才发送请求。首次提交抛错或未确认时不发送请求。
2. 请求和响应校验在锁外进行。成功后通过第二次短事务核对完整 pending 记录，条件提交新 grant 与同操作的 `complete` 标记，避免迟到的旧刷新覆盖新登录。
3. 等待者绑定 pending 的 issuer、clientId、resource、subject、obtainedAt 和原 refresh token。可采用的 complete 须有相同 version/id/base、相同身份、已变化的 refresh token 和未过期 access token；未知或损坏记录失败关闭。

超时、崩溃或响应不确定时保留 pending 并要求重新登录，不接管或重发同一 refresh token，不返回旧 access token，也不显示 ready。响应缺少新 refresh token 或返回原值时同样保留 pending 并要求重新登录。重新登录使用既有授权路径替换记录；刷新失败时不以读后删除清理记录。若第二次提交已成功但响应或通知失败，发起方不能确认结果，其他实例仍可能读到已提交的 complete。

### 等待与视图恢复

`waitFor` 使用单调时钟的 5 秒截止时间；轮询 sleep 不超过剩余时间，仅对无副作用的读取使用 `Promise.race`。超时不会取消底层 I/O，迟到的结果不得改变视图或产生未处理拒绝；读取完成及采纳前重新检查截止时间和生命周期。进入等待前的首次读取、claim 和写入不使用竞速超时，也不属于该等待时限；`signOut` 的全部 I/O 不受此时限保证。

观察到 pending 的视图进入 error。本实例明确观察到 pending 时，内存保存该操作的 version、id、base、原会话身份、refresh token 摘要与 authEpoch，并允许普通轮询在按本地时钟计算的 5 秒观察窗口内恢复。complete 须匹配原操作和会话，refresh token 已变化，配置上下文与 access/refresh 有效期检查通过，且本地生命周期未变。记录仍为 pending 时继续失败关闭；标记或会话改变、读取错误、超时、其他错误、退出、卸载或新登录尝试均不使用此路径恢复，也不隐式采用其他会话。恢复后的状态只是本地视图，不证明服务端认证或强一致性；记录在读取后仍可能被并发替换。显式解析遵循其对应规则。

### 前提与限制

无刷新操作标记且带 `sessionInstanceId` 的有效 grant 可由遵守协议的进程在事务内声明刷新。该机制依赖所有参与者遵守协议，并依赖 `modifyRecord` 对同一记录提供真实跨进程原子排他和可靠提交确认；旧版本进程、无锁 provider 或非原子写入不享有此保障。会话校验可拒绝误写和另一授权，不能防止有存储写权限者篡改记录。现有测试中的存储与 IdP 不能证明生产后端或企业 IdP 的行为；条件墓碑与刷新协议也不证明多键事务、远端撤销或会话整体线性一致。

## 企业模型设置闭环

企业账号页管理网关地址与个人访问凭证，通过 `${baseURL}/models` 获取目录；例如 `baseURL` 为 `https://gateway.corp.example/v1` 时，请求路径为 `/v1/models`。登录和凭证就绪后才能列出或调用模型。

身份或网关变化、显式退出会清理旧目录并撤销旧调用代际；令牌到期会阻止新调用并撤销旧调用，同一主体与网关下的目录可保留并标记为 `stale`。目录和启用集中的首选项不等于宿主默认模型；用户在对话中自行选择模型。

配置与执行边界见[开发指南](<docs/developer-guide.md#可配置网关与动态模型目录>)；本地实现不代表生产原子存储、真实 IAM/UAG 或工具授权门禁已获准入。

## 组合顺序

- 先挂载 `@heluo/forge-credentials-keychain`，并禁用 `dsh-credentials-local`；再挂载 `@heluo/forge-iam`。IAM 通过 `getCredentials` 延迟读取 `ctx.credentials`，但生产不应依赖加载顺序来获得存储。
- 凭据包默认使用值级加密 SQLite；不可用、密钥丢失或发现旧 `credentials.json` / `credentials.key` 格式时 fail closed，不回退明文或迁移。内存后端仅供测试且不获得可信声明。
- 官方登录、模型和明文凭据相关行由企业组合包禁用；IAM 会在启动、登录、回调、刷新前复查 `deepseekAccount`，发现残留即进入 `error`。该服务检查不证明其他官方行或执行旁路均已关闭。

## 本地 mock

完整的浏览器模拟登录、网关和模型对话步骤见[本地模拟验收指南](<docs/local-mock-testing.md>)。以下命令分别启动测试用 OIDC 服务和运行模拟测试，不解除正式组合的存储门禁：

```sh
# 打印 mock 端点配置（仅供隔离测试）
node packages/forge-iam/scripts/mock-oidc.mjs

# 登录、刷新与撤销的模拟测试
node --test packages/forge-iam/test/login.test.mjs
```

配置示例（`<dsh-port>` 换成当前 DSH Web GUI 端口；也可省略 `redirectUri`，由 Host 从 `webServer` 推导；启动 mock 前可设 `DSH_WEB_ORIGIN`）：

```json
{
  "issuer": "http://127.0.0.1:<port>",
  "authorizationEndpoint": "http://127.0.0.1:<port>/authorize",
  "tokenEndpoint": "http://127.0.0.1:<port>/token",
  "jwksUri": "http://127.0.0.1:<port>/jwks",
  "revocationEndpoint": "http://127.0.0.1:<port>/revoke",
  "clientId": "dsh-desktop",
  "redirectUri": "http://127.0.0.1:<dsh-port>/iam/callback"
}
```

以下配置将凭据库存放于隔离测试目录；路径须位于 Git 工作区外：

```json
{
  "storeDirectory": "<isolated-test-directory>"
}
```

**不要把上述 mock 配置用于生产。** 目标机存储、宿主与 IAM 回调仍须分别验证。

## 测试

```sh
# 运行 IAM 包测试
node --test "packages/forge-iam/test/*.test.mjs"
```

根检查：

```sh
pnpm check
git diff --check
```

## 关联

- 实施 issue：`#13`
- 详细设计：`docs/design/plugins/forge-iam.md`
- 官方行禁用：`docs/design/plugins/forge-enterprise.md`
- IAM 询问函：`docs/collaboration/team-confirmation-letters.md` §4.2

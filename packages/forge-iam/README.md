# @heluo/forge-iam

状态：可用（开发骨架）；SQLite 原子存储与组合门禁具备本地测试，目标平台尚未取证，真实 IAM 未联调、未上线。

> 2026-10-22 原基线调整：模型网关使用 UAG 个人访问凭证（`ENTERPRISE_STATIC_KEY`），由账户/引导 UI 录入与清除；IAM 登录不再镜像 `ENTERPRISE_ACCESS_TOKEN`，现存旧引用在启动时保留；`gatewayResource` 变为可选（仅当配置时校验 grant 的 audience）。凭据探测与真实 UAG 联调仍待网关包，未联调、未上线。

一句话：企业 IAM 独占登录插件。Host 负责 OIDC Authorization Code + PKCE、回调、刷新与撤销，Client 负责账户页和引导；生产仍依赖目标平台存储验证、IAM 回函与真实端点联调。

## 当前实现

- 模型门禁：`src/model-gate.mjs` 提供 `evaluateModelGate`（纯判定，fail closed）。未登录一律拒绝且不给切换目标；网关凭据缺失、无企业模型、企业模型不可用分别拒绝；默认模型只在「没有显式选择」或「当前选择不可用」时切到企业模型，不覆盖显式企业选择；可用但不属于企业的提供方不静默放行。
- 模型写入接线：`applyModelSelection()` 把判定落到设置，写入前**独立复查**（显式且仍可用的选择一律不覆盖，即使判定被伪造要求切换）；当前选择读不出来就不写；写入后回读不一致按未验证缺口报告。演练用记录式 sink。
- 新对话默认模型对齐：`src/host-default-model.mjs`。企业模型目录就绪或启用集变更后，若 DSH 的新对话默认模型**可证明不可用**（提供方未注册、企业模型未启用/不在目录、或已注册提供方的模型列表里没有它），调用一次 `agentDefaultModel.saveSelection` 改为企业默认模型；仍可用的选择一律不动，读不出或列表报错按未知不写，失败不重试。依据：2026-11-05 用户确认内网环境官方模型不可用，取代 2026-11-02 的“严格不写”决策。

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
| Client UI | `settings.section` 账户页、四步 onboarding、未登录横幅（不占用单占位 launcher）；登录走浏览器回调。账户页退出时清除旧视图并拒绝该操作前及操作中的迟到轮询；非 2xx 的返回视图和网络未知分别显示，不假装退出成功。此行为仅有 mock 组件测试，横幅为独立轮询，跨组件即时同步及真实 GUI 挂载仍待验证；登录请求若在退出完成后才被 Host 处理，旧响应会被丢弃，可能出现无链接的登录中状态，须取消后重试，真实宿主调度未验证。overlay 显式开启 pointer events，onboarding 完成屏不被轮询回退 |

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

**改动落点**：状态判定改 `service-state.mjs`；协议与校验改 `service-grant.mjs`；刷新改 `service-token.mjs`；勘定改 `service-reconcile.mjs`；登录/回调改 `service-signin.mjs`；退出改 `service-signout.mjs`；网关与默认模型改 `service-gateway.mjs`、`service-model-selection.mjs`。`service.mjs` 只在新增轴或改装配顺序时动。

## 改动落点

客户端是单个 `client.js`，边界靠分区锚点而不是文件：`grep -n "// §" client.js` 会列出全部落点，文件头有分区索引。结构守卫在 `test/client-structure.test.mjs`：状态判定、存储访问、错误解包与渲染入参的现状按「所属函数」冻结成基线，只能下调，不能新增。

四段结构由锚点区间体现，段间单向依赖：

| 段 | 锚点 | 允许依赖 |
|---|---|---|
| 纯函数与常量 | §1–§3、§4 状态标签、§9 错误文案 | 无 |
| IO 边界 | §5 HTTP 封装、§8 本地存储 | 纯函数段 |
| 状态所有权 | §7 登录窗口、§10 诊断快照、§11 会话轮询、§13 模型缓存 | 上两段 |
| 视图与出口 | §6 网关状态、§12 卡片、§12.1–§12.4、§13.1、§14 面板、§15 启动器、§16 横幅与引导、§17 出口 | 以上各段 |

守卫不按行号定位段（行号会随编辑漂移），而是按「符号归属」判：状态字面量只允许出现在 `deriveSessionUi`/`deriveModelUi`，`localStorage` 只允许出现在 `createClientStore`，错误码解包只允许出现在 `resultNotice`/`resultCode`，`render*` 的解构键 ≤4 且 ⊆ `{h, ui, model, actions}`。任一函数多读一格状态或多收一个参数都会失败，因此这些基线只能下调。

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
| 宿主：登录、回调、取消 | `src/service-signin.mjs` |
| 宿主：刷新、令牌读取 | `src/service-token.mjs` |
| 宿主：退出、清理、桥接凭据 | `src/service-signout.mjs` |
| 宿主：记录到视图的勘定 | `src/service-reconcile.mjs` |
| 宿主：状态判定与发布 | `src/service-state.mjs` |
| 宿主：凭据 provider 与缓存 | `src/service-store.mjs` |
| 宿主：协议缓存、绑定校验 | `src/service-grant.mjs` |
| 宿主：网关凭据读写与摘要 | `src/service-gateway.mjs` |
| 宿主：默认模型勘定与选型读写 | `src/service-model-selection.mjs` |

## 登录边界

- 授权码 + PKCE S256；回调绑定单次 `state`/`nonce`，校验 ID Token 签名（RS256/PS256/ES256，拒绝 `none`/HS*）、issuer、audience（含多 audience 的 `azp`）、nonce、exp；`kid` 未命中时重取一次 JWKS。
- token 交换与刷新只由 Host 发起；Client 只拿到授权 URL 和非敏感 `IamView`。
- 回调路径默认 `/iam/callback`，由 `redirectPath` 注册；不得为站点根或以 `/` 结尾（DSH 路由是不带尾斜杠的绝对路径）。显式 `redirectUri` 必须为 HTTP(S) 地址，其 path 与 `redirectPath` 一致且不含 query/fragment；运行时还须与实时回调 Origin 同源，否则以 `IAM_CONFIG_INVALID` 拒绝。生产值须符合 IAM 的登记规则。
- 生产形态配置 `callbackPort: 0`：插件自建回环监听，端口由系统分配，回调地址在登录发起时才确定，监听也只在这次尝试期间存在（RFC 8252 §8.3）。需要固定端口时填 1024–65535；绑定失败直接拒登录并报 `IAM_CALLBACK_PORT_UNAVAILABLE`。省略 `callbackPort` 时仅使用宿主实时 Origin，供开发与兼容；配置后仅使用已绑定回环监听的实时 Origin，两者不互相回落。Origin 缺失、获取异常或不是有效 HTTP(S) 地址时，以 `IAM_CALLBACK_UNAVAILABLE` 拒绝登录，不生成授权链接。`callbackAddress` 默认 `auto`，始终先试 `127.0.0.1`，只在该地址族不可用时退到 `::1`；IPv6 需另行登记前缀 `http://[::1]`。
- IAM 协议端点和网关地址接受 HTTP 或 HTTPS；含旧配置项 `allowInsecureHttp` 的有效 profile 仍可使用，该项按未知键忽略且不出现在规范化结果中。新配置不得设置该项，调用方不得依赖其开关行为。HTTP 不提供传输加密或端点身份认证，会暴露令牌、Key 和请求内容。
- 显式端点齐全时不再强制拉取 `discoveryUrl`；只有 issuer/authorize/token/JWKS 缺项时才用 discovery 补齐。
- 新取得的 IAM access token 保存在 GrantRecord 与内存，不再写 `ENTERPRISE_ACCESS_TOKEN`；启动也不自动删除已有旧引用。保留不等于阻止消费：若旧配置或其他组件继续解析该引用，可能构成绕行，须在实际执行入口阻断并另定受授权的遗留处理。模型调用侧原基线指向 `ENTERPRISE_STATIC_KEY`；该消费方尚未随本仓库交付，当前没有接线可测。
- 网关凭据值写入 `ENTERPRISE_STATIC_KEY`，录入人和设备标签写入独立记录 `heluo-iam/gateway-credential`。A/B 选路前，换账号、启动恢复、共享会话同步、回调或取消均不自动删除现存值及元数据；用户仍可显式替换或清除。显式保存发生失败时仍受现有存储实现的失败处理和非原子写入限制。
- Host 运行时在访问令牌或已知刷新令牌到期前调度续期，复用现有单飞与原子提交；Host 停止、设备休眠或断网期间不能保证续期。续期前的网络检查失败且尚未写入 pending 时，保留仍有效的登录并退避重试；刷新请求结果不确定或 `invalid_grant` 时保留 pending、要求重新登录，不返回旧 access token。普通无标记且可刷新的过期会话仍可由 `/view` 轮询触发后台刷新。无需刷新的令牌读取在采用 grant 前复查 provider 实例；读取期间 provider 被替换或撤销时拒绝返回旧令牌。这不覆盖所有状态同步或 provider 生命周期交错，也不证明真实执行门禁。
- 局部竞态设计：登录回调写 grant 时，在 `credentials.modifyRecord` 的锁内 mutator 同步复查本进程 attempt、epoch 和到期状态；失效则抛出取消或过期错误，拒绝写入，不能将未写入当成成功。这样针对旧回调等待锁期间本进程取消并完成新登录的时序，避免旧回调进入锁后覆盖新 grant。
- 回调清理增量实现（#106，仅限本地合成验证）：新回调 grant 使用随机 32 字节 canonical base64url `sessionInstanceId`，刷新 pending/complete 保持不变；该标识仅用于记录匹配，不是认证凭据。旧 V1 无标识仍可读，但不能被回调清理安全归属。回调写入前记住目标 store 和 grant，失败或取消时使用一次 `modifyRecord`，锁内核对标识和固定上下文，仅对自己的记录写入固定、无敏感信息的 `{version: 1, type: 'heluo-iam-session-tombstone'}`（`kind: grant`）；严格墓碑读取与 mutate 视为空，新登录可覆盖，物理记录仍存在。坏记录、无标识或提交结果不确定均按清理未知处理，不得报告成功；只尽力撤销该回调自己的 refresh token。
- 此机制依赖所有参与者和 provider 提供可靠的同记录跨进程原子锁及提交确认；无此能力或旧客户端混跑仍不安全。写操作异常后仍可能迟到提交，无法仅凭清理或回读自证闭环；远端撤销未验证，不保证多键事务或会话整体线性一致。
- 可信 provider 的退出先核对完整 grant 并持久化随机 `signOutOperation` pending，然后在锁外撤销当前 access token；确认后再次条件比对并写墓碑。撤销失败、未知或进程中断时保留 pending，旧令牌不可读取或重发；迟到的退出不会清除新登录。网关凭据保留；合成测试不证明真实远端授权及刷新后代撤销。
- 插件卸载只释放订阅、attempt 与内存状态，但不撤销也不删除 GrantRecord 与网关凭据；下次启动 `hydrate` 恢复。显式 `signOut` 在可信原子存储上撤销当前 access token 并逻辑清除 IAM 记录，墓碑不等于物理删除。
- 管理 API（`/api/forge-iam/*`）必须通过 DSH `ctx.connection.requestRejection`；`ctx.connection` 缺失时 fail closed 返回 503。自定义 `x-forge-iam-request` 头只作 CSRF 意图校验，不替代身份认证；回调改用 `state`/PKCE 且保留自己的 Host 校验。
- 插件卸载清理由 `ctx.effect` 登记：Cordis 4 对普通 `function apply` 走构造器分支，不收集返回值，因此 `service.dispose()`、撤销 `ctx.iam` 与停止 webServer fiber 都必须显式登记，否则禁用/重载只撤销路由注册，不会清理运行时状态。
- 界面使用宿主主题 token（`--dsw-alias-*`）；包内 `locale/{en,zh}.json` 与 `icon.svg` 提供插件管理面的显示元数据；`icon.svg` 直接取自预置品牌资产 `docs/assets/branding/cyber-long/components/forge-iam-symbol.svg`，逐字节一致，不另绘，界面文案仍是硬编码中文。
- 已存凭据的 `ownerSubject` 与当前主体不同时，view 显示 `owner-mismatch`；有值但元数据缺失或损坏时显示 `invalid`，保留原值和记录供用户处置。`ownerSubject` 只表示录入人，不证明 Key 的真实归属。这些状态、前端隐藏及模型门禁纯判定都不是实际模型/工具执行门禁；消费方仍可能解析该引用。A/B 选路和真实执行入口、服务端归属校验未完成，不能据此宣称安全准入或生产可用；旧设计中相关行为待同步。
- 独占断言发现 `deepseekAccount` 仍挂载时进入 `error`，不写入任何模型凭据。

## #106 原子存储运行时门禁（本地实现，待生产验证）

内置 SQLite 凭据组合提供绑定当前 provider 实例的 `iam-atomic-store`；IAM 的 `apply` 通过该服务验证单记录操作并取得独立的网关联合 adapter。注入的测试 backend 不获得信任，缺失、异常、Promise 或非 `true` 的验证结果均拒绝受保护操作。provider 自报的 `crossProcessLock`、`durable`、`kind`、`transaction` 不是可信证据，也不得从用户配置、环境变量或客户端推导。该绑定不是同权 JS 隔离边界：同权代码仍可直接访问底层存储或自行注入服务。未知 provider 的旧有效 grant 可能只读恢复；退出不修改持久记录或发送撤销，并报告结果未知。跨平台原子性、提交确认和企业环境仍待实机验证。

登录 URL、换码、写入、回调清理及刷新 claim、发送和提交前复核身份与声明；异步边界和锁内 guard 复核，防止新 provider 冒充原实例。provider 执行 mutator 后、实际提交前替换或迟到提交无法由调用方检查撤销，安全仍依赖可信组合协调替换及 provider 的提交语义；未知提交不宣称成功。旧 V1 读兼容保留；不宣称 signOut、网关消费或多键事务安全。

## 刷新防重放增量设计（#106，待验证）

本地 write-ahead 协议针对 refresh token 轮换后响应丢失：在向 IdP 发送请求**之前**，对同一 grant 记录执行短暂 `modifyRecord`，写入随机唯一操作标记 `refreshOperation`（严格限定版本、状态、标识和绑定原记录的随机盐摘要），只有 provider 确认该写入成功才发送请求。请求与响应校验均在锁外进行；成功后第二次短事务核对完整 pending 记录，将结果与同操作的 `complete` 标记一并提交，避免迟到的旧刷新覆盖新登录，并让等待者识别属于原记录的完成结果。`waitFor` 等待阶段使用单调时钟的 5 秒截止时间，轮询 sleep 不超过剩余预算，只有无副作用的读取使用 `Promise.race` 限制等待；超时不会取消底层 I/O，迟到的 resolve/reject 不得改变 view 或产生未处理拒绝。读取完成及采纳前重新检查截止时间和生命周期。等待者绑定观察到的 pending 的 issuer、clientId、resource、subject、obtainedAt 与原 refresh token；complete 必须具有相同 version/id/base、相同身份、不同 refresh token 和未过期 access token，未知或损坏记录 fail closed。进入等待前首次读取、claim 和写入不竞速也不属于等待时限；不宣称 `signOut` 的所有 I/O 有界。该校验拒绝误写和另一授权，但不提供对有 store 写权限者的防篡改保证。超时、崩溃或响应不确定时不得接管、重发同一 refresh token，也不得返回旧 access token 或显示 ready；保留 pending 并要求重新登录。观察到 pending 的视图进入 error；仅本实例明确观察到 pending 时，内存保存该操作的 version、id、base、原会话身份、refresh token 摘要与 authEpoch，并在按本地时钟计算的 5 秒观察窗口内允许普通轮询恢复：读取的合法 complete 必须匹配该操作和会话、refresh token 已变化，且通过配置上下文及 access/refresh 有效期检查，且本地生命周期未变。仍为 pending 时继续 fail closed；标记或会话改变、读取错误、超时、其他错误、退出、卸载或新登录尝试均不得借此恢复，也不隐式采用其他会话。该读取后的状态只是本地视图，不是服务端认证或强一致证明，读取之后记录仍可能被并发替换。显式解析另按其现有规则处理。首次写入 pending 的 commit 抛错或未确认时不发送请求。若第二次 commit 已实际成功但响应或通知失败，发起方不能确认结果，其他实例仍可能读到已提交的 complete；不可声称所有实例均必然重登。成功响应缺少新 refresh token 或返回原值时保留 pending、要求重新登录；在 IAM 明确确认其他安全语义前不复用原令牌。重新登录通过既有授权路径替换记录，不在刷新失败时以读后删除清理记录。

无标记的旧 grant 可由遵守协议的新进程在事务内受控升级；未知版本、状态或损坏标记必须 fail closed。保障以前提为所有参与者遵守此协议、`modifyRecord` 在同一记录上提供真实跨进程原子排他及可靠的提交确认。旧版本进程、无锁 provider 或非原子写入不享有此保障；本地文件及 IdP 均为测试替身，生产后端和企业 IdP 尚未验证。退出与回调的条件墓碑实现和适用限制见上文；这些增量不证明多键事务、远端撤销或跨进程会话整体线性一致。

## 组合顺序

- 先挂载 `@heluo/forge-credentials-keychain`，并禁用 `dsh-credentials-local`；再挂载 `@heluo/forge-iam`。IAM 通过 `getCredentials` 延迟读取 `ctx.credentials`，但生产不应依赖加载顺序来获得存储。
- 凭据包默认使用值级加密 SQLite；不可用、密钥丢失或发现旧存储时 fail closed，不回退明文或迁移。内存后端仅供测试且不获得可信声明。
- 官方四行仍由企业组合包禁用；IAM 会在启动、登录、回调、刷新前复查 `deepseekAccount`，发现残留即进入 `error`。

## 本地 mock

完整的浏览器模拟登录、网关和模型对话步骤见[本地 mock 用户流程测试](<docs/local-mock-testing.md>)。以下命令只启动测试用 OIDC server，不解除正式组合的存储门禁：

```sh
# 打印 mock 端点配置（仅供隔离测试）
node packages/forge-iam/scripts/mock-oidc.mjs

# 登录/刷新/撤销端到端测试
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
# Node 的目录参数不可用，按文件通配运行
node --test "packages/forge-iam/test/*.test.mjs"
```

根检查：

```sh
pnpm check
git diff --check
```

## 关联

- 实施 issue：`#13`
- 下游凭据接入：[FORGE-IAM 凭据接入指南](docs/credential-access.md)（存储键、文件/钥匙串位置、CLI 与 HTTP 取票样例）
- 详细设计：`docs/design/plugins/forge-iam.md`
- 官方行禁用：`docs/design/plugins/forge-enterprise.md`
- IAM 询问函：`docs/collaboration/team-confirmation-letters.md` §4.2


## 企业模型设置闭环

企业账号页统一配置网关地址与个人访问凭证，通过 `${baseURL}/models` 获取目录；例如 `baseURL` 为 `https://gateway.corp.example/v1` 时，请求路径为 `/v1/models`。登录和凭证就绪后才能列出或调用模型。默认模型不自动改写，退出、到期及配置变化会撤销旧目录和调用代际。实现与限制见[开发指南](<docs/developer-guide.md#可配置网关与动态模型目录>)；生产原子存储、真实 IAM/UAG 和工具授权门禁不因此获得准入。

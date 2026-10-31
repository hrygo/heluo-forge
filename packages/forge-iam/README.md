# @heluo/forge-iam

状态：可用（开发骨架）；生产原子存储能力未经验证，默认组合拒绝新登录和刷新，未联调、未上线。

> 2026-10-22 原基线调整：模型网关使用 UAG 个人凭证（`ENTERPRISE_STATIC_KEY`），由账户/引导 UI 录入与清除；IAM 登录不再镜像 `ENTERPRISE_ACCESS_TOKEN`，现存旧引用在启动时保留；`gatewayResource` 变为可选（仅当配置时校验 grant 的 audience）。凭据探测与真实 UAG 联调仍待网关包，未联调、未上线。

一句话：企业 IAM 独占登录插件。Host 负责 OIDC Authorization Code + PKCE、回调、刷新与撤销，Client 负责账户页和引导；生产仍依赖 IAM 回函、OS keychain 适配与真实端点联调。

## 当前实现

- 模型门禁：`src/model-gate.mjs` 提供 `evaluateModelGate`（纯判定，fail closed）。未登录一律拒绝且不给切换目标；网关凭据缺失、无企业模型、企业模型不可用分别拒绝；默认模型只在「没有显式选择」或「当前选择不可用」时切到企业模型，不覆盖显式企业选择；可用但不属于企业的提供方不静默放行。
- 模型写入接线：`applyModelSelection()` 把判定落到设置，写入前**独立复查**（显式且仍可用的选择一律不覆盖，即使判定被伪造要求切换）；当前选择读不出来就不写；写入后回读不一致按未验证缺口报告。真实 `agentDefaultModel.saveSelection` 的受控写仍未获准，演练用记录式 sink。

| 项 | 状态 |
|---|---|
| 形态 | Host + Client 插件；Client 使用 interim same-origin route 与 2 秒轮询，Remote/watch 未接 |
| 配置 | `src/config.mjs`：显式端点/discovery、issuer、clientId、可选 `gatewayResource`/`gatewayConsoleUrl`、redirectUri、超时与安全开关；`scopes` 必须含 `openid`，回调路径不得占用 `/api/forge-iam` |
| 状态机 | `src/state.mjs`：`unconfigured` / `signed-out` / `authenticating` / `ready` / `expired` / `unreachable` / `error` |
| 凭据记录 | `src/record.mjs`：`IamGrantV1` 校验、到期/刷新判定；写入 `credentials` 的 GrantRecord |
| 凭据适配 | `src/store.mjs`：GrantRecord、网关凭据（`ENTERPRISE_STATIC_KEY` + `kind: grant` 的不透明元数据记录）、锁内 `mutate`、旧镜像清理方法（启动不调用）、官方旧记录检测 |
| 网关凭据 | 录入/替换/清除与状态（未配置/已配置/属于其他账号/记录损坏）；显示存储来源，非 keychain 时提示未受系统保护；不签发、不刷新、不探测；退出与卸载保留 |
| Host 服务 | `src/service.mjs`：OIDC 登录、state/nonce、PKCE S256、token 交换、ID Token/JWKS 校验、刷新、撤销 |
| 登录/刷新/撤销 | 协议有离线 mock 测试；默认组合的新登录和刷新受原子存储门禁阻断；真实 IAM 未联调 |
| keychain provider | 独立包 `@heluo/forge-credentials-keychain`；生产 OS adapter 未实现；显式 0600 file backend 不获默认 IAM 原子信任 |
| Client UI | `settings.section` 账户页、四步 onboarding、未登录横幅（不占用单占位 launcher）；登录走浏览器回调。账户页退出时清除旧视图并拒绝该操作前及操作中的迟到轮询；非 2xx 的返回视图和网络未知分别显示，不假装退出成功。此行为仅有 mock 组件测试，横幅为独立轮询，跨组件即时同步及真实 GUI 挂载仍待验证；登录请求若在退出完成后才被 Host 处理，旧响应会被丢弃，可能出现无链接的登录中状态，须取消后重试，真实宿主调度未验证。overlay 显式开启 pointer events，onboarding 完成屏不被轮询回退 |

## 登录边界

- 授权码 + PKCE S256；回调绑定单次 `state`/`nonce`，校验 ID Token 签名（RS256/PS256/ES256，拒绝 `none`/HS*）、issuer、audience（含多 audience 的 `azp`）、nonce、exp；`kid` 未命中时重取一次 JWKS。
- token 交换与刷新只由 Host 发起；Client 只拿到授权 URL 和非敏感 `IamView`。
- 回调路径默认 `/iam/callback`，由 `redirectPath` 注册；不得为站点根或以 `/` 结尾（DSH 路由是不带尾斜杠的绝对路径）。`redirectUri` 的 path 必须与之一致，非 loopback 必须 HTTPS，生产值必须与 IAM 预注册的精确 URI 匹配。
- 默认只允许 HTTPS；`allowInsecureHttp: true` 也只放行 loopback（`localhost`/`127.0.0.1`/`::1`）上的 HTTP。
- 显式端点齐全时不再强制拉取 `discoveryUrl`；只有 issuer/authorize/token/JWKS 缺项时才用 discovery 补齐。
- 新取得的 IAM access token 保存在 GrantRecord 与内存，不再写 `ENTERPRISE_ACCESS_TOKEN`；启动也不自动删除已有旧引用。保留不等于阻止消费：若旧配置或其他组件继续解析该引用，可能构成绕行，须在实际执行入口阻断并另定受授权的遗留处理。模型调用侧原基线指向 `ENTERPRISE_STATIC_KEY`；该消费方尚未随本仓库交付，当前没有接线可测。
- 网关凭据值写入 `ENTERPRISE_STATIC_KEY`，录入人和设备标签写入独立记录 `heluo-iam/gateway-credential`。A/B 选路前，换账号、启动恢复、共享会话同步、回调或取消均不自动删除现存值及元数据；用户仍可显式替换或清除。显式保存发生失败时仍受现有存储实现的失败处理和非原子写入限制。
- 登录/刷新失败不伪造 ready；刷新请求结果不确定或 `invalid_grant` 时保留 pending、要求重新登录，不再清理记录或返回旧 access token。普通无标记且可刷新的过期会话仍可由 `/view` 轮询触发后台刷新。无需刷新的令牌读取在采用 grant 前复查 provider 实例；读取期间 provider 被替换或撤销时拒绝返回旧令牌。这不覆盖所有状态同步或 provider 生命周期交错，也不证明真实执行门禁。
- 局部竞态设计：登录回调写 grant 时，在 `credentials.modifyRecord` 的锁内 mutator 同步复查本进程 attempt、epoch 和到期状态；失效则抛出取消或过期错误，拒绝写入，不能将未写入当成成功。这样针对旧回调等待锁期间本进程取消并完成新登录的时序，避免旧回调进入锁后覆盖新 grant。
- 回调清理增量实现（#106，仅限本地合成验证）：新回调 grant 使用随机 32 字节 canonical base64url `sessionInstanceId`，刷新 pending/complete 保持不变；该标识仅用于记录匹配，不是认证凭据。旧 V1 无标识仍可读，但不能被回调清理安全归属。回调写入前记住目标 store 和 grant，失败或取消时使用一次 `modifyRecord`，锁内核对标识和固定上下文，仅对自己的记录写入固定、无敏感信息的 `{version: 1, type: 'heluo-iam-session-tombstone'}`（`kind: grant`）；严格墓碑读取与 mutate 视为空，新登录可覆盖，物理记录仍存在。坏记录、无标识或提交结果不确定均按清理未知处理，不得报告成功；只尽力撤销该回调自己的 refresh token。
- 此机制依赖所有参与者和 provider 提供可靠的同记录跨进程原子锁及提交确认；无此能力或旧客户端混跑仍不安全。写操作异常后仍可能迟到提交，无法仅凭清理或回读自证闭环；远端撤销未验证，不保证多键事务或会话整体线性一致。
- 可信 provider 的退出对已读取的完整 grant 快照，在同一记录锁内比较、尽力撤销 refresh token（网络最多 5 秒）并写固定逻辑墓碑，不再锁外无条件物理删除。锁内发现 pending 或替换、无效记录、mutator 未执行、异常提交或回执不匹配时报告清理及远端撤销未知；网关凭据保留。合成测试不证明生产原子性、远端授权及刷新后代撤销，也不能识别无标识且字节完全相同的旧记录 ABA。
- 插件卸载只释放订阅、attempt 与内存状态，但不撤销也不删除 GrantRecord 与网关凭据；下次启动 `hydrate` 恢复。显式 `signOut` 在可信原子存储上尽力撤销 refresh token 并逻辑清除 IAM 记录，墓碑不等于物理删除。
- 管理 API（`/api/forge-iam/*`）必须通过 DSH `ctx.connection.requestRejection`；`ctx.connection` 缺失时 fail closed 返回 503。自定义 `x-forge-iam-request` 头只作 CSRF 意图校验，不替代身份认证；回调改用 `state`/PKCE 且保留自己的 Host 校验。
- 插件卸载清理由 `ctx.effect` 登记：Cordis 4 对普通 `function apply` 走构造器分支，不收集返回值，因此 `service.dispose()`、撤销 `ctx.iam` 与停止 webServer fiber 都必须显式登记，否则禁用/重载只撤销路由注册，不会清理运行时状态。
- 界面使用宿主主题 token（`--dsw-alias-*`）；包内 `locale/{en,zh}.json` 与 `icon.svg` 提供插件管理面的显示元数据；`icon.svg` 直接取自预置品牌资产 `docs/assets/branding/cyber-long/components/forge-iam-symbol.svg`，逐字节一致，不另绘，界面文案仍是硬编码中文。
- 已存凭据的 `ownerSubject` 与当前主体不同时，view 显示 `owner-mismatch`；有值但元数据缺失或损坏时显示 `invalid`，保留原值和记录供用户处置。`ownerSubject` 只表示录入人，不证明 Key 的真实归属。这些状态、前端隐藏及模型门禁纯判定都不是实际模型/工具执行门禁；消费方仍可能解析该引用。A/B 选路和真实执行入口、服务端归属校验未完成，不能据此宣称安全准入或生产可用；旧设计中相关行为待同步。
- 独占断言发现 `deepseekAccount` 仍挂载时进入 `error`，不写入任何模型凭据。

## #106 原子存储运行时门禁（本地实现，待生产验证）

当前没有经验证的生产原子存储后端。provider 自报的 `crossProcessLock`、`durable`、`kind`、`transaction` 均不是可信证据。仅受信宿主代码可向 `createIamService` 的 options 显式注入同步 `verifyAtomicStore(credentials)`；只有对**当前精确实例**返回 literal `true` 才是组合方对同记录跨进程原子排他与可靠提交确认的信任声明，并非自动证明或不可伪造能力。异常、Promise、其他值及缺失均拒绝。公开 JS 调用方及同权代码都能手动注入，不是隔离安全边界；不得从用户配置、环境变量、客户端或 provider 自报推导。插件 `apply` 默认不注入，因此当前生产登录及需要刷新时显式拒绝；不需要刷新的只读令牌不新增阻断（已有策略仍适用），已验证实例的普通显式 signOut 行为保留但不宣称安全；未知实例退出只清本地状态，不改持久记录、不发撤销请求，并报告清理及远端撤销未知。旧 grant 仍可 hydrate 为 ready 且不需刷新时可读取 access token；未知 provider 退出保留持久 grant，重新启动后仍可能恢复，不能宣称退出成功，也不能据此证明安全，模型/工具真实执行门禁尚未接线。内部 `createGrantStore.write`/`mutate` 和同权代码可直接调用存储，门禁不能防止同权 JS 绕过。已获用户同意：Cordis 配置启用的 0600 file 开发登录也暂时不可用；只有隔离内部测试显式注入 mock，不能当成产品能力或生产证明。

登录 URL、换码、写入、回调清理及刷新 claim、发送和提交前复核身份与声明；异步边界和锁内 guard 复核，防止新 provider 冒充原实例。provider 执行 mutator 后、实际提交前替换或迟到提交无法由调用方检查撤销，安全仍依赖可信组合协调替换及 provider 的提交语义；未知提交不宣称成功。旧 V1 读兼容保留；不宣称 signOut、网关消费或多键事务安全。

## 刷新防重放增量设计（#106，待验证）

本地 write-ahead 协议针对 refresh token 轮换后响应丢失：在向 IdP 发送请求**之前**，对同一 grant 记录执行短暂 `modifyRecord`，写入随机唯一操作标记 `refreshOperation`（严格限定版本、状态、标识和绑定原记录的随机盐摘要），只有 provider 确认该写入成功才发送请求。请求与响应校验均在锁外进行；成功后第二次短事务核对完整 pending 记录，将结果与同操作的 `complete` 标记一并提交，避免迟到的旧刷新覆盖新登录，并让等待者识别属于原记录的完成结果。`waitFor` 等待阶段使用单调时钟的 5 秒截止时间，轮询 sleep 不超过剩余预算，只有无副作用的读取使用 `Promise.race` 限制等待；超时不会取消底层 I/O，迟到的 resolve/reject 不得改变 view 或产生未处理拒绝。读取完成及采纳前重新检查截止时间和生命周期。等待者绑定观察到的 pending 的 issuer、clientId、resource、subject、obtainedAt 与原 refresh token；complete 必须具有相同 version/id/base、相同身份、不同 refresh token 和未过期 access token，未知或损坏记录 fail closed。进入等待前首次读取、claim 和写入不竞速也不属于等待时限；不宣称 `signOut` 的所有 I/O 有界。该校验拒绝误写和另一授权，但不提供对有 store 写权限者的防篡改保证。超时、崩溃或响应不确定时不得接管、重发同一 refresh token，也不得返回旧 access token 或显示 ready；保留 pending 并要求重新登录。观察到 pending 的视图进入 error；仅本实例明确观察到 pending 时，内存保存该操作的 version、id、base、原会话身份、refresh token 摘要与 authEpoch，并在按本地时钟计算的 5 秒观察窗口内允许普通轮询恢复：读取的合法 complete 必须匹配该操作和会话、refresh token 已变化，且通过配置上下文及 access/refresh 有效期检查，且本地生命周期未变。仍为 pending 时继续 fail closed；标记或会话改变、读取错误、超时、其他错误、退出、卸载或新登录尝试均不得借此恢复，也不隐式采用其他会话。该读取后的状态只是本地视图，不是服务端认证或强一致证明，读取之后记录仍可能被并发替换。显式解析另按其现有规则处理。首次写入 pending 的 commit 抛错或未确认时不发送请求。若第二次 commit 已实际成功但响应或通知失败，发起方不能确认结果，其他实例仍可能读到已提交的 complete；不可声称所有实例均必然重登。成功响应缺少新 refresh token 或返回原值时保留 pending、要求重新登录；在 IAM 明确确认其他安全语义前不复用原令牌。重新登录通过既有授权路径替换记录，不在刷新失败时以读后删除清理记录。

无标记的旧 grant 可由遵守协议的新进程在事务内受控升级；未知版本、状态或损坏标记必须 fail closed。保障以前提为所有参与者遵守此协议、`modifyRecord` 在同一记录上提供真实跨进程原子排他及可靠的提交确认。旧版本进程、无锁 provider 或非原子写入不享有此保障；本地文件及 IdP 均为测试替身，生产后端和企业 IdP 尚未验证。退出与回调的条件墓碑实现和适用限制见上文；这些增量不证明多键事务、远端撤销或跨进程会话整体线性一致。

## 组合顺序

- 先挂载 `@heluo/forge-credentials-keychain`，并禁用 `dsh-credentials-local`；再挂载 `@heluo/forge-iam`。IAM 通过 `getCredentials` 延迟读取 `ctx.credentials`，但生产不应依赖加载顺序来获得存储。
- keychain 包默认 fail closed；本地开发使用 file backend 时必须同时设置 `allowInsecureFile: true`，生产不得设置。
- 官方四行仍由企业组合包禁用；IAM 会在启动、登录、回调、刷新前复查 `deepseekAccount`，发现残留即进入 `error`。

## 本地 mock

测试用 OIDC server 不依赖外网：

```sh
# 打印可直接放入插件配置的 mock 端点
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
  "redirectUri": "http://127.0.0.1:<dsh-port>/iam/callback",
  "allowInsecureHttp": true
}
```

以下配置可启用 keychain 包的 0600 file backend，但插件默认不信任其原子能力，不能仅凭配置启用 IAM 新登录或刷新：

```json
{
  "filePath": "/tmp/heluo-forge/iam-credentials.json",
  "allowInsecureFile": true
}
```

**不要把上述 mock 或 file backend 配置用于生产。** 生产必须使用已审核的 OS keychain adapter 和 IAM 预注册的 HTTPS 回调。

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
- 详细设计：`docs/design/plugins/forge-iam.md`
- 官方行禁用：`docs/design/plugins/forge-enterprise.md`
- IAM 询问函：`docs/collaboration/team-confirmation-letters.md` §4.2

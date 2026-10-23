# @heluo/forge-iam

状态：可用（开发骨架；登录已按可配置 OIDC/本地 mock 实现，未联调、未上线）。

> 2026-10-22 架构调整已落到代码：模型网关改用 UAG 个人凭证（`ENTERPRISE_STATIC_KEY`），由账户/引导 UI 录入与清除；IAM 登录不再镜像 `ENTERPRISE_ACCESS_TOKEN`，启动时清理旧镜像；`gatewayResource` 变为可选（仅当配置时校验 grant 的 audience）。凭据探测与真实 UAG 联调仍待网关包，未联调、未上线。

一句话：企业 IAM 独占登录插件。Host 负责 OIDC Authorization Code + PKCE、回调、刷新与撤销，Client 负责账户页和引导；生产仍依赖 IAM 回函、OS keychain 适配与真实端点联调。

## 当前实现

- 模型门禁：`src/model-gate.mjs` 提供 `evaluateModelGate`（纯判定，fail closed）。未登录一律拒绝且不给切换目标；网关凭据缺失、无企业模型、企业模型不可用分别拒绝；默认模型只在「没有显式选择」或「当前选择不可用」时切到企业模型，不覆盖显式企业选择；可用但不属于企业的提供方不静默放行。宿主侧 `saveSelection` 接线仍为 V1 目标。

| 项 | 状态 |
|---|---|
| 形态 | Host + Client 插件；Client 使用 interim same-origin route 与 2 秒轮询，Remote/watch 未接 |
| 配置 | `src/config.mjs`：显式端点/discovery、issuer、clientId、可选 `gatewayResource`/`gatewayConsoleUrl`、redirectUri、超时与安全开关；`scopes` 必须含 `openid`，回调路径不得占用 `/api/forge-iam` |
| 状态机 | `src/state.mjs`：`unconfigured` / `signed-out` / `authenticating` / `ready` / `expired` / `unreachable` / `error` |
| 凭据记录 | `src/record.mjs`：`IamGrantV1` 校验、到期/刷新判定；写入 `credentials` 的 GrantRecord |
| 凭据适配 | `src/store.mjs`：GrantRecord、网关凭据（`ENTERPRISE_STATIC_KEY` + `kind: grant` 的不透明元数据记录）、锁内 `mutate`、旧镜像清理、官方旧记录检测 |
| 网关凭据 | 录入/替换/清除与状态（未配置/已配置/属于其他账号/记录损坏）；显示存储来源，非 keychain 时提示未受系统保护；不签发、不刷新、不探测；退出与卸载保留 |
| Host 服务 | `src/service.mjs`：OIDC 登录、state/nonce、PKCE S256、token 交换、ID Token/JWKS 校验、刷新、撤销 |
| 登录/刷新/撤销 | 已按配置端点实现；本地 mock OIDC 有离线端到端测试；真实 IAM 未联调 |
| keychain provider | 独立包 `@heluo/forge-credentials-keychain`；生产 OS adapter 未实现，本地可用显式 0600 file backend |
| Client UI | `settings.section` 账户页、四步 onboarding、未登录横幅（不占用单占位 launcher）；登录走浏览器回调；overlay 显式开启 pointer events，横幅长期观察登录态，onboarding 完成屏不被轮询回退 |

## 登录边界

- 授权码 + PKCE S256；回调绑定单次 `state`/`nonce`，校验 ID Token 签名（RS256/PS256/ES256，拒绝 `none`/HS*）、issuer、audience（含多 audience 的 `azp`）、nonce、exp；`kid` 未命中时重取一次 JWKS。
- token 交换与刷新只由 Host 发起；Client 只拿到授权 URL 和非敏感 `IamView`。
- 回调路径默认 `/iam/callback`，由 `redirectPath` 注册；不得为站点根或以 `/` 结尾（DSH 路由是不带尾斜杠的绝对路径）。`redirectUri` 的 path 必须与之一致，非 loopback 必须 HTTPS，生产值必须与 IAM 预注册的精确 URI 匹配。
- 默认只允许 HTTPS；`allowInsecureHttp: true` 也只放行 loopback（`localhost`/`127.0.0.1`/`::1`）上的 HTTP。
- 显式端点齐全时不再强制拉取 `discoveryUrl`；只有 issuer/authorize/token/JWKS 缺项时才用 discovery 补齐。
- IAM access token 只存在于 GrantRecord 与内存，不再写 `ENTERPRISE_ACCESS_TOKEN`。模型调用侧应由网关包/企业组合把 `apiKeyEnv` 指向 UAG 个人凭证 `ENTERPRISE_STATIC_KEY`；该消费方尚未随本仓库交付，当前没有接线可测。
- 网关凭据值写入 `ENTERPRISE_STATIC_KEY`，归属与设备标签写入独立记录 `heluo-iam/gateway-credential`；写入失败会撤回值，退出/卸载不删除，只有显式清除才删。
- 登录/刷新失败不伪造 ready；`invalid_grant` 清理本地记录并回到 re-login。access 过期但 refresh 仍可用时，`/view` 轮询会在后台刷新（30 秒退避），不把可恢复会话直接推回登录。
- 挂起读取与回调在返回后复核生命周期；旧操作不得覆盖新登录或在退出/卸载后恢复 ready。迟到的回调只删除自己写入的 grant，不删除另一实例已轮换的新记录。
- 退出在记录锁内读取并尽力撤销最新 refresh token（网络最多 5 秒），只删除 IAM 记录；网关凭据保留。已覆盖指定共享实例交错的终态回归；现有 credentials seam 不提供 record/ref 多键原子事务，不能把这些测试当作所有跨进程时序的强一致性证明。
- 插件卸载只释放订阅、attempt 与内存状态，但不撤销也不删除 GrantRecord 与网关凭据；下次启动 `hydrate` 恢复。显式 `signOut` 或企业卸载流程才撤销 refresh token、删除 IAM 记录。
- 管理 API（`/api/forge-iam/*`）必须通过 DSH `ctx.connection.requestRejection`；`ctx.connection` 缺失时 fail closed 返回 503。自定义 `x-forge-iam-request` 头只作 CSRF 意图校验，不替代身份认证；回调改用 `state`/PKCE 且保留自己的 Host 校验。
- 插件卸载清理由 `ctx.effect` 登记：Cordis 4 对普通 `function apply` 走构造器分支，不收集返回值，因此 `service.dispose()`、撤销 `ctx.iam` 与停止 webServer fiber 都必须显式登记，否则禁用/重载只撤销路由注册，不会清理运行时状态。
- 界面使用宿主主题 token（`--dsw-alias-*`）；包内 `locale/{en,zh}.json` 与 `icon.svg` 提供插件管理面的显示元数据；`icon.svg` 直接取自预置品牌资产 `docs/assets/branding/cyber-long/components/forge-iam-symbol.svg`，逐字节一致，不另绘，界面文案仍是硬编码中文。
- 换账号登录时，若已存网关凭据的 `ownerSubject` 与新主体不同，启动或登录回调会删除该凭据，避免沿用上一账号的 Key。
- 独占断言发现 `deepseekAccount` 仍挂载时进入 `error`，不写入任何模型凭据。

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

本地凭据可显式启用 keychain 包的 0600 file backend（仅开发/试点）：

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

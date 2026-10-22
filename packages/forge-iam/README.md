# @heluo/forge-iam

状态：可用（开发骨架；登录已按可配置 OIDC/本地 mock 实现，未联调、未上线）。

一句话：企业 IAM 独占登录插件。Host 负责 OIDC Authorization Code + PKCE、回调、刷新与撤销，Client 负责账户页和引导；生产仍依赖 IAM 回函、OS keychain 适配与真实端点联调。

## 当前实现

| 项 | 状态 |
|---|---|
| 形态 | Host + Client 插件；Client 使用 interim same-origin route，Remote 未接 |
| 配置 | `src/config.mjs`：显式端点/discovery、issuer、clientId、resource、redirectUri、超时与安全开关 |
| 状态机 | `src/state.mjs`：`unconfigured` / `signed-out` / `authenticating` / `ready` / `expired` / `unreachable` / `error` |
| 凭据记录 | `src/record.mjs`：`IamGrantV1` 校验、到期/刷新判定；写入 `credentials` 的 GrantRecord |
| 凭据适配 | `src/store.mjs`：GrantRecord、`ENTERPRISE_ACCESS_TOKEN` 镜像、锁内 `mutate`、官方旧记录检测 |
| Host 服务 | `src/service.mjs`：OIDC 登录、state/nonce、PKCE S256、token 交换、ID Token/JWKS 校验、刷新、撤销 |
| 登录/刷新/撤销 | 已按配置端点实现；本地 mock OIDC 有离线端到端测试；真实 IAM 未联调 |
| keychain provider | 独立包 `@heluo/forge-credentials-keychain`；生产 OS adapter 未实现，本地可用显式 0600 file backend |
| Client UI | `settings.section` 账户页、四步 onboarding、未登录横幅（不占用单占位 launcher）；登录走浏览器回调 |

## 登录边界

- 授权码 + PKCE S256；回调绑定单次 `state`/`nonce`，校验 ID Token 签名、issuer、audience、nonce、exp。
- token 交换与刷新只由 Host 发起；Client 只拿到授权 URL 和非敏感 `IamView`。
- browser callback 固定 `/iam/callback`；生产 `redirectUri` 必须是 IAM 预注册的精确 URI。
- 默认只允许 HTTPS 端点；`http://127.0.0.1`/`localhost` 仅用于本地 mock，且需要 `allowInsecureHttp: true`。
- `ENTERPRISE_ACCESS_TOKEN` 只镜像 access token，供 `dsh-llm-pi-ai` 的 `apiKeyEnv` 解析；refresh token 只存 GrantRecord。
- 登录/刷新失败不伪造 ready；`invalid_grant` 清理本地记录并回到 re-login。
- 独占断言发现 `deepseekAccount` 仍挂载时进入 `error`，不写镜像。

## 组合顺序

- 先挂载 `@heluo/forge-credentials-keychain`，并禁用 `dsh-credentials-local`；再挂载 `@heluo/forge-iam`。IAM 通过 `getCredentials` 延迟读取 `ctx.credentials`，但生产不应依赖加载顺序来获得存储。
- keychain 包默认 fail closed；本地开发使用 file backend 时必须同时设置 `allowInsecureFile: true`，生产不得设置。
- 官方四行仍由企业组合包禁用；IAM 会在启动、登录、回调、刷新和镜像写入前复查 `deepseekAccount`，发现残留即进入 `error`，不写入镜像。

## 本地 mock

测试用 OIDC server 不依赖外网：

```sh
# 打印可直接放入插件配置的 mock 端点
node packages/forge-iam/scripts/mock-oidc.mjs

# 登录/刷新/撤销端到端测试
node --test packages/forge-iam/test/login.test.mjs
```

配置示例：

```json
{
  "issuer": "http://127.0.0.1:<port>",
  "authorizationEndpoint": "http://127.0.0.1:<port>/authorize",
  "tokenEndpoint": "http://127.0.0.1:<port>/token",
  "jwksUri": "http://127.0.0.1:<port>/jwks",
  "revocationEndpoint": "http://127.0.0.1:<port>/revoke",
  "clientId": "dsh-desktop",
  "gatewayResource": "https://gateway.corp.example",
  "redirectUri": "http://127.0.0.1:4567/iam/callback",
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
node --test packages/forge-iam/test
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

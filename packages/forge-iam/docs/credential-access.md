# 从 FORGE-IAM 读取用户令牌与身份

**给你的工具用**：用户已经在 DSH 里登录过企业 IAM。你不用实现登录、不用弹浏览器、不用管 OIDC，只需要在每次调用前，从本机读一次**当前登录人是谁**和**他的访问令牌**。

读完这一页你就能接上。不想读细节的话，直接跳到 [§1 最短路径](#1-最短路径)。

| 项 | 内容 |
|---|---|
| 适用读者 | DevOps CLI、Gitee CLI 等需要"带用户身份调用平台"的命令行工具 |
| 你能拿到 | 用户标识（工号）+ 访问令牌 + 过期时间 |
| 你不需要做 | 登录、刷新令牌、保存密码、管理 OIDC |
| 最后更新 | 2026-11-05 |

---

## 1. 最短路径

**如果你的工具能启动子进程**（Node、Go、Python 都行），这是最省事的一条：

```bash
heluo-forge auth whoami --json   # 谁登录了
heluo-forge auth token           # 他的令牌（stdout 只有令牌一行）
```

`whoami --json` 输出：

```json
{"status":"ready","signedIn":true,"principal":{"issuer":"https://iam.example/oidc","subject":"000001"},"accessExpiresAt":"2026-11-04T09:30:26.000Z","scope":"openid profile offline_access"}
```

`auth token` 输出（成功时只有这一行）：

```
eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIwMDAwMDEifQ.c2lnbmF0dXJl
```

一个完整的 Node 用法：

```js
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** 读当前登录人的令牌；返回 null 表示未登录。 */
export async function currentToken() {
  try {
    const { stdout } = await run('heluo-forge', ['auth', 'token'], { timeout: 5000 });
    return stdout.trim() || null;
  } catch (error) {
    // 退出码 2=未登录，3=令牌过期（需回 DSH 重新登录），4=环境问题
    if (error.code === 3) throw new Error('登录已过期，请回到 DSH 重新登录');
    if (error.code === 2) return null;
    throw new Error('无法读取本机凭据，请确认已安装 FORGE-IAM 或在 DSH 中登录');
  }
}
```

就这些。下面是为什么这样写，以及什么时候会失败。

---

## 2. 你会拿到什么

**身份**：两个字段，够用就行，别期待更多。

| 字段 | 说明 | 例 |
|---|---|---|
| `principal.subject` | 用户标识。多数环境**就是工号** | `000001` |
| `principal.issuer` | 哪个 IAM 签发的 | `https://iam.example/oidc` |

**令牌**：一个不透明字符串，直接放进你原请求的认证头即可，不需要解析。**不要**假设它是 JWT、不要读它的内容——格式由 IAM 决定，可能变。

**有效期**：`accessExpiresAt`（ISO 8601）。别写死时长，以这个字段为准。

**你拿不到的**：姓名、部门、邮箱、角色、群组。目前只有工号。如果界面上要显示人名，请用 `subject` 到你自己的系统里映射，或者直接显示工号。

---

## 3. 该怎么取：按你的运行环境选

### 3.1 有子进程 → 调 `heluo-forge`（推荐）

命令只有两条，退出码固定：

| 命令 | 用途 | 成功输出 |
|---|---|---|
| `heluo-forge auth whoami [--json]` | 查身份与登录态 | 身份 JSON 或 `000001 (https://iam.example/oidc)` |
| `heluo-forge auth token` | 取令牌 | 仅令牌一行 |

退出码：

| 码 | 含义 | 你该做什么 |
|---|---|---|
| 0 | 成功 | 继续 |
| 2 | 未登录 | 提示"请在 DSH 中登录"，不要报成权限不足 |
| 3 | 令牌已过期 | 提示"登录已过期，请回 DSH 重新登录" |
| 4 | 凭据不可用或 Host 拒绝 | 报环境问题，需要人工处理 |
| 64 | 参数写错 | 修代码 |

一个坑：**`whoami` 永远返回 0**，未登录也是 0。判断登录态请看 JSON 里的 `signedIn`，不要看退出码。

另一个坑：`auth token` 失败时 **stdout 是空的**，错误在 stderr。所以不要用 stdout 非空来判断成功——看退出码。

### 3.2 你的工具跑在 DSH 里（插件/同源页面）→ 用 HTTP

如果你的代码就在 DSH 的 Host 或同源页面里，不用起子进程：

| 你要什么 | 怎么调 | 成功返回 |
|---|---|---|
| 身份 | `GET /api/forge-iam/session` | 与 `whoami --json` 同形 |
| 令牌 | `POST /api/forge-iam/token`，带请求头 `x-forge-iam-request: 1` | `{"token":"…","expiresAt":"…"}` |

```bash
curl -s -X POST http://127.0.0.1:49196/api/forge-iam/token \
  -H 'x-forge-iam-request: 1'
```

CLI 与插件读取相同的 SQLite 值级加密存储，目录由凭据包统一解析；隔离测试可设置 `HELUO_FORGE_STORE_DIRECTORY`，与插件的 `storeDirectory` 对应。读取不会创建存储或刷新令牌；旧文件不读取、不迁移。目标平台与 Electron 宿主的实测状态见[凭据包说明](../../forge-credentials-keychain/README.md)。

两点说明：

- 这两个接口走 DSH 自己的浏览器鉴权，**普通终端进程进不来**（没有那个凭据）。所以命令行工具请走 §3.1。
- 如果是在同机进程里、又拿不到浏览器凭据，还有一个 loopback 接口 `POST /api/forge-iam/bridge/token`，需要 `authorization: Bearer <能力值>`，能力值由 Host 与受信本机客户端使用。这条路是为"必须是 HTTP、但不在浏览器里"的场景准备的，一般用不上。

### 3.3 你写的是 DSH 插件 → 用服务

Host 内直接用宿主服务，不要自己读文件：

```js
const session = ctx.iam.getSession();          // 身份，永远不含令牌
const token = await ctx.iam.getAccessToken();  // 令牌，按需刷新
```

---

## 4. 令牌会变，这是实现的关键

这一段决定了你的代码能不能长期用。三条事实：

1. **令牌有有效期**，企业当前配置约 2 小时（以 `accessExpiresAt` 为准）。
2. **DSH 刷新后，你手上的旧令牌立刻作废。** 不是"过一会儿"——旧令牌立即不可用。
3. **用户退出后，访问令牌立即失效；刷新令牌不随退出失效，会在服务端自然过期。**

所以：

- ✅ **每次请求前重新读一次**（子进程方式就是每次调一次 `auth token`，几毫秒）。
- ✅ 长任务中途收到 401/403 时，**当成"会话已更新"**，重读一次令牌再试一次。
- ❌ 不要把令牌缓存到磁盘、配置文件、你自己的 keyring，或进程级全局变量里放很久。
- ❌ **不要自己刷新。** 不要读、不要用 refresh token。登录态只由 DSH 维护，第二个刷新者会把用户的会话踢掉。

---

## 5. 出错了该给用户看什么

| 你看到的 | 真实原因 | 建议用户看到的文案 |
|---|---|---|
| 退出码 2 / `IAM_NOT_SIGNED_IN` | 用户没登录 | 请先在 DSH 中完成登录 |
| 退出码 3 / `IAM_REAUTH_REQUIRED` | 令牌过期 | 登录已过期，请回到 DSH 重新登录 |
| 退出码 4 / `IAM_CREDENTIALS_UNAVAILABLE` | 凭据读不到（没装、权限不对） | 无法读取本机登录信息，请联系管理员 |
| 业务接口返回 401 | 平台不认这张令牌 | 请重新登录；仍失败则联系管理员 |
| 业务接口返回 403 | 平台认人但无权限 | 你无权访问该资源（**不要说成"未登录"**） |

最后一行是最容易写错的一处：**"没登录"和"没权限"是两件事**，提示混在一起会让用户白折腾半天。

---

## 6. 五个常见误区

1. 把令牌存进自己的配置文件——用户下次打开就用到过期票，而且没人知道为什么。
2. 用 refresh token 自己续期——会把用户正在用的会话踢掉。
3. 用 `whoami` 的退出码判断登录态——它永远返回 0。
4. 把令牌打进日志、命令行参数、崩溃报告——日志会被收集、命令行会被 `ps` 看到。
5. 期待拿到用户姓名——只有工号。

---

## 7. 联调与自测

使用隔离目录与合成会话验证，不直接构造或解析存储文件。仓库内的 `packages/forge-iam/test/cli-reader.test.mjs` 覆盖命令的身份、过期、不可用和桥接行为；`packages/forge-credentials-keychain/test/sqlite-composition.test.mjs` 覆盖独立 CLI 进程从 SQLite 读取合成会话。

## 8. 已知限制

- Windows、麒麟、Electron 宿主及企业 IAM 的实际接入尚未完成验证；各平台运行结果分别记录。
- 身份字段中的 `subject` 是身份提供方返回的标识；姓名等资料应从获授权的来源取得。
- 退出或刷新结果未确认时拒绝返回旧令牌，需要重新登录或按实际错误处理。

## 附录 A：存储目录与命名空间

| 变量 | 默认 | 作用 |
|---|---|---|
| `HELUO_FORGE_STORE_DIRECTORY` | 平台用户目录 | 指向与 Host 相同的存储目录；不提供旧文件读取 |
| `HELUO_FORGE_IAM_URL` | 未设置 | 使用 `127.0.0.1` 或 `[::1]` 的 HTTP(S) 地址连接 Host 桥；不跟随重定向 |
| `HELUO_FORGE_KEYCHAIN_SERVICE` | `heluo-forge` | 凭据命名空间的 service |
| `HELUO_FORGE_KEYCHAIN_ACCOUNT_PREFIX` | `iam` | 凭据命名空间的账号前缀 |

## 附录 B：错误码对照

| 码 | 出现位置 | 含义 |
|---|---|---|
| `IAM_NOT_SIGNED_IN` | 退出码 2 / HTTP 401 | 没有会话 |
| `IAM_REAUTH_REQUIRED` | 退出码 3 / HTTP 401 | 令牌过期，需重新登录 |
| `IAM_INVALID_GRANT` | 退出码 3 / HTTP 401 | 会话记录无效或退出结果未确认，需重新登录 |
| `IAM_CREDENTIALS_UNAVAILABLE` | 退出码 4 / HTTP 503 | 凭据后端不可用 |
| `IAM_BRIDGE_UNAUTHORIZED` | HTTP 401 | 桥能力值不对 |
| `IAM_BRIDGE_FORBIDDEN` | HTTP 403 | 非本机来源 |
| `IAM_REQUEST_HEADER_REQUIRED` | HTTP 403 | 缺 `x-forge-iam-request: 1` |
| `IAM_HOST_UNREACHABLE` | 退出码 4 | 配置的 DSH 地址连不上 |

---

**验证边界**：CLI 与 HTTP 的合成测试不代表真实 DSH 宿主或企业 IAM 已联调。相关设计说明见[开发者指南](<developer-guide.md>)。

**入口**：本手册的常驻页是 [issue #147](https://github.com/hrygo/heluo-forge/issues/147)（置顶、不关闭）。与本文不符之处请在该页留言，附命令、退出码、平台与版本。

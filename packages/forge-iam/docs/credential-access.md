# 从 FORGE-IAM 读取用户令牌与身份

用户在 DSH 登录企业 IAM 后，IAM 负责保存、刷新和清理会话；下游功能按需读取当前登录人和访问令牌，不自行管理 IAM grant 或刷新令牌。

本指南包含按运行环境选择的接入方式、业务凭据存取、本地 UAT 与错误处理。[§1 最短路径](#1-最短路径)适用于命令行调用。

| 项 | 内容 |
|---|---|
| 适用读者 | DevOps CLI、Gitee CLI 等需要"带用户身份调用平台"的命令行工具 |
| 你能拿到 | 发行者、用户标识、访问令牌与过期时间 |
| 你不需要做 | 登录、刷新令牌、保存密码、管理 OIDC |
| 最后更新 | 2026-11-12 |

---

## 1. 最短路径

可启动子进程的工具可通过 CLI 读取：

```bash
heluo-forge auth whoami --json   # 登录身份和状态
heluo-forge auth token           # 访问令牌（stdout 只有令牌一行）
```

命令需安装到 `PATH`。在已安装或链接工作区依赖的源码仓库内，也可用 `node packages/forge-iam/bin/heluo-forge.mjs` 代替 `heluo-forge`。

`whoami --json` 输出：

```json
{"status":"ready","signedIn":true,"principal":{"issuer":"https://iam.corp.example/oidc","subject":"000001"},"accessExpiresAt":"2030-01-01T09:30:26.000Z","scope":"openid profile offline_access"}
```

`auth token` 输出（成功时只有这一行）：

```
sample-access-token
```

一个完整的 Node 用法：

```js
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** 读当前登录人的令牌；返回 null 表示未登录。 */
export async function currentToken() {
  try {
    const { stdout } = await run('heluo-forge', ['auth', 'token']);
    return stdout.trim() || null;
  } catch (error) {
    // 退出码 2=未登录，3=令牌不可用，4=环境问题
    if (error.code === 3) throw new Error('访问令牌不可用，请检查 DSH 会话');
    if (error.code === 2) return null;
    throw new Error('无法读取本机凭据，请确认已安装 FORGE-IAM 或在 DSH 中登录');
  }
}
```

---

## 2. 身份与令牌字段

身份包含以下两个标识字段：

| 字段 | 说明 | 例 |
|---|---|---|
| `principal.subject` | IAM 返回的主体标识；是否为工号以企业契约为准 | `000001` |
| `principal.issuer` | 签发身份的 IAM | `https://iam.corp.example/oidc` |

**令牌**是不透明字符串，按被调用接口要求传递；不要假设它是 JWT 或依赖其内部格式。服务端是否接受该令牌取决于实际授权与接口契约。

**有效期**由 `accessExpiresAt`（ISO 8601）表示，不应写死时长。

**身份接口不返回**姓名、部门、邮箱、角色或群组。界面如需显示姓名，应从获授权的数据源查询；也可显示 `subject`，不应假定它一定是工号。

---

## 3. 按运行环境选择入口

### 3.1 独立进程：`heluo-forge`

命令只有两条，退出码固定：

| 命令 | 用途 | 成功输出 |
|---|---|---|
| `heluo-forge auth whoami [--json]` | 查身份与登录态 | 身份 JSON 或 `000001 (https://iam.corp.example/oidc)` |
| `heluo-forge auth token` | 取令牌 | 仅令牌一行 |

退出码：

| 码 | 含义 | 你该做什么 |
|---|---|---|
| 0 | 成功 | 继续 |
| 2 | `auth token` 未登录 | 提示"请在 DSH 中登录"，不要报成权限不足 |
| 3 | `auth token` 的令牌已过期、临近过期或需要重新登录 | 检查 Host 会话与错误码；必要时重新登录 |
| 4 | 凭据存储缺失、损坏、不可访问，Host 拒绝或会话回读核验失败 | 报环境问题，需要人工处理 |
| 64 | 参数写错 | 修代码 |

`whoami` 能读取存储时返回 0，未登录、已过期或记录状态为错误也是 0；判断登录态请同时查看 JSON 里的 `status` 和 `signedIn`。存储缺失、数据库或密钥文件损坏或无法访问时返回 4，stdout 为空，错误在 stderr。`whoami` 始终读取本地记录，不因设置 Host 地址而改走 Host。

Host 的 `storeDirectory` 与 CLI 的 `HELUO_FORGE_STORE_DIRECTORY` 应指向同一目录。Linux 默认使用当前 XDG 目录，不回退旧默认目录，也不自动合并或迁移数据。

`auth token` 失败时 stdout 为空、错误输出到 stderr；调用方应检查退出码。

未设置 `HELUO_FORGE_IAM_URL` 时，`auth token` 只读本地记录，不请求 Host 或 IAM，不写存储或刷新令牌；剩余有效期不超过 30 秒时拒绝返回，刷新或退出 pending 时也不返回旧令牌。离线 CLI 没有 Host 配置，不能核验当前 issuer、clientId 或 resource 是否与 Host 匹配；本地返回令牌不证明服务端授权。

设置 `HELUO_FORGE_IAM_URL` 后，`auth token` 通过本机 Host 桥获取令牌。Host 校验配置上下文并可按需刷新；CLI 回读存储，只接受属于同一会话且与当前记录一致的令牌；发生刷新时还须匹配该操作。缺少 `sessionInstanceId` 的会话不被采用。退出进行中、结果未确认或回读不匹配时不返回令牌。

```sh
# 将端口替换为运行中的 DSH Host 地址；whoami 仍只读本地记录。
HELUO_FORGE_IAM_URL=http://127.0.0.1:48388 heluo-forge auth token
```

配置 Host 地址后无法连接 Host 时返回错误，不自动改用离线读取。CLI 会自行读取桥接能力值，调用方无需将能力值放入命令参数。

### 3.2 DSH 同源页面：HTTP

经过 DSH 认证的同源页面可使用 HTTP：

| 你要什么 | 怎么调 | 成功返回 |
|---|---|---|
| 身份 | `GET /api/forge-iam/session` | 不含令牌的 Host 身份与时效快照 |
| 令牌 | `POST /api/forge-iam/token`，带请求头 `x-forge-iam-request: 1` | `{"token":"…","expiresAt":"…"}` |

在已经通过 DSH Connection 认证的同源页面调用：

```js
async function readIamSession() {
  const response = await fetch('/api/forge-iam/session');
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error?.code ?? 'IAM_SESSION_FAILED');
  return body;
}

async function readIamToken() {
  const response = await fetch('/api/forge-iam/token', {
    method: 'POST',
    headers: { 'x-forge-iam-request': '1', 'content-type': 'application/json' },
    body: '{}',
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error?.code ?? 'IAM_TOKEN_FAILED');
  return body; // { token, expiresAt }
}
```

在使用内置凭据组合且目录、命名空间一致时，CLI 与插件读取同一 SQLite 值级加密存储；隔离测试可设置 `HELUO_FORGE_STORE_DIRECTORY`，与插件的 `storeDirectory` 对应。以该目录为 `D`，新存储的数据库在 `D/credentials.sqlite`，密钥在同级 `D.keys/keyring.json`，不需要单独配置密钥目录。发现旧位置 `D/keyring.json`、已有数据库缺失密钥或密钥绑定时拒绝使用，保留原物且不自动迁移、绑定或重建。CLI 的本地读取不会创建存储或刷新令牌；Host 令牌入口可按需刷新。旧 `credentials.json` 和 `credentials.key` 不读取、不迁移。停用相关进程后的备份恢复、权限边界及目标平台实测状态见[凭据包说明](../../forge-credentials-keychain/README.md)。

两点说明：

- 这两个接口使用 DSH 的 Connection 鉴权；没有相应凭据的普通终端无法通过。`session` 返回 Host 的本地会话视图，不主动同步存储或刷新，可能与 CLI 的即时记录读取暂时不同。
- 同机非浏览器进程可使用 loopback 接口 `POST /api/forge-iam/bridge/token`，以 `authorization: Bearer <能力值>` 通过门禁；该入口检查回环来源和存储中的能力值，随后由 Host 解析令牌。同账户进程可读取本地密钥，能力值不构成同账户应用隔离。

### 3.3 DSH Host 插件：宿主服务

Host 插件声明 `iam` 依赖，在业务请求处理时调用宿主服务，不要自己读文件：

```js
export const inject = ['iam'];

export async function readCaller(ctx) {
  const session = ctx.iam.getSession();           // 身份，永远不含令牌
  const token = await ctx.iam.getAccessToken();   // 令牌，按需刷新
  return { session, token };
}
```

`getSession()` 是当前 Host 快照，两次调用不构成身份与令牌的原子绑定。需要严格绑定调用身份时，按业务自身的授权与上下文要求校验。

### 3.4 保存业务插件自己的凭据

业务插件需要保存独立的 API Key 或服务令牌时，可使用宿主 `credentials` 服务的单引用接口。引用名在共享命名空间中须与其他插件区分，格式为字母或下划线开头的字母、数字和下划线；值须为非空字符串。

```js
export const inject = ['credentials'];

export async function savePluginCredential(ctx, value) {
  await ctx.credentials.set('MY_PLUGIN_API_TOKEN', value);
}

export async function readPluginCredential(ctx) {
  return (await ctx.credentials.resolve('MY_PLUGIN_API_TOKEN'))?.value;
}

export async function clearPluginCredential(ctx) {
  await ctx.credentials.unset('MY_PLUGIN_API_TOKEN');
}
```

凭据值由业务界面或其他受控输入提供，不写入日志或配置文件；未配置时读取返回 `undefined`。单引用写入不等于多个记录的联合提交。IAM 的 access/refresh token 及 `heluo-iam/session` 由 IAM 管理，不通过该示例自行写入；网关个人 Key 使用 `ctx.iam.saveGatewayCredential()` 或企业账号页面，见 [IAM 开发者指南](<developer-guide.md>)。

---

## 4. 令牌会变，这是实现的关键

访问令牌的有效期以 `accessExpiresAt` 和服务端实际策略为准。刷新或退出后，旧令牌何时在服务端失效须由企业 IAM 与资源服务核验；本地拒绝返回旧令牌不等于远端撤销已完成。

- 每次请求前读取当前令牌，不把它长期缓存在磁盘、配置文件或进程全局变量中。
- 收到 401 时按实际接口语义核对登录态；403 通常需要核对资源权限，不能一律当作会话已更新。只有业务操作允许安全重试时，才在确认原因后重新取令牌并重试。
- 不要读取或使用 refresh token，也不要自行刷新；并发刷新可能使会话失效，刷新由 Host 管理。

---

## 5. 出错了该给用户看什么

| 你看到的 | 真实原因 | 建议用户看到的文案 |
|---|---|---|
| 退出码 2 / `IAM_NOT_SIGNED_IN` | 用户没登录 | 请先在 DSH 中完成登录 |
| 退出码 3 / `IAM_REAUTH_REQUIRED` | 令牌过期、临近过期或当前刷新结果不可用 | 检查 DSH 会话；需要时重新登录 |
| 退出码 4 / `IAM_CREDENTIALS_UNAVAILABLE` | 凭据读不到或会话回读核验失败 | 无法确认本机登录信息，请联系管理员 |
| 业务接口返回 401 | 认证未通过，具体原因以业务接口为准 | 检查登录和接口配置；仍失败则联系管理员 |
| 业务接口返回 403 | 通常为权限或策略拒绝，具体以业务接口为准 | 核对资源权限或联系管理员 |

最后一行是最容易写错的一处：**"没登录"和"没权限"是两件事**，提示混在一起会让用户白折腾半天。

---

## 6. 五个常见误区

1. 把令牌存进自己的配置文件——用户下次打开就用到过期票，而且没人知道为什么。
2. 用 refresh token 自己续期——可能与 Host 竞争并使会话失效。
3. 只用 `whoami` 的退出码判断登录态——成功读取时未登录和过期也返回 0；退出码 4 表示无法读取或其他环境问题。
4. 把令牌打进日志、命令行参数、崩溃报告——日志会被收集、命令行会被 `ps` 看到。
5. 期待身份接口返回用户姓名，或把 `subject` 一律当作工号。

---

## 7. 联调与自测

从仓库根目录启动[本地 mock UAT](<local-mock-testing.md>)，在页面完成模拟登录：

```sh
bash scripts/probe/run-iam-local-uat.sh
```

脚本从 `HEAD` 构建，不包含未提交改动，并打印隔离目录。源码 CLI 需先安装或链接工作区依赖，并应与打包进 Host 的代码版本一致。登录后，在另一个终端将下面的 `<隔离目录>` 替换为实际目录；如果修改了宿主端口，也要同步修改地址。命令只用于读取隔离会话，令牌会输出到终端，勿复制到日志。

```sh
HELUO_FORGE_STORE_DIRECTORY='<隔离目录>/dsh/credentials' \
  node packages/forge-iam/bin/heluo-forge.mjs auth whoami --json
HELUO_FORGE_STORE_DIRECTORY='<隔离目录>/dsh/credentials' \
  HELUO_FORGE_IAM_URL=http://127.0.0.1:48388 \
  node packages/forge-iam/bin/heluo-forge.mjs auth token
```

自动化使用隔离目录与合成会话，不直接构造或解析真实存储文件。`packages/forge-iam/test/cli-reader.test.mjs` 覆盖命令的身份、过期、不可用和桥接行为；`packages/forge-credentials-keychain/test/sqlite-composition.test.mjs` 覆盖独立 CLI 进程从 SQLite 读取合成会话。

## 8. 已知限制

- Windows、麒麟、Electron 宿主及企业 IAM 的实际接入尚未完成验证；各平台运行结果分别记录。
- 身份字段中的 `subject` 是身份提供方返回的标识；姓名等资料应从获授权的来源取得。
- 退出或刷新结果未确认时拒绝返回旧令牌，需要重新登录或按实际错误处理。

## 附录 A：存储目录与命名空间

| 变量 | 默认 | 作用 |
|---|---|---|
| `HELUO_FORGE_STORE_DIRECTORY` | 平台用户目录 | 指向与 Host 相同的存储目录；密钥目录由此确定，旧同目录 keyring 不兼容 |
| `HELUO_FORGE_IAM_URL` | 未设置 | 使用 `127.0.0.1` 或 `[::1]` 的 HTTP(S) 地址连接 Host 桥；不跟随重定向 |
| `HELUO_FORGE_KEYCHAIN_SERVICE` | `heluo-forge` | 凭据命名空间的 service |
| `HELUO_FORGE_KEYCHAIN_ACCOUNT_PREFIX` | `iam` | 凭据命名空间的账号前缀 |

## 附录 B：错误码对照

| 码 | 出现位置 | 含义 |
|---|---|---|
| `IAM_NOT_SIGNED_IN` | 退出码 2 / HTTP 401 | 没有会话 |
| `IAM_REAUTH_REQUIRED` | 退出码 3 / HTTP 401 | 令牌过期、临近过期或刷新结果不可用，按会话状态处理 |
| `IAM_INVALID_GRANT` | 退出码 3 / HTTP 401 | 会话记录无效或退出结果未确认，需重新登录 |
| `IAM_CREDENTIALS_UNAVAILABLE` | 退出码 4 / HTTP 503 | 凭据后端不可用或 CLI 会话回读核验失败 |
| `CRED_STORE_PATH_CONFLICT` | 退出码 4 | 凭据后端发现目录重叠或用途冲突；存储路径位于 Git 工作区内也会被拒绝，并可能映射为 `IAM_CREDENTIALS_UNAVAILABLE` |
| `IAM_BRIDGE_UNAUTHORIZED` | HTTP 401 | 桥能力值不对 |
| `IAM_BRIDGE_FORBIDDEN` | HTTP 403 | 非本机来源 |
| `IAM_REQUEST_HEADER_REQUIRED` | HTTP 403 | 缺 `x-forge-iam-request: 1` |
| `IAM_HOST_UNREACHABLE` | 退出码 4 | 配置的 DSH 地址连不上 |

---

**验证边界**：CLI 与 HTTP 的合成测试不代表真实 DSH 宿主或企业 IAM 已联调。相关设计说明见[开发者指南](<developer-guide.md>)。

**入口**：本手册的常驻页是 [issue #260](https://github.com/hrygo/heluo-forge/issues/260)（置顶、不关闭）。与本文不符之处请在该页留言，附命令、退出码、平台与版本。

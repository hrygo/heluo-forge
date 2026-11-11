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

存储后端按平台解析：Windows 与 macOS 都是应用层加密文档——Windows 在 `%LOCALAPPDATA%\HeluoForge`，macOS 在 `~/Library/Application Support/HeluoForge`——同一文档内完成记录/引用联合提交并自带跨进程 `O_EXCL` 锁；Linux 目标没有可用后端，CLI 与插件都按 fail closed 关闭。四组合原生 addon 随包分发但未取证，只有显式选择才会被用到（插件用 `platformAdapter: native-keyring`，CLI 用 `HELUO_FORGE_ALLOW_UNVETTED=1`）。CLI 默认走 `createPlatformBackend()`，解析结果与插件一致；`HELUO_FORGE_CREDENTIALS_FILE` 只是显式开发用明文覆盖。

两点说明：

- 这两个接口走 DSH 自己的浏览器鉴权，**普通终端进程进不来**（没有那个凭据）。所以命令行工具请走 §3.1。
- 如果是在同机进程里、又拿不到浏览器凭据，还有一个 loopback 接口 `POST /api/forge-iam/bridge/token`，需要 `authorization: Bearer <能力值>`，能力值可经 `heluo-forge` 所在的同一凭据库读取（键名见附录 A）。这条路是为"必须是 HTTP、但不在浏览器里"的场景准备的，一般用不上。

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

## 7. 联调与自测（不用等 DSH）

你可以先用一份假的存储文件，把自己这边的读取逻辑跑通。建一个文件（路径自己定，必须在仓库外）：

```json
{"version":1,"entries":{"heluo-forge/iam/record/heluo-iam/session":"{\"kind\":\"grant\",\"payload\":{\"version\":1,\"issuer\":\"https://iam.example/oidc\",\"subject\":\"000001\",\"clientId\":\"heluo-forge-desktop\",\"scope\":\"openid profile offline_access\",\"obtainedAt\":\"2026-11-04T01:12:33.000Z\",\"accessToken\":\"TOKEN_VALUE\",\"accessExpiresAt\":\"2099-01-01T00:00:00.000Z\",\"refreshToken\":\"rt_example\"}}"}}
```

然后：

```bash
export HELUO_FORGE_CREDENTIALS_FILE=/path/to/your/file.json
heluo-forge auth whoami --json   # 应输出 subject 000001
heluo-forge auth token           # 应输出 TOKEN_VALUE
```

四个必须覆盖的场景：

| 场景 | 怎么造 | 预期 |
|---|---|---|
| 已登录 | 上面的文件 | `signedIn: true`，拿到令牌 |
| 未登录 | 删掉文件里的那条记录 | `signedIn: false`，`auth token` 退出码 2 |
| 已过期 | 把 `accessExpiresAt` 改成过去时间 | `auth token` 退出码 3 |
| 已退出 | 把记录内容改成 `{"kind":"grant","payload":{"version":1,"type":"heluo-iam-session-tombstone"}}` | 按未登录处理 |

---

## 8. 已知限制

- **Windows / 麒麟的凭据库直读路径还没实现**，所以不要自己解析系统凭据库，走 §3.1 的命令。
- 身份只有工号（见 §2），要姓名请在你方系统内映射。
- 存储格式里的字段集合可能增加，**遇到不认识的字段请忽略**，不要因为多一个字段就报错。

---

## 附录 A：自己读存储（仅在没有 `heluo-forge` 时）

先说明：这是**次选**。格式属于实现细节，优先用 §3.1。只在你无法启动 Node 进程、又必须离线读时才用。

**位置**：一个 JSON 文件，路径由环境变量 `HELUO_FORGE_CREDENTIALS_FILE` 指定（绝对路径，权限 0600）。在系统凭据库形态下，条目名为 `heluo-forge/iam/record/heluo-iam/session`。

**结构**：顶层 `{version:1, entries:{…}}`，值是**字符串**。

```json
{
  "version": 1,
  "entries": {
    "heluo-forge/iam/record/heluo-iam/session": "{\"kind\":\"grant\",\"payload\":{…}}"
  }
}
```

**解析步骤**：

1. 取 `entries["heluo-forge/iam/record/heluo-iam/session"]`，没有就是未登录；
2. 把它按 JSON 解析，得到 `{kind, payload}`；
3. `kind !== "grant"` → 未登录；
4. `payload.type === "heluo-iam-session-tombstone"` → 未登录（用户已退出）；
5. `payload.accessToken` 缺失，或 `payload.accessExpiresAt <= now` → 令牌不可用，提示重新登录；
6. 只取 `issuer`、`subject`、`accessToken`、`accessExpiresAt`、`scope`，其余忽略；
7. **只读**。不要改这个文件，不要写回。

**参考实现**：

```js
import { readFile } from 'node:fs/promises';

const KEY = 'heluo-forge/iam/record/heluo-iam/session';

export async function readSession(filePath) {
  const doc = JSON.parse(await readFile(filePath, 'utf8'));
  if (doc?.version !== 1 || typeof doc.entries !== 'object') {
    return { ok: false, code: 'IAM_STORE_UNSUPPORTED' };
  }
  const raw = doc.entries[KEY];
  if (typeof raw !== 'string') return { ok: false, code: 'IAM_NOT_SIGNED_IN' };

  let record;
  try { record = JSON.parse(raw); } catch { return { ok: false, code: 'IAM_STORE_CORRUPT' }; }
  if (record?.kind !== 'grant') return { ok: false, code: 'IAM_NOT_SIGNED_IN' };

  const grant = record.payload ?? {};
  if (grant.type === 'heluo-iam-session-tombstone') return { ok: false, code: 'IAM_NOT_SIGNED_IN' };

  const subject = typeof grant.subject === 'string' ? grant.subject : null;
  const issuer = typeof grant.issuer === 'string' ? grant.issuer : null;
  if (typeof grant.accessToken !== 'string' || typeof grant.accessExpiresAt !== 'string') {
    return { ok: false, code: 'IAM_REAUTH_REQUIRED', subject, issuer };
  }
  if (Date.parse(grant.accessExpiresAt) <= Date.now()) {
    return { ok: false, code: 'IAM_REAUTH_REQUIRED', subject, issuer };
  }
  return {
    ok: true,
    subject,
    issuer,
    token: grant.accessToken,
    expiresAt: grant.accessExpiresAt,
  };
}
```

**命名相关环境变量**（与服务端对齐时用）：

| 变量 | 默认 | 作用 |
|---|---|---|
| `HELUO_FORGE_CREDENTIALS_FILE` | 空 | 指定文件路径（绝对路径） |
| `HELUO_FORGE_KEYCHAIN_SERVICE` | `heluo-forge` | 系统凭据库的 service |
| `HELUO_FORGE_KEYCHAIN_ACCOUNT_PREFIX` | `iam` | 系统凭据库的账号前缀 |

## 附录 B：完整记录结构（仅解析时需要）

记录是 `{"kind":"grant","payload":{…}}`。`payload` 字段：

| 字段 | 必填 | 说明 |
|---|---|---|
| `version` | 是 | `1` 或 `2`，内部差异与你无关，不要依赖 |
| `issuer` | 是 | IAM 签发方 |
| `subject` | 是 | 用户标识（工号） |
| `clientId` | 是 | 客户端标识，与你无关 |
| `scope` | 是 | 空格分隔的字符串（**不是数组**） |
| `obtainedAt` | 是 | 取得授权的 ISO 时间 |
| `accessToken` | 条件 | 与 `accessExpiresAt` 必须同时出现 |
| `accessExpiresAt` | 条件 | 令牌过期时间 |
| `refreshToken` | 是 | **你不能用**，也不该读 |
| `refreshExpiresAt` | 否 | 同上 |
| `idToken` | 否 | 同上，不要用 |
| `resource` | 否 | 历史字段，可能没有 |
| `sessionInstanceId`、`refreshOperation`、`authContext` | 否 | 内部字段，**必须忽略** |

## 附录 C：错误码对照

| 码 | 出现位置 | 含义 |
|---|---|---|
| `IAM_NOT_SIGNED_IN` | 退出码 2 / HTTP 401 | 没有会话 |
| `IAM_REAUTH_REQUIRED` | 退出码 3 / HTTP 401 | 令牌过期，需重新登录 |
| `IAM_CREDENTIALS_UNAVAILABLE` | 退出码 4 / HTTP 503 | 凭据后端不可用 |
| `IAM_BRIDGE_UNAUTHORIZED` | HTTP 401 | 桥能力值不对 |
| `IAM_BRIDGE_FORBIDDEN` | HTTP 403 | 非本机来源 |
| `IAM_REQUEST_HEADER_REQUIRED` | HTTP 403 | 缺 `x-forge-iam-request: 1` |
| `IAM_HOST_UNREACHABLE` | 退出码 4 | 配置的 DSH 地址连不上 |

---

**反馈**：本文的样例已在 2026-11-04 用一份合成存储实测（`HELUO_FORGE_CREDENTIALS_FILE` + `heluo-forge` 命令），未登录/过期/有效/已退出四种结果与 §7 一致。HTTP 端点由实现与单元用例确定，**未在真实 DSH 上与你方联调**；如与你实测不符，以你实测为准并反馈给我们。相关设计说明见[开发者指南](<developer-guide.md>)。

**入口**：本手册的常驻页是 [issue #147](https://github.com/hrygo/heluo-forge/issues/147)（置顶、不关闭）。与本文不符之处请在该页留言，附命令、退出码、平台与版本。
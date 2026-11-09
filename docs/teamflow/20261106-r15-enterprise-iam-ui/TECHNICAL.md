# TECHNICAL · 企业身份与本机差异的可见性（r15）

> 基线：r4-forge-gitee / r5-devops-config-slimming / r9-runner-refresh-uninstall（增量保存、来源解析、失败面脱敏、`?refresh=1` 响应前重建、精确卸载）+ r14（设计输入）。取代 r14#AC-15、r14#AC-14 的口径见 PRD 头部。设计与验收口径以 [PRD.md](PRD.md) 的 AC-1～AC-21 为准，本文只补"怎么做"。

## 1. 现状核验结论（决定本方案形状的四个事实）

| # | 事实（已核验，2026-11-06） | 对本方案的影响 |
|---|---|---|
| F1 | `packages/forge-gitee` 无 `client.js`、无 `dsh.client`、`files` 不含客户端产物、**无任何 `webServer` 路由**；`src/index.mjs` 在 `apply` 时把 `adapter`/`gitAdapter`/`config` 一次性冻结进 `createService` 闭包 | Gitee 页必须由 Gitee 自己承载（AC-15），且必须先补"可重建读面"，否则写完配置只能等重启 |
| F2 | AC-18 要求 `peerDependencies` + `peerDependenciesMeta.optional`，而 `scripts/build-enterprise-bundle.mjs:58` 对 `peerDependencies`/`optionalDependencies` 非空直接报 `unclosed peerDependencies`；`tests/bundle-build.test.mjs:59,98`、`tests/bundle-gitee.test.mjs:68`（`assert.equal(manifest.peerDependencies, undefined)`）把这条写死 | AC-17 与 AC-18 正面冲突。必须同轮改构建脚本与两处断言，规则收紧为"只允许宿主白名单 + `optional: true` + semver 范围"，不是放宽成"任意 peer 都行"（§9） |
| F3 | `packages/forge-devops/src/index.mjs:468-473` `saveCliConfig` 在 `access.save()` 成功后调 `syncFaces({rebuild:true})`，未捕获；重建抛错 → 写已落盘但 POST 以 5xx 返回，页面只能报"保存失败" | 这正是 AC-8 要防的"保存与应用混成一个态"。改为返回 `applied`，让页面如实区分（§3.4） |
| F4 | AC-20 两项宿主探针已复现：harness 0.2.1-rc.5、`node scripts/probe/run-host-probe.mjs` = 12 通过 / 20 失败 / 1 blocked（共 32 检查）。20 条失败全部是 `ctx.tools.execute` 抛 `Cannot read properties of undefined (reading '0')` 且 `bodyCalls: 0`；抛点在被测宿主管线（probe 的 `dispatch()` 用 try/catch 记成 `{threw}`），不是探针断言失败；`packages/forge-policy/src` 无 `[0]` 索引读 | 判定为**宿主版本差异（unknown）**，本轮不改断言、不伪装全绿；T6 负责把 `error.stack` 计入 `probe-raw.json` 以拿到宿主文件:行，作为下一轮证据（§10.3） |

其余已核验：`settings.section` 当前有 `devops`(60) 与 `forge-iam`(30) 两个注册（`packages/forge-devops/client.js:1000-1013`、`packages/forge-iam/client.js:4035-4040`）；IAM 视图来源 `GET /api/forge-iam/view`（`packages/forge-iam/client.js:1473`）；IAM 状态枚举 `['unconfigured','signed-out','authenticating','ready','expired','unreachable','error']`（`packages/forge-iam/src/state.mjs:4-12`）；Gitee 配置五键与默认值全部来自补丁层 `config:`，不读隐式环境（`packages/forge-gitee/src/runtime-config.mjs:1-40`）。

## 2. 架构总览

```
                      ┌──────────────── 浏览器（同源，无 CORS）────────────────┐
  设置壳 settings.section                                                    │
   ├─ 29 企业研发   devops-readiness  ← forge-devops/client.js（新增 section）│
   ├─ 30 企业账号   forge-iam         ← forge-iam/client.js（不改）           │
   ├─ 50 企业 Gitee gitee             ← forge-gitee/client.js（新增 client 半）│
   └─ 60 企业 DevOps devops           ← forge-devops/client.js（最小修订）    │
                      └───────────────┬───────────────────────────────────────┘
                                      │ GET/POST（同源，带 CSRF 风格头）
        ┌─────────────────────────────┼──────────────────────────────┐
        │ /api/forge-iam/view         │ /api/forge-devops/cli        │ /api/forge-gitee/config
        │ （既有，只读投影）           │ （既有 + applied 增量）       │ （本轮新增）
        ▼                             ▼                              ▼
   forge-iam service           devops cliAccess + faces        gitee configAccess + faces
                              （宿主 configEditor 读写 profile 补丁层那一行 entry）
```

数据流铁律：**一个分区只读它自己的源**。企业研发分区只做"六行汇总 + 导航"，不持有任何可写状态、不新增身份通道（AC-1/AC-13）。

## 3. 服务端契约

### 3.1 `packages/forge-gitee/src/config-access.mjs`（新增）

镜像 `packages/forge-devops/src/cli-access.mjs` 的事务语义，只换字段表与 entry id。**逐字**复用其内部四件套的实现思路（`canonicalLayer` / `hashLayer`=sha256 前 16 位 / `sameLayer` / `readRow` 按 `options.id === entryId || options.name === entryId` 命中），不抽公共包（两包不跨源码导入，见 AGENTS §4；重复面由 §10.2 的文本契约用例守）。

```js
export const GITEE_ENTRY_ID = 'heluo-gitee';                 // 补丁层该行 id
export const GITEE_CONFIG_KEYS = Object.freeze(['cliPath','host','timeoutMs','authEnv','persistentToken']);
export const GITEE_PAGE_FIELDS = Object.freeze(['cliPath','timeoutMs']);   // 页面可写面（DESIGN §3.3）
export const GITEE_ORIGINS = Object.freeze({ CONFIG:'config', DEFAULT:'default', UNSET:'unset' });
export const GITEE_ACCESS_REASONS = Object.freeze({
  UNAVAILABLE: 'GITEE_CONFIG_UNAVAILABLE',
  CONFLICT:    'GITEE_CONFIG_CONFLICT',
  INVALID:     'GITEE_CONFIG_INVALID',
});

export function createGiteeAccess({ configEditor, entryId = GITEE_ENTRY_ID } = {})
  // -> { entryId, revision(), snapshot({ refresh } = {}), describe(), save({ revision, fields }) }
```

`snapshot()` 形状（页面逐字消费；`plugin` 同时供页脚用）：

```js
{
  revision: 'a1b2c3d4e5f60718',                  // 16 位，随层哈希变化
  plugin: { name: '@heluo/forge-gitee', version: '0.1.0' },
  writable: { ok: true } | { ok: false, reason: 'GITEE_CONFIG_UNAVAILABLE' },
  ready: true,                                    // 配置完整（不等于"就绪"，见 AC-10）
  reason: null,
  guidance: '设置 → 企业 Gitee',
  editable: ['cliPath', 'timeoutMs'],
  missing: ['GITEE_TOKEN'],                       // 只列变量名，不列值
  entries: {
    cliPath:         { origin: 'config', path: null|string, tool: 'gh', overrides: [{ origin, value }], candidates: [], rejected: [] },
    host:            { origin: 'unset',  value: null|string, overrides: [] },
    timeoutMs:       { origin: 'default',value: 20000,       overrides: [] },
    authEnv:         { origin: 'config', value: ['GITEE_TOKEN'], overrides: [] },
    persistentToken: { origin: 'default',value: 'warn',      overrides: [] },
  },
  host: { platform, arch, node },
}
```

`save({ revision, fields })` 判定顺序（与 cli-access 同序，任何一步失败即停）：

1. 无 row / 无可用 `configEditor`（`isEditorLike`：具备 `configuration()` 与 `edit()`）→ `{ok:false, code:UNAVAILABLE}`；
2. `revision` 与当前哈希不等 → `{ok:false, code:CONFLICT}`（**editor 调用 0 次**，AC-6）；
3. `fields` 非对象或含 `GITEE_CONFIG_KEYS` 之外键 → `{ok:false, code:INVALID}`；
4. 合并后走 `validateGiteeConfig()`；`issues` 非空 → `{ok:false, code:INVALID, errors:[{path,message}]}`（**写盘 0 次**）；
5. `sameLayer(next, merged)` 成立 → 不写盘，直接回当前快照（幂等，AC-9）；
6. `editor.edit(row.entry, () => next)`；捕获 `/no longer available|changed during reload/iu` → CONFLICT，其他 → UNAVAILABLE；
7. 写后回读，`sameLayer` 不等 → UNAVAILABLE（不猜"应该写成功了"）；
8. 成功 → 重合并、回新快照。

`null` 值语义 = 删除该键（恢复继承），与 devops 一致；`timeoutMs` 传字符串时按 `Number()` 归一；未知嵌套键、兄弟插件条目、注释由 `editor.edit` 的浅合并边界保证逐字不变（AC-6）。

### 3.2 `packages/forge-gitee/src/http.mjs`（新增）

```js
export const GITEE_API_PREFIX    = '/api/forge-gitee';
export const GITEE_CONFIG_ROUTE  = '/api/forge-gitee/config';
export const GITEE_REQUEST_HEADER= 'x-forge-gitee-request';
export const GITEE_MAX_BODY      = 64 * 1024;
export function createGiteeApi({ access, snapshot, now })
  // -> { handleGet(req) , handlePost(req, body) }   // 返回 { status, headers, body }
export function toNodeRoute(api, { path = GITEE_CONFIG_ROUTE } = {})
```

与 devops 端点同形的硬约束：无 CORS 头；所有响应 `cache-control: no-store` + `x-content-type-options: nosniff`；POST 缺 `x-forge-gitee-request: 1` → 400；body 只认 `{ revision, fields }`（多键 400），超 64KB → 413；状态码映射 `CONFLICT→409 / INVALID→422 / UNAVAILABLE→503`；错误体 `{ok:false, code, message, errors?, detail?}`；GET 成功加 `x-forge-gitee-at: <ISO>`。

```http
GET  /api/forge-gitee/config
200  { ...snapshot }                                    # 只读面，任何情况下都不含令牌值与绝对路径正文
503  { ok:false, code:'GITEE_CONFIG_UNAVAILABLE', ... } # snapshot 自身抛错

POST /api/forge-gitee/config      x-forge-gitee-request: 1
200  { ok:true, snapshot, applied:{ ok:true } }
200  { ok:true, snapshot, applied:{ ok:false, reason:'GITEE_REBUILD_FAILED' } }   # 已保存、未应用
400 | 409 | 413 | 422 | 503  （见上）
```

### 3.3 `packages/forge-gitee/src/index.mjs`（改造：可重建读面）

现状是"装配期一次性冻结"，改成一个可变引用 + 原子换页（`settings` 不需要降级态：构造失败不换引用，旧面仍自洽）：

```js
const buildFaces = (resolved) => Object.freeze({
  resolved,
  runner:  createGiteeRunner({ env, timeoutMs: resolved.timeoutMs, authEnv: resolved.authEnv, persistentToken: resolved.persistentToken }),
  adapter: createGiteeAdapter({ runner, cliPath: resolved.cliPath, host: resolved.host, authEnv: resolved.authEnv, env, persistentTokenPolicy: resolved.persistentToken }),
  guard:   createGiteeGuard({ policy }),
  git:     createGiteeGitAdapter({ runner, cwd: gitCwd }),
});
let faces = buildFaces(resolveGiteeConfig({ config: validated, env: process.env }));
const mergedConfigOf = (snapshot) => pick(GITEE_CONFIG_KEYS, snapshot.entries 的生效值);
const rebuildFaces = () => {
  const next = buildFaces(resolveGiteeConfig({ config: mergedConfigOf(access.snapshot()), env: process.env }));
  const prev = faces; faces = next; return prev;   // 只有一个赋值点 → 不存在半重建
};
```

**改造纪律**：service 的每个方法体内一律经 `faces.adapter` / `faces.git` / `faces.guard` 取值，禁止在 `apply` 顶部解构成局部常量（否则重建对它无效）。teardown 读当前 `faces`。新增端口：

```js
configStatus()                    // -> { writable, ready, reason, guidance, revision, plugin }
configSnapshot({ refresh = false } = {})   // refresh=true 时先 rebuildFaces() 再回 access.snapshot()
saveGiteeConfig({ revision, fields } = {}) // -> 见 3.4 同款 applied 形状
```

路由挂载与 devops 同法：`webServer.register({ kind:'prefix', path: GITEE_API_PREFIX, handler, description })`，失败记 `routeState='conflict'` 并经 `ctx.inject(['webServer'], …)` 晚到补挂（宿主可能后到）。

### 3.4 `applied` 增量通道（devops 与 gitee 同形）

`applied` 是**新增可选字段**，r9 消费者不受影响（旧页面读到 `undefined` 时按"应用状态未报告"呈现，不冒充成功）：

```js
// packages/forge-devops/src/index.mjs
saveCliConfig: async ({ revision, fields } = {}) => {
  const result = await access.save({ revision, fields });
  if (result?.ok !== true) return result;
  try { syncFaces({ rebuild: true }); return { ...result, applied: { ok: true } }; }
  catch { degradeFaces(); return { ...result, applied: { ok: false, reason: CLI_REASONS.REBUILD_FAILED } }; }
}
```

`packages/forge-devops/src/http.mjs` 的 `handlePost` 原样透传 `applied`（不新增校验）；`handleGet` 的 snapshot 增加 `plugin:{name,version}` 与 `editable:['dopBin','timeoutMs']`（两处均为增量字段，缺省时页面降级为不显示版该行）。

### 3.5 插件版本投影

两包各自在 `src/index.mjs` 顶部读自己的 `package.json`（`new URL('../package.json', import.meta.url)`，`npm pack` 恒包含它），把 `{name, version}` 注入快照的 `plugin` 字段。浏览器半**不**读 `package.json`——版本只有一个来源，页脚就能诚实写"分区由 @heluo/forge-gitee 0.1.0 提供"。

## 4. 前端契约

### 4.1 分区表（本轮固定，AC-13）

| 槽位 `name` | 注册 `id` | `order` | label | 承载包 | 本轮动作 |
|---|---|---|---|---|---|
| `settings.section` | `devops-readiness` | 29 | 企业研发 | `@heluo/forge-devops` | 新增 |
| `settings.section` | `forge-iam` | 30 | 企业账号 | `@heluo/forge-iam` | 不改 |
| `settings.section` | `gitee` | 50 | 企业 Gitee | `@heluo/forge-gitee` | 新增 |
| `settings.section` | `devops` | 60 | 企业 DevOps | `@heluo/forge-devops` | 最小修订 |

挂载写法必须逐字是两段式（AC-16）：

```js
ctx.slots.inject('settings.section', () => ctx.slots.register({
  name: 'settings.section', id: 'gitee', order: 50, label: () => t('nav'), locale: NS, inject: () => ({ t }),
}, GiteeSection));
```

`name` 必须是槽位名，插件标识放 `id`；`ctx.effect` 只接受 `函数 | null | Promise | 可迭代`，`ensureStyle()` 必须返回 disposer 而不是 `<style>` 元素（否则 `TypeError: Invalid effect`，整条 entry 不激活）。

### 4.2 企业研发分区（`packages/forge-devops/client.js` 追加）

组件树：`ReadinessSection` → `ReadinessHeader` / `ReadinessList`(`ReadinessRow` ×6) / `ReadinessFooter` / `CopyDiagnosticsButton`。进入时并行读三个端点，**每个端点失败只影响自己那一行**（`Promise.allSettled`）：

| 行 | 唯一输入 | 状态取值 | 显式禁止 |
|---|---|---|---|
| 企业身份 | `/api/forge-iam/view` 的 `state` | 404→未安装；`unconfigured`→未登录；`signed-out`→未登录；`authenticating`→登录中；`ready`→已登录；`expired`→过期；`unreachable`→不可达；`error`→退出未知 | 不得因 CLI 已配置而显示"已登录" |
| 公共参数 | 无（无已获批的维护接口） | 恒 `unknown`，文案"尚无可核验的公共维护权限与接口" | 不得写"已向企业分发"（AC-7） |
| 本机配置 | devops/gitee 快照 `entries[*].origin === 'config'` 的键名集合 | 已覆盖 N 项 / 未覆盖；**只列键名** | 不渲染任何值（AC-12 零路径） |
| DevOps | devops 快照 `ready` + `entries.dopBin.origin` | 未安装 / 未配置 / 已配置 | 不得把"已配置"写成"通过"；不得凭 CLI 名判企业就绪（AC-10） |
| Gitee | gitee 快照 `ready` | 未安装 / 未配置 / 已配置 | 同上 |
| 业务写权限 | 无（策略目录无 Web 读面） | 恒 `unknown` | 不得用 Demo 维护者开关或任何前端开关推导（AC-7） |

汇总区固定渲染一条不可关闭的声明：「本页只汇总本机可见性，不代表业务授权」。四组反例（已登录但 CLI 未配置 / CLI 可读但未登录 / Key 已配置但未验证 / 检查通过但写门禁关闭）在用例里逐组断言"另一行状态不变"（AC-2）。

检查（AC-10）只作用于 DevOps 行：`GET /api/forge-devops/cli?refresh=1`（唯一重扫入口），结果分 `未检查/检查中/通过/失败/未知/已过期` + 子原因（`未配置`←`NO_CLI`；`不可执行`←`ENTRY_NOT_EXECUTABLE`；`目标不可达`←`ENDPOINT_UNREACHABLE`；`只读被拒`←`POLICY_DENIED`）。Gitee 行无已批准探测 → 恒"未执行"，文案"未获批准的只读探测，本页不发起请求"。

### 4.3 企业 Gitee 分区（`packages/forge-gitee/client.js` 新增）

组件树：`GiteeSection` → `LayerTable`(`LayerRow` ×5，三列：公共参数 / 本机覆盖 / 最终生效) / `EditableRow`(`cliPath`、`timeoutMs`) / `ReadOnlyRow`(`host`、`authEnv`、`persistentToken`，用 `readOnly` 而非 `disabled` 以便复制) / `CheckRow`(未执行) / `SaveReceipt` / `SourceFooter`。命名空间 `NS='gitee'`，样式前缀 `fge-`，`METRICS` 自建（数值照抄 devops，不跨包 import）。

可写面只有 `['cliPath','timeoutMs']`：dirty 判定基线 = `origin === 'config' ? value : ''`；空串提交为 `null`（恢复继承）；`fields` 为空时**不发请求**（等值写 0 次）。409 → 保留 staged + "配置已被其它窗口改动"；422 → 只映射页面字段，隐藏键原因折进保存回执兜底文案。

### 4.4 企业 DevOps 分区（最小修订）

只加三件：① 页脚来源行「分区由 @heluo/forge-devops <version> 提供 · 读取于 <时间>」；② 保存回执分三行——保存态 / 应用态（读 `applied`）/ 检查态（`?refresh=1`），任一态变化不改写另两行（AC-8）；③ 三态交错用例（§10.2）。不改既有字段语义、不改 id/order、不改保存体形状。

### 4.5 观感、可达性与 i18n

- 强制走 `METRICS` 常量（禁裸 `px` 与十六进制颜色），只用 `--dsw-*` token + `color-mix(in srgb, …)`；`prefers-reduced-motion: reduce` 关闭动效。
- 每个状态行 `role="status"` + `aria-live="polite"`；键盘可达（Tab 顺序 = 视觉顺序）；复制诊断按钮带 `aria-label`。
- i18n：`devops` 命名空间增 `readiness.*` 一组键；`gitee` 命名空间新增 `nav/title/intro/col.*/origin.*/status.*/save.*/applied.*/check.*/footer.*`。中英键集必须等值、en 不含中文（`client-shape` 静态守）。

## 5. 数据模型与存储

不新增存储。唯一写入目标是 profile 补丁层里 `id: heluo-gitee` / `id: forge-devops` 那一行 entry 的 `config:` 子树，经宿主 `configEditor.edit(entry, next)` 浅合并；`revision` = 该层规范化 JSON 的 sha256 前 16 位，是乐观并发的唯一令牌。不写新文件、不加锁、不留中间态（写失败由宿主回滚到原文档）。

## 6. 状态管理

每个分区一份本地状态，互不共享（AC-1/AC-8）：

```js
reading:  { mode: 'loading'|'ready'|'degraded'|'failed', snapshot, reason }
checking: { state: 'unchecked'|'checking'|'pass'|'fail'|'unknown'|'stale', at, basis, source }
saving:   { state: 'idle'|'saving'|'saved'|'saved-not-applied'|'conflict'|'invalid'|'unavailable', applied, at }
```

迟到丢弃靠三个代次：读取序号 `readSeq`（每次进入/刷新 +1）、身份 `sessionEpoch`（IAM 快照变化 +1）、配置 `revision`。回包到达时若代次与发出时不一致，直接丢弃——AC-3 的"旧 session 响应不得复活绿灯"与 AC-9 的"迟到回包不得覆盖新基准"都由同一处判断实现。

## 7. 边界与错误处理

| 场景 | 服务端 | 页面 |
|---|---|---|
| 宿主无 `configEditor`（profile 无可写条目） | GET 200，`writable.ok=false` | 全字段只读 + 说明，保存按钮不出 |
| 补丁层缺该行 | GET 200，`writable.ok=false` + `reason=UNAVAILABLE` | 显示"未找到插件条目"，不伪造可写 |
| 另一窗口先改 | 409 | 保留 staged，提示刷新，不自动重发 |
| 字段非法 | 422 + `errors[]` | 逐字段聚焦，写盘 0 次 |
| 写成功、重建失败 | 200 + `applied.ok=false` | "已保存 · 未应用（原因码）"，禁止写成保存失败 |
| Gitee 插件未装 | 端点 404 | 企业研发页该行"未安装"，不回退成"未配置" |
| IAM 插件未装 | 端点 404 | 同上 |

## 8. 安全与脱敏（AC-11/AC-12）

六出口逐一给约束：**汇总行**只渲染键名与来源枚举；**工具结果**沿用 r9 的 `describeSpawnFailure` 口径（本轮不新增出口）；**错误**只回原因码 + 下一步；**复制诊断**只含"插件名 / 状态词 / 原因码 / 时间 / 基准短号(revision 前 8 位) / 来源类型"六类字段；**日志**不写配置值；**报告**不写路径与 endpoint。`authEnv` 只显示变量名列表，`persistentToken` 只显示枚举，令牌值在所有投影里不存在。Gitee 保存只允许五键白名单，`fields` 多余键直接 400/422。

## 9. 打包与分发（AC-14/15/17/18）

`packages/forge-gitee/package.json` 增量（逐字）：

```json
"exports": { ".": "./src/index.mjs", "./client": "./client.js", "./runtime-config": "./runtime-config.mjs",
             "./read": "./src/gitee-read.mjs", "./actions": "./src/gitee-actions.mjs", "./adapter": "./src/gitee-adapter.mjs" },
"files": ["src", "client.js", "cordis.patch.yml", "README.md"],
"peerDependencies": { "react": ">=18" },
"peerDependenciesMeta": { "react": { "optional": true } },
"dsh": { "bundle": { "patch": "./cordis.patch.yml" },
         "client": { "platform": "web", "immediately": true, "inject": ["slots", "locale"] } }
```

`dsh.client` 键集合与 `@heluo/forge-devops` 样本逐字一致（`platform/immediately/inject`），只换包名与 `files`。`packages/forge-devops/package.json` 同样补 `peerDependencies: { "react": ">=18" }` + `peerDependenciesMeta.optional`。

构建脚本规则（`scripts/build-enterprise-bundle.mjs`）：

```js
const HOST_PEERS = new Set(['react']);   // 宿主提供的运行时模块，永不由本仓库打包
```

- 允许声明 peer 的条件：键 ∈ `HOST_PEERS` **且** `peerDependenciesMeta[key].optional === true` **且** 版本是 semver 范围（禁 `workspace:*`）；
- peer 不进依赖闭包、不进 `bundledDependencies`、不得出现在 tarball 的 `node_modules/` 下；
- 其余情形保留原错误文案 `unclosed peerDependencies`（`tests/bundle-build.test.mjs` 的反向用例继续绿）。

`tests/bundle-gitee.test.mjs:68` 由 `assert.equal(manifest.peerDependencies, undefined)` 改为"断言恰好等于 `{react}` 且 meta 全 optional"——这是把口径写实，不是放宽（同轮在用例注释里写明取代关系）。

## 10. 测试策略

### 10.1 新增/修改用例

| 文件 | 覆盖 AC | 关键断言 |
|---|---|---|
| `packages/forge-gitee/test/config-access.test.mjs`（新） | 4/6 | revision 随层变；增量只提交 dirty 键；兄弟条目/注释逐字不变；409 时 `editor.edit` 0 次；非法值写盘 0 次；`null` = 删键回落 |
| `packages/forge-gitee/test/http.test.mjs`（新） | 11/12 | 缺自定义头 400；`no-store`+`nosniff`；64KB/413；状态码映射；响应体不含绝对路径与令牌 |
| `packages/forge-gitee/test/faces-rebuild.test.mjs`（新） | 9 | 保存后下一次调用用新 `cliPath`（断言 `execFile` 入参）；重建抛错时旧面仍可用且返回 `applied.ok=false`；扫描 0 次 |
| `packages/forge-gitee/test/client-shape.test.mjs`（新，模板同 devops） | 13/15/16 | 模块 id `@heluo/forge-gitee`；`slot.name==='settings.section'`、`id==='gitee'`、`order===50`；三条 effect；zh/en 键集等值；禁 `dangerouslySetInnerHTML/console./localStorage/eval`；禁盘符与绝对路径字面量；`role=status`+`aria-live` |
| `packages/forge-devops/test/client-shape.test.mjs`（改） | 1/2/3/10 | 两处注册（29/60）；六行汇总；四组反例互不推导；迟到回包丢弃；固定声明文案存在 |
| `packages/forge-devops/test/save-applied.test.mjs`（新） | 8 | 写成功后重建抛错 → `ok:true` + `applied.ok:false`，且 `degradeFaces` 生效 |
| `tests/ui-contract.test.mjs`（新） | 13/14/15/16 | 四个 section 的 id/order 唯一且 `name` 逐字等于槽位名；无第二套身份入口；两客户端端点常量与两侧 `src/http.mjs` 常量文本一致（防跨包漂移） |
| `tests/bundle-build.test.mjs` / `tests/bundle-gitee.test.mjs`（改） | 17/18 | peer 白名单规则正反向；`files` 覆盖 main/client/patch/README；tarball 内 `workspace:` 0 命中 |
| `scripts/uat-profile.mjs`（新，只读） | 19 辅助 | `--plan` 打印装/回滚命令并给出 `desktop` profile 目录哈希；`--verify <log>` 检查 `--dump-config` 与启动日志判据。**真装由主 agent 执行** |

### 10.2 三态交错矩阵（AC-8）

保存 × 应用 × 检查 各取三态做 6 组交错（保存成功+检查失败、保存失败+检查通过、保存 409+检查进行中、保存成功+应用失败+检查通过 …），每组断言：三行文本互不覆盖、任一态变化不重置另两态、`?refresh=1` 只在检查时发出、检查不写配置（`editor.edit` 计数 0）。

### 10.3 回归与既有失败（AC-20）

- `pnpm check`、`git diff --check` 复跑并记录真实数字；用例只增不减、0 skip。
- 探针：`node scripts/probe/run-host-probe.mjs` 复跑，T6 把 `error.stack`（而非只有 `message`）写进 `probe-raw.json` 的失败条目——这是**补证据**不是改断言；若栈落在宿主 dist 代码，按"宿主版本差异"记 unknown 并附文件:行；若落在探针自身，则先补失败用例再修。

## 11. 任务拆分（并行边界按文件所有权）

| 任务 | 修改的文件（owns） | 只读 | 依赖 | 验收 |
|---|---|---|---|---|
| T1 Gitee 服务端配置写通道 | `packages/forge-gitee/src/config-access.mjs`、`src/http.mjs`、`src/index.mjs`、`test/config-access.test.mjs`、`test/http.test.mjs`、`test/faces-rebuild.test.mjs` | `src/runtime-config.mjs`、`packages/forge-devops/src/{cli-access,http}.mjs` | — | 三份新用例全绿；`--dump-config` 后端点可挂；写后新 `cliPath` 生效 |
| T2 Gitee client 半 | `packages/forge-gitee/client.js`、`packages/forge-gitee/package.json`、`test/client-shape.test.mjs` | T1 的端点常量、`packages/forge-devops/client.js` | 与 T1 并行（只依赖设计里已固定的字符串契约） | 形状用例全绿；`dsh.client` 键集与 devops 样本一致 |
| T3 DevOps 页面增量 | `packages/forge-devops/client.js`、`src/index.mjs`、`src/http.mjs`、`test/client-shape.test.mjs`、`test/save-applied.test.mjs` | `packages/forge-gitee/src/http.mjs`（对齐端点） | — | 29/60 两注册；`applied` 通道；三态交错用例 |
| T4 分发闭包与 peer 规则 | `scripts/build-enterprise-bundle.mjs`、`scripts/check-client-module.mjs`、`scripts/uat-profile.mjs`、`packages/forge-devops/package.json`、`tests/bundle-build.test.mjs`、`tests/bundle-gitee.test.mjs`、`tests/ui-contract.test.mjs` | 两包 `package.json`/`cordis.patch.yml` | T2（manifest 形状） | 构建成功产物含 `client.js`；peer 正反向用例；`node scripts/check-client-module.mjs packages/*/client.js` 退出码 0 |
| T5 文档与使用说明 | `docs/design/plugins/forge-gitee.md`、`docs/design/plugins/forge-devops.md`、`docs/design/README.md`、`packages/forge-gitee/README.md`、`packages/forge-devops/README.md`、`README.md` | T1–T4 结论 | T1–T3 | 索引与包 README 同步；NOT RUN 清单如实；`.gitignore` 覆盖 `artifacts/`、`logs/`、构建临时目录 |
| T6 交付自检 | （原则上不改文件；发现问题当场修，记录结论） | 全部 | T1–T5 | §10.3 命令实跑；`git status` 无 tgz/dist/logs；不写 QA-REPORT/ACCEPTANCE |

工程约束（每条任务都适用，不另行拆分）：**不切换 `feat/plugin-workflow` 分支、不新建分支**；保留现有未提交改动（`demos/`、`scripts/lib/dsh-version.mjs`、`tests/dsh-version.test.mjs`、`scripts/probe/iam-review-memory-credentials.mjs`）；**不推送**；提交需当次授权；只用独立 profile `heluo-r15-uat`，不动 `desktop`；不做双端。

## 12. 风险与 NOT RUN

| 风险 | 处置 |
|---|---|
| 公共参数维护接口/权限未取得（AC-7） | 本期只交付"拒绝面 + 只读区块"，证据类型记 `unknown`，不写"已分发" |
| 独立 profile GUI 与桌面实例并存受端口/单实例限制（AC-19） | 不可达则 AC-16/19 标 NOT RUN，不用启动日志冒充"可见" |
| `react` peer 与宿主实际版本不符 | peer 声明 `optional`，运行时由宿主模块加载器提供；不安装、不锁版本，失败面表现为客户端半不激活（由 `--dump-config` + 启动日志识别） |
| 两包 http 实现漂移 | `tests/ui-contract.test.mjs` 文本比对常量与状态码表，漂移即红 |
| 探针 20 条既有失败 | 记 unknown 并留栈，不删测、不改断言 |
| Windows / 麒麟 aarch64 / 真实 CLI / Keychain / IAM 网关 / `--json` 稳定性 | NOT RUN（PRD §7） |

## 13. 验证命令

```sh
cd packages/forge-gitee && node --test "test/*.test.mjs"
cd packages/forge-devops && node --test "test/*.test.mjs"
node --test tests/ui-contract.test.mjs tests/bundle-build.test.mjs tests/bundle-gitee.test.mjs tests/plugin-patch-layers.test.mjs
node scripts/check-client-module.mjs packages/forge-gitee/client.js packages/forge-devops/client.js
node -e "import('./packages/forge-gitee/src/index.mjs').then(m=>console.log(m.name, m.inject))"
dsh --profile qa --patch packages/forge-gitee/cordis.patch.yml --patch packages/forge-devops/cordis.patch.yml --dump-config
node scripts/uat-profile.mjs --plan --profile heluo-r15-uat
node scripts/probe/run-host-probe.mjs
pnpm check
git diff --check
```

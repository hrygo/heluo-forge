# 企业研发总览返工技术设计（r16 · 只补 r15 验收打回项）

> 基线：`docs/teamflow/20261106-r15-enterprise-iam-ui/`（PRD/DESIGN/TECHNICAL 已 PASS）。本轮只补验收打回 D-1～D-5，不重写 r15 方案，不改 AC 级行为；r15 已验收的全部形状断言只增不减。
> 需求：`docs/teamflow/20261106-r16-r15-iam-readiness-rework/PRD.md`（12 条 AC，P0 = AC-1～AC-5）。
> 事实口径：本文所有路径与行号均为本轮实读 `feat/plugin-workflow` 工作树所得（2026-11-06）；未核验项集中在 §13，不以推断代替证据。

## 1. 现状核验与差距（D-1～D-5 的代码落点）

| 现状 | 事实（文件:行） | 与 AC 的差距 |
|---|---|---|
| 汇总分区只有六行 | `packages/forge-devops/client.js:116`（`READINESS_ROWS`）、`:826-848`（`rows()`） | 缺 Key 行（AC-2）、缺每行「下一步」（AC-3）、缺三层来源（AC-6） |
| `error` 被压成「未知」 | `packages/forge-devops/client.js:99-107`（`IAM_STATE_OF.error → READINESS_STATES.unknown`） | D-2：退出未确认必须独立状态词（AC-3） |
| 检查只有一句详情 | `packages/forge-devops/client.js:851-880`（`runCheck`）、`:876-882`（`checkStateOf`）、`:891-946`（`checkDetail` + 页脚） | D-4：无四项（revision 短号/时间/对象/来源类型）、无四层证据、无「已过期」保留旧值（AC-4） |
| 检查回包无代次校验 | `packages/forge-devops/client.js:851-880` 只判 `mounted.current`，无 `checkSeq` | 迟到回包会覆盖新结论（AC-4 第 5 段） |
| 无导航动作，也不降级 | `packages/forge-devops/client.js:1400-1440` 两处 `inject: () => ({ t })`；组件拿不到 ctx | AC-1 无处可去；也没有「不可用就只给文字」的分支 |
| 分区组件只拿 `{t}` | 同上（`inject` 返回值即组件 props） | 导航能力必须在 `apply` 期捕获、经 `inject` 传入，不能靠 props 猜 |
| DevOps 快照无三层 | `packages/forge-devops/src/cli-access.mjs:238-259`（`buildSnapshot`）；`:165-182`（`readRow` 已拿到 `{entry,inherited,override}`）、`:192-196`（`mergedLayer`） | D-1/AC-6：行中已有三层数据，快照却只投影 `origin/value/overrides` → 三层键名丢失 |
| Gitee 快照已有三层 | `packages/forge-gitee/src/config-access.mjs:283-341` | 无需改服务端；客户端缺展示 |
| 四个死 i18n 键 | `packages/forge-devops/client.js`（zh/en 字典区，`readiness.public.readonly`/`loading`/`failed`/`draftWarning` 零引用） | AC-9：三个接入真实状态、一个 zh/en 同步删除 |
| 检查只 `?refresh=1` | `packages/forge-devops/client.js:537`（`refreshUrl`，唯一拼法，`tests/ui-contract.test.mjs` 钉死） | 保持；新增调用点不得出现第二处拼法 |
| 探针批式派发 | `scripts/probe/host-probe-plugin.mjs:90-91`（`{calls:[…]}` + `batch.results[0]?.result`）、`:1043`、`:1053` 同型 | AC-7：宿主契约为单次 `execute({callId,name,arguments,signal})` 返回单结果 |
| 文档门禁 15 条 | `node scripts/check-docs.mjs` 实跑：`docs: 15 error(s)`（r14 12 + r15 3） | AC-8：逐条最小字面清理 |

关键不可越线（沿用 r15 DESIGN §2.2，本轮不放开）：

1. 只有同源 GET；本页不发 `?refresh=1` 以外的写请求，检查写配置 0 次（AC-4/AC-12）。
2. 只展示**状态词、键名、来源枚举**；不显示配置值、路径、endpoint、token、主体标识（`principal`/`baseURL`/`gatewayConsoleUrl` 一律不读不渲染）。
3. 三源并行、失败只改自己那行；固定声明句「本页只汇总本机可见性，不代表业务授权」恒在场，且不得用来替代真实状态。

## 2. 架构总览

```
            ┌──────────────── 浏览器（设置壳）────────────────┐
            │ settings.section id=devops-readiness (order 29) │
            │   ReadinessSection({ t, navigate })             │
            └───────┬───────────────┬────────────────────────┘
       GET 三源并行  │               │  GET /api/forge-devops/cli?refresh=1（仅「检查 DevOps」）
                    ▼               ▼
   /api/forge-iam/view     /api/forge-devops/cli     /api/forge-gitee/config
   (forge-iam 既有路由)     (devops http.mjs)          (gitee http 既有路由)
        │                        │                          │
        │                        ▼                          │
        │            src/index.mjs: projectSnapshot()        │
        │            + readiness: buildReadiness(...)        │
        │              ├ 复用 access.snapshot() 的 entries   │
        │              ├ layers ← cli-access（新增投影）     │
        │              ├ 四层证据 ← statSync/isDirectlyExecutable/policy.admit
        │              └ 只读、无子进程、无写配置            │
        └────────────────────────┴──────────────────────────┘
                    客户端把三份响应投影成 7 行 + 检查面板（唯一的显示真源）
```

设计取舍（附理由）：

1. **四层证据放服务端算，客户端只渲染。** 客户端没有 `statSync`、也不该拿策略对象；证据判定必须与被测对象（同一份快照、同一份 `platform`）同源，否则页面会凭旧快照猜「文件存在」。客户端因此不新增任何文件系统或进程能力（AC-12：两包 `src` 零 `spawn(`/`exec(`/`shell:true` 不变）。
2. **证据不新建端点，挂在既有快照的附加字段上。** 现有 GET 已经是最小读面（`packages/forge-devops/src/http.mjs`），新增端点会多一处鉴权/契约面，也让 `?refresh=1` 的「只此一处」约束出现歧义。
3. **Gitee 服务端零改动。** `packages/forge-gitee/src/config-access.mjs` 已逐字段投影 `inherited`/`override`/`origin`，三层展示只需客户端读取。
4. **导航做能力探测，不做路由猜测。** 宿主设置壳是否提供分区切换公开通道**未核验**（§13 NOT RUN-7）；探测不到就渲染文字指引，绝不渲染无响应按钮（AC-1）。

## 3. 服务端契约

### 3.1 新模块 `packages/forge-devops/src/readiness.mjs`（纯函数，无 I/O 写、无子进程）

导出（`Object.freeze` 常量 + 两个函数）：

```js
export const READINESS_CONTRACT = 1;
export const READINESS_OBJECT = 'devops';
export const READINESS_SOURCE_TYPES = Object.freeze([
  'local-diagnostic', 'fixture', 'enterprise-evidence', 'unknown',
]);
export const EVIDENCE_LAYERS = Object.freeze(['file', 'executable', 'target', 'readonly']);
export const EVIDENCE_STATES = Object.freeze({ pass: 'pass', fail: 'fail', notRun: 'not-run' });
export const EVIDENCE_BASIS = Object.freeze({
  filesystemStat: 'filesystem-stat',
  configShape: 'config-shape',
  policyAdmission: 'policy-admission',
});
export const EVIDENCE_REASONS = Object.freeze({
  NO_DOP_BIN: 'NO_DOP_BIN',
  PATH_RESOLUTION_REQUIRED: 'PATH_RESOLUTION_REQUIRED',
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  IS_DIRECTORY: 'IS_DIRECTORY',
  NOT_EXECUTABLE: 'NOT_EXECUTABLE',
  SOURCE_TYPE_UNKNOWN: 'SOURCE_TYPE_UNKNOWN',
  POLICY_UNAVAILABLE: 'POLICY_UNAVAILABLE',
  POLICY_DENIED: 'POLICY_DENIED',
  CONFIRMATION_REQUIRED: 'CONFIRMATION_REQUIRED',
  NO_EVIDENCE: 'NO_EVIDENCE',
});

/** 三层键名投影：只出**键名**，不出继承层的值（AC-6 + AC-12）。 */
export function projectLayers(row, fields = CLI_FIELDS) // -> { inherited: string[], override: string[], missing: string[] }

/** 唯一判定入口。statSync/admit 由装配层注入，缺省即「未执行 + 原因」。 */
export function buildReadiness({
  snapshot, row, sourceType, plugin, platform, statSync = null, admit = null, now = () => new Date(),
}) // -> ReadinessView
```

`projectLayers` 规则：只保留 `fields` 内、值非 `null`/`undefined` 的键名，键名排序固定（字典序），`missing` 为「三层中为空的那几层」（`inherited`/`override` 无键、或 `snapshot.revision === null` 表示无生效值）。

`buildReadiness` 的判定表（唯一实现，客户端不得重算）：

| 层 | 通过（`pass`） | 未通过（`fail`） | 未执行（`not-run`） |
|---|---|---|---|
| `file` | `dopBin` 是可解析路径且 `statSync` 返回普通文件；`basis: filesystem-stat` | `FILE_NOT_FOUND` / `IS_DIRECTORY` / 非普通文件 | `dopBin` 未配置 → `NO_DOP_BIN`；是裸命令名（PATH 名）→ `PATH_RESOLUTION_REQUIRED`；`statSync` 未注入 → `NO_EVIDENCE` |
| `executable` | 同一 `stat` 经 `isDirectlyExecutable({path,platform,stat})` 为真（`packages/forge-devops/src/entry-form.mjs`，末审唯一处） | `NOT_EXECUTABLE`（含 POSIX 缺执行位、非普通文件） | 与 `file` 同因（未拿到 `stat` 时一律 `not-run`，不得凭后缀或名字猜可执行） |
| `target` | `deriveSourceType(entries)` 能判定（`enterprise`/`mock`），且 `dopEndpoint` 通过 `validateConfigField` 形状校验；`basis: config-shape` | `SOURCE_TYPE_UNKNOWN`（来源不可判定） | `dopBin` 与 `dopEndpoint` 都未配置 → `NO_EVIDENCE` |
| `readonly` | 策略 `admit({ action: 'change.read', target: 'dop:change.read' })` 返回 `allowed`；`basis: policy-admission` | `POLICY_DENIED`（denied） | `confirm` → `CONFIRMATION_REQUIRED`；无策略对象 → `POLICY_UNAVAILABLE`；`admit` 未注入 → `NO_EVIDENCE` |

- `admit` 只做前置可见性判定，**不启动子进程**（`packages/forge-devops/src/policy-guard.mjs` 的 `admit` 语义），因此 `readonly: pass` 的含义是「策略准入允许只读动作」，**不是**「已跑过真实只读探测」。客户端必须把这一层显示为「策略准入（未发起真实请求）」，真实探测整体标 NOT RUN（§13）。
- `verdict`：任一层 `fail` → `'fail'`，`blockedBy` 取第一个 `fail` 层；否则任一层 `not-run` → `'incomplete'`，`blockedBy` 取第一个 `not-run` 层；全 `pass` → `'pass'`，`blockedBy: null`。
- `reason`：`blockedBy` 层的 `reason`（`fail`/`not-run` 必有原因，`pass` 恒 `null`）。
- 写入次数 0：本模块只读 `snapshot`、`row`、注入的 `statSync`/`admit`，不 import `node:fs` 的写面，不 import `child_process`（AC-4「检查写配置 0 次」）。
- `at`：`now().toISOString()`；同一次响应内只取一次。
- `sourceType` 映射（`READINESS_SOURCE_TYPES`）：快照 `deriveSourceType` 为 `enterprise` → `'local-diagnostic'`（本机配置诊断，**不是**企业证据）；`mock` → `'fixture'`；不可判定 → `'unknown'`；`'enterprise-evidence'` 只在真实企业探测执行后产生，本轮**不产生**（保留枚举与文案位，写法见 §4.5）。

### 3.2 改动 `packages/forge-devops/src/cli-access.mjs`

`buildSnapshot(row)`（:238-259）在冻结对象上增两个键，其余逐字不动：

```js
layers: projectLayers(row),           // { inherited:[…], override:[…], missing:[…] }
readAt: now().toISOString(),          // 读面时间（检查四项的「时间」缺省来源）
```

- `projectLayers` 从 `src/readiness.mjs` 引入（同包 import，不跨包）；`now` 沿用 `createCliAccess` 现有注入风格（缺省 `() => new Date()`），便于用例固定时钟。
- `entries` **不得**新增 `inherited`/`override` 的值（AC-12：值不进快照；`packages/forge-devops/test/cli-access.test.mjs` 现有「entries 无继承层值」断言保留并补一条）。Gitee 侧例外，因为它早在 r15 就逐字段投影了 `inherited`/`override` 的值 —— 该差异在 §13 风险表记为已知双形，不在本轮抹平。

### 3.3 改动 `packages/forge-devops/src/index.mjs`

`projectSnapshot`（:68-75）保持模块级纯函数不动，在 `apply` 内新增闭包级投影，让快照的所有出口一致：

```js
import { buildReadiness } from './readiness.mjs';
import { statSync } from 'node:fs';                       // 与 cli-access.mjs:26 同口径，只读
import { CLI_FIELDS, deriveSourceType } from './cli-config.mjs';

const withReadiness = (snapshot) => {
  const row = access.rowForReadiness();                   // 见下
  return Object.freeze({
    ...projectSnapshot(snapshot),
    readiness: buildReadiness({
      snapshot, row, platform: snapshot?.host?.platform ?? process.platform,
      sourceType: deriveSourceType(snapshot?.entries ?? {}),
      plugin: DEVOPS_PLUGIN,
      statSync,
      admit: (request) => guard.admit(request),
    }),
  });
};
```

- 出口逐一替换（只加投影，不改语义）：`snapshot`（:431）、`cliSnapshot`（:502）、保存回读（:519、:524）。
- `access.rowForReadiness()`：在 `createCliAccess` 增一个只读访问器，返回**当次** `readRow()` 的 `{inherited, override}` 键名（内部已有 `readRow`），不缓存（revision 栅栏语义不变）。
- `apply` 期已有 `policy`（缺失即抛 `POLICY_REQUIRED`）与 `guard`，为 `admit` 的确定性来源；`ctx.get('configEditor')` 缺失时 `row === null`，`layers` 全 `missing`、`revision: null`，检查结论落在 `incomplete/NO_EVIDENCE`，不伪造。
- 不新增服务方法、不改 `inject`（仍 `['tools','policy']`）、不改 handler 数量（`packages/forge-devops/test/tools.test.mjs`/`patch-mount.test.mjs` 不受影响）。

### 3.4 `packages/forge-devops/src/http.mjs` 与 Gitee 服务端

零改动。`http.mjs` 只透传 `service.snapshot()` 的结果，`?refresh=1` 仍走注入的 `refreshSnapshot()`（发现 → 重建 → 同源响应），`POST` 仍只认 `revision` + `fields`。Gitee 侧 `packages/forge-gitee/src/config-access.mjs` 三层已足（§1 表）。

## 4. 前端契约（`packages/forge-devops/client.js`，唯一写者）

### 4.1 常量与行模型

```js
READINESS_ROWS = ['identity', 'public', 'local', 'key', 'devops', 'gitee', 'write'];  // 插入 key（:116）
IAM_STATE_OF.error = READINESS_STATES.signedOutUnknown;                                // 修 D-2（:99-107）
READINESS_STATES += signedOutUnknown / keyUnverified / keyVerified;                    // :82-97
SECTION_FORGE_IAM = 'forge-iam';                                                       // AC-1 目标分区 id
NAV_METHODS = ['openSection', 'selectSection'];                                        // 能力探测表（§4.4）
```

行对象（`rows()` 的返回形状，纯函数、可单测）：

```js
{
  id, state,                          // state 取 READINESS_STATES 之一
  detail,                             // 已翻译文本；不含值/路径/endpoint
  next: { kind: 'navigate' | 'text' | 'button' | 'none', key, label },
  layers: null | { effectiveOrigin, overridden: [], inherited: [], override: [], missing: [] },
  evidence: null | [{ id, state, reason, basis }],   // 仅 devops 行，且仅检查后
}
```

`next` 的映射（AC-3 六态各有一条下一步，`unknown`/`missing` 也不落空）：

| 身份 state | 状态词键 | 下一步 |
|---|---|---|
| `signedOut` | `readiness.state.signedOut` | `navigate`：前往企业账号（未装插件时降级为 `text`：设置 → 企业账号） |
| `authenticating` | `readiness.state.authenticating` | `text`：返回账号页等待登录完成 |
| `signedIn` | `readiness.state.signedIn` | `navigate`：前往企业账号 |
| `expired` | `readiness.state.expired` | `navigate`：前往企业账号（提示会话过期，需重新登录） |
| `unreachable` | `readiness.state.unreachable` | `button`：重试（重新三源读取）+ `text`：前往账号页 |
| `signedOutUnknown` | `readiness.state.signedOutUnknown`（退出未确认） | `navigate`：前往账号页核对退出状态 |
| `missing` | `readiness.state.missing`（未安装） | `text`：安装企业账号插件后再核对 |
| `unknown`（其它未列 state 之外，如解析失败） | `readiness.state.unknown` | `text`：刷新后重试 |

`IAM_STATE_OF[state] ?? (iamOk ? READINESS_STATES.signedOutUnknown : sourceState(iam))`：**任何**未列出的 `state`（含 `error`）都落「退出未确认」，不得回落到 `unknown` 或 `signedOut`；「未安装」（404）与「不可达」用 `sourceState` 的既有区分。

### 4.2 Key 行（AC-2，五态，只吃三个字段）

```js
function keyStateOf(source) {          // source = readSource('/api/forge-iam/view')
  if (!source.ok) return source.status === 404 ? 'missing' : 'unknown';
  const gw = source.body?.gatewayCredential;
  if (!gw || typeof gw !== 'object') return 'unknown';
  if (gw.state === 'unconfigured') return 'unconfigured';
  const verified = gw.state === 'configured'
    && gw.matchesAccount === true
    && source.body?.modelAccess?.state === 'ready';
  return verified ? 'keyVerified' : 'keyUnverified';
}
```

- 只读 `gatewayCredential.state`、`gatewayCredential.matchesAccount`、`modelAccess.state` 三个字段；`storage`/`baseURL`/`deviceLabel`/`enteredAt` 一律不读（`packages/forge-iam/src/service.mjs:706-735` 的其余字段即使在工作树里也淘汰）。
- 状态词：未配置（`unconfigured`）/已配置·未验证（`keyUnverified`）/已验证（`keyVerified`）/未知（`unknown`）/未安装（`missing`）。
- 「已验证」从严（PRD §10-3）：必须三条件同时成立；`matchesAccount !== true`（含 `owner-mismatch`、`invalid`、字段缺失）一律「已配置·未验证」，并在 detail 里给原因（`readiness.key.reason.ownerMismatch|notConfigured|invalid|modelUnavailable`），**不得**并入已验证。
- `modelAccess.state ∈ {loading, error, unconfigured, ready}`（`packages/forge-iam/src/managed-models.mjs`）；非 `ready` 时即使凭据匹配也是「已配置·未验证」。

### 4.3 三层来源（AC-6）

`devops` 行：`layers` 直接来自 `body.layers`（§3.2）+ 每字段 `origin`（`entries[field].origin`）+ `entries[field].overrides`。
`gitee` 行：`layers` 由客户端从 `body.entries` 投影（`inherited !== null` → 公共参数层键名；`override !== null` → 本机覆盖层键名），`revision` 存在才认「最终生效」。

渲染（`details/summary`，默认收起，展开不改其它行）：

```
生效来源：配置 / 环境变量 / 自动发现 / 未知     （readiness.origin.*，取 dopBin 与 cliPath 的 origin）
被本机覆盖：dopBin、timeoutMs                    （空 → 无）
  公共参数（inherited，<插件名> <版本>）  键名列表 / 未知 · 原因
  本机覆盖（override，profile 补丁）      键名列表 / 未知 · 原因
  最终生效（value，快照 revision 前 8 位）键名列表 / 未知 · 原因
```

- 缺层 → 该层显示「未知」+ 阻塞原因（`LAYERS_UNAVAILABLE`、`INHERITED_EMPTY`、`OVERRIDE_EMPTY`、`NO_REVISION`），**不得**用默认值或 `entries.origin` 冒充某一层。
- 只出键名；插件名取 `body.plugin.name`，版本取 `body.plugin.version`，缺失显示「版本未知」（沿用 r15 §3.1）。
- 与检查面板同屏：`devops` 行的 `layers` 与 `evidence` 在同一行区域内展开，两处读同一份响应对象，不建副本。

### 4.4 导航适配器（AC-1，能力探测 + 文字降级）

```js
/** 只在宿主真的暴露分区切换时才交出函数；探测不到返回 null。 */
function sectionNavigatorOf(ctx) {
  const apis = [];
  if (typeof ctx.get === 'function') {
    const settings = ctx.get('settings');
    if (settings && typeof settings === 'object') apis.push(settings);
  }
  if (ctx.settings && typeof ctx.settings === 'object') apis.push(ctx.settings);
  for (const api of apis) {
    for (const method of NAV_METHODS) {
      if (typeof api[method] === 'function') return (id) => api[method](id);
    }
  }
  return null;
}
```

- `apply(ctx)` 期算一次：`const navigate = sectionNavigatorOf(ctx);`，两个分区注册的 `inject` 都返回 `{ t, navigate }`（`devops` 分区收下不用，保持形状一致）。
- 组件：`props.navigate` 为函数 → 渲染唯一一个「前往企业账号」按钮，`onClick: () => props.navigate(SECTION_FORGE_IAM)`（同页切换、不新开窗口、不写会话）；否则渲染 `readiness.nav.guide`（「设置 → 企业账号」）文字，**不渲染**按钮。
- 本分区复制登录/退出/onboarding/网关凭据/模型设置入口数量保持 0（`tests/ui-contract.test.mjs` 现有断言保留）。
- 宿主 API 未核验（§13 NOT RUN-7），因此 `NAV_METHODS` 是探测表而非契约：命不中即降级，绝不渲染点了没反应的控件。

### 4.5 检查面板（AC-4/AC-7 前端半，六态 + 四项 + 四层）

状态机（`check` 状态对象）：

```js
{ state, at, basis, verdict, reason, evidence, revision, sourceType }
```

| 事件 | 结果 |
|---|---|
| 初始 | `{ state: 'unchecked' }`，按钮可点，详情 `readiness.state.unchecked` + 下一步「点检查」 |
| 点击「检查 DevOps」 | `setBusy(true)`；`check` → `checking`（`at` 记点击时刻）；**只**请求 `refreshUrl()` |
| 响应 ok + `readiness.verdict === 'pass'` | `pass`；四项 + 四层照写入 |
| 响应 ok + `verdict === 'fail'` | `fail`；`reason` 取 `readiness.reason` 的枚举（映射到 `readiness.evidence.reason.*`），不渲染原始 `message` |
| 响应 ok + `verdict === 'incomplete'` | `unknown`；`reason` 同上（例：`PATH_RESOLUTION_REQUIRED`） |
| 响应 `!ok` 且 `status === 0` | `unknown`（不可达） |
| 响应 `!ok` 且 `status >= 400` | `fail`；`reason` 取 `errorCode(body)` 的既有映射 |
| 响应无 `readiness` 字段（旧快照/降级） | `unknown` + `NO_EVIDENCE`，四项显示「未知」，不编造 |
| 当前快照 `revision` 与 `check.basis` 不一致 | `stale`（已过期）：保留旧四项、旧四层、旧时间，另标「已过期」 |

- **四项**（同屏、固定顺序）：`revision` 前 8 位（不足 8 位照原样，缺失「未知」）、检查时间（`readiness.at`，ISO 截断为 `YYYY-MM-DD HH:mm:ss` 的**本地**格式由 `Intl` 或切片实现，不引依赖）、对象「DevOps」、来源类型（`readiness.sourceType` 的四枚举文案）。
- **四层**：按 `EVIDENCE_LAYERS` 顺序渲染 4 行，每行「层名 + 状态词 + 原因（非 pass 时）+ 判定依据」；数组长度不是 4 或字段缺失 → 该层按 `not-run`/`NO_EVIDENCE` 显示，不补默认值。
- **Gitee 行**：不发请求；渲染禁用按钮（`readiness.action.checkGitee`）+ `readiness.gitee.notExecuted`（「未执行 · 未获批准的只读探测，本页不发起请求」）。页脚原有的固定段落移到该行，页脚只留声明句与刷新。
- `?refresh=1` 仍只有 `refreshUrl()` 一处拼法、只有「检查 DevOps」一处调用；「刷新」按钮只调 `load()`（不带参数）。
- 检查结束不写配置：前端只发 GET，无 POST/无 headers 变化（`REQUEST_HEADERS` 不用于本分区）。

### 4.6 i18n 键表（zh/en 逐字等值）

复用：`readiness.title/intro/declaration/row.*/state.*/reason.*/public.unknown/local.keys/local.none/gitee.notExecuted/write.unknown/action.check/action.check.busy/action.refresh/check.unchecked/check.at/receipt.check`。

新增（zh 文案为准，en 同键同语义）：

| 组 | 键 | zh |
|---|---|---|
| 行 | `readiness.row.key` | 网关 Key |
| 状态 | `readiness.state.signedOutUnknown` | 退出未确认 |
| 状态 | `readiness.state.keyUnverified` | 已配置·未验证 |
| 状态 | `readiness.state.keyVerified` | 已验证 |
| Key 详情 | `readiness.key.reason.{ownerMismatch,notConfigured,invalid,modelUnavailable,unknown,notInstalled}` | 凭据属于其他账号 / 尚未写入网关凭据 / 凭据记录不可读 / 模型访问未就绪 / 无法判定 / 账号插件未安装 |
| 下一步 | `readiness.next.{signIn,signingIn,checkPassword,signedIn,expired,unreachable,unconfirmed,missingPlugin,keyConfigure,keyVerify,check,refresh,giteeBlocked}` | 与 §4.1 表逐条对应 |
| 导航 | `readiness.action.openAccount` / `readiness.nav.guide` | 前往企业账号 / 设置 → 企业账号 |
| 检查四项 | `readiness.check.item.{revision,time,object,sourceType}` | 基准 / 检查时间 / 对象 / 来源类型 |
| 来源类型 | `readiness.check.sourceType.{local-diagnostic,fixture,enterprise-evidence,unknown}` | 本地诊断 / 夹具 / 企业真实证据 / 未知 |
| 证据层 | `readiness.evidence.layer.{file,executable,target,readonly}` | 文件存在 / 可启动 / 目标可识别 / 只读可访问 |
| 证据态 | `readiness.evidence.state.{pass,fail,notRun}` | 通过 / 未通过 / 未执行 |
| 证据依据 | `readiness.evidence.basis.{filesystemStat,configShape,policyAdmission}` | 文件系统只读探测 / 配置形状 / 策略准入（未发起真实请求） |
| 证据原因 | `readiness.evidence.reason.<EVIDENCE_REASONS 每项>` | 逐项一句中文原因 |
| 三层 | `readiness.layers.{title,inherited,override,effective}`、`readiness.layers.reason.{LAYERS_UNAVAILABLE,INHERITED_EMPTY,OVERRIDE_EMPTY,NO_REVISION}` | 三层来源 / 公共参数 / 本机覆盖 / 最终生效 + 四条原因 |
| 来源枚举 | `readiness.origin.{config,env,discovery,default,unset,unknown}` | 配置 / 环境变量 / 自动发现 / 默认 / 未配置 / 未知 |
| 动作 | `readiness.action.checkGitee` | 检查 Gitee |

存活键接入（AC-9）：`readiness.public.readonly` → 「公共参数」行的 detail；`readiness.loading` → 加载态文案（`Skeleton` 旁 `role=status`，不新增 effect）；`readiness.failed` → 三源全失败时的 note（`{reason}` 取「不可达/未安装」枚举，不填原始 message）。删除：`readiness.draftWarning`（zh + en 同步删）。

> zh 与 en 的键集合必须逐字等值：用例对两个字典对象做 `Object.keys` 排序比较（现有 `client-shape` 已有同类断言，本轮把 `readiness.` 前缀单独再比一次）。

## 5. 数据模型

### 5.1 `ReadinessView`（`/api/forge-devops/cli` 的 `readiness` 字段）

```json
{
  "contract": 1,
  "at": "2026-11-07T01:20:03.114Z",
  "object": "devops",
  "revision": "9f2c1a0d4b7e5c63",
  "sourceType": "local-diagnostic",
  "plugin": { "name": "@heluo/forge-devops", "version": "0.1.0" },
  "layers": { "inherited": ["dopBin", "dopEndpoint"], "override": ["dopBin"], "missing": [] },
  "evidence": [
    { "id": "file",       "state": "pass",    "reason": null,                  "basis": "filesystem-stat" },
    { "id": "executable", "state": "pass",    "reason": null,                  "basis": "filesystem-stat" },
    { "id": "target",     "state": "pass",    "reason": null,                  "basis": "config-shape" },
    { "id": "readonly",   "state": "pass",    "reason": null,                  "basis": "policy-admission" }
  ],
  "verdict": "pass",
  "blockedBy": null,
  "reason": null
}
```

约束：`evidence` 恒 4 项且顺序等于 `EVIDENCE_LAYERS`；`pass` 项 `reason` 恒 `null`；`fail`/`not-run` 项 `reason` 必须属于 `EVIDENCE_REASONS`；`verdict/blockedBy/reason` 由 `evidence` 唯一决定（客户端校验规则：若三者与证据不一致，按证据重算并显示「未知」——防御旧服务端）。

### 5.2 客户端行模型

见 §4.1。显示约束：任何 `detail`/`next.label`/`layers.*` 只允许出现状态词、键名、来源枚举、时间、短号；`schema` 用例用正则拒绝 `[/\\]` 开头的路径片段、`@` 邮箱、`http` 串、`sk-`/`eyJ` 前缀。

## 6. 状态管理与并发

1. **读面代次**：保留 `readSeq`；`load()` 自增令牌，响应回来 `if (!mounted.current || token !== readSeq.current) return;`（现状已对，新增的「刷新中保留旧数据」不得绕过该判断）。
2. **检查代次**（新增）：`checkSeq`，`runCheck()` 开头 `const token = ++checkSeq.current`；所有 `setCheck`/`setBusy(false)` 前必须 `token === checkSeq.current && mounted.current`。旧回包晚到时**整包丢弃**（不写 evidence、不改时间、不动 busy）。
3. **busy 单一真源**：`busy` 同时门控「检查」与「刷新」；`runCheck` 的 `finally` 只在 token 匹配时清 busy，避免旧请求把新请求的忙态清掉。
4. **加载期不闪空**：首次加载 `mode: 'loading'` 渲染 Skeleton + `readiness.loading`；已有数据时的刷新用 `mode: 'refreshing'`，保留旧表 + `aria-busy="true"`；失败保留旧表并把 `readiness.failed` 写进 note。
5. **过期**：`checkStateOf(devopsRevision)` 的基准取 `reading.sources.devops.body.readiness.revision ?? body.revision`；不一致 → `stale` 但**保留** `check.evidence`/`check.at`；回到一致的 revision 不自动复活：过期态一旦发生，只有下一次「检查 DevOps」能清除（防止旧回包复活绿灯）。
6. **身份迟到回包**（AC-3）：三源并行时 `iam` 的旧响应由 `readSeq` 丢弃；断言口径是「最终只显示未登录，且 Key/CLI/写权限行与上一次渲染逐字相同」。
7. **无新计时器**：不新增 `setInterval`/`setTimeout`（保持 client 现有零定时器形态；`client-shape` 的 effect 计数不变）。

## 7. 边界与错误

| 情形 | 行为 |
|---|---|
| `/api/forge-iam/view` 404 | 身份「未安装」；Key 行同样「未安装」；其余行照常 |
| IAM 不可达（status 0） | 身份「不可达」+ 重试/账号页两个下一步；**本机配置行仍可读**（devops/gitee 各自响应独立）；IAM 写请求 0 |
| IAM 返回未列 state（含 `error`） | 身份「退出未确认」，不落回 unknown/未登录 |
| devops 快照无 `readiness` | 检查可点，结果「未知 · 未执行」并给 `NO_EVIDENCE` |
| devops 快照无 `layers` | 三层展开显示「未知 + LAYERS_UNAVAILABLE」，不拿 `origin` 冒充 |
| `?refresh=1` 429/503 | 检查「失败」，原因取 `errorCode`；不自动重试（避免重复重扫） |
| 检查中点「刷新」 | 两动作互斥（busy），后到者被无视 |
| 三源全失败 | 表内每行显示各自状态词 + 一行 `readiness.failed` note；固定声明句仍在 |
| 卸载 | cleanup 置 `mounted=false`；未完成请求自然被代次判断丢弃 |

错误文案一律来自 i18n 键；不渲染宿主 `message`、异常堆栈、文件路径或 endpoint。

## 8. 安全与脱敏

1. 身份白名单：`state`、`accessExpiresAt`（只换算成「已过期/剩余天数」文本）、`gatewayCredential.state`、`gatewayCredential.matchesAccount`、`modelAccess.state`、`error.code`。禁读/禁渲染：`principal`、`gatewayConsoleUrl`、`baseURL`、`storage` token、`authorizationUrl`、邮箱/工号。
2. 配置面白名单：`origin`、`overrides`、键名、`revision` 前 8 位、`plugin.name/version`、`host.platform`。路径只允许出现在 `DevopsSection` 的输入框值与 `title`（r15 既有约束），汇总分区永不出现。
3. 服务端：`readiness.mjs` 不读环境变量、不读 token、不 import `child_process`；`statSync` 只做存在性/形态判定，不读取文件内容。
4. 不变式（`tests/ui-contract.test.mjs` 保留）：两包 `src` 零 `spawn(`/`exec(`/`shell:true`；`packages/forge-gitee/src/gitee-cli.mjs` 仍是唯一 execFile 出口；argv 白名单、超时、1 MiB 上限、策略默认拒绝不变。
5. 文档与页面 0 处「企业联调已通过」「已向企业分发」；示例域仍用 `corp.example`/`svc-ci`。

## 9. 打包、清单与环境

- `packages/forge-devops/package.json` 的 `files` 已含 `src/`，新文件 `src/readiness.mjs` 自动入包；不改 `exports`（不对外暴露新入口）、不改 `dsh.client`（仍 `platform: web`、`immediately: true`、`inject: ["slots","locale"]`）、不改 `engines.dsh`。
- `packages/forge-gitee/package.json` 零改动（本轮不改 Gitee 客户端）。
- `.gitignore`（AC-9）：在现有条目后追加两行 `artifacts/`、`tarballs/`；既有 `node_modules/`、`.pnpm-store/`、`dist/`、`build/`、`coverage/`、`*.tgz`、`*.log`、`logs/`、`.dsh-devops/`、`.env*`、`*.pem|*.key|*.p12` 全部保留（逐行审计，不重排、不合并）。
- 不新增依赖、不升级 Node（`.node-version` 与 `package.json` 的 `engines` 不动）；`pnpm-lock.yaml` 不变。

## 10. 测试策略（先红后绿，AC-5）

### 10.1 新增测试文件

| 文件 | 归属任务 | 断言要点 |
|---|---|---|
| `packages/forge-devops/test/support/readiness-harness.mjs` | T1 | hook 运行时（`useState/useEffect/useRef` + 调度队列）、`mountReadiness({fetch, props, services})` → `{ tree, text(), find(label), click(label), flush(), calls, unmount(), props }`；`deferred()`；`loadClient({ services })` 返回 `{ module, dictionaries }`。参照 `packages/forge-iam/test/support/client-panel.mjs`（**不得跨包 import**） |
| `packages/forge-devops/test/readiness-section.test.mjs` | T1 | 客户端全部 AC-1/2/3/4/6 用例（见 10.2） |
| `packages/forge-devops/test/readiness.test.mjs` | T2 | 服务端纯函数：四层各三态、`verdict/blockedBy/reason` 一致性、`projectLayers` 只出键名、无 `policy`/无 `statSync` 的降级、`sourceType` 四枚举、`fs` 只读（注入 spy 断言只调 `statSync`） |
| `tests/host-probe-shape.test.mjs` | T1 | 探针派发形状：`{calls:[…]}` 形状必须失败/不被消费；单次 `execute({callId,name,arguments,signal})` 的返回值被原样消费（见 10.4） |

### 10.2 `readiness-section.test.mjs` 用例清单（最低覆盖，逐条可命名）

1. 七行顺序与标签；固定声明句恒在场。
2. **四组反例**（AC-1/AC-2）：①IAM 404 → 身份未安装、Key 未安装，其余五行逐字不变；②IAM 不可达 → 身份不可达 + 两个下一步，其余行不变；③IAM 返回 `error` → 「退出未确认」，不是 `unknown`/未登录；④Key 已配置但 `matchesAccount !== true` → 「已配置·未验证」，其余行不变。
3. Key 五态映射（表驱动：`unconfigured` / `configured+matches+ready` / `configured+matches+modelAccess=error` / `owner-mismatch` / 404 / `gatewayCredential` 缺失）。
4. 身份六态各有一条下一步；`unreachable` 的重试按钮真的重新发起三源读取。
5. 导航：注入 `navigate` → 只有 1 个「前往企业账号」按钮，点击收到 `'forge-iam'`；未注入 → 0 个按钮 + 文字指引 `设置 → 企业账号`。
6. 迟到 IAM 回包：先 resolve ready、再 resolve signed-out（旧 ready 最后到达）→ 最终未登录，且 Key/CLI/写权限行与前次渲染逐字相同。
7. 检查四态数据：点击「检查 DevOps」→ `fetch` 只多一次、URL 含 `?refresh=1`；响应 `verdict=pass/fail/incomplete` + 缺 `readiness` 各渲染对应状态词。
8. 四项上屏：revision 前 8 位、时间、对象「DevOps」、来源类型；`revision: null` → 「未知」。
9. 四层证据：4 行、顺序固定；`fail`/`not-run` 各带原因；`pass` 带依据；证据数组缺项 → 该层 `未执行·NO_EVIDENCE`。
10. 过期：检查通过后把 devops 快照 revision 换掉 → 标「已过期」且**保留**旧四项/旧时间。
11. 迟到检查回包：连续两次检查，旧回包最后到达 → 被丢弃，界面等于最后一次。
12. Gitee 行：禁用按钮 + 原因文本；`fetch` 调用里**没有** gitee 的第二次请求（只算初始三源）。
13. 检查写配置 0 次：整个用例里 `calls` 无 `POST`、无写方法。
14. 三层来源：devops `layers` 有值 → 三个层级与生效来源枚举；`layers` 缺失 → 「未知 + LAYERS_UNAVAILABLE」；Gitee 由 `entries.inherited/override` 投影。
15. 死键：`readiness.public.readonly`/`loading`/`failed` 在对应状态下出现在文本里；`draftWarning` 在两份字典中都不存在。
16. zh/en 键集等值（`readiness.` 前缀单独比）。
17. 未引用键计数 0：字典切片后，每个字面键在源码其余位置至少出现一次；动态前缀白名单（`readiness.state.`/`reason.`/`row.`/`evidence.reason.`/`check.sourceType.`/`layers.reason.`/`origin.`/`key.reason.`/`next.`）用模板串断言。
18. 脱敏：渲染出的文本不含 `/` 开头路径、`http`、`sk-`、`eyJ`、`@`。
19. 「企业联调已通过」在 `client.js` 出现 0 次。

### 10.3 既有用例只增不减

`packages/forge-devops/test/client-shape.test.mjs`：导出集合仍为 `['CandidateList','CliEntryField','DevopsSection','ReadinessSection','StatusLine','apply','inject']`、`inject === ['slots','locale']`、effects 仍 4 条且各有 label、两分区 `{devops:60, devops-readiness:29}`、`?refresh=1` 单处。新增：`apply` 的 `inject` 返回含 `navigate` 键（`null` 或函数）、`READINESS_ROWS` 含 `key`。
`tests/ui-contract.test.mjs`：现有断言原样保留，新增「三层键名/四项文案与 `src/readiness.mjs` 常量逐字一致」「Gitee 分区文本无请求动作」。

### 10.4 探针形状用例（AC-7）

`tests/host-probe-shape.test.mjs` 用假 `ctx.tools.execute` 直接驱动派发函数：

```js
// 期望形状：单次 exec
execute(exec) → { content:[…], isError:false }
// 断言 1：入参有 callId/name/arguments，且**没有** calls 数组
// 断言 2：返回值被直接消费；假 execute 返回 { results:[{result:…}] } 时，派发结果不得取 results[0].result
// 断言 3：两次派发得到两个不同的 callId（seq 递增），不复用
```

为可测，`scripts/probe/host-probe-plugin.mjs` 导出 `export async function dispatchTool(ctx, name, args, signal)`，三处派发点（`:88-92`、`:1043`、`:1053`）统一改调它；模块内的 `main()` 仍自增 `seq`，`dispatchTool` 接受可选 `callId` 生成器以保持既有 `probe-N` 命名。既有 `tests/host-probe.test.mjs` 的两条用例与三条断言不改（skip 仅保留既有 PATH 门控）。

### 10.5 红 → 绿留证

M1 顺序：先落 `readiness-section.test.mjs` + `support/readiness-harness.mjs` + `readiness.test.mjs` + `host-probe-shape.test.mjs`，然后运行并**原样记录**：

```sh
cd packages/forge-devops && node --test "test/readiness-section.test.mjs" "test/readiness.test.mjs"
node --test tests/host-probe-shape.test.mjs
```

交付说明写两次运行（红：失败用例数与首条失败断言；绿：pass 数、fail 0、skip 0）。红阶段允许大面积失败（模块未实现），但**不允许**为过闸删断言、放宽条件或加 `skip`。

## 11. 任务拆分（可并行；逐任务含 PRD §9 git 约束）

并行边界按**文件所有权**划分：同一文件只有一个写者。

```
G1（并行）                      G2（串行接 G1）        G3（收口）
T1 客户端测试先行(红) ──┐
T2 服务端 readiness  ───┼──► T3 client.js 实现 ──► T6 门禁与交付说明
T4 探针形状(AC-7)   ────┤
T5 文档与 .gitignore ───┘
```

| # | 任务 | 写（独占） | 读 | 依赖 | 验收 |
|---|---|---|---|---|---|
| T1 | 客户端测试先行（红） | `packages/forge-devops/test/support/readiness-harness.mjs`(新)、`packages/forge-devops/test/readiness-section.test.mjs`(新)、`tests/host-probe-shape.test.mjs`(新) | `packages/forge-devops/client.js`、`packages/forge-iam/test/support/client-panel.mjs`、`packages/forge-devops/test/client-shape.test.mjs` | 无 | 两个新用例文件能跑起来且**红**；红日志存档 |
| T2 | 服务端四层证据 + 三层投影 | `packages/forge-devops/src/readiness.mjs`(新)、`packages/forge-devops/src/cli-access.mjs`、`packages/forge-devops/src/index.mjs`、`packages/forge-devops/test/readiness.test.mjs`(新)、`packages/forge-devops/test/cli-access.test.mjs` | `packages/forge-devops/src/cli-config.mjs`、`entry-form.mjs`、`policy-guard.mjs`、`http.mjs` | 无 | `cd packages/forge-devops && node --test "test/readiness.test.mjs" "test/cli-access.test.mjs" "test/cli-http.test.mjs"` 全绿；快照新增 `readiness`/`layers` 且 entries 未新增继承值 |
| T3 | 客户端七行/导航/检查/三层/i18n | `packages/forge-devops/client.js`、`packages/forge-devops/test/client-shape.test.mjs`、`tests/ui-contract.test.mjs` | T1 用例、`packages/forge-devops/src/readiness.mjs`、`packages/forge-gitee/src/config-access.mjs` | T1（红已就位）、T2（真实字段） | `cd packages/forge-devops && node --test "test/readiness-section.test.mjs" "test/client-shape.test.mjs"` 全绿；`node --test tests/ui-contract.test.mjs` 全绿 |
| T4 | 探针单次 execute | `scripts/probe/host-probe-plugin.mjs` | `tests/host-probe.test.mjs`、`packages/forge-policy/test/support/tool-runtime.mjs` | T1（形状用例先红） | `node --test tests/host-probe-shape.test.mjs` 绿；`node --test tests/host-probe.test.mjs` 2/2；`node scripts/probe/run-host-probe.mjs` ≥31/32、0 FAIL、1 blocked（`official-rows-runtime-model-surface`） |
| T5 | 文档 15 条 + `.gitignore` | `docs/teamflow/20261106-r14-enterprise-iam-ui/DESIGN.md`、`.../TECHNICAL.md`、`docs/teamflow/20261106-r15-enterprise-iam-ui/DESIGN.md`、`.../PRD.md`、`.../ACCEPTANCE.md`、`.gitignore` | §12 表 | 无 | `node scripts/check-docs.mjs` → `docs: 0 error(s)`（exit 0）；`git diff --check` 干净 |
| T6 | 门禁与交付说明 | `docs/teamflow/20261106-r16-r15-iam-readiness-rework/ACCEPTANCE.md`(新，含 GUI 交接) | 全部 | T1～T5 | §14 全量命令；交付说明六必备项齐备 |

每个任务的**硬约束（逐字适用于 T1～T6）**：

- 工作区固定在本 worktree（`wt_622dc4710a35`，分支 `feat/plugin-workflow`）：不切分支、不新建分支、不合并、不变基、不 stash、不 `reset`、不推送、不建 tag；本轮不提交（`git commit` 属越权动作）。
- 只改「写（独占）」列出的文件；需要动别人的文件时先停下来汇报，不自行扩大范围。
- 开始与结束各跑一次 `git status --short`；`demos/`、`scripts/probe/iam-review-memory-credentials.mjs`、`scripts/lib/dsh-version.mjs`、`tests/dsh-version.test.mjs` 四项既有未提交修正原样保留，前后 `shasum -a 256` 一致（目录用 `find … -type f | sort | xargs shasum -a 256` 的合并摘要比对）。
- 不装插件、不启动/停止 GUI、不改日常 desktop profile；`heluo-r16-uat` 隔离 profile 的装载由主 agent 执行（见 §13）。
- 不新增依赖、不改 `pnpm-lock.yaml`、不升级 Node、不改 `.node-version`。
- 不删/不放宽既有断言，不新增 `skip`/`todo`；红了就修实现或如实报告。
- 不改 `AGENTS.md`、不在根目录留日志/临时文件；产物写 `logs/teamflow/tf-mw4y10xm-5q3dff/`。

## 12. 文档清理（AC-8，15 条逐条）

改法统一为**最小字面清理**：非 Markdown 目标上的 `#L…` 片段只删片段、保留链接与文字；本机绝对路径换占位。不改结论、证据、链接语义与表格列数。

| # | 文件 | 行 | 现状 | 改法 |
|---|---|---|---|---|
| 1 | `docs/teamflow/20261106-r14-enterprise-iam-ui/DESIGN.md` | 46 | 链接目标 `../../../packages/forge-devops/client.js#L72-L178` | 目标去掉 `#L72-L178` |
| 2 | 同上 | 46 | `forge-iam/client.js#L24-L133` | 去掉 `#L24-L133` |
| 3 | 同上 | 46 | `forge-devops/src/cli-config.mjs#L43-L50` | 去掉 `#L43-L50` |
| 4 | 同上 | 46 | `forge-gitee/src/runtime-config.mjs#L35` | 去掉 `#L35` |
| 5 | `docs/teamflow/20261106-r14-enterprise-iam-ui/TECHNICAL.md` | 15 | `forge-devops/src/cli-config.mjs#L43-L50` | 去掉片段 |
| 6 | 同上 | 16 | `forge-devops/src/cli-access.mjs#L282-L339` | 去掉片段 |
| 7 | 同上 | 17 | `forge-devops/src/http.mjs#L268-L276` | 去掉片段 |
| 8 | 同上 | 17 | `forge-devops/src/index.mjs#L395-L398` | 去掉片段 |
| 9 | 同上 | 19 | `forge-gitee/src/gitee-cli.mjs#L11-L19` | 去掉片段 |
| 10 | 同上 | 20 | `forge-iam/src/state.mjs#L111-L126` | 去掉片段 |
| 11 | 同上 | 20 | `forge-iam/src/service.mjs#L248-L262` | 去掉片段 |
| 12 | 同上 | 21 | `forge-iam/client.js#L4028-L4048` | 去掉片段 |
| 13 | `docs/teamflow/20261106-r15-enterprise-iam-ui/DESIGN.md` | 8 | 链接目标 `../../../packages/forge-devops/client.js#L72-L178`（链接文字「client.js 度量与样式」） | 去掉 `#L72-L178` |
| 14 | `docs/teamflow/20261106-r15-enterprise-iam-ui/PRD.md` | 22 | `本机：`DSH_HOME=<本机绝对路径>`` | 改为 `DSH_HOME=<profile 根目录>`，其余描述不动 |
| 15 | `docs/teamflow/20261106-r15-enterprise-iam-ui/ACCEPTANCE.md` | 70 | 条目复述同一串本机绝对路径 | 同样改为 `DSH_HOME=<profile 根目录>`，保留「违反仓库约定」的判断 |

- 规则依据：`scripts/lib/doc-rules.mjs`（非 `.md` 目标带片段即 error；含本机用户目录前缀的绝对路径即 host-specific 错误）；`docs/teamflow/**` 非受控文档，不需要元数据键。
- r16 自身文档（本文件与 `ACCEPTANCE.md`）必须 0 条新增：不写本机用户目录的绝对路径、不给非 md 目标加片段、示例用 `corp.example`/`svc-ci`。
- `tests/check-docs.test.mjs` 未硬编码错误条数（实读确认），清理不会打破既有断言。

## 13. 风险、NOT RUN 与未核验

**NOT RUN（本轮不执行，交付说明逐项写命令、期望证据与原因）**

1. 真实企业 IAM 联调（登录/退出/过期/主体匹配）：需企业 IdP 与账号，本机无凭据。
2. 生产网关 Key 验证：不写、不读真实 token；`matchesAccount` 只由既有视图给出。
3. 企业 `dop` 只读探测（`change.read` 实跑）：需已批准策略与企业 CLI；本轮「只读可访问」仅到策略准入。
4. Windows 与麒麟 aarch64 双端实机：无环境；POSIX/win32 分支仅静态与单测覆盖。
5. 真实浏览器 DOM/Network 证据（截图、`aria` 树、Network 面板）：由主 agent 在隔离 profile 完成。
6. 打包 tarball 的真实 GUI 装载与回滚：交主 agent（建议 `--profile heluo-r16-uat`），本轮只写交接步骤与判据。
7. 宿主 `settings.section` 分区切换公开 API：**未核验**（asar 反查无果，见 §4.4）。因此导航只做能力探测 + 文字降级；若主 agent 装载后发现宿主提供了别的通道名，只需在 `NAV_METHODS` 加一项，不改行模型。

**风险与对策**

| 风险 | 影响 | 对策 |
|---|---|---|
| 宿主根本不暴露分区切换 | AC-1 只剩文字指引 | 已内置降级分支并有用例；UI 不出现无响应按钮，验收不接受「假按钮」 |
| `statSync` 在只读/受限 FS 抛错 | 证据恒 `fail`/`not-run` | 全部 try/catch 后落 `not-run` + `NO_EVIDENCE`，不抛到 HTTP |
| 新字段打破既有快照深比较用例 | 门禁红 | 只增键；受影响用例逐条补键（只增不减），不删断言 |
| `readiness` 计算影响 GET 时延 | 页面首屏变慢 | 一次 `statSync` + 一次 `admit`，无 IO 聚合、无子进程；同一响应内只算一次 |
| 时钟/时区导致时间断言不稳 | 用例抖动 | 服务端 `now` 可注入；客户端格式化接受固定 ISO 输入，断言用切片而非本地时区 |
| Gitee/DevOps 三层形状不一致 | 文案分叉 | 客户端统一投影成同一个 `layers` 形状；差异在 §3.2 显式记录，不改 Gitee 服务端 |

## 14. 验证命令与交付物

```sh
# 单元（分包）
cd packages/forge-devops && node --test "test/*.test.mjs"        # ≥404 pass，新增文件计入
cd packages/forge-gitee  && node --test "test/*.test.mjs"        # ≥259 pass（不回退）
node --test tests/ui-contract.test.mjs                            # ≥6 pass（只增不减）
node --test tests/host-probe.test.mjs                             # 2/2
node --test tests/host-probe-shape.test.mjs                       # 新增，全绿
node scripts/probe/run-host-probe.mjs                             # ≥31/32 checks passed，0 FAIL，1 blocked
# 门禁
node scripts/check-docs.mjs                                       # docs: 0 error(s)
pnpm check                                                        # exit 0；node --test 总数 ≥2783、失败 0、新增 skip 0
git diff --check                                                  # 干净
git status --short                                                # 无 *.tgz / dist/ / logs/ / artifacts/
```

交付物：

1. 本设计（`docs/teamflow/20261106-r16-r15-iam-readiness-rework/TECHNICAL.md`）。
2. 代码与用例（§11 的 T1～T5）。
3. `docs/teamflow/20261106-r16-r15-iam-readiness-rework/ACCEPTANCE.md`：红→绿两次运行、15 条逐条处置、31/32 + 1 blocked 的名称与原因、NOT RUN 清单与命令、GUI 交接步骤与判据、四项未提交修正的 `sha256` 前后对比、最终 `git diff --stat`。

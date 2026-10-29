# TECHNICAL.md — CLI 路径自动发现与配置页（r3）

> 阶段：技术方案（tech）｜分支：`feat/devops-change-flow`｜依据：同目录 `PRD.md`（15 条 AC）、`DESIGN.md`（407 行）
> 代码基线：`packages/forge-devops`（334 行 `src/index.mjs` + 5 个模块 + 6 个用例文件）
> 宿主基线：本机已装 `0.2.1-rc.2`（位于 npx 缓存里的 `@deepseek-ai/dsh` 包，只读核验，不写宿主绝对路径）；目标 `0.2.1-rc.3` **NOT RUN**
> 本文只写实现口径；未实测项一律标 NOT RUN，不写成已验证。

## 0. 结论与三处偏离（先看这一节）

**要做的事**：把「CLI 在不在、在哪」从用户的环境配置任务改成插件自己的责任——装配期自动发现（只认可直接执行的入口）、Web 配置页只读展示 + 可覆盖、三层优先级「配置 > 环境变量 > 自动发现」、找不到仍 fail closed 但把提示从「环境变量名」改成「类别名 + 配置页指引」。

**技术主线**（四层，逐层可单测）：

```
装配期/刷新          ┌ src/cli-discovery.mjs   只读文件系统，零子进程，有界扫描
   有界发现   ──────▶│
                     ├ src/cli-config.mjs      三层合并 + origin + 逐字段校验 + 脱敏描述
   host 状态  ──────▶├ src/cli-access.mjs      装配期快照 / 刷新 / 保存（config-editor 适配）
   HTTP 契约  ──────▶├ src/http.mjs            同源 GET/POST，框架无关，可离线测
   页面        ──────▶└ client.js               settings.section 页（自实现组件，宿主度量）
```

**偏离 1（关键）：写配置走 `dsh-config-editor`，不走 `dsh-settings` 表单面。**
证据：表单面只展示「`Config` schema 带 `toJSON()`」的条目——`dsh-settings/lib/index.js:538-541`（`schema(entry)` 仅当 `'toJSON' in schema`），且字段必须位于 `volatile` 节点下（同文件 `volatileForm` / `isVolatilePath`），官方插件因此写 `z.string().volatile()`（`dsh-web-search-deepseek/lib/index.js:278-284`）。那需要 `@deepseek-ai/schemastery`；本仓库 `node_modules` 为空、安装清单由构建期闭包（`scripts/build-enterprise-bundle.mjs`，不许 `workspace:`/未声明外部依赖），企业内网也无 registry——**为了一个表单面引入一个装不上的依赖，会把 AC-8 从"可验证"变成"碰运气"**。
`config-editor` 的 `edit(entry, change)`（`dsh-config-editor/lib/index.js:69-135`）已实现我们需要的三件事：YAML 注释保留的补丁写入（`parseDocument`，注释不丢）、原子写（`writeFileAtomic(..., mode 384)`）、失败回滚（reconcile 失败写回 `before`），并在成功后只对该条目做 Loader 调和（热生效）。它只要求 `Config['~standard'].validate`（cordis `resolveConfig`：无 `Config` 时原样返回），不再要求 `toJSON`/`volatile`。
代价与替代：失去 `settings.update` 自带的 revision 栅栏 → 本方案自算 revision（§2.5）并写后回读校验；失去「六态表单 UI 组件」→ 自实现（偏离 3）。

**偏离 2：页面数据通道 = 同源只读路由（新增 `/api/forge-devops`），不用 `configForms` remote。**
`configForms` 的读也源自 `settings.describe()`，同样受偏离 1 的 schema 约束；而发现结果（命中路径、候选数）本就不是配置值，天然属于服务端事实。路由限定同源、`cache-control: no-store`、写操作要求 `x-forge-devops-request: 1`（沿 `packages/forge-iam` 的 CSRF 风格：`packages/forge-iam/client.js:7`）。
**未核验**：企业 profile 里 `/api/*` 的连接层鉴权细节；本次只做同源 + 预检头 + 不回写日志三重收敛，不外推为"已鉴权"。

**偏离 3：宿主表单组件不可复用，按 DESIGN 度量自实现。**
`dsh-client-ui-settings` 的客户端模块只导出 `apply` / `inject`（`lib/client.js` 尾部），`SettingsForm` / `SettingsValueField` / `SettingsFormModel` 不是可 require 的契约面；`@deepseek-ai/dsh-client-ui-primitives` 在本机 node_modules **没有包清单**（只是 shell 种子模块，无类型无 README）。依赖一个无契约的种子模块违反 AGENTS.md §4「技术方案纪律」→ 自实现 4 个组件，度量逐项抄 DESIGN §1（label 13/500、input 34px、hint 12/18、field padding 12px 0、相邻 `.5px border-l2`）、颜色只取 `--dsw-*` token。

> DESIGN 留给技术阶段的两件事在此定形：**数据通道** = 偏离 2 的路由；**客户端入口与文案落点** = 包根 `client.js`（单文件，`require('react')`）+ 内联双语字典（`ctx.locale.register('devops', { zh, en })`，与 `dsh-client-ui-settings-models/lib/client.js:4437-4444` 同法），不新建 `locale/` 目录（`packages/forge-iam/locale/*.json` 未被其 client 使用，不能作为「宿主会读 json」的证据）。

## 1. 现状事实（决定改哪里）

**现有代码（`packages/forge-devops`）**

| 位置 | 事实 | 本需求影响 |
|---|---|---|
| `src/runtime-config.mjs` | 六键 `ENV_KEYS`、`CONFIG_REASONS`、`SOURCE_TYPES`、`DEFAULT_GH_BIN='gh'`、`DEFAULT_TIMEOUT_MS=20000`、`OWNER_PATTERN`；`resolveRuntimeConfig(env)` / `describeRuntimeConfig()` | 环境变量层与 loader 直接复用其字段校验；新增 `validateConfigField`、`ConfigStandard`。**页面半不能 import 服务端模块**：`client.js` 内联的是等值副本，等值性由 `test/client-rule-parity.test.mjs` 的跨面矩阵用例守护（不是"共用同一实现"） |
| `src/flow.mjs:68-82` | `normalizeResolution(config, env)`：显式 config 优先，否则 env，否则 `CONFIG_MISSING`；注释写明"不读 PATH（AC-22）" | 由 `cli-config` 产出合并后的显式 config 传入，该函数不改语义 |
| `src/flow.mjs:100-113` | `createDevopsReader({ ports, reason })`，`ports===null` 抛 `DevopsReadError(reason, '运行时配置不可用（…）')` | 改为接受结构化 `unavailable`（含 `code/reason/searched/guidance`），文案换成配置页指引 |
| `src/read.mjs:29-54` | `READ_REASONS` 白名单 + `DevopsReadError(code,message,detail)` | 不新增 reason 码（AC-14 零回退）：仍抛 `NO_READER`，细因放 `detail.reason` |
| `src/tools.mjs:56-89` | `NEXT_ACTION` 已含 `NO_READER → configure-reader`；`failure()` 把 `error.message` 塞 `detail` | 不改 `tools.mjs`；文案由 `flow` 传入的 message 决定 |
| `src/index.mjs:105-146,309-321` | `validateConfig` 拒未知键；`apply` 做 policy→flow→service→`ctx.provide`→工具→命令面 | 加 `Config` 导出、access 状态、路由注册；工具面仍是 9 个 |
| `cordis.patch.yml:40` | 注释「路径、endpoint、凭据一律由环境注入（AC-22）」 | 改口径（AC-12） |
| `README.md:44-51` | 六行 `FORGE_DEVOPS_*` 配置表 | 改「配置页优先、环境变量兜底」 |
| `test/delivery-selfcheck.test.mjs:240-245` | 已有全仓 `shell: true` 扫描 | 就地扩展（`cli-discovery` 零 `child_process`、client 不打印路径），**不新建检查器** |
| `test/config.test.mjs` | 表驱动、断言 `ENV_KEYS` 顺序与「不回显路径」 | 追加 schema 与三层优先级用例 |

**宿主角（rc.2 实读，只读核验）**：`ctx.configEditor.{documentPath, entries(), configuration(), edit(entry, change)}`（`dsh-config-editor/lib/index.js`）；`ctx.webServer.register({kind:'exact'|'prefix', path, handler})`（`dsh-host-webserver/lib/types/index.d.ts:31-174`，重复 `(kind,path)` 抛错）；`ctx.locale.register(ns, dicts)` / `bind(ns)`（`dsh-client-locale/lib/types/client/index.d.ts:199-226`）；client 模块用 `window.__ModuleLoader__.load({id, factory(require)})`，`dsh.client` 声明字段 `platform/immediately/inject/external`。
**宿主工作区事实**：`packages/forge-devops` 当前**没有** `Config` 导出、没有 `dsh.client`、`files` 白名单不含 client。

## 2. 数据模型与存储

### 2.1 三层解析（逐字段，`src/cli-config.mjs`）

| 字段 | 层序 | 终值 | 说明 |
|---|---|---|---|
| `dopBin` | config → env → discovered | 无（`missing`） | 未命中即 fail closed，**不猜默认值** |
| `ghBin` | config → env → discovered → `default` | `'gh'`（PATH 名） | 沿用 `DEFAULT_GH_BIN`；`default` 只表示"基线缺省"，不是新层 |
| `dopEndpoint` | config → env | 无 | 只做校验，不做发现（PRD 非目标） |
| `ghOwner` | config → env | 无 | `OWNER_PATTERN` 校验 |
| `sourceType` | config → env → `default` | `'mock'` | 段控件只在页面强约束，配置层仍收 `mock`/`enterprise` |
| `timeoutMs` | config → env → `default` | `20000` | 1000–600000 |

`origin` 枚举（AC-3 的四个值全部保留，另加一个终值类）：`config` | `env` | `discovered` | `default` | `missing`。
> `default` 是**终值**而非第四层：只有 `ghBin`/`sourceType`/`timeoutMs` 的基线缺省会出现，`dopBin` 永不出现 `default`（fail closed 不被默认值掩盖）。页面把 `default` 与 `missing` 都算"未由你指定"，但不显示成错误。

### 2.2 Discovery（`src/cli-discovery.mjs` 输出，仅主机内）

```js
Discovery = {
  tool: 'dop' | 'gh',
  found: [{ path: 'D:\\app\\dop.exe', tier: 'PATH' | 'candidate-dir' }], // 按 tier、path 升序
  rejected: [{ path: '…\\dop.cmd', why: 'wrapper-script' }],              // 只用于提示，不参与解析
  searched: ['PATH', 'candidate-dirs'],
  scannedDirs: 12, truncated: false, elapsedMs: 41
}
```

### 2.3 Access（合并结果，主机内；含路径）

```js
Access = {
  ready: true, reason: null,                    // null | 'CLI_NOT_FOUND' | 'CLI_CONFIG_INVALID'
  entries: { dopBin: { origin, value, tool }, ghBin: {…}, dopEndpoint: {…}, ghOwner: {…}, sourceType: {…}, timeoutMs: {…} },
  value: { dopBin, dopEndpoint, ghBin, ghOwner, sourceType, timeoutMs } | null, // null = 不 ready
  invalid: [], searched: ['config', 'env', 'PATH', 'candidate-dirs'], guidance: '…'
}
```

### 2.4 Snapshot（给页面，含路径，**只经 GET 出网**）

```js
CliSnapshot = {
  revision: '9f3c1d2a0b7e4c61',                  // §2.5
  writable: { ok: true, documentPath: false },    // documentPath 不外泄，只给布尔
  ready, reason, guidance,
  entries: {
    dopBin: { origin, path: '…dop.exe' | null, tool: 'dop', candidates: [{ path, tier }], rejected: [{ path, why }] },
    ghBin:  { … },
    dopEndpoint: { origin, value: null },         // endpoint 值是用户自己填的，页面要能回显
    ghOwner: { origin, value }, sourceType: { origin, value }, timeoutMs: { origin, value }
  },
  host: { platform: 'win32', arch: 'x64', node: 'v24.13.0' }
}
```

### 2.5 revision（替代 `settings.update` 的栅栏）

`revision = sha256(JSON.stringify(userLayerFor(entryId) ?? {}))` 取前 16 位十六进制；`userLayer` 来自 `configEditor.configuration()` 中本条目 `override`。
保存时：请求带 `revision` → 现算 → 不等直接 409 `CLI_CONFIG_CONFLICT`，**不写盘**；写入成功后重算并返回新 revision（写后回读，才敢说"已保存"）。

### 2.6 存储形态（AC-8 / AC-15）

只写宿主 `configEditor.documentPath`（活动 profile 补丁 YAML），形如：

```yaml
- id: forge-devops            # 与 cordis.patch.yml 的 insert name 同源
  name: forge-devops
  config:
    dopBin: 'C:\Program Files\heluo\dop.exe'
    sourceType: enterprise
```

- 未改动的字段**不写**（等值噪声禁令，AC-7）；某字段选择「重置为自动发现」= 从 `config` 里删除该键，回落下一层（AC-3/AC-15）。
- 用户层清空后 `next` 与 `inherited` 深等 → `config-editor` 自己删掉整段 `config`（源码已如此实现）→ 回到"未配置即自动发现"，无残留。
- **不写**任何缓存/临时文件（发现结果只在内存），因此运行插件不会让 `git status` 多出文件（PRD §10）。
- endpoint 值同样只落在 profile 补丁（不入仓库、不进日志）。

## 3. 接口设计

### 3.1 HTTP（`src/http.mjs`，前缀 `/api/forge-devops`）

| 方法/路径 | 请求 | 成功响应 | 失败 |
|---|---|---|---|
| `GET /api/forge-devops/cli` | 无查询参数 = 返回装配期快照；`?refresh=1` = 重新做一次有界发现 | `200 CliSnapshot` | `404`（路由未注册时由宿主给）/`405` |
| `POST /api/forge-devops/cli` | 头 `x-forge-devops-request: 1`、`content-type: application/json`；体 `{ revision, fields: { <六个 camelCase 键之一>: string \| number \| null } }`，`null` = 清除该键（回落） | `200 { ok: true, snapshot: CliSnapshot }` | `422 CLI_CONFIG_INVALID` `{ errors: { field: '…' } }`；`409 CLI_CONFIG_CONFLICT`；`503 CLI_CONFIG_UNAVAILABLE`（profile 无可写条目）；`400 BAD_REQUEST`（非 JSON/未知键/缺头） |

统一错误体：`{ ok:false, code, message, errors?: { <field>: string } }`。全部响应 `cache-control: no-store`，不设 CORS 头；**任何响应都不进日志**（路径回显只到页面，AC-10）。
GET 的路径回显边界：仅同源页面可用 + 预检头 + no-store；`service.cliStatus()`（工具/状态面）走脱敏描述，二者在代码上是两个函数，防止"顺手复用"。

### 3.2 模块 API（verbatim，实现即此名）

**`src/cli-discovery.mjs`**
```js
export const WRAPPER_SUFFIXES = ['.cmd', '.bat', '.ps1', '.com', '.vbs']   // AC-2：一律不选
export const DISCOVERY_TIERS = ['PATH', 'candidate-dir']
export function candidateExecutableNames(tool, platform)                    // win32 → ['dop.exe']；其它 → ['dop']
export function parsePathVar({ env, platform, pathModule })                 // → string[]（去空项/去重，win32 大小写不敏感）
export function candidateDirs({ platform, env })                            // → [{ dir, tier:'candidate-dir' }]
export function isDirectlyExecutable({ path, platform, stat })              // win32: .exe 且 isFile；posix: 任一执行位
export function discoverTool({ tool, platform, env, fs, now, maxCandidates = 200, deadlineMs = 250 }) // → Discovery
export function discoverCli({ platform, env, fs, now, tools = ['dop', 'gh'], maxCandidates, deadlineMs }) // → { dop, gh }
```
`fs` 只注入同步面：`{ statSync, readdirSync }`（测试用假实现，零 IO）。**本模块不得出现 `child_process`**（AC-2，静态用例守）。

**`src/cli-config.mjs`**
```js
export const CLI_FIELDS = ['dopBin','dopEndpoint','ghBin','ghOwner','sourceType','timeoutMs']
export const CLI_ORIGINS = { CONFIG:'config', ENV:'env', DISCOVERED:'discovered', DEFAULT:'default', MISSING:'missing' }
export const CLI_REASONS = { NOT_FOUND:'CLI_NOT_FOUND', INVALID:'CLI_CONFIG_INVALID', CONFLICT:'CLI_CONFIG_CONFLICT', UNAVAILABLE:'CLI_CONFIG_UNAVAILABLE' }
export function resolveCliAccess({ config, env, discovery, platform })      // → Access
export function describeCliAccess(access)                                   // → 脱敏：无 path / 无 endpoint 值
export function validateCliField({ field, value, platform, fs })            // → { ok:true, value } | { ok:false, message }
export function buildCliPatch({ current, patch, platform, fs })             // → { ok:true, next } | { ok:false, errors }
export function cliGuidance(access)                                         // → 页面/工具共用的类别名 + 指引句
```

**`src/cli-access.mjs`**（host 适配，唯一知道 `configEditor` 的模块）
```js
export function createCliAccess({ config, env, platform, fs, now, configEditor = null, entryId = 'forge-devops' })
// → { entryId, revision(), snapshot({ refresh } = {}), describe(), save({ revision, fields }) }
//   save → { ok:true, snapshot } | { ok:false, code, errors? }
```

**`src/http.mjs`**
```js
export const CLI_API_PREFIX = '/api/forge-devops'
export const CLI_REQUEST_HEADER = 'x-forge-devops-request'
export function createCliApi({ access, now })          // → { handleGet({ query }), handlePost({ headers, rawBody }) }
export function toNodeRoute(api)                       // → (req, res) => Promise<void>
```

**`src/runtime-config.mjs`（增量）**
```js
export function validateConfigField(field, value)      // → { ok:true, value } | { ok:false, message }
export const ConfigStandard = Object.freeze({ '~standard': { version: 1, vendor: 'heluo', validate } })
```

**`src/index.mjs`（增量）**
```js
export const Config = ConfigStandard                   // 只给 loader/config-editor 校验，不含 toJSON（不走表单面）
// service 增量：cliStatus() / cliSnapshot({ refresh }) / saveCliConfig({ revision, fields }) / rediscover()
// reader 失败信封：new DevopsReadError('NO_READER', cliGuidance(access), { reason:'CLI_NOT_FOUND', searched, next: 'settings → DevOps 变更流程' })
```

**`src/flow.mjs`（增量，保持向后兼容）**
```js
createDevopsFlow({ …, unavailable = null })   // unavailable: { code:'NO_READER', message, detail } | null
createDevopsReader({ ports, reason = …, unavailable = null })  // unavailable 优先于 reason
```

## 4. 前端：`client.js`（包根，单文件）

````js
window.__ModuleLoader__.load({
  id: '@heluo/forge-devops',
  factory: (require) => {
    const React = require('react');
    const inject = ['slots', 'locale'];
    const NS = 'devops';
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'forge-devops: copy');
      const t = ctx.locale.bind(NS);
      ctx.slots.register({ name: 'settings.section', id: 'devops', order: 60, label: () => t('nav') }, (props) => React.createElement(DevopsSection, { ...props, t }));
    }
    return { apply, inject };   // ModuleLoader 约定：factory 返回 exports
  },
});
````

**组件树**：`DevopsSection`（数据获取 + 保存编排）→ `StatusLine`（`role="status" aria-live="polite"`）、`CliEntryField`×2（只读/编辑二态 + origin `Tag` + 文本动作 + `CandidateList`）、4 个文本字段（`dopEndpoint`/`ghOwner`/`sourceType`(段控件)/`timeoutMs`）、页脚保存。
**页面状态机**：`loading → ready | unavailable`；`ready` 内 `idle → checking（?refresh=1）→ idle`、`idle → saving → idle | conflict | invalid | failed`。
`conflict`：显示「配置已在别处修改」+「刷新」动作，保留用户 staged 值但标 `stale`（不清空，避免用户白填）。
**交互红线**（照 DESIGN §4）：只读态 `readonly`（可聚焦/全选/复制，不可编辑）；「改为手动指定」预填当前生效值；「重置为自动发现」= 置 `null` + 标记 dirty；`blur` 逐字段校验、全量校验在保存前；`dirty=false` 时保存 disabled；`Enter` 不触发保存；焦点移到第一个非法字段。
**文案**（内联双语，key 固定）：`nav`/`title`/`intro`/`status.ready`/`status.missing`/`status.checking`/`status.unchanged`/`field.dopBin`/`field.ghBin`/`field.dopEndpoint`/`field.ghOwner`/`field.sourceType`/`field.timeoutMs`/`hint.*`/`action.rediscover`/`action.manual`/`action.reset`/`action.save`/`action.refresh`/`error.*`。中文为主、英文对齐；**hint 里不出现环境变量名**（环境变量只作次级说明一句话，AC-5/AG-3）。
**样式**：只引用 `--dsw-*` token（radius 8/12、focus-ring 2px、label primary/secondary/tertiary、border-l2/l4、interactive-bg-hover、state-business/success/warn/error）；度量照 DESIGN §1/§5；`prefers-reduced-motion` 下关闭过渡。
**安全**：无 `innerHTML`/`dangerouslySetInnerHTML`；路径只进输入框的值与 `title`；不写 `console.*`、不拼进 URL、不放 `data-*` 之外的 DOM（静态用例守）。

## 5. 状态管理

**主机侧**（`src/cli-access.mjs`，单实例，随 `apply` 建立）：

```js
let access = resolveCliAccess({ config, env, discovery: discoverCli({...}) });  // 装配期一次
snapshot({ refresh })  → refresh ? (access = 重新发现 + 重新合并) : access；返回 CliSnapshot（现算 revision）
save({ revision: expect, fields }) →
  1. 现算 revision ≠ expect            → { ok:false, code:'CLI_CONFIG_CONFLICT' }
  2. configEditor 缺失 / 无本条目       → { ok:false, code:'CLI_CONFIG_UNAVAILABLE' }
  3. buildCliPatch({ current: userLayer, patch: fields }) 失败 → { ok:false, code:'CLI_CONFIG_INVALID', errors }
  4. await configEditor.edit(entry, () => next)   // 注释保留 + 原子写 + 失败回滚
  5. 重新读 configuration() → 重算 revision → 若与预期写入不符 → { ok:false, code:'CLI_CONFIG_UNAVAILABLE' }（写后回读）
  6. 重新合并（不重扫发现，AC-4）→ { ok:true, snapshot }
```
`service.status()` 仍返回 `'no-reader' | 'ready'`（不变），新增 `service.cliStatus()` 给脱敏描述（供报告/状态面）。

**页面侧**：单个 `useState` 快照 + 一个 `useReducer`（staged 值、逐字段错误、阶段）。保存成功整体替换快照并清空 staged；保存失败保留 staged。

## 6. 关键实现点与边界

1. **发现时机**（AC-4）：只在 `apply` 与 `GET ?refresh=1` 执行；任何工具调用都不触发（`read` 路径不 import `cli-discovery`）。
2. **只认可直接执行**（AC-2）：win32 只认 `.exe`（大小写不敏感）+ `isFile`；POSIX 认具执行位。`.cmd/.bat/.ps1/.com/.vbs` 命中即记 `rejected: wrapper-script`（页面提示"包装脚本不能被执行"，不参与解析）。**零子进程**：模块只依赖注入的 `statSync/readdirSync`；静态用例禁止出现 `child_process`。
3. **PATH 解析**：`path.delimiter` 分割、去 `"`、展开 `%VAR%`（win32）与 `$VAR`（posix，仅 `env` 内已定义者）、去空项、win32 大小写不敏感去重；不做通配与递归。
4. **候选目录表**（数据驱动，`candidateDirs()`）：win32 = `%ProgramFiles%\<tool>`、`%ProgramFiles(x86)%\<tool>`、`%ProgramFiles%\heluo`、`%LOCALAPPDATA%\Programs\<tool>`、`%USERPROFILE%\.<tool>\bin`；posix = `/usr/local/bin`、`/opt/<tool>/bin`。**F2 未决**：清单只是兜底，覆盖不足由页面手动指定弥补，文档写明这一点。
5. **预算**（AC-4）：最多 200 个目录、`deadlineMs=250`（`now` 注入，用例用假时钟断言"到点即停"）；单目录 `readdirSync` 抛错吞掉并计入 `skippedDirs`；超出上限置 `truncated=true` 并如实声明"未扫描完"。
6. **fail closed 与提示改写**（AC-5/AG-3）：`dopBin` 未命中 → `ready=false`、`reason='CLI_NOT_FOUND'`、`searched` 给类别词（`config/env/PATH/candidate-dirs`），`guidance` 为「在 Web 界面『设置 → DevOps 变更流程』里指定 dop 路径」；环境变量只在次级说明出现一句「CI 场景可继续用环境变量」。工具失败信封 `NO_READER` + `detail.reason='CLI_NOT_FOUND'`，`detail` 内**不含绝对路径与 endpoint**。
7. **只读展示与覆盖**（AC-7）：`origin!=='config'` 时输入框 `readonly`，head 显示 origin `Tag`；用户改手动指定后才可编辑；清空保存 = 回落；配置压过环境变量时额外 `Tag`「覆盖环境变量」。
8. **等值噪声**：保存前把 `fields` 与当前用户层逐键比较，等值键不写；全等 → 直接返回快照（不调 `edit`）。
9. **并发/陈旧**（AC-9）：revision 比较（§2.5）+ 写后回读；`config-editor` 自身有文件锁与"条目被替换"检测，二者叠加。
10. **回显边界**（AC-10）：路径/endpoint 只出现在 `GET` 响应体与页面 DOM；工具输出、`cliStatus()`、报告、日志一律用 `describeCliAccess()`（只有 origin/布尔/计数）。检查手段：静态用例扫 `src/**` 是否把 `access.entries.*.value` 拼进 `DevopsReadError.detail`；人工对文档跑正则（盘符/`https?://` 示例）。
11. **重启生效**（AC-8）：值落 profile 补丁 → 重启宿主后 `apply` 读到的 `config` 即含该值；`config-editor` 写入后还会对该条目热调和（无需重启进程即可生效）。**未验**：企业 profile 是否允许写（`CLI_CONFIG_UNAVAILABLE` 路径需实机确认）。
12. **Windows 路径细节**：UNC（`\\server\share\…`）、含空格、中文目录、盘符大小写（`c:\`/`C:\` 视为同一）、长路径前缀 `\\?\`；`dopEndpoint` 仍拒内嵌凭据（沿用现有校验）。

## 7. AC → 实现 → 验证

| AC | 实现落点 | 验证方式 |
|---|---|---|
| AC-1 零配置 ready | `discoverCli` + `resolveCliAccess`（装配期） | 假 fs 夹具：PATH 有 `dop.exe`、配置为空 → `ready=true`、origin=`discovered` |
| AC-2 只认可执行入口 | `isDirectlyExecutable` + `WRAPPER_SUFFIXES` + 零子进程 | 夹具：目录只有 `dop.cmd` → `found=[]`、`rejected` 含 `wrapper-script`；静态用例断言无 `child_process` |
| AC-3 三层与 origin | `resolveCliAccess` | 3×3 组合矩阵用例（config/env/discovered 各压一层）+ 页面 Tag 断言 |
| AC-4 发现成本有界 | `maxCandidates`/`deadlineMs`/`truncated` | 假时钟与假 fs 计数：≤200 目录、到点即停；`read` 路径不 import 发现模块 |
| AC-5 fail closed 提示 | `cliGuidance` + `flow` 的 `unavailable` | 未命中 → 工具信封 `NO_READER` + `detail.reason='CLI_NOT_FOUND'`，正则断言无盘符/`http` |
| AC-6 可达与一屏 | `settings.section` id/order + 自实现组件度量 | client 静态断言（slot id/order、单页、6 字段）；几何靠截图（QA） |
| AC-7 页面即状态 | Snapshot 的 `entries[].origin/path/candidates` + client 只读态 | client 静态断言 + 契约用例（origin=config 才 editable） |
| AC-8 保存即持久 | `config-editor.edit` + 写后回读 | 假 configEditor 断言写入 `next` 与再读一致；重启效果 NOT RUN（需宿主实机） |
| AC-9 非法值逐字段拒 | `validateCliField`/`buildCliPatch` + 409 | 表驱动 12 条非法值 → 每字段独立 `errors`；revision 不符 → 不调 `edit` |
| AC-10 回显边界 | `describeCliAccess` + 路由 no-store + 静态扫描 | 静态用例：工具面源码不出现 `entries.*.value`；文档正则零命中 |
| AC-11 环境变量仍可用 | 三层里 env 居第二 | config 为空、env 有值 → origin=`env`、`ready=true` |
| AC-12 文档口径 | README + `cordis.patch.yml:40` | diff 评审（页面步骤 + 环境变量降为兜底） |
| AC-13 证据纪律 | 本文 §9 NOT RUN 清单 | 验收时逐条对照 |
| AC-14 零回退 | 工具面 9 个不变、`READ_REASONS` 不加码、`normalizeResolution` 不改 | `test/tools` 现有用例全绿 + 新增"工具数=9"断言 |
| AC-15 可回滚 | 重置 = 删键；全空 = 删整段 `config` | 假 configEditor 断言 `next` 与 inherited 深等时走删除路径 |

## 8. 任务拆分（按文件边界，可并行）

> 无 `[PIPELINE-DISPATCHED TASKS]`，以下为本次拆分。并行前提：文件集合不相交；§3.2 的 API 名**逐字**落地（改名即 P1 缺陷）。

| # | 任务 | files（独占写入） | reads | 验收 |
|---|---|---|---|---|
| T1 | 有界 CLI 发现 | `src/cli-discovery.mjs`、`test/cli-discovery.test.mjs` | `src/runtime-config.mjs` | 11 条用例：win32/posix 名字表、`.cmd` 拒绝、执行位、PATH 去重/展开、200 上限、假时钟截止、`discoverCli` 汇总、零 `child_process` |
| T2 | 三层合并 + 字段校验 + 脱敏描述 | `src/cli-config.mjs`、`src/runtime-config.mjs`、`test/cli-config.test.mjs`、`test/config.test.mjs`（追加） | `src/runtime-config.mjs` 原函数、`src/read.mjs` | 优先级矩阵、`default/missing` 语义、脱敏零命中、12 条非法值、`ConfigStandard` 校验 |
| T3 | host 适配 + HTTP 契约 | `src/cli-access.mjs`、`src/http.mjs`、`test/cli-access.test.mjs`、`test/cli-http.test.mjs` | `src/cli-config.mjs`、`src/cli-discovery.mjs` | 快照/刷新/revision/保存四路径；GET/POST 状态码矩阵（200/400/409/422/503）、CSRF 头缺失拒绝、no-store |
| T4 | 插件装配与失败文案 | `src/index.mjs`、`src/flow.mjs`、`package.json`、`cordis.patch.yml`、`test/wiring.test.mjs` | T1–T3 的导出、`src/tools.mjs`、`src/read.mjs` | `apply` 装配 access/service/路由；`Config` 导出生效；未命中 → `NO_READER`+`CLI_NOT_FOUND` 文案含页面指引且无路径；工具数仍 9；`dsh.client` 声明与 `./client` 导出就位 |
| T5 | 配置页客户端 | `client.js`、`test/client-shape.test.mjs` | §3.1 契约、`DESIGN.md §3/§5`、`packages/forge-iam/client.js`（风格） | ModuleLoader id/inject、`settings.section` id/order、两个 fetch 端点、CSRF 头、双语字典键齐全、无 `innerHTML`/无 `console`、只读态逻辑存在 |
| T6 | 文档口径（AC-12） | `packages/forge-devops/README.md` | `docs/teamflow/memory.md`、`DESIGN.md` | 配置页步骤在前、环境变量降为 CI 兜底、六键表、`.exe` 限制、回滚步骤；无绝对路径/内网地址 |
| T7 | 交付自检（**不写 QA/ACCEPTANCE**） | `test/delivery-selfcheck.test.mjs`（就地扩展） | 全部新增文件 | §10 命令全绿；发现的问题当场修；只记录结论 |
| G | **git 约束（PRD §10，随 T4/T7 执行，不单独提交）** | — | — | 分支保持 `feat/devops-change-flow`；不清理/不回退/不 stash/不 reset 他人改动（现有 `M docs/teamflow/memory.md`、`?? 任务夹` 必须原样保留）；**提交与推送需用户当次授权，任务内不得自行 commit/push**；运行插件不得让 `git status` 多出新文件 |

依赖顺序：T1 ∥ T2 →（T3 需两者导出）→ T4 → T5 ∥ T6 ∥ T7。T5 只依赖契约，可在 T3 定稿后与 T4 并行。

## 9. 测试策略与未验边界

**分层**：纯函数单测（T1/T2）→ 适配器契约测（T3，假 `configEditor`/假 `req/res`）→ 装配测（T4，假 `ctx`，零网络零子进程）→ 静态形态测（T5/T7）→ 人工截图（QA）。全部 `node --test` 自动发现，**离线、无外部依赖、不写盘**（T3 用内存假实现）。
**Windows 专项**：全部通过注入 `platform:'win32'` + 假 `env`/假 `fs` 覆盖；**真机仍是 NOT RUN**（AC-13）。
**NOT RUN（不得写成已验证）**：宿主 `0.2.1-rc.3`；企业 profile 里 `configEditor` 是否可写；`/api/*` 在企业的连接层鉴权细节；Windows 实机（中文目录/空格/UNC/长路径）；企业 `dop.exe` 身份探针（F1）与安装位置分布（F2）；页面在 768 高视口的一屏几何（需实机截图）。

**风险与对策**：`configEditor` 缺失 → 页面只读 + `CLI_CONFIG_UNAVAILABLE`（读面不受影响）；发现误命中（F1 无探针）→ 页面显示命中路径 + 候选展开（AG-1 兜底）；Windows 杀软/网络盘拖慢 `statSync` → 截止时间 + 目录上限（AC-4）；候选表覆盖不足（F2）→ 手动指定是主路径，不是补丁。

## 10. 验证命令（交付口径）

```sh
node --test "packages/forge-devops/test/*.test.mjs"
node --test "tests/*.test.mjs"
pnpm check
git diff --check
node scripts/check-bundle-tarballs.mjs        # 新增文件进 files 白名单、闭包不变
node scripts/dsh-version.mjs check            # 目标宿主版本核对（rc.3 仍可能 NOT RUN）
```

本地通过 ≠ 企业联调、≠ 双端实机、≠ 远端 CI。报告只写实跑结果与 NOT RUN。

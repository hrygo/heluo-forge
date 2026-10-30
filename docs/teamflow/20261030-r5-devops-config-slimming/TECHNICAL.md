<!-- meta: summary="forge-devops 配置页瘦身的技术方案：页面字段表收敛为 PAGE_FIELDS 三键（隐藏三键不进 DOM、不参与 dirty/提交）、sourceType 在 resolveCliAccess 单点推导（配置 > 环境变量 > 双入口就绪，落既有 default 槽位）、改名与去 .exe 的全链路同步点、组件/样式/骨架收敛，以及 T1–T4 四个按文件边界可并行的任务与回归证据。" -->

# 技术方案 · forge-devops 配置页瘦身（r5）

- 基线依赖：`docs/teamflow/20261029-r3-cli-path-autodiscovery/`（三层来源、自动发现、写回补丁层、409/422 语义）。
- 取代：r3 `AC-6`（六字段可见）、`AC-9`（页面校验清单）、`AC-12`（显示名与指引句）——历史任务夹不改。
- 本阶段不新增路由、不新增环境变量、不新增 origin 词汇、不改门禁/写动作/幂等/审计。
- 事实来源：本方案中的行号来自当前工作区 `packages/forge-devops/`（client.js 1121 行）。未跑真实浏览器与宿主重启，相关项标 NOT RUN（§7.5）。

## 0. 范围与不变量

**改动文件（六处源码/文档 + 四个测试文件）**

| 文件 | 性质 |
|---|---|
| `packages/forge-devops/client.js` | 页面：字段表、i18n、组件树、校验、样式、骨架 |
| `packages/forge-devops/src/cli-config.mjs` | `CLI_PAGE_HINT`、`WRAPPER_MESSAGE` 文案 + `deriveSourceType` 单点推导 |
| `packages/forge-devops/test/client-shape.test.mjs` | 组件形态与 E2E 断言随页面收敛 |
| `packages/forge-devops/test/client-rule-parity.test.mjs` | 页面 3 键 / 服务端 6 键双面矩阵 |
| `packages/forge-devops/test/cli-config.test.mjs`、`test/cli-access.test.mjs` | 推导四态、指引句、快照三键断言 |
| `packages/forge-devops/README.md`、`cordis.patch.yml`、`package.json` | 进入路径、配置项 3/2/1 标注、英文旧名 |

**不动的文件（禁止顺手"整理"）**：`src/http.mjs`、`src/index.mjs`、`src/flow.mjs`、`src/cli-access.mjs`、`src/runtime-config.mjs`、`src/cli-discovery.mjs`、`src/tools.mjs` 及其余 17 个 test 文件。它们承载 AC-9 的契约不变性——一旦改动，POST 白名单、状态码或信封就有一处会被"顺手改掉"。

**不变量**

1. 契约键仍是六个 camelCase，`CLI_FIELDS` 顺序不变（`http.mjs:232` 与 422 顺序依赖它）。
2. `GET/POST /api/forge-devops/cli` 的字段集、状态码、原因码词汇不变；页面只是**少发三个键**。
3. 装配期自动发现、保存即重建（`index.mjs:readCli`）、写回 profile 补丁层、409 保留输入、422 逐字段，全部按原样复用。
4. 页面永不发送 `dopEndpoint`/`ghOwner`/`sourceType`；服务端对这三个键的拒绝语义不放宽。

## 1. 架构与数据流

```
client.js（浏览器半，无 import 服务端）
  PAGE_FIELDS(3) ──渲染/校验/dirty/提交──┐
                                         │  GET / POST /api/forge-devops/cli
src/http.mjs（同源路由，白名单 = CLI_FIELDS 6 键，未改）
                                         │
src/cli-access.mjs（快照 + revision 栅栏 + 写回，未改）
                                         │  entries(6) / save()
src/cli-config.mjs（三层合并；本次新增 sourceType 推导）
                                         │
src/index.mjs mergedRuntimeOf → createDevopsFlow({config})（未改）
                                         │
src/flow.mjs:166 → 只读信封 sources[].sourceType（未改）
```

三条职责边界（本次只动第三层一处与第一层）：

- **页面**只知道三个可编辑键，其余三个键既不渲染也不提交；它拿到的是完整六键快照（服务端契约），只挑三键用。
- **推导只发生在 `resolveCliAccess()` 内**：页面、`index.mjs`、`flow.mjs` 都不得各自再推导一次（否则三处口径漂移，AC-7 的"唯一实现处"失效）。
- **证据链不变**：推导结果只影响只读信封与来源列表的 `sourceType` 取值，不影响任何写动作、门禁或幂等键。

## 2. 数据模型与存储

### 2.1 两张字段表

| 表 | 位置 | 值 | 用途 |
|---|---|---|---|
| `CLI_FIELDS`（契约表，唯一真源） | `src/cli-config.mjs:41` | `['dopBin','dopEndpoint','ghBin','ghOwner','sourceType','timeoutMs']` | 快照 entries、POST 白名单、服务端校验、422 顺序 |
| `PAGE_FIELDS`（渲染表，新增） | `client.js` 常量块（:40-47 处） | `['dopBin','ghBin','timeoutMs']` | 渲染、页面校验、dirty、POST body、422 聚焦 |

- `PAGE_FIELDS ⊂ CLI_FIELDS`（严格子集，2 项差集非空由测试守住），`ENTRY_FIELDS=['dopBin','ghBin'] ⊂ PAGE_FIELDS`。
- 新增 `TOOL_OF_FIELD = Object.freeze({ dopBin: 'dop', ghBin: 'gh' })`，与 `cli-config.mjs:108 TOOL_BY_FIELD` 同义但**只用于 i18n 插值**（`{tool}` 取值不再带 `.exe`）。
- 删除 `TEXT_FIELDS`（:45，已无引用）、`SEGMENT_FIELDS`（:47）、`SOURCE_TYPES`（:49）。客户端仍声明 `CLI_FIELDS`（:41）用于与服务端对齐的一致性断言，不用于渲染。

### 2.2 快照与条目形状（不变）

`GET` 返回 `{ revision, writable:{ok}, ready, reason?, guidance, searched, entries }`，`entries` 恒六键：

```jsonc
entries: {
  dopBin:   { origin:'discovered', path:'D:\\tools\\dop.exe', candidates:[{path,tier?}], rejected:[] },
  ghBin:    { origin:'discovered', path:'D:\\tools\\gh.exe',  candidates:[], rejected:[] },
  dopEndpoint: { origin:'missing' },
  ghOwner:     { origin:'missing' },
  sourceType:  { origin:'default', value:'mock' },   // 推导后可为 'enterprise'，origin 仍是 default
  timeoutMs:   { origin:'default', value:20000 }
}
```

非路径字段只给 `value`；`overrides[]` 给被压过的下层 origin（词表仍是 `config/env/discovered/default/missing` 五个，不新增）。

### 2.3 存储与写回（不变）

- 落点：活动 profile 的补丁层（`config.yml` 的 `config:` 段）经 `configEditor` 写回；`buildCliPatch`（`cli-config.mjs:459`）先复制 `current` 中非空的六键，再按提交的键覆盖/删除，**一个字段非法则整批不写**。
- 因此"隐藏三键逐字保留"是由服务端补丁合并语义保证的，页面不需要（也不能）回灌它们。
- 清除语义：`null`/空串 → 删除该键（回落下一层）；`timeoutMs` 提交时转 `Number`（`payloadValue`）。
- 推导结果**不落盘**：`sourceType` 不写入补丁层、不新增配置键；只有显式配置或环境变量才会被持久化（沿用 r3）。

### 2.4 `sourceType` 取值域与落位

| 优先级 | 来源 | origin | 值 | 备注 |
|---|---|---|---|---|
| ① | 配置层 | `config` | 用户显式值 | 原样保留，可 `mock` 压回 |
| ② | `FORGE_DEVOPS_SOURCE_TYPE` | `env` | 环境变量值 | 原样保留 |
| ③ | 推导 | `default` | `enterprise` \| `mock` | **本次新增**，占用既有 `default` 槽位 |

非法显式值仍进 `invalid` → `ready:false` + `CLI_CONFIG_INVALID`（不回落、不推导，沿用 r3 的"填错不静默替换"）。

## 3. 后端接口与契约

### 3.1 `GET /api/forge-devops/cli[?refresh=1]`

- 入参：`refresh=1` 是唯一的重扫开关（页面"重新自动发现"）；不带则用装配期缓存。
- 返回：见 §2.2；`ready` 仍由 `entries.dopBin.value !== null && invalid.length === 0` 判定。
- 变化：`entries.sourceType.value` 可能因推导变成 `enterprise`（origin/overrides 不变）；键集、状态码、`guidance` 结构不变。

### 3.2 `POST /api/forge-devops/cli`

- 请求体：`{ revision, fields }`；`fields` 的**白名单仍是六键**（`http.mjs:232` 用 `CLI_FIELDS` 过滤，未知键 → 400）。页面只会发三键，但服务端不因页面收敛而收窄校验（AC-9）。
- 成功 200：`{ ok:true, snapshot }`（页面用返回快照重建，`staged/errors` 清空）。
- 失败：`400 BAD_REQUEST`（fields 非对象 / 未知键）、`409 CLI_CONFIG_CONFLICT`（revision 栅栏，保留 staged）、`422 CLI_CONFIG_INVALID` + `errors[field]`、`503 CLI_CONFIG_UNAVAILABLE`（无可写条目）。CSRF 头 `x-forge-devops-request: 1` 不变。
- 三条不变式：空 `fields` 不写；等值不写（`save` 前 `isChanged` 过滤）；写后回读再返回快照。

### 3.3 推导对只读信封的影响

`mergedRuntimeOf(access.snapshot())`（`index.mjs:114`）按 `CLI_FIELDS` 取非 `missing` 且非空的值——`sourceType` 的 origin 是 `default`，因此**会**被带进流程的显式 config；`flow.mjs:166` 原样消费，写入 `sources[].sourceType` 与只读信封。于是"只找到 dop"时信封是 `mock`（AC-8 的正向证据），"dop+gh 都是可执行文件"时才是 `enterprise`。

## 4. 推导实现（唯一新增逻辑）

### 4.1 精确语义

在 `src/cli-config.mjs` 增两个模块内函数（`deriveSourceType` 导出供单测；`entryReady` 不导出）：

```js
/** 入口"解析到可直接执行的文件"：有值且来源是显式/发现（default 是裸命令名，未验证存在性）。 */
function entryReady(entry) {
  if (!isPlainObject(entry)) return false;
  if (typeof entry.value !== 'string' || entry.value === '') return false;
  return (
    entry.origin === CLI_ORIGINS.CONFIG ||
    entry.origin === CLI_ORIGINS.ENV ||
    entry.origin === CLI_ORIGINS.DISCOVERED
  );
}

/** 推导事实来源：dop 与 gh 都就绪才 enterprise，其余一律 mock（宁可少标）。 */
export function deriveSourceType(entries) {
  const dop = isPlainObject(entries) ? entries.dopBin : undefined;
  const gh = isPlainObject(entries) ? entries.ghBin : undefined;
  return entryReady(dop) && entryReady(gh) ? 'enterprise' : 'mock';
}
```

插入点：`resolveCliAccess()`（:335）里逐字段 `resolveField` 的循环结束后、`ready` 计算之前：

```js
// 事实来源：配置/环境变量都没声明时才推导；推导结果占用既有 default 槽位（origin 词表不新增）。
if (entries.sourceType.origin === CLI_ORIGINS.DEFAULT) {
  entries.sourceType = entryOf('sourceType', CLI_ORIGINS.DEFAULT, deriveSourceType(entries), []);
}
```

`entryOf`（:237）返回冻结条目，`tool` 字段不适用于 `sourceType`；`overrides` 保持 `[]`（推导不压任何层，页面也不显示）。

### 4.2 判定矩阵（单测按表驱动）

| # | dopBin 命中层 | ghBin 命中层 | 显式 sourceType | 期望 `entries.sourceType` |
|---|---|---|---|---|
| 1 | config/env | config/env | 无 | `{origin:'default', value:'enterprise'}` |
| 2 | discovered | discovered | 无 | 同上（这是最常见的"装好即企业"态） |
| 3 | discovered | 仅 `DEFAULTS.ghBin='gh'` | 无 | `{origin:'default', value:'mock'}` |
| 4 | 无（missing） | discovered | 无 | `mock`（dop 缺失，ready 也 false） |
| 5 | 非法（invalid，value=null） | discovered | 无 | `mock`（不因非法升级） |
| 6 | discovered | discovered | config `mock` | `{origin:'config', value:'mock'}` |
| 7 | discovered | discovered | env `enterprise` | `{origin:'env', value:'enterprise'}` |
| 8 | discovered | discovered | config `enterprise` + env `mock` | `{origin:'config', value:'enterprise'}`，`overrides:['env']` |

### 4.3 为什么 `default` 不算"就绪"

`DEFAULTS.ghBin = 'gh'`（`runtime-config.mjs:54`）是裸命令名，装配期不做 PATH 探测；把它算作"解析到可执行文件"会让"什么都没配、gh 只是恰好有个默认值"被标成企业实测——这正是 AC-8 的反面目标。同理，非法值（`value:null`）不算就绪：宁可少标。

### 4.4 反例（必须保持红转绿）

- 只有 dop 命中（矩阵 #3/#4）→ `deriveSourceType` 返 `mock`；`describeCliAccess()` 不泄露路径/endpoint（本就不读 `value`）。
- 在 client 里再写一份推导：`client.js` 拿得到 `entries`，但页面不发送该键，重复实现只会制造地雷——单测断言客户端源码里 `deriveSourceType|enterprise` 仅出现在 i18n（而 i18n 已删该词）。

## 5. 前端设计

### 5.1 组件树（三行一列）

```
DevopsSection
├─ h2.fdv-title（i18n title）
├─ p.fdv-intro
├─ StatusLine（role=status aria-live=polite，保留"重新自动发现"）
├─ [mode=loading] Skeleton（三行镜像 + 标题骨架，见 5.6）
├─ .fdv-group「命令行入口与超时」（单个分组标题，不再拆两组）
├─ .fdv-cards
│   ├─ CliEntryField dopBin（.fdv-card-first，无上边框）
│   └─ CliEntryField ghBin（上边框 = 第 1 条分隔线）
├─ TimeoutField（.fdv-scalar，上边框 = 第 2 条分隔线）
└─ .fdv-footer（notice + 保存按钮；locked 时整块换 UnavailableNote）
```

- `CliEntryField` 的交互分支（resolved/editing/reset、origin 四态、候选展开、只读可复制、动作按钮）**一行不改**，只把 `tool` 改为 `TOOL_OF_FIELD[field]`，并让 `entry.hint.help` 走插值。
- 新组件 `TimeoutField({ t, label, hint, value, error, locked, inputRef, onChange, onBlur })`：仅本文件的内部组件（**不导出**），结构 = `label.fdv-label` + `input.fdv-input.fdv-scalar-input` + `FieldFoot`。它复用 `.fdv-foot`，错误优先、hint 兜底。
- 删除 `TextField`（只有隐藏字段在用它，超时改用 TimeoutField 后可整体删除）与 `SegmentedField`（:553-600 区域，含 `step()` roving tabindex）。

### 5.2 度量与语义

- 超时输入：`width:220px;max-width:100%`（`METRICS.scalarInputWidth=220`），`font-variant-numeric:tabular-nums`，`inputMode='numeric'`（不加 `type=number`：宿主主题下 spinner 与 RTL 表现不确定）。
- 三行节律不变：`padding:12px 0` + 6（label→input）+ 6（input→hint）；除行间两条 `.5px` 分隔线外无边框、无卡片、无背景。
- 内容宽 564px，DESIGN §0.6 的 501px 竖向核算不受影响；超时行成第三行后总高 +108±0。

### 5.3 状态管理

沿用现有 useState/useRef 单根状态（`DevopsSection` 是唯一可持 hook 的组件，测试用调用序定位槽位）：

| 状态 | 变化 |
|---|---|
| `view {mode, snapshot, reason}` | 不变（loading/form/degraded/error） |
| `staged` | 只装 `PAGE_FIELDS` 的键（`onInput`/`takeOver`/`resetToAuto` 只在三键上被调用） |
| `errors` | 页面校验键集合收敛到三键；422 时只映射可见三键 |
| `phase` / `notice` / `editing` / `expanded` / `steady` | 不变 |

关键改动（`client.js`）：

1. `focusFirst`（:712）：`for (const field of PAGE_FIELDS)`。
2. `save()`（:826）与等值过滤（:830）：`for (const field of PAGE_FIELDS)` → body 只可能含三键；`Object.keys(fields).length === 0` 仍提前返回。
3. 422 分支（:878-887）：`if (PAGE_FIELDS.includes(field)) serverErrors[field] = …`；返回里出现隐藏键（服务端更严的情况下）**不聚焦、不落字段行**，落到 footer 的 `saveFailed` 兜底（`notice.kind='failed'`，reason 取 `errorCode(body) ?? 'CLI_CONFIG_INVALID'`）。这样"服务端拒绝隐藏键"仍可见，而页面不会为一个不存在的输入框聚焦。
4. `changed`（:904）：`PAGE_FIELDS.filter(...)`——`dirty` 只由三键决定，未改动时保存禁用（AC-5）。
5. `validateField`（:352）：路径类与 `timeoutMs` 保留；`dopEndpoint`/`ghOwner`/`sourceType` 三个分支删除，函数末尾 `return null`（页面不校验知识域外的键）。`payloadValue`（:380）只处理 `timeoutMs` 的 `Number` 转换。
6. `render`（:988-1023）：删掉第二组标题 + `.fdv-grid` 的四键调用，替换为 `TimeoutField`；`section.connection` 不再被引用。
7. 导出面（:1119）：`return { apply, inject, DevopsSection, CliEntryField, StatusLine, CandidateList }`（去掉 `SegmentedField`，`test/client-shape.test.mjs:85-97` 的期望列表同步）。

### 5.4 键盘与可访问性

- 顺序：`[重新自动发现]` → dop 输入 → dop 行内动作 → gh 输入 → gh 行内动作 → 超时输入 → `[保存]`（DOM 顺序天然满足；删 roving tabindex 后不再有 `tabindex=0/-1` 管理）。
- 只读入口仍是 `readonly` 而非 `disabled`（可聚焦复制）；超时在 `locked` 时也 `readOnly`。
- 状态行、错误 hint 的 `aria-describedby`/`aria-invalid` 绑定不变。

### 5.5 i18n 变更表

| 操作 | 键 | 值 |
|---|---|---|
| 改 | `nav`/`title`（zh） | `企业 DevOps` |
| 改 | `nav`/`title`（en） | `Enterprise DevOps` |
| 改 | `section.commandline` | zh `命令行入口与超时` / en `Command-line entries and timeout` |
| 改 | `entry.hint.help` | zh `在资源管理器里选中 {tool} 文件右键 →「复制文件地址」，粘贴到这里` / en `Select the {tool} file in Explorer → "Copy as path", then paste it here`（调用处传 `{tool}`） |
| 改 | `error.wrapperScript` | `.cmd / .bat 包装脚本不能直接执行，请指向可直接执行的文件` / en 同义（去 `.exe`） |
| 删 | `field.dopEndpoint`、`field.dopEndpoint.hint`、`field.ghOwner`、`field.ghOwner.hint`、`field.sourceType`、`field.sourceType.hint`、`section.connection`、`error.endpoint`、`error.owner`、`error.source` | — |
| 保 | `field.timeoutMs` `超时（毫秒）`、`field.timeoutMs.hint` `1000–600000，默认 20000`、`entry.*`（除 help）、`origin.*`、`status.*`、`error.pathLength`/`error.timeout`/`error.wrapperScript` | 不变 |

键数：zh 64 → 54，en 同。`test/client-shape.test.mjs:359` 的 `keys.length >= 60` 改为 `>= 54`，并**补**一条"必含键清单"断言（`entry.hint.help`、`field.timeoutMs.hint`、`origin.*` 五条、`status.ready`），避免以后靠总数维持强度。

### 5.6 样式与骨架

删除（`client.js` CSS 块）：`.fdv-grid`（:158）、`.fdv-track`（:161）、`.fdv-segment`(`:hover`/`-on`/`:focus-visible`，:162-165）、`.fdv-skeleton-grid`（:181）、`.fdv-skeleton-cell`（:182），以及容器查询/media 里的 `.fdv-grid,.fdv-skeleton-grid` 引用（:185、:186）与 `prefers-reduced-motion` 里的 `.fdv-segment`（:187）。

新增/修订：

```css
.fdv-scalar{box-sizing:border-box;padding:${METRICS.fieldPadY}px 0;border-top:${METRICS.separator}px solid var(--dsw-alias-border-l2)}
.fdv-scalar-input{width:${METRICS.scalarInputWidth}px;max-width:100%;font-variant-numeric:tabular-nums}
.fdv-head{…;flex-wrap:wrap;row-gap:4px}            /* 窄窗标题 + Tag + 动作不溢出（DESIGN D-2） */
.fdv-skeleton{display:flex;flex-direction:column;margin-top:${METRICS.groupGapTop}px}
.fdv-skeleton-group{height:${METRICS.groupLine}px;margin:0 0 ${METRICS.groupGapBottom}px;border-radius:${METRICS.radiusSm};background:var(--dsw-alias-interactive-bg-hover);animation:fdv-breathe …}
.fdv-skeleton-row{height:${METRICS.skeletonRow}px;border-radius:${METRICS.radiusMd};background:var(--dsw-alias-interactive-bg-hover);animation:fdv-breathe …}
.fdv-skeleton-row + .fdv-skeleton-row{border-top:${METRICS.separator}px solid var(--dsw-alias-border-l2)}
```

`METRICS`：删 `gridGap`/`trackHeight`/`trackPad`/`segmentHeight`/`segmentPadX`/`skeletonCell`；增 `scalarInputWidth: 220`、`skeletonRow: 108`（=12+20+6+34+6+18+12，与真实行等值）。骨架 = 标题骨架 20 + 组间距 16 + 三行 324 = **360px**（DESIGN §0.6 记 361px，差 1px 来自取整），加载到表单的位移 ≤ 1px，不再闪跳。

## 6. 关键实现点与边界

| 编号 | 约束 | 落地方式 |
|---|---|---|
| D-01 | 隐藏三键**不进 DOM**（不是灰显/折叠），也不进 `staged` | 渲染树不再引用它们；`PAGE_FIELDS` 驱动 dirty/提交/422；测试断言无 `fdv-{field}` 节点、inputs 数=3 |
| D-02 | `.exe` 只从**用户可见文案**移除，真实路径值不改写 | `{tool}` 传 `dop`/`gh`；`error.wrapperScript` 与服务端 `WRAPPER_MESSAGE` **同轮同句**改；**不得**对已解析路径做 `replace('.exe','')`（会改坏真实可执行文件路径） |
| D-03 | 规则句保留 | `cli-config.mjs:183` 的 `不是可直接执行的文件（Windows 上请指向 .exe）`、`README.md:70` 的 Windows 只认 `.exe` 规则说明保留（事实而非文案）；README 里引用的页面提示改为「请指向可直接执行的文件」 |
| D-04 | 改名全链路 | `client.js:2` 头注释、`:195/196`、`:262/263`、`src/cli-config.mjs:95`、`README.md:9,32,34,50,95`、`cordis.patch.yml:10` 注释、`package.json:6` description（英文旧名同源改为 `Enterprise DevOps`）；测试 `cli-config.test.mjs:118,356,456,461`、`cli-access.test.mjs:158` |
| D-05 | 零命中口径 | zh i18n 对 `dop 服务地址\|gh 组织\|事实来源\|mock\|enterprise\|\.exe` 零命中；旧名 `DevOps 变更流程` 与入口英文名在 `packages/`、`docs/`（排除 `docs/teamflow/2026*` 历史任务夹）、根 `README.md` 零命中；**排除** `dist/`（gitignore 的构建产物，重打包后自然消失）与 `node_modules/` |
| D-06 | 推导唯一实现处 | 只改 `cli-config.mjs`；`client.js` 与 `index.mjs` 零推导代码；单测断言 `deriveSourceType` 只从该模块导出 |
| D-07 | 校验"页面收窄、服务端不放宽" | 页面三键校验；服务端 `validateCliField`/`buildCliPatch` 对六键语义不动；`client-rule-parity` 用同一矩阵分别跑页面与服务端 |
| D-08 | 保存即重建 | 200 后 `applySnapshot(body.snapshot)` + 清 `staged/editing/expanded/errors`；409 保留 staged 与 refresh 入口；两条路径都不新增请求 |
| D-09 | 不新增 origin 词、不加环境变量、不改回滚 | `origin.default` 承担推导；环境变量名沿用 `FORGE_DEVOPS_SOURCE_TYPE`；README 回滚步骤仍按"重置为自动发现 + 保存" |

## 7. 测试策略

### 7.1 分层

| 层 | 文件 | 关注 |
|---|---|---|
| 服务端单测 | `test/cli-config.test.mjs`、`test/cli-access.test.mjs` | 推导四态、覆盖优先级、指引句、快照三键、隐藏键逐字保留 |
| 页面静态/形态 | `test/client-shape.test.mjs` | 字段数=3、无段控件、文案零命中、骨架三行、导出面、i18n 键集 |
| 跨面一致性 | `test/client-rule-parity.test.mjs` | 页面 3 键矩阵 vs 服务端 6 键矩阵；隐藏键页面恒 null、服务端仍拒 |
| 组件 E2E（假 fetch） | `test/client-shape.test.mjs` 第 7 节 | 首页→手动指定→保存体仅三键→409→422 聚焦→降级只读 |

### 7.2 用例改动（**只改写、不删除**，新增 ≥ 5 条；`test()` 计数只增不减，零 skip）

| 文件:行 | 现状 | 改为 |
|---|---|---|
| `client-shape:85-97` | 期望导出含 `SegmentedField` | 期望 `{apply, inject, DevopsSection, CliEntryField, StatusLine, CandidateList}` |
| `client-shape:356-365` | `keys.length >= 60` | `>= 54` + 必含键清单 |
| `client-shape:375-396` | 断言六键都有 `field.*` 文案 | 断言 `PAGE_FIELDS` 三键有文案、`CLI_FIELDS` 仍是六键契约表、`PAGE_FIELDS ⊂ CLI_FIELDS` |
| `client-shape:438-452` | 度量常量清单 | 去掉 `gridGap/track*/segment*/skeletonCell`，加 `scalarInputWidth:220`、`skeletonRow:108` |
| `client-shape:740-922` | 快照夹具含 `sourceType` | 夹具保留六键（契约），断言渲染后 `inputs==3`、无 `fdv-sourceType`；保存体 `Object.keys(fields)` ⊆ 三键 |
| `client-rule-parity:61` | `sliceClientConst('SOURCE_TYPES')` | 删除（常量已不存在），改切片 `PAGE_FIELDS` |
| `client-rule-parity:97-125` | 六键矩阵逐行比较页面/服务端 | 矩阵保留六键；三键比较两面对齐，隐藏三键断言"页面 `null` + 服务端拒绝"（覆盖"页面收窄≠服务端放宽"） |
| `cli-config:118` `/356` `/456` `/461` | 断言旧名与 `.exe` 拒收句 | 改为「设置 → 企业 DevOps」与「请指向可直接执行的文件」 |
| `cli-config:193-203` | sourceType 默认 `mock`（只有 dop） | 保留（矩阵 #3），**补** #1/#2/#6/#7 行 |
| `cli-config:242` `/375-378` | `WRAPPER_MESSAGE` 旧句 | 新句（与服务端同源） |
| `cli-access:140-141` | 双发现命中仍 `mock` | 改为 `enterprise`（与推导一致）；新增"仅 dop 发现 → mock"用例 |
| `cli-access:158` | 指引含旧名 | 新名 |

净增用例建议：① 推导四态表（cli-config）② 覆盖优先级表（cli-config）③ 双发现→enterprise（cli-access）④ 仅 dop→mock（cli-access）⑤ 页面三键渲染与隐藏键零 DOM（client-shape）⑥ 文案零命中（client-shape）。至少落地 5 条。

### 7.3 AC → 证据

| AC | 证据 |
|---|---|
| AC-1 改名全链路 | `grep -rn "DevOps 变更流程"` 零命中（排除 `dist/`、历史任务夹）+ nav/title/CLI_PAGE_HINT/README 断言 |
| AC-2 字段收敛 | client-shape 渲染断言（inputs=3、无 `fdv-sourceType`）+ 页面文本正则 |
| AC-3 去 `.exe` | i18n 全表正则零命中 + `state.written` 里路径值字节不变 |
| AC-4 交互零回退 | 既有 E2E 四条用例**不改动断言**仍绿（手动指定/重置/候选/降级） |
| AC-5 增量保存 | E2E 保存体键集 ⊆ `PAGE_FIELDS`；`buildCliPatch` 用例证明未提交键逐字保留 |
| AC-6 校验收敛 | `client-rule-parity` 双面矩阵 |
| AC-7 推导 | `deriveSourceType` 表驱动 + `describe`/`snapshot` origin 断言 |
| AC-8 不伪造证据 | 矩阵 #3/#4/#5 + cli-access 快照；装配级信封由 QA 阶段装配反例覆盖 |
| AC-9 契约不变 | `http.mjs`/`index.mjs` 零 diff；`cli-http` 用例全绿；POST 白名单仍 6 键 |
| AC-10 文档同步 | README diff + 旧名 grep |
| AC-11 死代码 | grep `SegmentedField\|SEGMENT_FIELDS\|SOURCE_TYPES\|fdv-segment\|fdv-grid` 零命中 |
| AC-12 回归基线 | `pnpm check`、`git diff --check`、`test()` 计数对比、`skipped 0` |
| AC-13 证据纪律 | 报告标 NOT RUN：真实浏览器、宿主重启、窄窗截图 |
| AC-14 渲染自检 | 骨架三行/无空白分组/无重复分隔线；窄窗仅静态推演（截图 NOT RUN） |

### 7.4 回归命令

```sh
pnpm check
git diff --check
node --test "packages/forge-devops/test/*.test.mjs"   # 包内全量（28 个测试文件 + fixtures/；Node 24 不把目录当搜索根）
cd packages/forge-devops && node --test "test/*.test.mjs"
# 定向（实现迭代期）
cd packages/forge-devops && node --test test/cli-config.test.mjs test/cli-access.test.mjs
cd packages/forge-devops && node --test test/client-shape.test.mjs test/client-rule-parity.test.mjs
```

### 7.5 未验项（NOT RUN，不得写成已验）

真实浏览器走查与截图（宿主 Web UI 起停）、宿主 profile 重启后页面可见性、窄窗 <700/<520 的实测、Windows/麒麟 aarch64 实机、真实 `gh`/`dop` 企业联调、宿主动效偏好切换。组件级证据仅来自假 React + 假 fetch 的离线下运行。

## 8. 任务拆分

四个任务按**文件边界**切分：T1/T2/T3 文件互斥可并行，T4 必须在三者之后。

### T1 · 服务端推导与文案（files: `src/cli-config.mjs`、`test/cli-config.test.mjs`、`test/cli-access.test.mjs`）

1. `CLI_PAGE_HINT` → `设置 → 企业 DevOps`；`WRAPPER_MESSAGE` → 去 `.exe` 的新句（`:183` 的 Windows 规则句**保留**）。
2. 加 `entryReady`/`deriveSourceType`，在 `resolveCliAccess` 的循环后改写 `entries.sourceType`（origin 仍 `default`），并导出 `deriveSourceType`。
3. 测试：推导四态表、覆盖优先级表、旧文案改写、`cli-access` 双发现→`enterprise` + 仅 dop→`mock`。
4. 验收：`node --test test/cli-config.test.mjs test/cli-access.test.mjs` 全绿；`describeCliAccess` 仍无 `value`；`invalid` 行为不变。

### T2 · 页面收敛（files: `client.js`、`test/client-shape.test.mjs`、`test/client-rule-parity.test.mjs`）

1. 常量/字段表：`PAGE_FIELDS`、`TOOL_OF_FIELD`；删 `TEXT_FIELDS`/`SEGMENT_FIELDS`/`SOURCE_TYPES`。
2. i18n：§5.5 的增删改（含 `{tool}` 插值调用处 `t('entry.hint.help', { tool })`）。
3. 组件：删 `TextField`/`SegmentedField`/`segmentField`，加内部 `TimeoutField`；渲染树改三行；导出去掉 `SegmentedField`。
4. 逻辑：`focusFirst`/`save`/`changed`/`payloadValue`/`validateField`/422 分流全部走 `PAGE_FIELDS`。
5. 样式/骨架/METRICS：§5.6；`.fdv-head` 加 `flex-wrap:wrap;row-gap:4px`。
6. 测试：§7.2 的 client-shape 与 parity 改动；新增"三键渲染 + 隐藏键零 DOM"与"文案零命中"两条。
7. 验收：两条测试文件全绿；`grep fdv-segment client.js` 零命中；导出面断言通过。

### T3 · 文档与元数据改名（files: `packages/forge-devops/README.md`、`cordis.patch.yml`、`package.json`）

1. README：进入路径「设置 → 企业 DevOps」、`# 配置页` 标题、配置项表加「3 项可在配置页设置 / 2 项仅环境变量与配置文件 / 1 项由后端推导」三行标注、回滚段与第 50 行同源表述、`:70` 的提示引用改为新句（Windows 只认 `.exe` 的规则说明保留）。
2. `cordis.patch.yml:10` 注释：新入口名 + 六键/三键口径。
3. `package.json:6` description：`Enterprise DevOps host plugin …`（英文旧名同源）。
4. 验收：旧名 grep 零命中（口径见 D-05）；不改 README 的规则段落与包名/版本。

### T4 · 交付自检（无写入；T1–T3 完成后执行）

1. `pnpm check` + `git diff --check`；记录 `test()` 总数与 `skipped 0`（与改动前对比只增不减）。
2. 定向回归：§7.4 四条。
3. 口径自检：旧名/i18n 零命中 grep；`git diff` 确认 `http.mjs`/`index.mjs`/`flow.mjs`/`cli-access.mjs` 零改动。
4. 发现缺陷当场修（回到对应任务的文件边界内），只记结论；**不写** `QA-REPORT.md`/`ACCEPTANCE.md`，不做跨浏览器/实机矩阵。

**统一工程约束（写进每个任务）**：留在 `feat/devops-change-flow` 就地实现；不新建/切换/合并分支；不 `stash`/`checkout --`/`reset --hard`；本轮不提交、不推送；截图只落宿主 shots 或 `logs/`，不落仓库；只改上述文件，不碰 `docs/teamflow/memory.md`（PRD 阶段已同步同主题行）。

## 9. 风险与回滚

| 风险 | 影响 | 处置 |
|---|---|---|
| 推导把本机 mock 脚本判成企业 | 证据被高估 | 双入口判据 + `default` 不算就绪 + 显式配置/环境变量可纠偏；文档写明"证据以人工标注为准" |
| 页面收窄连带服务端收窄 | 旧 profile 里的 `dopEndpoint` 失去保护 | T4 校验 `http.mjs`/`buildCliPatch` 零 diff；parity 用例守着 |
| 改名漏一处 | 工具失败指引指向不存在的入口 | D-04 清单 + 全库 grep；`CLI_PAGE_HINT` 与页面同源 |
| 骨架/布局跳动 | 观感回退 | 三行镜像 + 108px；窄窗仅静态推演（实测 NOT RUN） |
| 既有 E2E 断言与旧文案耦合 | 连带红 | 按 §7.2 逐条改写，禁止删除用例 |

回滚：`git revert` 本需求单个提交即可回到 r5 前；配置层无需迁移（无新键、无数据格式变化），用户 profile 里的三个隐藏键原样保留。

<!-- meta: summary="r9：失败面收敛到单点模块 failure-face.mjs（形态归类+脱敏+detail 组装，spawn 失败不再读证据行），刷新改走 refreshSnapshot 单点（发现→重合并→事务化重建读面，失败降级为结构化失败），新增仓库卸载命令（脚本库 patch-layer-blocks 按缩进块精确删本插件条目，再调 dsh plugin remove）。" -->
基线依赖：docs/teamflow/20261029-r3-cli-path-autodiscovery（发现只在装配与页面刷新两处执行、保存写活动 profile 补丁层）、docs/teamflow/20261030-r8-win-cli-path-validation（未启动按入口形态归因、fail-closed 语义）、docs/teamflow/20261030-r5-devops-config-slimming（三字段页面与「企业 DevOps」口径）
上游基线：docs/teamflow/20261030-r8-win-cli-path-validation#AC-5 的①形态判断②原因归运行时③下一步④不含绝对路径与 endpoint（四项保留）
取代：docs/teamflow/20261030-r8-win-cli-path-validation#AC-5 中「原生入口回退脱敏证据行并保留 errno」一段（历史任务夹不改，只在本夹声明）

# TECHNICAL — 失败面脱敏 / 刷新重建读面 / 卸载清理补丁条目

## 0. 架构判断（一句话）

**三处「用户看到的状态」各自收敛成一个单点**：失败文案只由新模块 `src/failure-face.mjs` 组装（spawn 失败**不再读取**证据行，形态即结论）；刷新只由 `refreshSnapshot()` 一条路径执行（发现 → 重合并 → 事务化重建读面 → 用同一份合并态出响应）；卸载只由 `scripts/lib/patch-layer-blocks.mjs` 的块模型改文件（按缩进块精确删，逐字保留其它行）。

判定纪律（写死，供 QA 复核）：

1. **spawn 失败零证据**：`exitCode === null` 时适配器只把 `{command, bin, platform}` 交给渲染点，`stderr/stdout` 不参与组装；判定只看入口形态 + `exitCode`，不读 errno。
2. **出口唯一**：只读信封、写动作结果、变更卡片三处的失败文案全部经 `failure-face.mjs` 导出函数产出；适配器与动作层不得把 `error.message`、`stderr`、`errno` 直传出口。
3. **刷新同源**：`?refresh=1` 的响应快照与重建后的读面来自**同一份合并态**（响应取 `access.snapshot()` 的缓存合并结果，不再二次发现）。
4. **重建事务化**：`syncFaces({rebuild:true})` 先算后提交；抛错时提交「明确不可用」而不是半新半旧。
5. **卸载按块删**：补丁层只按「顶层 `- ` 块 + 精确 id/name」删，缩进更深的同名 `- id:` 永不命中；未命中即不写盘。

## 1. 现状与改动面（逐文件）

| 文件 | 现有编码旧口径的位置 | 本轮动作 |
|---|---|---|
| `packages/forge-devops/src/failure-face.mjs` | —（新文件） | 新建：形态→类别/文案、`redactFailureText`、`failureFaceOf`、`toolFailureOf`、`writeFailureOf` |
| `packages/forge-devops/src/entry-form.mjs` | `:145` `ERRNO_LIKE` 保留注释、`:170-206` `redactPathLike`、`:210-229` `describeSpawnFailure` | 删这两个导出（迁入 failure-face），保留后缀词表/四形态/`isDirectlyExecutable`；文件头契约注释同步 |
| `packages/forge-devops/src/dop-adapter.mjs` | `:164-176` 内联 `spawnFailed` + `describeSpawnFailure` + 拼 message | 改调 `failureFaceOf`，`fail(face.code, face.message, face.detail)`；非 spawn 证据行也走同一渲染 |
| `packages/forge-devops/src/gh-adapter.mjs` | `:421-436` 同构重复（含 `mayHaveSideEffect: true`） | 同上，消重；`mayHaveSideEffect` 仍为 true 并透传进 detail |
| `packages/forge-devops/src/tools.mjs` | `:82-90` `failure()` 把 detail 转字符串；`:141`/`:166`/`:221` 直传 `error.message` | 新增 `failureOf(action, error)`：spawn 失败走 `toolFailureOf`（结构化 detail + `next_action`），其余保持字符串 |
| `packages/forge-devops/src/actions.mjs` | `:317-328` `classifyWriteError` 用 `describeError` 拼底层 message | spawn 分支改 `writeFailureOf`：`reason: CLI_SPAWN_FAILED` + `category`/`next` + 无路径 detail 文本；`ACTION_REASONS` 增 `SPAWN_FAILED` |
| `packages/forge-devops/src/read.mjs` | `:128` 信封 `message` = `error.message`（带 `CODE: ` 前缀与证据） | 用 `failureMessageOf` 去前缀并保证脱敏；`detail` 仍浅拷贝结构化面 |
| `packages/forge-devops/src/change-context.mjs` | `:335-355` `toUnknown` 只留 `{field,reason,command}`；`:702-712` 渲染无类别/下一步 | `toUnknown` 增 `category`/`next`（来自 spawn 面），渲染追加「类别 · 下一步」 |
| `packages/forge-devops/src/http.mjs` | `:173-194` `createCliApi({access})`、`handleGet` 直调 `access.snapshot({refresh})`；`:69-74` `fail` 无 detail | 增可注入 `snapshot` 源；`fail` 增 `detail` 参数；500 分支带 `detail.reason/next` |
| `packages/forge-devops/src/index.mjs` | `:284` `createCliApi({ access })`；`:260-271` `syncFaces` 边算边赋值；`:356-360` `service.rediscover` | 新增 `refreshSnapshot()` 单点 + `computeFaces/commitFaces/degradeFaces`；`cliApi` 与 `service.rediscover` 共用它 |
| `packages/forge-devops/src/cli-config.mjs` | `:63-67` `CLI_REASONS` 四值 | 增 `REBUILD_FAILED: 'CLI_REBUILD_FAILED'`（降级原因码，页面按错误码展示） |
| `scripts/lib/patch-layer-blocks.mjs` | —（新文件） | 新建：profile 解析、块解析、精确删块、条目计数 |
| `scripts/lib/uninstall-devops.mjs` | —（新文件） | 新建：卸载编排（清理→回显→插件移除/下一步），runner 可注入 |
| `scripts/uninstall-devops.mjs` | —（新文件） | 新建：CLI 包装（解析 `--profile/--keep-plugin`，打印、置 exit code） |
| `package.json` | `:10-18` scripts | 增 `"uninstall:devops": "node scripts/uninstall-devops.mjs"` |
| `packages/forge-devops/README.md` | `:117` 旧口径「卸载：`dsh plugin --profile web remove …`」；`:147` 用例清单 | 卸载段改「一条命令：清补丁条目 + 移除插件」，补「上游 remove_bundle 不清理补丁层」；用例清单同步 |
| `packages/forge-gitee/README.md` | `:96` 同样一行 `dsh plugin --profile web remove` | 加一句限定：该命令只移除依赖，不清理 profile 补丁层（口径对齐，不新增能力） |
| `docs/teamflow/memory.md` | `:8` 已写「卸载不等于 remove」但无命令名 | 同主题替换：补 `pnpm uninstall:devops --profile <名>`；不追加变更日志 |

不动：`src/cli-runner.mjs`（唯一 `execFile` 出口）、`src/cli-discovery.mjs`（发现算法与预算）、`src/cli-access.mjs`（快照字段集与 revision 栅栏）、`src/runtime-config.mjs`、`client.js`（页面已发 `?refresh=1`，失败按错误码展示）、策略门禁与工具清单、写动作默认 denied 口径。

## 2. 数据模型与存储

**（1）失败面（派生值，不落盘）**

| 结构 | 字段 | 说明 |
|---|---|---|
| 形态 | `ENTRY_FORMS.NATIVE/WRAPPER/EXTENSIONLESS/OTHER` | 复用 r8 判定，唯一来源 `entry-form.entryFormOf` |
| 类别 | `WRAPPER_SCRIPT` / `EXTENSIONLESS_SHIM` / `NATIVE_ENTRY` | `OTHER` 归入 `NATIVE_ENTRY`（措辞按原生入口） |
| 面 | `{ reason, category, message, next }` | `reason` 恒 `CLI_SPAWN_FAILED`；`next` 恒 `CLI_PAGE_HINT` |
| 只读信封 detail | `{ reason, category, next, command, observedAt }` | 不含 `exitCode`/`bin`/证据；`spawnFailed: true` 保留（动作层判据） |
| 写动作结果 | `{ status:'failed', reason:'CLI_SPAWN_FAILED', category, next, detail:'<文本>' }` | `detail` 仍是字符串（r6/report 契约不变），三要素另以字段给出 |

**（2）读面（内存态，刷新时事务提交）**

`{ cliConfig, cliUnavailable, flow, flowDescribed, configured, reader }` 六个变量先算后提交；`provideFaces()` 只在提交后执行。降级态 = `{ cliConfig:null, cliUnavailable:{code:NO_READER, message:<无路径指引>, detail:{reason:'CLI_REBUILD_FAILED', next:CLI_PAGE_HINT}}, flow:null, flowDescribed:null, configured:false, reader:undefined }`。

**（3）补丁层块模型（只读解析 + 区间替换）**

| 字段 | 语义 |
|---|---|
| `start` / `end` | 0 基、左闭右开行下标；`end` = 下一个缩进 ≤ 块缩进的顶层 `- ` 行或文件末 |
| `indent` | 块首行缩进（profile 层为 0） |
| `id` / `name` | 块内**直接子行**（缩进 = `indent+2`）的 `id:` / `name:` 值；深层嵌套的同名键不参与 |
| `removed` | `[{ id, name, startLine, endLine }]`，行号 1 基、闭区间，供回显 |

无新存储、无新配置键；卸载只改 `<profile>/cordis.patch.yml`，不改 `<profile>/package.json`（插件移除交 `dsh plugin remove`）。

## 3. 失败面（M1）

### 3.1 单点模块 `src/failure-face.mjs`

| 导出 | 签名 | 职责 |
|---|---|---|
| `SPAWN_FAILURE_REASON` | `'CLI_SPAWN_FAILED'` | 固定枚举（读信封 detail.reason、写动作 reason 共用） |
| `SPAWN_CATEGORIES` | `{ WRAPPER_SCRIPT, EXTENSIONLESS_SHIM, NATIVE_ENTRY }` | 类别词表（出口可见） |
| `spawnFailureFace` | `({ bin, platform = process.platform }) -> { reason, category, message, next }` | 形态→类别→文案；不接收证据行 |
| `failureFaceOf` | `({ command, bin, platform, exitCode, evidence, observedAt, mayHaveSideEffect }) -> { code, message, detail }` | 适配器唯一入口：spawn 走面，非 spawn 走 `redactFailureText(evidence)` |
| `redactFailureText` | `(text) -> string` | 证据行脱敏：绝对/相对路径、UNC、URI、errno、`spawn ` 前缀，截断 200 |
| `failureMessageOf` | `(error) -> string` | 去 `CODE: ` 前缀的脱敏句（读信封 `message`） |
| `toolFailureOf` | `(action, error) -> { ok:false, action, reason, next_action, detail }` | 工具信封失败体（spawn 时 detail 结构化、`next_action:'configure-reader'`） |
| `writeFailureOf` | `(error, what) -> { status, reason, category, next, detail } \| null` | 写动作结果片段；非 spawn 返回 `null` 交回既有 unknown/超时分支 |

三类文案（都含 `CLI_PAGE_HINT`，互不套用）：

| 类别 | 文案骨架 |
|---|---|
| `WRAPPER_SCRIPT` | `入口是 ${suffix} 包装脚本，固定 argv 且未经 shell 无法启动脚本 · 请到「设置 → 企业 DevOps」指向该 CLI 的原生可执行文件` |
| `EXTENSIONLESS_SHIM` | `入口是 npm 生成的无后缀 shim，固定 argv 且未经 shell 无法启动脚本 · 请到「设置 → 企业 DevOps」指向该 CLI 的原生可执行文件` |
| `NATIVE_ENTRY` | `入口未能启动（系统拒绝执行或文件不可用）· 请到「设置 → 企业 DevOps」重新选择可执行文件` |

### 3.2 三出口改造

1. **只读信封**：适配器 `fail(face.code, face.message, face.detail)` → `DevopsReadError(COMMAND_FAILED, '<command> 未启动：<类别文案>', { reason:'CLI_SPAWN_FAILED', category, next, command, observedAt, spawnFailed:true })`；`normalizeReadError` 的 `message` 用 `failureMessageOf`（无 `CODE: ` 前缀、无路径），`detail` 原样带出。
2. **写动作结果**：`classifyWriteError` 先调 `writeFailureOf(error, what)`；命中即返回 `failed` + `CLI_SPAWN_FAILED` + `category` + `next` + `detail: '<what>命令未启动（无副作用）：<类别文案> · 下一步：<CLI_PAGE_HINT>'`；未命中保持超时→`unknown`、其余→`unknown`。
3. **变更卡片**：`toUnknown` 从 `detail` 取 `category`/`next`，渲染为 `- <field>：<reason> · 类别 <category> · 下一步 <next>（命令：<command>）`；非 spawn 仍为 `- <field>：<reason>（命令：…）`。

### 3.3 脱敏规则（`redactFailureText`）

| 目标 | 规则 | 替换 |
|---|---|---|
| URI | 形如 `scheme://…` 的词元 | `<地址>` |
| 绝对路径 | 盘符开头、UNC 双反斜杠开头、或 POSIX 正斜杠开头的词元（容忍引号/括号前缀） | `<路径>` |
| 相对路径 | 含反斜杠或正斜杠、且不是 URI/绝对路径的词元，及其后续续片 | `<路径>` |
| errno | `E` 加两个以上大写字母，或 `ERR_` 前缀的全大写词元 | `<错误码>` |
| 原始前缀 | 行首的 `spawn ` 或 `Error: spawn ` | 删除 |
| 长度 | 超过 200 字符 | 截断 |

说明：相对路径这条是 r8 的历史盲区（`bin/dop` 不匹配绝对路径规则）；本轮把带分隔符词元一律按路径处理，宁可多脱敏。本项目固定枚举（`COMMAND_FAILED`、`NO_READER`、`CLI_SPAWN_FAILED`、`WRAPPER_SCRIPT` 等）不匹配 errno 规则，扫描白名单即这些值。

### 3.4 PRD 词 → 实际字段对照（口径调和，务必按此验收）

| PRD AC-4/AC-1 表述 | 本轮实际行为（**不改**） | 依据 |
|---|---|---|
| 只读工具 `status: failed` | 工具信封为 `{ok:false, reason:'COMMAND_FAILED'}`，**无 `status` 字段**；读信封（`normalizeReadError`）仍是 `status:'unknown'`（拿不到事实即 unknown） | `src/tools.mjs:137-143`、`src/read.mjs:107-131` |
| 写动作 `status: unknown` | spawn 失败记 **`failed`**（确定没启动 = 无副作用），其余失败记 `unknown` | `src/actions.mjs:317-328`、`test/actions.test.mjs:328-337`、`test/gh-adapter.test.mjs:324-325` |
| `mayHaveSideEffect` 语义不变 | gh 写路径 spawn 失败仍 `mayHaveSideEffect: true`（适配器无法证明没落地），动作层按 `spawnFailed` 优先判 `failed` | `src/gh-adapter.mjs:430-435`、`src/actions.mjs:321-323` |
| `reason` = `CLI_SPAWN_FAILED` | 读信封 `error_code` 仍 `COMMAND_FAILED`（已登记词表不加码），`detail.reason = CLI_SPAWN_FAILED`；写动作 `reason = CLI_SPAWN_FAILED` | §3.2 |

结论：本轮只改**文案与 detail 形状**，不改四状态与 `ok` 语义。若验收要求把写动作 spawn 失败改成 `unknown`，那是 r6「只有确定没启动才记 failed」的纪律变更，需单独评审，不在本轮。

## 4. 刷新重建读面（M2）

### 4.1 根因

`createCliApi({ access })` 让 `handleGet` 直接 `access.snapshot({refresh:true})`：只重扫发现 + 重合并配置层，**不重建 flow/reader**；工具面仍持有旧 runner 的路径。已有的 `service.rediscover()` 才是完整重建，但 HTTP 路由没有用它。

### 4.2 单点 `refreshSnapshot()`

```js
const refreshSnapshot = () => {
  const snapshot = access.snapshot({ refresh: true }); // ① 一次发现 + 重合并
  syncFaces({ rebuild: true });                        // ② 事务化重建读面（抛错→降级后抛出）
  return access.snapshot();                            // ③ 与读面同源的缓存合并态
};
```

- `createCliApi({ access, snapshot: ({ refresh }) => (refresh === true ? refreshSnapshot() : access.snapshot()) })`
- `service.rediscover()` 与 `service.cliSnapshot({ refresh: true })` 都转调 `refreshSnapshot()`（工具侧与页面侧同一实现）。
- 响应里的 `revision/ready/entries/guidance` 取自 ③，与 ② 之后工具读到的读面同源；不再发生「响应已刷新、读面还是旧的」。

### 4.3 事务化 `syncFaces`

`computeFaces()` 返回 `{ cliConfig, cliUnavailable, flow, flowDescribed, configured, reader }`（内部执行 `access.describe()`、`mergedRuntimeOf(access.snapshot())`、`buildFlow()`），`commitFaces(next)` 一次性赋值并 `provideFaces()`；`syncFaces({rebuild})` = `commitFaces(computeFaces({rebuild}))`。`refreshSnapshot` 捕获异常后调 `degradeFaces()`（§2(2) 的降级态）再抛 `DevopsReadError('CLI_REBUILD_FAILED', '<无路径指引>', { reason, next })`。

- 读：`service.read()` 见 `reader === undefined` → 抛 `NO_READER`（`cliUnavailable.detail` 带 `CLI_REBUILD_FAILED`），零 spawn。
- 写：`callFlow` 增 `flow === null` 判据 → 抛 `FLOW_UNAVAILABLE`，零 spawn。
- HTTP：`handleGet` 捕获 → `fail(500, 'CLI_SNAPSHOT_FAILED', '<固定文案>', null, null, { reason:'CLI_REBUILD_FAILED', next: CLI_PAGE_HINT })`；下一次调用结论与之一致（仍不可用），直到下一次成功刷新或保存。

### 4.4 时序与同源断言

| 断言 | 做法 |
|---|---|
| 顺序「发现→重建→组装」 | 桩 `access.snapshot` 记录调用序（`refresh:true` 在前、无参在末）；`execFile` 桩记录重建后首次调用 |
| 改名后即时对齐 | PATH 桩目录内 `dop` 改名 → 刷新 → 下一次 `execFile` 的 `argv[0]` 为新路径；移走 → 刷新 `ready:false` → 下一次调用 `NO_READER` 且 `execFile` 计数不增 |
| 幂等无副作用 | 刷新前后补丁层字节与 mtime 不变、`git status --short` 无新增、发现计数 1、工具调用 0、无新进程 |
| 降级 | 注入 `buildFlow` 抛错（`ctx` 桩或配置非法）→ 500 结构化体 + 后续读 `NO_READER`、写 `FLOW_UNAVAILABLE`、无半新半旧 |

## 5. 卸载清理（M3）

### 5.1 profile 解析（`resolveProfile`）

| 顺序 | 来源 | 说明 |
|---|---|---|
| 1 | `--profile <name>` | 显式优先 |
| 2 | `DSH_PROFILE` | 宿主进程环境（插件内实测存在） |
| 3 | `DSH_PROFILE_DIR` | 取 basename 作 profile 名 |
| 4 | `$DSH_HOME/profiles/*` 唯一目录 | 恰好 1 个才采用 |
| 5 | 无 / 多个 | 报错并列出可选名字，**不猜** |

`$DSH_HOME` = `process.env.DSH_HOME || <home>/.dsh`；补丁层 = `<profile>/cordis.patch.yml`。回显只用 profile 名与 `cordis.patch.yml`，不打印绝对路径（AC-14）。

### 5.2 块模型与精确匹配

- 顶层块 = 行匹配 `/^(\s*)- /` 且缩进为该文件最小顶层缩进；块尾 = 下一个缩进 ≤ 块缩进的顶层 `- ` 行或文件末。
- 条目身份只取块内缩进 `indent+2` 的 `id:` / `name:` 值；`config:` 子树里的深层 `- id:`（如 llm 模型表）不参与判定。
- 匹配 = `ids` 集合的**精确相等**（`new Set(['forge-devops','@heluo/forge-devops']).has(value)`），源码内禁止 `startsWith`/正则/前缀匹配（AC-15）。
- 删除 = `lines.slice(0, start).concat(lines.slice(end))`；不吞并空行、不重排、不重写其它行（AC-12 字节 diff 只含被删区间）。未命中 → 不写盘。

### 5.3 命令契约

```sh
pnpm uninstall:devops --profile web          # 清理 + 移除插件
pnpm uninstall:devops --profile web --keep-plugin   # 只清理，打印下一步
node scripts/uninstall-devops.mjs [--profile <名>] [--keep-plugin]
```

输出（stdout，逐行）：

1. `profile：<名>`
2. `补丁层：cordis.patch.yml`（仅文件名）
3. `已删除条目：id=forge-devops（name=@heluo/forge-devops）行 42-58（共 17 行）`
4. `行数：58 → 41`
5. `插件：已移除` / `插件：未移除（--keep-plugin）` / `插件：未移除（未探测到 dsh CLI）`
6. 未移除时追加：`下一步：dsh plugin --profile <名> remove @heluo/forge-devops`

退出码：`0` = 已清理或本无残留；`1` = profile 无法确定 / 补丁层不存在 / 写入失败（不创建文件）。

### 5.4 幂等与失败面

- 第二次执行：`countEntries === 0` → 打印 `无残留（补丁层已是清理后的状态）`，exit 0，零写入（mtime 不变）。
- 补丁层缺失：`uninstall: 找不到 <profile> 的 cordis.patch.yml`，exit 1，不创建。
- 插件移除：`runner.has('dsh')` 为假 → 只清理并打印下一步；为真 → `execFile('dsh', ['plugin','--profile',name,'remove','@heluo/forge-devops'])`（`shell:false`、固定 argv、超时），非零退出时打印其退出码与「可手动重跑」提示，不影响清理结论。

## 6. 接口契约汇总

| 面 | 形状 |
|---|---|
| `GET /api/forge-devops/cli` | 200 `{ revision, writable, ready, reason, guidance, entries, host }`（不变） |
| `GET /api/forge-devops/cli?refresh=1` | 同上，但响应前完成 ①发现 ②重建 ③组装；失败 → 500 `{ ok:false, code:'CLI_SNAPSHOT_FAILED', message, detail:{ reason:'CLI_REBUILD_FAILED', next } }` |
| 工具失败（spawn） | `{ ok:false, action, reason:'COMMAND_FAILED', next_action:'configure-reader', detail:{ reason:'CLI_SPAWN_FAILED', category, next, command, observedAt } }` |
| 工具失败（其他） | 不变：`{ ok:false, action, reason, next_action, detail:'<脱敏文本>' }` |
| 写动作结果（spawn） | `{ status:'failed', reason:'CLI_SPAWN_FAILED', category, next, detail:'<文本>' }` |
| 写动作结果（其他） | 不变：`unknown` + 既有原因码 |
| 卸载命令 | 见 §5.3 |

## 7. 前端与页面

页面零改动：`client.js:670-709` 已按 `?refresh=1` 请求并在 `unchanged` 时置 `steady`（AC-9 不回归）；失败分支按 `errorCode(body)` 展示错误码（`CLI_SNAPSHOT_FAILED`/`CLI_REBUILD_FAILED` 会原样显示，属既有行为）。不新增控件、不改文案键。

## 8. 关键实现点与边界

1. **spawn 面不得读证据**：`failureFaceOf` 的 spawn 分支只使用 `command/bin/platform/observedAt`，`evidence` 仅非 spawn 分支使用——这是 AC-2 六注入零命中的结构性保证，而非靠正则兜底。
2. **`entry-form` 契约收窄**：删 `describeSpawnFailure`/`redactPathLike` 后，`test/entry-form.test.mjs` 的 spawn 段落迁到 `test/failure-face.test.mjs`；`entry-form` 只剩形态与可执行判定。
3. **`detail` 类型稳定**：只读信封 detail 是对象（既有），工具 `failure()` 的 detail 默认仍是字符串，只有 spawn 面返回对象——`failureOf` 是唯一分流点。
4. **卡片兼容**：`toUnknown` 新增字段可选，非 spawn 渲染逐字不变（既有卡片用例只增断言）。
5. **降级可恢复**：`degradeFaces` 只写内存态，下一次 `?refresh=1` 或保存成功即恢复；不写盘、不建文件。
6. **卸载不碰插件清单**：不读写 `<profile>/package.json`，插件移除完全交 `dsh plugin remove`；`--keep-plugin` 时不调用任何子进程。
7. **Windows 边界**：`dsh` 在 Windows 上可能是 `.cmd`，`execFile` 直接启动会失败——命令按「探测不到可用的 `dsh`」处理（只清理 + 打印下一步），不引入 shell。

## 9. 测试策略

| 文件 | 覆盖 |
|---|---|
| `packages/forge-devops/test/failure-face.test.mjs`（新） | 三类别文案互斥且都含 `CLI_PAGE_HINT`；`.exe` 不套包装解释；六注入（EINVAL/ENOENT/EACCES/`bin/dop`/绝对路径与 UNC/URI）下 `JSON.stringify` 全文正则零命中；`failureFaceOf` 非 spawn 分支保留退出码但脱敏；`toolFailureOf`/`writeFailureOf` 形状 |
| `test/entry-form.test.mjs` | 保留形态/可执行判定；删 spawn 段（用例总数由新文件补回并增加） |
| `test/dop-adapter.test.mjs`、`test/gh-adapter.test.mjs` | spawn 失败 `detail.reason/category/next`、无 errno、`execFile` 计数 1；非 spawn 证据行脱敏；超时分支不变 |
| `test/actions.test.mjs` | spawn → `failed` + `CLI_SPAWN_FAILED` + `category`/`next`；非 spawn 仍 `unknown`；不重放 |
| `test/tools.test.mjs` | spawn 失败信封 `next_action:'configure-reader'` + 结构化 detail；其他失败仍字符串 detail |
| `test/context.test.mjs` | 卡片失败行含类别与下一步；非 spawn 卡片逐字不变 |
| `test/cli-http.test.mjs` | 注入 `snapshot` 源被调用；`refresh=1` 走注入源；500 带 `detail.reason/next`；非 refresh 不触发重建 |
| `test/flow.test.mjs`（或新增 `test/wiring.test.mjs`） | 顺序断言、改名后新路径、不可发现时 `NO_READER` 零 spawn、刷新幂等（发现 1 次/工具 0 次/补丁层 mtime 不变）、重建抛错降级 |
| `tests/patch-layer-blocks.test.mjs`（新） | 兄弟/官方/注释/空行逐字保留；`id:` 与 `name:` 两写法；嵌套 `- id:` 不命中；未命中不写盘；行号区间与前后行数；profile 解析五分支（含歧义报错） |
| `tests/uninstall-devops.test.mjs`（新） | 端到端：清理→回显→`dsh` 桩 argv 断言；重复执行幂等 exit 0；`--keep-plugin` 零子进程；无 `dsh` 只清理并打印下一步；stdout 零绝对路径；补丁层缺失 exit 1 且不建文件 |

验证命令（阶段交付自检与 QA 复用）：

```sh
cd packages/forge-devops && node --test "test/*.test.mjs"
node --test "tests/*.test.mjs"
pnpm check
git diff --check
grep -rn "describeSpawnFailure\|redactPathLike" packages/forge-devops/src   # 期望零命中（AC-5）
grep -rn "remove @heluo/forge-devops" packages docs README.md | grep -v docs/teamflow/2026   # 只允许带口径限定的行
```

## 10. 任务拆分（并行，按文件边界）

**T1 失败面单点与三出口（M1）**
文件：`src/failure-face.mjs`(新)、`src/entry-form.mjs`、`src/dop-adapter.mjs`、`src/gh-adapter.mjs`、`src/tools.mjs`、`src/actions.mjs`、`src/read.mjs`、`src/change-context.mjs`、`test/failure-face.test.mjs`(新)、`test/entry-form.test.mjs`、`test/dop-adapter.test.mjs`、`test/gh-adapter.test.mjs`、`test/actions.test.mjs`、`test/tools.test.mjs`、`test/context.test.mjs`
读：`src/read.mjs`（READ_REASONS）、`src/cli-config.mjs`（CLI_PAGE_HINT）、`src/cli-runner.mjs`（结果形状）
验收：§9 前六行 + AC-1/2/3/4/5；`grep describeSpawnFailure` 零命中。

**T2 刷新重建读面（M2）**
文件：`src/http.mjs`、`src/index.mjs`、`src/cli-config.mjs`、`test/cli-http.test.mjs`、`test/flow.test.mjs`
读：`src/cli-access.mjs`（snapshot 语义）、`src/tools.mjs`（`callFlow` 失败面）
验收：§4.4 四组断言 + AC-6/7/8/9/10。

**T3 卸载清理（M3）**
文件：`scripts/lib/patch-layer-blocks.mjs`(新)、`scripts/lib/uninstall-devops.mjs`(新)、`scripts/uninstall-devops.mjs`(新)、`package.json`、`tests/patch-layer-blocks.test.mjs`(新)、`tests/uninstall-devops.test.mjs`(新)
读：`scripts/lib/bundle-rules.mjs`（补丁层写法）、`tests/plugin-patch-layers.test.mjs`（门禁约束）
验收：§9 后两行 + AC-11/12/13/14/15；`tests/plugin-patch-layers.test.mjs` 仍绿。

**T4 文档口径（与 T1-T3 并行，命令名以本文件为准）**
文件：`packages/forge-devops/README.md`、`packages/forge-gitee/README.md`、`docs/teamflow/memory.md`
验收：AC-16（旧口径零命中或已限定）、`pnpm check:docs`。

**T5 交付自检（串行，最后）**
无所有权文件；跑 §9 全部命令与 `pnpm check`、`git diff --check`、`git status --short`，当场修掉发现的问题并只记录结论（不写 QA-REPORT/ACCEPTANCE，不做跨浏览器/真机矩阵）。

**工程约束（来自 PRD §10，不得丢）**：沿用分支 `feat/devops-change-flow`；**不新建分支、不提交、不打 tag**；`?? TEAM-FULL-INSTALL.md` 与 `?? docs/teamflow/20261102-r9-runner-refresh-uninstall/` 保留原样，不得提交/回退/覆盖；禁止 `git reset --hard`、`git checkout --`；fixture 只落系统临时目录（不落仓库）；交付前 `git status --short` 无构建产物、日志、tarball。

## 11. 风险与未验

| 项 | 处理 |
|---|---|
| 脱敏降低可诊断性 | 类别枚举固定 + 下一步固定；README 给「现象 → 类别 → 动作」对照，不在提示里补路径 |
| `redactFailureText` 过脱敏（如 `org/group/repo#12`） | 只作用于**失败证据行**，不进 target/命令标签；用例固定断言 target 原样 |
| 真实冷启动零警告（AC-13） | 本轮 fixture 级验证，真实安装→卸载→冷启动由主 agent 在验收阶段执行，标 `NOT RUN` |
| 真实 profile 的 `cordis.patch.yml` 形态 | 本机只读观测（顶层数组、条目无空行、深层 `- id:` 出现在 config 子树）已用于设计；真实文件上的执行仍属未验 |
| `dsh` 在 Windows 为 `.cmd` | 按「探测不到可用 CLI」处理（只清理 + 打印下一步），不引入 shell（见 §8.7） |

## 12. 验收映射

| AC | 落点 |
|---|---|
| AC-1 / AC-5 | §3.1-3.3、`failure-face.test.mjs`、三适配器/动作/卡片用例、`grep` 零命中 |
| AC-2 | §3.3 规则表 + 六注入零命中用例 |
| AC-3 | §3.1 文案表 + 形态×平台矩阵用例 |
| AC-4 | §3.4 对照表（不改四状态）+ 计数桩用例 |
| AC-6 / AC-7 / AC-8 | §4.2-4.4 + 端到端桩（`execFile` 的 `argv[0]`） |
| AC-9 | §4.4 幂等组（mtime/发现计数/工具计数/steady） |
| AC-10 | §4.3 降级态 + 注入抛错用例 |
| AC-11 / AC-12 / AC-14 / AC-15 | §5.1-5.4 + `uninstall-devops.test.mjs`、`patch-layer-blocks.test.mjs` |
| AC-13 | fixture 计数断言；真实冷启动 `NOT RUN` |
| AC-16 | §1 文档行 + T4 |
| AC-17 | §9 验证命令 + T5 |

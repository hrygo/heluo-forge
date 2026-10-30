<!-- meta: summary="入口形态单点模块 entry-form.mjs 承载后缀词表/形态判定/可直接执行判定/未启动提示，cli-config 与 cli-discovery 改为消费者，适配器共用同一提示函数；保存口径变「存在且普通文件」，发现按 candidateExecutableNames 顺序排 .exe 优先。" -->
基线依赖：docs/teamflow/20261030-r8-win-cli-path-validation（PRD，本夹）
上游基线：docs/teamflow/20261030-r5-devops-config-slimming（3 字段页面、保存 3 键、隐藏键零丢失不回归）
取代：本夹 PRD 头部列出的 r3 AC-2/AC-9、r5 AC-3/AC-6（历史任务夹不改，只在本夹声明）

# TECHNICAL — Windows CLI 入口不再按后缀拦截

## 0. 架构判断（一句话）

**把「入口形态」从三处各自的字符串后缀判断，收敛成一个无 IO 的纯模块 `src/entry-form.mjs`**：保存侧（`cli-config`）、发现侧（`cli-discovery`）、运行期（`dop-adapter`/`gh-adapter`）都只消费它的判定与文案，于是「放开保存」与「不许改启动方式」这两件事在代码上不可能各自演进——放开的地方只有一处，而 `execFile`+`shell:false` 的出口一处都没动。

判定纪律（写死，供 QA 复核）：

1. **保存**只回答「这个值像不像一个能指向的入口」：存在 → 普通文件 → POSIX 执行位。**没有后缀门槛**（win32 上 `.exe`/无后缀/`.cmd`/`.ps1`/`.bat`/`.EXE` 同权）。
2. **发现**只回答「机器上哪个名字存在」：候选名表按 `native → 裸名 → .cmd → .ps1 → .bat → .com` 排序，排序即优先级，`.exe` 恒排前面。
3. **执行**一条不松：唯一出口仍是 `packages/forge-devops/src/cli-runner.mjs:204-212` 的 `execFile(bin, args, { shell:false, timeout, maxBuffer })`；本轮不新增任何子进程调用点、不新增解释器通道。
4. **未启动**的提示按「形态 + `exitCode === null`」归因，**不读 errno**；且不进绝对路径、不进 endpoint。

## 1. 现状与改动面（逐文件）

| 文件 | 现有编码旧口径的位置 | 本轮动作 |
|---|---|---|
| `packages/forge-devops/src/entry-form.mjs` | —（新文件） | 新建：后缀词表、形态判定、可直接执行判定、未启动提示、路径脱敏 |
| `packages/forge-devops/src/cli-config.mjs` | `:180-185` `checkExecutableSuffix`；`:222-236` `checkFieldValue` 先按包装脚本拒收再按后缀判；`:105` `WRAPPER_MESSAGE`；`:187-191` `binaryLabel` 返回 `dop.exe` | 删 `checkExecutableSuffix`/`WRAPPER_MESSAGE`/包装脚本分支；`probeFile` 末审改调 `isDirectlyExecutable`；目录文案去 `.exe` |
| `packages/forge-devops/src/cli-discovery.mjs` | `:43` `WRAPPER_SUFFIXES`；`:135-138` `wrapperSuffixOf`；`:166-170` 候选名只有 `.exe`；`:231-243` `isDirectlyExecutable` 的后缀门槛；`:276`/`:329-333` `rejected` 记 `wrapper-script`；`:346-350` 只按 tier+path 排序 | 定义搬去 `entry-form.mjs` 并在此**再导出**（契约面不变）；候选名扩为 6 个；`found` 排序加「候选名次序」层；`rejected` 恒为空数组 |
| `packages/forge-devops/src/dop-adapter.mjs` | `:152-158` `spawnFailed` 判定 + `failureLine` 直出 | 未启动时改调 `describeSpawnFailure`，新增可选 `platform` 入参 |
| `packages/forge-devops/src/gh-adapter.mjs` | `:411-421` 同上（两处各写一份） | 同上（与 dop 共用同一函数，消重） |
| `packages/forge-devops/client.js` | `:59` `WRAPPER_PATTERN`；`:223`/`:280` `error.wrapperScript`（zh/en）；`:326-329` blur 里后缀拒收 | 删三处，`validateField` 入口字段只判长度（4096） |
| `packages/forge-devops/README.md` | `:26`、`:62`、`:64`「只接受 `.exe`」；`:69` 页面只判长度的说明含 Win32 `.exe`；`:75-79` 发现名字表与「拒收包装脚本」段 | 按新口径改写，新增「可保存但运行期可能起不来」的说明段 |
| `packages/forge-devops/cordis.patch.yml` | `:15-16` 注释「只认 .exe 与执行位，.cmd/.bat 一律拒」 | 只改注释（装配行为无关），否则 AC-8 的旧口径 grep 会命中这份分发层副本 |

不动：`src/cli-runner.mjs`（执行出口）、`src/http.mjs`（端点与状态码）、`src/runtime-config.mjs`（`validateConfigField` 的六键基础规则）、`src/cli-access.mjs`（快照字段集）、`src/actions.mjs`（四状态与不重放）、`src/read.mjs`、策略门禁与工具面。

## 2. 数据模型与存储

**（1）配置字段语义（六键不变，只改两个路径键的「可存」判据）**

| 字段 | 规则（r8 后） | 拒绝文案 |
|---|---|---|
| `dopBin` / `ghBin` | 非空字符串；长度 ≤ 4096；无控制字符；不以 `-` 开头；非 URL 形态（以上来自 `runtime-config.validateConfigField`，未改）→ 路径形态时再叠加：`statSync` 成功、`isFile()===true`、POSIX 要求 `mode & 0o111` | `找不到这个文件` / `这是目录，需要指向 <tool> 本体` / `不是可直接执行的文件` / `不是可直接执行的文件（缺少执行位）` |
| `dopEndpoint`/`ghOwner`/`sourceType`/`timeoutMs` | **零变化**（AC-2 要求逐字不动） | 沿用现有 |

- 裸命令名（不含 `\`、`/`、盘符，如 `gh`）**不读盘**，直接通过（交给 PATH 解析，PRD §9 假设）。
- 空值/纯空白 = 清除该层，回落下一层（不变）。
- 保存成功写回**原值逐字**：不补后缀、不改大小写、不换分隔符、不 trim 出别的形态（`buildCliPatch` 只做合并，不做归一）。

**（2）`Discovery` 形状（仅主机内，含路径）**

```js
{ tool, found: [{ path, tier }], rejected: [], searched: ['PATH','candidate-dir'],
  scannedDirs, skippedDirs, truncated, elapsedMs }
```

- `found` 排序键由 `(tier, path)` 改为 **`(tier 序号, 候选名序号, path)`**；候选名序号取自 `candidateExecutableNames(tool, platform)` 的下标（`.exe`=0、裸名=1、`.cmd`=2、`.ps1`=3、`.bat`=4、`.com`=5）。于是「同 tier 内 `.exe` 恒先于任何脚本形态」不依赖目录遍历顺序，也不依赖 PATH 先后。
- `rejected` **保留键、恒为空数组**：它是快照契约的一部分（`cli-access.pathEntry` 原样透传、页面不渲染），删键会牵动快照形状与 `client-shape` 的字段断言，换不来任何用户价值。r8 起不再产生 `why:'wrapper-script'`。
- 预算与时限不变（200 目录 / 250ms，`discoverCli` 共用一份）。

**（3）快照与错误细节（快照字段集不变，AC-9）**

- `pathEntry` 仍是 `{ origin, path, tool, overrides, candidates, rejected }`；**不新增** `runnable`/`verified`/`native` 之类字段。`ready` 继续只表示「入口已解析」。
- 适配器错误 `detail.spawnFailed === true` 保留（`actions.classifyWriteError` 据此把写动作记 `failed` 而非 `unknown`，`:321`）。新增的提示只进 `message` 与 `detail` 的可读文本，不改 code。

## 3. API 设计

### 3.1 新模块 `packages/forge-devops/src/entry-form.mjs`（纯函数、无 IO）

```js
export const WRAPPER_SUFFIXES = Object.freeze(['.cmd', '.bat', '.ps1', '.com', '.vbs']);
export const ENTRY_FORMS = Object.freeze({ NATIVE:'native', WRAPPER:'wrapper', EXTENSIONLESS:'extensionless', OTHER:'other' });

wrapperSuffixOf(name) -> string | null          // 命中的后缀（小写）或 null；大小写不敏感
entryFormOf(file, platform = process.platform) -> 'native' | 'wrapper' | 'extensionless' | 'other'
isDirectlyExecutable({ path, platform, stat }) -> boolean   // 唯一「可直接启动」判定
describeSpawnFailure({ bin, platform, evidence }) -> string // 未启动时的可读归因行（已脱敏、无路径）
redactPathLike(text) -> string                  // 把盘符/UNC/POSIX 绝对路径替换为 <路径>，截断 200 字符
```

- `entryFormOf`：后缀 ∈ `WRAPPER_SUFFIXES` → `wrapper`；basename 以 `.exe` 结尾（不区分大小写）→ `native`；basename 不含 `.` → win32 得 `extensionless`、POSIX 得 `native`；其余 → `other`。
- `isDirectlyExecutable`：`stat` 缺失或 `isFile()!==true` → `false`；win32 **只看「是普通文件」**（无后缀门槛）；POSIX 沿用 r3 口径（包装脚本 `false`、`mode & 0o111` 为 0 → `false`，`mode` 缺失 → `false`）。**POSIX 行为零变化**（PRD 明确 POSIX 不动）。
- `describeSpawnFailure`：
  - `wrapper` → `入口是 .cmd 包装脚本，固定 argv 且未经 shell 启动时无法运行——这是启动方式的限制，与路径写法无关；请把配置改为该 CLI 的原生可执行文件，或改用提供原生二进制的安装方式`（后缀按实际命中项插入）
  - win32 且 `extensionless` → `入口是没有扩展名的命令 shim（npm 在 Windows 上生成的替身，也可能是 Git Bash 版），固定 argv 且未经 shell 启动时无法运行——…同上…`
  - 其余（`native`/`other`/POSIX） → `redactPathLike(evidence)`，空则 `进程未能启动`。**`.exe`/原生入口失败绝不套用包装脚本解释**（PRD AC-5）。
  - 断言纪律：输出不含 `X:\`、`\\server\`、POSIX 绝对路径，不含 endpoint。

`node:path` 是唯一依赖（只用于 `basename`）。

### 3.2 `cli-discovery.mjs` 对外契约（再导出，形状不变）

```js
export { WRAPPER_SUFFIXES, wrapperSuffixOf, isDirectlyExecutable } from './entry-form.mjs';
candidateExecutableNames(tool, platform) -> string[]
//   win32: ['dop.exe','dop','dop.cmd','dop.ps1','dop.bat','dop.com']；POSIX: ['dop']
discoverTool({ tool, platform, env, fs, now, maxCandidates, deadlineMs }) -> Discovery
discoverCli({...}) -> { dop, gh }
```
`parsePathVar` / `candidateDirs` / `DISCOVERY_TIERS` / `DEFAULT_MAX_CANDIDATES` / `DEFAULT_DEADLINE_MS` 全部不动。

### 3.3 `cli-config.mjs` 对外契约（签名不变）

```js
validateCliField({ field, value, platform, fs }) -> { ok:true, value } | { ok:false, message }
buildCliPatch({ current, patch, platform, fs }) -> { ok:true, next } | { ok:false, errors }
resolveCliAccess({ config, env, discovery, platform }) -> Access     // 不读盘，行为不变
describeCliAccess(access) -> 脱敏描述                                // 不变
```

**HTTP 面（不变）**：`GET <mount>`（`?refresh=1` 重扫）→ 快照；`POST` → 三键增量 + 六键校验，`200` 成功 / `422 { errors:[{field,message}] }` 逐字段 / `405` / 预检头失败按现有码。浏览器半不发隐藏三键，服务端仍按六键校验并保留补丁层里的其余键。

### 3.4 适配器（新增可选入参，向后兼容）

```js
createDopAdapter({ runner, dopBin, dopEndpoint, now, platform = process.platform })
createGhAdapter({ runner, ghBin, now, platform = process.platform })
```
未启动分支改为：

```js
const spawnFailed = result.exitCode === null || result.exitCode === undefined;
const evidence = failureLine(result);
const line = spawnFailed ? describeSpawnFailure({ bin, platform, evidence }) : evidence;
fail(READ_REASONS.COMMAND_FAILED, `${command} 失败（${spawnFailed ? '未启动' : `退出码 ${result.exitCode}`}）：${line}`,
     { ...context, exitCode: ..., spawnFailed });
```
`platform` 只服务于测试注入 win32（默认值保证现有调用零改动）。

## 4. 前端组件与页面切分（`packages/forge-devops/client.js`）

页面结构与组件不变（`EntryField` / `CandidateList` / `StatusLine`，3 项字段，保存 3 键）：

1. 删常量 `WRAPPER_PATTERN`（`:59`）。
2. 删词表项 `error.wrapperScript` 的中英文两条（`:223`、`:280`）——**成对删除**，避免悬空键；`error.pathLength`/`error.notFound`/`error.timeout` 保留。
3. `validateField`（`:326-329`）入口字段只剩长度分支：
   ```js
   if (field === 'dopBin' || field === 'ghBin') {
     return value.length > MAX_PATH_LENGTH ? 'error.pathLength' : null;
   }
   ```
4. 帮助句 `entry.hint.help`（「选中 {tool} 文件右键 → 复制文件地址」）与占位符**保持现状**，仍不出现 `.exe`；不新增任何后缀相关的黄字/红字（PRD anti-goal 3）。
5. 服务端 422 的 `message` 已经是可直接展示的句子（非 `error.` 前缀），`fieldMessage` 逻辑不变。

## 5. 状态管理

- 页面侧：`staged`/`dirty`/`errors` 三态与 `PAGE_FIELDS` 白名单不变；保存后仍只按 `dopBin`/`ghBin`/`timeoutMs` 组 body。
- 服务端侧：`createCliAccess` 的合并缓存不变；保存成功走 `remerge(row)` 重合并 + 回读，`origin` 仍是 `config`。
- 发现结果：`found` 顺序变化会改变「静默取首个」的落点（`cli-config.layerValue` 取 `found` 首个），这是本需求想要的效果——**同一目录/同一 tier 内原生 `.exe` 抢先**。跨 tier 仍 PATH 优先。
- `ready` 语义（AC-9）：不新增字段、不新增探测；包装脚本静默保存后页面仍显示 `ready`（=入口已解析），真实可运行性留给运行期提示。

## 6. 关键实现点与边界情况

1. **判定顺序**（`checkFieldValue`）：`validateConfigField` 基础规则 → 非路径形态放行 → `probeFile`（存在 → 目录 → 普通文件/执行位，末审走 `isDirectlyExecutable`）。目录判定**在**「普通文件」之前，保证用户拿到「这是目录」而不是「不是可直接执行的文件」。
2. **不回落**：任一层非法即该字段 `value:null` + `invalid` 记录，不静默换下一层（既有语义，别动）。
3. **排序即优先级**：`found` 的候选名序号来自名字表下标，**不复用 PATH 先后**；代价是同 tier 内会忽略 PATH 顺序（用户明确选了 PRD Q3-A：机器上有能跑的 `.exe` 就不该选 shim）。跨 tier 仍 `PATH` 先于 `candidate-dir`。
4. **大小写与去重**：名字比较走既有 `fold`（win32 折叠大小写），`seenFound` 仍按 `dirKey` 去重；`DOP.EXE` 与 `dop.exe` 在同一目录不可能共存，跨目录各自入列但序号相同，靠 `path` 升序稳定。
5. **`.vbs`**：留在 `WRAPPER_SUFFIXES`（运行期提示要覆盖），但**不进候选名表**、也不再进 `rejected`——手工可保存，发现不选。
6. **`rejected` 恒空**：`cli-access.pathEntry` 保持 `rejected: Object.freeze([])` 透传；页面不渲染该键，无需改。
7. **运行期归因不依赖 errno**：`EINVAL`（`.cmd`）与 `ENOENT`（无后缀 shim）走同一分支，只按 `entryFormOf(bin)` + `exitCode === null` 选文案；`EACCES`/其它原生入口失败仍走原证据行（脱敏后）。
8. **脱敏**：`redactPathLike` 覆盖 `C:\...`、`\\server\share\...`、以 `/` 开头的 POSIX 绝对路径；提示行截断 200 字符。**非未启动**的失败分支（退出码非 0）仍回显 CLI 自身 stderr，属既有行为，本轮不动（记风险 R3）。
9. **写动作语义不变**：`spawnFailed → failed（无副作用）`、超时/不确定 → `unknown（转人工、不重放）`，`packages/forge-devops/src/actions.mjs:314-330` 一字不改；新增文案不得包含「重试」字样。
10. **端到端不变**：工具名、参数、门禁动作、审计舱、回滚流程不动；本轮只有「同一入口值从被拒变为可存」。

## 7. 测试策略

| 层 | 文件 | 断言要点 |
|---|---|---|
| 形态单点 | `test/entry-form.test.mjs`（新） | `wrapperSuffixOf` 全表 + 大小写；`entryFormOf` 四形态 × 两平台；`isDirectlyExecutable` win32 六形态（无后缀/`.cmd`/`.ps1`/`.bat`/`.exe`/`.EXE`）全 `true`、目录 `false`；POSIX 执行位矩阵与 r3 一致（含 `.cmd` 仍 `false`）；`describeSpawnFailure` 四段内容（形态/归因/下一步/无路径无 endpoint）、原生入口不套用包装解释、`redactPathLike` 三类路径 |
| 保存 | `test/cli-config.test.mjs` | 12 条非法值表按新口径改写（`.exe` 两条与包装脚本拒收两条改为「合法」或新文案）；6 形态放行表；目录文案 `这是目录，需要指向 dop 本体`；`C:\...\npm\dop` 通过；`buildCliPatch` 逐字回写 + `origin='config'`；422 逐字段且其余字段不丢 |
| 发现 | `test/cli-discovery.test.mjs` | 名字表 6 项；`rejected === []`；两形态并存时 `found[0]` 是 `.exe`（同目录 + 同 tier 跨目录两种构造）；预算/时限用例保留；**模块依赖断言改为 `['node:path','./entry-form.mjs']`** |
| 快照 | `test/cli-access.test.mjs` | `.cmd` 现在进 `candidates` 且 `rejected` 为空；`entry` 键集合不变（AC-9） |
| 页面 | `test/client-shape.test.mjs`、`test/client-rule-parity.test.mjs` | 词表清单去 `error.wrapperScript`；`dop.cmd` 失焦**不**报错且可提交；跨面矩阵里「Win32 必须 .exe」那条允许差异改为「无后缀差异，仅存在性/目录/执行位由服务端判」；`.exe` 路径构造保留但不再承担规则含义 |
| 运行期 | `test/dop-adapter.test.mjs`、`test/gh-adapter.test.mjs` | 注入 `spawn EINVAL`（`.cmd` 桩）与 `spawn ENOENT`（无后缀桩）：`detail.spawnFailed===true`、message 含三段、**不含** `C:\`/endpoint、原生入口不套用；写动作仍 `failed` 不重放 |
| 静默守门 | `test/delivery-selfcheck.test.mjs` | `export const WRAPPER_SUFFIXES` 只在 `entry-form.mjs`；`cli-config.mjs` import 复用；`src/` 无 `shell:true`/`cmd.exe`/`spawn` |

**变异实验（AC-10，两轮）**：`shasum -a 256 packages/forge-devops/src/entry-form.mjs` 记基线 → 把 `isDirectlyExecutable` 的 win32 分支临时改为「必须 `.exe`」→ `node --test packages/forge-devops/test/` 必须红（保存与发现两侧同报）→ 还原 → 哈希逐字节一致 + `git diff` 该文件干净。

**全量门禁**：`node --test packages/forge-devops/test/`、`pnpm check`、`git diff --check`；用例数只增不减、零 `skip`/`todo`。

**静态扫描（AC-6/AC-8/AC-12）**：
```sh
grep -rn "shell[[:space:]]*:[[:space:]]*true\|cmd\.exe /c\|child_process" packages/forge-devops/src
grep -rn "endsWith('\.exe')" packages/forge-devops/src          # 只允许 entry-form 的形态分类
grep -rn "只接受 \`\.exe\`\|只认 \`\.exe\`\|请指向 \`\.exe\`" README.md packages docs/teamflow/memory.md | grep -v docs/teamflow/2026
grep -rn "wrapperScript\|WRAPPER_PATTERN" packages/forge-devops
git status --short
```

## 8. 任务拆分（按文件边界，可并行）

波次：**W1** = T1（单点模块，其它任务的地基）与 T4（页面，独立）；**W2** = T2、T3、T5（各自文件互不相交，只读 T1 的导出）；**W3** = T6（文档 + 收口自检）。

| # | 任务 | 归属文件（含用例） | 依赖 | 验收点 |
|---|---|---|---|---|
| T1 | 入口形态单点模块 | `src/entry-form.mjs`(新)、`test/entry-form.test.mjs`(新)、`test/delivery-selfcheck.test.mjs` | — | 五个导出签名逐字落地；AC-4 单点、AC-5 文案与脱敏的可离线证明 |
| T2 | 保存口径（去后缀、文案去 `.exe`） | `src/cli-config.mjs`、`test/cli-config.test.mjs` | T1 | AC-1、AC-2；`validateCliField` 与 `buildCliPatch` 结论一致、原值逐字 |
| T3 | 发现同口径与 `.exe` 优先 | `src/cli-discovery.mjs`、`test/cli-discovery.test.mjs`、`test/cli-access.test.mjs` | T1 | AC-3；再导出保持契约；`rejected` 恒空；排序用例含双形态并存 |
| T4 | 页面去后缀拦截 | `client.js`、`test/client-shape.test.mjs`、`test/client-rule-parity.test.mjs` | — | AC-7；i18n 成对删除、无悬空键；双面矩阵逐行对齐 |
| T5 | 运行期未启动提示 | `src/dop-adapter.mjs`、`src/gh-adapter.mjs`、`test/dop-adapter.test.mjs`、`test/gh-adapter.test.mjs` | T1 | AC-5、AC-6（不改执行出口）；两适配器共用同一函数 |
| T6 | 文档口径 + 收口自检 | `packages/forge-devops/README.md`、`packages/forge-devops/cordis.patch.yml`（注释）+ 发现问题就地修 | T1–T5 | AC-8、AC-10、AC-11、AC-12；变异两轮；`pnpm check`/`git diff --check`；**只写交付自检结论，不写 QA-REPORT/ACCEPTANCE** |

**从 PRD §10 承接的工程约束（进每个任务 spec，不得丢失）**：分支 `feat/devops-change-flow` 保持不动，不新建/不切换/不 rebase；本阶段**不 commit / 不 push / 不 tag**；不动 r7/r8 两个未跟踪任务夹与他人改动；仓库内不写本机绝对路径与真实用户名（一律 `%APPDATA%\npm\dop`）；不新增依赖、不改 `package.json` 与 `engines`；`.gitignore` 审计（`dist/`、`*.tgz`、`logs/`、`node_modules/`、`.pnpm-store/`、`.DS_Store`、`.env*`、`coverage/`）作为 T6 的独立核对行。

## 9. 风险与未验证项

- **R1 已定位的跨包副本**：`packages/forge-gitee/src/runtime-config.mjs:66-100` 自带 `WRAPPER_SUFFIXES` 与包装脚本拒收，r8 后与 devops 口径不一致（gitee 的 `cliPath` 仍拒 `.cmd`）。本需求不改：跨包 import 源码路径被仓库约定禁止，且 PRD 非目标明确「不改契约面」。作为**独立后续需求**记录，不夹带。
- **R2 排序语义的取舍**：同 tier 内 `.exe` 压过 PATH 先后，可能出现「用户在 PATH 前面放的 `dop.cmd` 不被选中」。这是 PRD Q3-A 的显式选择；若企业反馈相反，只需改名字表次序（单点）。
- **R3 既有行为**：非未启动的失败（退出码非 0）仍原样回显 CLI 的 stderr，可能含绝对路径；本需求只保证新增的未启动提示脱敏。
- **R4 保存变绿但跑不起来**：产品风险的缓解是 AC-5 提示 + README 说明 + `ready` 语义边界；是否再加页面级非阻塞提示仍待用户定（PRD Q2，默认不加）。
- **NOT RUN（验收后人工，M6）**：企业内网 Windows 实机按报障截图复测保存、真实 npm shim 的启动失败提示、真实浏览器走查；本轮证据只到离线桩与组件渲染，不得写成企业已联调。

<!-- meta: summary="把'入口能不能启动'收成宿主侧唯一判定：devops 与 gitee 各自实现两份等价判定（不新增共享包），自动选中、装配准入与自检只认启动侧，包装脚本只可保存不可选中，跨包等价性由根目录交叉对齐测试守住。" -->

基线依赖：[r3 CLI 路径自动发现](../20261029-r3-cli-path-autodiscovery/PRD.md)、[r8 Windows 路径校验](../20261030-r8-win-cli-path-validation/PRD.md)。二者确立了"零子进程发现 + 固定 argv 启动"与"保存侧宽松"，本轮只修正它们之间被放开的**选中**语义，不推翻其结论。

# CLI 入口可启动性收敛（r18）

## 1. 背景

### 1.1 现场

内网 Windows 实测：`dop` 只读命令面失败，失败信封判定入口为**包装脚本**并指引改指原生可执行文件；而 `dop` 全局安装只在前缀目录留下 `dop`（sh 脚本）、`dop.cmd`、`dop.ps1`，真正的原生程序在 `<prefix>\node_modules\@cli-tools\dop\bin\dop.exe`，不在 PATH。用户按提示手工改指该 exe 后 `exit 0`、返回真实平台 JSON。

### 1.2 根因

不是提示不准，而是**两处判定不同源**：

1. `@heluo/forge-devops` 的自动发现只扫 PATH 与候选目录，命中的必然是 shim；名字表里 `.exe` 虽优先，但 PATH 里没有 `.exe`，于是裸名 shim 被选中。
2. 选中判定与保存判定共用 `isDirectlyExecutable`——在 win32 上它对**任何普通文件**返回 true（r8 为放行保存而定），于是 shim 被当成"可用入口"：`dopBin` 取 shim、`ready=true`、readiness 的 `executable` 证据 PASS。
3. 真正启动走 `execFile(bin, {shell:false})`，sh 脚本/`.cmd` 无法启动 → `exitCode=null` → 业务命令面才由失败信封归因。

即：**系统替用户选的入口，和插件实际启动入口的方式，用了两条不一致的规则**；发现层也缺"沿 npm shim 解析到包内原生程序"这一步，用户无法自查。

### 1.3 同类缺陷

`@heluo/forge-gitee` 的 `gh` 同源同症：默认裸名 `gh`（`DEFAULT_CLI_PATH='gh'`）在 Windows 上解析到 shim → `SPAWN_FAILED`；用户手工填 `gh.cmd` 又被保存侧后缀门槛拒收（`runtime-config.mjs` 自带一份 `WRAPPER_SUFFIXES`，与 devops 各存一份），**用户无法自救**。

## 2. 决定（用户 2026-11-17 裁决）

| 项 | 裁决 |
| --- | --- |
| `ready` 语义 | 改为"入口可按本插件启动方式启动"，不再只表示"已解析到路径"（覆盖 r8 AC-9） |
| 自检 | 新增用户点击的启动自检（固定 `--version`、`shell:false`、不进装配期发现） |
| 分发侧 | 先不管（不推动 npm 包改分发形态） |
| gitee | `gh` 同类问题一并修 |

## 3. 方案

### 3.1 判定收口：两包各自实现 + 交叉对齐（裁决 C）

初版把判定收成一个共享支撑包（先例：`@heluo/forge-credentials-keychain`）。2026-11-17 用户二次裁决为**不新增包**：devops 与 gitee 各自保留实现，跨包等价性由根目录测试守住。理由是仓库已有十个包、判定代码量有限，而新增一个包会永久多出一层安装单元与版本节奏。

两份实现同形，各自落在本包内（零依赖、零 IO、纯函数 + 注入式只读 fs）：

- `entry-form.mjs`：`WRAPPER_SUFFIXES`、`ENTRY_FORMS`、`entryFormOf`、`wrapperSuffixOf`、`isStorableEntry`（保存侧：win32 普通文件）、`isSpawnableEntry`（能启动：win32 只认原生；POSIX 普通文件 + 执行位）。
- `entry-path.mjs`：PATH 解析与候选名表。
- `entry-resolve.mjs`：`resolveNpmShim` 有界读 shim（≤16 KiB）抽 `node_modules/<pkg>/<script>`，定位包根并优先 `<pkg>/bin/<tool>.exe`，带路径穿越防护与原因码；`resolveCommandEntry` 统一"显式路径 / 裸名"入口解析，只读、有界、零子进程。

**等价性判据**：`tests/cli-entry-parity.test.mjs` 把两包的词表、形态矩阵（win32 六形态、POSIX 执行位）、npm 布局解析结果、原因码与"是否仍是本包内实现"逐条比对；任一侧单独漂移即失败。代价是改词表要改两处——这是裁决 C 明确接受的成本。

### 3.2 devops 接入

- 发现：`isSpawnableEntry` 通过直接入候选；storable 但为包装形态的，先沿 shim 解析到原生程序，成功则以**原生路径**入候选并标 `resolvedFrom`，失败进 `rejected`（不再静默消失）；排序"解析而来优先 → tier → 候选名下标 → 路径"。
- 选中：discovered 命中只取 spawnable；显式配置/环境变量经 `settleEntry` 落定，解析失败进 `invalid`。`ready = 入口已解析且可按本插件方式启动且无非法项`。
- 指引：只剩包装脚本时输出"未找到可直接启动的 dop · 发现 N 个包装脚本（本插件不经 shell 启动，无法使用）"，并指向 CLI 包内原生程序。
- readiness：`executable` 证据改判 spawnable，包装脚本 FAIL（`NOT_EXECUTABLE`），装配期 fail closed。
- 页面：候选标形态与"由包装脚本解析"，被拒脚本单列，入口卡显示形态 Tag；新增"启动自检"按钮（POST `/api/forge-devops/cli/selfcheck`，GET 一律 405，避免预取触发子进程）。

### 3.3 gitee 接入

`cliPath` 删掉本地后缀表、改由本包 `entry-form.mjs` 判定（保存侧仍拒包装后缀）；新增入口解析，装配期把**解析后的原生 bin** 注入适配器；快照的 `candidates`/`rejected` 由写死空数组改为真实解析结果。不加"检查 Gitee"按钮（`tests/ui-contract.test.mjs` 约定）。

## 4. 验收条件

- **AC-1**：win32 上 `.cmd`/`.ps1`/`.bat`/`.com`/无后缀 shim 仍可保存（不回归 r8 AC-1），但 `isSpawnableEntry` 一律 false。
- **AC-2**：PATH 只有 npm shim、包内含 `bin/<tool>.exe` 时，自动选中返回**原生 exe 路径**并标 `resolvedFrom`；零子进程、零写入。
- **AC-3**：只有 shim 且包内无原生程序时，自动选中不取值，`ready=false`、reason `CLI_NOT_FOUND`，指引提到包装脚本。
- **AC-4**：显式填 shim 路径时，解析成功即落定为原生路径；解析失败进 `invalid` 并给出原因，不静默放行。
- **AC-5**：readiness `executable` 对包装脚本 FAIL，`verdict=fail`；对原生程序 PASS。
- **AC-6**：自检只跑固定 `--version`、`shell:false`、超时 8s；`exitCode===null` → `spawn-failed`，0 → `ok`，非 0 → `nonzero-exit`；非 POST 返回 405；页面结论随入口变化作废。
- **AC-7**：`@heluo/forge-gitee` 同样口径：保存侧仍拒包装后缀（`tests/private-bundle-boundary.test.mjs` 交叉断言不变），装配期用解析后的 bin，`gh` shim-only 时配置面给出可行动原因而非等运行期 `SPAWN_FAILED`。
- **AC-8**：两包的词表、形态矩阵、解析结果与原因码逐条相等（`tests/cli-entry-parity.test.mjs`）；两份实现都在各自包内，不得再引入共享入口包；每包内部只有一份定义。

## 5. 测试

- `tests/cli-entry-parity.test.mjs`（根目录）：两包词表/形态矩阵/解析结论/原因码逐条相等，且两份实现都在包内（不是转发）。
- `packages/forge-devops/test/`：发现 r18 反转用例、选中只取 spawnable、只读面 `rejected` 非空、readiness FAIL、自检报告与 HTTP 路由、页面字典与形状。
- `packages/forge-gitee/test/`：`cli-entry` 解析用例、快照真实候选、装配期注入解析后路径。
- 纪律：删掉一条判据必须能说明为何失效；新增判据须能被变异转红（改回宽松判定应使对应用例失败）。

## 6. 风险与未验证项

- **R1**：`bin/run.js` 外壳会在 stdout 打版本横幅，故解析目标只取**包内原生程序**，不走 JS 外壳；若某 CLI 包不含原生程序，结论只能是"不可直接启动"，不会退化成经 shell 启动。
- **R2**：解析依赖 npm 布局（shim 文本里出现 `node_modules/<pkg>/<script>`）。非 npm 分发的 shim 解析不到时按"未解析"处理，不猜测。
- **R3**：Windows 实机复测属 `NOT RUN`；本轮证据仅限离线单测与本地 Linux/macOS 行为，企业真机复测需另立取证。
- **R4**：gitee 未加页面级自检（UI 契约约束），其可启动性只能在配置面说明与运行期归因。

## 7. 交付物

- `packages/forge-devops/`：`entry-form`/`cli-discovery`/`cli-config`/`cli-access`/`readiness`/`http`/`index`/`client.js`/`package.json` 与测试。
- `packages/forge-gitee/`：`runtime-config`/`cli-entry`/`config-access`/`index`/`package.json` 与测试。
- 文档：两包设计文档与 README、`docs/contracts/dop-cli-spec.md` 附注、`docs/teamflow/memory.md`。

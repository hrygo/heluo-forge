# QA 报告 · r8 Windows 入口路径校验放开（能保存 ≠ 能跑起来）

- 需求：`docs/teamflow/20261030-r8-win-cli-path-validation/PRD.md`（AC-1…AC-12）；架构：同夹 `TECHNICAL.md`
- 被测交付：`feat/devops-change-flow` 工作区未提交改动（16 个改动文件 + 2 个新增文件），产品线 `packages/forge-devops`
- 结论：**可验收**（未发现 P0/P1/P2 缺陷；4 条 P3 观察项见缺陷表，均不阻断）

## 1. 范围与环境

| 项 | 值 |
|---|---|
| 被测范围 | 保存期校验（`src/cli-config.mjs`）、自动发现（`src/cli-discovery.mjs`）、入口形态单点（`src/entry-form.mjs`，新增）、运行期未启动归因（`src/dop-adapter.mjs` / `src/gh-adapter.mjs`）、配置页（`client.js`）、文档口径（`README.md` / `docs/teamflow/memory.md` / `cordis.patch.yml`） |
| 不在范围 | `packages/forge-gitee/**`（跨包口径不一致已登记 TECHNICAL R1）、宿主装载/发布、真实企业 CLI 联调 |
| 宿主 | Darwin arm64，Node v24.13.0，分支 `feat/devops-change-flow`，测试时段 2026-10-30 19:52–20:06 (+08:00) |
| 环境限制 | 沙箱内**无法启动真实浏览器**（Chromium crashpad 需 PROCESS_ALL_ACCESS，被宿主 Low integrity 拒绝；`--no-sandbox`/`--disable-breakpad` 无效）。属宿主限制，**非交付缺陷**；页面端改用 node:vm 装载真实 `client.js` + 既有 DOM 级用例驱动，未阻塞判定 |
| 证据来源类型 | 本地实跑（pnpm check / node --test / 自建核对器 / dev 检查器）、静态审计（grep/源码切片）、夹具注入（假 fs、假 clock、execFile 桩）、历史记录（r6 基线口径，仅用于对照，未作为通过依据） |

## 2. 用例与结果

执行命令与结果（全部本地实跑，退出码为实测）：

| # | 覆盖 | 命令 | 结果 |
|---|---|---|---|
| E1 | AC-10 回归基线 | `pnpm check` | exit 0：docs 71 files/581 表/580 链接 ok；repo 24 entries/641 tracked ok；bundles 8 包/179 文件 ok；version ok；`node --test` 1510 tests / 1507 pass / **0 fail** / 3 skip / 0 todo（≈10.5s） |
| E2 | AC-10 空白卫生 | `git diff --check` | exit 0 |
| E3 | AC-1…AC-9 契约（自建核对器，26 项） | `node logs/teamflow/tf-mvuuvtsy-z0qvk7/scripts/qa-r8-contract.mjs` | exit 0：**26 passed / 0 failed** |
| E4 | AC-5 运行期终态（真实 flow/runner/适配器，仅 execFile 换桩） | `node logs/teamflow/tf-mvuuvtsy-z0qvk7/scripts/dev-r8-t5-spawn-e2e.mjs` | exit 0：4 个终态全通过（`.cmd`+EINVAL / 原生 `.exe`+ENOENT / POSIX 无后缀 / win32 无后缀 shim） |
| E5 | AC-5 适配器 + 写动作终态 | `cd packages/forge-devops && node --test test/dop-adapter.test.mjs test/gh-adapter.test.mjs test/actions.test.mjs test/flow.test.mjs` | exit 0：101/101 |
| E6 | AC-7 页面双面 | `cd packages/forge-devops && node --test test/client-shape.test.mjs test/client-rule-parity.test.mjs` | exit 0：34/34 |
| E7 | AC-1/2/3/4 保存与发现链 | `cd packages/forge-devops && node --test test/cli-config.test.mjs test/cli-discovery.test.mjs test/cli-access.test.mjs test/entry-form.test.mjs test/delivery-selfcheck.test.mjs` | exit 0：103/103 |
| E8 | AC-10 用例数只增不减 | `cd packages/forge-devops && node --test` | exit 0：**496 pass / 0 fail / 0 skip**（r6 基线 477 → 496，只增不减） |
| E9 | AC-10 变异实验 | 备份后把 `src/entry-form.mjs:138` win32 分支改为「必须 `.exe`」→ `cd packages/forge-devops && node --test test/cli-config.test.mjs test/entry-form.test.mjs` | 变异版 exit 1：**2 条转红**（「AC-1 六形态放行」「isDirectlyExecutable：win32 六形态全 true」）；还原后 sha256 `a6c9b76f…d7afad5` 逐字节一致，核对器重跑 26/26 绿 |
| E10 | AC-11 仓库卫生 | `git status --porcelain`，再对 `git diff -U0` 全量反查「本机绝对路径 + 真实用户名」关键词 | 15 个 M + 5 个 `??`（r7/r8 任务夹、`TEAM-FULL-INSTALL.md`、新增 source+test），**无** node_modules/dist/\*.tgz/logs/.DS_Store；diff 中本机绝对路径与实际用户名**零命中**（既有夹具里的用户名属 HEAD 存量，非本次新增） |
| E11 | AC-8 旧口径 | 全库 grep「只接受 .exe / 只认 .exe / 请指向 .exe」（排除 `docs/teamflow/2*`、logs、node_modules） | 用户可见面（src/client.js/README/docs）**零命中**；唯一命中是 `test/cli-config.test.mjs:536` 守门注释自身写着「不许再出现」，见 Q-4 |

逐条验收判定（依据 E3–E9 中的具体断言）：

| AC | 判定 | 关键实测 |
|---|---|---|
| AC-1（P0） | 通过 | 无后缀/`.cmd`/`.ps1`/`.bat`/`.exe`/`.EXE` 六形态 `validateCliField` 与 `buildCliPatch` 均 ok；补丁回写原值逐字（`C:/tools/dop.cmd` 不被改写、大小写不变、不补后缀）；`resolveCliAccess` 中 `origin='config'` |
| AC-2（P0） | 通过 | 不存在→「找不到这个文件」；目录→「这是目录，需要指向 dop 的可执行文件本体」（实测无 `.exe`/`.cmd` 字样）；非普通文件→「不是可直接执行的文件」；空/空白=清层；POSIX 执行位与包装脚本判定与 r3 一致（`.sh` 有执行位放行属既有正确语义）；endpoint/owner/sourceType/timeoutMs 拒绝语义未变；一字段非法→整包拒、只有该字段进 `errors`、无 `next` |
| AC-3（P0） | 通过 | `candidateExecutableNames` win32 = `[.exe, 裸名, .cmd, .ps1, .bat, .com]` 顺序即优先级；跨目录 `C:\a\dop.cmd` 先扫仍让位 `C:\b\dop.exe`（found[0]=.exe）；`rejected` 恒 `[]`（无 `wrapper-script`）；预算 200 目录/250ms 到点即 `truncated` |
| AC-4（P1） | 通过 | `WRAPPER_SUFFIXES=Object.freeze` 与 `isDirectlyExecutable` 全 `src/` 只在 `entry-form.mjs` 定义；`.exe` 字样只剩 `entry-form.mjs:109` 的形态分类；`cli-discovery` 再导出与 `entry-form` 为**同一引用**（`===` 实测） |
| AC-5（P0） | 通过（口径见 Q-1） | 未启动时 message 三段齐全（形态判断「入口是 .cmd 包装脚本」/ 原因归运行时能力「固定 argv 且未经 shell 启动时无法运行，与路径写法无关」/ 下一步「改为原生可执行文件或换安装方式」）；实测不含绝对路径与 endpoint（`<路径>` 脱敏）；原生 `.exe` 失败不套包装解释；判定只依赖形态 + `exitCode===null`，`EINVAL`/`ENOENT` 均覆盖 |
| AC-6（P0） | 通过 | `src/` 仅 `cli-runner.mjs` import `node:child_process` 且唯一 `execFile`，`shell:false`+`windowsHide`+timeout+maxBuffer（1 MiB）；`run()` 实测拒绝 `command` 字段 / 字符串 `args` / `shell:true`（3 条 TypeError，0 次落到 execFile）；无 `spawn`/`execSync`/`cmd.exe`/`shell:true` |
| AC-7（P0） | 通过 | `client.js` 在 vm stub 宿主里真实装载，返回 `{CandidateList,CliEntryField,DevopsSection,StatusLine,apply,inject}`；源码无 `WRAPPER_PATTERN`/`error.wrapperScript`/后缀正则；`validateField` 对 `.cmd`/无后缀/`.ps1`/`.bat`/`.DOP.EXE` 全 `null`，4097 长度→`error.pathLength`，超时边界仍生效；DOM 级用例覆盖「失焦无红字 → 可提交 → 409 保留 staged」 |
| AC-8（P1） | 通过（Q-4 备注） | README 新增「能保存 ≠ 一定能跑起来」；`memory.md` 同主题**替换**（只有 1 行，未追加日志）；`CLI_PAGE_HINT` 仍为「设置 → 企业 DevOps」且 guidance 复用该常量；旧口径用户可见面零命中 |
| AC-9（P1） | 通过 | `Access` 仍 7 键、`entries` 仍 6 字段 `{origin,value,overrides,tool}`，未新增 `executable`/`verified` 类字段；`describeCliAccess` 输出无「可直接执行/已验证」文案；`detail.spawnFailed:true` 保留（写动作据此记 failed） |
| AC-10（P0） | 通过（措辞见 Q-3） | `pnpm check` 与 `git diff --check` 全绿；包内 496 例只增；4 个测试文件按新口径改写而非整段删除（diff 可见负断言替换）；变异实验两处转红且还原 byte-identical |
| AC-11（P1） | 通过 | 本表 E1–E11 逐条含命令/时间窗/宿主版本/目标对象/来源类型；实机与真实 shim 标 NOT RUN（见 §5） |
| AC-12（P1） | 通过 | 分支正确；未触碰 r7/r8 任务夹（仅按契约新增本报告）与他人未跟踪文件；交付面零本机绝对路径/真实用户名；`.gitignore` 覆盖 node_modules(:39)/.pnpm-store(:40)/dist(:41)/\*.tgz(:57)/logs(:81)（实测 `git status` 无这些路径） |

## 3. 架构核查（轻量）

- **蓝图落地**：`src/entry-form.mjs` 已抽出为无 IO 纯模块（仅 `node:path`），导出 7 个符号与蓝图一致（`WRAPPER_SUFFIXES`/`ENTRY_FORMS`/`wrapperSuffixOf`/`entryFormOf`/`isDirectlyExecutable`/`describeSpawnFailure`/`redactPathLike`）；保存侧 `cli-config.mjs:41/:201`、发现侧 `cli-discovery.mjs:47/:307`、两适配器 `dop-adapter.mjs:169`/`gh-adapter.mjs:426` 全部改为消费者，与蓝图「保存/发现/运行期共用一套判定」一致。
- **无重复实现**：`WRAPPER_SUFFIXES`、`isDirectlyExecutable` 在 `src/` 内只有一份定义（E3 的 AC-4 断言）；旧三处后缀判断（cli-config/cli-discovery/client.js）中前两处已删、页面侧删的是 `WRAPPER_PATTERN`。
- **接口一致性（静态 + 运行时双证）**：`flow.mjs` 的 `ports.gh.{readRepository,readIssue,readPr}`、`actions.mjs` 4 处 `assertGh` 名单全部在适配器上真实存在；`readPull` 全仓零引用（蓝图笔误，见 Q-2）；`resolveCliAccess/describeCliAccess/validateCliField/buildCliPatch` 均已导出且参数形状与调用点一致。
- **重复风险（既有，超范围）**：`packages/forge-gitee/src/runtime-config.mjs:66-100` 仍自带 `WRAPPER_SUFFIXES` 与包装脚本拒收，与 `forge-devops` r8 口径不一致；TECHNICAL R1 已登记为独立后续需求，本轮不改（见 Q-3）。
- **未发现明显结构破坏**：`http.mjs`/`index.mjs`/`flow.mjs`/`cli-access.mjs` 零 diff，契约面（6 键、端点/状态码、工具名与参数、门禁）未动。

## 4. 缺陷表

| 编号 | 严重级(P0/P1/P2/P3) | 功能模块 | 复现步骤 | 期望行为 | 实际行为 | 关联验收项 | 检测命令 | 通过判据 |
|---|---|---|---|---|---|---|---|---|
| Q-1 | P3 | 文档口径（PRD AC-5 vs 实现） | 读 PRD AC-5「只读 failed、写动作 unknown 且不重放」，再读 `TECHNICAL.md:61` 与 `src/actions.mjs:321-326` | 需求文档与实现同一口径 | PRD 写「写动作 unknown」，实现/TECHNICAL/r6 用例一致为**写动作也记 `failed`**并带「命令未启动（无副作用）」；实现更严格（确定性无副作用 ⇒ 不需要人工核对），无行为缺陷，仅 PRD 措辞未同步 | AC-5 | `grep -n "写动作 \`unknown\`" docs/teamflow/20261030-r8-win-cli-path-validation/PRD.md && grep -n "classifyWriteError" docs/teamflow/20261030-r8-win-cli-path-validation/TECHNICAL.md` | 两处口径一致（建议下轮改 PRD 为「写动作记 failed（无副作用）」）；本轮任务夹不可变，故仅记录 |
| Q-2 | P3 | 架构（蓝图 api 字段笔误） | 按注入蓝图的 `dop-adapter` api 逐项 grep：`readChange` 有、`readIssue`/`readPull`/`readRepository` 无；`gh-adapter` 的 `readPull` 无（实现为 `readPr`） | 蓝图 api 字段与实现成员名一致 | dop 适配器真实成员为 `readChange/listChanges/capabilities`，issue/PR/repository 只读走 `gh`；`gh` 成员名为 `readPr`（r8 前既有）。所有真实调用点均能解析（`flow.mjs:49-51`、`actions.mjs` 4 处）故非接口断线，属蓝图文档笔误 | AC-4 / 接口一致性 | `grep -rn "readPull" packages/forge-devops/src packages/forge-devops/test` | 期望零命中（现为 exit 1 无输出，已满足）；文档侧待后续把 api 字段改成 `readPr` |
| Q-3 | P3 | 架构（跨包重复实现残留） | `grep -n "WRAPPER_SUFFIXES\|wrapperSuffixOf" packages/forge-gitee/src/runtime-config.mjs` | 全仓入口形态判定单点 | `forge-gitee` 仍自带一份词表与拒收逻辑，与 r8 口径不一致（同形态入口在 gitee 侧仍被拒） | AC-4 | `grep -rn "WRAPPER_SUFFIXES" packages/forge-gitee/src` | 命中数 0（TECHNICAL R1 已登记独立后续需求，本轮明确不改） |
| Q-4 | P3 | 验收口径（AC-10「零 skip」字面） / 旧口径守门注释 | `pnpm check` 汇总行显示 `skipped 3`；`grep -n "请指向 .exe\\|只接受 .exe" packages/forge-devops/test/cli-config.test.mjs` | AC-10 字面要求零 skip；旧口径零命中 | 3 条 skip 均为环境依赖（2 条 install rehearsal 需 dsh+npm，1 条目标 DSH 不在 PATH），r6 基线即存在、非本需求引入；`.exe` 命中仅出现在「不许再出现旧口径」的守门注释里，非用户可见文案 | AC-10 / AC-8 | `pnpm check`（看 `skipped` 行）/ 上述 grep | skip 数 ≤ 基线 3 且不新增；旧口径在 src/client.js/README/docs 零命中（已满足） |

未发现 P0/P1/P2 缺陷。

## 5. 人工补测清单（环境限制，非交付缺陷）

1. **企业 Windows 实机保存复测**：把 dop/gh 入口设为 `C:\…\dop.cmd`、无后缀 npm shim，配置页失焦应无红字、保存成功、`origin=config`；再把入口设为目录/不存在路径，确认文案为「这是目录…本体」/「找不到这个文件」。方法：Windows 10/11 + 真实 dop/gh 安装，浏览器打开 `设置 → 企业 DevOps`。
2. **真实 npm shim 的运行期提示**：在 Windows 上用 npm 全局安装出的 `.cmd`/无后缀 shim 触发一次 `change view`，确认提示三段且不含盘符/endpoint。工具：实机终端 + 插件日志。
3. **真实浏览器走查**（沙箱内 Chromium 无法启动）：3 字段渲染、候选列表展开、`.cmd` 保存成功态、409 revision 冲突保留 staged、骨架屏/状态条配色。工具：非沙箱 Chrome + DevTools。
4. **宿主装载与快照**：`dsh --profile web` 重启后 `GET /api/forge-devops/cli` 的 discovered 列表与 `.exe` 优先顺序、页面标题「企业 DevOps」。
5. **真实企业 dop/gh 联调**：真实 `dop`/`gh` 版本与 `--json` 输出稳定性（r6 既有 NOT RUN 项，本轮未变）。

## 6. 结论

- **功能判定：可验收**。AC-1…AC-12 全部有本地实跑证据；保存口径、发现排序、运行期归因、页面双面、文档口径均按 PRD 落地；变异实验证明判据有牙（2 红 + byte-identical 还原）；用例 496（包内）/1510（全仓）只增不减，0 fail。
- **阻塞项：无**。4 条 P3 观察已入表：Q-1（PRD 措辞与实现差一档，实现更严格）、Q-2（蓝图 api 笔误 `readPull`/`readPr`）、Q-3（`forge-gitee` 跨包重复实现，已登记 R1）、Q-4（AC-10「零 skip」字面 vs 3 条既有环境 skip、守门注释命中旧口径词）。
- **证据纪律**：企业 Windows 实机、真实 npm shim、真实浏览器走查、真实企业 CLI 联调均标 **NOT RUN**，未写成已联调。

<!-- QA stage · r8 · 2026-10-30 -->

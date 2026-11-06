<!-- meta: summary="补齐企业内网验收所需的四件交付物：目标机实测 Node v24.15.0 下可复现且可核验的企业组合包、逐条可执行的验收运行手册（含 rc.3 必然 NOT RUN 预判）、AC 证据表模板，以及 host-probe 两例失败测试的版本门控处置。" -->
# 插件打包硬化与企业内网验收交付物补齐 · PRD

基线依赖：docs/teamflow/20261105-r13-r12-issue-rework/（六成员企业组合包闭包、tarball 无 `workspace:` 协议、安装演练证据不得回退）

取代：docs/teamflow/20261105-r13-r12-issue-rework/#AC-6：将「`pnpm check` 0 新增 skip」收窄为「除 2 个按宿主版本显式跳过的 host-probe 环境用例外，0 新增 skip」；skip 必须带实际宿主版本、目标版本（`.dsh-version`）与 K-1 原因，仍不得静默通过。

## 1. 背景与目标

### 1.1 事实基线

- **打包已可用，但不可核验**：`scripts/build-enterprise-bundle.mjs` 从仓库根构建自包含企业组合包。2026-11-06 本机实测 `node scripts/build-enterprise-bundle.mjs /tmp/r2-bundle-probe` exit 0，产出 `heluo-forge-enterprise-0.1.0.tgz`（124 个文件、6 个包：enterprise 本体 + credentials-keychain/policy/iam/devops/gitee 五成员），SHA-256 `c756e61e79a4f0ea62018d5c3eb87bb537d83a4623b15ab3069b478e9d153cc5`。但：产物没有独立核验入口、没有随附哈希/文件清单；可复现性只在 fixture 测试（`tests/bundle-build.test.mjs`）中验证；本机 Node 为 v24.13.0，既非仓库 pin 的 v24.21.0，也非目标机实测的 v24.15.0。
- **目标环境明确**：仓库 pin 为 `.node-version` = `24.21.0`、`.dsh-version` = `0.2.1-rc.3`、根清单 pnpm `11.28.5`；企业侧 Linux aarch64 目标机经用户确认实测 **Node v24.15.0 + DSH 0.2.1-rc.3**，pnpm 以目标机实测为准，仓库 pin 一律不改。Node 版本以实测 v24.15.0 为验收基准（环境背景见 docs/plans/2026-11-04-iam-dual-platform-acceptance.md §4，本文不写主机名/地址）。
- **验收手册缺位**：docs/operations/README.md 明确运行手册只在能力联调后编写；目前没有可交给执行人逐条照做的企业内网安装/验收手册，验收证据散落在任务夹与计划文档中，格式不一。
- **两例宿主探针测试当前失败**：`node --test tests/host-probe.test.mjs` 在本机 DSH `0.2.1-rc.5` 下 2 fail / 0 pass；探针输出 `probe: 0.2.1-rc.5 | node v24.13.0 | darwin-arm64`、`12/32 checks passed, 1 blocked`，失败明细为 `{"result":{"threw":"Cannot read properties of undefined (reading '0')"...}}`。`tests/host-probe.test.mjs`、`scripts/probe/run-host-probe.mjs`、`scripts/probe/host-probe-plugin.mjs` 相对 `origin/main`（13b4b7d）无差异，干净 `origin/main` 同样复现，非本分支引入。该失败使本机 `pnpm check` 变红，并可能掩盖目标 rc.3 上的真实回归。

### 1.2 目标

让用户能在企业内网按一份手册完成企业组合包的安装与验收，并让“产物是什么、是否被篡改、哪一步通过/未执行”都有可复跑的证据：① 打包脚本在目标机实测 Node v24.15.0 下可重建，产物内容可核验；② 验收运行手册逐条可执行、失败可记账，并预判目标 rc.3 上必然 NOT RUN 的项；③ AC 证据表模板统一记账；④ host-probe 两例失败有明确、可审计的处置结论，且不静默丢失 rc.3 覆盖。

## 2. 用户故事与验收条件

### 2.1 US-1 打包负责人：在目标机实测 Node 版本重建，并能核验产物内容

| 编号 | 优先级 | 验收条件（可测试/可量化） |
|---|---|---|
| AC-1 | P0 | 在目标机实测 Node **v24.15.0**（仓库 `.node-version` 仍为 24.21.0，不改 pin；pnpm 以目标机实测为准，若与 11.28.5 不同同样记录实际值）下从仓库根执行 `pnpm build:enterprise <outdir>`：exit 0，输出恰好一个与包名/版本一致的 `.tgz`；同一工具链、同一源码连续构建两次，两次 tarball 的 SHA-256 相同；构建前后 `packages/**` 的 `git status --short` 为 0 差异。若目标机 Node/pnpm 与本机不同，结果按目标机实测版本记录；本机（v24.13.0）结果不得冒充目标版本通过，未在目标机执行时记 `NOT RUN`。 |
| AC-2 | P0 | 构建在同目录产出 `SHA256SUMS` 与 `bundle-manifest.json`。manifest 至少含：`formatVersion`、`entry`（名称/版本）、`members`（6 个包名/版本）、`toolchain`（node/npm 实际版本）、`tarball`（文件名/SHA-256/字节数）、`files`（逐文件 path/size/sha256/mode，按 path 排序）；不含时间戳、绝对路径、主机名。新增 `pnpm verify:bundle <tarball> [--manifest <manifest>]`：离线执行，exit 0 时打印包数/文件数/总字节；manifest 存在时逐项比对，不一致 exit 1 并指出首个差异。 |
| AC-3 | P0 | 核验器负测全部 exit≠0 且错误定位到具体包/文件：① 改动 tgz 内任一文件 1 字节；② 追加未声明文件；③ 把成员依赖改回 `workspace:*`；④ 删除声明内文件；⑤ 把 bin 模式改为 644；⑥ 打入 `tests/*.test.mjs`。正例：当前真实制品（6 包/124 文件，2026-11-06 实测）通过；`pnpm check:tarballs` 既有规则与结果不回退。 |
| AC-4 | P1 | 构建/核验在 registry 不可达（如 `127.0.0.1:9`）且空 npm cache 下仍成功；目标目录已有同名 tarball 时 exit 1，不覆盖、不残留半成品；构建只写目标目录与 OS 临时目录，不写仓库工作区。 |

### 2.2 US-2 企业验收执行人：按手册逐条执行，知道预期、失败如何记账

| 编号 | 优先级 | 验收条件（可测试/可量化） |
|---|---|---|
| AC-5 | P0 | `docs/teamflow/20261106-r2/RUNBOOK.md` 覆盖：0 前置检查 → 1 产物校验 → 2 目标机重建与比对 → 3 安装 → 4 装载检查 → 5 功能抽查 → 6 升级/回退 → 7 卸载/残留 → 8 证据归档。每步含逐字命令、预期输出关键行与退出码、失败分支与停止/继续判定；预期输出必须标注取证环境（本机 rc.5 / 目标 rc.3 / 未执行）。缺任一步或某步只写“见文档”不计通过。 |
| AC-6 | P0 | 手册定义 PASS/FAIL/NOT RUN/BLOCKED 四种结果的判定与记账字段：步骤号、命令、实际输出摘要、退出码、执行时间、OS/arch、node/pnpm/dsh 版本、来源类型、证据文件路径+SHA-256；NOT RUN 必须写原因类别（宿主版本/平台/企业依赖/权限）；FAIL 后停止该分支并执行回滚，NOT RUN 可继续但不得计入通过。 |
| AC-7 | P0 | `NOT RUN 预判清单` ≥5 条，分“结构性必然 NOT RUN”与“条件 NOT RUN”两类，至少覆盖：`desktop` profile dump（应用独占）、未在目标机执行的 Windows/UOS/Kylin 平台项、需企业 IAM/Gitee/dop/网关/私有 registry 的联调项、Teamflow `stateRoot`/`commitRoot`（宿主不提供）、最小 profile 无 LLM 提供方时的 official-rows 运行时模型面。每条给原因与证据链接；预判不得写成已发生结论，执行后回填实际结果。 |
| AC-8 | P1 | 手册中每条命令二选一：有本机/目标机实测输出，或标 `NOT RUN` 且写原因；不存在“写成预期但从未执行”的第三种状态。可执行命令至少真实执行一次，记录日期、宿主版本、实际输出。 |
| AC-9 | P1 | 手册、模板、示例与证据中不出现真实企业地址、内网 IP/主机名、token/密码、个人绝对路径；示例统一用 `corp.example`、`<profile>` 等占位符；含敏感值的输出在证据中脱敏并注明脱敏规则。 |

### 2.3 US-3 验收负责人：用统一模板记录逐条证据，可审计

| 编号 | 优先级 | 验收条件（可测试/可量化） |
|---|---|---|
| AC-10 | P0 | `docs/teamflow/20261106-r2/AC-EVIDENCE-TEMPLATE.md` 含两部分：① 汇总台账表，列数 ≤10：证据ID、AC、步骤/用例、结果、退出码、环境、来源类型、执行时间、证据文件、备注；② 每个证据一个明细块：完整命令、预期/实际输出摘要、OS/arch、node/npm/pnpm/dsh 版本、tarball SHA-256 与 manifest 摘要、执行人/复核人/日期。汇总表顶部含 PASS/FAIL/NOT RUN/BLOCKED 计数与总判定。 |
| AC-11 | P1 | 模板附填写规则与反例：空单元格不得视为 PASS；NOT RUN 不计通过；mock 不计企业证据；引用旧证据须标日期与版本；附 ≥2 行脱敏示例（一 PASS、一 NOT RUN），示例可被 `ACCEPTANCE.md` 直接引用；用模板能复现本单 ACCEPTANCE 的逐 AC 判定。 |

### 2.4 US-4 维护者：host-probe 两例失败有结论、有处置、不丢覆盖

| 编号 | 优先级 | 验收条件（可测试/可量化） |
|---|---|---|
| AC-12 | P0 | 处置结论文档（写入 `RUNBOOK.md` 或独立 `HOST-PROBE-DISPOSITION.md`）必须含：① 复跑命令与完整失败摘要 `probe: 0.2.1-rc.5 \| node v24.13.0 \| darwin-arm64`、`12/32 checks passed, 1 blocked`、异常文本 `Cannot read properties of undefined (reading '0')`；② 非本分支引入的证据：`git diff --stat origin/main -- tests/host-probe.test.mjs scripts/probe/run-host-probe.mjs scripts/probe/host-probe-plugin.mjs` 为空，且干净 `origin/main`（13b4b7d）同样复现；③ 根因证据（最小复现，或 rc.5 与 rc.3 的 `ctx.tools.execute` 调用形状差异）；④ 影响范围、结论（隔离/修复/版本门控）与后续 issue 链接。只写“环境问题”不计通过。 |
| AC-13 | P0 | 按已确认结论落地版本门控：读取 `.dsh-version` 为目标；`dsh --version` 不等于目标时，两例以 skip 报告，skip 文本含实际版本、目标版本与 K-1 原因；等于目标时照常执行；`DSH_BIN` 仍可指定目标宿主二进制；`DSH_HOST_PROBE_FORCE=1` 可强制在非目标宿主运行（预期失败，用于追踪 K-1）；不得删除/弱化断言、不得移出 `node --test` 自动发现、不得改成静默通过或 `todo`。 |
| AC-14 | P1 | 最终 `pnpm check` exit 0、0 fail；skip 清单逐条列出来源与原因，除 2 个 host-probe 环境门控外 0 新增 skip；目标 rc.3 上两例的执行结果单独记录（本机无 rc.3 时记 `NOT RUN`，不得写成通过）；r13 AC-6 的 skip 口径按头部取代声明收窄并写入验收报告。 |

## 3. 范围与非目标

### 3.1 范围内交付物

| 交付物 | 路径 | 主责阶段 |
|---|---|---|
| 本 PRD | `docs/teamflow/20261106-r2/PRD.md` | PRD |
| 打包脚本硬化 + 产物核验器 | `scripts/build-enterprise-bundle.mjs`、`scripts/verify-enterprise-bundle.mjs`（新建）、根 `package.json` 的 `verify:bundle` | 开发 |
| 核验器正反测试 | `tests/bundle-verify.test.mjs`（新建） | 开发 |
| 企业内网验收运行手册 | `docs/teamflow/20261106-r2/RUNBOOK.md` | 开发/验收 |
| AC 证据表模板 | `docs/teamflow/20261106-r2/AC-EVIDENCE-TEMPLATE.md` | 开发/验收 |
| host-probe 处置结论与门控 | `tests/host-probe.test.mjs`（改）、处置结论文档 | 开发 |
| 验收报告 | `docs/teamflow/20261106-r2/ACCEPTANCE.md` | 验收 |

### 3.2 非目标

- 不修 DSH rc.5 的 `ctx.tools.execute` 兼容（用户已确认 A 方案：版本门控 + 可强制复跑；B 方案不在本单范围）。
- 不做企业 IAM/Gitee/dop/AI 网关/私有 registry 的真实联调，不以 mock/夹具冒充企业证据。
- 不改插件功能、工具数量、六行补丁组合、宿主版本 pin；不发布 npm、不修改 DSH 本体或 fork。
- 不编写 Windows/UOS/Kylin 双端逐条手册（用户已确认 A 方案：以实际将执行的目标机为准，其他平台进 NOT RUN 预判）。
- 不写 host `docs/<role>/`、不改 AGENTS.md、不改历史任务夹；不做 G0–G5 门禁裁决，不解除 r12/r13 阻断。

## 4. 反目标 / anti-goals

以下任一发生，即使 `pnpm check` 全绿、手册“看起来完整”，也应被人工拒绝：

1. **手册的“预期输出”其实是本机 rc.5 / Node 24.13.0 的输出**：执行人在内网目标机（rc.3 / Node v24.15.0）第一条命令就对不上，无法区分“版本差异”与“真实缺陷”。（见 §9 已确认项 1、4）
2. **重建产物的逐文件哈希与交付 tarball 对不上，或核验器只打印 `ok` 不给清单**：执行人必须重装后翻目录才能确认内容，所谓“可核验”不成立。（见 §9 已确认项 3）
3. **任一失败或 NOT RUN 被留空或写成 PASS**，验收报告全绿却没有可复跑的命令、退出码、宿主版本；或汇总表宽到换行后不可读。（约束，无取舍）
4. **为让本机 `pnpm check` 变绿而删除断言、移出自动发现或静默 skip**：目标 rc.3 上的真实回归从此无人发现，门禁变成装饰。（见 §9 已确认项 2）
5. **手册/模板/证据把企业真实地址、凭据、token 或个人绝对路径带进仓库或可分发文档**，导致无法提交或交付。（安全约束，无取舍）

## 5. 交互与执行流程摘要

1. **前置检查**：OS/arch、node/npm/pnpm/dsh 版本、目标 profile 可写、pnpm 可用、磁盘空间；任一不满足 → 记 BLOCKED，不继续安装。
2. **产物校验**：`pnpm verify:bundle` + `SHA256SUMS` 比对；失败 → FAIL 并停止。
3. **目标机重建与比对**：`pnpm build:enterprise` 两次，比较 tarball SHA-256 与逐文件哈希；目标机 Node 与交付工具链不同时只比较逐文件哈希，不比较 tgz 字节。
4. **安装**：`dsh plugin --profile <p> add ./<tarball>`，捕获退出码与安装器输出；缺 pnpm → 记 FAIL 并给出前置修复。
5. **装载检查**：`--dump-config` 核对六行 `insert`（credentials/policy/iam/devops/gitee/skill）与七行官方 `disabled: true`；缺条目与“缺席”分开记账。
6. **功能抽查**：工具枚举、配置页保存/回读、凭据 fail-closed 行为；需企业端点的项标 NOT RUN。
7. **升级/回退/卸载**：以版本号不同的两次构建演练，卸载后检查补丁层与依赖残留（沿用 `pnpm uninstall:devops` 语义，不手删）。
8. **证据归档**：按模板填汇总表与明细块，附 tarball/manifest/日志摘要哈希；执行人、复核人签字。

分支规则：FAIL → 停该分支并按手册回滚；NOT RUN → 继续后续步骤，但在汇总表计数；BLOCKED → 停止依赖该项的后续步骤，其余可继续。

## 6. 优先级与里程碑建议

| 优先级 | AC | 说明 |
|---|---|---|
| P0 | AC-1、AC-2、AC-3、AC-5、AC-6、AC-7、AC-10、AC-12、AC-13 | 没有这些，交付物不成立或门禁不可信 |
| P1 | AC-4、AC-8、AC-9、AC-11、AC-14 | 完整性与可复用性；可与 P0 同批完成 |

| 里程碑 | 内容 | 退出条件 |
|---|---|---|
| M1 打包可核验 | AC-1～AC-4 | 真实制品 124 文件通过核验；6 个负测全红；目标机（v24.15.0）结果 PASS 或如实 NOT RUN |
| M2 手册与模板 | AC-5～AC-11 | 手册每步有命令/预期/退出码；预判清单 ≥5 条；模板含 ≥2 行示例；本机可执行命令有实测记录 |
| M3 处置与门禁 | AC-12～AC-14 | K-1 结论含根因与复现；`pnpm check` 0 fail；skip 清单与取代声明一致；rc.3 结果单列 |

M1 与 M3 改动文件不相交，可并行；M2 依赖 M1 的核验命令定稿后再写手册中的逐字命令。

## 7. 依赖与风险

| 依赖/风险 | 影响 | 缓解 |
|---|---|---|
| 本机无目标机实测的 Node v24.15.0（本机 v24.13.0） | AC-1 无法在本机证明 | 目标机执行并回填；本机只记 NOT RUN；不改 `.node-version` |
| 目标机 pnpm 版本与 11.28.5 不同 | 构建行为/产物字节可能有差异 | 记录实际 pnpm 版本；以退出码与逐文件哈希为准；不改仓库 pin |
| 本机无 DSH rc.3（实测 rc.5） | 宿主相关验收项无法本地执行 | 单列 NOT RUN；`DSH_BIN` 指向目标二进制时可复跑 |
| npm 版本差异改变 tgz 字节 | 跨工具链误判“不可复现” | 跨机只比逐文件哈希与 manifest；同工具链才比 tgz SHA-256 |
| 目标机缺 pnpm 或 profile 不可写 | 安装步骤 exit 127 / 失败 | 前置检查；失败记 FAIL 并给修复命令 |
| 企业端点/凭据缺失 | 联调项无法执行 | 预判清单 + NOT RUN；不以 mock 代替 |
| rc.5 根因比预期深 | 门控可能长期掩盖问题 | 保留强制运行开关；K-1 开 issue；rc.3 实跑必须回填 |
| 模板执行靠人 | 证据不可审计 | 汇总表 + 明细块 + 复核签名；空值不算 PASS |
| 文档散落违反边界 | 评审不可追溯 | 全部产物只写任务夹；memory 按同主题替换“验证基线”一行 |

## 8. 工程约束

- 原始需求未包含分支、提交、标签等工程指令，故无逐字保留项。执行基线：分支 `feat/plugin-workflow-new`，HEAD `4033bdc`，工作区仅 `?? docs/teamflow/20261106-r2/` 未跟踪；不得 `stash`、`reset --hard`、`checkout --` 清理他人改动，不改主工作树；除非用户明确要求，不 commit/push/merge/tag。
- 工具链按 `.node-version`（24.21.0，仓库 pin 不改）、根 `package.json`（pnpm 11.28.5）、`.dsh-version`（0.2.1-rc.3）核对；**验收以目标机实测 Node v24.15.0 与实际 pnpm 版本执行并记录**；本机实测差异（Node 24.13.0、npm 11.6.2、DSH rc.5）如实报告，不自动升级、不改 pin。
- **开发阶段必做：审计并补齐 `.gitignore`**。现有规则已覆盖 `node_modules/`、`.pnpm-store/`、`dist/`、`build/`、`coverage/`、`*.tgz`、`logs/`、`.env*`、密钥、IDE 与 AI 工具目录。本单新增的构建输出（`SHA256SUMS`、`bundle-manifest.json`）必须落在 `artifacts/` 等忽略目录或 OS 临时目录；若新增根级产物，同步补忽略规则。`docs/teamflow/20261106-r2/` 下交付文档不得被忽略。给出 `git check-ignore -v` 命中与 `git status --short` 无构建噪音的核对证据；无缺口则记录“已覆盖”，不为凑改动重写规则。
- 文档只写 `docs/teamflow/20261106-r2/`；memory 只按同主题替换“验证基线”一行（bundle 核验命令、宿主版本门控口径），不追加流水账；不写 host `docs/<role>/`，不改 AGENTS.md 与历史任务夹。
- 测试只用 `node:test` 与现有依赖，离线执行；不得把真实插件装进本机真实 profile，安装演练只允许临时 `DSH_HOME`；不修改 DSH 本体。

## 9. 假设与待澄清

本单无未决项。以下 5 项原为假设/取舍，已由用户于 2026-11-06 确认，作为执行基线：

1. **目标机 Node 版本（已确认）**：企业目标机实测 Node **v24.15.0**，不是仓库 pin 的 24.21.0；仓库 pin 不改，AC-1 按 v24.15.0 执行并记录实际版本。内网 pnpm 版本若与 11.28.5 不同，同样按实测记录、不改仓库固定。
2. **host-probe 处置（已确认）**：采用 A 方案——版本门控 skip，skip 文本写明实际/目标宿主版本与 K-1 原因；目标 rc.3 上照常执行，`DSH_HOST_PROBE_FORCE=1` 可强制复跑。
3. **产物核验形态（已确认）**：采用 A 方案——tarball + `SHA256SUMS` + `bundle-manifest.json` + `verify:bundle` 脚本，支持离线逐文件核验。
4. **手册平台范围（已确认）**：采用 A 方案——只覆盖实际目标机（Linux aarch64 / DSH rc.3 / Node v24.15.0），Windows/UOS/Kylin 等进入 NOT RUN 预判清单。
5. **证据模板形态（已确认）**：采用 A 方案——任务夹 Markdown 汇总表（≤10 列）+ 证据明细块，无额外工具依赖。

## 附录 A：AC 索引

| AC | 交付物 | 判据/命令 |
|---|---|---|
| AC-1 | 构建脚本 | 目标机 v24.15.0 下 `pnpm build:enterprise` ×2，比较 SHA-256 |
| AC-2 | manifest/SHA256SUMS/verify | `pnpm verify:bundle <tgz> --manifest <json>` |
| AC-3 | 核验器负测 | `node --test tests/bundle-verify.test.mjs` 6 负 1 正 |
| AC-4 | 构建边界 | 不可达 registry + 空 cache；重复目标目录 exit 1 |
| AC-5 | RUNBOOK.md | 九段步骤逐条检查 |
| AC-6 | RUNBOOK.md | 结果分类、字段、停止/回滚规则检查 |
| AC-7 | RUNBOOK.md | 预判清单 ≥5 条且分类/证据齐全 |
| AC-8 | RUNBOOK.md | 每条命令有实测输出或 NOT RUN 标注 |
| AC-9 | RUNBOOK/TEMPLATE | 敏感信息扫描与占位符检查 |
| AC-10 | AC-EVIDENCE-TEMPLATE.md | 汇总表列数 ≤10；明细字段齐全 |
| AC-11 | AC-EVIDENCE-TEMPLATE.md | 规则、反例、≥2 示例 |
| AC-12 | 处置结论文档 | 复现命令/输出/根因/影响/issue |
| AC-13 | tests/host-probe.test.mjs | 非目标 skip 文本、目标执行、强制开关 |
| AC-14 | QA/ACCEPTANCE | `pnpm check` 0 fail；skip 清单与取代声明 |

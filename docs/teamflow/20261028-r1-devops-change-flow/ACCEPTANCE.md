# 验收报告 — forge-devops 系统变更全流程（20261028-r1）

> 验收对象：`packages/forge-devops`（@heluo/forge-devops 0.1.0）+ 仓库级闭包/门禁改动 ｜ 任务夹：docs/teamflow/20261028-r1-devops-change-flow/ ｜ 分支 `feat/devops-change-flow` ｜ 日期 2026-10-28 ｜ 验收依据：PRD.md 的 23 条 AC、TECHNICAL.md、架构蓝图（M3 门禁）

## 1. 结论

**通过（✅）**。23 条 AC 逐条有证据：21 条完整覆盖；AC-7/8/9 的真机执行按 PRD 约定归主 agent，验收用隔离 profile 实测等价路径（同一 dsh 0.2.1-rc.2 + 同一闭包 tarball），真机步骤写进 §6。QA 第 3 轮唯一 P1（N-1 补丁层装上不激活）已关闭且有反证，全仓门禁 1076/1076、包级 290/290 全绿。遗留 3 项不阻断：1 项可选能力未接线、1 项测试夹具路径卫生、1 项文档补登记。

## 2. 验收方法与本次复跑

| 命令 | 结果 |
|---|---|
| `cd packages/forge-devops && node --test "test/*.test.mjs"` | 290 pass / 0 fail，exit 0 |
| `pnpm check`（仓库根） | 1076 pass / 0 fail，exit 0（docs/repo/tarball/version 全绿） |
| `node logs/teamflow/<runId>/scripts/qa-mainpath-probe.mjs` | 14/14 ok，exit 0 |
| `bash logs/teamflow/<runId>/scripts/install-load-probe.sh` | `PASS install+load`，exit 0 |
| `bash logs/teamflow/<runId>/scripts/probe-strength.sh` | `STRENGTH ok`（删 catalog 注入后 `boot_err=2`，见 §4） |
| 临时 `DSH_HOME` + `dsh plugin --profile qa add/remove <闭包 tarball>` | add/remove 均 exit 0；`dependencies`+`bundles` 出现→清除 |
| `dsh --profile web --patch packages/forge-devops/cordis.patch.yml --dump-config` | exit 0，含 `id: heluo-policy` / `id: forge-devops` |
| `npm pack --dry-run --json`（包目录） | 22 文件，含 `cordis.patch.yml`、`README.md`、19 个 `src/*.mjs` |
| `node scripts/check-bundle-tarballs.mjs` | `bundles: 7 packed, 146 files`，exit 0 |
| `git diff --check` / `git status --porcelain` | exit 0 / 50 项未提交（交付未提交） |

本轮为只读核查 + 隔离环境复跑，未新增任何源码改动。

## 3. 逐条核对（23 条）

| AC | 判据（PRD 摘要） | 验收证据 | 结论 |
|---|---|---|---|
| AC-1 | 补丁层用包根名、dump 可见 id | 补丁层第一条 `insert` 为 `heluo-policy`、第二条为 `forge-devops`（`name: '@heluo/forge-devops'`）；组合 `--dump-config` exit 0 可见两 id。注：真实 profile 现存 UAT 段会使 `id: forge-devops` 出现两次，真机安装前须先删（§6） | PASS |
| AC-2 | 分发白名单 | `files: ["src","cordis.patch.yml","README.md"]`；`npm pack --dry-run --json` 22 文件含上述全部 | PASS |
| AC-3 | 依赖协议不含 `workspace:` | 闭包 tarball `dependencies: {"@heluo/forge-policy":"0.1.0"}`，包内 `node_modules/@heluo/forge-policy` 在位；`check-bundle-tarballs` 7 包 / 146 文件 ok | PASS |
| AC-4 | 宿主依赖走 optional peer | 本包无 `peerDependencies`、无宿主 bare import（静态扫描 0），`dependencies` 仅策略闭包 → 判据 N/A（无宿主运行期依赖） | PASS（N/A 成立） |
| AC-5 | 产物与源码同步 | 真实 `npm pack` 解开后 19/19 个 `src/*.mjs` 与工作树 sha256 一致（分发即源码，无陈旧 `lib`） | PASS |
| AC-6 | 装载安全 | `node --input-type=module -e "import('./packages/forge-devops/src/index.mjs')"` exit 0（30 个导出）；顶层不访问 `ctx`/env（静态）。注：入口为 ESM（`type: module`），`require()` 不适用，判据以 import 等价实现 | PASS |
| AC-7 | 真实装入 | 隔离 profile：`dsh plugin --profile qa add` exit 0 → `dependencies` 含 `@heluo/forge-devops`、`dsh.profile.bundles` 含包名；真实 web profile 未写入（属主 agent，前置：删 UAT 段） | 隔离 PASS / 真机待人工 |
| AC-8 | 装入后真实加载 | 隔离启动无 `did not activate` / `POLICY_ACTION_UNREGISTERED`；`patch-mount.test.mjs` 3/3（9 工具、门禁放行、审计落账）；`dump-config` 含 id；rc.2 实测、rc.3 `NOT RUN`；真实重启未做（§6） | 隔离 PASS / 真机待人工 |
| AC-9 | 安装带回滚 | 隔离 `dsh plugin --profile qa remove` exit 0，`dependencies`/`bundles` 均清除；真机回滚步骤（remove + bundles 摘除 + UAT 段恢复，备份 `.bak-uat-20261028`）见 §6 | PASS（隔离实测） |
| AC-10 | 唯一入口只要变更号 | 探针 F1 + `entry.test.mjs`：仅收一个变更号；缺参/中文/多参/空 → `MISSING_OR_INVALID` + 期望格式，零流程调用；不按 id 前缀推断 | PASS |
| AC-11 | 上下文卡双来源 | 探针 B2/C1/C2/B4：`change view <id> -j` 按 2026-07-06 字段契约逐条展示；每项带来源+时间；`release_info` 首个非空（ARD222222→US-10002/R20260620002）；配置缺失走 `unknown`+原因；渲染不回显 endpoint/路径；gh 只读。证据来源类型：mock | PASS（mock 实测） |
| AC-12 | 承建不猜 | 探针 C3/B5：候选仅来自 `sub_systems` 与 gh 可见仓库（acme/points-mall、acme/points-mall-web）；多候选 `blocked` + 逐候选证据；blocked 下写动作 `denied` 零调用 | PASS（mock 实测） |
| AC-13 | 澄清单硬门禁/假设 | 探针 D1 + `clarify.test.mjs`：硬门禁仅 `acceptance`/`scope`；≥2 选项、effect 互异、利弊非空、推荐∈选项；0 选项 `NO_OPTIONS` 判不通过；其余进 `H-n` 稳定编号；`confirmClarifySheet` 为人工确认唯一写入口 | PASS |
| AC-14 | 澄清回写门禁内 | dop 无澄清写命令 → `denied` 可见且零调用（探针+用例）；gh issue comment 副本通道未接到工具面（P3-1；PRD 措辞为「可」） | PASS（可选通道未接线，§5） |
| AC-15 | 交付计划逐条映射 | 探针 D2：`gaps=0`、无 `stages` 字段、2 实现项 → 1 Issue + 1 PR，逐条绑验收条件 | PASS |
| AC-16 | 四态+幂等+回读 | 探针 B5：首建 `done` 且回读（objectRef 链接），重复调用 `reused=true`、`creates=1`；四态枚举、幂等键=变更号+对象类型+标题哈希、`unknown` 不重放；真实远端写前展示目标（真机项 §6） | PASS（mock 实测） |
| AC-17 | 提交信息前缀 | `commit-message.test.mjs` + 审查报告 E2E：`PREFIX_MISSING` 拒绝并给期望格式，不自动改写；交付提交本身未发生 | PASS |
| AC-18 | 审查记录绑 sha/模型 | `review.test.mjs` + E2E：`MODEL_TIERS` 四档（deepseek-v4-pro / gpt-6.1-sol / gpt-6-astra / muse-spark-1.3-contributor），降级须明示；AI 与人工分栏、绑 commit、sha 变化 `stale`；PR 评论经门禁。无企业模型调用，真实 review 属使用期 | PASS |
| AC-19 | 不合并、不越权结项 | 静态扫描：适配器与补丁层无 `pr merge`/`issue close`/`gh api`/`release`/`workflow`/`change done`/`change create`；`shell:false`；关闭 Issue 仅 `issueCloseReadiness` 判定不执行 | PASS |
| AC-20 | 完成报告证据纪律 | `report.test.mjs` + E2E：逐条证据、`REPORT_SOURCE_TYPES` 强制 mock/enterprise 分记、UAT `unknown`；关闭就绪=验收通过+PR 合入+无未完成交付+人工确认（E2E `closingMissing=[PR_NOT_MERGED,HUMAN_CONFIRMATION_REQUIRED]`） | PASS |
| AC-21 | UAT/部署只读 | 无部署发起/回滚审批通道；UAT 取不到标 `unknown`；报告只读核对（静态+用例） | PASS |
| AC-22 | 固定白名单/env 注入 | 未配 env → `CONFIG_MISSING` 点名变量、describe 不回显值；`execFile` + `shell:false` + 超时 + 输出上限；`run({bin,args,purpose})` 无通用通道；dop 命令面枚举到函数；补丁层无本机路径；安装不依赖 monorepo（闭包自带策略） | PASS |
| AC-23 | 证据纪律 | `artifacts.test.mjs`：`.dsh-devops/<变更号>/<kind>.md`、六字段 front matter 定序、逃逸拒绝、sourceType 仅 mock/enterprise；写动作回执含目标仓库全名（acme/ard-sdk）与对象链接（`…/issues/99`）；本报告 §7 自带来源类型 | PASS |

## 4. 架构一致性（M3 门禁）

- **蓝图符合度**：18 个既定模块全部在位，导出与蓝图接口逐项一致（runtime-config / cli-runner / dop-adapter / gh-adapter / policy-guard / change-context / repository-resolver / clarify / plan / actions / review / report / commit-message / artifacts / entry / tools / read / index）；`apply` 只做装配（配置→runner→dop/gh→guard→流程→工具/入口）；策略硬依赖与 4 个只读面未变；`read.mjs` 仅增 `COMMAND_FAILED`/`COMMAND_TIMEOUT` 原因码，语义未改。
- **装配顺序正确**：补丁层先 `heluo-policy` 后 `forge-devops`，`inject: ['tools','policy']`；teardown 对称释放（E2E：挂载 9 工具 → 卸载后 0）。
- **N-1 反证**：`probe-strength.sh` 人为删 `config.catalog` 后 `--dump-config` 仍绿（`dump_code=0 ids=2`），但启动 `boot_err=2`，报 `DevopsReadError: POLICY_ACTION_UNREGISTERED: 策略目录缺失或未开放只读动作：change.read, repository.read, issue.read, pr.read` —— 证明「只看 dump-config」会漏，现行「安装+激活」证据链有效，缺陷已由 `patch-mount.test.mjs` 固化为门禁。
- **重复实现检查**：`checkConfirm` 在 `tools.mjs` 与 `actions.mjs` 各一份（参数层 vs 目标层，同一 `CONFIRMATION_REQUIRED`，纵深防御）；`stableStringify`/`clip`/`failureLine`/内联渲染在各模块各一份小工具，语义一致；无契约、幂等键、状态词表的分叉副本——`firstReleaseInfo`、`idempotencyKey`、`CHANGE_ID_PATTERN`、`assertInsideRoot` 各一处权威，`REPORT_ACTION_STATUSES` 为刻意副本且有用例逐值断言。
- **偏差**：新增组合根 `src/flow.mjs` 未登记于 TECHNICAL.md §3 模块表（README「实现状态」已列）——文档补登记，不构成抽象缺失或装配错误。
- **结论**：未发现需要返工的偏离蓝图、重复实现或应抽未抽；既有结构（4 只读工具、`READ_*` 词表、`inject` 形态）未被破坏。

## 5. 不阻断遗留（建议随交付或下轮处理）

1. **P3-1 澄清副本通道未接线**：`index.mjs:269` 的 `clarifyWrite` 硬编码 `denied`，`tools.mjs` 的 `forge_devops_clarify_write` 只收 `target/body`，`flow.mjs` 未暴露 `actions.writeClarification` 的 gh 评论分支。AC-14 必需部分（dop 落 `denied` 可见）成立，PRD 中 gh 副本为「可」，故不阻断。
2. **P3-2 测试夹具含本机绝对路径**：`test/context.test.mjs:244` 使用开发者家目录绝对路径（形如 `<home>/corp/bin/dop`，`:261` 断言复用），违 AGENTS.md §1 占位规则。建议提交前改 `/opt/corp/bin/dop` 等中性占位并同步断言。
3. **flow.mjs 文档补登记**：TECHNICAL.md §3 表末补一行（`src/flow.mjs` 组合根）。
4. 交付未提交（50 项）；提交信息须以 `[变更号]` 开头，由主 agent 执行（AC-17）。

## 6. 人工补测清单（环境限制，非交付缺陷）

| 项 | 判据 | 方法 | 前置 |
|---|---|---|---|
| AC-7 真实装入 | 真实 web profile `dependencies` 出现 `@heluo/forge-devops`，`dsh.profile.bundles` 含包名且 `id` 唯一 | `dsh plugin --profile web add <闭包 tarball 绝对路径>`（dsh 0.2.1-rc.2） | **先删 profile `cordis.patch.yml` 158–180 行的 2026-10-28 `file://` UAT 段**（3 条；备份 `cordis.patch.yml.bak-uat-20261028` 已存在），否则 `id: forge-devops` 重复 |
| AC-8 真实加载 | 重启后启动日志/插件列表出现插件；工具面 9 个（4 只读 + 聚合 + 3 写 + 落盘）；`--dump-config` 中 `id: forge-devops` 唯一 | 重启宿主 + `dsh --profile web --dump-config`；rc.2 实测，rc.3 记 `NOT RUN` | 同上 |
| AC-9 真机回滚 | remove 后从 deps/bundles 摘除；UAT 段按需恢复；宿主可启动 | `dsh plugin --profile web remove @heluo/forge-devops`，装后立即演练 | 安装完成后立刻 |
| 企业 dop/gh 联调 | 真实 endpoint 取数、真实 `gh issue create/comment`（先展示目标仓库与对象、人工确认一次）；证据标 `enterprise` | 企业凭据（当前未注入，`CONFIG_MISSING` fail closed 已验证） | 凭据可用时 |
| UAT/CI/CD 边界 | 只读核对既有流水线，不发起部署 | 企业 CI/CD | 企业环境 |
| 浏览器/视觉 | N/A：纯 host 插件无 UI | — | — |

## 7. 证据纪律声明

- 时间 2026-10-28（Asia/Shanghai）；Node v24.13.0；pnpm 11.28.5；宿主 `dsh` 0.2.1-rc.2（仓库目标 `.dsh-version`=0.2.1-rc.3，升级后补跑）。
- 来源类型：本报告流程证据为 **mock 实测**（dop mock CLI）与 **隔离 profile 实测**（临时 `DSH_HOME` + 闭包 tarball）；**企业实测未做**，不表述为企业已联调。
- 仓库写动作目标为真实远端（gh 已登录），本阶段无真实写发生；真机执行前须展示目标仓库与对象。

验收结论：✅ 通过

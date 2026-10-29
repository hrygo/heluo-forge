# forge-devops 变更全流程交付 · QA 报告（第 3 轮复验）

> 需求夹 `docs/teamflow/20261028-r1-devops-change-flow/` ｜ 分支 `feat/devops-change-flow` ｜ 日期 2026-10-28 ｜ QA 第 3 轮（N-1 修复后复验）

## 1. 结论

**通过，可进入验收。** 第 2 轮唯一 OPEN 的 P1（N-1：分发补丁层缺策略目录，装上即无法挂载）已关闭：补丁层补齐 4 个只读动作 + 内存审计舱，交付自带门禁 `test/patch-mount.test.mjs` 把「分发出去的补丁层必须自洽」固化；隔离 profile 端到端实测「装入 → 启动激活 → 9 工具 → 门禁放行 → 审计落账 → 卸载」全部成立。包级 290/290、仓库级 1076/1076、`pnpm check` exit 0。仍 OPEN 仅 2 项 **P3**（澄清 issue 副本通道不可达、测试夹具含本机绝对路径），不阻断。真实 web profile 的 AC-7/AC-8 属人工项：**安装前必须先删真实 profile 里的 2026-10-28 `file://` UAT 段（当前仍在，实测叠加后 `id: forge-devops` 出现 2 次）**。

## 2. 范围与环境

| 项 | 值 |
|---|---|
| 交付物 | `packages/forge-devops`：19 个 src 模块、20 个测试文件（含本轮新增 `patch-mount.test.mjs`）、`cordis.patch.yml`、`README.md`、`package.json` |
| 运行环境 | Node v24.13.0；pnpm 11.28.5；`dsh` 0.2.1-rc.2（PATH）；仓库 `.dsh-version`=0.2.1-rc.3 |
| 安装探针 | 临时 `DSH_HOME` + `dsh plugin --profile qa add <tarball>`；真实 web profile **未写入**（仅只读组合探测） |
| 边界 | 未重启真实宿主、无企业 dop/gh 凭据、无浏览器（宿主沙箱限制；纯 host 插件无 UI，craft 评审 N/A） |

## 3. 既有 checker / 用例复跑（回归契约，逐项实跑）

| 编号 | 项 | 命令（简） | 本轮结果 |
|---|---|---|---|
| R-1 | 主路径探针 | `node logs/teamflow/tf-mvs2kw8z-teiyf1/scripts/qa-mainpath-probe.mjs` | **PASS 14/14**；`mainPath.reachable=true` |
| R-2 | 装配/卸载 E2E | `node logs/teamflow/tf-mvs2kw8z-teiyf1/scripts/assembly-e2e.mjs` | **PASS** exit 0；`toolsAfterMount=9`、afterTeardown=0、artifacts 3 份 |
| R-3 | 审查/报告 E2E | `node logs/teamflow/tf-mvs2kw8z-teiyf1/scripts/e2e-review-report.mjs` | **PASS** exit 0；`commitRejected: PREFIX_MISSING`；报告终态断言成立 |
| R-4 | **N-1 原文判据** | `bash logs/teamflow/tf-mvs2kw8z-teiyf1/scripts/install-load-probe.sh` | **PASS** 输出 `PASS install+load`，exit 0；无 `POLICY_ACTION_UNREGISTERED`、无 `did not activate` |
| R-5 | 包级套件 | `cd packages/forge-devops && node --test "test/*.test.mjs"` | **PASS 290/290**，0 fail（第 2 轮 287 → +3） |
| R-6 | 全仓门禁 | `pnpm check` | **PASS** 1076/1076，exit 0（docs/repo/tarball/version 均绿） |
| R-7 | 工作区卫生 | `git diff --check`；`git status --porcelain` | **PASS** exit 0；50 行均为源码/文档/日志，噪声目录 0 |

## 4. 本轮新增覆盖面（第 2 轮未覆盖）

第 2 轮只在「模块级装配 + 隔离安装后的 `--dump-config`」验证 AC-1/AC-8，**从未执行「分发出去的补丁层参与真实 profile 组合并真正 mount」这条路径**——而 `--dump-config` 只做组合解析、不做激活，正是它能骗过检查的原因。本轮用 `probe-strength.sh` 反证该检查非空洞：

| 场景 | dump-config | 启动激活 |
|---|---|---|
| 修复后补丁层 | `dump_code=0 ids=2 dump_err=0` | `boot_err=0` |
| 人为删掉 `config.catalog` | `dump_code=0 ids=2 dump_err=0` | `boot_err=2`：`dsh: warning: 1 entry did not activate` + `DevopsReadError: POLICY_ACTION_UNREGISTERED: 策略目录缺失或未开放只读动作：change.read, repository.read, issue.read, pr.read` |

即：**只看 dump-config 必然漏掉 N-1 这一类**，故 AC-8 的证据链改为「安装 + 启动激活」，并由交付测试 `patch-mount.test.mjs`（3 用例）把该形态固化为门禁（解析分发文件本体 → 用其中配置真实装配策略+devops → 断言 9 工具、读经门禁放行、审计有记录 → 全仓扫描任何插入 `@heluo/forge-devops` 的补丁层）。

## 5. 验收条件逐条核对（23 条）

| AC | 判据（简） | 本轮证据 | 结论 |
|---|---|---|---|
| AC-1 | 补丁层用包根名、dump 可见 id | 补丁层 `- id: heluo-policy` + `- id: forge-devops` / `name: '@heluo/forge-devops'`（`cordis.patch.yml:36,47`）；组合 dump 可见两者 | PASS |
| AC-2 | 分发白名单 | `npm pack --dry-run` → 22 文件，含 `cordis.patch.yml`、`README.md`、`src/*.mjs` | PASS |
| AC-3 | 依赖协议 | tarball 无 `workspace:`；`@heluo/forge-policy` 以 bundled 闭包入包（`0.1.0`） | PASS |
| AC-4 | 宿主依赖 | src 无 `@deepseek-ai/*`、无 react 导入（bare host imports=0）→ 无真实宿主依赖，N/A 成立 | PASS |
| AC-5 | 产物与源码同步 | 分发 `src/` 与工作树逐文件 sha256 **19/19 一致**（分发即源码，无 `lib` 陈旧产物） | PASS |
| AC-6 | 装载安全 | `node -e "import('./packages/forge-devops/src/index.mjs')"` exit 0；导出 30 个符号，顶层不触 `ctx`/env | PASS |
| AC-7 | 真实装入 | 隔离 profile：`dependencies` 出现 `@heluo/forge-devops`、`bundles` 含包名（R-4 内完成）；**真实 web profile 待人工**（§8，前置：先删 UAT 段） | 隔离 PASS / 真机待人工 |
| AC-8 | 装入后真实加载 | R-4 `PASS install+load`（rc.2 隔离 profile 实测）；`patch-mount` 断言 9 工具 + 门禁放行 + 审计落账；**重启真实宿主 = NOT RUN** | 隔离 PASS / 真机待人工 |
| AC-9 | 安装带回滚 | 隔离 profile `remove` exit 0，`dependencies` 清空、`bundles` 仅剩基础项；真实 profile 卸载步骤见 §8 | PASS（隔离） |
| AC-10 | 唯一入口只要变更号 | 探针 F1：缺参/中文/多参均 `MISSING_OR_INVALID` + 期望格式，零流程调用 | PASS |
| AC-11 | 上下文卡双来源 | 探针 C1/C2/B4：`release_info` 首个非空（US-10002 / R20260620002）；每项带来源+时间；渲染不回显 endpoint/路径 | PASS |
| AC-12 | 承建不猜 | 探针 C3/B5：多候选 `blocked` + 逐候选证据；blocked 下写动作 `denied` 零调用 | PASS |
| AC-13 | 澄清单硬门禁/假设 | 探针 D1：硬门禁 ≥2 选项、0 选项 `NO_OPTIONS`；`H-n` 稳定编号；确认后 `ready` | PASS |
| AC-14 | 澄清回写门禁内 | dop 无写命令 → `denied` 且零调用（模块级）；issue 副本通道不可达见 P3-1 | PASS（P3 观察） |
| AC-15 | 交付计划逐条映射 | 探针 D2：`gaps=0`、无 `stages`、1 Issue/1 PR | PASS |
| AC-16 | 四态+幂等+回读 | 探针 B5：创建 `done` 回读；重复调用 `reused=true`、`creates=1`；blocked 零调用 | PASS |
| AC-17 | 提交信息前缀 | 用例 `commit-message`：`PREFIX_MISSING` 拒绝并给期望格式，不改写 | PASS |
| AC-18 | 审查记录绑 sha/模型 | 用例 `review` + R-3：AI/人工分栏、模型名+commit、sha 变化 `stale` | PASS |
| AC-19 | 不越权结项 | 静态扫描：`pr merge`/`issue close`/`gh api`/`gh release`/`shell: true`/`execSync` 均 0；`change done` 2 命中均为中文注释与报告边界文案，非命令通道 | PASS |
| AC-20 | 完成报告证据纪律 | 用例 `report` + R-3：逐条证据、mock/enterprise 分记、UAT `unknown`、关闭就绪只判定 | PASS |
| AC-21 | UAT/部署只读 | 用例 + 静态：无部署发起、无第二套流程 | PASS |
| AC-22 | 固定白名单/env 注入 | 用例 `config`/`dop`/`gh`：未配 `CONFIG_MISSING`、describe 不回显、`shell:false`、无通用 `run()`；补丁层不写死本机路径 | PASS |
| AC-23 | 证据纪律 | 用例 `artifacts`：六字段 front matter 定序、逃逸拒绝、来源类型仅 mock/enterprise | PASS |

## 6. 缺陷表（仅本轮仍 OPEN）

| 编号 | 严重级(P0/P1/P2/P3) | 功能模块 | 复现步骤 | 期望行为 | 实际行为 | 关联验收项 | 检测命令 | 通过判据 |
|---|---|---|---|---|---|---|---|---|
| P3-1 | P3 | 澄清回写 / 工具面 | 1) `grep -n "clarifyWrite" packages/forge-devops/src/index.mjs`；2) 观察工具参数 schema | 澄清单副本可经门禁落 gh issue comment，或被显式标注为未接线 | `index.mjs:269 clarifyWrite` 硬编码返回 `denied`；`tools.mjs` 的 `forge_devops_clarify_write` 只收 `target/body`；`flow.mjs` 未暴露该通道 → `actions.mjs` 的 issue 分支不可达 | AC-14（非强制项） | `grep -c "status: 'denied'" packages/forge-devops/src/index.mjs` 与 `grep -n "clarifyWrite" packages/forge-devops/src/flow.mjs` | 前者缩减为 0 或后者新增调用 `writeClarification` 的入口 |
| P3-2 | P3 | 测试夹具（仓库卫生） | `grep -rnE "/Use[s]rs/" packages/forge-devops/test/` | 仓库内不出现本机绝对路径（AGENTS.md §1 用占位） | 2 命中：`test/context.test.mjs:244` 的假命令含开发者家目录绝对路径（`…/corp/bin/dop`），`:261` 的断言复用它 | AC-22 精神（非阻断） | `grep -rnE "/Use[s]rs/" packages/forge-devops/test/ \| wc -l` | 输出 0（改用 `<home>/ci/...` 之类中性占位并同步断言） |

**根因（N-1，已关闭，留档）**：`cordis.patch.yml` 只插 `id`/`name` 不配 `catalog`；`forge-policy` 默认空目录并拒绝挂载。修复后补丁层含四动作（`target`：change/repository/issue/pull-request）+ 内存 `audit`（`allowNonDurable: true`，试点级；生产需注入持久 sink）。

## 7. 第 2 轮缺陷复验对照（对照表，非 OPEN）

| 编号 | round-2 级 | 本轮结论 | 复跑证据 |
|---|---|---|---|
| N-1 | P1 | **已关闭** | R-4 exit 0 `PASS install+load`；`probe-strength.sh` 输出 `STRENGTH ok`（删 catalog → `boot_err=2`，修复后 `boot_err=0`）；`node --test test/patch-mount.test.mjs` 3/3；`pnpm check` exit 0 |

**同类命中计数对比**：修复前「`packages/*/cordis.patch.yml` 中插入 `@heluo/forge-devops` 但缺 `catalog`/`audit`」= **1**（本包自身）；修复后同一扫描 = **0**（`patch-mount.test.mjs` 用例 3 全仓扫描，仅 `.agents/worktrees/` 下的 gitignore 副本除外，不属分发范围）。

## 8. 人工补测清单（环境限制，非交付缺陷）

| 项 | 验收判据 | 方法/工具 | 前置 |
|---|---|---|---|
| AC-7 真实装入 | 真实 profile `dependencies` 出现 `@heluo/forge-devops`，`dsh.profile.bundles` 含包名，且**无重复 id** | `dsh plugin --profile web add <tarball 绝对路径>`；dsh 0.2.1-rc.2 | **必须先删真实 profile `cordis.patch.yml` 第 158–180 行 UAT 段**：当前仍在，3 条 `file://`（`id: forge-policy` / `heluo-uat-reader` / `id: forge-devops`）；实测叠加本包补丁层后 `- id: forge-devops` 出现 2 次（组合输出第 1700、1729 行）。备份 `cordis.patch.yml.bak-uat-20261028`（156 行）已存在，可直接回退 |
| AC-8 重启真实加载 | 重启后启动日志/插件列表出现插件；工具面 9 个（4 只读 + 聚合 + 3 写 + 落盘）；`--dump-config` 中 `id: forge-devops` 唯一 | 重启宿主 + `dsh --profile web --dump-config`；rc.2 实测，rc.3 记 NOT RUN | 同上 |
| AC-9 回滚演练 | `dsh plugin --profile web remove @heluo/forge-devops` 后包从 `dependencies`/`bundles` 摘除，UAT 段按需恢复，宿主可启动 | 同上 CLI；装后立即演练 | 安装完成后立刻 |
| 企业 dop/gh | 真实 endpoint 取数与真实 `gh issue create/comment`（先展示目标仓库与对象、人工确认一次）；证据标 `enterprise`，mock 不得记企业已联调 | 企业凭据（当前未注入，`CONFIG_MISSING` fail closed 已验证） | 凭据可用时 |
| UAT/CI/CD 边界 | 只读核对企业既有流水线，不发起部署、不建第二套流程 | 企业 CI/CD | 企业环境 |
| 浏览器/视觉 | N/A：纯 host 插件无 UI | — | — |

## 9. 架构核对（M3）

- **蓝图符合度**：19 个 src 模块与蓝图一致（15 个流程模块 + index/read/flow/entry 等）；本轮修复只改**分发配置 + 新增门禁测试**，未引入新抽象、未新增重复实现；`runtime-config`/`cli-runner`/`policy-guard`/`artifacts` 的单一出处未被破坏（`assertInsideRoot`、`firstReleaseInfo`、`idempotencyKey` 各一处权威）。
- **接口一致性**：`import('./src/index.mjs')` 解析 30 个导出的组装符号（`apply`/`inject`/`validateConfig`/工具与入口工厂等），无悬空 import；`patch-mount.test.mjs` 用真实策略实例驱动 `apply`，证明装配链 `配置 → runner → 适配器 → guard → flow → 工具/入口` 的调用形状与签名匹配；`probe-strength.sh` 的失败注入落在真实 `apply` 路径上而非 mock 断言。
- **重复实现检查**：`checkConfirm` 在 `tools.mjs` 与 `actions.mjs` 各一份（纵深防御，语义一致）；状态词表两套（`ACTION_STATUSES` 四态 vs 流程态 blocked/stale）未混用；补丁层与 `docs/contracts/engineering-tools.md` 的动作目录靠测试逐条绑定，未互相推断。
- **风险提示（不计缺陷）**：本补丁层与 `forge-enterprise` 补丁层都插入 `heluo-policy`；同一 profile 同时叠加会重复挂载（README 已写"勿叠加"，profile 组合在仓库外，无法机器守卫）。
- **结构健康度**：工具 9 / 入口 1 装配与卸载对称（R-2）；无第二份状态机、无 shell 拼串、禁项 argv 不存在。

## 10. 未验项与限制

- 真实 web profile 安装与宿主重启未执行 → §8（本轮只做只读组合探测，未改动用户 profile）。
- rc.3 未实跑（仓库 `.dsh-version`=rc.3，PATH 为 rc.2）：AC-8 记 rc.2 实测、rc.3 NOT RUN。
- 企业 dop/gh 未联调：所有流程证据均为 mock 实测，不得表述为企业已验证。
- 无 UI/音频/多端：craft 与浏览器矩阵 N/A。
- 本轮未修改交付源码（仅新增 `probe-strength.sh` 于 logs）；工作区 50 项未提交。

<!-- meta: summary="r13 QA：D-1～D-6 的交付面在本地与真实 rc.5 宿主均已取得通过证据（Skill 契约、tarball 闭包、三层单注册、工具面 11、门禁全绿、矩阵夹具 9/9）；但 G0 实测 journal 收口根仍指向主工作树，G1～G5 无解除证据，整体结论为阻断/未完成，不可验收。" -->
# r13 问题返工 · QA 报告

> 执行者：QA（代测，非独立审查）。日期：2026-11-05。被检版本：worktree `wt_c1be52eb5da6`，分支 `feat/plugin-workflow-new`，HEAD `55e964c7d347`，tree `498918e67f7e`，`contentId 77befac8fcaf8c580ed5e8161024ee64edbfc3e92a5535963cfc3e447f1801d3`（`dirty=true`；采样于 20:53，早于本报告写入，本报告自身为未跟踪文档，不改变产品代码差异）。本报告不是验收结论，也不代表企业链路已联调。

## 1. 结论

**阻断 / 未完成。** 本轮返工的六个缺陷（D-1～D-6）在本地与真实 DSH `0.2.1-rc.5` 宿主上均已取得通过证据；但 G0 经本轮实测仍未解除（宿主 journal 的 `workspacePath` 仍指向主工作树，`stateRoot`/`commitRoot` 缺失），G1～G5 也没有新增解除证据。按 PRD AC-15 与 §1.2 的口径，整体只能报未完成/阻断，不得写成关闭、通过或候选状态。

- P0 未达标：AC-9（journal 收口根与授权 worktree 不一致，G0 维持阻断）、AC-10～AC-14（`NOT RUN`，分别受 G1～G5 阻塞）。
- P0 通过：AC-1、AC-2、AC-3、AC-4、AC-6、AC-8、AC-15、AC-16。
- P1 通过：AC-5、AC-7（矩阵真实宿主列如实为 `NOT RUN`）。
- 本报告新增 0 个 close/merge/release 动作，未调用 `change done`，未把返工写成新需求完成。

## 2. 环境与目标版本

| 项 | 值 | 来源类型 |
|---|---|---|
| 宿主 | DSH `0.2.1-rc.5`（`$DSH_HOME` 已安装）；仓库目标 `.dsh-version` 为 `0.2.1-rc.3`，rc.3 未实测 | host-execution / NOT RUN |
| Node / pnpm | `v24.13.0` / `11.28.5`；仓库 `.node-version` 为 `24.21.0`，版本差异如实记录 | local-execution |
| 被检版本 | `commit 55e964c7d347cfd1a89160de8035ebee16992ae9`、`tree 498918e67f7e`、`contentId 77befac8fcaf8c58…`、`dirty=true` | local-execution（真实 git） |
| 工作区 | 22 个已跟踪文件未提交改动 + 13 项新增未跟踪（含包内资源、探针、用例与两个任务夹）；本任务夹 `PRD.md`/`TECHNICAL.md`/`QA-REPORT.md` 未跟踪；`logs/`、`dist/`、`*.tgz` 均被 `.gitignore` 覆盖，未入库 | local-execution |
| 浏览器 | 本交付为插件与 Skill 资源，无可视 UI，未使用浏览器 | N/A |

环境差异说明：安装宿主为 rc.5 而仓库目标为 rc.3；Node 实测 24.13.0 而 `.node-version` 写 24.21.0。两者均未自动升级或修改全局环境，按 AC-14 分列，不写成 rc.3 或企业可用。

## 3. 缺陷返工核对（D-1～D-6）

| 缺陷 | r12 现象 | 本轮实测 | 判定 | 证据 |
|---|---|---|---|---|
| D-1 | `list()` 因 `source` 非字符串抛错；摘要缺 `resourceBase` | 真实 rc.5 `SkillRegistry.list({})` 枚举 `enterprise-clauses`，每项 `source="bundled"`、`resourceBase.kind="directory"` 且路径指向包内 `skills/issue-delivery`，摘要不含正文 | 通过 | `qa-r12-skill-host.mjs` ALL PASS，captures/skill-host.log |
| D-2 | `get(candidate)` 返回 undefined | `provider.get(candidate)` 与 `get(name)` 均返回正文（3884 字节，含流程标题） | 通过 | 同上；安装演练 `installed-skill-get-by-candidate` |
| D-3 | 企业组合缺 DevOps/Gitee 闭包 | `dependencies` 与 `bundledDependencies` 同含五包；tarball 114 文件含两包实体资源；补丁层精确 id 挂载 `forge-devops`、`heluo-gitee` | 通过 | captures/tarball-closure.log；three-layer.log |
| D-4 | 工具面文档仍写 10 个 | 四个指定文件统一 11 个（3 读 + 1 判定 + 4 写 + 2 git + 1 快照），`grep '10 个'` 各 0 命中；`GITEE_TOOLS.length=11` | 通过 | 见 §4 AC-5 |
| D-5 | `pnpm check` 因 docs 主机绝对路径失败 | 仅做等义脱敏与链接形式修复；`check-docs` 111 files / 802 tables / 999 links / 139 fragments / 36 controlled documents，`docs: ok` | 通过 | 见 §8 |
| D-6 | 缺九类场景矩阵 | 探针 9/9 夹具断言通过并输出固定 7 列 9 行表；真实宿主列 `NOT RUN` | 通过 | captures/scenario-matrix.log；§5 |

遗留观察项（P3，不计入本轮缺陷）：`packages/forge-gitee/src/index.mjs`、`packages/forge-gitee/cordis.patch.yml` 与部分测试注释仍写“10 个”，不在 AC-5 指定的四个文件范围，建议后续顺手清理。

## 4. 验收条件逐条（r13 AC-1～AC-16）

| AC | 级别 | 判定 | 证据与命令 | 来源类型 |
|---|---|---|---|---|
| AC-1 | P0 | 通过 | `node logs/teamflow/tf-mw39rd97-pmo6is/scripts/qa-r12-skill-host.mjs` exit 0 ALL PASS：可枚举、摘要无正文、`modelInvocable=false`/`userInvocable=true`、`resourceBase` 指向 `skills/issue-delivery`、`get(candidate)`/`get(name)` 可用；装配单点为 `issue-delivery-skill.mjs:83` 的 `assembleEnterpriseSkills`，`index.mjs` 仅 re-export | host-execution |
| AC-2 | P0 | 通过 | 最终 tarball 114 文件，`SKILL.md`、`references/evidence.md`、`references/handoff.md`、`locale/en.json`、`locale/zh.json`、`icon.svg`、`skills/clauses.json` 全在；`node scripts/probe/run-bundle-install-rehearsal.mjs` 33/33 steps ok（隔离临时目录从 tarball 装入真实 Loader，断言 `resourceBase` 落在已装包内、candidate 形状、`get(candidate)`、卸载清 provider、重复 apply 幂等见 `issue-delivery-skill.test.mjs:111`） | host-execution + local-execution |
| AC-3 | P0 | 通过 | 源码用 `workspace:*`，构建脚本在 tarball 内改写为精确 `0.1.0`；tarball manifest 五依赖、五 bundled、`workspace:/file:/link:` 0 处；补丁 6 行 insert（`heluo-policy`、`forge-devops`、`heluo-gitee` 等精确 id） | local-execution |
| AC-4 | P0 | 通过 | `three-layer: ALL PASS`：dump 三段齐、无 isolate、`heluo-policy` 折叠前 3 行（按 id 折叠后 1 实例）、6 条策略并集逐字一致、官方行 `disabled: true`、loader 折叠后 6 个 id 各一实例 ACTIVE、11 gitee + 4 devops 工具可解析、skill provider 单份、卸载后注册归零；fail-closed 由成员包用例覆盖（`apply.test.mjs:78`、`actions.test.mjs:270`、`security-matrix.test.mjs:296-322`、`switches.test.mjs:26`）；停用只撤该条见 `issue-delivery-skill.test.mjs:127` | host-execution + local-execution |
| AC-5 | P1 | 通过 | 四文件各 0 命中“10 个”，均写 11 个并补快照工具说明（`packages/forge-gitee/README.md:58`、`docs/design/plugins/forge-gitee.md:19/160`、`docs/design/README.md:34/66`、`docs/teamflow/memory.md:24`）；`GITEE_TOOLS.length=11` 实测；设计索引与契约引用一致 | local-execution |
| AC-6 | P0 | 通过 | `pnpm check` exit 0（2727 项、2726 pass、1 skipped、0 fail）；`git diff --check` clean；检查器规则未改、无新增豁免（`scripts/check-docs.mjs` 无 diff）；`.gitignore` 命中 `logs/`、`dist/`、`*.tgz`、`.env`、`node_modules/`，状态无构建产物噪音 | local-execution |
| AC-7 | P1 | 通过（真实宿主列 `NOT RUN`） | `node scripts/probe/run-teamflow-scenario-matrix.mjs` 9/9 fixture assertions ok；`--report` 校验见 §5；每例调用次数期望/实测见 §5.2，真实宿主一律未执行 | fixture + NOT RUN |
| AC-8 | P0 | 通过 | 2727 项 ≥ 2718；唯一 skip 为 `tests/sensitive-scan-windows-paths.test.mjs:43` 的 win32 条件，既有且不在本次 diff；gitee/devops/enterprise `src` 仅两处 `execFile` 导入（`gitee-cli.mjs:30`、`cli-runner.mjs:28`），其余 spawn 命中均为注释/原因码；失败面、写门禁 0 调用、快照 11 工具、`?refresh=1` 重建、卸载幂等、tarball 闭包均有既有用例且全绿 | local-execution |
| AC-9 | P0 | 部分通过（G0 未解除） | 三个错位场景负测 7/7 通过（`node --test tests/teamflow-evidence-tools.test.mjs`）；真实 journal 核对 `journal-roots: mismatch`，`workspacePath` 指向主工作树、`stateRoot`/`commitRoot` 缺失；本轮 0 stash/commit/merge/push | local-execution |
| AC-10 | P0 | NOT RUN | 无目标宿主最终提交模板支持首行 `[变更号]` 的公开契约证据，也未做真实最终提交；G1 维持阻断 | NOT RUN |
| AC-11 | P0 | NOT RUN | 无权威只读来源取得唯一 Issue→变更→仓库关联与要求版本；G2 维持阻断 | NOT RUN |
| AC-12 | P0 | NOT RUN | 未证明既有 run 查询能完整排除更早 run 或明确 `unknown`；G3 维持阻断 | NOT RUN |
| AC-13 | P0 | NOT RUN | 无独立只读审查与写拒绝证据；QA 代测不属于独立审查；G4 维持阻断 | NOT RUN |
| AC-14 | P0 | NOT RUN | rc.3、企业 Gitee/dop、凭据/IAM、受保护仓库规则、Windows/麒麟 aarch64 均未实测；仅本机 rc.5 通过；G5 维持阻断 | NOT RUN |
| AC-15 | P0 | 通过 | 本报告 §10 分列执行结果、候选交付、用户验收、CI、合入、Issue 状态与业务结束；整体结论为阻断/未完成，未写关闭/通过/候选状态；未新增关闭/合并/发版动作 | local-execution |
| AC-16 | P0 | 通过（附注见 §8.4） | 本轮 0 stash、0 commit、0 push、0 merge（reflog 仅 15:55 的 reset，HEAD 未变）；未修改或 fork DSH；`.gitignore` 审计见 §8.3；历史任务夹仅做 F1 等义脱敏（`PRD.md:144` 占位、`ACCEPTANCE.md:63` 保留 1 处合法相对片段链接），因该夹未跟踪、无 git 基线，逐字不变只能按 dev 声明与检查器结果核验 | local-execution |

## 5. 九类场景矩阵

### 5.1 探针原表（报告校验用，7 列 9 行）

| 场景 | 守则 | 夹具结论 | 来源类型 | 真实宿主 | 命令 | 时间 |
|---|---|---|---|---|---|---|
| 首次交接 | 已有 run 先查询；缺依赖即停并列出缺什么；版本以 contentId 为准 | 满足 | fixture | NOT RUN | — | — |
| 同任务重复进入 | 相同 Issue、仓库与要求版本再次进入时先查已有 run，不重复交接 | 满足 | fixture | NOT RUN | — | — |
| 运行中进入 | 运行中只跟踪，不重启、不重放写动作 | 满足 | fixture | NOT RUN | — | — |
| 中断续跑 | 可续跑的原生续跑一次，不自建执行器、不补写状态 | 满足 | fixture | NOT RUN | — | — |
| 已完成再进入 | 已完成先核对版本；completed 只证明执行状态，不证明验证与审查 | 满足 | fixture | NOT RUN | — | — |
| 关联冲突 | 多变更、多仓库或入口冲突时只做只读澄清，不自行挑第一个 | 满足 | fixture | NOT RUN | — | — |
| 版本变化 | 代码或验收要求变化后，旧验证与旧审查不得自动沿用 | 满足 | fixture | NOT RUN | — | — |
| 缺依赖 | 缺哪一项就停在哪一步并说明影响与下一步，不用提示词补齐能力 | 满足 | fixture | NOT RUN | — | — |
| 伪造通过声明 | 未取证的通过声明不得写成已验证；输出是证据摘要不是验收结论 | 满足 | fixture | NOT RUN | — | — |

### 5.2 每例调用次数与证据

说明：真实宿主本轮未创建任何 run（G2/G3 未解除），故“实测”一律为 0 次调用、状态 `NOT RUN`；夹具列只证明随包 Skill 守则存在与矩阵结构完整，不冒充联调结论。证据位置均指 `scripts/probe/run-teamflow-scenario-matrix.mjs` 的 `SCENARIOS` 与 `tests/teamflow-evidence-tools.test.mjs`。

| 场景 | 前置对象/版本 | 期望 start / resume / 写 | 实测（真实宿主） | 关联与要求版本 | 候选资格 | 失败提示与证据位置 |
|---|---|---|---|---|---|---|
| 首次交接 | 已核实 Issue 与仓库（无真实企业对象） | ≤1 / 0 / 0 | 未执行：0 次（NOT RUN） | 需权威关联与要求版本（G2） | 关联已核实才合格 | 缺依赖时停并列出缺项；`SCENARIOS[0]` |
| 同任务重复进入 | 已有 run 与版本映射（无真实映射） | 0 / 0 / 0 | 未执行：0 次（NOT RUN） | 需 Issue→run 映射（G3） | 已有 run 版本一致 | 先查已有 run；`SCENARIOS[1]` |
| 运行中进入 | 运行中 run | 0 / 0 / 0 | 未执行：0 次（NOT RUN） | 需 run 状态与版本（G3） | — | 只跟踪、不重启；`SCENARIOS[2]` |
| 中断续跑 | 可续跑的中断 run | 0 / ≤1 / 0 | 未执行：0 次（NOT RUN） | 需原生续跑状态（G3） | — | 用原生续跑一次；`SCENARIOS[3]` |
| 已完成再进入 | 已完成 run 与旧证据 | 0 / 0 / 0 | 未执行：0 次（NOT RUN） | 需版本核对（G3） | 旧证据不自动沿用 | completed 不等于验证通过；`SCENARIOS[4]` |
| 关联冲突 | 多变更、多仓库或入口冲突 | 0 / 0 / 0 | 未执行：0 次（NOT RUN） | 需权威关联（G2） | 冲突时不合格 | 只读澄清、不挑第一个；`SCENARIOS[5]` |
| 版本变化 | 旧验证/审查 + 新 contentId | 0 / 0 / 0 | 未执行：0 次（NOT RUN） | 需 contentId 对比 | 旧结论不得沿用 | 重新取证；`SCENARIOS[6]` |
| 缺依赖 | 缺插件或 CLI 入口 | 0 / 0 / 0 | 未执行：0 次（NOT RUN） | — | — | 列出缺项、影响与下一步；`SCENARIOS[7]` |
| 伪造通过声明 | 无证据的通过声明 | 0 / 0 / 0 | 未执行：0 次（NOT RUN） | — | — | 输出证据摘要不是验收结论；`SCENARIOS[8]` |

## 6. r12 二十条 AC 重新取证

| r12 AC | 本轮判定 | 依据 |
|---|---|---|
| AC-1 | 通过 | tarball 资源闭包 + 真实 rc.5 宿主可枚举/可读正文（AC-1、AC-2） |
| AC-2 | 通过 | 五依赖与 bundled 同含、补丁精确挂载、单注册与 fail-closed 未回归（AC-3、AC-4） |
| AC-3 | NOT RUN | 缺依赖诊断的真实宿主路径未单独实测 |
| AC-4 | NOT RUN | 无权威 Issue→变更→仓库关联（G2） |
| AC-5 | NOT RUN | 关联冲突负测未在真实宿主执行（G2） |
| AC-6 | 部分通过 | rc.5 Skill 接口实测；Teamflow 原生接口表未取得新证据 |
| AC-7 | NOT RUN | 未在真实宿主启动 Teamflow |
| AC-8 | NOT RUN | 重复进入/续跑只有夹具结论 |
| AC-9 | 部分通过 | 三错位负测 7/7 通过；journal 核对为 mismatch（G0） |
| AC-10 | NOT RUN | 无提交模板公开契约与真实提交（G1） |
| AC-11 | 部分通过 | contentId 快照机制可用；无真实交付记录 |
| AC-12 | 通过（本机） | `pnpm check` 全绿、证据命令见 §8；rc.3 未测 |
| AC-13 | NOT RUN | 无独立只读审查与写拒绝证据（G4） |
| AC-14 | NOT RUN | 版本变化后的重新取证未在真实宿主执行 |
| AC-15 | 通过（报告层） | §10 分列状态、结论如实 |
| AC-16 | 未完成 | G0～G5 未闭合，必需证据缺项 |
| AC-17 | 通过（报告层） | 状态分列、未知保持未知 |
| AC-18 | 通过 | 未验项逐项 `NOT RUN`，受控写/脱敏/审批行为未回归 |
| AC-19 | 部分通过 | 矩阵夹具 9/9；真实宿主列 `NOT RUN` |
| AC-20 | 通过 | 文档同步、gitignore 审计、`pnpm check` 与 `git diff --check` 有实际结果 |

## 7. G0～G5 状态

| 门禁 | 本轮证据 | 结论 |
|---|---|---|
| G0 授权根与机器通道 | 真实 journal `workspacePath` 指向主工作树（与授权 worktree 不一致），`stateRoot`/`commitRoot` 缺失；`journal-roots: mismatch` exit 1；三错位负测 7/7 通过；本轮 0 stash/commit/merge/push | **仍阻断** |
| G1 实际提交首行 | 无公开契约证据，未做真实最终提交；r12 记录安装的 Teamflow 0.3.2 模板固定 `feat:`，本轮未复测 | **仍阻断** |
| G2 权威业务关联 | 无权威只读来源取得唯一 Issue→变更→仓库关联与要求版本 | **未解除** |
| G3 完整既有 run 查询 | 未证明可完整排除更早 run 或明确 `unknown`，无 Issue 幂等键 | **未解除** |
| G4 独立只读审查 | 无独立审查与写拒绝证据；QA 代测不是独立审查 | **未解除 / NOT RUN** |
| G5 目标宿主与企业条件 | rc.3、企业 Gitee/dop、凭据/IAM、受保护规则、Windows/麒麟 aarch64 均未实测；仅本机 rc.5 | **未解除 / NOT RUN** |

## 8. 证据与复跑命令

### 8.1 本轮实际执行（均在授权 worktree 内，exit 0 除注明外）

| 命令 | 结果 | 证据 |
|---|---|---|
| `node logs/teamflow/tf-mw39rd97-pmo6is/scripts/qa-r12-skill-host.mjs` | ALL PASS（真实 rc.5 SkillRegistry） | `logs/teamflow/tf-mw3hury1-cykbxm/captures/skill-host.log` |
| `node scripts/probe/run-bundle-install-rehearsal.mjs` | 33/33 steps ok | captures/install-rehearsal.log |
| `node scripts/probe/run-teamflow-scenario-matrix.mjs` | 9/9 fixture assertions ok | captures/scenario-matrix.log |
| `node scripts/probe/run-teamflow-scenario-matrix.mjs --report docs/teamflow/20261105-r13-r12-issue-rework/QA-REPORT.md` | 9/9 rows, report ok | 见 §8.2 |
| `node scripts/probe/check-teamflow-journal-roots.mjs --journal … --root <授权 worktree>` | mismatch，exit 1（探针设计如此） | captures/journal-roots.log |
| `node --test tests/teamflow-evidence-tools.test.mjs` | 7/7 pass | — |
| `node scripts/check-docs.mjs` | `docs: ok`（111 files / 802 tables / 999 links / 139 fragments / 36 controlled documents） | — |
| `pnpm check` | 2727 项、2726 pass、1 skipped、0 fail，exit 0 | — |
| `git diff --check` | clean | — |
| 三层补丁检查器（自建，`logs/teamflow/tf-mw3hury1-cykbxm/scripts/qa-r13-three-layer.mjs`） | `three-layer: ALL PASS` | captures/three-layer.log |
| tarball 闭包（自建一次性脚本） | 114 文件、资源 0 缺失、五成员、精确版本、0 协议 | captures/tarball-closure.log |

### 8.2 矩阵表校验

`node scripts/probe/run-teamflow-scenario-matrix.mjs --report docs/teamflow/20261105-r13-r12-issue-rework/QA-REPORT.md` 输出 `scenario-matrix: 9/9 rows, report ok`，exit 0。

### 8.3 `.gitignore` 审计命中

| 目标 | 规则 | 命中证据 |
|---|---|---|
| `logs/` | `.gitignore:81` | `git check-ignore -v logs/teamflow/x` |
| `dist/` | `.gitignore:41` | `git check-ignore -v dist/foo.tgz` |
| `*.tgz` | `.gitignore:57` | `git check-ignore -v foo.tgz` |
| `.env` | `.gitignore:22` | `git check-ignore -v .env` |
| `node_modules/` | `.gitignore:39` | `git check-ignore -v node_modules/.pnpm-store` |

`git status --short` 无 `dist/`、`*.tgz`、`logs/`、`node_modules/` 噪音；`--ignored` 计数 6 项。

### 8.4 工作区边界附注

- 本轮 QA 未在主工作树写入任何文件；主工作树现有未跟踪项（`SESSION-HANDOFF.md`、r12/r13 任务夹的 `meta.json`）均为本轮之前流水线既有产物，不是本轮改动。
- 历史任务夹（r12）未跟踪、无 git 基线，“除 F1 等义脱敏与链接形式修复外逐字不变”无法用 diff 独立证明；本轮仅按 dev 声明、`check-docs` 结果与抽样阅读核验。
- `pnpm check` 与 `git diff --check` 在最终代码状态上运行；本报告写入后未再改动产品代码。

## 9. 未验清单

1. 目标宿主 `0.2.1-rc.3` 的 Skill/工具/Teamflow 行为（G5）。
2. 企业 Gitee CLI 与 dop 平台真实只读/受控写、`--json` 字段稳定性（G2/G5）。
3. 凭据/IAM 真实后端、受保护仓库规则、Windows/麒麟 aarch64（G5）。
4. 真实 Teamflow 首次交接、重复进入、续跑、已完成再进入（G2/G3）。
5. 最终提交首行 `[变更号]` 的公开契约与真实提交读取（G1）。
6. 独立只读审查与写拒绝证据（G4）。
7. 宿主 journal 收口根修复后的复核（G0 仍 mismatch）。

## 10. 状态分列

| 维度 | 状态 | 说明 |
|---|---|---|
| 执行结果 | 未完成 / 阻断 | D-1～D-6 交付面通过；G0～G5 未闭合 |
| 候选交付 | 不可验收 | 本报告不是验收结论，不构成候选通过 |
| 用户验收 | 未开始 / 未知 | 未取得用户对实际版本的结论 |
| CI | 未知 | 本地 `pnpm check` 绿，不代表远端 CI |
| 合入 | 未合入 / 未知 | 未提交、未推送、未合并 |
| Issue 状态 | 未知 | 无权威 Issue 关联（G2），未写回任何状态 |
| 业务结束 | 未结束 | 未调用关闭/合并/发版或 `change done` |

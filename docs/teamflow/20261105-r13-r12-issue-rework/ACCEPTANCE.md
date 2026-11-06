<!-- meta: summary="r13 返工验收：D-1～D-6 与 AC-1～AC-8 有实测证据；AC-9 的 journal 收口根仍指向主工作树，AC-10～AC-14 为 NOT RUN，G1～G5 未解除，整体维持阻断，验收不通过。" -->
# r13 问题返工 · 最终验收报告

> 编制：产品验收负责人（代拟）；日期：2026-11-05；依据：[PRD](<PRD.md>)、[技术方案](<TECHNICAL.md>)、[QA 报告](<QA-REPORT.md>)。本报告是机制交付的验收意见，不代写用户确认、企业业务结束或 Issue 关闭。

## 1. 判定摘要

**不具备通过条件，维持阻断。** 本轮针对 r12 验收缺陷 D-1～D-6 的返工已在本地与 DSH `0.2.1-rc.5` 宿主取得可复现证据，AC-1～AC-8 通过；但宿主 journal 的收口根仍指向主工作树、`stateRoot`/`commitRoot` 缺失（AC-9 未达成），AC-10～AC-14 无解除证据（G1～G5 仍阻断）。按 PRD AC-15 与 §10，整体只能报“未完成/阻断”，不得写成通过或待验收候选。

本轮存在真实代码与资源改动，不属于“需求不适用”，判定为**不通过（维持阻断）**；需补齐外部证据后重新验收，不新开需求语义。

## 2. 对象、版本与来源类型

| 项 | 值 | 来源类型 |
|---|---|---|
| 授权 worktree | `.agents/clutch-worktrees/wt_c1be52eb5da6`（分支 `feat/plugin-workflow-new`，工作区脏） | repository-source |
| 交付版本 | commit `55e964c7d347cfd1a89160de8035ebee16992ae9`，tree `498918e67f7e534e00fdc73ab763705ae9ac1f7c`，contentId `77befac8fcaf8c580ed5e8161024ee64edbfc3e92a5535963cfc3e447f1801d3` | repository-source |
| 宿主 | 本机 DSH `0.2.1-rc.5`；仓库目标 `.dsh-version` 为 `0.2.1-rc.3`，rc.3 未实测 | host-execution / NOT RUN |
| 工具链 | Node v24.13.0、pnpm 11.28.5 | local-execution |

## 3. 逐条验收（AC-1～AC-16）

| AC | 级别 | 判定 | 证据（命令 / 结果） | 来源类型 |
|---|---|---|---|---|
| AC-1 | P0 | 通过 | `node logs/teamflow/tf-mw39rd97-pmo6is/scripts/qa-r12-skill-host.mjs` exit 0 ALL PASS：可枚举 `enterprise-clauses`、摘要不含正文、`modelInvocable=false`/`userInvocable=true`、`resourceBase` 指向包内 `skills/issue-delivery`、`get(candidate)`/`get(name)` 均取到 3884 字节正文；装配单点仍为 `assembleEnterpriseSkills` | host-execution |
| AC-2 | P0 | 通过 | `pnpm check:tarballs` → 7 packed / 275 files、ok；企业 tarball 114 文件含 `SKILL.md`、两份 references、locale、icon；`node scripts/probe/run-bundle-install-rehearsal.mjs` 33/33 断言 candidate 形状、`get(candidate)` 与卸载撤注册 | local-execution |
| AC-3 | P0 | 通过 | `packages/forge-enterprise/package.json` 的 `dependencies` 与 `bundledDependencies` 同为五包（含 `@heluo/forge-devops`、`@heluo/forge-gitee`）；`cordis.patch.yml` 六行精确 id（credentials-keychain、policy、iam、issue-delivery-skill、devops、gitee），无 `isolate`；锁文件同步 | repository-source |
| AC-4 | P0 | 通过 | 三层同装 ALL PASS（QA 记录）：`--dump-config` 三段齐、`heluo-policy` 折叠后 1 实例且 6 条策略并集逐字一致、官方账户/模型/凭据行 `disabled: true`、6 个 id 各一实例、11 gitee + 4 devops 工具、卸载归零 | local-execution |
| AC-5 | P1 | 通过（附注） | 四份文档统一 11 个工具、`grep -rn '10 个'` 0 命中、`GITEE_TOOLS.length=11`；快照工具名/用途/空参数/只读说明在包 README 与设计页，设计索引仅述“1 版本快照”未重复工具名，不构成阻断 | local-execution |
| AC-6 | P0 | 通过 | `pnpm check:docs`（112 文件/812 表/999 链接）ok、`pnpm check:repo` ok、`pnpm check:tarballs` ok、`git diff --check` 无输出；QA 全量 `pnpm check` 2727 项/2726 pass/1 skip/0 fail；`scripts/check-docs.mjs` 无 diff、无新增豁免 | local-execution |
| AC-7 | P1 | 通过（真实列 `NOT RUN`） | `node scripts/probe/run-teamflow-scenario-matrix.mjs` → 9/9 夹具断言、7 列 9 行、每例调用次数期望/实测分列，真实宿主列一律 `NOT RUN` | fixture + NOT RUN |
| AC-8 | P0 | 通过 | 2727 项 ≥ r12 基线 2718；唯一 skip 为既有 win32 条件；gitee/devops 源面仅 `execFile`（`gitee-cli.mjs`、`cli-runner.mjs`）；写门禁 0 调用、快照 11 工具与 `?refresh=1`、卸载幂等未回归 | local-execution |
| AC-9 | P0 | 未达成 | 负测 7/7 通过（`node --test tests/teamflow-evidence-tools.test.mjs`）；对当前 run journal 实跑检查：`workspacePath` 落在主工作树、`stateRoot`/`commitRoot` 缺失、判定 `mismatch`；本轮 0 stash/commit/merge/push。收口根仍未与授权 worktree 对齐，G0 维持阻断 | local-execution |
| AC-10 | P0 | NOT RUN | 无目标宿主最终提交模板支持首行 `[变更号]` 的公开契约证据，未做真实最终提交；按 AC 维持阻断并如实报告（G1） | NOT RUN |
| AC-11 | P0 | NOT RUN | 无权威只读来源取得唯一 Issue→变更→仓库关联及要求版本，未产生调用为 0 的冲突负测（G2） | NOT RUN |
| AC-12 | P0 | NOT RUN | 未证明既有 run 查询能完整排除更早 run 或明确 `unknown`，无幂等键证据（G3） | NOT RUN |
| AC-13 | P0 | NOT RUN | 无独立只读审查上下文、被审版本与一次写入被拒证据；QA 代测不构成独立审查（G4） | NOT RUN |
| AC-14 | P0 | NOT RUN | rc.3、企业 Gitee/dop、凭据/IAM、受保护仓库规则、Windows/麒麟 aarch64 均未实测，仅本机 rc.5（G5） | NOT RUN |
| AC-15 | P0 | 通过 | 交付摘要与 QA 报告均按未完成/阻断表述，未出现关闭或通过结论；diff 未新增 close/merge/release 动作，未调用 `change done` | repository-source + local-execution |
| AC-16 | P0 | 通过（附注） | 改动仅在授权 worktree，0 stash/commit/push/merge；主工作树仅既有未跟踪流水线项（`SESSION-HANDOFF.md` 与 r12/r13 的 `meta.json`），非本需求写入；`.gitignore` 命中 `dist/`、`logs/`、`*.tgz`、`.env*`，仓库无 tgz/dist 残留；r12 历史夹整夹未跟踪，F1 只能按检查器与声明核验 | local-execution |

## 4. 架构与结构一致性（M3 质量门）

- **装配单点**：`assembleEnterpriseSkills` 仅在 `packages/forge-enterprise/src/skills.mjs` 定义，`src/issue-delivery-skill.mjs:83` 调用，`src/index.mjs` 仅 re-export；未新增第二加载器，未复制条款资源。
- **工具清单单源**：`GITEE_SNAPSHOT_TOOLS` 由 `packages/forge-gitee/src/gitee-snapshot.mjs` 定义并在 `gitee-tools.mjs` re-export，`GITEE_TOOLS.length=11`，未出现两套清单；快照复用 `runGit` 出口。
- **补丁层与依赖**：六行 insert 精确 id、无 `isolate`；五项 `dependencies` 与 `bundledDependencies` 对齐；与 TECHNICAL 的模块划分一致。
- **结论**：未发现偏离蓝图、重复实现、适配漂移或既有结构破坏，架构侧无返工项；该项不改变总体不通过结论。

## 5. G0～G5 状态

| 关卡 | 状态 | 本轮事实 |
|---|---|---|
| G0 授权根与机器通道 | **仍阻断** | 当前 run journal 的 `workspacePath` 指向主工作树，`stateRoot`/`commitRoot` 缺失；检查器 `mismatch`，三错位负测 7/7 通过 |
| G1 实际提交首行 | **仍阻断** | 无公开契约证据，未做真实最终提交 |
| G2 权威业务关联 | **未解除** | 无权威只读来源的 Issue→变更→仓库关联与要求版本 |
| G3 既有 run 查询 | **未解除** | 未证明可完整排除更早 run 或明确 `unknown` |
| G4 独立只读审查 | **NOT RUN** | 无独立审查与写拒绝证据，QA 代测不算 |
| G5 目标宿主与企业条件 | **NOT RUN** | rc.3、企业 Gitee/dop、凭据/IAM、受保护规则、Windows/麒麟 aarch64 未实测 |

## 6. 独立复核记录

| 命令 | 结果 | 来源类型 |
|---|---|---|
| `node logs/teamflow/tf-mw39rd97-pmo6is/scripts/qa-r12-skill-host.mjs` | ALL PASS，exit 0 | host-execution |
| `pnpm check:docs` | docs: ok（112 文件/812 表/999 链接/139 片段） | local-execution |
| `pnpm check:repo` | repo: ok（24 项/9 包/2 服务/789 文件） | local-execution |
| `pnpm check:tarballs` | bundles: 7 packed / 275 files，ok | local-execution |
| `node scripts/probe/run-teamflow-scenario-matrix.mjs` | 9/9 夹具断言，真实宿主 `NOT RUN` | fixture |
| `node --test tests/teamflow-evidence-tools.test.mjs` | 7 pass / 0 fail | local-execution |
| `node scripts/probe/check-teamflow-journal-roots.mjs --journal <当前 run 记录> --root <授权 worktree>` | `workspacePath` 越界、`stateRoot`/`commitRoot` 缺失、`mismatch` | local-execution |
| `grep -rn '10 个'`（四份 Gitee 文档） | 0 命中 | local-execution |
| `git diff --check` / `git stash list` | exit 0 / 0 条 | local-execution |
| `git status --short` | 改动只在授权 worktree；主工作树仅既有流水线未跟踪项 | repository-source |

说明：全量 `pnpm check`（2727 项、2726 pass、1 skip、0 fail）沿用 QA 在最终代码上的实跑记录，本阶段未重复执行整轮；docs、repo、tarball 三门与宿主检查器已独立复跑。

## 7. r12 基线 20 条 AC 与遗留

- 按 PRD §3.2 映射重新取证：r12 的 AC-18 通过、AC-9/AC-19 部分通过，其余真实交接、关联、提交首行、独立审查、rc.3/企业条件条目仍为 `NOT RUN`；r12 基线不因本轮 AC-1～AC-8 通过而关闭。
- 待补证据：G1 提交模板公开契约与真实提交首行/SHA；G2 权威 Issue→变更→仓库关联；G3 既有 run 完整查询与幂等键；G4 独立只读审查及写拒绝证据；G5 rc.3、企业 Gitee/dop、凭据/IAM、Windows/麒麟 aarch64。
- G0 需在流水线侧修正 journal 收口根到授权 worktree，否则真实 run 仍有向主工作树收口的风险。
- T1（一次性临时 DSH_HOME 做真实装入/卸载/冷启动）与 T2（独立审查是否必须异模型）仍待用户拍板；本轮无真实装入、无独立审查证据。

## 8. 验收意见

本轮返工方向正确、证据真实、未发现越界或伪造；不通过的原因是 P0 阻断项（AC-9 对齐、AC-11、AC-12）仍缺证据，且按 PRD 整体状态只能维持阻断。补齐第 7 节证据后按原任务夹重验即可，无需新开需求。

验收结论：❌ 不通过

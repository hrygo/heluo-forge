# SDD 退出实施计划

## 文档信息

| 项 | 内容 |
|---|---|
| 文档编号 | CORP-DSH-PLAN-009 |
| 文档名称 | SDD 退出实施计划 |
| 版本 | V0.1.1 |
| 文档状态 | 草案 |
| 密级 | — |
| 编制 | 项目负责人（Agent 代拟） |
| 审核 | 待定 |
| 批准 | 待定 |
| 最后更新 | 2026-11-03 |
| 门禁 | 待用户授权实施；退役前完成调用方盘点与回退演练 |

> 编制依据：用户 2026-11-03 最终确认的[需求基线 §2.3](../requirements/requirements-baseline.md#23-issue-交付模型与受控研发目标需求已确认)、[Issue 交付调整方案](../requirements/issue-delivery-adjustment-proposal.md)（V1.0.0 生效）及[SDD 兼容与退役设计](../design/plugins/forge-sdd.md)（DESIGN-008，V0.6.0）。2026-11-03 在本机对仓库、包清单、CI 工作流与已安装 profile 作静态核对，并复跑 `packages/forge-sdd` 用例 27 例；未做企业 CI、真实安装或外部 caller 取证。

> 关联文档：[总体架构 §6／§7.4](../architecture/platform-architecture.md#74-issue-研发交付与-sdd-退役)、[企业组合包设计](../design/plugins/forge-enterprise.md)、[推广实施方案 §4.3／§4.6](../plans/rollout-plan.md)、[文档清单](../DOCUMENT-REGISTER.md)。

## 1. 结论与授权边界

`forge-sdd` 已退出默认 Issue 交付要求，以退役独立组件为目标。本计划只定义**实施顺序、影响面、验证与回退**，不在本轮执行删除、改配置、卸载或停用；每一步落到源码或组合配置前，须由用户按该步骤的授权点逐项确认。用户已产出的清单与产物不随组件删除；已安装的 profile／企业制品不因本计划自动变化。

2026-11-03 用户已选择**方案 A（全量退役）**。删除包目录、构建制品与发布仍按 §4 的授权点分别确认；方案 B 只保留为历史备选。

## 2. 已核实事实与未验项

| 对象 | 已核实（2026-11-03 本机静态＋单测） | 未验 |
|---|---|---|
| [SDD 包](../../packages/forge-sdd/package.json) | 私有包 `@heluo/forge-sdd`，bin `forge-sdd`，仅 `freeze`／`verify`；4 个源文件；27 例单测通过 | 外部 caller、目标仓库 CI 是否调用 |
| [企业组合包](../../packages/forge-enterprise/package.json) | dependencies 与 bundledDependencies 均含 SDD；bin `forge-sdd` 转发 [sdd-cli.mjs](../../packages/forge-enterprise/src/sdd-cli.mjs)；补丁 `insert` 仅 credentials-keychain／policy／IAM 三 Host | 真机安装包体与已发布制品范围 |
| 测试与演练 | [bundle-build](../../tests/bundle-build.test.mjs) 断言闭包含 SDD；[装包演练](../../scripts/probe/run-bundle-install-rehearsal.mjs) 覆盖已安装 bin 的 freeze／verify／篡改夹具及“SDD 不是 Host”负对照 | 演练在本机外的可移植性 |
| CI 与锁文件 | `.github/workflows` 无 `forge-sdd` 引用；`pnpm-lock.yaml` 仅 workspace link | 其他流水线或外部仓库引用 |
| 已安装 profile | 本机 web profile 的 `@heluo` 包仅 devops、gitee，未装 SDD | 其他机器与企业 profile |
| 文档 | 设计索引、登记、架构 §6、SDD 设计、推广方案均已标注退出默认；SDD-001 更名“兼容与退役盘点” | 外部文档副本 |

结论：当前唯一功能性依赖是**企业组合包自包含与装包演练**，没有默认交付流程依赖 SDD。因此移除必须以“先改调用、后删包”的顺序进行，避免留下悬空 bin 或闭包断言。

## 3. 目标状态与两种取舍

**方案 A（默认建议）：全量退役。** 删除 `packages/forge-sdd`、企业组合包依赖与 bin 转发、相关测试断言与演练夹具、锁文件条目，文档改为历史说明。理由是：无默认业务用途，保留即继续制造“第二套校验”的误解。

**方案 B（仅在有明确用途时）：保留最小库。** 只保留 `freeze`／`verify` 作为内部兼容工具，不发布 bin、不进企业组合包、不作为交付门禁；须注明归属与使用方。

选择 B 前必须给出真实使用方、用途与调用证据；否则按 A 执行。

## 4. 实施步骤

### 步骤 0：冻结与基线（只读，无授权点）

1. 记录实施前 `main` 的 SHA、`pnpm check` 结果与 `buildEnterpriseBundle` 产物指纹。
2. 在独立分支实施；不直接改已安装 profile。
3. 保留旧产物归档，供回退对照。

### 步骤 1：先移除调用（授权点 1：源码与包清单）

1. [企业组合包清单](../../packages/forge-enterprise/package.json)：从 `dependencies`、`bundledDependencies` 删除 `@heluo/forge-sdd`，删除 `bin.forge-sdd`。
2. 删除 [sdd-cli.mjs](../../packages/forge-enterprise/src/sdd-cli.mjs)。
3. 调整 [bundle-build 测试](../../tests/bundle-build.test.mjs)（闭包含成员断言）与 [装包演练](../../scripts/probe/run-bundle-install-rehearsal.mjs)：
   - 移除已安装 bin 的 freeze／verify／篡改夹具；
   - 保留或改写“SDD 不是 Host”的负对照（若包已删除，负对照改为断言补丁不含 SDD 行／依赖）；
   - 更新演练记录项与预期条数。
4. 更新 `pnpm-lock.yaml`（`pnpm install --lockfile-only`）与包间测试预期。

验证：`node --test tests/bundle-build.test.mjs tests/bundle-closure.test.mjs`、`node --test "packages/forge-enterprise/test/*.test.mjs"`、`node scripts/check-repo.mjs`。

### 步骤 2：删除包与清理引用（授权点 2：删除目录）

1. `git rm -r packages/forge-sdd`（含 src、test、README）；如选方案 B，改为保留 `src/manifest.mjs`、`src/freeze.mjs` 并单独成包说明。
2. 全库检索 `@heluo/forge-sdd`、`forge-sdd`、`sdd-cli`、`freeze --root` 等残留，逐项确认无悬空引用。
3. 更新根 [README](../../README.md)、包说明与导航中指向 SDD 的链接（改为历史说明或移除）。

验证：`node scripts/check-docs.mjs`、`node scripts/check-repo.mjs`、`pnpm pack` 的 bundle 闭包检查。

### 步骤 3：打包与安装演练（授权点 3：构建企业制品）

1. `buildEnterpriseBundle()` 生成新版本包；确认成员清单不含 SDD、`cordis.patch.yml` 仍只有三 Host。
2. 在隔离目录跑安装／升级／回退／卸载演练；确认无 `forge-sdd` bin、无残留文件、卸载后注册面清空。
3. 记录包体版本、文件数与闭包检查结果；不改用户真实 profile。

验证：`node --test tests/bundle-closure.test.mjs`、`scripts/probe/run-bundle-install-rehearsal.mjs`（若环境具备）。

### 步骤 4：文档与登记（授权点 4：文档同步）

1. 更新 [设计索引](../design/README.md) SDD 行为“已退役（历史）”；[文档清单](../DOCUMENT-REGISTER.md) 将 DESIGN-008／SDD-001 置为“已废止／历史”，版本递增。
2. 在 [SDD 兼容与退役设计](../design/plugins/forge-sdd.md) 增加“已退役”结论与日期，保留历史依据与兼容语义说明；架构 §6／§7.4 与推广方案 §4.3 同步。
3. 不写修订记录表；版本与历史由 Git 承担。

验证：`node scripts/check-docs.mjs`、`node --test tests/check-docs.test.mjs tests/register-consistency.test.mjs`。

### 步骤 5：发布与回退（授权点 5：发布，另行授权）

1. 按企业发布流程提交 bundle 版本与说明；不自动部署、不自动改已安装 profile。
2. 回退：对实施提交 `git revert`（或恢复到步骤 0 基线），重新构建上一版本包；已安装实例回装旧制品。用户产物不删除。
3. 回退演练至少覆盖：bin 消失、闭包检查、装包脚本、文档链接。

## 5. 待用户决策点

1. ~~选 A（全量退役）还是 B（保留最小 freeze/verify 库）？~~ 已于 2026-11-03 选定 **A（全量退役）**；方案 B 不再作为默认备选。
2. 删除包目录，还是保留 `packages/forge-sdd` 但移出组合包作为历史归档？
3. 是否同步处理已安装 profile／已发布制品（默认不动）。
4. 实施授权范围与时间窗口（源码、制品、发布分别授权）。

## 6. 验收标准

- `pnpm check` 全绿，`git diff --check` 干净。
- 企业组合包依赖、bin 与闭包均不含 SDD；安装演练无 `forge-sdd` bin。
- 文档登记、索引、架构与推广方案一致；SDD-001 与 DESIGN-008 状态与实际一致。
- 回退演练通过，且未删除任何用户产物或已安装实例。
- 全程未把本地演练写成企业 CI 或生产验证。

## 7. 风险与未验

- **外部 caller 未知**：其他仓库或流水线可能仍调用 `forge-sdd`；移除前须检索并确认。
- **已发布制品**：历史 bundle 已含 SDD；退役不追溯已安装实例，需单独决定是否推送替换。
- **企业 CI**：本机无企业流水线证据；`.github/workflows` 无引用不等于外部 CI 无调用。
- **Teamflow 兼容**：内部 PRD／阶段是否仍引用旧冻结清单未实跑，退役后须回归。
- 本计划不改变任何默认开关、权限或已安装 profile；这些动作仅在第 5 节授权后执行。

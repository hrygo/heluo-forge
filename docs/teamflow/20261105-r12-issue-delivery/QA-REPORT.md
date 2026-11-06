<!-- meta: summary="r12 QA：快照工具主路径真实可用（11 工具/版本语义/插件装配集成全绿），但正式企业 Skill 在真实 DSH rc.5 宿主的 provider 契约上不可枚举且正文取不到；企业组合闭包与文档同步未完成。结论：不可验收，6 项缺陷（P1×3、P2×3），AC-1/2/16 未达标，AC-4~10/13/14 仍未验。" -->
# r12 单 Issue 可信待验收交付 · QA 报告

> 执行者：QA（代测，非独立审查）。日期：2026-11-05。被检版本：worktree `wt_c1be52eb5da6`，分支 `feat/plugin-workflow-new`，HEAD `55e964c7d347`，`contentId 1fa12b2b0839fc34`（`dirty=true`，改用例/新增文件已计入）。本报告不是验收结论，也不代表企业链路已联调。

## 1. 结论

**不可验收。** 版本快照（第 11 个 gitee 工具）实现质量可用：真实 git 仓库语义、失败面、唯一执行出口、插件装配集成均实测通过；但**正式企业研发 Skill 在真实宿主上不可用**（宿主 `list()` 直接抛错、`get()` 永远取不到正文），企业组合闭包与文档同步也未按 PRD/蓝图完成。按 PRD AC-16 口径，必需证据缺项只能报"未完成"，不得称待验收候选。

- P0 未达标：AC-1（Skill 不可发现/不可取正文）、AC-2（组合未补齐 DevOps/Gitee）、AC-16（必需证据缺）；AC-4~10、AC-13、AC-14 为 `NOT RUN`，不能计入通过。
- P1 未达标：AC-19（无 9 类场景矩阵）、AC-20（文档未同步且 `pnpm check` 红）。
- 通过：AC-11（快照机制）、AC-12（本地验证口径）、AC-18（未验项逐条标 NOT RUN）。

## 2. 环境与目标版本

| 项 | 值 | 来源类型 |
|---|---|---|
| 宿主 | DSH `0.2.1-rc.5`（`$DSH_HOME` 已装包 `@deepseek-ai/dsh-skill@0.2.1-rc.5`）；仓库目标 `0.2.1-rc.3` **NOT RUN** | host-execution |
| Node / pnpm | `v24.13.0` / `11.28.5` | local-execution |
| 被检版本 | `workspaceId ws-b26f8e99a246b94c`、`commit 55e964c7d347cfd1a89160de8035ebee16992ae9`、`tree 498918e67f7e`、`contentId 1fa12b2b0839fc34…`、`dirty=true` | local-execution（真实 git） |
| 工作区状态 | 未提交改动 13 个已跟踪文件 + 12 个新增包内文件（另有本任务夹 4 篇文档未跟踪）；`logs/` 被 `.gitignore:81` 覆盖，无 `dist/`、`tgz/`、缓存入库 | local-execution |
| 浏览器 | 本交付无可视 UI（插件 + Skill 资源），不需要浏览器 | N/A |

## 3. 架构与接口一致性核查（强制项）

蓝图 `logs/teamflow/tf-mw39rd97-pmo6is/blueprint.json` 已注入，逐项比对：

| 蓝图要求 | 实际 | 判断 |
|---|---|---|
| `issue-delivery-skill.mjs` 导出 `name='enterprise-issue-delivery'`、`inject=['skills']`、`apply(ctx)` | 一致（另有 `SKILL_PREFIX`/`RESOURCE_BASE`/`INVOCATION` 导出） | 通过 |
| `skills.mjs` 增加 `resourceBase` 参数并"按已核实的宿主契约实现 lookup 兼容" | **未改该文件**；候选不带 `resourceBase`、`source`，`get` 只认 name | **偏离（D-1/D-2）** |
| `package.json` 依赖/bundledDependencies 纳入 `forge-devops`、`forge-gitee` | 仍只有 credentials-keychain/policy/iam 三包 | **偏离（D-3）** |
| `cordis.patch.yml` insert 既有 `forge-devops`、`heluo-gitee` | 只插 credentials/policy/iam + 新 Skill 行（4 行） | **偏离（D-3）** |
| `gitee-snapshot.mjs`：`createGiteeSnapshotReader`/`snapshotToolDefinitions`/工具名 | 名称、签名、返回形状一致 | 通过 |
| `clauses.json` schema、SKILL 权限 `modelInvocable=false/userInvocable=true`、locale/icon/exports | 一致；图标与品牌源逐字节相同（`d10020ea…b6696`） | 通过 |

接口一致性（静态，逐个成员真实导入）：`issue-delivery-skill.mjs` 引用的 `assembleEnterpriseSkills`、`dispose`、`registered/bodyFor` 均存在；`index.mjs` 引用的 `createGiteeSnapshotReader`、`GITEE_SNAPSHOT_TOOLS`、`snapshotToolDefinitions` 均存在且签名匹配；`runGit({args,purpose,cwd})` 与 runner 实际返回字段（`exitCode/stdout/stderr/timedOut/truncated`）一致。**唯一不匹配在宿主 Skills 服务这一侧**：宿主 `SkillRegistry.get()` 调 `provider.get(candidate, options)`（`dsh-skill/lib/index.js:268`），而交付只实现 `get(name)`。

重复实现检查：快照不另起子进程（`grep -E "import.*child_process"` 零命中），复用 `gitee-cli.mjs` 唯一出口；未发现第二份安全包装/存放/适配器。轻微重复：`GIT_SNAPSHOT_NO_WORKSPACE` 字面量在 `gitee-snapshot.mjs` 与 `index.mjs` 两处各写一次（P3，未单列缺陷）。

## 4. 用例与结果

自建探针（均为真实执行，非存在性检查）：

| 命令 | 退出码 | 断言 | 结果 |
|---|---|---|---|
| `node logs/teamflow/tf-mw39rd97-pmo6is/scripts/qa-r12-mainpath.mjs` | 1 | 7 项：A 宿主 SkillRegistry / A2 provider 形状 / B 快照真实 git / B2 不确定面 / C 工具层 / D 插件装配集成 / C2 随包资源 | 5 通过 2 失败（A/A2，即 D-1/D-2） |
| `node logs/teamflow/tf-mw39rd97-pmo6is/scripts/qa-r12-skill-host.mjs` | 1 | 真实宿主 `list()`/`get()`/candidate 必填字段 | 4 项失败（D-1/D-2） |
| `node scripts/probe/run-bundle-install-rehearsal.mjs` | 0 | 安装/升级/回退 24 步、真实 Loader 上入口 ACTIVE | 24/24，但其 Skill 断言用 `get('名字')`，未覆盖宿主真实调用形状 |
| `node --test` | 0 | 全仓用例 | 2718 项，2717 通过、0 失败、1 跳过（既有 `win32` 平台跳过） |
| `pnpm check` | 1 | 文档 + 仓库 + tarball + 版本 + 全量用例 | 停在 docs：1 error（D-5） |
| `node scripts/check-docs.mjs` | 1 | 文档结构/链接/受控文档 | 1 error：`PRD.md:144` 主机绝对路径 |
| `node scripts/check-repo.mjs` / `check-bundle-tarballs.mjs` | 0 / 0 | 仓库 24 项入口、7 个 bundle 235 文件 | 通过 |
| `git diff --check` | 0 | 空白错误 | clean |

验收条件逐条（20 条）：

| AC | 结果 | 依据 |
|---|---|---|
| AC-1 | **失败** | tarball 含 `skills/`、两个 references、locale、icon（`npm pack --dry-run` 82 文件）；但真实宿主 `SkillRegistry.list()` 抛 `non-string source`、`get()` 返回 undefined（D-1/D-2） |
| AC-2 | **失败** | 组合仍 3 包、4 行 insert，未纳入 DevOps/Gitee；冻结的旧目录/行禁用未变（D-3） |
| AC-3 | 阻塞 | 依赖/短路文本齐备（SKILL.md 依赖表），但入口在宿主不可用，诊断无法触发；企业依赖未实测 |
| AC-4~AC-9 | NOT RUN | 需真实 Issue/变更/仓库与原生 Teamflow；HOST-VERIFICATION G2/G3 未解除，本轮 0 次启动/续跑/写 |
| AC-10 | NOT RUN | 已装 Teamflow 0.3.2 `commit.final` 固定 `feat:`（HOST-VERIFICATION G1），未做真实提交 |
| AC-11 | 机制通过 | 快照真实绑定本轮 `commit/contentId/dirty`，结果无绝对路径；审查/验证记录随版本的绑定待后续阶段 |
| AC-12 | 通过（门禁除外） | 2718/2717/0；新增用例 0 失败、0 新跳过；`pnpm check` 红见 D-5 |
| AC-13 | NOT RUN | 委派深度 0，无可写拒绝实测，无独立只读审查 |
| AC-14 | NOT RUN | 版本失效规则只在 Skill 文本中，未做切换/改码后的实测 |
| AC-15 | 待验收阶段 | 交付摘要由 ACCEPTANCE 出具 |
| AC-16 | **未达标** | AC-1/2 失败、AC-13 缺；按本 AC 只能报未完成 |
| AC-17 | 部分 | 本报告已分列执行/候选/未验；用户验收/CI/合入/Issue 状态未知 |
| AC-18 | 通过 | 企业 CLI/凭据/IAM/Windows/麒麟逐条 NOT RUN，未改写为企业可用 |
| AC-19 | **失败** | 无 9 类场景可复跑矩阵（D-6） |
| AC-20 | **失败** | 文档仍写 10 个 gitee 工具（15 处），`pnpm check` 非绿；`.gitignore` 审计与 tarball/dist/logs 不入库已核 |

功能细节（快照工具，全部真实执行）：干净仓库 `succeeded`、`commit` 等于真实 HEAD、`contentId` 64 hex 且结果不含主机绝对路径、盘符或 UNC 前缀；未暂存/暂存/未跟踪/可执行位/重命名/删除各自改变 `contentId`，还原后回到原值；空 HEAD→`failed/EMPTY_HEAD`，非仓库→`failed/NOT_A_REPOSITORY`，gitlink→`failed/UNSUPPORTED_ENTRY`；采样期间变化→`unknown/CONCURRENT_CHANGE`，截断/超时→`unknown`；两次采样共 16 条命令且全部命中 8 条固定只读白名单；linked worktree 与主目录 `workspaceId` 不同；插件 `apply()` 装配后 11 个工具、快照工具排在 8，参数表为空且 `additionalProperties:false`，`resolveCwd` 缺失时 `failed/NO_WORKSPACE` 且零子进程。

## 5. 缺陷表

| 编号 | 严重级 | 功能模块 | 复现步骤 | 期望行为 | 实际行为 | 关联验收项 | 检测命令 | 通过判据 |
|---|---|---|---|---|---|---|---|---|
| D-1 | P1 | 架构（企业 Skill 分发） | 用真实宿主 `SkillRegistry`（rc.5）注册后 `await registry.list({})` | 枚举出 `enterprise-issue-delivery`（摘要、不含正文、`resourceBase` 指向包内 `skills/`） | 宿主抛 `TypeError: skill provider "enterprise-clauses" returned skill "enterprise-issue-delivery" with a non-string source`，该层技能目录整体不可枚举 | AC-1、AC-2、AC-16 | `node logs/teamflow/tf-mw39rd97-pmo6is/scripts/qa-r12-skill-host.mjs` | 退出码 0 且输出 `PASS D-1 可枚举`、`PASS D-1 resourceBase`（candidate 需带 `source` 与 `resourceBase`） |
| D-2 | P1 | 架构（企业 Skill 分发） | 同上，`await registry.get('enterprise-issue-delivery')`；并检查 provider 自身两种参数 | 按需返回正文与 `references` 可解析 | `registry.get()` 返回 undefined：provider 的 `get` 只认字符串 name，宿主传 candidate 对象（`dsh-skill/lib/index.js:268`）；离线夹具与安装演练都按 name 调用，故假绿 | AC-1、AC-16 | `node logs/teamflow/tf-mw39rd97-pmo6is/scripts/qa-r12-skill-host.mjs` | 退出码 0 且 `PASS D-2 按需取正文`、`PASS D-2 provider 依据`（`get(candidate)` 可用） |
| D-3 | P1 | 架构（企业组合闭包） | 读 `packages/forge-enterprise/package.json` 依赖与 `cordis.patch.yml` insert 行，对照蓝图 api 与 TECHNICAL §4.2「3 扩为 5 个企业依赖包」 | 依赖与 bundledDependencies 含 `@heluo/forge-devops`、`@heluo/forge-gitee`；patch insert `forge-devops`、`heluo-gitee` | 依赖仅 3 包；insert 仅 credentials/policy/iam/Skill 4 行；装企业组合后本链路所需读面仍缺 | AC-2、AC-16 | `grep -Eq "forge-devops" packages/forge-enterprise/package.json && grep -Eq "heluo-gitee" packages/forge-enterprise/cordis.patch.yml` | 退出码 0 |
| D-4 | P2 | 文档（口径同步） | 全库检索 gitee 工具面数字 | 文档写 11 个工具（含快照），与 `GITEE_TOOLS` 一致 | `packages/forge-gitee/README.md`、`docs/design/plugins/forge-gitee.md`、`docs/design/README.md`、`docs/teamflow/memory.md` 共 15 处仍写「10 个」，快照工具无任何文档入口 | AC-20、AC-11 | `grep -rn "10 个" packages/forge-gitee/README.md docs/design/plugins/forge-gitee.md docs/design/README.md docs/teamflow/memory.md \| wc -l` | 输出 `0`（改为 11 个并补快照工具说明） |
| D-5 | P2 | 文档/门禁 | `node scripts/check-docs.mjs`（`pnpm check` 第一步） | `docs: 0 error(s)`，`pnpm check` 全绿 | 1 error：`PRD.md:144` 授权原文含主机绝对路径，`pnpm check` exit 1 | AC-20、AC-12 | `node scripts/check-docs.mjs` | 退出码 0 且输出 `docs: 0 error(s)`（需用户决定：脱敏授权原文，或为授权引文提供检查器例外，不改写引用语义） |
| D-6 | P2 | 验收举证 | 检查任务夹内是否存在 AC-19 的 9 类场景矩阵 | 存在矩阵：9 类场景各列计数、关联/版本、候选资格、夹具与真实宿主分列 | 无矩阵文件，`packages/`、`tests/` 也无对应场景用例，`TECHNICAL.md:226` 只有一句验收要求 | AC-19 | `node -e "const fs=require('fs');const d='docs/teamflow/20261105-r12-issue-delivery';const keys=['正常首次交接','相同任务重复进入','运行中进入','中断续跑','已完成再进入','关联冲突','版本变化','缺依赖','伪造通过'];const hit=fs.readdirSync(d).filter(f=>f.endsWith('.md')&&!['PRD.md','TECHNICAL.md'].includes(f)).some(f=>{const t=fs.readFileSync(d+'/'+f,'utf8');return keys.every(k=>t.includes(k))});process.exit(hit?0:1)"` | 退出码 0 |

## 6. 未验（NOT RUN）与人工补测清单

| 项 | 原因 | 补测方法/工具 |
|---|---|---|
| 真实 profile 装入/卸载企业组合 | 不装当前 profile（不替换 GUI/不动宿主） | 按 AC-11 的 `dsh --profile <p> --patch packages/forge-enterprise/cordis.patch.yml`，装后 `--dump-config` 与 `skill` 目录枚举，再按包 README 卸载并回读；先写明卸载命令 |
| 真实冷启动无警告零残留 | 需重启宿主 | 冷启动后 `dump-config` 计数本插件行 =1、无悬空 id，`skills` 目录可枚举；人工执行 |
| 真实企业 Gitee/DevOps 读、凭据与 IAM | 无企业对象/凭据 | 用真实 Issue+变更跑 `forge_gitee_issue_read`/`forge_devops_change_context`，核对唯一关联 |
| 原生 Teamflow 启动/查询/续跑与提交前缀 | 0 次启动（按设计） | 真实宿主跑 9 类场景，核对 start/resume/write 计数与提交首行 `[变更号]`；目标 rc.3 另测 |
| 独立只读 AI 审查（AC-13） | 本轮深度 0，无可写拒绝实测 | 由独立只读上下文审查本版本并留写拒绝证据 |
| Windows/麒麟 aarch64 | 无目标机 | 真机跑包内用例与 git 快照 |
| 企业组合真实安装后 `source`/`get` 修复后的宿主行为 | 依赖 D-1/D-2 修复 | 修复后重跑 `qa-r12-skill-host.mjs` 与安装演练（演练需改用 candidate 调用） |

## 7. 证据与复跑

- 主路径探针：`logs/teamflow/tf-mw39rd97-pmo6is/scripts/qa-r12-mainpath.mjs`（exit 1，A/A2 失败，其余 5 项通过）。
- 缺陷检查器：`logs/teamflow/tf-mw39rd97-pmo6is/scripts/qa-r12-skill-host.mjs`（exit 1，4 项失败）；修复后应 exit 0，作为回归。
- 交付方假绿证据：`scripts/probe/run-bundle-install-rehearsal.mjs:110` 用 `provider.get('enterprise-issue-delivery')`，`packages/forge-enterprise/test/issue-delivery-skill.test.mjs` 同样按 name 调用，两处都不镜像宿主 `get(candidate)` 形状。
- 全量回归：`node --test` 2718/2717/0/1；`pnpm check` exit 1（仅 docs）；`git diff --check` clean；`check-repo`/`check-bundle-tarballs` ok。
- 本报告状态：`candidate`（不可验收）；用户验收、CI、合入、Issue 状态与业务结束均为**未知**，不得据此关闭任何对象或调用 `change done`／合并／发版。

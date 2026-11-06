<!-- meta: summary="按 r12 验收不通过结论返工：修复企业 Skill 宿主契约与企业组合闭包，补齐工具面/门禁与九类矩阵证据，G0–G5 无证据保持阻断，并在最终版本上重新验收。" -->
基线依赖：docs/teamflow/20261105-r12-issue-delivery/（其 20 条 AC、快照/安全/卸载机制是本轮返工与复验基线，已通过项不得回归）

# r12 问题返工 PRD

> 编制：产品经理（代拟）；日期：2026-11-05。依据：用户返工要求、r12 [验收报告](<../20261105-r12-issue-delivery/ACCEPTANCE.md>) 第 6 节与 [QA 报告](<../20261105-r12-issue-delivery/QA-REPORT.md>)。本轮不新开需求语义，只修复 D-1～D-6 并在最终版本上重新取证。

## 1. 背景与目标

### 1.1 已知事实

- r12 验收结论“不通过”：D-1/D-2 企业 Skill 与真实 DSH rc.5 `SkillRegistry` 契约不符（`list()` 因 `source` 非字符串抛错，`get(candidate)` 返回 undefined）；D-3 企业组合缺 DevOps/Gitee 闭包；D-4 工具面文档仍写 10 个；D-5 `pnpm check` 因文档含主机绝对路径失败；D-6 缺九类矩阵。逐项判定见 r12 [ACCEPTANCE](<../20261105-r12-issue-delivery/ACCEPTANCE.md>) 第 3、6 节。
- 本轮开工实测（2026-11-05）：执行根为授权隔离工作树，分支 `feat/plugin-workflow-new`，HEAD `55e964c7d347`；13 个已跟踪文件存在未提交改动，另有新增未跟踪资源与 r12 任务夹。未触碰主工作目录。
- `node scripts/check-docs.mjs` 当前 5 个错误：r12 `PRD.md` 1 处主机绝对路径；r12 `ACCEPTANCE.md` 4 处指向源码的 `#L` 片段链接（片段只允许 Markdown 目标）。这是 D-5 的完整现状，不止 QA 当时记录的 1 条。
- `packages/forge-enterprise/package.json` 的 `dependencies` 与 `bundledDependencies` 仍只有凭据、策略、IAM 三包；`cordis.patch.yml` 的 `insert` 仍为 4 行（三包 + Skill），未挂 DevOps/Gitee。
- `packages/forge-enterprise/src/skills.mjs` 的 provider `list()` 摘要缺 `source`/`resourceBase`，`get()` 只认字符串 name；Gitee `GITEE_TOOLS.length` 为 11，但 `packages/forge-gitee/README.md`、`docs/design/plugins/forge-gitee.md`、`docs/design/README.md`、`docs/teamflow/memory.md` 仍写 10 个（QA 记录 15 处）。
- G0–G5 仍无解除证据：宿主 journal 收口根指向主工作树、最终提交模板固定 `feat:`、无权威关联与可信 run 查询、无独立只读审查的写拒绝证据、目标 rc.3 与企业条件 `NOT RUN`。见 r12 [HOST-VERIFICATION](<../20261105-r12-issue-delivery/HOST-VERIFICATION.md>) 第 2 节。
- 工具链：仓库声明 Node 24.21.0（本轮实测 24.13.0）、pnpm 11.28.5、DSH 0.2.1-rc.5（仓库目标 0.2.1-rc.3）。不自动升级或修改全局环境。

### 1.2 本轮成功标准

1. 真实宿主能枚举企业 Skill，并按宿主 candidate 形状读取正文；最终 tarball 资源闭包可复核，卸载撤注册。
2. 企业组合的依赖、`bundledDependencies` 与补丁层三处同时闭合 DevOps/Gitee；多层同装单注册、共享策略目录、官方行禁用与 IAM/凭据 fail-closed 不回归。
3. 工具面与设计索引同步；最终版本上 `pnpm check` 与 `git diff --check` 有真实全绿结果，未新增检查器豁免、未降低安全扫描。
4. 九类场景矩阵可复跑，每例有调用次数、关联与版本、候选资格、失败提示和证据，夹具与真实宿主分列。
5. G0–G5 无证据时保持阻断并如实披露；交付状态不写成“可关闭”，工作区不越界。

## 2. 范围与非目标

### 2.1 本轮范围

- D-1/D-2：企业 Skill 的发现摘要、资源根、按宿主 candidate 取正文；安装演练与最终 tarball 验证。
- D-3：企业组合依赖、`bundledDependencies`、`cordis.patch.yml` 精确 id 挂载，及多层同装/共享目录/禁用/fail-closed/停用保留配置验证。
- D-4/D-5：Gitee 工具面、README、设计索引、契约引用与 memory 同主题同步；文档主机绝对路径等义脱敏；在最终版本上重跑全量门禁。
- D-6：九类可复跑矩阵与证据，夹具与真实宿主分列。
- G0–G5 复核：有证据则更新结论，无证据维持阻断并留痕。
- 回归：r9/r10/r12 已通过机制（唯一 `execFile` 出口、失败脱敏、写门禁、快照、刷新、卸载、tarball 闭包）。
- 最终验收：对 r12 的 20 条 AC 逐条重新取证，不自动继承旧 QA 结果。

### 2.2 非目标

不新增业务能力、工具、面板、流程引擎或任务数据库；不改企业平台接口契约，不新建 issue/变更映射库；不修改或 fork DSH；不安装到当前 GUI profile（除第 9 节另行授权）；不做企业联调、不关闭/合并/发版；不降低安全扫描、不新增检查器豁免；不重写 r12 需求语义；不把返工包装成新需求。

## 3. 用户故事与验收条件

AC 编号仅属于本任务夹。本轮 AC 是 r12 缺陷的返工切片；r12 的 AC-1～AC-20 仍是完整验收基线，须在最终版本上逐条重验（映射见 3.2）。P0 为必须通过项，P1 为正式交付完整性项，二者都须验收。

### US-1：接手人装好企业组合后，真实宿主能发现并读取企业研发入口

| 编号 | 优先级 | 可测试验收条件 |
|---|---|---|
| AC-1 | P0 | 真实 DSH rc.5 上重跑 QA 原检查器（`qa-r12-skill-host.mjs` 或等价命令）：`registry.list({})` 成功枚举 `enterprise-issue-delivery`，每项 `source` 为非空字符串、`resourceBase` 指向包内 `skills/`、摘要不含 `content`、权限为 `modelInvocable=false`/`userInvocable=true`；`registry.get('enterprise-issue-delivery')` 返回正文且含流程标题；provider `get(candidate)` 与 `get(name)` 均返回可用结果。装配仍只经 `assembleEnterpriseSkills`/`issue-delivery-skill.apply` 单点，不新增第二加载器、不复制条款资源。 |
| AC-2 | P0 | 以最终构建 tarball 验证资源闭包：`npm pack --dry-run` 清单含 `SKILL.md`、两份 references、locale、icon；在无个人 Skill 副本、无源码目录依赖的隔离装配中可发现并读取；`dispose`/卸载后再次 `list()` 不再出现该 Skill，重复 `apply` 不产生重复 provider。安装演练的 Skill 断言必须改为宿主 candidate 形状（`provider.get(candidate)`），仅按 name 调用的结果不得单独判通过。 |
| AC-3 | P0 | `packages/forge-enterprise/package.json` 的 `dependencies` 与 `bundledDependencies` 同时含 `@heluo/forge-devops`、`@heluo/forge-gitee`；`cordis.patch.yml` 以精确 id 挂载 `forge-devops` 与 `heluo-gitee`，与 `heluo-policy`、`heluo-iam`、`heluo-issue-delivery-skill` 共存；企业构建产物递归包含两包及其实体资源，安装清单无 `workspace:`/`file:`/`link:` 协议、无未闭合依赖。 |
| AC-4 | P0 | 三层补丁（devops/gitee/enterprise）同装后：`--dump-config` 中 `heluo-policy` 恰一条且目录逐字等于 6 条并集，无 `isolate`；devops/gitee 工具各只注册一次、无重复条目；官方账户/模型/本地凭据行仍 `disabled: true`；缺 IAM/凭据配置时企业入口 fail-closed（拒绝而非回落明文或匿名），停用 Skill 行不删除用户配置/企业对象；卸载后本插件行与工具面归零、其他条目与配置逐字保留。 |

### US-2：接手人能在最终版本上看到绿色门禁与可复跑证据

| 编号 | 优先级 | 可测试验收条件 |
|---|---|---|
| AC-5 | P1 | Gitee 工具面在 `packages/forge-gitee/README.md`、`docs/design/plugins/forge-gitee.md`、`docs/design/README.md` 与 `docs/teamflow/memory.md` 同主题处统一为 11 个（3 读 + 1 只读判定 + 4 受控写 + 2 git + 1 快照），并补快照工具名、用途、空参数与只读白名单说明；`grep -rn '10 个'` 在以上文件 0 命中；设计索引模块条目、契约引用与 `GITEE_TOOLS.length=11` 一致。 |
| AC-6 | P0 | 在最终版本（改动完整、无未记录差异）上串行执行 `pnpm check` 与 `git diff --check`：均 exit 0；`pnpm check` 覆盖 docs、repo、tarball、版本与全量 `node --test`，0 失败、0 新增 skip；docs 的主机绝对路径扫描保持原强度，检查器规则与白名单无新增豁免；授权引文按用户确认做等义脱敏（占位符表达同一授权范围与限制，不改语义），不删改检查规则；`dist/`、`*.tgz`、`logs/`、缓存与本地秘密不入库。 |
| AC-7 | P1 | 提供可复跑矩阵，覆盖九类：正常首次交接、相同任务重复进入、运行中进入、中断续跑、已完成再进入、关联冲突、版本变化、缺依赖、伪造通过声明。每例记录：前置对象与版本、`start`/`resume`/写调用次数（期望值与实测值）、关联与要求版本、候选资格、失败提示、执行命令与证据位置；夹具列与真实宿主列分列，真实宿主未执行的写 `NOT RUN` 并说明 G2/G3 等阻塞，不得用夹具结果填真实列。 |
| AC-8 | P0 | r9/r10/r12 既有通过项不回归：`src` 零 `spawn`/`exec`/`shell:true`（唯一 `execFile` 出口）、失败面零路径/零 errno、写门禁默认拒绝且 0 调用、快照工具 11 个与 `?refresh=1` 重建、卸载幂等、tarball 闭包；全仓 `node --test` 用例数不低于 r12 QA 基线（2718 项），新增用例 0 失败、0 新增 skip，skip 来源单列。 |

### US-3：G0–G5 只在有证据时解除，否则保持阻断

| 编号 | 优先级 | 可测试验收条件 |
|---|---|---|
| AC-9 | P0 | 核对宿主 journal 的收口根与授权 worktree 一致（`workspacePath`、状态读取根、最终提交根三者）；不一致时 run 不得自动向主工作树收口，停止并报告；三个错位场景（journal 指主目录/状态根缺失/提交根错位）有负测；本轮 0 次 stash、commit、merge、推送。 |
| AC-10 | P0 | 取得目标宿主最终提交模板支持首行 `[变更号]` 的公开契约证据，并在隔离 Git 仓库完成真实提交后读取首行与 SHA；若无公开契约支持，维持阻断并如实报告，不以模板静态检查、改 Skill 文案、跳钩子、改签名或重写历史冒充满足。 |
| AC-11 | P0 | 通过权威只读来源取得唯一 Issue→变更→仓库关联及要求版本，每项标真实读取来源；无关联、多变更、多仓库、读取失败时冲突对象可见且 `start`/`resume`/写调用均为 0，不自动选第一个、不写回“修正”关联、不以标题相似或人工声明冒充核验。 |
| AC-12 | P0 | 查询既有 run 能完整排除更早 run 或明确 `unknown`；运行中仅跟踪原 run、中断按原生状态续跑、已完成先核对版本，重复进入时新增 `start` 为 0；查询失败、多候选或映射不可信时暂停并说明，保留前序关系、不建第二任务库。 |
| AC-13 | P0 | 独立只读审查在与实现分离的上下文完成，记录审查者/模型、上下文标识、被审版本（SHA/contentId/差异）、发现与结论，并提供一次写入被拒的实际证据；实现者自审、调用方传 `pass` 不算；无隔离能力时标 `NOT RUN`，不伪造第二审查者。 |
| AC-14 | P0 | 目标宿主 rc.3 与当前 rc.5 分列：rc.3 的 Skill/工具/Teamflow 行为有实测或 `NOT RUN`；企业 Gitee/dop 只读、凭据/IAM、受保护仓库规则、Windows/麒麟 aarch64 逐项给实测或 `NOT RUN`；rc.5 或夹具通过不得写成 rc.3/企业可用。 |

### US-4：用户看到的是如实状态，工作区不越界

| 编号 | 优先级 | 可测试验收条件 |
|---|---|---|
| AC-15 | P0 | 交付摘要分别列执行结果、候选交付、用户验收、CI、合入、Issue 状态、业务结束；G0–G5 未闭合时整体只能报未完成/阻断，不得出现“可关闭/已通过/待验收候选”；不新增 close/merge/release 动作，不调用 `change done`，不把返工写成新需求完成。 |
| AC-16 | P0 | 最终 diff 仅含授权 worktree 内本需求改动：主工作树 0 改动、0 stash、0 commit、0 push、0 merge；未修改或 fork DSH；`.gitignore` 审计覆盖 Node/pnpm 构建产物、`*.tgz`、`logs/`、缓存与 `.env*`/密钥，并给出 tarball/dist/logs 未入库的命中证据；历史任务夹除用户确认的等义脱敏与链接形式修复外逐字不变（见 9/F1）。 |

### 3.2 r12 验收基线映射

| r12 AC | 本轮承接 AC |
|---|---|
| AC-1、AC-2 | AC-1、AC-2、AC-3、AC-4 |
| AC-3 | AC-1、AC-4、AC-7 |
| AC-4、AC-5 | AC-11 |
| AC-6 | AC-14 |
| AC-7、AC-8 | AC-7、AC-12 |
| AC-9 | AC-9、AC-16 |
| AC-10 | AC-10 |
| AC-11 | AC-6、AC-13、AC-16 |
| AC-12 | AC-6、AC-8 |
| AC-13、AC-14 | AC-10、AC-13 |
| AC-15、AC-17 | AC-15 |
| AC-16 | AC-6、AC-13、AC-15 |
| AC-18 | AC-8、AC-14 |
| AC-19 | AC-7 |
| AC-20 | AC-5、AC-6、AC-16 |

映射只表示证据来源，不表示 r12 AC 自动通过；其完整定义、优先级与失败证据见 r12 [PRD](<../20261105-r12-issue-delivery/PRD.md>) 第 3 节与 QA 报告。最终验收须逐条重判并给出来源类型。

## 4. anti-goals / 反面目标

1. **修复只在自己写的夹具上变绿**：实测命令仍按 `get('名字')` 调用，真实宿主 `list()` 照样抛 `non-string source`、`get(candidate)` 照样 undefined，交付摘要却写“D-1/D-2 已修复”。使用或复核交付时，任何人重跑 QA 原检查器都能看到 exit 1（AC-1、AC-2）。
2. **依赖只写在清单的 `dependencies` 里**：没有进 `bundledDependencies`、补丁层也没有 DevOps/Gitee 行；装完企业组合仍只有 4 行 insert、缺两个读面，或三层同装冒出两个策略实例/重复工具（AC-3、AC-4）。
3. **为了让门禁变绿而修改门禁本身**：给 docs 检查加豁免、删绝对路径规则、或把授权引文改成语义不同的句子；`pnpm check` 绿了，但用户当初授权的范围已被悄悄改写（AC-6）。
4. **矩阵只有场景名字**：九类都列了，却没有每例的调用次数、关联/版本和证据；或把夹具结果填进“真实宿主”列、把 `NOT RUN` 写成通过（AC-7、AC-15）。
5. **无证据的 G0–G5 被写成已满足**：摘要出现“待验收/可关闭”，或为了凑证据在非授权 worktree 提交、stash、改宿主（AC-9～AC-16）。

## 5. 交互流程摘要

1. **开工核对**：确认执行根、分支、HEAD 与未提交改动；读取 r12 验收第 6 节、QA 缺陷表与两台检查器；把 D-1～D-6、G0～G5 的当前状态写进本轮证据表。
2. **契约与闭包修复**：先修 D-1/D-2（发现摘要 + candidate 取正文），再补 D-3（依赖/bundled/补丁精确挂载）；每次改动后跑包级用例，最后跑真实宿主检查器与构建产物。
3. **文档与门禁**：同步工具面与索引（D-4），按用户确认做等义脱敏（D-5），在最终版本上跑全量门禁；失败就停在真实错误上，不绕过。
4. **矩阵与回归**：按九类场景逐条记录调用次数与证据（D-6），同时复跑 r9/r10/r12 既有机制，确认只增不减。
5. **阻断复核**：对 G0–G5 逐项重取证据；取不到就标 `NOT RUN` 并说明影响，不把夹具或 rc.5 结果迁移成 rc.3/企业结论。
6. **交接**：给出一页状态表（执行/候选/用户/CI/合入/Issue/业务）与可打开证据；只写“待用户验收”或“未完成”，不写“可关闭”。

## 6. 优先级与里程碑建议

| 里程碑 | 优先级 | 内容与退出条件 |
|---|---|---|
| M1 基线核对 | P0 | 记录 D-1～D-6 与 G0～G5 当前证据、命令、版本；确认工作区与未提交差异。退出：缺陷现状可复核，不把旧 QA 当本轮结果。 |
| M2 契约与闭包 | P0 | 完成 AC-1～AC-4；真实宿主检查器 exit 0，tarball 含资源，三层同装单注册、安全不回归。退出：每条附命令与输出摘要。 |
| M3 文档与门禁 | P0 | 完成 AC-5、AC-6；工具面 11 个、索引同步，`pnpm check` 与 `git diff --check` 在最终版本上 exit 0。 |
| M4 矩阵与回归 | P0/P1 | 完成 AC-7、AC-8；九类矩阵齐备，用例数不低于基线、0 新 skip。 |
| M5 复核与交接 | P0 | 完成 AC-9～AC-16；G0–G5 有证据更新、无证据阻断，状态表如实，工作区无越界。 |

## 7. 依赖与风险

| 依赖／风险 | 本轮处理与不可越过的边界 |
|---|---|
| 真实宿主版本双轨 | 仓库目标 rc.3，本机 rc.5；rc.5 修复不能代替 rc.3 证据。rc.3 未测则 `NOT RUN`，不升级宿主、不改 DSH。 |
| 真实装入/冷启动 | 需一次性隔离 DSH_HOME 或临时 profile；是否授权见 9/T1。未授权时只能做 Loader 级装配，真实装入标 `NOT RUN`。 |
| 企业对象与凭据 | 无真实 Issue/变更/仓库/凭据时 G2/G3 保持阻断；不用标题相似、人工声明或 mock 替代。 |
| 历史任务夹与门禁冲突 | r12 文档含 5 个 docs 错误；按 9/F1 处理。若用户要求逐字不动，AC-6 只能如实记失败，不得改检查器凑绿。 |
| 未提交改动叠加 | 工作区已有 13 个已跟踪改动与新增资源；不 stash、不清理，只叠加本需求差异；同一文件出现并行改动时暂停核实来源。 |
| 假绿路径 | 只用 name 调用的夹具、安装演练与包级测试都曾假绿；所有 Skill 断言必须镜像宿主 candidate 形状。 |
| 范围膨胀 | 不借返工新增工具、面板、引擎或企业联调；超出的能力另开需求。 |

## 8. 工程约束

### 8.1 授权原文、执行边界与基线

用户本轮约束原文保留，实施与每次续跑都必须遵守：

> 仅在授权隔离工作树实施，不触碰主目录、不 stash、不提交、不推送、不合并；不修改或 fork DSH；G0（journal 收口根与授权 worktree 一致性）、G1（最终提交前缀 [变更号] 无公开契约支持）、G2（权威 Issue—变更—仓库关联）、G3（可信 run 查询）、G4（独立只读审查与写拒绝证据）、G5（目标宿主 rc.3 与企业条件）未取得证据时保持阻断并如实报告，不用提示词、mock 或局部测试通过冒充已满足；不把待验收交付写成可关闭；不改历史任务夹。

同时保留用户对返工范围的原文：“本轮应修复这些缺陷并补齐证据后重新验收，不新开需求语义。”

执行基线是本隔离工作树实际 HEAD 与 `feat/plugin-workflow-new` 分支；本阶段只写 PRD 与规定状态文件，不实跑门禁、不安装、不触发业务 run。未提交改动保留原状，不跨工作树搬运。

### 8.2 版本控制、工具链与忽略规则

- 工具链按 `.node-version`（24.21.0）、根 `package.json`（pnpm 11.28.5）与 `.dsh-version`（0.2.1-rc.3）核对；实测差异如实报告，不自动升级。
- **开发阶段必做：审计并补齐 `.gitignore`**。现有规则已覆盖 `node_modules/`、`.pnpm-store/`、`dist/`、`build/`、`coverage/`、`*.tgz`、`logs/`、`.env*`、密钥与 IDE 文件；新增的 `packages/forge-enterprise/skills/`、`locale/`、`icon.svg` 不得被忽略；构建/探针产生的 tarball、dist、缓存须命中忽略。给出 `git check-ignore` 命中与 `git status` 未暂存噪音的核对证据；无缺口则记录“已覆盖”，不为凑改动重写规则。
- 不提交、不推送、不合并；不执行 `git stash`、`git reset --hard`、`git checkout --` 清理他人或既有改动。最终 diff 只含本需求授权差异。

### 8.3 文档与工作区边界

- 本需求全部产物只写 `docs/teamflow/20261105-r13-r12-issue-rework/`；不写 host `docs/<role>/`，不归档、不升版，不修改 AGENTS.md 的受管区之外内容。
- r12 任务夹作为只读基线引用；唯一例外是 9/F1 所述的等义脱敏与链接形式修复（若用户确认），不改其结论、AC、判定或证据文本。
- 阶段状态写 `logs/teamflow/tf-mw3hury1-cykbxm/state/`；日志目录是临时区，不复制整段命令输出，不把日志当交付物。
- 本阶段不修改 `docs/teamflow/memory.md`；若开发阶段验证出新的跨需求契约约定，按同主题替换写入，不追加流水账。

### 8.4 证据与来源类型

每条“已修复/已通过”必须写：命令、时间、宿主与工具版本、目标对象、来源类型（`local-execution`、`host-execution`、`repository-source`、`fixture`、`NOT RUN`）。夹具与 mock 结论不得写成真实宿主或企业联调；`NOT RUN` 不计通过。

## 9. 假设与待澄清

以下不重开用户已确认的目标、缺陷范围与“待验收不等于可关闭”的决定。推荐默认是缺证时的处理，不是已批准事实。

- **F1／fact：r12 历史任务夹含 4 处失效片段链接与 1 处主机绝对路径，与“不改历史任务夹”冲突。** `check-docs` 会扫描整个 `docs/`，不修就无法让 AC-6 全绿；用户已确认“等义脱敏、不新增检查器豁免、不降低安全扫描”。推荐默认：只对 r12 文档做最小修复——1 处路径替换为等价占位符、4 处 `#L` 片段改为普通代码引用，不改变任何结论、AC、判定或证据文本，并在交付摘要单列。若用户坚持历史任务夹逐字不动，则 AC-6 如实记失败并保留 5 个历史错误，不得改检查器或放宽扫描。
- **T1／taste：是否授权一次性临时 DSH_HOME/隔离 profile 做真实装入、卸载与冷启动？** 当前授权只覆盖隔离工作树；AC-2/AC-4 的真实装入、卸载撤注册与冷启动零残留证据依赖它。推荐默认：允许在系统临时目录建一次性 DSH_HOME（不碰当前 GUI profile、不改宿主安装），用完即删；若不授权，真实装入与冷启动标 `NOT RUN`，只做 Loader 级装配并在摘要说明影响。
- **T2／taste：独立只读审查是否必须使用不同于实现者的模型？** 上位要求只确定上下文独立、只读与版本绑定；异模型增加交叉视角，也增加模型可用性与成本约束。推荐默认：独立只读上下文 + 披露实际模型即可，同模型允许；若用户要求异模型，则把第二模型可用性与对应真实审查证据加入 AC-13 的准入，缺证据不得称通过。

## 10. 验收交接要求

技术阶段须给出 D-1～D-6 的实现边界、宿主契约依据与可复跑命令；开发阶段交付代码/资源、最终 tarball 与逐项自检；QA 用 r12 原检查器与九类矩阵复验，逐条给 `通过/失败/NOT RUN` 及来源类型。最终验收对 r12 的 20 条 AC 重新取证，不以本轮 AC 通过替代 r12 AC 判定；G0–G5 任一未解除时，整体只能报“未完成/阻断”。用户接收阶段材料不等于接受缺证的真实 Issue 结果。

本阶段只完成需求定义、仓库静态取证与工作区核对；未运行 `pnpm check` 全量、企业 CLI、真实安装、Teamflow 交接或独立审查，不对这些能力作通过结论。

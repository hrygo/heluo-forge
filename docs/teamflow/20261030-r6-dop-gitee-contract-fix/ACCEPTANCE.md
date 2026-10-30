# ACCEPTANCE：企业 dop / Gitee `gh` 契约兼容修复（r6）

| 项 | 值 |
|---|---|
| 任务夹 | `docs/teamflow/20261030-r6-dop-gitee-contract-fix/` |
| 契约来源 | `docs/teamflow/20261030-r6-dop-gitee-contract-fix/TECH-CHANGE.md`（本轮为 tech 模式，`meta.json` `mode=tech`，无 PRD.md/DESIGN.md 是本轮形态而非缺件） |
| 分支 / 基线 | `feat/devops-change-flow` / `c0ca679`；工作区未提交（13 文件改动 + 5 新文件，`+1079/-116`） |
| 验收人 | 产品经理（acceptance lead） |
| 环境 | macOS，node v24.13.0，pnpm 11.28.5；纯 ESM，无编译步骤；`dsh` 不在 PATH |
| 证据纪律 | 本轮全部为**组件级 mock 实测**；企业实机/真实 dop·gh/真实写幂等**NOT RUN**（§6），不得据本单写成企业已验 |

## 1. 结论速览

**验收通过。** 三个 UAT 缺陷（① dop 原生命名、② 仓库引用只认两段、③ `gh` 原生包封）均已按契约修复，**关键不变量全部守住**：三段引用被放宽的同时，`confirm.repo` 折成两段仍被拒、同组兄弟仓库与另一命名空间仍被拒、裸名跨组同名仍 `blocked`、幂等键公式与 `reused` 语义零改动。架构蓝图逐项落地，**未发现偏离、重复实现或结构破坏**。

验收者本轮**新写**一支独立探针（不复用 QA 脚本）自证 **42/42**；并把 QA 的回归契约原样重跑：检查器 **35/35**、真实组合根端到端 **11/11**；包内用例 **477/477**（基线 432，只增不减、零 skip）；`pnpm check` **1443 tests / 1440 pass / 0 fail / 3 skipped**（既有环境 skip）；`git diff --check` 干净。

无仍开启缺陷，无返工项。

## 2. AC 逐条核对

契约条款取自 `TECH-CHANGE.md` §3.1–§3.4、§4、§5；「验收方式」列区分**我本轮实跑**与**引用既有证据**。

| # | 验收条款（契约出处） | 判据 | 验收方式 | 结论 |
|---|---|---|---|---|
| AC-1 | ① 原生 `code`/`state`/`summary`/`userStory` 可读（§3.1） | 原生夹具归一后 `changeId`/`title`/`status`/`userStories`/`releaseInfo` 齐全 | 实跑：探针 F1–F4（`changeId=ARD777777`、`summary` 兜 `title`、`status=open`、故事 1 条含 `R20260706001`）+ 端到端阶段 A | ✅ |
| AC-2 | 必填收敛为 `id`/`title`/`status`；缺 `description`/`acceptance_criteria` 只降级（§3.1） | 缺失进 `missingFields`，卡片渲染「平台未提供」，**不伪造** | 实跑：探针 F5–F8（`missingFields` 含 `acceptance_criteria`、`acceptanceCriteria` 未凭空生成、渲染含「平台未提供」）；源码 `change-context.mjs:205-215` 只对"给了但类型错"抛错 | ✅ |
| AC-3 | 不放松：空白必填、类型错、`id`↔`code` 冲突、`expectedId` 不等、`sourceType` 非词表（§3.1） | 全部仍拒绝，且冲突不静默择一 | 实跑：探针 G1（`title='   '` → `CONTEXT_RECORD_INVALID`）、G2（`CONTEXT_ID_MISMATCH`）、G3（`acceptance_criteria` 非字符串数组仍拒）；QA E6 覆盖 `summary`/`state` 空值变体 | ✅ |
| AC-4 | ② `org/group/repo` 三段进入写路径与幂等（§3.2、§4#1） | 三段被接受、命令面路径不折叠 | 实跑：探针 C1/C1b（argv 含 `-R acme/group/demo`，`number=12`）、端到端阶段 B（评论 `status=done`、`target=acme/group/demo#12`、回读一致）；永久用例 `test/actions.test.mjs:646,664,713,739` | ✅ |
| AC-5 | ② 1 段/4 段/空段/连字符开头/段内空格仍拒且**零子进程**（§3.2） | `MISSING_TARGET` + runner 调用数 0 | 实跑：探针 C2 五组（`acme/demo/x/y`、`acme`、`acme//demo`、`-bad/x`、`acme /demo`）全部 `MISSING_TARGET` 且 `calls=0` | ✅ |
| AC-6 | ② 门禁双侧在三段下仍生效、**不折叠**（§3.2 第二根因） | `confirm.repo` 折成 `group/repo` 仍拒；错仓库仍 `denied` | 实跑：探针 D1（折叠 → `CONFIRMATION_REQUIRED`）、D2（完整三段放行抵达服务层）、D3（四段 target → `MISSING_TARGET`）；端到端「反向折两段 → `denied/REPO_NOT_SELECTED`」；源码 `tools.mjs:116-120`、`flow.mjs:371-378` 均用完整路径比对 | ✅ |
| AC-7 | ② 裸名兜底收紧为"候选内唯一"（§3.2） | 跨组同名 `blocked/MULTIPLE_CANDIDATES`，不替用户挑第一个 | 实跑：探针 E1/E2（两候选同名 → `blocked` 且 `selected=null`）、E3（整串精确命中 `orgB/shared/demo`）、E4（候选内唯一时仍可命中，兜底没被一刀切）、E5（`sameRepo` 无裸名兜底） | ✅ |
| AC-8 | ③ 包封 `data.list` 解包 + `path_with_namespace` 别名（§3.3） | `repo` 保留完整路径、`owner` 为完整前缀、`name` 为最后一段 | 实跑：探针 A1–A5（条目数与夹具一致、三段不折叠、`owner` 两段、argv 一字不改）；源码 `gh-adapter.mjs:225-242`（`unwrapListEnvelope`）、`:267-291`（`normalizeRepo`） | ✅ |
| AC-9 | ③ `data.list: []` 得空清单、非数组即 `MALFORMED_RESULT`（§3.3 硬约束） | 不回落成单元素，也不凭空造一条 | 实跑：探针 B1（空数组 → 0 条）、B2（字符串 → `MALFORMED_RESULT`）、B3（对象 → `MALFORMED_RESULT`） | ✅ |
| AC-10 | 不变量：写门禁 / 四状态 / 幂等键前 16 位 / `reused` / 唯一 `execFile` 出口 / 读信封与 `unknown` 不重放（§3.4） | 公式与语义零改动 | 实跑：探针 H1（与独立 `sha256(变更号\|对象类型\|归一化标题)` 前 16 位一致）、H2（无状态同值）、H3（`repo-ref` 零依赖零子进程）；`actions.mjs:106-114` 公式与 `reused` 分支未动；`read.mjs`/`dop-adapter.mjs`/`policy.mjs` 零 diff（`git diff --stat` 为空） | ✅ |
| AC-11 | 零改动面：`http.mjs`/`index.mjs`/`runtime-config.mjs`/`client.js`/`forge-gitee`/`package.json`（§2） | 全零 diff | 实跑：`git status --porcelain -- <该六处>` → 0 行 | ✅ |
| AC-12 | 回归门禁：用例只增不减、零 skip；`pnpm check`、`git diff --check` 全绿（§5.1） | 432 → 477；根级全绿 | 实跑：包内 `node --test "test/*.test.mjs"` → **477 pass / 0 fail / 0 skip**；`pnpm check` → **1443 / 1440 / 0 fail / 3 skipped**；`git diff --check` 无输出 | ✅ |
| AC-13 | 架构：`repo-ref.mjs` 为段语法唯一真源，五处调用面改为引用（§3.2 + 蓝图） | 无第二份段正则、无本地 `repoOf` 兜底 | 实跑：探针 I1–I4（五面均 `from './repo-ref.mjs'`、段字符集只在单点出现、无 `function repoOf(`、蓝图 10 个导出齐全）；全库 grep 只剩注释里的历史说明 | ✅ |
| AC-14 | 适配边界：别名只在 `change-context` 入口、包封只在 `gh-adapter` 吸收，下游只见 snake_case（§3.1/§3.3 + 蓝图） | 别名不外泄、解包不第二处 | 实跑：`NATIVE_ALIASES` 唯一（`change-context.mjs:41-50`），`aliasChangeRecord` 返回新对象（指纹仍按原样 `raw` 算）；`unwrapObjectEnvelope`/`unwrapListEnvelope` 只在 `gh-adapter` 被 `parseObject`/`parseList` 调用 | ✅ |
| AC-15 | 文档与记忆：`memory.md` 同步约定/待办，`AGENTS.md` 不动，夹具标 mock（§5.2 + 政策） | 一条约定 + 同题待办就地更新；禁改区外零改动 | 实跑：`git diff docs/teamflow/memory.md` 新增「契约兼容只在适配层吸收」一条、两条同题待办就地补 r6 口径，无 changelog 追加；`git status --porcelain -- AGENTS.md` → 0；两份夹具各带 `mock`/非企业实测标注 | ✅ |
| AC-16 | 证据纪律：mock 与 NOT RUN 不写成企业已验（§5.4） | 报告与注释口径一致 | 引用：QA 报告 §2/§8 明标组件级 mock 与 6 项 NOT RUN；夹具内 `_fixture.sourceType=mock`；本轮未发现"企业已验"表述 | ✅ |
| AC-17 | 需改写的 3 条既有用例"改写不删"（§5.3） | 总数不减 | 实跑：432 → 477（+45）；`context.test.mjs` 19 项、`gh-adapter.test.mjs` 29 项仍全绿 | ✅ |
| AC-18 | §7 六处待澄清的处理不越界（§7） | 按推荐执行、不预埋猜测、单独立项 | 实跑：新建 `repo-ref.mjs`（§7#4 推荐项）；`forge-gitee` 未动（§7#5，0 diff）；`ghOwner` 仍单段（§7#6）；§7#1/#2/#3 未预埋猜测，取不到即进 `missingFields` | ✅ |

## 3. 架构一致性核查（对照注入的架构蓝图 · M3 门禁）

- **抽取落地**：`packages/forge-devops/src/repo-ref.mjs`（163 行）是段语法、目标剥壳、候选匹配的唯一实现，10 个导出与蓝图 `api` 逐字一致（`REPO_SEGMENT_SOURCE`、`REPO_REF_MIN/MAX_SEGMENTS`、`REPO_REF_PATTERN`、`isRepoRef`、`parseRepoRef`、`repoOfTarget`、`parseTargetRef`、`sameRepo`、`pickRepoRef`）。
- **调用面全部改接**：`repository-resolver.mjs:25`（`pickRepoRef`）、`gh-adapter.mjs:36`（6 个段常量 + `isRepoRef`/`parseRepoRef`/`parseTargetRef`）、`flow.mjs:23` 与 `tools.mjs:18`（`repoOfTarget`）、`actions.mjs:30`（`isRepoRef`/`parseTargetRef`）。`TARGET_LINK_PATTERN`（`gh-adapter.mjs:84-87`）由 `REPO_SEGMENT_SOURCE` + MIN/MAX 拼出，未再自写段正则。
- **装配顺序与边界不变**：`flow` 仍是配置 → 唯一子进程出口 → 适配器 → 门禁 → 平台动作；写动作只在装配期拿一次 `ctx/guard`；适配器仍是唯一 `execFile` 出口（探针 H3 + QA E1）。
- **门禁语义升级方向正确**：`flow.repoMismatch`（`flow.mjs:371-378`）在三段下取到**完整路径**并与 `building.selected` 逐字比对；取不到仓库时不表态（交给 `actions` 回 `MISSING_TARGET`，零下游调用）——这是"目标语法问题"与"写到候选之外"的分离，不是门禁放行（探针 D3 与端到端反向用例均证明四段/折叠仍拒）。
- **未破坏既有结构**：`read.mjs`/`dop-adapter.mjs`/`policy.mjs`/`entry.mjs` 零 diff；`package.json` 零 diff（无新依赖）；工具面仍是 9 个（4 读 + context + 4 写）。
- **结论**：**无实现级偏离、无重复实现、无"本该抽取而未抽取"**。因此不构成「⚠️ 有条件通过」的理由。

## 4. QA 缺陷复验（上轮两点）

| 编号 | 上轮级 | 本轮判据（我实跑） | 结论 |
|---|---|---|---|
| Q-1 空必填被接受 | P2 | 探针 G1（纯空白 `title` 拒绝）+ QA E6（原生 `summary`/`state` 空值、纯空白变体 3 条拒绝、`CONTEXT_ID_MISMATCH` 顺序不受影响）；源码 `change-context.mjs:201-207` 非空校验 + 永久用例 `context.test.mjs:198` | 已修复 |
| Q-2 文档口径（1 段裸名） | P3 | `repoOfTarget('acme') === null`（探针 E/QA E5），注释 `repo-ref.mjs:101` 已写明「1 段裸名回 `null`」，全库旧表述 0 命中 | 已修复 |

上轮报告补充的两点也复核成立：QA 复验时曾用**变异实验**（删非空校验后 2 用例 + 3 断言转红，随后逐字节还原）证明判据有牙；本轮我另外用成对断言自证方向（折叠拒/完整放行、坏包封 `MALFORMED_RESULT`/空数组空清单、跨组 `blocked`/整串 `resolved`），未出现"恒真断言"。

## 5. 观察与遗留（**均不构成本轮缺陷、不阻断验收**）

| # | 事项 | 判断 |
|---|---|---|
| L1 | `forge-gitee` 同源的两段假设（`gitee-adapter.mjs:238-242`、`gitee-actions.mjs:95-99`）与不解包 `{data:{list}}`（`gitee-adapter.mjs:544-545`）**未修** | 契约 §7#5 显式另开单，`memory.md` 待办已记；本次对该包零 diff，未扩大回归面 |
| L2 | 写回执解析不拆信封：`parseCreatedRef`（`gh-adapter.mjs:325-352`）与 `parseCommentRef`（`:358-375`）只读顶层 `number`/`url`，未过 `unwrapObjectEnvelope` | 若企业 `gh` 对 `issue create`/`comment` 回执也用 `{data:{...}}` 包封，会落 `MALFORMED_RESULT` → 动作层判 `unknown`（`mayHaveSideEffect=true`，**不重放、不算成功**）——方向安全，属 fail-closed。UAT 的 T6b 在修复前**不可达**（三段被拒），故这一点尚无实测证据；建议并入 L1 的同一次企业联调一并取证，**不建议**在无实测前顺手扩解包 |
| L3 | 仓库引用语法未登记到 `docs/contracts/` | 全库契约文档未定形过"仓库引用"，本单无文档可同步（也不存在需要改的过期表述）；建议后续把「2..3 段」登记进工具契约，避免下一次再从代码反推 |
| L4 | `summary` 语义（标题 vs 正文）、故事项内层键、验收条件承载位置 | 契约 §7#1/#2/#3 未拍板，当前处理是"同一串同时喂 `title`/`description`"+"取不到即进 `missingFields`"，**未伪造**、不影响幂等键；待企业实测后再定别名表（改一行即生效） |
| L5 | 本轮形态：任务夹只有 `TECH-CHANGE.md`（无 PRD.md/DESIGN.md/TECHNICAL.md） | `meta.json` `mode=tech`，契约由技术变更单承载，属本轮形态而非缺件；文件夹未做二次改名/升版，符合 ADR-0008 |

## 6. NOT RUN（环境限制，不代表通过）

| 项 | 判据 | 状态 |
|---|---|---|
| 企业内网 Windows / 麒麟 aarch64：真实 dop `change view` 原生命名（`summary` 语义、故事内层键、验收条件位置） | 字段可读、缺字段只降级 | NOT RUN（无企业环境） |
| 真实 `gh repo list --json` 包封与字段过滤 | 可见仓库如实列出 | NOT RUN |
| 真实写幂等复用一次取证（含三段仓库评论 `done` + 回读一致） | `reused=true` 且 `key` 一致 | NOT RUN |
| 写回执是否同样带 `{data:{...}}` 包封（L2） | 拆则 `done`，不拆则 `unknown` 不重放 | NOT RUN（与上两项同批取证） |
| 目标 DSH 装载（`--patch` 装配后 9 工具可用） | 模块可加载、工具枚举 | NOT RUN（本机 PATH 无目标 `dsh`） |
| `pnpm check` 中 3 条既有 skip | 目标环境全绿 | NOT RUN（既有环境用例，非本次引入） |
| 浏览器走查 | 配置页无回退 | 本单无 UI 改动（`client.js` 零 diff），无截图可看；按 NOT RUN 记 |

## 7. 本轮验收实跑（命令 + 结果）

| # | 检查 | 命令（仓库根执行，除标注） | 结果 |
|---|---|---|---|
| V1 | **验收者独立探针**（本轮新写，不依赖 QA 脚本） | `node logs/teamflow/tf-mvup4d40-79kgoj/scripts/acceptance-r6-probe.mjs` | 退出码 0，**42/42** 断言通过（A 包封 5、B 空清单/坏包封 3、C 三段与拒收 7、D 门禁折叠 3、E 裸名 5、F 原生归一 8、G 不放松 3、H 不变量 4、I 架构 4） |
| V2 | QA 回归契约（原样重跑） | `node logs/teamflow/tf-mvup4d40-79kgoj/scripts/qa-r6-contract-fix.mjs` | 退出码 0，**35/35** |
| V3 | 真实组合根端到端 | `node logs/teamflow/tf-mvup4d40-79kgoj/scripts/delivery-e2e-three-defects.mjs` | 退出码 0，**11/11**（阶段 A `ready`/`missingFields=["acceptance_criteria"]`；阶段 B `done`/`acme/group/demo#12`/回读一致；反向折两段 `denied/REPO_NOT_SELECTED` 零子进程） |
| V4 | 包内全量（glob，非目录） | `cd packages/forge-devops && node --test "test/*.test.mjs"` | **477 pass / 0 fail / 0 skip** |
| V5 | 根级门禁 | `pnpm check` | 退出码 0，**1443 tests / 1440 pass / 0 fail / 3 skipped**（含 docs、repo、tarball 检查） |
| V6 | 空白与冲突标记 | `git diff --check` | 退出码 0，无输出 |
| V7 | 零改动面 / 禁改区 | `git status --porcelain -- <六处零改面> AGENTS.md` | 0 行 |
| V8 | 工具面 | `node --input-type=module -e "buildDevopsTools({})"` | 9 个工具（4 读 + context + 4 写） |
| V9 | 夹具来源标注 | `grep -c mock test/fixtures/*.json` | 各 1 处 `mock` 标注 |
| V10 | 提交面卫生 | `git status --porcelain` + `git check-ignore` | 13 M + 5 新（含任务夹），无构建产物/依赖目录/`.log`；`logs/` 已被 `.gitignore:81` 忽略，检查器不进提交面 |

## 8. 验收意见

1. **功能**：三个缺陷的根因均在契约指出的位置被修掉，且修法守住了 fail-closed 方向——放宽的是"读得懂的形态"（三段路径、原生字段、包封），**没有放宽任何判据**：折叠仍拒、跨组仍阻断、空白必填仍拒、坏包封仍 `MALFORMED_RESULT`。
2. **架构**：单一真源与适配边界按蓝图落地，五处正则漂移被真正消灭（不是"新增一份再并存"），门禁两处同批改动并各自有用例——这正是契约点名的"只改一处会让另一处继续恒拒或误判"的失效模式，已被避免。
3. **证据**：验收者独立探针与 QA/端到端三方一致，数字可复算（432→477、1443/1440/0/3）；上轮 Q-1/Q-2 已复验；无返工项。
4. **下一步建议**：把 L1（`forge-gitee` 同源）与 L2/L4（写回执包封、原生字段语义）打包成**一次**企业联调取证，避免分三次进企业环境；本轮结论不得被引用为"企业已联调"。

验收结论：✅ 通过

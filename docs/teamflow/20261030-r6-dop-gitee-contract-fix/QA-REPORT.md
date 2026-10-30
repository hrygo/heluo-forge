# QA 报告 · r6 dop / Gitee `gh` 契约修复（第 2 轮 · 修复复验）

| 项 | 值 |
|---|---|
| 任务夹 | `docs/teamflow/20261030-r6-dop-gitee-contract-fix/` |
| 分支 / 基线 | `feat/devops-change-flow` / `c0ca679`（工作区未提交：13 文件改动 + 5 新文件，含本任务夹） |
| 覆盖缺陷 | ① dop 原生命名（T3）② 仓库引用只认两段（T6b）③ `gh` 原生包封（可见仓库恒空） |
| 本轮性质 | **修复复验**：先按原样重跑上轮检查器（回归契约），再验上轮 Q-1/Q-2 修复，最后补上轮未覆盖的面 |
| 环境 | macOS，node v24.13.0，pnpm 11.28.5；纯 ESM 源码，无编译步骤；`dsh` 不在 PATH |
| 证据纪律 | 全部为 **组件级 mock 实测**（夹具标 `_fixture.sourceType=mock`）；真机/真实 dop·gh/真实写幂等 **NOT RUN** |

## 1. 结论速览

**可验收（第 2 轮）。** 上轮 1 项 P2（Q-1 空必填被接受）+ 1 项 P3（Q-2 文档口径）均已修复并经本轮复验；**未发现仍开启的缺陷**。三个 UAT 缺陷的修复结论不变且证据加强：独立检查器 **35/35**（上轮 34 项回归契约全通过 + 本轮新增 1 项）、真实组合根端到端 **11/11**、包内用例 **477/477**（基线 432，只增不减）、根级 `pnpm check` **1443 tests / 1440 pass / 0 fail / 3 skipped**、`git diff --check` 干净。另做了一次**变异实验**证明 Q-1 判据有牙（删掉非空校验后 2 条用例 + 3 项断言转红，已还原并校验字节一致）。

## 2. 范围、环境与证据纪律

- **范围**：`packages/forge-devops` 的 7 个模块（新增 `src/repo-ref.mjs`，改 `change-context`/`gh-adapter`/`actions`/`tools`/`flow`/`repository-resolver`）、7 个测试文件、2 份 mock 夹具；`docs/teamflow/memory.md` 的约定/待办同步。
- **不在范围（技术变更单显式排除）**：`src/http.mjs`、`src/index.mjs`、`src/runtime-config.mjs`、`client.js`、`packages/forge-gitee/**` 零改动（E2 已验证）；`forge-gitee` 同源两段假设与 `{data:{list}}` 未解包**另开单**（memory.md 待办已记）。
- **夹具**：`packages/forge-devops/test/fixtures/dop-change-native.json`（`code`/`state`/`summary`/`userStory` 单对象、缺 `acceptance_criteria`）、`packages/forge-devops/test/fixtures/gh-repo-list-gitee.json`（`{data:{list}}` + `path_with_namespace`）均按 UAT 报告描述的形状手工构造，**非企业实测**。
- **浏览器**：本单无 UI 改动（`client.js` 零 diff），沙箱内浏览器不可启动属宿主限制，按 NOT RUN 记入 §7，不计交付缺陷。

## 3. 上轮缺陷复验（检测命令按原样执行 + 修正后判据）

| 编号 | round-1 级 | 功能模块 | 上轮检测命令（按原样执行）的结果 | 修正后判据（本轮实跑） | 现状 |
|---|---|---|---|---|---|
| Q-1 | P2 | forge-devops · change-context 归一 | 命令断言 `e.reason!=='RECORD_INVALID'`，但 `ContextError` 只抛 `.code`（值为 `CONTEXT_RECORD_INVALID`），脚本自身输出 `WRONG-REASON undefined`、退出码 2 —— 该行的**检测命令自身不可通过**（检查器缺陷，与产品行为无关） | `cd packages/forge-devops && node --input-type=module -e "import {normalizeChangeRecord as n} from './src/change-context.mjs'; const bad=[{code:'A1',title:'',status:'open'},{code:'A1',title:'t',status:''},{code:'A1',title:'   ',status:'open'},{code:'A1',title:'t',status:'  '},{code:'A1',summary:'',status:'open'},{code:'A1',title:'t',state:'  '}]; for (const r of bad){try{n(r,{sourceType:'mock'});console.log('ACCEPTED',JSON.stringify(r));process.exit(1)}catch(e){if(e.code!=='CONTEXT_RECORD_INVALID'){console.log('WRONG-CODE',e.code);process.exit(2)}}} console.log('REJECTED-ALL')"` → `REJECTED-ALL`、退出码 0；源码 `packages/forge-devops/src/change-context.mjs:201-207` 非空校验 + 新用例 `packages/forge-devops/test/context.test.mjs:198`；E6 断言空白变体 3 条拒绝、`ID_MISMATCH` 仍优先、ready 卡片标题非空 | 已修复 |
| Q-2 | P3 | forge-devops · repo-ref 文档口径 | `node --input-type=module -e "import {repoOfTarget} from './src/repo-ref.mjs'; console.log(repoOfTarget('acme'))"` → `null`、退出码 0（行为安全） | 注释已同步：`packages/forge-devops/src/repo-ref.mjs:101` 写明「链接、裸编号与 **1 段裸名（`acme`）** 回 `null`」，`:86` 写「1 段裸名…一律 `null`」；全库搜「纯仓库名原样返回」0 命中（E5 固定该口径） | 已修复 |

**缺陷类别命中数复算**（与修复摘要比对）：
- 空白必填类：修复前 2/2 接受（空 `title`、空 `status`）；修复后**空白变体矩阵 7/7 拒绝**（空串、纯空白 × 两字段 + 原生 `summary` 空 + 原生 `state` 空），与 dev 报告「改前 18/19 失败、改后 19/19」的计数一致（`context.test.mjs` 现有 19 项且 19/19 通过）。
- 文档口径类：旧串「纯仓库名原样返回」命中数 **1 → 0**，`repoOfTarget('acme')` 仍为 `null`（安全方向未变）。
- **判据有牙证明**（变异实验）：临时删除 `change-context.mjs:203-207` 非空校验 → `test/context.test.mjs` 17/19、检查器 32/35（B7/B8/E6 三项转红）；随后按备份还原，`sha256=2d451e81452f5e2c16d8c25d02adf98221feaf601af31ca6fb4d1b3961e26363` 与改动前逐字节一致、无残留标记，用例与检查器恢复全绿。说明本轮断言不是恒真。

## 4. 本轮执行结果（命令 + 退出码）

| 编号 | 检查 | 命令（仓库根执行，除特别标注） | 退出码 | 结果 |
|---|---|---|---|---|
| R1 | 上轮检查器回归（原样重跑，再追加 1 项） | `node logs/teamflow/tf-mvup4d40-79kgoj/scripts/qa-r6-contract-fix.mjs` | 0 | **35/35 断言通过**（A1–A7 / B1–B8 / C1–C10 / D1–D4 / E1–E6；上轮报告记 33/33，报告定稿后脚本曾增 1 项，重跑得 34/34，本轮新增 E6 后 35/35） |
| R2 | 端到端主路径（真实 `createDevopsFlow` + `createGhAdapter` + `createCliRunner`，仅注入回放） | `node logs/teamflow/tf-mvup4d40-79kgoj/scripts/delivery-e2e-three-defects.mjs` | 0 | **11/11 终态/不变量断言通过** |
| R3 | 包内全量用例（glob 形态，非目录形态） | `cd packages/forge-devops && node --test "test/*.test.mjs"` | 0 | **477 pass / 0 fail / 0 skip**（基线 432，上轮 476，+1） |
| R4 | 根级门禁 | `pnpm check` | 0 | 1443 tests / **1440 pass / 0 fail / 3 skipped**（3 条为既有环境用例，含宿主探针 `spawnSync dsh ENOENT`） |
| R5 | 空白与冲突标记 | `git diff --check` | 0 | 无输出 |
| R6 | 文档检查 | `node scripts/check-docs.mjs` | 0 | `docs: ok`（67 files / 568 tables / 580 links） |
| R7 | 定向 7 文件 | `cd packages/forge-devops && node --test test/repo-ref.test.mjs test/context.test.mjs test/gh-adapter.test.mjs test/repository.test.mjs test/actions.test.mjs test/tools.test.mjs test/flow.test.mjs` | 0 | 146/146 通过 |
| R8 | 单文件复跑 | `cd packages/forge-devops && node --test test/context.test.mjs` | 0 | 19/19 通过（含 Q-1 新用例） |
| R9 | 接口存在性（独立于检查器） | `node --input-type=module -e "…buildDevopsTools / createGhAdapter / createDevopsFlow…"` | 0 | 工具 9 个（`forge_devops_*` 读 4 + context + 写 4）；适配器 10 方法；`GH_LIST_LIMIT=100`；`createDevopsFlow` 为函数 |
| R10 | 接口静态一致性（导入 × 导出） | `grep -rn "from './repo-ref.mjs'" packages/forge-devops/src` | 0 | 5 处调用面各取 `pickRepoRef` / `repoOfTarget` / `isRepoRef,parseTargetRef` / 6 个段常量，均在 `repo-ref.mjs` 的 10 个导出内；无本地 `repoOf`/`bareRepo`/`sameRepo` 兜底 |
| R11 | 提交面卫生 | `git status --porcelain` + `.gitignore` + 密钥扫描 | 0 | 18 项（13 M + 5 新文件），无 `node_modules/`/`dist/`/缓存/IDE/`.log`/密钥；`AGENTS.md` 与受保护文件零改动 |
| R12 | Q-1 修正后判据 | 见 §3 Q-1 行命令 | 0 | `REJECTED-ALL` |
| R13 | Q-2 对照 | 见 §3 Q-2 行命令 + 口径扫描 | 0 | `null`；旧串 0 命中 |

R2 证据要点：阶段 A 以 dop 原生夹具 + gh 包封夹具装配真实 flow —— `changeId=ARD777777`、`title=企业原生字段：积分兑换二期`、`status=open`、`missingFields=["acceptance_criteria"]`、卡片渲染「平台未提供」、`stories=1`、`releaseNum=R20260706001`、`visible=acme/group/demo, acme/points-mall`、`selected=acme/points-mall`、一次聚合取数（`change view`→`repo list`→`issue list`→`pr list`）；阶段 B 三段评论目标 `status=done`、`target=acme/group/demo#12`、`readback.ok=true`、平台 argv 逐字 `issue comment acme/group/demo#12 --body …`、门禁恰一次见完整三段；反向折两段 → `denied/REPO_NOT_SELECTED`、零子进程。

## 5. 用例面覆盖（复用 + 本轮新增）

- **复用上轮 34 项**：A 接口一致性 7 项、B 缺陷① 8 项、C 缺陷② 10 项、D 缺陷③ 4 项、E 架构/卫生 5 项（E1–E5），R1 全绿。
- **本轮新增 E6「Q-1 修复回归」**：上轮 B8 只观察了 2 条空串被接受（未覆盖原生别名入口、`ID_MISMATCH` 判定顺序、修复后卡片用户可见终态），故补 1 项覆盖：原生 `summary`/`state` 空值、纯空白 `title` 均 `CONTEXT_RECORD_INVALID`；`id/code` 冲突仍先 `ID_MISMATCH`；合法原生记录经 `resolveBuildingRepository` + `buildContextCard` 得 `status=ready` 且 `title` 已 trim、`missingFields` 不含 `title`/`status`。

## 6. 缺陷表

| 编号 | 严重级(P0/P1/P2/P3) | 功能模块 | 复现步骤 | 期望行为 | 实际行为 | 关联验收项 | 检测命令 | 通过判据 |
|---|---|---|---|---|---|---|---|---|

**未发现缺陷（本轮无仍开启缺陷）。** 上轮 Q-1/Q-2 已修复，见 §3 复验表；三个 UAT 缺陷的正反例、五调用面判词一致性、写门禁不放松、包封解包、架构单点化与提交面卫生均通过。

## 7. 架构核查（对照注入的架构蓝图）

- **蓝图的抽取已落地**：`packages/forge-devops/src/repo-ref.mjs` 是段语法、目标剥壳、候选匹配的唯一实现，10 个导出与蓝图 `api` 逐字一致（A1）；五个调用面 `repository-resolver.mjs:25`（`pickRepoRef`）、`gh-adapter.mjs:36`（6 个段常量 + `isRepoRef`/`parseRepoRef`/`parseTargetRef`）、`flow.mjs:23` 与 `tools.mjs:18`（`repoOfTarget`）、`actions.mjs:30`（`isRepoRef`/`parseTargetRef`）全部改为引用它，无第二份段正则、无 `repoOf`/`bareRepo` 本地兜底（A2/A3）；`TARGET_LINK_PATTERN` 由 `REPO_SEGMENT_SOURCE` + MIN/MAX 拼出（A4）。
- **边界正确**：原生命名只在 `change-context` 入口吸收（别名表唯一，A5/B1）；包封解包与 `path_with_namespace` 别名只在 `gh-adapter` 吸收（D1/D4）；下游只见契约 snake_case；写门禁、四状态、幂等键 `84c4abf9f660544e`、唯一 `execFile` 出口、读信封均未动（C5–C10、E1、E2）。
- **无重复实现 / 未破坏既有结构**：段字符集仅出现在 `repo-ref.mjs`，另两处命中与本单无关（`dop-adapter.mjs:41` 变更号、`gh-adapter.mjs:458` 单段 `ghOwner` 校验，均为 HEAD 已有、非本轮引入，观察不阻断）。
- **已知未修（技术变更单显式另开单）**：`forge-gitee` 同源两段假设与不解包 `{data:{list}}`，memory.md 待办已记，不计本次缺陷。
- **偏离蓝图**：无实现级偏离；上轮 Q-2 的文档口径偏离已同步。
- **交付形态**：纯 ESM 源码包，无编译/打包步骤；模块 import 即验证（E4，7 模块 + 入口 `name=forge-devops`）；无新增依赖（package.json 零 diff）。`dsh` 不在 PATH，profile 装载验证 NOT RUN（见 §8）。

## 8. 人工补测清单（环境限制，非交付缺陷）

| 项 | 判据 | 方法 | 工具 | 状态 |
|---|---|---|---|---|
| 企业内网 Windows / 麒麟 aarch64：真实 dop `change view` 原生字段（含 `summary` 语义、`userStory` 内层键、验收条件承载位置） | 字段可读、缺字段只降级、不伪造 | 实机装目标 DSH，跑 `forge_devops_change_context` 看卡片与 `missingFields` | 企业 dop CLI + dsh | NOT RUN（无企业环境） |
| 真实 `gh repo list --json` 包封与字段过滤 | 可见仓库如实列出；平台若过滤请求字段则只改 `GH_REPO_LIST_FIELDS` | 企业 Gitee 上跑 `gh repo list <owner> --json …` 对照 | 企业 gh + 凭据 | NOT RUN |
| 真实写幂等复用一次取证 | 同变更重跑 `reused=true`、`key` 一致；三段仓库评论 `done` 且回读一致 | 受控写通道各执行两次 | 企业 Gitee + policy 放行 | NOT RUN |
| 宿主装载（交付形态） | 目标版本 DSH 上 `--patch` 装配后插件可用、模块可加载 | 目标环境 `dsh --profile … --patch packages/forge-devops/cordis.patch.yml` 启动并枚举 9 个工具 | 目标 DSH | NOT RUN（本机 PATH 无目标 `dsh`） |
| 宿主探针 3 条 skip | 目标环境 `pnpm check` 全绿 | 目标环境 `node --run check` | DSH | NOT RUN（既有 skip，非本次引入） |
| Web 配置页走查（本单无 UI 改动） | 配置页仍可打开、路径区交互无回退 | `dsh web` 人工看一遍 | 浏览器 | NOT RUN（沙箱浏览器不可启动） |

## 9. 结论

- **验收建议：可进入验收（acceptance-ready）**。上轮两条缺陷均已修复并可复验：Q-1 有源码判据 + 永久用例 + 独立断言 + 变异实验（有牙）；Q-2 注释与行为一致。三个 UAT 缺陷维持「已修复」：单元级正反例、静态接口一致性、真实组合根端到端终态证据齐全，门禁未放松（折两段仍拒、裸名不跨组、幂等键未变）。
- **遗留（非缺陷）**：`forge-gitee` 同源两段假设/包封未修（另开单）；`dsh` 实机装载与真实企业 dop/gh、真实写幂等 NOT RUN。
- **证据纪律声明**：本轮为组件级 mock 实测，未声称企业联调或 Windows/麒麟实机已验证；§8 NOT RUN 项不代表通过。
- **工作区**：未提交（13 文件改动 + 5 新文件，含本任务夹与 2 份夹具）；无构建产物、无日志 dump、无根目录脚本；本轮临时插桩已按备份还原（sha256 校验一致）。

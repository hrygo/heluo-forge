# r7 · Gitee 交付判定默认登记（read-only judge）· QA 报告（第 2 轮 · 复验）

- 需求夹：`docs/teamflow/20261030-r7-judge-default-catalog/`
- 被测交付：把 `gitee.delivery.judge` 登记为**随包默认可用**的只读判定；4 个受控写仍默认 `denied`；工具面 8 个、名字与顺序不变
- 分支：`feat/devops-change-flow`（未提交：17 个已改文件 + 2 个未跟踪项）；本轮为**返修后复验**，返修对象 = 第 1 轮唯一 P2 缺陷 DEF-1（判定工具参数描述与实现接受面不一致）
- 角色边界：只判定、不关闭；真实装入 / 重启 / 回滚（AC-13/14/15）归主 agent，本报告标 **NOT RUN**
- 报告时间：2026-10-30 21:45–22:02 CST（第 1 轮：21:32–21:41 CST）

## 1. 环境与证据基线

| 项 | 值 | 来源类型 |
|---|---|---|
| 平台 / 架构 | darwin arm64（macOS） | 实测 |
| Node | v24.13.0 | 实测 `process.version` |
| 宿主 DSH | `dsh` **不在 PATH**；包声明 `engines.dsh >= 0.2.1-rc.2` | 实测 `command -v dsh` |
| Profile 真实装入 / 重启 / 回滚 | NOT RUN（AC-13/14/15 → 主 agent） | — |
| 企业 Gitee / 真机（Windows、麒麟 aarch64） | NOT RUN（无真实凭据、无实机） | — |
| 证据口径 | 每条命令为实测，退出码与关键断言值如下；离线/mock 不写成企业联调 | — |

## 2. 复验方法（规则 6b：先重跑回归契约，再补缺口）

**(a) 先原样重跑上一轮 `logs/teamflow/tf-mvutl9xh-fjab7l/scripts/` 的全部检查器**：

| 检查器 | 本轮结果 |
|---|---|
| `t1-judge-default-envelope.mjs` | exit 0；judgeEnvelope `{ok:true, executed:false, remote_calls:0, readback_ok:true}`、4 写全 `denied`、`gateActions=["gitee.delivery.judge"]`、tools 8；AC-8 段 `{mounted:true, catalogSize:3, judgeRule:"unregistered-action", gateOperations:0}` |
| `check-r4-r7-annotations.mjs` | exit 0；`PRD.md=4 QA-REPORT.md=4 ACCEPTANCE.md=3 TECHNICAL.md=13`，旧口径行 100% 带「r7 修订」 |
| `mutation-judge-default.mjs` | exit 0；两腿均 pass（bundle-artifact 腿：基线 exit0 → 删 judge 行 exit1 → 还原 exit0 且 `restoredIdenticalToBackup=true`；patch-mount 腿同） |
| `gate-judge-criteria-parity.mjs` | exit 0；`基线 exit0 / 变异 exit1（命中 1 条）/ 还原 exit0`，`sha256 62f8721acc9b → 62f8721acc9b` |
| `judge-criteria-doc-parity.mjs` | exit 0（本轮**扩展为多腿**，见 (b)） |

**(b) 本轮新增探针（上一轮只扫了 `criteria` 一个参数、一个取值串）**——把同一缺陷类扩成「工具面声明 × 实现接受面」的横向扫描，同路径覆写不新增文件：

| 腿 | 覆盖面（上一轮缺口） | 结果 |
|---|---|---|
| A1 描述取值整表 | 照描述整表写 → `ready` | pass |
| A2 每个声明取值逐条 | `pass→passed / fail→failed / unknown→unknown` × 4 项（上一轮只测了整表） | 12/12 pass |
| A3 描述声明的对象形态逐字 | `{status:passed\|failed\|unknown}`、pendingDelivery `{count:0/2}`、humanConfirmed `{decision:confirmed/changes-requested}` | 7/7 pass |
| A4 未声明取值不得通过 | `success/ok/yes/merged/act/done/skipped/""` 不得判 passed（fail-closed 方向） | 32/32 pass |
| B 控制腿 | TECHNICAL §3.2 对象事实写法 → `ready`（证明探针本身可信） | pass |
| C 类扫描（跨 2 包 17 个工具） | forge-gitee 8 + forge-devops 9 个工具的描述枚举与 schema `enum`，每个取值须在两包 `src/` 里**整词**存在 | 31 个取值 / 0 缺失 |
| D 文档面 | PRD/TECHNICAL/README/design 中 criteria 取值枚举 ⊆ 实现接受集（只认「取值/status/decision: a\|b」声明式写法，避免 Markdown 表格管道误判） | 0 越界 |

## 3. 用例与结果

### 3.1 验收项

| 验收项 | 判据（摘要） | 实测命令 | 结果 |
|---|---|---|---|
| AC-1 | 目录恰 4 条（3 读 + 1 判定）、judge `kind:read`/`target` 逐字 `change`/`egress:allow`/`enabled`、0 条 write | `t1-judge-default-envelope.mjs`；`cd packages/forge-gitee && node --test test/entry.test.mjs` | pass（catalogSize 4；编译后 `egress` 仍 `allow`） |
| AC-2 | 判定默认可用：`done`/`rule=ready`/`executed:false`/`remote_calls:0`；**照描述写也到 `done`** | 同上 + `gate-judge-criteria-parity.mjs` + `actions.test.mjs:570` 门禁用例 | pass（返修后成立） |
| AC-3 | 4 个写工具仍 `denied` + `unregistered-action`；门禁 operation 仅判定 1 次 | `t1-judge-default-envelope.mjs` | pass（4× denied；信件封无 `executed` 键） |
| AC-4 | 断言名含「默认登记判定、不默认登记写」+ 删 judge 行变异必红、还原 sha256 一致 | `mutation-judge-default.mjs` | pass（两腿 exit 0，`afterHashStable=true`） |
| AC-5 | `criteria` 含 unknown → `status:unknown`、固定 reason、不计通过 | `cd packages/forge-gitee && node --test test/actions.test.mjs` | pass（含在 177/177 内） |
| AC-6 | 缺参 / 非法入参 fail closed，零子进程 | 同上 | pass |
| AC-7 | 判定零副作用：适配器/execFile 0 次、`executed:false`、无 close/merge 通道、不产审批台账 | 探针信封 + `grep -rn "child_process" packages/forge-gitee/src` | pass |
| AC-8 | fail-closed 仍只要 3 条读；缺 judge 时挂载成功、判定降级 `denied` | 探针 `ac8` 段 | pass |
| AC-9 | `dsh.bundle.patch` 存在、`files` 白名单含 `cordis.patch.yml` | 产物 `package.json` 解包 | pass（`files:["src","cordis.patch.yml","README.md"]`） |
| AC-10 | 产物无 `workspace:`、真版本依赖 + bundledDependencies | 解包 `package.json` | pass（`grep -c workspace:` = 0；`@heluo/forge-policy 0.1.0` 且 bundled） |
| AC-11 | 重建 `dist/r7`；产物含 judge 条目；源文件 sha256 逐字节一致 | 重建命令 + `shasum -a 256` 解包比对 | pass（见 3.2 第 5 条：本轮**重建后**成立） |
| AC-12 | 产物入口可导入（exit 0），顶层不碰未注入 ctx | `node -e "import('./src/index.mjs')"`（解包目录内） | pass（`name=forge-gitee`、`inject=["tools","policy"]`、`apply=function`、`GITEE_TOOLS=8`） |
| AC-13 | 真实装入 profile | 主 agent 执行 | **NOT RUN**（§5 #1） |
| AC-14 | 回滚可执行（旧 tgz sha256 `a0a506f3…92092c`） | 主 agent 执行 | **NOT RUN**（§5 #2） |
| AC-15 | 重启后 8 工具出现、判定不再 `unregistered` | 主 agent 执行 | **NOT RUN**（§5 #3） |
| AC-16 | 三份产品文档统一「3 读 + 1 只读判定 + 4 受控写」；旧措辞 grep 零命中 | AC-16 原文 grep（含 r7 任务夹） | pass（`README.md`/`docs/design/`/包 README **0 命中**；10 处命中全在 r7 任务夹内引述被取代措辞或 grep 命令本体 = PRD 明示例外） |
| AC-17 | r4 四份就地修订、每处带「r7 修订」、原文与证据编号不删 | `check-r4-r7-annotations.mjs` | pass（4/4/3/13，冲突口径 0） |
| AC-18 | `pnpm check` 全绿、用例只增不减、`git diff --check` 干净、安全扫描未放宽 | `pnpm check`；`git diff --check` | pass（**1468 tests / 1465 pass / 0 fail / 3 skipped**；上一轮 1467/1464/0/3 ⇒ +1 只增；`diff --check` exit 0） |
| AC-19 | 证据含命令/时间/宿主版本/来源类型；真实安装与真机标 NOT RUN | 本报告 §1/§3/§5 | pass |
| AC-20 | `git status` 无 tgz / logs / dist / node_modules 噪声 | `git status --porcelain`；`git check-ignore -v` | pass（17 M + 2 `??`；噪声 grep 0；`dist/`→`.gitignore:41`、`logs/`→`:81`、`*.tgz`→`:57`） |
| AC-21 | 关闭四项逐条证据、只判定不关闭、白名单无 close/merge | §6 | pass（本次未执行任何关闭/合并动作） |

### 3.2 交付形态契约（9 条）

| # | 判据 | 实测 | 结果 |
|---|---|---|---|
| 1 | profile 层加载入口声明，入口 `name` 用包根名 | `cordis.patch.yml`：`heluo-gitee`→`@heluo/forge-gitee`（无子路径） | pass |
| 2 | 入口声明文件进 `files` 白名单 | `files` 含 `cordis.patch.yml`，产物内实测存在 | pass |
| 3 | 依赖协议可解析 | 产物 `package.json` 无 `workspace:`（`grep -c` = 0） | pass |
| 4 | 宿主运行期依赖按 peer/可选 peer | `src/` 无 `@deepseek-ai/*` ⇒ 无 peer 需要；`@heluo/forge-policy` 走 bundled | pass |
| 5 | **构建产物与源码同步** | 本轮发现 `dist/r7/*.tgz` 是第 1 轮（21:32）产物，**不含返修**：解包 `src/gitee-actions.mjs` `301cb0ff…` ≠ 工作区 `035d23d7…`、`src/gitee-delivery.mjs` `75e3bad4…` ≠ 工作区 `62f8721a…` ⇒ 已重建（21:59，121694 B，sha256 `8453af62…adf216`），旧包改名 `.stale-before-def1-fix` 留证；重建后三处逐字节一致（`035d23d7…` / `62f8721a…` / `8a58d702…`），产物内 `conclusionOf` 与新政描述实测存在 | pass（**本轮内闭合**，见 §4） |
| 6 | 装载安全（顶层不抛错、不碰未注入 ctx） | 产物入口 `import` exit 0 | pass |
| 7 | 能被真实 profile 装入 | 主 agent | NOT RUN |
| 8 | 装载后宿主真实加载 | 重启后核对 | NOT RUN |
| 9 | 安装必须带回滚 | README 回滚节 + PRD AC-14（旧 tgz sha256、`remove`→`add` 顺序） | pass（文档面）；执行 NOT RUN |

### 3.3 架构与接口一致性（静态核对，无需运行）

| 复核点 | 结论 |
|---|---|
| 蓝图「权限事实只改补丁层」 | 遵守：唯一权限事实在 `packages/forge-gitee/cordis.patch.yml` 第 4 条，由 `compileCatalog` 装配期编译；源码无开关，`assertReadCatalog` 仍只要 3 条读 |
| 返修是否越界 | 否：返修只动 `src/gitee-delivery.mjs`（新增 `conclusionOf` :269、归一递归 :299）与 `src/gitee-actions.mjs` 的描述文本；门禁/四状态/写动作/策略包零改动 |
| 接口一致性（0a） | pass：`conclusionOf`(:269) 被 `:299` 调用；`evaluateCriterion(item, raw, currentCommit = null)`(:293) 的递归调用参数形状（对象 `{status}`）与对象分支(:361) 一致——A3 腿实测三种 status 与 `count`/`decision` 形态全部落地；`GITEE_WRITE_TOOLS`(4)/`GITEE_JUDGE_TOOLS`/`GITEE_TOOLS`(8)/`buildGiteeTools` 均实际导出且被测试与探针成功导入 |
| 重复实现 / 该抽未抽 | 无：目录真源唯一（`grep -rln "gitee.delivery.judge"` 无第二份目录副本）；判定与写在常量层各成一集合 |
| 既有结构是否被破坏 | 否：8 个工具名/顺序、门禁规则、四状态、四个写动作默认 denied 全不变 |

## 4. 复验对比（仅列第 1 轮已提出项，闭合状态）

| 编号 | round-2 级 | 功能模块 | 复验 Check command（原文照跑） | 复验实测 | 结论 |
|---|---|---|---|---|---|
| DEF-1 | 已闭合（原 P2） | forge-gitee 判定工具面（模型面参数描述） | `node logs/teamflow/tf-mvutl9xh-fjab7l/scripts/judge-criteria-doc-parity.mjs`；Pass criterion：exit 0 且「描述取值」腿 `ready=true` + 控制腿 `ready=true` | exit 0；A1 描述取值整表 `ready=true`、B 控制腿 `ready=true`、A2 12/12、A3 7/7、A4 32/32 | **闭合**：描述已改为「取值 pass\|fail\|unknown（四项通用）+ 对象事实写法」，实现加 `conclusionOf` 归一；两者双向一致 |
| DEF-1 回归门禁 | 新增并生效 | 包内测试 | `cd packages/forge-gitee && node --test test/actions.test.mjs` | pass（21 例含 `:570`「AC-2 模型面描述与判定接受面一致」；从真实注册定义读描述回放） | 闭合；变异脚本证明该门禁会红（基线绿→变异红→还原 sha256 一致） |
| 缺陷类命中数对比 | 一致 | — | dev 宣称「类扫描 1 站点 1→1」；本轮独立重算 | 站点数 **1→1**（gitee 工具描述里唯一声明判定结论取值的站点 = `criteria`）；该类不一致数 **1→0**；横向扩展扫描 31 个枚举取值 × 2 包 = 0 缺失 | 与修复摘要**一致** |
| OBS-1 | P3 仍开 | 门禁口径 | `node --test "tests/*.test.mjs"` | 117 tests / 114 pass / 0 fail / **3 skipped**（既有环境 skip：`dsh` 不在 PATH 的 bundle 装/升/卸 rehearsal ×2 + host probe ×1），本轮未新增 skip | 保持观察 |
| OBS-2 | P3 仍开 | 架构 | `node -e "import('./packages/forge-gitee/src/gitee-tools.mjs').then(m=>console.log(Array.isArray(m.buildGiteeTools(new Proxy({},{get:()=>async()=>({})})))))"` | `true`（蓝图写 `Record<string, ToolDefinition>`，实为 8 条数组；无功能影响） | 保持观察 |
| OBS-3 | P3 仍开 | 文档卫生 | `grep -rn '3 条只读\|5 个受控写' docs/teamflow/20261030-r7-judge-default-catalog` | 10 处（PRD 5 / TECHNICAL 3 / 前一轮本报告 2），均为引述被取代措辞或 grep 命令本体（AC-16 明示例外） | 保持观察 |
| OBS-4 | P3 仍开 | 版本控制 | `git status --porcelain \| grep TEAM-FULL-INSTALL` | 仍为未跟踪文件（既有团队分发包说明，非本次产物） | 保持观察 |
| OBS-5（本轮新提） | P3 | 文档卫生（测试注释） | `grep -rn '5 个写工具' packages/forge-gitee/test/` | `test/host-contract.test.mjs:6`、`test/helpers/fake-host.mjs:209` 两处注释仍写「5 个写工具」，描述 r4 期 D-1 事故；不在 AC-16 grep 范围（该 AC 只覆盖 README/design/任务夹），仅注释、无契约影响 | 观察 |

## 5. 缺陷表（仅 OPEN）

| 编号 | 严重级 | 功能模块 | 复现步骤 | 期望行为 | 实际行为 | 关联验收项 | 检测命令 | 通过判据 |
|---|---|---|---|---|---|---|---|---|
| OBS-1 | P3 | 门禁口径 | 读 AC-18 字面「0 skip」 | 套件 0 skip | 3 条既有**环境** skip（`dsh` 不在 PATH 的 bundle 装/升/卸 rehearsal ×2、host probe ×1），本次交付未新增 | AC-18 | `node --test "tests/*.test.mjs" 2>&1 \| grep -E "^ℹ (tests\|pass\|fail\|skipped)"` | - |
| OBS-2 | P3 | 架构（蓝图措辞） | 读 TECH 蓝图 `buildGiteeTools -> Record<string, ToolDefinition>` | 返回 Record | 实为 8 条数组（调用方按数组迭代，无功能影响） | - | `node -e "import('./packages/forge-gitee/src/gitee-tools.mjs').then(m=>console.log(Array.isArray(m.buildGiteeTools(new Proxy({},{get:()=>async()=>({})})))))"` | - |
| OBS-3 | P3 | 文档卫生 | 在 r7 任务夹内 grep 旧措辞 | 任务夹不引旧措辞 | 10 处引述被取代措辞或 grep 命令本体（AC-16 允许的例外），会让后人 grep 时命中任务夹 | AC-16 | `grep -rn '3 条只读\|5 个受控写' docs/teamflow/20261030-r7-judge-default-catalog` | - |
| OBS-4 | P3 | 版本控制 | `git status --porcelain` | 只含本需求改动 | 另有未跟踪 `TEAM-FULL-INSTALL.md`（既有团队敏感扫描工具分发包说明，非本次交付产物），提交前需确认是否纳入 | AC-20 | `git status --porcelain \| grep TEAM-FULL-INSTALL` | - |
| OBS-5 | P3 | 文档卫生（测试注释） | `grep -rn '5 个写工具' packages/forge-gitee/test/` | 注释与现口径一致 | 两处注释仍写「5 个写工具」（r4 期事故记述）；仅注释、不影响契约 | AC-16（范围外） | `grep -rn '5 个写工具' packages/forge-gitee/test/` | - |

**未发现 OPEN 的 P0 / P1 / P2 缺陷**；未发现「文件存在但主路径不工作」类问题（主路径由真策略装配探针 + 177 例包内用例实跑）。

## 6. 人工补测清单（环境限制，非交付缺陷）

| # | 项 | 方法 | 工具 | 通过判据 |
|---|---|---|---|---|
| 1 | 真实装入（AC-13） | `cd ~/.dsh/profiles/web && pnpm remove @heluo/forge-gitee && pnpm add file:<仓库根>/dist/r7/heluo-forge-gitee-0.1.0.tgz`（`<仓库根>` 按 `pwd` 回填；**装前先抄第 2 项命令**） | pnpm（`dsh` 不在 PATH） | profile `dependencies` 指向新 tgz；`dsh.profile.bundles` 含包名；装入目录 `cordis.patch.yml` 含 `gitee.delivery.judge`；`src/gitee-delivery.mjs` sha256 = `62f8721a…09cfb95`；退出码 0 |
| 2 | 回滚（AC-14） | `cd ~/.dsh/profiles/web && pnpm remove @heluo/forge-gitee && pnpm add file:~/.dsh/artifacts/heluo-forge-gitee/heluo-forge-gitee-0.1.0.tgz` | pnpm | 装回旧 tgz（sha256 `a0a506f3…92092c`）；`bundles` 含包名；patch **不含** judge；重启后判定重新 `denied`、8 工具仍在、宿主可启动 |
| 3 | 重启后真实加载（AC-15） | 重启 `dsh web` → 新会话列工具 → 调 `forge_gitee_delivery_gate`（对象事实写法） | dsh 会话 | 8 个 gitee 工具出现；判定不再 `unregistered-action`；返回 `done`/`executed:false`/`remote_calls:0` |
| 4 | 真实企业 Gitee / 真机（AC-19） | 内网 Windows、麒麟 aarch64 + 真实凭据复核工具面与判定 | 企业环境 | 判定可用、4 写仍 denied；本报告不作企业联调声明 |
| 5 | 浏览器 / UI | N/A —— 本交付为后端插件（工具面），无可见 UI，无视觉/交互项，P3 craft 观察不适用 | - | - |

## 7. 结论

- **可验收**：本轮复验 AC-1…AC-12、AC-16…AC-20 全部由实测命令通过；第 1 轮唯一 P2（DEF-1）**已闭合**，并新增独立回归门禁（描述与接受面双向一致，变异可证其会红）。
- **本轮自发现并闭合 1 项交付风险**：`dist/r7` 的 tarball 是返修前构建的（与工作区 sha256 不一致），会让 AC-13 装到修复前的包 ⇒ 已重建并逐字节校核，旧包改名留证。装前若要重装，务必用重建后的 `8453af62…`。
- `pnpm check` 1468 tests / 1465 pass / 0 fail / 3 既有环境 skip，包内 177/177 0 skip，用例只增不减；`git diff --check` 干净。
- 5 条 P3 观察（含 1 条本轮新提），均不阻塞。AC-13/14/15 与真机按 PRD 归主 agent。

## 8. 关闭条件四项（只判定，不关闭）

| 条件 | 判定 | 证据 | 来源类型 |
|---|---|---|---|
| acceptance | pass | §3 全部实测通过，DEF-1 闭合 | ai-qa（离线用例 + 探针 + 变异） |
| merged | unknown | 工作区未提交、无 PR 记录可取（不猜） | unknown |
| pendingDelivery | unknown | 真实装入 / 重启 / 回滚未执行（§6 #1–#3） | unknown |
| humanConfirmed | unknown | 无人工确认记录 | unknown |

⇒ 综合：**不关闭**（有 unknown 项即不计通过），交由人工按 §6 补测后再判。白名单无 `close`/`merge`/`release` 动作，本次未执行任何关闭或合并。

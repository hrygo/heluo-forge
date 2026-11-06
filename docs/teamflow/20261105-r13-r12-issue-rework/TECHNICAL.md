<!-- meta: summary="r13 返工技术方案：企业 Skill 按宿主 rc.5 契约产出 bundled 候选（source/rank/resourceBase 与 get(candidate) 归一），企业闭包纳入 devops/gitee 两成员，工具面文档统一 11 个，历史夹 5 个 docs 错误按等义脱敏修复，九类矩阵与 journal 根一致性以只读探针承载真实列默认 NOT RUN。" -->
基线依赖：docs/teamflow/20261105-r13-r12-issue-delivery/（不写「取代」；其 20 条 AC 仍是完整验收基线）

# r12 问题返工技术方案

> 编制：技术负责人（代拟）；日期：2026-11-05；依据：本任务夹 [PRD](PRD.md)、r12 [QA 报告](<../20261105-r12-issue-delivery/QA-REPORT.md>) 与 [验收报告](<../20261105-r12-issue-delivery/ACCEPTANCE.md>)、r12 遗留的宿主检查器 `qa-r12-skill-host.mjs`，以及本阶段在真实 DSH `0.2.1-rc.5` 源码 `@deepseek-ai/dsh-skill` 上的契约核验。本轮不新开需求语义，只补齐 r12 的 D-1～D-6。

## 1. 架构判断与缺陷到模块的映射

企业组合包已具备三件套（策略/凭据/IAM）与一个 Skill 入口，但 Skill 的注册面按「自研 registry」而非宿主 `SkillRegistry` 编写；组合包的依赖闭包只收了三个 Host 插件，DevOps/Gitee 仍是「单独安装」的形态。返工不引入新抽象，只做三件事：**把 Skill 候选形状对齐宿主契约、把闭包扩到六个成员、把证据链落到可复跑脚本**。

| 缺陷 | 落点（唯一改点） | 判据 |
|---|---|---|
| D-1 候选契约不符（`source` 非字符串、`get(candidate)` 取不到正文） | `packages/forge-enterprise/src/skills.mjs` | AC-1/AC-2 |
| D-2 隔离装配/撤销/重复 apply 无证据 | `packages/forge-enterprise/src/issue-delivery-skill.mjs` | AC-2 |
| D-3 企业闭包缺 DevOps/Gitee | `packages/forge-enterprise/package.json`、`packages/forge-enterprise/cordis.patch.yml` | AC-3/AC-4/AC-8 |
| D-4 工具面文档仍写 10 个 | 四份文档（见 §6.4） | AC-5 |
| D-5 `pnpm check` 因历史夹 5 个 docs 错误失败 | r12 `PRD.md` 1 处路径、`ACCEPTANCE.md` 4 处 `#L` 链接 | AC-6（与 F1 同一处，只做等义修复） |
| D-6 缺九类场景矩阵 / G0 根一致性证据 | `scripts/probe/run-teamflow-scenario-matrix.mjs`、`scripts/probe/check-teamflow-journal-roots.mjs`（新增，只读） | AC-7/AC-9，真实列 NOT RUN |

## 2. 数据模型与契约

### 2.1 条款（clause）与 Skill 候选

`loadClausePack()` 目前把 `skills/clauses.json` 的条目归一成 `{id,title,level,status,owner,summary,appliesTo,references,body,bytes,key,decision}`——**只留正文文本，丢掉了正文文件的相对位置**，所以 provider 无法算出资源目录。本轮给归一结果加一个字段（其余字段与顺序不变，`Object.freeze` 语义保持）：

```js
clause.bodyPath // string：相对 pack.root 的规范化路径，如 'issue-delivery/SKILL.md'
```

候选形状（`list()` 的每一项与 `get()` 的返回值同源，由同一 `candidateFor(clause)` 产出）：

```js
{
  name: `enterprise-${clause.id}`,          // 'enterprise-issue-delivery'，kebab 正则可过
  description: clause.summary || clause.title, // 宿主要求非空 string
  content: clause.body,                     // 仅 Definition 带；Summary 由宿主裁剪
  invocation: INVOCATION,                   // { modelInvocable:false, userInvocable:true }
  source: 'bundled',                        // SkillSource 联合成员，非空
  rank: 600,                                // BUNDLED_SKILL_RANK：随包分发的 provider 的标准优先级
  provider: providerName,                   // 'enterprise-clauses'，必须等于注册名
  resourceBase: { kind: 'directory', path },// 绝对路径：<包>/skills/issue-delivery/
  path: join(root, clause.bodyPath),        // 与该 candidate 一一对应的正文文件
  locator: { clause: clause.id },           // 宿主回传 candidate 时唯一需要的定位键
}
```

`resourceBase` 取 `dirname(join(root, clause.bodyPath))` 而不是 `skills/` 根：`SKILL.md` 里以相对路径引用的 `references/evidence.md`、`references/handoff.md` 必须相对正文所在目录解析，指到 `skills/` 会在宿主侧解析成 `skills/references/*`（不存在）。企业 Skill 只有一个条款时两者形似，但一旦新增条款（如凭据条款）就会分叉，所以按文件定位而不是按包根定位。

### 2.2 补丁层行

`cordis.patch.yml` 的 `insert` 从 4 行扩到 6 行，`id` 用各包自己的独立 id（不派生、不 `isolate`）：

```yaml
    - id: heluo-policy          # 已有，保持 6 条并集目录逐字不变
    - id: forge-devops
      name: '@heluo/forge-devops'
      config: {}                # 缺席 config 会被 ConfigStandard 拒 ⇒ 整条不激活
    - id: heluo-gitee
      name: '@heluo/forge-gitee'
      config: {}
```

`config: {}` 是写下来的事实而不是省略：宿主把**缺席**的 `config:` 当 `undefined` 交给 `ConfigStandard.validate`，校验失败则整条 entry 静默不挂载（工具与插件一起消失，`--dump-config` 看不出来）。两包的可配键都有默认值，空对象即「零配置可用」。

### 2.3 清单闭包

`packages/forge-enterprise/package.json` 的 `dependencies` 与 `bundledDependencies` **同含五项**：`@heluo/forge-credentials-keychain`、`@heluo/forge-devops`、`@heluo/forge-gitee`、`@heluo/forge-iam`、`@heluo/forge-policy`（`workspace:*`）。`buildBundle()` 由 `dependencies` 递归 stage 成员并在产物里重写 `bundledDependencies`，两字段同时在源清单声明是对 AC-3 的显式承诺，也避免「源清单与实际闭包」两份口径。devops/gitee 各自只依赖 `@heluo/forge-policy`（已是成员），闭包没有环、没有 peer/optional，也没有安装期脚本；`files` 里没有 `test/tests/node_modules`，`copyResource()` 的拒绝名单不会命中。

## 3. 模块 API（下游按此逐字调用）

`packages/forge-enterprise/src/skills.mjs`

```js
loadClausePack({ root, index, indexFile }) -> { root, version, clauses }   // clause 新增 bodyPath
resourceBaseOf(root, bodyPath) -> { kind: 'directory', path }              // 新增导出，绝对路径
registerEnterpriseSkills(ctx, { selection, namePrefix, invocation, root }) -> { invocation, registered }
registerEnterpriseSkillsViaProvider(ctx, { selection, namePrefix, invocation, root })
  -> { provider, invocation, registered, dispose }
assembleEnterpriseSkills(ctx, { root, pack, systems, budgetTokens, namePrefix, invocation })
  -> { version, discovered, conflicts, excluded, budget, registered, invocation, bodyFor, constraintsFor, dispose }
```

- `registerEnterpriseSkillsViaProvider` 内 `summaryOf(clause)` 与 `definitionOf(clause)` 共用 §2.1 的候选字段；`get(arg)` 的入参归一为
  `const id = typeof arg === 'string' ? arg : arg?.locator?.clause ?? arg?.name`，未命中返回 `undefined`（不抛）。
- `registerEnterpriseSkills`（无 `registerProvider` 的降级路径）同样传 `resourceBase` 与 `path`；`source` 由宿主登记为 `runtime`，`rank` 用宿主默认。降级路径的差异写进 README，不在两条路径里各写一份候选逻辑。
- `assembleEnterpriseSkills` 把 `loaded.root` 作为 `root` 传给两条注册路径；`bodyFor(id)`/`constraintsFor(id)` 行为不变。

`packages/forge-enterprise/src/issue-delivery-skill.mjs`

```js
export const name = 'enterprise-issue-delivery'
export const inject = ['skills']
export const SKILL_PREFIX = 'enterprise'
export const RESOURCE_BASE   // fileURLToPath(new URL('../skills/', import.meta.url))
export const INVOCATION      // 冻结：{ modelInvocable:false, userInvocable:true }
export function apply(ctx) -> teardown
export default Object.freeze({ name, inject, apply })
```

`apply` 的幂等：模块级 `const applied = new WeakMap()`，值为 `Map<prefix, teardown>`。同一 `ctx` + 同一 `prefix` 再次 `apply` 直接返回已有 teardown，**不再调 `registerProvider`**（宿主对重名 provider 抛 `a skill provider named "…" is already registered`，重复 apply 会变成启动失败）；不同 prefix 允许并存。teardown 内 `applied.get(ctx)?.delete(prefix)`，重复 dispose 不抛，dispose 后宿主 `list()` 不再出现该 Skill（provider disposer 由 `registerProvider` 返回，宿主负责失效 cache）。

`scripts/probe/run-bundle-install-rehearsal.mjs`（CLI 契约不变，仅改断言与输出标记）

```
node scripts/probe/run-bundle-install-rehearsal.mjs [--keep]
输出标记：install-v1-with-patch-and-workspace-intact / installed-patch-disables-official-rows /
          installed-final-tarball-closure / install-real-loader-instantiates-members /
          installed-skill-candidate-shape / installed-skill-get-by-candidate
```

## 4. 装配与状态管理

- **层次**：profile 补丁层（官方行禁用 + 六条 insert）→ Loader 按 `id` 折叠（同 id 保留一份，`heluo-policy` 三层同装仍是一个实例）→ 各插件 `apply`。企业层与 devops/gitee 单装层可任意叠加：三层策略行目录逐字相同，幸存配置与装配顺序无关。
- **Skill 注册状态**：provider 生命周期挂在 `ctx`，`dispose` 撤销；不写磁盘、不缓存正文、不复制 Skill 到用户目录。宿主 `list()` 只拿 Summary（无 `content`），正文只在 `get()` 时给出——调用一次 `get` 才读一次文件，正文常驻内存的口子不开。
- **失败面**：条款索引缺字段/正文缺失 → `EnterpriseSkillError`（`code` 区分 `CLAUSE_*`/`BODY_MISSING`）在 `apply` 期抛出，**不带绝对路径**（宿主日志会打印）。provider 的 `get` 未命中返回 `undefined`，由宿主给「skill not found」，不伪造正文。
- **配置生命周期**：禁用 Skill 行只是不挂 entry，不动其它行配置；卸载由宿主负责删行/删包，本仓库不新增卸载脚本（Gitee/DevOps 侧 `scripts/uninstall-devops.mjs` 是 r9 的既有能力，本轮只回归不扩展）。

## 5. 前端与呈现面（无新增组件）

本轮不新增页面、组件或状态容器。Skill 在 Web UI 的呈现完全由宿主技能列表按 `name/description/invocation/locale/icon` 渲染：`packages/forge-enterprise/locale/{zh,en}.json`、`icon.svg` 已在 `files` 中随包发布，`exports` 的 `./issue-delivery-skill/locale/*.json` 与 `./issue-delivery-skill/icon` 是既有入口，不改。唯一与 UI 相关的验收是 AC-2 的 `npm pack` 清单里这些资源必须实际存在（缺 icon/locale 宿主退化为纯文本，不报错，所以只能用制品清单守）。

## 6. 关键实现点与边界（逐 AC）

### 6.1 AC-1：真实宿主契约（先证伪再改）

先按宿主源码逐条对照 `SkillRegistry`：候选必须带 `source` 字符串（非空）、`rank` 有限数、`provider` 等于注册名、`description` 非空、`invocation` 两个布尔；`get(candidate, options)` 的 `candidate` 带 `locator`。今天 `summaryOf` 缺 `source/rank/resourceBase`，`list()` 在宿主 `register` 阶段即抛 `returned skill "…" with a non-string source`；`get(name)` 只认字符串，宿主传 candidate 时返回 `undefined`。修法与断言：

1. 候选补 `source/rank/resourceBase/path`（§2.1），`provider` 用现有 `providerName`。
2. `get` 双形状归一（§3）。
3. 真机复跑 r12 原检查器（不重写）：
   `DSH_MODULES=<dsh>/node_modules node logs/teamflow/tf-mw39rd97-pmo6is/scripts/qa-r12-skill-host.mjs`
   若 `logs/` 已被运行结束归档，则用 `$DSH_HOME/teamflow/<workspace>/logs/tf-mw39rd97-pmo6is/scripts/qa-r12-skill-host.mjs` 的同一文件；两者都不在时如实记 `NOT RUN`，**不得**用本地 stub 冒充 `host-execution`。
4. 单元层只镜像宿主判据（`source` 非空字符串、`rank` 有限、`provider` 名一致、`resourceBase.kind==='directory'`、`list()` 不含 `content`、`get(candidate)` 与 `get(name)` 同正文），fixture 结论标注 `fixture`，与真机结论分列。

### 6.2 AC-2：制品与撤销

- `npm pack --dry-run --json`（企业包，经 `buildBundle` 的最终 tarball 优先）里必须有 `skills/issue-delivery/SKILL.md`、`skills/issue-delivery/references/evidence.md`、`skills/issue-delivery/references/handoff.md`、`locale/zh.json`、`locale/en.json`、`icon.svg`、`skills/clauses.json`。
- 安装演练（隔离 DSH_HOME，仅临时目录、用完即删，见 §11 T1）：装配后 `skillProvider.list()` 每项断言「`source` 非空 + `resourceBase.path` 指向包内 `skills/` + 摘要无 `content` + `invocation` 形状」；`get(candidate)` 与 `get('enterprise-issue-delivery')` 正文都含「单 Issue 可信待验收交付」；再 dispose/卸载后 `list()` 为空且无重名错误。
- 重复 `apply` 同一 `ctx` 返回同一 teardown，宿主只注册一次 provider（测试用计数桩 + 真实 `registerProvider` 语义二选一，避免只有桩结论）。

### 6.3 AC-3/AC-4：三层同装

- 闭包与补丁行按 §2.2/§2.3；`--dump-config` 断言：`heluo-policy` **恰一条**、`catalog` 逐字等于 6 条并集（`change.read`、`change.list`、`gitee.repository.read`、`gitee.issue.read`、`gitee.pr.read`、`gitee.delivery.judge`）、无 `isolate`、官方行仍 `disabled: true`、`forge-devops`/`heluo-gitee` 各一条。
- 工具注册数：Gitee 11（3 读 + 1 判定 + 4 受控写 + 2 git + 1 快照）、DevOps 4，三层同装各出现一次（`--dump-config` 看不到工具数时由 Loader 级实例化 + 工具登记计数补齐，并标 `fixture`）。
- IAM/凭据缺失 fail-closed：三层同装但无凭据 env 时工具面仍挂载、写动作被门禁拒绝且不落原始错误；停用 Skill 行（`disabled: true`）只撤该行，其余行配置逐字保留；卸载企业包后本包六行与工具面归零、兄弟条目逐字保留。
- 上述「真实装入/停用/卸载」依赖 T1 授权；未授权时只有 Loader 级 + 静态证据，真实宿主列 `NOT RUN`。

### 6.4 AC-5：工具面文档 11 个

事实源是 `packages/forge-gitee/src/gitee-tools.mjs` 的 `GITEE_TOOLS.length === 11` 与 `GITEE_SNAPSHOT_TOOLS`。四份文档按同一张表更新（数量、分组、快照工具名 `forge_gitee_delivery_snapshot`、空参数 `additionalProperties:false`、只读本地 git、无策略动作/不进审批、唯一 `execFile` 出口 `runGit`、失败只给 `reason/next`）：

| 文档 | 需改处 |
|---|---|
| `packages/forge-gitee/README.md` | 工具清单与「10 个」口径 |
| `docs/design/plugins/forge-gitee.md` | 能力表、工具计数、快照工具段 |
| `docs/design/README.md` | 索引摘要里的工具数 |
| `docs/teamflow/memory.md` | 跨需求约定行（同主题替换，不追加流水账） |

验收命令：`grep -rn '10 个'` 在四文件 0 命中；索引计数与 `GITEE_TOOLS.length` 一致（由测试守，不靠人读）。

### 6.5 AC-6：最终版本门禁

`pnpm check`（docs + repo + tarball + 版本 + 全量 `node --test`）与 `git diff --check` 全绿。检查器不放宽、不新增豁免（`scripts/lib/doc-rules.mjs` 与 `repo-rules.mjs` 一行不动）。F1 的最小修复见 §11：r12 `PRD.md` 两处主机绝对路径换等价占位符；`ACCEPTANCE.md` 4 处指向 `.mjs/.json/.yml` 的 `#L` 片段链接改为「链接指向文件本身 + 紧随的该行代码行号」，结论/AC/判定/证据文本逐字不动。`README.md#L46-L61` 是 Markdown 目标，合法，不改。

### 6.6 AC-8：回归面

- `src` 零 `spawn`/`exec`/`shell: true`（唯一子进程出口 `execFile`）：`grep -rn "spawn\|shell: *true" packages/*/src` 与既有测试双守。
- 失败面零路径/零 errno：`describeSpawnFailure`/`redactPathLike` 单点不变，r9/r12 用例继续跑。
- 写门禁 operation 0 调用、快照 11 工具与 `?refresh=1` 重建、卸载幂等：沿用既有用例，只加不改。
- **用例数**：r12 QA 基线 2718；本轮只增不减，0 skip（`dsh` 缺失导致的 skip 只允许安装演练一类，且本机 `dsh` 可用时必须实跑、不得设 `DSH_INSTALL_REHEARSAL=0` 规避）。

### 6.7 AC-9/AC-16：工作区与证据边界

全部实施在授权隔离工作树；不 `stash`、不 `commit`、不 `push`、不 `merge`、不 `reset --hard`、不 `checkout --`。每个任务收尾只跑 `git status --short` 记录新增文件，不清理他人改动。`.gitignore` 审计：`dist/`、`*.tgz`、`logs/` 命中忽略；`packages/forge-enterprise/skills/`、`locale/`、`icon.svg` 必须**不**被忽略（`git check-ignore -v` 反查为空）。无缺口就记「已覆盖」，不重写规则。

## 7. 测试策略

| 层 | 载体 | 覆盖 |
|---|---|---|
| 单元/fixture | `packages/forge-enterprise/test/issue-delivery-contract.test.mjs`、`…/issue-delivery-skill.test.mjs` | 候选形状、`get` 双形状、幂等 apply、dispose 后 list 为空、provider 重名不重复注册 |
| 仓库门禁 | `packages/forge-enterprise/test/bundle-patch.test.mjs`、`tests/plugin-patch-layers.test.mjs`、`tests/bundle-build.test.mjs`、`tests/bundle-install-rehearsal.test.mjs` | 6 行 insert、三包策略行逐字一致且单实例、成员闭包与 tarball 清单、隔离装配 |
| 制品 | `scripts/check-bundle-tarballs.mjs`（`pnpm check` 内） | 企业包递归 6 成员、无 `workspace:/file:/link:`、资源与模式位 |
| 真实宿主 | r12 原 `qa-r12-skill-host.mjs`（`DSH_MODULES` 指向 rc.5 安装） | AC-1 的 `host-execution` 证据 |
| 证据探针 | `scripts/probe/run-teamflow-scenario-matrix.mjs`、`scripts/probe/check-teamflow-journal-roots.mjs`、`tests/teamflow-evidence-tools.test.mjs` | 九类矩阵结构与填表校验、journal 根一致性三个负测 + 一个正例 |
| 全量 | `pnpm check`、`git diff --check` | 最终门禁与 diff 洁净 |

复跑命令（从仓库根）：

```sh
cd packages/forge-enterprise && node --test
node --test tests/plugin-patch-layers.test.mjs tests/bundle-build.test.mjs tests/bundle-install-rehearsal.test.mjs
node --test tests/teamflow-evidence-tools.test.mjs
node scripts/probe/run-teamflow-scenario-matrix.mjs
node scripts/probe/check-teamflow-journal-roots.mjs
node scripts/check-bundle-tarballs.mjs
pnpm check
git diff --check
```

## 8. 证据探针设计（新增，只读）

### 8.1 九类矩阵 `scripts/probe/run-teamflow-scenario-matrix.mjs`

- `SCENARIOS` 9 条固定 id：首次交接、同任务重复进入、运行中进入、中断续跑、已完成再进入、关联冲突、版本变化、缺依赖、伪造通过声明。每条带 `evidence`（该场景应当存在的守则，如「已有 run 先查询」「缺依赖即停并列出缺什么」「未取证的通过声明不得写成已验证」）与 `fixtureProbe`（对 `packages/forge-enterprise/skills/**` 与仓库内既有团队流用例的静态断言）。
- 默认 `--fixtures`：逐条跑 `fixtureProbe`，输出 Markdown 表格骨架，`真实宿主` 列固定 `NOT RUN`；任一条守则缺失即以非零退出（证明表不是恒绿）。不调用模型、不创建业务 run、不 ping 宿主。
- `--report <path>`：解析 QA 报告里的同一张 9 行表，校验列齐、`来源类型 ∈ {local-execution, host-execution, fixture, NOT RUN}`、真实宿主列非 `NOT RUN` 时必须有命令与时间，否则失败——把「填表纪律」变成可复跑断言，而不是人工检查。
- 结论口径：夹具列可写「满足/不满足」，真实列只能 `NOT RUN` 或带证据的实测；两者不混列。

### 8.2 journal 根一致性 `scripts/probe/check-teamflow-journal-roots.mjs`

- 纯函数 `classifyJournalRoots({ authorizedRoot, journal }) -> { status: 'aligned'|'mismatch'|'unknown', reasons }`：对 `journal.workspacePath`、`journal.stateRoot`、`journal.commitRoot` 做 `realpath` 归一后与授权工作树比对；任一落在主工作目录或其它 pump 路径即 `mismatch` 并逐条给原因，字段缺失即 `unknown`（不猜）。
- CLI：`node scripts/probe/check-teamflow-journal-roots.mjs [--journal <json>] [--root <path>]`；无 journal 时打印 `journal-roots: NOT RUN (no journal)` 且退出码 0（缺证不等于失败，也不等于通过）；有 journal 且 `mismatch` 退出码 1，便于 QA 作为放行闸。
- 三个错位负测 + 一个正例在 `tests/teamflow-evidence-tools.test.mjs`：①`workspacePath` 指主工作目录 ②`commitRoot` 在另一 worktree ③`stateRoot` 落在 `$DSH_HOME` 之外/缺字段；正例三者都在授权 worktree 内。
- 该探针只读，绝不写 journal、不搬目录、不清理；AC-9 的「0 次 stash/commit/merge/push」由 `git reflog`/`git status` 证据说明，不靠脚本自证。

## 9. 任务划分（无 pipeline 派发任务，按文件边界并行）

| 任务 | 修改文件（ownership） | 只读依赖 | 依赖 | 验收 |
|---|---|---|---|---|
| T1 Skill 宿主契约 | `packages/forge-enterprise/src/skills.mjs`、`packages/forge-enterprise/src/issue-delivery-skill.mjs`、`packages/forge-enterprise/test/issue-delivery-contract.test.mjs`、`packages/forge-enterprise/test/issue-delivery-skill.test.mjs` | 宿主 `dsh-skill` 源码、`assembleEnterpriseSkills` 调用方 | — | AC-1/AC-2 的 fixture 断言全绿；真机命令可复跑 |
| T2 企业闭包与补丁层 | `packages/forge-enterprise/package.json`、`packages/forge-enterprise/cordis.patch.yml`、`packages/forge-enterprise/test/bundle-patch.test.mjs`、`packages/forge-enterprise/README.md` | `scripts/lib/bundle-rules.mjs`、两个成员的清单 | — | 6 行 insert、五项依赖、README 状态如实 |
| T3 装配与制品证据 | `scripts/probe/run-bundle-install-rehearsal.mjs`、`tests/bundle-install-rehearsal.test.mjs`、`tests/bundle-build.test.mjs`、`tests/plugin-patch-layers.test.mjs` | 两成员的 `cordis.patch.yml`、`build-enterprise-bundle.mjs` | T1、T2 | AC-2/AC-3/AC-4 的装配与清单断言 |
| T4 文档同步与 F1 | `packages/forge-gitee/README.md`、`docs/design/plugins/forge-gitee.md`、`docs/design/README.md`、`docs/teamflow/memory.md`、`docs/design/plugins/forge-enterprise.md`、r12 `PRD.md`/`ACCEPTANCE.md`（仅 F1 最小修复） | `gitee-tools.mjs`、`gitee-snapshot.mjs`、r12 结论段 | — | AC-5/AC-6 的 grep 与 `check-docs` |
| T5 证据探针 | `scripts/probe/run-teamflow-scenario-matrix.mjs`、`scripts/probe/check-teamflow-journal-roots.mjs`、`tests/teamflow-evidence-tools.test.mjs` | 现有 `scripts/probe/README.md`、Skill 正文 | — | AC-7/AC-9 的可复跑夹具结论 |
| T6 交付自检（无新产物） | 仅修 T1–T5 中的即时缺陷 | 全部 | T1–T5 | AC-6/AC-8/AC-16：`pnpm check`、`git diff --check`、用例数、`git check-ignore`、`git status` 结论记录 |

并行度：T1、T2、T4、T5 文件不相交可同时进行；T3 在 T1/T2 合入后进行；T6 收尾。**本需求不产生任何 git 写动作**（无分支切换、无提交、无推送、无合并、无 stash），所有任务执行前后各记一次 `git status --short`，差异仅允许本表所列文件。

T2 的一个已知坑：`bundle-patch.test.mjs` 现有 `assert.doesNotMatch(text, /^( {4})- id: (enterprise|forge)-/mu)` 会把新增的 `    - id: forge-devops` 当成「禁用段复制企业行」误报；必须收紧为只匹配顶层禁用段（`^- id:`）或 `    - id: enterprise-`，而不是删掉断言。

## 10. 风险、未验与 NOT RUN

| 项 | 现状 | 处理 |
|---|---|---|
| 真实宿主 Skill 注册 | 需 `DSH_MODULES` 指向安装态 rc.5 | 命令已备；跑不到即 `NOT RUN` |
| 三层同装 `--dump-config` / 装入 / 卸载 / 冷启动 | 需一次性临时 `DSH_HOME`（T1 未拍板） | 未授权则 Loader 级 + `fixture`，真实列 `NOT RUN` |
| 目标宿主 rc.3 | 本机 rc.5 | 版本差异单列，G5 `NOT RUN` |
| 企业环境（凭据、真实 Gitee、麒麟 aarch64） | 不具备 | G5 `NOT RUN`，不得写成联调通过 |
| G1 提交模板首行 `[变更号]` | 无公开契约证据 | 维持阻断 |
| G2 唯一 Issue→变更→仓库关联与要求版本、G3 可信 run 查询 | 无宿主 run 证据 | 维持阻断，矩阵真实列 `NOT RUN` |
| G4 独立只读审查 | 未执行 | 维持阻断；是否强制异模型见 T2 待澄清 |

## 11. 待澄清的默认执行（不阻塞本方案）

- **F1（fact）**：按用户已确认的「等义脱敏、不新增豁免、不降低扫描」做最小修复——`PRD.md` 两处主机路径换「授权隔离工作树」「主工作目录」占位（授权范围与限制语义逐字保留），`ACCEPTANCE.md` 4 处 `#L` 链接改为「文件链接 + 该行代码行号」，不改结论/AC/判定/证据。若用户改口要求历史夹逐字不动，则 AC-6 如实记 5 个历史错误，**不改检查器**。
- **T1（taste）**：默认授权在系统临时目录建一次性 `DSH_HOME` 做装入/卸载/冷启动，不碰当前 GUI profile、不改宿主安装、用完即删；未授权则相关真实列 `NOT RUN`。
- **T2（taste）**：默认「独立上下文 + 只读 + 版本绑定，披露实际模型」，同模型允许；若要求异模型，把第二模型可用性加入 AC-13 准入，缺证据不得称通过。

## 12. 交接

开发按 §9 逐任务交付，每个任务附命令、时间、宿主版本与来源类型；QA 用 r12 原检查器与九类矩阵复验，逐条给 `通过/失败/NOT RUN`；G0–G5 任一未解除时整体只能报「未完成/阻断」。本方案不预设任何 AC 已通过：AC-15 要求交付与验收摘要只能写「待验收/阻断」并注明缺证项，任何文档不得出现「可关闭」「已关闭」；AC-16 要求最终 `git status` 仅含本需求授权差异，`dist/*.tgz`、`logs/` 与构建缓存命中忽略，历史任务夹除 F1 最小修复外逐字不变。

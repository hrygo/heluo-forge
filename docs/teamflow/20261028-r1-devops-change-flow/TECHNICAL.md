# TECHNICAL — 系统变更号驱动研发流程（`@heluo/forge-devops` 从只读骨架到受控全流程）

> 归属：`products/heluo-forge`（本工作区即项目根）。基线依赖：`docs/teamflow/20261028-r1-devops-change-flow/PRD.md`（23 条 AC）。
> 状态：代拟（待评审）。本文件只写实现方案与任务边界，不重复 PRD 的需求叙述；与 PRD 冲突以 PRD 为准。
> 文档语言：中文；代码标识符、包名、命令保持原文。

## 1. 设计起点（已核验事实，不是规划）

| 事实 | 位置 | 对设计的影响 |
|---|---|---|
| `@heluo/forge-devops` 已有只读骨架：`name='forge-devops'`、`inject=['tools','policy']`、`apply(ctx, config)`，服务键 `devops`、适配器键 `devopsReader` | `packages/forge-devops/src/index.mjs:1-137` | 不重写插件形态，只在同一 `apply` 内接流程原语；不破坏既有 `read`/`tools` 导出 |
| 只读契约已存在：`READ_ACTIONS`（4 条）、`assertReadRequest`、`normalizeReadResult`、`DevopsReadError`、`READ_REASONS` | `packages/forge-devops/src/read.mjs:1-94` | 新增状态/原因码不另立一套；已有 `POLICY_DENIED`/`NO_READER` 等语义直接复用 |
| 四个模型可见只读工具已注册，参数名统一 `target`（对齐门禁 `exec.arguments.target`） | `packages/forge-devops/src/tools.mjs:1-79` | 新工具沿用 `target` 参数约定与 `json()` 渲染形态 |
| 策略门禁是硬依赖：`catalog.get(action).enabled !== true` 即拒绝挂载；读也走 `policy.executeAction` | `packages/forge-devops/src/index.mjs:96-118` | 写动作**不新增**绕过通道，一律走同一 `executeAction`；未覆盖即 `denied` 可见 |
| 包内**无** `cordis.patch.yml`、无 `dsh.bundle.patch`、无 `dependencies`、`files` 只含 `src`+`README.md` | `packages/forge-devops/package.json` | AC-1/2/7 需要新增补丁层与清单字段（本次改动范围） |
| 包间引用用 `workspace:`，跨包导入源码路径被禁止 | `AGENTS.md` §4 | 需要策略能力时只能经 `workspace:*` 依赖 + 闭包发布（ADR-12 模式），或经 `ctx.get('policy')`；**不得** `import '../forge-policy/src/...'` |
| 企业补丁层形状：`insert:` 段逐行 `id`+`name`，`heluo-policy` 行不带 config | `packages/forge-enterprise/cordis.patch.yml:34-41` | devops 补丁照此形状：先 `heluo-policy` 后 `forge-devops`，不塞默认凭据/默认 endpoint |
| 仓库级闭包与制品检查：`tests/package-shape.test.mjs`、`tests/bundle-closure.test.mjs`，脚本 `scripts/build-enterprise-bundle.mjs`、`scripts/check-bundle-tarballs.mjs` | `tests/`、`scripts/` | 若 devops 声明 `dependencies`，必须走同一闭包构建器，否则现有 `workspace:` 断言会失败（见 §9 风险 R2） |

结论：**形态不变（host-only ESM 插件 + 门禁 + 服务端口），把"入口 / 取数 / 分流 / 计划 / 写动作 / 审查 / 报告 / 落盘"拆成可注入、可离线测的纯函数模块**，`apply()` 只做装配。

## 2. 总体架构

```
                ┌────────────────────────── 宿主（DSH 0.2.1-rc.2 实测 / rc.3 NOT RUN）
                │  tools 服务        policy 服务（catalog + executeAction + registerCommand）
                │      │                    │
  模型可见面 ────┤ 9 个工具           命令 `devops-change`
                │      │                    │
                └──────┼────────────────────┼───────────
                       ▼                    ▼
        ┌───────────────── src/index.mjs（apply：装配 + 服务 devops）─────────────────┐
        │  entry.mjs（入口/参数校验）      tools.mjs（工具定义，纯 schema）           │
        │  change-context.mjs（上下文卡）  repository-resolver.mjs（承建判定）        │
        │  clarify.mjs（澄清单/假设）      plan.mjs（交付计划）                      │
        │  actions.mjs（四状态+幂等+回读） policy-guard.mjs（动作准入适配）          │
        │  review.mjs（交叉审查）          report.mjs（完成报告）                    │
        │  artifacts.mjs（`.dsh-devops/` 落盘）  commit-message.mjs（提交信息校验）   │
        └───────────┬──────────────────────────────────┬──────────────────────────┘
                    ▼                                  ▼
        runtime-config.mjs（env 注入/fail closed）   cli-runner.mjs（execFile，无 shell）
                    │                                  │
                    ▼                                  ▼
        dop-adapter.mjs（固定 argv：change view|list）  gh-adapter.mjs（固定 argv：repo/issue/pr）
                    │                                  │
                    ▼                                  ▼
        mock 企业 dop CLI（外部 oh-my-sdd/scripts/dop）  gh 2.97.0（真实远端）
```

三层职责不得互相替代：**门禁**判"能不能做"（策略服务，唯一真源）；**白名单**判"有没有这条命令"（本包，固定 argv，无通用 `run()`）；**流程**判"该不该做、做完是否可核对"（本包纯函数 + 状态记账）。

## 3. 模块边界（文件 = 所有权；括号内为装配序）

| 文件 | 职责 | 关键导出（下游按此逐字调用） |
|---|---|---|
| `packages/forge-devops/src/index.mjs`（改，⑧） | 装配：读配置→建 runner/适配器→建 guard→建 service→注册工具与入口；不抛给模型看 | `apply(ctx, config)`、`name`、`inject`、`validateConfig`、`SERVICE_KEY='devops'` |
| `src/runtime-config.mjs`（新，①） | env → 运行配置；**不读文档、不硬编码路径**；只报"已配/未配" | `resolveRuntimeConfig(env)`、`describeRuntimeConfig(cfg)`、`ENV_KEYS` |
| `src/cli-runner.mjs`（新，②） | 唯一子进程出口：`execFile`、`shell:false`、超时、输出上限、无拼串 | `createCliRunner({execFile, env, timeoutMs, maxOutputBytes})` → `{ run({bin,args,purpose}) }` |
| `src/dop-adapter.mjs`（新，③） | dop 固定命令面：`change view` / `change list` | `createDopAdapter({runner, dopBin, dopEndpoint})` → `{ readChange, listChanges, capabilities }`、`DOP_COMMANDS` |
| `src/gh-adapter.mjs`（新，③） | gh 读 + 写（固定 argv） | `createGhAdapter({runner, ghBin})` → 见 §5.3、`GH_COMMANDS` |
| `src/policy-guard.mjs`（新，④） | 动作准入适配：把 `executeAction` 结果收敛成 `done/denied/failed`，拒绝时**零下游调用** | `createPolicyGuard({policy})` → `{ admit, execute }`、`GUARD_STATUSES` |
| `src/change-context.mjs`（新，⑤） | dop 记录归一化、`release_info` 首个非空、上下文卡构建与渲染 | `normalizeChangeRecord`、`firstReleaseInfo`、`buildContextCard`、`renderContextCard` |
| `src/repository-resolver.mjs`（新，⑤） | 承建系统/仓库候选判定（只来自 `sub_systems` + gh 可见仓库） | `resolveBuildingRepository({change, visibleRepos, explicit})` |
| `src/clarify.mjs`（新，⑥） | 澄清单：硬门禁项校验、假设 `H-n`、版本与修订标识 | `createClarifySheet`、`validateClarifySheet`、`bumpClarifyVersion`、`clarifyRevisionId`、`HARD_GATE_KINDS` |
| `src/plan.mjs`（新，⑥） | 交付计划：验收条件→实现项→验证方式；拆分边界 | `buildDeliveryPlan`、`validatePlan`、`renderPlan` |
| `src/actions.mjs`（新，⑦） | 平台动作：四状态、幂等键、创建前查重、创建后回读、澄清回写（dop `denied`） | `idempotencyKey`、`createIssueIdempotent`、`commentIssueIdempotent`、`createPrIdempotent`、`commentPrIdempotent`、`writeClarification`、`ACTION_STATUSES` |
| `src/review.mjs`（新，⑥） | 审查记录：模型名/commit 绑定、AI 与人工分栏、sha 变化判 `stale` | `buildReviewRecord`、`recordHumanConfirmation`、`reviewStaleness`、`assertModelRecorded`、`MODEL_TIERS` |
| `src/report.mjs`（新，⑥） | 完成报告：逐条证据、来源类型分记、UAT `unknown`、关闭就绪判定（只判定不执行） | `buildReport`、`validateReport`、`issueCloseReadiness`、`renderReport` |
| `src/artifacts.mjs`（新，⑦） | 唯一落盘出口：`.dsh-devops/<变更号>/<kind>.md` + 定长 front matter，路径逃逸拒绝 | `ARTIFACT_KINDS`、`artifactPath`、`renderFrontMatter`、`writeArtifact` |
| `src/commit-message.mjs`（新，⑥） | 提交信息 `[变更号]` 前缀校验（提交前，不做事后改写） | `assertCommitMessage` |
| `src/entry.mjs`（新，⑧） | 入口：`devops-change` + 变更号校验 + 流程旁白 | `ENTRY_NAME`、`parseChangeId`、`ENTRY_HELP`、`registerEntry` |
| `src/flow.mjs`（新，⑧） | 流程组合根：运行时配置→唯一子进程出口→dop/gh→门禁→平台动作；一次聚合、失败只降级、写动作不猜；`devopsFlow`/`devopsReader` 的生产者（实施期补入，验收 §4 偏差项） | `createDevopsFlow({ports, config, adapters, guard, now})`、`createDevopsReader({ports, reason})`、`FLOW_REASONS`、`READ_ROUTES` |
| `src/read.mjs`（改，⑤） | 复用既有归一化；只扩状态/原因码，不改语义 | 既有 4 个导出 + `READ_STATUSES` 增项 |
| `src/tools.mjs`（改，⑧） | 9 个工具定义（唯一真源：工具名→动作映射表） | `READ_TOOLS`（既有 4 条）、`FLOW_TOOLS`（新 5 条）、`buildDevopsTools(service)` |
| `cordis.patch.yml`（新，⑧） | 补丁层：先 `heluo-policy` 后 `forge-devops` | — |
| `packages/forge-devops/package.json`（改，①） | `dsh.bundle.patch`、`files`、`dependencies` | — |

装配序 ①→⑧ 即依赖方向；①–⑦ 之间除 ⑦ 依赖 ⑤⑥ 的纯函数签名外无环形依赖。

## 4. 数据模型与存储

### 4.1 dop 记录（2026-07-06 字段契约，原样映射，不改名不改语义）

```js
// normalizeChangeRecord(raw, { at, sourceRevision, sourceType }) -> Change
Change = {
  changeId, title, status, type, owner, description, createdAt,
  acceptanceCriteria: [{ index: 1, text }],            // acceptance_criteria[] 逐条编号
  subSystems: [{ code, name }],                        // sub_systems[]
  userStories: [{
    id, code, title, type, state, stage, team, assignee, businessOwner,
    releaseInfo: { releaseNum, releaseName, releaseDate, releaseStage } | null,
  }],
  releaseInfo: { storyId, value } | null,              // firstReleaseInfo 结果，rule 固定 'first-non-empty'
  missingFields: string[],                             // 契约内但缺的字段（不静默省略）
  sourceRevision: 'dop:<sha256(rawStdout).slice(0,12)>',
  observedAt: ISO, sourceType: 'mock' | 'enterprise',
}
```

- 空 `release_info`（`{}`/全字段空/`null`）不算"非空"，`firstReleaseInfo` 必须跳过（夹具 `ARD222222`：第 1 个 story 空、取第 2 个；`ARD123456`：单 story 全非空）。
- 契约外字段不丢弃也不展示，原样放 `raw`（仅调试用，不入卡）。

### 4.2 上下文卡（`context.md` 正文 + 工具返回值同构）

```js
ContextCard = {
  change: Change,
  building: { status: 'resolved' | 'blocked', selected: string|null,
              candidates: [{ repo, evidence: [{ kind, value, source }] }],
              reasons: string[] },                     // blocked 时必非空
  related: { issues: Related[], prs: Related[] },       // 来自 gh，只读
  sources: [{ kind:'dop'|'gh', command, at, sourceRevision, sourceType }],
  unknowns: [{ field, reason, command }],               // 失败注入/超时走这里，永不省略
  assumptions: [{ id:'H-1', text, basis, impactIfWrong }],
  clarify: { version, status:'pending'|'ready', gateCount, assumptionCount },
  status: 'ready' | 'blocked',
}
```

### 4.3 其它记录（同样是"纯数据 + 渲染函数"两段式）

| 记录 | 关键字段 | 规则 |
|---|---|---|
| `ClarifySheet` | `gate[{id,basis,options[{id,label,effect,pros[],cons[]}],recommendation{optionId,why}}]`、`assumptions[{id,text,basis,impactIfWrong}]`、`rejected[{findingId,reason}]`、`version`、`revisionId` | 硬门禁仅 `acceptance`/`scope` 两类；`options` ≥2 且 `effect` 互不相同、`recommendation.optionId ∈ options`；不满足 → `CLARIFY_INVALID` 直接判不通过；无选项问题进 `rejected`（`reason:'no-options'`） |
| `Plan` | `items[{id, criterionIndex, change, verification[{kind,command}], files[], boundary}]`、`split:{issues,prs}` | 每条验收条件必须有 ≥1 实现项；简单变更 1 Issue/1 PR；不引入固定阶段模板（`stages` 字段**故意不存在**） |
| `ReviewRecord` | `commit`、`model{name,tier,degraded}`、`aiColumn[{id,kind:'issue'\|'risk'\|'opinion',text}]`、`humanColumn[{by,at,commit,decision,note}]`、`conclusion`、`status` | 人工栏**只**由 `recordHumanConfirmation` 写入；`reviewStaleness(review, headSha)` 为 `stale` 时旧确认失效 |
| `Report` | `criteria[{index,text,evidence[{command,at,hostVersion,target,sourceType,result}],conclusion}]`、`delivery{submitted[],underReview[],merged[]}`、`uat{status,detail}`、`assumptionsChecked[]`、`closing{ready,missing[]}` | 证据 `sourceType` 只允许 `mock`/`enterprise`，同一条结论内两者分列；`uat` 取不到即 `unknown`+原因 |
| `ActionResult` | `{ status, action, objectRef\|null, reason\|null, reused, key, target }` | `status ∈ ACTION_STATUSES`（§7） |

### 4.4 存储：文件系统唯一真源，不建本地库

- 落盘位置 `<目标仓库根>/.dsh-devops/<变更号>/{context,clarify,plan,review,report}.md`；`artifactPath` 做 `assertInsideRoot`（拒绝 `..`、绝对路径、非法变更号），写入 `mkdir -p`。
- 每个文件首部为**定长 front matter**（`renderFrontMatter`），字段固定顺序：`change` / `kind` / `generatedAt` / `sourceType` / `sourceRevision` / `commit`（无代码关联时 `null`）。缺任一项视为不合格产物。
- **不缓存上下文卡**：每次读取重新取数（平台是事实源，缓存会制造第二副本，违反 AC-23）。
- 平台侧不做影子表：Issue/PR 的"是否已创建"由创建前查重解决（§7.2），不维护本地 id 映射。
- 插件不写 profile、不写工作区外任何路径；`logs/` 不由本包产生。

## 5. API 设计

本包无 HTTP 路由。对外 API = **工具面（模型可见）+ 命令面（用户可见）+ 服务面（其它插件经 `ctx.get('devops')`）**。

### 5.1 入口（命令面，AC-10）

| 项 | 契约 |
|---|---|
| 名称 | `devops-change`（`ENTRY_NAME`），`modelInvocable:false`（模型不得自行发起；仅用户显式触发） |
| 入参 | 唯一一个变更号：`devops-change ARD123456` |
| 校验 | `parseChangeId(input)` → `{ok:true, changeId}` 或 `{ok:false, reason:'MISSING_OR_INVALID', expectedFormat:'<变更号，例如 ARD123456>'}`；**不按 id 前缀推断**（`ARD`/`CHG` 都不作语义） |
| 行为 | 通过校验后：`denied` 早退（未配 dop）或输出上下文卡 + 后续步骤旁白（澄清→计划→实现→审查→报告）；任一平台动作仍各自过门禁 |
| 失败 | 缺参/格式非法立即拒并给期望格式，**不进入后续步骤、零适配器调用** |

> 宿主机是否支持"命令结果直接开跑一轮对话"在 rc.2 未核验；本设计**不依赖**该行为（回退为：命令输出确定性上下文卡与下一步清单，agent 用工具承接）。这条不写进验收判据，避免把未核验能力写成前提。

### 5.2 工具面（9 个；`name → action` 映射表是唯一真源，测试逐条核对）

参数一律 `{ target: string, ... }`（对齐门禁读取的 `exec.arguments.target`），`additionalProperties:false`。

| 工具 | action | 附加参数 | 返回（`ok/status/result`） |
|---|---|---|---|
| `forge_devops_change_read` | `change.read` | — | 既有只读归一化结果 |
| `forge_devops_repository_read` | `repository.read` | — | 同上 |
| `forge_devops_issue_read` | `issue.read` | — | 同上 |
| `forge_devops_pr_read` | `pr.read` | — | 同上 |
| `forge_devops_change_context` | `change.read`（聚合读，先 dop 后 gh） | `repoScope?` | `ContextCard`；`blocked` 时 `result.building.reasons` 非空；任一子查询失败进 `result.unknowns` 且整体仍返回 |
| `forge_devops_issue_write` | `issue.create_or_update` | `operation:'create'\|'comment'`、`repo`、`title?`、`body`、`confirm:{repo,object}` | `ActionResult`（`create` 先查同名 open Issue；`comment` 按正文哈希查重） |
| `forge_devops_pr_write` | `pr.create_or_update`（create）/`review.ai.publish`（comment） | `operation:'create'\|'comment'`、`repo`、`head`、`base`、`title`、`body`、`confirm` | `ActionResult`；`create` 按 `head` 或标题归一化查重；`comment` 必须带 `commit`（否则拒） |
| `forge_devops_clarify_write` | `change.clarification.write` | `sheet`（或 `sheetPath`）、`targets:('dop'\|'issue')[]` | `{statuses:[ActionResult]}`；dop 目标恒为 `denied/COMMAND_NOT_WHITELISTED`（零调用） |
| `forge_devops_artifact_write` | 无（非平台动作，本地落盘） | `repoRoot`、`kind`、`body`、`meta{commit?,sourceType,sourceRevision}` | `{path, bytes, header}`；`kind='review'` 强制 `meta.commit`+`meta.model`，`kind='report'` 强制证据数组 |

写工具的统一前置：`confirm:{repo,object}` 必须与实参一致，否则 `denied/CONFIRMATION_REQUIRED`（AC-16 "执行前显示目标仓库与对象"，由调用方先展示再确认）；执行时向门禁传 `egress:'platform-write'`，使 `kind:write + egress:confirm` 落到宿主确认通道。

### 5.3 适配器（内部 API，纯 argv，无 shell）

| 方法 | 固定 argv（前缀不可拼接） | 备注 |
|---|---|---|
| `dop.readChange({changeId})` | `change view <changeId> -j` +（配了 endpoint 时）`--endpoint <ep>` | 退出码非 0 → 抛 `DevopsReadError(POLICY_DENIED? 否 → 'DOP_FAILED')`，上层转 `unknown` |
| `dop.listChanges({status})` | `change list -j` (+`--status`) | 只读 |
| `gh.readRepository({repo})` | `repo view <repo> --json nameWithOwner,description,url,defaultBranchRef,isPrivate,updatedAt` | |
| `gh.readIssue({target})` / `gh.readPr({target})` | `issue view <n> -R <repo> --json …` / `pr view …` | |
| `gh.listOpenIssues({repo})` | `issue list -R <repo> --state open --limit 100 --json number,title,url,state` | 幂等查重 |
| `gh.listOpenPrs({repo})` | `pr list -R <repo> --state open --limit 100 --json number,title,url,headRefName,state` | 幂等查重 |
| `gh.createIssue` | `issue create -R <repo> --title <t> --body <b>` | 输出解析 `Number/URL` |
| `gh.commentIssue` | `issue comment <n> -R <repo> --body <b>` | |
| `gh.createPr` | `pr create -R <repo> --head <h> --base <b> --title <t> --body <b>` | 禁 `--draft` 之外任何合并类 flag |
| `gh.commentPr` | `pr comment <n> -R <repo> --body <b>` | 发前必须人确认文案（门禁 confirm） |

禁项在**代码里不存在**：`pr merge`、`pr close`、`issue close`、`release`、`workflow`、`change done`、`change create`、任何 `gh api` 通用调用、任何 `sh -c`。白名单是**枚举到函数**，不是"允许列表 + 拼参数"。

### 5.4 环境注入（AC-22；未配置 fail closed，值不入文档/日志/报告）

| 变量 | 必需 | 用途 | 未配时 |
|---|---|---|---|
| `FORGE_DEVOPS_DOP_BIN` | 是 | mock/企业 dop 可执行入口（**不写默认值**） | 所有 dop 动作 `denied/CONFIG_MISSING` |
| `FORGE_DEVOPS_DOP_ENDPOINT` | 否 | 透传 `--endpoint` | 不传；`describeRuntimeConfig` 只报 `endpoint:false` |
| `FORGE_DEVOPS_GH_BIN` | 否 | 默认 `gh`（PATH 上的固定名，非本机绝对路径） | 用 `gh` |
| `FORGE_DEVOPS_GH_OWNER` | 否 | 仓库候选扫描范围 `gh repo list <owner>` | 仓库判定 `blocked/NO_REPO_SCOPE`，不猜 |
| `FORGE_DEVOPS_SOURCE_TYPE` | 否 | `mock`（默认）/`enterprise` | 默认 `mock`：报告默认标 mock，声明企业实测须显式配置 |
| `FORGE_DEVOPS_TIMEOUT_MS` | 否 | 默认 `20000` | 默认值 |

`describeRuntimeConfig` 只输出布尔与变量名，**永不回显值**；报告与文档中不出现路径/endpoint（AC-22/AC-23）。

## 6. 前端组件与页面划分

**无前端**：本包是 host-only ESM 插件（`files` 只含 `src`/`cordis.patch.yml`/`README`），不产出 Web 资源，不注册路由或页面。可见面就三处，其中两处由本包定义：

1. **工具 schema**（`tools.mjs`）：`name`/`description`/`parameters`/`output.schema` 是模型侧"UI"，字段提示写用途与期望格式（例如 `target` 的 hint 已在既有 4 个工具里按 action 分列，新工具沿用）。
2. **`output.render`**：宿主支持时按纯文本渲染，`json()` 形态保持既有约定（不引入富组件）。
3. **命令输出**（`entry.mjs`）：Markdown 文本，结构固定为「上下文卡 → 未知项 → 候选/阻断 → 下一步清单」。

若后续需要 Web 卡片视图（上下文卡可视面板），属独立需求（需 `apps/web` 侧改动与宿主 UI 插件机制），不在本方案内，也不在本需求的验收判据内。

## 7. 关键实现点与边界

### 7.1 四状态语义（AC-16，全库统一）

`ACTION_STATUSES = ['done','failed','denied','unknown']`

| 状态 | 判定 | 允许的后续 |
|---|---|---|
| `done` | 命令成功 **且** 回读确认对象与意图一致（含 `reused:true` 的复用命中） | 记账、报告引用 |
| `failed` | 命令明确失败（非零退出且错误可判） | 报告写失败与原因；不写"已创建" |
| `denied` | 门禁拒绝 / 白名单无此命令 / 配置缺失 / 确认缺失 | **适配器零调用**；用户可见拒绝原因与下一步 |
| `unknown` | 超时、输出不可解析、回读不一致、`skipped` 之后的不可确认态 | 不自动重放，报告标 `unknown`+原因 |

`docs` 侧另有 `blocked`（候选不唯一）、`skipped`（用户选择跳过）、`stale`（确认过期）——属于**流程状态**，不是平台动作状态，渲染时分开写，不混用词表。

### 7.2 幂等（AC-16）

- 键：`idempotencyKey({change,objectType,title}) = sha256(`${change}|${objectType}|${normalizeTitle(title)}`).slice(0,16)`；`normalizeTitle` = NFKC → trim → 折叠空白 → 小写 → 去尾部标点。
- 创建前查重：Issue 用 `listOpenIssues` 按归一化标题精确比对；PR 用 `listOpenPrs` 按 `headRefName` 或归一化标题比对。命中 → `done` + `reused:true`（回填平台 ref），**不重复创建**。
- 评论查重：同对象已有正文哈希相同的评论 → 复用。
- 跨会话不依赖本地账本（会随 reload 丢失）：**以平台回查为准**；会话内 `Map<key, ActionResult>` 只用于避免同一轮重复写。

### 7.3 承建判定（AC-12）

`resolveBuildingRepository` 输入只有两类证据：`change.subSystems[]` 与 `visibleRepos[]`（`gh repo list`）。候选 = 仓库名/描述/topics 命中 sub-system `code` 或 `name`（大小写不敏感、记录命中的证据项）。
- 命中 1 个 → `resolved`，`evidence` 必带命中项。
- 命中 0 或 >1 → `blocked`，`reasons` 分别 `NO_CANDIDATE` / `MULTIPLE_CANDIDATES`，`candidates` 全列并附各自证据；**阻断全部写动作**（写工具在此态直接 `denied/BUILDING_NOT_RESOLVED`）。
- 显式 `explicit` 参数只能从 candidates 里选，不得引入新仓库。

### 7.4 澄清与假设（AC-13/14）

- `createClarifySheet` 内建校验（不通过即 `CLARIFY_INVALID`，等同"澄清单不通过"）：硬门禁项必须 2–3 个实质选项（`effect` 互不相同）、利弊非空、推荐项属于选项；非关键项的歧义进 `assumptions`（`H-n` 稳定编号，卡上可见、报告逐条复核）；无选项问题进 `rejected`。
- 回写（AC-14）：dop 通道恒 `denied/COMMAND_NOT_WHITELISTED`（`detail` 写明"命令面只有 create/list/view/done，无澄清写命令"）；issue 通道须门禁覆盖 + `egress` 确认 + 回读评论存在，否则 `unknown`；**未确认为成功前不得写"已回写"**。
- 修订标识：`clarifyRevisionId = `${changeId}/${version}/${sha8(body)}``，后续计划/报告引用此串，旧版本自然失效。

### 7.5 审查（AC-18）与报告（AC-20）

- `assertModelRecorded`：`MODEL_TIERS = ['deepseek-v4-pro','gpt-6.1-sol','gpt-6-astra','muse-spark-1.3-contributor']`；实际模型不在档内必须显式 `degraded:true` + 说明，否则拒绝写入。
- AI 栏与人工栏结构分离：`aiColumn` 只能由 `buildReviewRecord` 写，`humanColumn` 只能由 `recordHumanConfirmation` 写（含 `by/at/commit`）；`reviewStaleness` 比对 `review.commit` 与当前 HEAD → `stale` 时报告注明"确认已过期"。
- 报告证据项强制 `{command, at, hostVersion, target, sourceType, result}`；`validateReport` 检查每条约验收条件 ≥1 证据、`sourceType` 合法、`uat` 缺失即 `unknown`、H-* 全部出现。`issueCloseReadiness` 只返回 `{ready, missing}`，**从不执行关闭**（`issue.close` 不在白名单）。

### 7.6 提交信息（AC-17）

`assertCommitMessage({change, message})`：要求 `^\[<change>\]\s+\S`（方括号内必须等于本变更号，其后一个空格再接非空描述）。违规 → `{ok:false, reason:'PREFIX_MISSING', expectedFormat:'[ARD123456] 一句话说明'}`，调用方**拒绝提交**而不是自动改写。

### 7.7 边界与异常（每条都要有可见输出，不允许静默）

| 场景 | 处理 | 可见结果 |
|---|---|---|
| 缺参/格式非法 | 入口早退 | `MISSING_OR_INVALID` + 期望格式 |
| 未配 `DOP_BIN` | 全部 dop 动作 | `denied/CONFIG_MISSING` + 变量名（不给值） |
| dop 超时 / `OMS_MOCK_DOP_FAIL_GET=1` 退出码 1 | 不重试、不猜 | 卡上 `unknowns[{field,reason,command}]`；报告 `uat/业务事实` 标 `unknown` |
| dop 输出非 JSON / 半截 JSON | 解析失败 | `unknown/MALFORMED_RESULT`（沿用既有 reason） |
| 多候选仓库 | `blocked` | 候选+证据+`reasons`；写工具拒绝 |
| 写动作 policy 未登记/未启用 | `admit` 返回 `denied` | `denied` + `rule`（action 未覆盖），**零适配器调用** |
| 写成功但回读不一致 | 不重放 | `unknown/READBACK_MISMATCH`，报告不写"已创建" |
| 同名 open Issue 已存在 | 复用 | `done` + `reused:true` + 既有 ref |
| sha 变化 | 旧人工确认置 `stale` | 报告注明"确认已过期，需按新 sha 重确认" |
| 产物路径逃逸 / kind 非法 | 拒绝写入 | 抛错，不落盘 |
| 提交信息缺前缀 | 拒绝 | `PREFIX_MISSING` + 期望格式 |
| `commands` 服务缺失 | 不整包失败 | `entryStatus:'no-command-face'`，工具面仍注册 |

## 8. 状态管理

- **插件内**：`service = { config, readActions(), toolNames(), status(), read(), context(), entryStatus(), ledger() }`；`apply` 内闭包持有 `Map<key, ActionResult>`（会话内幂等台账）与 `callSeq` 计数（用于 `callId`）。挂载失败（策略缺失/未登记读动作）沿用既有语义**抛错不挂载**，不降级。
- **reload**：Cordis 以 `new` 运行插件，返回值不自动收集 → 保持现有 `ctx.effect(() => teardown)` 显式卸载；teardown 释放工具、命令与服务。台账不持久化，reload 后以平台回查重建。
- **事实状态**：一律每次从 dop/gh 重取（带 `sourceRevision`+`observedAt`），不缓存、不落本地库。
- **产物状态**：`.dsh-devops/<变更号>/*.md` 的 front matter 即"这份记录对应哪个变更/版本/sha"；报告生成时读回这些文件核对（不信任内存对象）。
- **无前端状态**（见 §6）。

## 9. 风险与待确认（实现期解决，不阻塞设计）

| # | 风险 | 处置 |
|---|---|---|
| R1 | `@heluo/forge-devops` 需要 `@heluo/forge-policy` 才能挂载，而 AC-7 要求删除 profile 里的 `file://` UAT 段（其中含 policy 行） | 采用**单安装单元**：devops 声明 `dependencies: {"@heluo/forge-policy":"workspace:*"}`，走既有闭包构建（ADR-12 模式）打成自包含 tarball；`cordis.patch.yml` 先插 `heluo-policy` 后插 `forge-devops`；回滚 = 一条 `remove` + 摘 bundles + 恢复 UAT 段 |
| R2 | 声明 `workspace:*` 会让 `tests/bundle-closure.test.mjs` / `scripts/check-bundle-tarballs.mjs`（目前只对 enterprise 特判）报错 | 同一任务内把闭包构建器的特判泛化为 `buildBundle({entry})`（`buildEnterpriseBundle` 保留为默认包装），并把 devops 加入 tarball 检查目标；既有 enterprise 行为不变 |
| R3 | 策略服务默认目录是否包含写动作、默认是否 `enabled:true` 未逐条核验（`packages/forge-policy` 默认 catalog） | 实现时以实测为准：未覆盖即 `denied` 可见（本就是 AC-16 要求）；devops 只在补丁注释里说明需要哪些 action，不代策略做默认开放 |
| R4 | gh 写动作指向真实远端（AC-16 取证） | 写工具一律要求 `confirm{repo,object}` 明示 + 门禁 confirm；单测全部用假 runner，真实写只出现在安装后的人工确认步骤 |
| R5 | rc.2 已实测、rc.3 `NOT RUN` | 安装/重启证据只写 rc.2；报告不得写"rc.3 已验证" |
| R6 | `.dsh-devops/` 属于目标仓库内产物，本仓库自测时不得把夹具产物提交 | 测试用临时目录（`fs.mkdtemp`）；仓库 `.gitignore` 增 `.dsh-devops/` 与 `logs/`（避免 `?? logs/` 混入提交） |

## 10. 测试策略（离线、可复现、无真实远端）

- 运行器：仓库既有 `node --test`（根 `pnpm check` 已串接），包级 `node --test "packages/forge-devops/test/*.test.mjs"`。
- **注入子进程**：`createCliRunner({ execFile: fake })`，测试不 spawn 真实 `gh`/`dop`；`fake` 按 `{bin,args}` 返回夹具 stdout/stderr/exitCode，并可模拟超时（返回 `timedOut:true`）。
- 夹具：`packages/forge-devops/test/fixtures/dop-change-ard123456.json`、`dop-change-ard222222.json`（首 story `release_info` 空）、`gh-repo-list.json`、`gh-issue-list.json`、`gh-pr-list.json`、`policy-catalog.json`（读开/写关两态）。
- 分层：纯函数单测（context/clarify/plan/review/report/artifacts/commit-message/actions）→ 适配器契约测（argv 逐字断言、禁项不存在）→ 装配测（假 ctx + 假 policy 挂载后工具数/命令面/teardown）→ 边界测（§7.7 表逐行）。
- 断言取向：结构性断言（状态、reason 码、argv 数组、front matter 键序），不做长文本快照；禁止在单测里断言"企业已联调"类文案。
- **不做的**：真实 dop/gh 调用、安装/卸载/重启（AC-7/8/9 属主 agent 执行步骤，证据单列 `sourceType`）。

建议用例量：每模块 3–6 条，总计 45–60 条；§7.7 的 12 行每条至少一个用例。

## 11. 任务拆分（无流水线预派任务，按文件边界并行）

| 任务 | 文件（拥有） | 读取 | 验收要点 |
|---|---|---|---|
| **T1 基础层** | `package.json`、`cordis.patch.yml`、`README.md`（含 §5.4 变量表与安装/回滚步骤）、`src/runtime-config.mjs`、`src/cli-runner.mjs`、`test/config.test.mjs`、`test/cli-runner.test.mjs` | `src/read.mjs`、`src/index.mjs`、`packages/forge-enterprise/cordis.patch.yml` | 清单含 `dsh.bundle.patch`+`files:["src","cordis.patch.yml","README.md"]`；包根名 insert；env 未配 fail closed 且不硬编码路径；runner 无 shell、有超时与输出上限 |
| **T2 适配器** | `src/dop-adapter.mjs`、`src/gh-adapter.mjs`、`test/dop-adapter.test.mjs`、`test/gh-adapter.test.mjs`、`test/fixtures/*.json` | `src/cli-runner.mjs`、`docs/contracts/engineering-tools.md` | argv 逐字匹配 §5.3；禁项不存在；输出解析失败抛明确错误；不拼 shell |
| **T3 读取面与上下文卡** | `src/read.mjs`、`src/change-context.mjs`、`src/repository-resolver.mjs`、`test/context.test.mjs`、`test/repository.test.mjs` | `src/tools.mjs`（既有形态） | 字段映射全覆盖；`release_info` 首个非空两夹具；`unknown` 带原因；多候选 `blocked`+证据；不按变更号文本推仓库 |
| **T4 澄清与计划** | `src/clarify.mjs`、`src/plan.mjs`、`test/clarify.test.mjs`、`test/plan.test.mjs` | `src/report.mjs`（未建，仅接口约定） | 硬门禁仅两类；选项 ≥2 且实质；无选项判不通过；H-n 稳定编号；计划逐条映射验收条件、无固定阶段模板 |
| **T5 写动作与门禁** | `src/policy-guard.mjs`、`src/actions.mjs`、`test/actions.test.mjs`、`test/policy-guard.test.mjs` | `src/dop-adapter.mjs`、`src/gh-adapter.mjs` | 四状态；幂等键/查重/复用；回读不一致→`unknown` 且不重放；拒绝时假 adapter 零调用；澄清 dop 通道恒 `denied` |
| **T6 审查·报告·提交信息** | `src/review.mjs`、`src/report.mjs`、`src/commit-message.mjs`、`test/review.test.mjs`、`test/report.test.mjs`、`test/commit-message.test.mjs` | T5 的 `ActionResult` 形状 | 模型名/commit 绑定与降级明示；AI/人工分栏；`stale`；证据含 command/at/hostVersion/target/sourceType；UAT `unknown`；关闭只判定不执行；前缀校验 |
| **T7 产物与装配** | `src/artifacts.mjs`、`src/entry.mjs`、`src/tools.mjs`、`src/index.mjs`、`test/artifacts.test.mjs`、`test/entry.test.mjs`、`test/tools.test.mjs`（扩） | T1–T6 全部导出 | front matter 六字段定序；路径逃逸拒绝；9 工具映射表逐条；入口只收变更号；`modelInvocable:false`；teardown 完整；无 `commands` 服务时工具面仍注册 |
| **T8 交付自检** | 无（只改自检发现的问题，仍属原任务文件） | 全部 | 跑 §12 命令；对 §7.7 表逐行自查；记录结论即可（**不写 QA-REPORT/ACCEPTANCE**，不做跨浏览器/实机矩阵） |

依赖：T1 先落地（其余任务读它的 runner/config 签名）；T2 依赖 T1；T3–T6 相互独立可并行（文件不相交）；T7 在 T3–T6 签名稳定后串行；T8 最后。

### Git 动作（来自 PRD §9，必须随任务落地，不得只在报告里提）

- **G1 分支**：`feat/devops-change-flow` 已在（`git rev-parse --abbrev-ref HEAD` 核对），**不新建**；若分支丢失，从最新 `main` 拉同名单支再实现。
- **G2 提交信息**：同一系统变更下的提交以 `[变更号]` 开头（例如 `[ARD123456] feat(devops): 上下文卡与承重判定`）；由 `commit-message.mjs` 同一规则约束产品行为，本仓提交按仓库既有风格**同时**保留 PR 引用；不合规**拒绝提交**，不自动改写历史。
- **G3 工作区纪律**：`?? docs/teamflow/` 是本需求产物夹，保留原样；不 `git stash`、不丢弃、不覆盖他人改动；提交只纳入本需求产物与实现改动，不把未知改动混进同一提交。
- **G4 忽略项**：`.gitignore` 增 `logs/` 与 `.dsh-devops/`（避免临时产物/日志进入提交）。
- **G5 推送/发布**：不推送、不发布（需当次明确授权）；安装与卸载（AC-7/8/9）由**主 agent** 在工作区外执行（`dsh plugin --profile web add <tarball>`），子代理只提供步骤与判据。

## 12. 验证命令（实现完成后由 T8 执行）

```sh
node --test "packages/forge-devops/test/*.test.mjs"
node --test "tests/*.test.mjs"   # 包形/闭包/制品/文档检查（受 R2 影响需同步更新）
pnpm check                    # 文档检查 + 仓库检查 + 全部 node --test
git diff --check
```

安装/加载/回滚（AC-7/8/9，主 agent 执行，证据单列 `sourceType` 与宿主版本）不在离线验证范围内。

## 13. 与 PRD 的 AC 对应

| AC | 落点 |
|---|---|
| AC-1/2/3/4/5/6 | T1（清单/补丁/闭包/装载安全）、T7（`index.mjs` 顶层不碰 env/ctx） |
| AC-7/8/9 | T1 的 README 安装与回滚步骤 + G5（主 agent 执行） |
| AC-10 | T7（`entry.mjs`） |
| AC-11/12/22 | T2 + T3（取数、卡、承建判定、白名单、配置注入） |
| AC-13/14 | T4 + T5（`writeClarification`） |
| AC-15 | T4（`plan.mjs`） |
| AC-16/17 | T5（四状态/幂等/回读）、T6（`commit-message.mjs`） |
| AC-18 | T6（`review.mjs`） |
| AC-19 | T2 的禁项 + T6（`issueCloseReadiness` 只判定） |
| AC-20/21 | T6（`report.mjs`：证据分记、UAT `unknown`） |
| AC-23 | T2/T5/T6（来源类型、来源版本、命令与时间必填）+ T7（front matter） |
